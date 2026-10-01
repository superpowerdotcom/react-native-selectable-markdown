import { IS_DEV } from '../dev';
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

// Native Image forwards View props, although ImageProps omits pointerEvents.
const NONINTERACTIVE_IMAGE_PROPS = { pointerEvents: 'none' as const };

export interface RenderContext {
  theme: MarkdownTheme;
  renderers: RendererMap;
  /** Original markdown source; last-resort text recovery for unknown kinds. */
  source: string;
  /** Nesting depth of the list currently being rendered (0 = top level). */
  listDepth: number;
  /** Document depth, maintained by {@link renderNode}; absent means 0. Consumers never set it. */
  depth?: number;
  /**
   * `false` while these blocks are still streaming, since Android's ActionMode breaks when text under
   * a selection is swapped. A custom renderer passes it to any `selectable` text. Absent means selectable.
   */
  selectable?: boolean;
  /**
   * The allowlist `openUrl` re-checks at navigation, since a custom engine's hrefs are unchecked.
   * Absent means `DEFAULT_LINK_PREFIXES`.
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
 * source. Iterative, because the depth cap calls it on subtrees too deep to recurse.
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
 * It also enforces the URL allowlist for every engine, since a substituted
 * engine's hrefs are unchecked. Omitted `allowedPrefixes` means
 * `DEFAULT_LINK_PREFIXES`, and the sanitized string is what opens.
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

const warnedSchemes = new Set<string>();

function warnRefusedUrl(url: string): void {
  if (!IS_DEV) {
    return;
  }
  // Only the scheme: the rest of a URL is content.
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

  // These set `selectable` because a standalone block renders outside any host,
  // and take it from `ctx` because the standalone tail has its own policy.
  //
  // On a nested `<Text>` it is inert: a nested <Text> renders as
  // RCTVirtualText, and `selectable` is not in that component's
  // `validAttributes` (Libraries/Text/TextNativeComponent.js:63-69), so React
  // drops it and the outermost `<Text>` decides.

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
          // `paddingStart` with `start: 0` below keeps the bar on the leading edge under RTL.
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
            // `'auto'`, not `'left'`: an undeclared column follows the text direction.
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
    // Only a standalone block reaches here; in a run a blocked link is a `blockedLink` mark.
    // Drawn as its label with no press, coloured like `styleForMark` does when the token is set.
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
      {...NONINTERACTIVE_IMAGE_PROPS}
      accessibilityLabel={node.alt}
      accessible={node.alt.length > 0}
      accessibilityRole="image"
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
 * Depth past which a standalone block renders flat, as one selectable `<Text>`
 * of its text, so untrusted nesting cannot drive Yoga's recursive layout.
 */
export const MAX_RENDER_DEPTH = 64;

let warnedDepth = false;

/**
 * Each renderer function gets its own wrapper component type, so its hooks get
 * their own instance and swapping the renderer remounts. An inline arrow
 * renderer therefore remounts every render.
 */
type RenderedNodeProps = {
  render: NodeRenderer;
  node: AnyNode;
  ctx: RenderContext;
};

type RenderedNodeType = ((props: RenderedNodeProps) => ReactNode) & {
  displayName?: string;
};

const nodeWrappers = new WeakMap<NodeRenderer, RenderedNodeType>();

function wrapperFor(render: NodeRenderer): RenderedNodeType {
  const cached = nodeWrappers.get(render);
  if (cached !== undefined) {
    return cached;
  }
  function RenderedNode(props: RenderedNodeProps): ReactNode {
    return props.render(props.node, props.ctx);
  }
  RenderedNode.displayName = `RenderedNode(${render.name || 'anonymous'})`;
  nodeWrappers.set(render, RenderedNode);
  return RenderedNode;
}

// Cached on the parent so siblings share one context and a memo keyed on `ctx` holds.
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
 * Every nested render funnels back through here, which is where the
 * {@link MAX_RENDER_DEPTH} cap applies.
 */
export function renderNode(node: AnyNode, ctx: RenderContext): ReactNode {
  const depth = (ctx.depth ?? 0) + 1;
  if (depth > MAX_RENDER_DEPTH) {
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
    return (
      <Text
        selectable={ctx.selectable ?? true}
        style={{ color: ctx.theme.colors.text }}
      >
        {textContentOf(node, ctx.source)}
      </Text>
    );
  }
  // Depth rides the context because the renderer runs later, inside React.
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
