import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import type {
  AnyNode,
  Block,
  Inline,
  SpoilerNode,
  TableAlignment,
} from '../document/nodes';
import { sliceSpan } from '../document/span';
import { childrenOf } from '../document/visit';
import { DEFAULT_LINK_PREFIXES } from '../engine/options';
import { isUrlAllowed, sanitizeUrl } from '../engine/urlPolicy';
import type { MarkdownTheme } from './theme';
import { headingFontSize } from './theme';

export interface RenderContext {
  theme: MarkdownTheme;
  renderers: RendererMap;
  /** Original markdown source; last-resort text recovery for unknown kinds. */
  source: string;
  /** Nesting depth of the list currently being rendered (0 = top level). */
  listDepth: number;
  /**
   * How many nodes deep in the DOCUMENT this render is — every node kind,
   * not just lists — maintained by {@link renderNode} and compared against
   * {@link MAX_RENDER_DEPTH}. Absent means 0, so a `RenderContext` built by
   * hand starts at the top; a consumer never sets this.
   */
  depth?: number;
  /**
   * Whether the blocks rendered with this context may be selected — the
   * platform tail policy, resolved by the view and applied by every renderer
   * that sets `selectable` on a `<Text>`.
   *
   * `false` means the text under these renderers is still changing: this is
   * the STANDALONE half of the policy `RunHost` applies to flowing runs
   * (`segmentRuns` emits an unsettled run with `selectable: false`, and the
   * view decides what each platform does with it). Android's ActionMode
   * misbehaves — and on some OEM builds crashes — when the text under an
   * active selection is swapped, which is what a standalone block in the
   * streaming tail does on every delta.
   *
   * A consumer's own renderer should pass it through to any `selectable`
   * text it renders, for the same reason.
   *
   * OPTIONAL, AND ABSENT MEANS SELECTABLE. The view always sets it; a
   * `RenderContext` built by hand to call the exported `renderNode` /
   * `renderBlocks` need not, and the default is the answer a hand-built
   * context wants — nothing outside a stream has text that is still moving.
   * Every built-in renderer reads it as `ctx.selectable ?? true`, so an
   * omitted field can never quietly turn the library's headline feature off.
   */
  selectable?: boolean;
  /**
   * The link prefixes `urlPolicy.linkPrefixes` allows, re-checked HERE, at
   * the moment of navigation, by `openUrl`.
   *
   * The allowlist's own doc comment says the check "has to run where the node
   * is built ... so there is no unsafe `href` to forget" — which is true of
   * `nativeEngine` and of nothing else. `parseDocument` runs no policy pass
   * over a substituted engine's output (`Engine.ts`: whatever the engine
   * returns IS the document), and honouring the flags is explicitly optional
   * for an engine author, so a `javascript:` href from a custom parser used
   * to reach `Linking.openURL` through this renderer with nothing in between.
   * `SelectableMarkdown` fills this in from the options the document was
   * parsed with, so the same list decides twice.
   *
   * Absent falls back to `DEFAULT_LINK_PREFIXES` rather than to "allow
   * anything": a context built by hand (a consumer driving `renderBlocks`
   * itself) gets the shipped policy, and a custom scheme it means to open
   * has to say so — the safe direction for a value that ends up at
   * `openURL`.
   */
  linkPrefixes?: readonly string[];
  /** Set while rendering a table's cells. */
  tableAlign?: readonly TableAlignment[];
  tableHeader?: boolean;
  tableCellIndex?: number;
}

export type NodeKind = AnyNode['kind'];
type NodeOfKind<K extends NodeKind> = Extract<AnyNode, { kind: K }>;

export type NodeRenderer = (node: AnyNode, ctx: RenderContext) => ReactNode;

export type RendererMap = {
  [K in NodeKind]: (node: NodeOfKind<K>, ctx: RenderContext) => ReactNode;
};

/** Per-kind renderer overrides, merged over the defaults. */
export type RendererOverrides = {
  [K in NodeKind]?: (node: NodeOfKind<K>, ctx: RenderContext) => ReactNode;
};

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

function bodyTextStyle(theme: MarkdownTheme): TextStyle {
  return {
    color: theme.colors.text,
    fontFamily: theme.fonts.body,
    fontSize: theme.fonts.baseSize,
    lineHeight: theme.fonts.baseSize * theme.fonts.lineHeight,
  };
}

function codeTextStyle(theme: MarkdownTheme): TextStyle {
  return {
    color: theme.colors.codeText,
    fontFamily: theme.fonts.mono,
    fontSize: theme.code.fontSize,
  };
}

/**
 * List bullet/number/task glyph. `colors.listMarker` unset (the default)
 * renders the bare string so the marker inherits the surrounding text colour —
 * the pre-existing behaviour, and what the native path does with the
 * `listMarker` mark.
 */
function renderListMarker(marker: string, ctx: RenderContext): ReactNode {
  if (marker === '') {
    return null;
  }
  const color = ctx.theme.colors.listMarker;
  return color ? <Text style={{ color }}>{marker}</Text> : marker;
}

/**
 * Best-effort plain text of a node: decoded values, else children, else raw
 * source.
 *
 * Walked with an explicit stack rather than recursively, because this is the
 * fallback the depth cap in {@link renderNode} lands on: it is called with
 * exactly the subtrees that were too deep to render, so a recursive version
 * would overflow on the input the cap exists to survive. (`childrenOf` is
 * itself flat, and `visit` is an explicit stack for the same reason.)
 */
export function textContentOf(node: AnyNode, source: string): string {
  const parts: string[] = [];
  // Reversed pushes keep document order out of a LIFO stack.
  const stack: AnyNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as AnyNode;
    const record = current as {
      value?: unknown;
      literal?: unknown;
      alt?: unknown;
    };
    if (typeof record.value === 'string') {
      parts.push(record.value);
      continue;
    }
    if (typeof record.literal === 'string') {
      parts.push(record.literal);
      continue;
    }
    if (typeof record.alt === 'string') {
      parts.push(record.alt);
      continue;
    }
    const children = childrenOf(current);
    if (children.length > 0) {
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
      continue;
    }
    parts.push(sliceSpan(source, current.span));
  }
  return parts.join('');
}

/**
 * Exported because it is the ONE press behaviour links have, on both render
 * paths: the `link`/`autolink` renderers below call it from their `<Text
 * onPress>`, and `SelectableMarkdown` calls it when the native host reports
 * an `onInlinePress` on a link range. If the two ever diverged, a link would
 * do different things depending on whether the native module happens to be
 * linked — the exact class of disagreement this module's renderers are kept
 * in step with `runAttributes.ts` to avoid.
 *
 * AND IT IS WHERE THE URL ALLOWLIST IS ENFORCED FOR EVERY ENGINE. The policy
 * runs inside the md4c decoder, one node at a time, which is what makes
 * `nativeEngine` incapable of returning a rejected `href`. It is not a
 * property of `parseDocument`: a substituted engine (`engine` prop) may
 * treat `options.urlPolicy` as the optional flag the `Engine` contract says
 * it is, and nothing between it and this call re-checked the string. So the
 * navigation boundary checks too — the same `sanitizeUrl` + `isUrlAllowed`
 * pair, against the same resolved `linkPrefixes` — and a href that fails is
 * a no-op instead of an `openURL`.
 *
 * `allowedPrefixes` omitted means `DEFAULT_LINK_PREFIXES`, not "allow
 * anything": the caller that knows the document's policy (`SelectableMarkdown`,
 * and any `RenderContext` it builds) passes it, and a caller that does not
 * gets the shipped one. The sanitized string is what opens, so the URL the
 * allowlist judged is the URL that navigates — the discipline the decoder
 * already applies when it stores the href on the node.
 */
export function openUrl(
  href: string,
  allowedPrefixes: readonly string[] = DEFAULT_LINK_PREFIXES,
): void {
  const url = sanitizeUrl(href);
  if (!isUrlAllowed(url, allowedPrefixes)) {
    warnRefusedUrl(url);
    return;
  }
  Linking.openURL(url).catch(() => {
    // Unopenable URLs (no handler installed) are a no-op, not a crash.
  });
}

/** Schemes already named in a refusal warning; same warn-once discipline as
 * the unknown-renderer warning below, keyed on the scheme so one bad custom
 * scheme in a transcript does not warn per link. */
const warnedSchemes = new Set<string>();

/**
 * A refused navigation is silent to the user — the tap does nothing — so in
 * DEV it says why. It is worth a line because the shape that produces it is
 * a consumer misconfiguration, not an attack: a custom engine (or a custom
 * `RenderContext`) plus a scheme the app forgot to add to
 * `urlPolicy.linkPrefixes`.
 */
function warnRefusedUrl(url: string): void {
  if (!IS_DEV) {
    return;
  }
  // The scheme and nothing else: the rest of a URL is content, and a warning
  // is not the place to print it. A string with no scheme at all (a bare
  // '#anchor' from a custom engine) is named as such rather than sliced.
  const colon = url.indexOf(':');
  const scheme = colon === -1 ? '(no scheme)' : url.slice(0, colon + 1).toLowerCase();
  if (warnedSchemes.has(scheme)) {
    return;
  }
  warnedSchemes.add(scheme);
  console.warn(
    `[react-native-selectable-markdown] refused to open a "${scheme}" URL: ` +
      'it is not in urlPolicy.linkPrefixes. Add the prefix to open it, or ' +
      'handle it yourself through onLinkPress.',
  );
}

function SpoilerSpan(props: { node: SpoilerNode; ctx: RenderContext }): ReactNode {
  const { node, ctx } = props;
  const [revealed, setRevealed] = useState(false);
  const { theme } = ctx;
  if (revealed) {
    return (
      <Text
        onPress={() => setRevealed(false)}
        style={{ backgroundColor: theme.colors.spoilerRevealedBackground }}
      >
        {renderInlines(node.children, ctx)}
      </Text>
    );
  }
  // Hidden state renders unstyled text content so child styles (e.g. a code
  // span's own text color) cannot leak through the mask.
  return (
    <Text
      onPress={() => setRevealed(true)}
      style={{
        backgroundColor: theme.colors.spoilerMask,
        color: theme.colors.spoilerMask,
      }}
    >
      {textContentOf(node, ctx.source)}
    </Text>
  );
}

const typedDefaults: RendererMap = {
  // -- Blocks ---------------------------------------------------------------

  // WHY `paragraph`, `heading`, `blockquote`, `list`, `htmlBlock`, `codeBlock`
  // AND `tableCell` SET `selectable`, AND WHY IT COMES FROM `ctx`. It is about
  // where they run, not about how they look.
  //
  // Inside a prose run none of them runs AT ALL. `RunHost` mounts one childless
  // native host built from `text` plus `attributes`, and `renderBlocks` is
  // reached only through `RunView`'s `run.standalone` branch, so no renderer
  // ever sits inside a host to argue with it about selection. The case this
  // prop is for is that *standalone* one — `segmentRuns` makes a block
  // standalone when it carries a spoiler, an unclaimed image (`images:
  // 'standalone'`, or one the embed box cannot reserve for), or a node
  // `classifyBlock` claimed, and a standalone block renders outside any
  // host. Without the prop, a paragraph containing an image was not selectable
  // at all: not by a custom menu item, not even by the system Copy that every
  // other standalone block already offered, in a library whose headline feature
  // is selection. (`listItem` is deliberately not among them: it is only ever
  // rendered nested inside `list`.)
  //
  // Setting it on renderers that end up NESTED inside another renderer's
  // `<Text>` — a paragraph inside `blockquote`, or one inside a `list`'s items
  // — is inert rather than contradictory: a nested <Text> renders as
  // RCTVirtualText, and `selectable` is not in that component's
  // `validAttributes` (Libraries/Text/TextNativeComponent.js:63-69), so React
  // drops it before it reaches any diff. The outermost `<Text>` of the
  // standalone block is the one that decides.
  //
  // `ctx.selectable` and not a hardcoded `true` because the standalone path
  // has a tail policy of its own. This comment used to say the Android policy
  // — no selection over text that is still changing, because
  // `TextView#setText` drops the selection and the ActionMode — "cannot be
  // undone from in here", and that was exactly the bug: `segmentRuns` computed
  // `selectable: false` for an unsettled standalone block, the standalone
  // branch of `RunView` never read it, and a paragraph whose image had arrived
  // while its text kept growing sat selectable over moving text. The view now
  // resolves the policy once and puts the answer here.

  paragraph: (node, ctx) => (
    <Text selectable={ctx.selectable ?? true} style={bodyTextStyle(ctx.theme)}>
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  heading: (node, ctx) => {
    const size = headingFontSize(ctx.theme, node.level);
    return (
      <Text
        accessibilityRole="header"
        selectable={ctx.selectable ?? true}
        style={{
          color: ctx.theme.colors.heading,
          fontFamily: ctx.theme.fonts.body,
          fontSize: size,
          fontWeight: ctx.theme.headings.weight,
          // Absolute when `headings.lineHeight` pins it, multiplier otherwise
          // — mirrored in the `heading` mark in `runAttributes.ts`.
          lineHeight:
            ctx.theme.headings.lineHeight ?? size * ctx.theme.fonts.lineHeight,
        }}
      >
        {renderInlines(node.children, ctx)}
      </Text>
    );
  },

  codeBlock: (node, ctx) => {
    const { theme } = ctx;
    // Highlight hook point: a syntax highlighter may attach here later, but
    // only for node.closed === true — an unclosed streaming fence must always
    // render as plain mono text (v0 renders plain mono in both cases).
    const literal = node.literal.endsWith('\n')
      ? node.literal.slice(0, -1)
      : node.literal;
    return (
      <View
        style={{
          backgroundColor: theme.colors.codeBackground,
          borderRadius: theme.code.borderRadius,
          paddingHorizontal: theme.spacing.codePadding,
          paddingVertical: theme.code.paddingVertical,
        }}
      >
        <Text selectable={ctx.selectable ?? true} style={codeTextStyle(theme)}>
          {literal}
        </Text>
      </View>
    );
  },

  blockquote: (node, ctx) => {
    const { quote } = ctx.theme;
    return (
      <View
        style={{
          backgroundColor: quote.background,
          borderRadius: quote.borderRadius,
          // `paddingStart`, not `paddingLeft`: the bar sits at the quote's
          // LEADING edge, which is the right edge under an RTL layout
          // direction. The pair with `start: 0` on the capsule below is what
          // keeps the two together when the direction flips.
          paddingStart: quote.barWidth + quote.indent,
          paddingVertical: quote.paddingVertical,
        }}
      >
        {/* The bar is its own absolutely-positioned capsule rather than a
            borderLeft: a left border takes square ends and bends around the
            box's rounded corners (radius 4 > barWidth 3 by default), while
            the native host draws a straight capsule of radius barWidth/2
            unclipped by the box — this matches it. Nested quotes still step
            their bars inward here (each level's bar sits at its own leading
            edge) where the native contract pins every level's bar at x=0;
            that residual divergence is accepted. */}
        <View
          pointerEvents="none"
          style={{
            backgroundColor: quote.barColor,
            borderRadius: quote.barWidth / 2,
            bottom: 0,
            // Logical, like the padding above: `start` is the left edge in an
            // LTR layout and the right edge in an RTL one.
            start: 0,
            position: 'absolute',
            top: 0,
            width: quote.barWidth,
          }}
        />
        <Text
          selectable={ctx.selectable ?? true}
          style={{ ...bodyTextStyle(ctx.theme), color: ctx.theme.colors.quoteText }}
        >
          {/* '\n\n' because that is BLOCK_SEPARATOR: `projectRun` separates the
              children of a blockquote with a blank line exactly as it separates
              top-level siblings, so joining them with a single '\n' here made
              the fallback and the native host show a different number of
              characters for the same quote. Fallback-only, so no offset moves. */}
          {joinBlockChildren(node.children, ctx, '\n\n')}
        </Text>
      </View>
    );
  },

  list: (node, ctx) => {
    const itemCtx: RenderContext = { ...ctx, listDepth: ctx.listDepth + 1 };
    const indent = '   '.repeat(ctx.listDepth);
    return (
      <Text selectable={ctx.selectable ?? true} style={bodyTextStyle(ctx.theme)}>
        {node.items.map((item, index) => {
          const marker = item.task
            ? ''
            : node.ordered
              ? `${(node.start ?? 1) + index}. `
              : ctx.theme.glyphs.bullet;
          return (
            <Fragment key={`${item.span.start}:${index}`}>
              {index > 0 ? '\n' : null}
              {indent}
              {renderListMarker(marker, ctx)}
              {renderNode(item, itemCtx)}
            </Fragment>
          );
        })}
      </Text>
    );
  },

  listItem: (node, ctx) => (
    <Text>
      {node.task
        ? renderListMarker(
            node.task === 'checked'
              ? ctx.theme.glyphs.taskChecked
              : ctx.theme.glyphs.taskUnchecked,
            ctx,
          )
        : null}
      {/* '\n\n' for the same reason as blockquote: a list item's children are
          sibling blocks, and `projectRun` puts BLOCK_SEPARATOR between them.
          The '\n' between list *items* is a different separator and stays a
          single newline (see the `list` renderer above). */}
      {joinBlockChildren(node.children, ctx, '\n\n')}
    </Text>
  ),

  table: (node, ctx) => {
    const { theme } = ctx;
    const headerCtx: RenderContext = {
      ...ctx,
      tableAlign: node.align,
      tableHeader: true,
    };
    const rowCtx: RenderContext = {
      ...ctx,
      tableAlign: node.align,
      tableHeader: false,
    };
    return (
      <View
        style={{
          borderColor: theme.colors.border,
          borderRadius: theme.table.borderRadius,
          borderWidth: theme.table.borderWidth,
          overflow: 'hidden',
        }}
      >
        {renderNode(node.header, headerCtx)}
        {node.rows.map((row, index) => (
          <Fragment key={`${row.span.start}:${index}`}>
            {renderNode(row, rowCtx)}
          </Fragment>
        ))}
      </View>
    );
  },

  tableRow: (node, ctx) => {
    const { theme } = ctx;
    return (
      <View
        style={{
          backgroundColor: ctx.tableHeader
            ? theme.colors.tableHeaderBackground
            : undefined,
          borderTopWidth: ctx.tableHeader ? 0 : theme.table.rowRuleThickness,
          borderTopColor: theme.colors.border,
          flexDirection: 'row',
        }}
      >
        {node.cells.map((cell, index) => (
          <Fragment key={`${cell.span.start}:${index}`}>
            {renderNode(cell, { ...ctx, tableCellIndex: index })}
          </Fragment>
        ))}
      </View>
    );
  },

  tableCell: (node, ctx) => {
    const { theme } = ctx;
    const align = ctx.tableAlign?.[ctx.tableCellIndex ?? 0] ?? null;
    return (
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.table.cellPaddingH,
          paddingVertical: theme.table.cellPaddingV,
        }}
      >
        <Text
          // A table is a flex layout of per-cell <Text>, not one text view,
          // so each cell has to opt in to selection itself. Without this the
          // cells were the one piece of rendered content in the library that
          // could not be selected or copied at all — including by the system
          // Copy that every other standalone block already offered.
          selectable={ctx.selectable ?? true}
          style={{
            ...bodyTextStyle(theme),
            fontWeight: ctx.tableHeader ? theme.table.headerWeight : 'normal',
            // `'auto'` — React Native's own default — and not `'left'` for a
            // column the table declares no alignment for. A physical 'left'
            // pins an unaligned cell to the left of the screen even when the
            // paragraph runs right-to-left, which is the one case where the
            // absent declaration means "whichever way this text reads". A
            // column that DOES declare left/center/right keeps it: those are
            // the author's physical alignment, as GFM defines them.
            textAlign: align ?? 'auto',
          }}
        >
          {renderInlines(node.children, ctx)}
        </Text>
      </View>
    );
  },

  thematicBreak: (node, ctx) => (
    <View
      style={{
        backgroundColor: ctx.theme.colors.border,
        height: ctx.theme.rule.thickness,
        marginHorizontal: ctx.theme.rule.inset,
        marginVertical: ctx.theme.spacing.blockGap / 2,
      }}
    />
  ),

  htmlBlock: (node, ctx) => (
    <Text
      selectable={ctx.selectable ?? true}
      style={{ ...codeTextStyle(ctx.theme), color: ctx.theme.colors.muted }}
    >
      {node.literal}
    </Text>
  ),

  // -- Inlines --------------------------------------------------------------

  text: (node) => node.value,

  emphasis: (node, ctx) => (
    <Text style={{ fontStyle: 'italic' }}>
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  // `strongFamily` / `colors.strong` apply only when set — same opt-in
  // contract as the `strong` mark in `runAttributes.ts`, so the fallback and
  // the native host draw the same bold.
  strong: (node, ctx) => (
    <Text
      style={{
        fontWeight: ctx.theme.fonts.strongWeight,
        ...(ctx.theme.fonts.strongFamily !== undefined
          ? { fontFamily: ctx.theme.fonts.strongFamily }
          : null),
        ...(ctx.theme.colors.strong !== undefined
          ? { color: ctx.theme.colors.strong }
          : null),
      }}
    >
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  strikethrough: (node, ctx) => (
    <Text style={{ textDecorationLine: 'line-through' }}>
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  underline: (node, ctx) => (
    <Text style={{ textDecorationLine: 'underline' }}>
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  codeSpan: (node, ctx) => (
    <Text
      style={{
        ...codeTextStyle(ctx.theme),
        backgroundColor: ctx.theme.colors.codeBackground,
      }}
    >
      {node.value}
    </Text>
  ),

  link: (node, ctx) => {
    // `blocked` means the href failed the URL policy and survived as a node
    // because `urlPolicy.blockedLinks: 'node'` was set. Until a renderer
    // claims it, it draws like the text node it replaces: its label and no
    // press — coloured with `colors.blockedLink` when that token is set (the
    // same rule `styleForMark` applies on the native path, and like there
    // with no underline: the policy refused this href as a destination),
    // otherwise unstyled so the surrounding text tree keeps supplying the
    // style.
    //
    // WHICH BLOCKED LINKS EVER REACH THIS RENDERER: only the ones in a
    // STANDALONE block. Prose flows into a native run, and a run has no
    // renderers in it at all — a blocked link there is a `blockedLink` mark
    // over projected text, reachable through `attributeForMark` (styling),
    // `onLinkPress` (taps, and the only channel that hears about blocked
    // ranges) and `embed` (a real element inside the sweep), or through
    // `classifyBlock` returning 'standalone', which is what puts the block
    // back on this path. An override here that expects to draw citation
    // pills in ordinary paragraphs draws nothing at all; see the `renderers`
    // prop in `SelectableMarkdown`, which warns about exactly that pairing
    // in DEV.
    if (node.blocked) {
      const blockedColor = ctx.theme.colors.blockedLink;
      return blockedColor ? (
        <Text style={{ color: blockedColor }}>
          {renderInlines(node.children, ctx)}
        </Text>
      ) : (
        renderInlines(node.children, ctx)
      );
    }
    return (
      <Text
        accessibilityRole={node.incomplete ? undefined : 'link'}
        onPress={
          node.incomplete
            ? undefined
            : () => openUrl(node.href, ctx.linkPrefixes)
        }
        style={{
          // `incomplete` means the stream has not delivered the closing paren
          // yet, so this is a `[label](https://…` that repair turned into a
          // link node. It gets no link colour, for the same reason it gets no
          // press and no underline: `projectRun` deliberately emits no `link`
          // mark for one (see the `link` case there), so painting it blue here
          // would make the two paths disagree about what looks tappable — and
          // during streaming it makes the text flash blue and settle to black
          // the instant the paren arrives. Undefined rather than the body
          // colour so the surrounding text tree keeps supplying the style,
          // exactly like the `blocked` branch above.
          color: node.incomplete ? undefined : ctx.theme.colors.link,
          textDecorationLine: node.incomplete ? 'none' : 'underline',
        }}
      >
        {renderInlines(node.children, ctx)}
      </Text>
    );
  },

  image: (node, ctx) => (
    <Image
      accessibilityLabel={node.alt}
      resizeMode="contain"
      source={{ uri: node.src }}
      style={{ height: ctx.theme.spacing.imageHeight, width: '100%' }}
    />
  ),

  autolink: (node, ctx) => (
    <Text
      accessibilityRole="link"
      onPress={() => openUrl(node.href, ctx.linkPrefixes)}
      style={{
        color: ctx.theme.colors.link,
        textDecorationLine: 'underline',
      }}
    >
      {node.href}
    </Text>
  ),

  hardBreak: () => '\n',

  softBreak: () => ' ',

  // No math typesetting in v0: raw TeX in mono italic (display math on its
  // own line via the run's block separators).
  math: (node, ctx) => (
    <Text style={{ ...codeTextStyle(ctx.theme), fontStyle: 'italic' }}>
      {node.value}
    </Text>
  ),

  spoiler: (node, ctx) => <SpoilerSpan ctx={ctx} node={node} />,

  htmlSpan: (node, ctx) => (
    <Text style={{ ...codeTextStyle(ctx.theme), color: ctx.theme.colors.muted }}>
      {node.literal}
    </Text>
  ),
};

export const defaultRenderers: RendererMap = typedDefaults;

/** Merge consumer overrides over the default per-kind renderer map. */
export function resolveRenderers(overrides?: RendererOverrides): RendererMap {
  if (!overrides) {
    return defaultRenderers;
  }
  const merged = { ...defaultRenderers };
  for (const key of Object.keys(overrides) as NodeKind[]) {
    const renderer = overrides[key];
    if (renderer !== undefined) {
      (merged as Record<NodeKind, unknown>)[key] = renderer;
    }
  }
  return merged;
}

const warnedKinds = new Set<string>();

/**
 * How many nodes deep a standalone block may be rendered before the tree is
 * flattened to text.
 *
 * WHY THERE IS A CAP AT ALL. Markdown nesting is unbounded and model output
 * is untrusted: 3 kB of `'> '` is a 1500-level blockquote, and every level of
 * it would otherwise become a `<View>` (plus its bar, plus a `<Text>`) around
 * the next one. Nothing in JavaScript overflows on that. React's render loop
 * is iterative, and so is every walk this library puts a document through on
 * the way here: the flat-buffer decode drains an explicit frame stack and
 * flattens inline subtrees with a second one (`plainText`, for a blocked
 * link's fallback text and an image's alt), and the spoiler transform, the
 * streaming span shift, the placeholder trim, segmentation and projection each
 * drain one of their own. (The streaming repair never descends a tree at all —
 * it scans lines.) `renderNode` is not on that list either: it walks nothing,
 * it renders ONE node and hands the descent back to React, and what it carries
 * down the context is a depth counter — which is what lets this cap be applied
 * in the single place every nested render passes through.
 *
 * WHAT DOES NOT SURVIVE THE DEPTH IS THE ELEMENT TREE. It becomes a shadow
 * tree of the same depth, and Yoga lays that out with a recursive C++ walk on
 * both platforms. Blowing a native stack is not an exception a
 * JavaScript `try` can catch, and short of that it is thousands of shadow
 * nodes and view mounts for a construct nobody can read anyway. The cap makes
 * the depth a property of this library instead of a property of the input.
 *
 * WHAT HAPPENS AT THE CAP. The node is rendered FLAT: one `<Text>` holding
 * `textContentOf` of the whole subtree, so every character the document
 * carries is still displayed and still selectable — what is lost is the
 * per-level chrome (quote bars, list markers, code backgrounds) below the
 * cap, and inline styling inside it. Nothing is dropped, nothing throws.
 *
 * 64 is far past anything a human writes — six levels of nested list is
 * `list`/`listItem`/`paragraph` eighteen deep, plus a few inline wrappers —
 * and far below where the native side starts to hurt. It is also only
 * reachable for STANDALONE blocks: prose flows into a native run, where
 * nesting is a flat list of marks and this path never runs at all.
 */
export const MAX_RENDER_DEPTH = 64;

/** Warn-once for the cap, the same discipline as `warnedKinds`. */
let warnedDepth = false;

/**
 * One node, rendered through its renderer AS A COMPONENT.
 *
 * WHY THE WRAPPER EXISTS. `renderNode` used to call `renderer(node, ctx)`
 * directly, which is a function call and not element position: whatever the
 * renderer did ran inside whichever component was rendering the tree — for a
 * standalone block, `RunView`. A hook in a consumer's renderer therefore
 * joined RUNVIEW's hook list, so two renderers' `useState`s shared one list,
 * their order depended on how many nodes happened to be above them, and any
 * conditional render ("only draw the chip once the image has loaded") changed
 * the hook count between renders — React's "Rendered more hooks than during
 * the previous render". The library itself already followed the rule the API
 * did not offer: the built-in spoiler wraps its `useState` in a real
 * `<SpoilerSpan>` component (see it above).
 *
 * With element position each node's renderer gets its own instance, so hooks
 * work the way a consumer would expect them to, state is per node position,
 * and a renderer that returns nothing for a node simply unmounts.
 *
 * ONE WRAPPER TYPE PER RENDERER FUNCTION, which is the other half of the same
 * rule. A single shared wrapper type made every renderer look like the same
 * component to React, so swapping the renderer at a stable position —
 * `renderers={editing ? draftRenderers : readRenderers}`, or an embed claim
 * that starts returning a different `render` for the same span — reconciled IN
 * PLACE and handed the new function the old function's hook list: the narrower
 * version of the very mismatch this wrapper exists to prevent. Keying the
 * wrapper on the renderer's identity makes a different function a different
 * component type, which is what tells React to unmount and remount.
 *
 * The cost is the ordinary React one, and the `renderers` prop says so: a
 * renderer whose identity changes on every render (an arrow written inline in
 * JSX) now remounts on every render, exactly as an inline component does.
 * Declare renderers at module scope or memoize them.
 */
type RenderedNodeProps = {
  render: NodeRenderer;
  node: AnyNode;
  ctx: RenderContext;
};

type RenderedNodeType = ((props: RenderedNodeProps) => ReactNode) & {
  displayName?: string;
};

/** The wrapper component built for each renderer function, kept weakly so a
 * renderer that goes away takes its wrapper with it. */
const nodeWrappers = new WeakMap<NodeRenderer, RenderedNodeType>();

function wrapperFor(render: NodeRenderer): RenderedNodeType {
  const cached = nodeWrappers.get(render);
  if (cached !== undefined) {
    return cached;
  }
  function RenderedNode(props: RenderedNodeProps): ReactNode {
    return props.render(props.node, props.ctx);
  }
  // Named for the React devtools tree, where a document is otherwise a wall of
  // identically-named wrappers.
  RenderedNode.displayName = `RenderedNode(${render.name || 'anonymous'})`;
  nodeWrappers.set(render, RenderedNode);
  return RenderedNode;
}

/**
 * The context one level deeper than this one, cached on the context it came
 * from.
 *
 * The depth is a property of the PARENT context and not of the node, so every
 * sibling at one level derives the identical object. Building a fresh
 * `{ ...ctx, depth }` per node per render instead — which this used to do —
 * gave every child a context that was `===` to nothing, so a consumer renderer
 * that memoizes on it (`React.memo`, a `useMemo` keyed on `ctx`) re-rendered
 * on every commit no matter what. Cached on the parent, the derived context
 * lives exactly as long as the parent does — which for the view's own context
 * is its `useMemo`, so it survives renders and the memo actually holds.
 */
const deeperContexts = new WeakMap<RenderContext, RenderContext>();

function contextOneDeeper(ctx: RenderContext): RenderContext {
  const cached = deeperContexts.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const deeper: RenderContext = { ...ctx, depth: (ctx.depth ?? 0) + 1 };
  deeperContexts.set(ctx, deeper);
  return deeper;
}

/**
 * Renders one node through the per-kind map. Unknown kinds render their text
 * content (DEV warn-once) — this function never throws for missing renderers.
 *
 * The renderer is placed as an element, not called, and the element's type is
 * the wrapper built for that particular renderer function: see `wrapperFor`.
 *
 * It is also the one funnel every nested render passes through — a renderer
 * reaches its children through `renderInlines`, `joinBlockChildren` or
 * `renderBlocks`, and all three come back here — which is what lets the
 * depth counter live in the context and the {@link MAX_RENDER_DEPTH} cap be
 * applied in exactly one place.
 */
export function renderNode(node: AnyNode, ctx: RenderContext): ReactNode {
  const depth = (ctx.depth ?? 0) + 1;
  if (depth > MAX_RENDER_DEPTH) {
    // Past the cap the subtree is flattened to its text rather than nested
    // any further. `selectable` is passed through so the flattened text is
    // still selectable and copyable, exactly like the block it came from.
    if (IS_DEV && !warnedDepth) {
      warnedDepth = true;
      console.warn(
        `[react-native-selectable-markdown] nesting deeper than ${MAX_RENDER_DEPTH} ` +
          `levels ("${node.kind}"); rendering its text content flat. Deeper ` +
          'structure is not drawn — the text is all still there.',
      );
    }
    return (
      <Text selectable={ctx.selectable ?? true} style={bodyTextStyle(ctx.theme)}>
        {textContentOf(node, ctx.source)}
      </Text>
    );
  }
  const renderer = ctx.renderers[node.kind] as NodeRenderer | undefined;
  if (!renderer) {
    if (IS_DEV && !warnedKinds.has(node.kind)) {
      warnedKinds.add(node.kind);
      console.warn(
        `[react-native-selectable-markdown] No renderer for node kind "${node.kind}"; rendering its text content.`,
      );
    }
    // `selectable` like every other fallback, including the depth cap three
    // lines up: an unknown kind is text the document still has to show, and
    // leaving the prop off made it the one construct in a standalone block
    // that could never be selected.
    return (
      <Text
        selectable={ctx.selectable ?? true}
        style={{ color: ctx.theme.colors.text }}
      >
        {textContentOf(node, ctx.source)}
      </Text>
    );
  }
  // A deeper context so the depth the renderer's own children see is one
  // below this one — the counter cannot be a module-level variable because
  // the renderer runs later, inside React, not during this call. It is shared
  // by every node at this level rather than rebuilt per node (see
  // `contextOneDeeper`), and the element's TYPE is this renderer's own
  // wrapper, so replacing the renderer remounts instead of reusing hooks.
  const Rendered = wrapperFor(renderer);
  return (
    <Rendered ctx={contextOneDeeper(ctx)} node={node} render={renderer} />
  );
}

export function renderInlines(children: Inline[], ctx: RenderContext): ReactNode {
  return children.map((child, index) => (
    <Fragment key={`${child.kind}:${child.span.start}:${index}`}>
      {renderNode(child, ctx)}
    </Fragment>
  ));
}

function joinBlockChildren(
  blocks: Block[],
  ctx: RenderContext,
  separator: string,
): ReactNode {
  return blocks.map((block, index) => (
    <Fragment key={`${block.kind}:${block.span.start}:${index}`}>
      {index > 0 ? separator : null}
      {renderNode(block, ctx)}
    </Fragment>
  ));
}

/**
 * Standalone block layout: each block in its own view with vertical rhythm.
 * Used outside prose runs (code blocks, tables, and custom compositions).
 */
export function renderBlocks(blocks: Block[], ctx: RenderContext): ReactNode {
  return blocks.map((block, index) => (
    <View
      key={`${block.kind}:${block.span.start}:${index}`}
      style={index > 0 ? { marginTop: ctx.theme.spacing.blockGap } : undefined}
    >
      {renderNode(block, ctx)}
    </View>
  ));
}
