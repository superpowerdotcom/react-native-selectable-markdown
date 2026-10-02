import { IS_DEV } from '../dev';
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import type { TextProps, TextStyle } from 'react-native';
import type {
  AnyNode,
  Block,
  HeadingLevel,
  Inline,
  SpoilerNode,
  TableAlignment,
} from '../document/nodes';
import { sliceSpan } from '../document/span';
import { childrenOf } from '../document/visit';
import { DEFAULT_LINK_PREFIXES } from '../engine/options';
import { isUrlAllowed, sanitizeUrl } from '../engine/urlPolicy';
import { innerItemGap, itemGap, marginBetween, spacingManaged } from './blockSpacing';
import { markerColumnWidth } from './runDecorations';
import { queryRanges } from './runPresentation';
import { startsWithWord } from '../selection/mapSelection';
import type { InlinePrefix, InlineTransform, MarkKind, RunMark } from '../selection/mapSelection';
import type { MarkAttribute } from './runAttributes';
import type { ChipStyle, PressableAccessibility, PressableInfo } from './runPresentation';
import type { CodeCardContext } from './codeBlocks';
import type { InlineLinkPress } from './SelectableMarkdown';
import type { MarkdownTheme, TableCellTextStyle } from './theme';
import { bulletGlyph, headingStyle } from './theme';

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
  /** `'newline'` renders a soft break as a line break. Absent means a space. */
  softBreak?: 'space' | 'newline';
  /** False opts every built-in `<Text>` out of the system text size. Absent means true. */
  allowFontScaling?: boolean;
  /** Caps the system text-size multiplier on built-in `<Text>`. */
  maxFontSizeMultiplier?: number;
  /** Display-text query the built-in `text` renderer highlights. */
  highlight?: { query: string; caseSensitive?: boolean; matchTokens?: boolean };
  /**
   * The document's `onLinkPress`. The built-in `link` and `autolink`
   * renderers route through it when set, exactly as native runs do, and
   * fall back to `openUrl` otherwise.
   */
  onLinkPress?: (press: InlineLinkPress) => void;
  /**
   * The inline constructs enclosing this node, outermost first — a link
   * inside a bold heading sees `heading` then `strong`. Maintained by the
   * built-in renderers; an override that renders children should pass
   * `withMark(ctx, …)` on to keep it.
   */
  marks?: readonly InlineScope[];
  /** The document's `transformInline`; `renderInlines` applies it. */
  transformInline?: InlineTransform;
  /**
   * The document's `attributeForMark`, `chipForMark` and
   * `accessibilityForPressable`, which the built-in inline renderers apply as
   * a run does. The mark they are given has `start` and `end` 0: a standalone
   * block has no run text to index.
   */
  attributeForMark?: MarkAttribute;
  chipForMark?: (mark: RunMark) => ChipStyle | undefined;
  accessibilityForPressable?: (pressable: PressableInfo) => PressableAccessibility | undefined;
  /** Set under `codeBlocks: 'card'`: the card's labels and copy handler. */
  codeCard?: CodeCardContext;
  /** Set while rendering inside an embed: the box the host reserved. */
  embedBox?: { width: number; height: number };
  /** Set while rendering a table's cells. */
  tableAlign?: readonly TableAlignment[];
  tableHeader?: boolean;
  /** The first body row of a table whose header is hidden: no rule above it. */
  tableFirstRow?: boolean;
  tableCellIndex?: number;
}

/** One enclosing construct in `RenderContext.marks`. */
export interface InlineScope {
  kind: 'heading' | 'strong' | 'emphasis' | 'strikethrough' | 'underline' | 'link' | 'blockquote';
  /** Heading level. */
  level?: number;
}

const scopedContexts = new WeakMap<RenderContext, Map<string, RenderContext>>();

/** `ctx` with one more enclosing construct, cached so siblings share it. */
export function withMark(ctx: RenderContext, scope: InlineScope): RenderContext {
  const key = scope.level === undefined ? scope.kind : `${scope.kind}:${scope.level}`;
  let byKey = scopedContexts.get(ctx);
  if (byKey === undefined) {
    byKey = new Map();
    scopedContexts.set(ctx, byKey);
  }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;
  const next: RenderContext = { ...ctx, marks: [...(ctx.marks ?? []), scope] };
  byKey.set(key, next);
  return next;
}

/** A link press on a standalone block: the document's handler, else `openUrl`. */
function pressLink(
  ctx: RenderContext,
  node: { href: string; span: { start: number; end: number } },
  blocked: boolean,
  event?: { nativeEvent?: { pageX?: number; pageY?: number } },
): void {
  if (ctx.onLinkPress) {
    const press: InlineLinkPress = { href: node.href, blocked, span: node.span };
    const x = event?.nativeEvent?.pageX;
    const y = event?.nativeEvent?.pageY;
    if (typeof x === 'number' && typeof y === 'number') press.rect = { x, y, width: 0, height: 0 };
    ctx.onLinkPress(press);
    return;
  }
  if (!blocked) openUrl(node.href, ctx.linkPrefixes);
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



/** The font-scaling props every built-in block-level `<Text>` carries. */
export function scaling(ctx: RenderContext): { allowFontScaling?: boolean; maxFontSizeMultiplier?: number } {
  if (ctx.allowFontScaling === undefined && ctx.maxFontSizeMultiplier === undefined) {
    return NO_SCALING;
  }
  const out: { allowFontScaling?: boolean; maxFontSizeMultiplier?: number } = {};
  if (ctx.allowFontScaling !== undefined) out.allowFontScaling = ctx.allowFontScaling;
  if (ctx.maxFontSizeMultiplier !== undefined) out.maxFontSizeMultiplier = ctx.maxFontSizeMultiplier;
  return out;
}

const NO_SCALING = Object.freeze({});

/** Space above `block` when `previous` precedes it in the same container. */
function gapBefore(previous: Block, block: Block, theme: MarkdownTheme, fallback: number): number {
  return spacingManaged(theme) ? marginBetween(theme, previous, block) : fallback;
}

const quoteThemes = new WeakMap<MarkdownTheme, MarkdownTheme>();

/** The theme a quote's children render with: body text in the quote colour. */
function quoteTheme(theme: MarkdownTheme): MarkdownTheme {
  const cached = quoteThemes.get(theme);
  if (cached !== undefined) return cached;
  const next: MarkdownTheme = { ...theme, colors: { ...theme.colors, text: theme.colors.quoteText } };
  quoteThemes.set(theme, next);
  return next;
}

function cellStyle(cell: TableCellTextStyle | undefined): TextStyle {
  if (cell === undefined) return {};
  const style: TextStyle = {};
  if (cell.fontFamily !== undefined) style.fontFamily = cell.fontFamily;
  if (cell.fontSize !== undefined) style.fontSize = cell.fontSize;
  if (cell.lineHeight !== undefined) style.lineHeight = cell.lineHeight;
  if (cell.color !== undefined) style.color = cell.color;
  if (cell.weight !== undefined) style.fontWeight = cell.weight;
  if (cell.letterSpacing !== undefined) style.letterSpacing = cell.letterSpacing;
  return style;
}

function isEmptyRow(row: Extract<Block, { kind: 'tableRow' }>): boolean {
  return row.cells.every((cell) =>
    cell.children.every((child) => child.kind === 'text' && child.value.trim() === ''),
  );
}

/** Shared with the `heading` mark in `runAttributes.ts`. */
function headingTextStyle(theme: MarkdownTheme, level: HeadingLevel): TextStyle {
  const resolved = headingStyle(theme, level);
  const style: TextStyle = {
    color: resolved.color,
    fontFamily: resolved.fontFamily,
    fontSize: resolved.fontSize,
    fontWeight: resolved.fontWeight,
    lineHeight: resolved.lineHeight,
  };
  if (resolved.letterSpacing !== undefined) style.letterSpacing = resolved.letterSpacing;
  return style;
}

function bodyTextStyle(theme: MarkdownTheme): TextStyle {
  return {
    color: theme.colors.text,
    fontFamily: theme.fonts.body,
    fontSize: theme.fonts.baseSize,
    lineHeight: theme.fonts.baseSize * theme.fonts.lineHeight,
  };
}

/** Raw HTML: muted mono, or body text under `html.display: 'text'`. */
function htmlTextStyle(theme: MarkdownTheme): TextStyle {
  return theme.html.display === 'text'
    ? bodyTextStyle(theme)
    : { ...codeTextStyle(theme), color: theme.colors.muted };
}

export function codeTextStyle(theme: MarkdownTheme): TextStyle {
  return {
    color: theme.colors.codeText,
    fontFamily: theme.fonts.mono,
    fontSize: theme.code.fontSize,
  };
}

/**
 * List bullet/number/task glyph, nested text so it lands in copied text the
 * way the projection's marker does. `colors.listMarker` unset (the default)
 * and no marker style renders the bare string, inheriting the text colour.
 * A dot marker becomes the bullet glyph in the dot's colour: nested text
 * cannot draw a shape or pin a column.
 */
function renderListMarker(marker: string, ctx: RenderContext, bullet: boolean): ReactNode {
  const { theme } = ctx;
  const style = theme.list.marker;
  if (bullet && style?.kind === 'dot') {
    return <Text style={{ color: style.color ?? theme.colors.listMarker ?? theme.colors.text }}>{marker}</Text>;
  }
  const glyph = style?.kind === 'glyph' ? style : undefined;
  const color = glyph?.color ?? theme.colors.listMarker;
  const marked: TextStyle = {};
  if (color) marked.color = color;
  if (glyph?.fontFamily !== undefined) marked.fontFamily = glyph.fontFamily;
  if (glyph?.fontSize !== undefined) marked.fontSize = glyph.fontSize;
  if (glyph?.weight !== undefined) marked.fontWeight = glyph.weight;
  return Object.keys(marked).length > 0 ? <Text style={marked}>{marker}</Text> : marker;
}

/**
 * A line break inside one `<Text>`, `gap` points of empty line after it. The
 * gap is a second '\n' whose line is `gap` tall, the way a run sizes its
 * blank separator line; 0 is a plain '\n'.
 */
function lineBreak(gap: number): ReactNode {
  if (gap <= 0) return '\n';
  return (
    <>
      {'\n'}
      <Text style={{ lineHeight: gap }}>{'\n'}</Text>
    </>
  );
}

/** Blocks inside one `<Text>`, each `separate(previous, block)` apart. */
function joinBlocks(
  blocks: Block[], ctx: RenderContext, separate: (previous: Block, block: Block) => ReactNode,
): ReactNode {
  return blocks.map((block, index) => (
    <Fragment key={`${block.kind}:${block.span.start}:${index}`}>
      {index > 0 ? separate(blocks[index - 1], block) : null}
      {renderNode(block, ctx)}
    </Fragment>
  ));
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
    <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={bodyTextStyle(ctx.theme)}>
      {renderInlines(node.children, ctx)}
    </Text>
  ),

  heading: (node, ctx) => (
    <Text
      {...scaling(ctx)}
      accessibilityRole="header"
      selectable={ctx.selectable ?? true}
      style={markStyle(
        ctx,
        fallbackMark('heading', { level: node.level }),
        headingTextStyle(ctx.theme, node.level),
      )}
    >
      {renderInlines(node.children, withMark(ctx, { kind: 'heading', level: node.level }))}
    </Text>
  ),

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
        <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={codeTextStyle(theme)}>
          {literal}
        </Text>
      </View>
    );
  },

  blockquote: (node, ctx) => {
    const { quote } = ctx.theme;
    const inner: RenderContext = { ...withMark(ctx, { kind: 'blockquote' }), theme: quoteTheme(ctx.theme) };
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
            unclipped by the box — this matches it. */}
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
        {/* One <Text> so a selection runs across the quote's children.
            They sit a blank line apart, as `projectRun`'s '\n\n'
            BLOCK_SEPARATOR puts them, or `theme.blocks` apart when set. A
            child that needs a view (a code block, table, nested quote)
            nests as an inline view. */}
        <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={bodyTextStyle(inner.theme)}>
          {joinBlocks(node.children, inner, (previous, block) =>
            spacingManaged(ctx.theme) ? lineBreak(marginBetween(ctx.theme, previous, block)) : '\n\n',
          )}
        </Text>
      </View>
    );
  },

  // One <Text> for the whole list, nested lists included, so a selection
  // runs across items and copies their markers, as in a run. Nested text
  // cannot hang-indent, so wrapped lines return to the list's leading edge;
  // a nested list's items are inset by an inline spacer, not by spaces that
  // would land in the copy.
  list: (node, ctx) => {
    const { theme } = ctx;
    const itemCtx: RenderContext = { ...ctx, listDepth: ctx.listDepth + 1 };
    const inset = ctx.listDepth * (markerColumnWidth(theme) ?? theme.spacing.listIndent);
    const gap = itemGap(theme) ?? 0;
    const bullet = bulletGlyph(theme);
    return (
      <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={bodyTextStyle(theme)}>
        {node.items.map((item, index) => {
          const marker =
            item.task === 'checked'
              ? theme.glyphs.taskChecked
              : item.task === 'unchecked'
                ? theme.glyphs.taskUnchecked
                : node.ordered
                  ? `${(node.start ?? 1) + index}. `
                  : bullet;
          return (
            <Fragment key={`${item.span.start}:${index}`}>
              {index > 0 ? lineBreak(gap) : null}
              {inset > 0 ? (
                <View
                  accessible={false}
                  importantForAccessibility="no-hide-descendants"
                  pointerEvents="none"
                  style={{ height: 1, width: inset }}
                />
              ) : null}
              {renderListMarker(marker, ctx, !item.task && !node.ordered)}
              {renderNode(item, itemCtx)}
            </Fragment>
          );
        })}
      </Text>
    );
  },

  // The marker belongs to the `list`; an item is its blocks, one line apart
  // as `projectRun`'s '\n' ITEM_SEPARATOR puts them, plus any item gap.
  listItem: (node, ctx) => (
    <Text>
      {joinBlocks(node.children, ctx, (previous, block) =>
        lineBreak(innerItemGap(ctx.theme, previous, block) ?? 0),
      )}
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
    const showHeader = !(theme.table.hideEmptyHeader && isEmptyRow(node.header));
    return (
      <View
        style={{
          borderColor: theme.table.frameColor ?? theme.colors.border,
          borderRadius: theme.table.borderRadius,
          borderWidth: theme.table.frame ? theme.table.borderWidth : 0,
          overflow: 'hidden',
        }}
      >
        {showHeader ? renderNode(node.header, headerCtx) : null}
        {node.rows.map((row, index) => (
          <Fragment key={`${row.span.start}:${index}`}>
            {renderNode(row, index === 0 && !showHeader ? { ...rowCtx, tableFirstRow: true } : rowCtx)}
          </Fragment>
        ))}
      </View>
    );
  },

  tableRow: (node, ctx) => {
    const { theme } = ctx;
    const ruled = !ctx.tableHeader && ctx.tableFirstRow !== true;
    return (
      <View
        style={{
          backgroundColor: ctx.tableHeader
            ? theme.colors.tableHeaderBackground
            : undefined,
          borderTopWidth: ruled ? theme.table.rowRuleThickness : 0,
          borderTopColor: theme.table.ruleColor ?? theme.colors.border,
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
    const typed = cellStyle(ctx.tableHeader ? theme.table.header : theme.table.body);
    return (
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.table.cellPaddingH,
          paddingVertical: theme.table.cellPaddingV,
        }}
      >
        <Text
          {...scaling(ctx)}
          // A table is a flex layout of per-cell <Text>, not one text view,
          // so each cell has to opt in to selection itself.
          selectable={ctx.selectable ?? true}
          style={{
            ...bodyTextStyle(theme),
            fontWeight: ctx.tableHeader
              ? (theme.table.header?.weight ?? theme.table.headerWeight)
              : 'normal',
            ...typed,
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
        backgroundColor: ctx.theme.rule.color ?? ctx.theme.colors.border,
        height: ctx.theme.rule.thickness,
        marginHorizontal: ctx.theme.rule.inset,
        // `theme.blocks.rule` spaces it instead when the theme spaces blocks.
        marginVertical: spacingManaged(ctx.theme) ? 0 : ctx.theme.spacing.blockGap / 2,
      }}
    />
  ),

  htmlBlock: (node, ctx) => (
    <Text
      {...scaling(ctx)}
      selectable={ctx.selectable ?? true}
      style={htmlTextStyle(ctx.theme)}
    >
      {node.literal}
    </Text>
  ),

  // -- Inlines --------------------------------------------------------------

  text: (node, ctx) => (ctx.highlight ? highlighted(node.value, ctx) : node.value),

  emphasis: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('emphasis'),
      ctx.theme.colors.emphasis !== undefined
        ? { fontStyle: 'italic', color: ctx.theme.colors.emphasis }
        : { fontStyle: 'italic' },
      renderInlines(node.children, withMark(ctx, { kind: 'emphasis' })),
    ),

  // `strongFamily` / `colors.strong` apply only when set — same opt-in
  // contract as the `strong` mark in `runAttributes.ts`, so the fallback and
  // the native host draw the same bold.
  strong: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('strong'),
      {
        fontWeight: ctx.theme.fonts.strongWeight,
        ...(ctx.theme.fonts.strongFamily !== undefined
          ? { fontFamily: ctx.theme.fonts.strongFamily }
          : null),
        ...(ctx.theme.colors.strong !== undefined
          ? { color: ctx.theme.colors.strong }
          : null),
      },
      renderInlines(node.children, withMark(ctx, { kind: 'strong' })),
    ),

  strikethrough: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('strikethrough'),
      { textDecorationLine: 'line-through' },
      renderInlines(node.children, withMark(ctx, { kind: 'strikethrough' })),
    ),

  underline: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('underline'),
      { textDecorationLine: 'underline' },
      renderInlines(node.children, withMark(ctx, { kind: 'underline' })),
    ),

  codeSpan: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('code'),
      { ...codeTextStyle(ctx.theme), backgroundColor: ctx.theme.colors.codeBackground },
      node.value,
    ),

  link: (node, ctx) => {
    // Only a standalone block reaches here; in a run a blocked link is a `blockedLink` mark.
    // Drawn as its label with no press, coloured like `styleForMark` does when the token is set.
    const inner = withMark(ctx, { kind: 'link' });
    if (node.blocked) {
      const blockedColor = ctx.theme.colors.blockedLink;
      // Pressable only for a document `onLinkPress`, as in a run.
      return markText(
        ctx,
        fallbackMark('blockedLink', { href: node.href }),
        blockedColor ? { color: blockedColor } : undefined,
        renderInlines(node.children, inner),
        pressableProps(ctx, node, true, ctx.onLinkPress !== undefined),
      );
    }
    if (!node.incomplete) {
      return markText(
        ctx,
        fallbackMark('link', { href: node.href }),
        { ...linkDecoration(ctx.theme), color: ctx.theme.colors.link },
        renderInlines(node.children, inner),
        pressableProps(ctx, node, false, true),
      );
    }
    // `incomplete` means the stream has not delivered the closing paren yet,
    // so this is a `[label](https://…` that repair turned into a link node.
    // No colour, press or underline: `projectRun` emits no `link` mark for
    // one, and painting it here would flash blue until the paren arrives.
    // The surrounding text tree keeps supplying the style.
    return (
      <Text style={{ textDecorationLine: 'none' }}>
        {renderInlines(node.children, inner)}
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
      style={
        ctx.embedBox
          ? { height: ctx.embedBox.height, width: ctx.embedBox.width }
          : { height: ctx.theme.spacing.imageHeight, width: '100%' }
      }
    />
  ),

  autolink: (node, ctx) =>
    markText(
      ctx,
      fallbackMark('link', { href: node.href }),
      { color: ctx.theme.colors.link, ...linkDecoration(ctx.theme) },
      node.text ?? autolinkLabel(node.href, sliceSpan(ctx.source, node.span)),
      pressableProps(ctx, node, false, true),
    ),

  hardBreak: () => '\n',

  softBreak: (_node, ctx) => (ctx.softBreak === 'newline' ? '\n' : ' '),

  // No math typesetting in v0: raw TeX in mono italic (display math on its
  // own line via the run's block separators).
  math: (node, ctx) => (
    <Text style={{ ...codeTextStyle(ctx.theme), fontStyle: 'italic' }}>
      {node.value}
    </Text>
  ),

  spoiler: (node, ctx) => <SpoilerSpan ctx={ctx} node={node} />,

  htmlSpan: (node, ctx) => (
    <Text style={ctx.theme.html.display === 'text' ? undefined : htmlTextStyle(ctx.theme)}>
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
      <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={bodyTextStyle(ctx.theme)}>
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
  const shown = ctx.transformInline ? transformedInlines(children, ctx.transformInline) : children;
  return shown.map((child, index) => {
    const prefix = prefixStyles.get(child);
    return (
      <Fragment key={`${child.kind}:${child.span.start}:${index}`}>
        {prefix === undefined ? renderNode(child, ctx) : <Text style={prefix}>{(child as { value: string }).value}</Text>}
      </Fragment>
    );
  });
}

/** The style of each prefix's stand-in text node; see `prefixNode`. */
const prefixStyles = new WeakMap<Inline, TextStyle>();

/** A `transformInline` prefix as a zero-width text node before `node`, drawn in its style. */
function prefixNode(node: Inline, prefix: InlinePrefix): Inline {
  const out: Inline = { kind: 'text', span: { start: node.span.start, end: node.span.start }, value: prefix.text };
  prefixStyles.set(out, prefix.style ?? {});
  return out;
}

const transformedLists = new WeakMap<Inline[], { transform: InlineTransform; out: Inline[] }>();

/**
 * `transformInline` on the renderer path: hidden nodes dropped with the space
 * before them unless a word follows directly, replaced text swapped into the
 * node, prefixes put before it. Cached per list so the tree keeps its keys
 * and identities across renders.
 */
function transformedInlines(children: Inline[], transform: InlineTransform): Inline[] {
  const cached = transformedLists.get(children);
  if (cached !== undefined && cached.transform === transform) return cached.out;
  const out: Inline[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const result = transform(child);
    if (result?.hide === true) {
      const previous = out[out.length - 1];
      if (previous?.kind === 'text' && previous.value.endsWith(' ') && !startsWithWord(children[i + 1])) {
        out[out.length - 1] = { ...previous, value: previous.value.slice(0, -1) };
      }
      continue;
    }
    const prefix = result?.prefix;
    if (prefix !== undefined && prefix.text !== '' && !/[\r\n]/.test(prefix.text)) {
      out.push(prefixNode(child, prefix));
    }
    if (result?.text !== undefined) {
      out.push(replaceText(child, result.text));
      continue;
    }
    out.push(child);
  }
  transformedLists.set(children, { transform, out });
  return out;
}

function replaceText(node: Inline, text: string): Inline {
  switch (node.kind) {
    case 'text':
    case 'codeSpan':
    case 'math':
      return { ...node, value: text };
    case 'htmlSpan':
      return { ...node, literal: text };
    case 'autolink':
      return { ...node, text };
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'underline':
    case 'spoiler':
    case 'link':
      return { ...node, children: [{ kind: 'text', span: node.span, value: text }] } as Inline;
    default:
      return { kind: 'text', span: node.span, value: text };
  }
}

/** Blocks in a column, `fallback` apart unless `theme.blocks` spaces them. */
function stackBlocks(blocks: Block[], ctx: RenderContext, fallback: number): ReactNode {
  return blocks.map((block, index) => {
    const gap = index > 0 ? gapBefore(blocks[index - 1], block, ctx.theme, fallback) : 0;
    return (
      <View key={`${block.kind}:${block.span.start}:${index}`} style={gap > 0 ? { marginTop: gap } : undefined}>
        {renderNode(block, ctx)}
      </View>
    );
  });
}

/** A custom engine's autolink with no `text`: the typed slice without `<>`. */
function autolinkLabel(href: string, typed: string): string {
  const label = typed.startsWith('<') && typed.endsWith('>') ? typed.slice(1, -1) : typed;
  return label || href;
}

function linkDecoration(theme: MarkdownTheme): TextStyle {
  const { underline, underlineColor } = theme.link;
  if (underline === 'none') return { textDecorationLine: 'none' };
  const style: TextStyle = { textDecorationLine: 'underline' };
  if (underline !== 'solid') style.textDecorationStyle = underline;
  if (underlineColor !== undefined) style.textDecorationColor = underlineColor;
  return style;
}

/** A fallback-path mark, shaped like the run's so one callback serves both paths. */
function fallbackMark(kind: MarkKind, extra?: { level?: number; href?: string }): RunMark {
  const mark: RunMark = { kind, start: 0, end: 0 };
  if (extra?.level !== undefined) mark.level = extra.level;
  if (extra?.href !== undefined) mark.href = extra.href;
  return mark;
}

/** `style` with the document's `attributeForMark` for `mark` laid over it. */
function markStyle(ctx: RenderContext, mark: RunMark, style: TextStyle | undefined): TextStyle | undefined {
  const own = ctx.attributeForMark?.(mark);
  return own === undefined ? style : { ...style, ...(own as TextStyle) };
}

/**
 * One inline mark's `<Text>`, with `attributeForMark` applied and, when
 * `chipForMark` asks for one, inside an inline chip box. A chip's text starts
 * a new text root, so it restates the enclosing heading or body typography.
 * Undefined `style` and no props render the children bare.
 */
function markText(
  ctx: RenderContext,
  mark: RunMark,
  base: TextStyle | undefined,
  children: ReactNode,
  props?: TextProps,
): ReactNode {
  const style = markStyle(ctx, mark, base);
  const chip = ctx.chipForMark?.(mark);
  if (chip === undefined) {
    return style === undefined && props === undefined ? children : (
      <Text {...props} style={style}>
        {children}
      </Text>
    );
  }
  const heading = ctx.marks?.find((scope) => scope.kind === 'heading');
  const inherited =
    heading?.level !== undefined
      ? headingTextStyle(ctx.theme, heading.level as HeadingLevel)
      : bodyTextStyle(ctx.theme);
  const text: TextStyle = { ...inherited, ...style };
  if (chip.color !== undefined) text.color = chip.color;
  if (chip.fontFamily !== undefined) text.fontFamily = chip.fontFamily;
  if (chip.fontSize !== undefined) text.fontSize = chip.fontSize;
  if (chip.fontWeight !== undefined) text.fontWeight = chip.fontWeight;
  if (chip.letterSpacing !== undefined) text.letterSpacing = chip.letterSpacing;
  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: chip.backgroundColor,
        borderColor: chip.borderColor,
        borderRadius: chip.borderRadius,
        borderWidth: chip.borderWidth,
        minWidth: chip.minWidth,
        paddingHorizontal: chip.paddingHorizontal,
        paddingVertical: chip.paddingVertical,
      }}
    >
      <Text {...scaling(ctx)} {...props} style={text}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Press and screen-reader props for a link-shaped range, after
 * `accessibilityForPressable`: 'none' is inert, 'text' keeps the press but
 * not the role.
 */
function pressableProps(
  ctx: RenderContext,
  node: AnyNode & { href: string; span: { start: number; end: number } },
  blocked: boolean,
  pressable: boolean,
): TextProps | undefined {
  const a11y = ctx.accessibilityForPressable?.({ href: node.href, blocked, text: textContentOf(node, ctx.source) });
  const role = a11y?.role ?? 'link';
  if (role === 'none' || !pressable) return undefined;
  const props: TextProps = { onPress: (event) => pressLink(ctx, node, blocked, event) };
  if (!blocked && role !== 'text') props.accessibilityRole = role;
  if (a11y?.label !== undefined) props.accessibilityLabel = a11y.label;
  return props;
}

function highlighted(value: string, ctx: RenderContext): ReactNode {
  const ranges = ctx.highlight ? queryRanges(value, ctx.highlight) : [];
  if (ranges.length === 0) return value;
  const style: TextStyle = { backgroundColor: ctx.theme.colors.highlight };
  if (ctx.theme.colors.highlightText !== undefined) style.color = ctx.theme.colors.highlightText;
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) out.push(value.slice(cursor, range.start));
    out.push(
      <Text key={range.start} style={style}>
        {value.slice(range.start, range.end)}
      </Text>,
    );
    cursor = range.end;
  }
  if (cursor < value.length) out.push(value.slice(cursor));
  return out;
}

/**
 * Standalone block layout: each block in its own view with vertical rhythm.
 * Used outside prose runs (code blocks, tables, and custom compositions).
 */
export function renderBlocks(blocks: Block[], ctx: RenderContext): ReactNode {
  return stackBlocks(blocks, ctx, ctx.theme.spacing.blockGap);
}
