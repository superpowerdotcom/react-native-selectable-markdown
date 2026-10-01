import { IS_DEV } from '../dev';
import type {
  MarkKind,
  ProjectedRun,
  ProjectedRunEmbed,
  RunMark,
} from '../selection/mapSelection';
import { isReservableEmbedSize } from './runEmbeds';
import type { MarkdownTheme, ThemeFontWeight } from './theme';
import { headingFontSize } from './theme';

/**
 * Theme resolution for the native selection host.
 *
 * WHY THIS EXISTS. The native host renders `ProjectedRun.text` verbatim —
 * that is the contract selection mapping depends on (docs/SELECTION.md) —
 * which used to mean it rendered *only* that text: unstyled, system font, no
 * headings, no bold, no link colour, and a spoiler's content in the clear.
 * The rich React Native tree built alongside it was passed to `RunHost` as
 * children and then dropped on the floor whenever the native component was
 * linked, so the better-looking path was the one you got when the native
 * module was missing. (That children tree is gone — `RunHost` throws without
 * a native host now — but the styling this module produces is what keeps the
 * native run and the standalone-block renderer looking like one document.)
 *
 * Styling does not change a single character of the text, so attributing it
 * is strictly additive: offsets, the piece table and every mapping built on
 * them are untouched. That is what makes this the fix rather than a second,
 * competing render path.
 *
 * The values here are kept deliberately close to `renderers.tsx` — the
 * standalone-block renderer and the native run should not visibly disagree
 * about what a heading or a code span looks like. That renderer is not a
 * degraded tier: every standalone block goes through it.
 */
/**
 * A block role a screen reader announces, carried over a range of the run.
 * Limited to roles both platforms announce natively, so no untranslated string
 * ships; links travel as `pressables` instead.
 */
export type RunSemanticRole = 'heading' | 'listItem' | 'tableCell';

export interface RunTextAttribute {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
  /**
   * What this range is for a screen reader; not settable through `attributeForMark`.
   * A `listItem` holding a nested construct ends where that construct begins.
   */
  role?: RunSemanticRole;
  /** A heading's level (1-6) or a list item's depth (1 at top level). Both hosts currently drop it. */
  roleLevel?: number;
  /**
   * One-based position among siblings, positional rather than the marker's
   * number; a table's header row is row 1. One-based because 0 means absent.
   */
  roleRow?: number;
  /** The list's length, or the table's row count including the header. Absent with `roleRow`. */
  roleRowCount?: number;
  /** One-based column, `tableCell` only. */
  roleColumn?: number;
  /** The table's column count. Absent with `roleColumn`. */
  roleColumnCount?: number;
  fontFamily?: string;
  fontSize?: number;
  /**
   * Absolute line height in points, not a multiplier — the same unit RN's
   * `TextStyle.lineHeight` takes, so the fallback tree and the native host are
   * given the identical number rather than each deriving one.
   *
   * IT IS A MEASUREMENT INPUT, NOT DECORATION, which is why it is worth a
   * field of its own rather than being left to the platform. The
   * standalone-block renderer has always set `baseSize *
   * theme.fonts.lineHeight` on body text and
   * `headingSize * …` on headings (`renderers.tsx`); the native host set
   * nothing and rendered at the platform's natural leading, so linking the
   * native module visibly compressed the whole document — the failure this
   * module's header describes, where the better-looking path was the one you
   * got when the native module was missing. Under a Fabric shadow node it
   * stops being cosmetic: the node measures the string the view will draw, so
   * a line height the measurer does not know about produces a perfectly
   * correct measurement of the wrong typography, and the run is laid out at a
   * height its own text does not fit into.
   */
  lineHeight?: number;
  /** A `ThemeFontWeight` string because that is what RN's TextStyle uses. */
  fontWeight?: ThemeFontWeight;
  fontStyle?: 'normal' | 'italic';
  textDecorationLine?: 'none' | 'underline' | 'line-through';
  color?: string;
  backgroundColor?: string;
}

/** `RunTextAttribute` without the range or the semantic fields, which a mark may not override. */
export type RunMarkStyle = Omit<
  RunTextAttribute,
  | 'start'
  | 'end'
  | 'role'
  | 'roleLevel'
  | 'roleRow'
  | 'roleRowCount'
  | 'roleColumn'
  | 'roleColumnCount'
>;

/**
 * One mark's contribution. Sparse on purpose: a mark says only what it
 * changes, so `strong` inside a `heading` keeps the heading's size and
 * colour and overrides nothing else.
 */
function styleForMark(mark: RunMark, theme: MarkdownTheme): RunMarkStyle {
  const kind: MarkKind = mark.kind;
  switch (kind) {
    case 'emphasis':
      return { fontStyle: 'italic' };
    case 'strong': {
      // `strongFamily` / `colors.strong` contribute only when set: a design
      // whose bold is a family swap (one font file per family — a weight
      // alone silently renders regular on iOS) states it in the theme
      // instead of via `attributeForMark`.
      const strong: RunMarkStyle = {
        fontWeight: theme.fonts.strongWeight,
      };
      if (theme.fonts.strongFamily !== undefined) {
        strong.fontFamily = theme.fonts.strongFamily;
      }
      if (theme.colors.strong !== undefined) {
        strong.color = theme.colors.strong;
      }
      return strong;
    }
    case 'strikethrough':
      return { textDecorationLine: 'line-through' };
    case 'underline':
      return { textDecorationLine: 'underline' };
    case 'code':
      return {
        fontFamily: theme.fonts.mono,
        fontSize: theme.code.fontSize,
        color: theme.colors.codeText,
        backgroundColor: theme.colors.codeBackground,
      };
    case 'codeBlock':
      return {
        fontFamily: theme.fonts.mono,
        fontSize: theme.code.fontSize,
        color: theme.colors.codeText,
      };
    case 'math':
      return {
        fontFamily: theme.fonts.mono,
        fontSize: theme.code.fontSize,
        color: theme.colors.codeText,
        fontStyle: 'italic',
      };
    case 'html':
      return {
        fontFamily: theme.fonts.mono,
        fontSize: theme.code.fontSize,
        color: theme.colors.muted,
      };
    case 'link':
      return { color: theme.colors.link, textDecorationLine: 'underline' };
    case 'blockedLink':
      // CONTRIBUTES NOTHING UNTIL THE CONSUMER ASKS. `blockedLink` is a new
      // mark over ranges that previously carried none, so any unconditional
      // style here would be a visual change nobody opted into — and a
      // *regressive* one, because marks apply outermost-first with the inner
      // winning, so a colour returned here would override the heading colour
      // of a blocked link inside a heading. An absent `colors.blockedLink`
      // therefore means "keep looking like the text around it", which is
      // exactly what these ranges looked like before the mark existed.
      //
      // No underline even when coloured: the URL policy refused this href as a
      // destination, and an underline is the one affordance that reads as
      // "this navigates". Consumers who want it can style the range themselves.
      return theme.colors.blockedLink ? { color: theme.colors.blockedLink } : {};
    case 'spoiler':
      // Foreground painted with the mask colour, exactly as `SpoilerSpan`
      // does. Without it the native host showed every spoiler's content in
      // the clear — the one styling gap here that was a confidentiality bug
      // and not a cosmetic one.
      return {
        color: theme.colors.spoilerMask,
        backgroundColor: theme.colors.spoilerMask,
      };
    case 'heading': {
      // The line height comes with the font size and cannot be left behind: a
      // 26pt heading laid out on the body's 22.4pt leading has its ascenders
      // clipped by the line above it on both platforms. Same multiplier and
      // same `headingFontSize` rounding as the `heading` renderer, so the
      // fallback and the native host measure to the same height.
      const fontSize = headingFontSize(theme, (mark.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6);
      return {
        color: theme.colors.heading,
        fontSize,
        // `headings.lineHeight` pins every level to one absolute leading (a
        // design that lays headings on the body's grid); unset falls back to
        // the multiplier.
        lineHeight: theme.headings.lineHeight ?? fontSize * theme.fonts.lineHeight,
        fontWeight: theme.headings.weight,
      };
    }
    case 'blockquote':
      return { color: theme.colors.quoteText };
    case 'tableHeader':
      return { fontWeight: theme.table.headerWeight };
    // 'listMarker' follows the blockedLink philosophy: it contributes nothing
    // until the consumer asks (via `colors.listMarker` or `attributeForMark`),
    // so adding the mark changes no document nobody restyled.
    case 'listMarker':
      return theme.colors.listMarker ? { color: theme.colors.listMarker } : {};
    // These style no characters — 'table' covers text whose styling the
    // inner marks (tableHeader, and whatever the cells hold) already carry,
    // 'thematicBreak' is zero-length so there is nothing to style, and a
    // 'listItem' looks like the prose it contains. All three exist for the
    // DECORATION channel (`runDecorations.ts`): the border box, the row
    // rules, the horizontal rule, the list indents.
    // An empty object drops the mark from the wire unless it carries a role, as 'listItem' does.
    case 'table':
    case 'thematicBreak':
    case 'listItem':
      return {};
    // The embed range's ONLY styling is the geometry attribute
    // `resolveRunAttributes` appends itself (transparent colour + the
    // reserved line height) — appended outside the mark→style path on
    // purpose, so neither this function nor an `attributeForMark` override
    // can drop it: it is a measurement input, not a look. Contributing
    // nothing here keeps the mark out of the overridable channel entirely.
    case 'embed':
      return {};
  }
}

type RunSemantics = Pick<
  RunTextAttribute,
  'role' | 'roleLevel' | 'roleRow' | 'roleRowCount' | 'roleColumn' | 'roleColumnCount'
>;

/** Headings and list items ride their mark's entry (`forMark`); table cells have no mark, so they come back as entries of their own (`cells`). */
interface RunSemanticsIndex {
  readonly forMark: Map<RunMark, MarkSemantics>;
  readonly cells: readonly RunTextAttribute[];
}

interface MarkSemantics {
  readonly semantics: RunSemantics;
  /** Set when a nested construct cut the mark short; absent means the mark's own `end`. */
  readonly end?: number;
}

function covers(outer: RunMark, inner: RunMark): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

interface OpenList {
  level: number;
  items: RunMark[];
  lastEnd: number;
}

/**
 * Lists group by parent item and split where a blank line separates two
 * adjacent lists; two sublists inside one item merge into one collection.
 * Table cells come from splitting the 'table' mark's text on '\n' and '\t', the
 * same rule as the 'columns' decoration, and row 1 is the header row.
 * An item's range stops at its first nested construct with the separator
 * trimmed: iOS `enumerateAttribute` merges adjacent equal runs otherwise.
 */
function resolveRunSemantics(projected: ProjectedRun): RunSemanticsIndex {
  const forMark = new Map<RunMark, MarkSemantics>();
  const cells: RunTextAttribute[] = [];
  // The enclosing `listItem` marks, innermost last.
  const open: RunMark[] = [];
  // Where an item's own text stops, when a nested construct cut it short.
  const ownEnd = new Map<RunMark, number>();
  // The list currently open under each parent item (`null` = top level).
  const openLists = new Map<RunMark | null, OpenList>();
  const finished: OpenList[] = [];

  for (const mark of projected.marks) {
    if (mark.kind === 'heading') {
      forMark.set(mark, { semantics: headingSemantics(mark) });
    }
    // Tables and headings vend ranges of their own, so they cut the enclosing item's text too.
    if (mark.kind !== 'listItem' && mark.kind !== 'table' && mark.kind !== 'heading') continue;
    while (open.length > 0 && !covers(open[open.length - 1], mark)) {
      open.pop();
    }
    const parent = open.length > 0 ? open[open.length - 1] : null;
    // Marks arrive in document order, so the first nested construct sets the cut.
    if (parent !== null && !ownEnd.has(parent)) ownEnd.set(parent, mark.start);
    if (mark.kind === 'heading') continue;
    if (mark.kind === 'table') {
      collectTableCells(mark, projected.text, cells);
      continue;
    }
    const level = mark.level !== undefined && mark.level > 0 ? mark.level : 0;
    const current = openLists.get(parent);
    if (
      current !== undefined &&
      current.level === level &&
      !projected.text.slice(current.lastEnd, mark.start).includes('\n\n')
    ) {
      current.items.push(mark);
      current.lastEnd = mark.end;
    } else {
      if (current !== undefined) finished.push(current);
      openLists.set(parent, { level, items: [mark], lastEnd: mark.end });
    }
    open.push(mark);
  }
  for (const list of openLists.values()) finished.push(list);

  for (const list of finished) {
    for (let index = 0; index < list.items.length; index += 1) {
      const item = list.items[index];
      const semantics: RunSemantics = {
        role: 'listItem',
        roleRow: index + 1,
        roleRowCount: list.items.length,
      };
      // 0 is the absent sentinel, so an unstated depth is left off.
      if (list.level > 0) semantics.roleLevel = list.level;
      const cut = ownEnd.get(item);
      if (cut === undefined) {
        forMark.set(item, { semantics });
        continue;
      }
      const end = trimTrailingSpace(projected.text, item.start, cut);
      // No own text, no entry; still counted, so siblings keep their positions.
      if (end <= item.start || !hasSourceText(projected, item.start, end)) continue;
      forMark.set(item, { semantics, end });
    }
  }
  return { forMark, cells };
}

function hasSourceText(projected: ProjectedRun, start: number, end: number): boolean {
  let lo = 0;
  let hi = projected.pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (projected.pieces[mid].textEnd <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < projected.pieces.length && projected.pieces[i].textStart < end; i++) {
    if (projected.pieces[i].source !== null) return true;
  }
  return false;
}

/** `to`, backed off any trailing whitespace, never past `from`. */
function trimTrailingSpace(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/.test(text.charAt(end - 1))) end -= 1;
  return end;
}

function headingSemantics(mark: RunMark): RunSemantics {
  const level = mark.level;
  // Out of range: still a heading, but no level (unlike `styleForMark`'s sizing default of 1).
  if (level === undefined || level < 1 || level > 6) return { role: 'heading' };
  return { role: 'heading', roleLevel: level };
}

function splitCells(body: string, from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cursor = from;
  for (;;) {
    const next = body.indexOf('\t', cursor);
    if (next < 0 || next >= to) {
      out.push({ start: cursor, end: to });
      return out;
    }
    out.push({ start: cursor, end: next });
    cursor = next + 1;
  }
}

function collectTableCells(
  table: RunMark,
  text: string,
  out: RunTextAttribute[],
): void {
  if (table.end <= table.start) return;
  const body = text.slice(table.start, table.end);
  const rows: { start: number; end: number }[][] = [];
  let cursor = 0;
  for (;;) {
    const next = body.indexOf('\n', cursor);
    const end = next < 0 ? body.length : next;
    rows.push(splitCells(body, cursor, end));
    if (next < 0) break;
    cursor = next + 1;
  }
  // Widest row, not the header: a consumer-built projection need not be GFM-normalized.
  let columnCount = 0;
  for (const row of rows) columnCount = Math.max(columnCount, row.length);
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      const cell = rows[row][column];
      // Skipped but counted, so neighbouring columns keep their indices.
      if (cell.end <= cell.start) continue;
      out.push({
        start: table.start + cell.start,
        end: table.start + cell.end,
        role: 'tableCell',
        roleRow: row + 1,
        roleRowCount: rows.length,
        roleColumn: column + 1,
        roleColumnCount: columnCount,
      });
    }
  }
}

/**
 * The attribute run that covers the whole text: the body style every
 * character starts from. Sent explicitly rather than left to the host's
 * default so that a theme change is a prop change, not a native rebuild.
 */
function baseAttribute(length: number, theme: MarkdownTheme): RunTextAttribute {
  return {
    start: 0,
    end: length,
    fontFamily: theme.fonts.body,
    fontSize: theme.fonts.baseSize,
    // The same product `bodyTextStyle` puts on every fallback paragraph. Sent
    // on the base run so that a run with no marks at all still carries it:
    // an unstyled paragraph is the common case, and it is the one where the
    // native host and the fallback disagreeing about leading is most visible.
    lineHeight: theme.fonts.baseSize * theme.fonts.lineHeight,
    fontWeight: '400',
    fontStyle: 'normal',
    textDecorationLine: 'none',
    color: theme.colors.text,
  };
}

/**
 * Per-mark styling, overriding the theme for that one range.
 *
 * WHY A CALLBACK AND NOT MORE THEME TOKENS. The theme carries one value per
 * concept, and real consumers need per-instance decisions the tokens cannot
 * express:
 *
 * - Two blocked schemes that must look different. An app whose URL policy
 *   rejects both `#…-citation-3` (a marker the reader should see) and
 *   `product://…` (an identifier that should read as ordinary prose) cannot say
 *   that with a single `colors.blockedLink`. The href is the only thing that
 *   separates them, and `RunMark` carries it.
 * - Per-level heading sizes. `headingFontSize` derives all six from
 *   `fonts.baseSize` by a fixed scale; an app with a designed type ramp
 *   (24/20/20/20/13/11, say) has no way to state it. `mark.level` is here.
 * - A bold FACE rather than a weight. An app shipping one file per family
 *   cannot use `fontWeight: '700'` — iOS resolves it within the single-face
 *   family and silently renders regular, so `strong` needs a family swap.
 *
 * Before this hook, a consumer's only route to any of that was the JS renderer
 * tree, which the native host does not use — so linking the native module
 * quietly replaced a designed document with the theme's approximation of it.
 *
 * Return `undefined` to accept the theme's styling for that mark. An empty
 * object is meaningful and different: it means "style this like the surrounding
 * text", which is how a consumer suppresses a token it set for other instances
 * of the same kind.
 *
 * The returned object replaces the theme's styling, so a `fontSize` above the
 * base needs a matching `lineHeight` or its ascenders clip (DEV warns once).
 * Return a `lineHeight` only for a mark spanning a whole block: iOS drops it
 * mid-paragraph while Android applies it to every line the mark touches.
 */
export type MarkAttribute = (mark: RunMark) => RunMarkStyle | undefined;



const warnedUnpairedFontSize = new Set<string>();

export function resetUnpairedFontSizeWarningsForTests(): void {
  warnedUnpairedFontSize.clear();
}

function warnUnpairedFontSize(
  mark: RunMark,
  style: RunMarkStyle,
  theme: MarkdownTheme,
): void {
  if (style.fontSize === undefined || style.lineHeight !== undefined) return;
  if (style.fontSize <= theme.fonts.baseSize) return;
  if (warnedUnpairedFontSize.has(mark.kind)) return;
  warnedUnpairedFontSize.add(mark.kind);
  console.warn(
    `[react-native-selectable-markdown] attributeForMark returned fontSize ` +
      `${style.fontSize} for a "${mark.kind}" mark with no lineHeight; it will ` +
      `be laid out on the base run's ${theme.fonts.baseSize * theme.fonts.lineHeight}pt ` +
      `leading and its ascenders will be clipped. A fontSize this size needs a ` +
      `lineHeight to sit in — see MarkAttribute for both rules about it.`,
  );
}

/**
 * Resolve a projected run's marks into styled ranges for the native host.
 * Returned in application order (the base run, then marks outermost-first), so
 * applying them in sequence lets the innermost construct win. Ranges overlap.
 */
export function resolveRunAttributes(
  projected: ProjectedRun,
  theme: MarkdownTheme,
  attributeForMark?: MarkAttribute,
): RunTextAttribute[] {
  if (projected.text.length === 0) return [];
  const out: RunTextAttribute[] = [baseAttribute(projected.text.length, theme)];
  const semantics = resolveRunSemantics(projected);
  for (const mark of projected.marks) {
    // Embed marks bypass the overridable mark→style path entirely — their
    // one attribute is the geometry entry appended below, which neither the
    // theme nor `attributeForMark` may drop or restyle.
    if (mark.kind === 'embed') continue;
    const override = attributeForMark?.(mark);
    const style = override ?? styleForMark(mark, theme);
    if (IS_DEV && override !== undefined) {
      warnUnpairedFontSize(mark, override, theme);
    }
    // Spread after the style, so no hook can restyle the role away.
    const semantic = semantics.forMark.get(mark);
    if (Object.keys(style).length === 0 && semantic === undefined) continue;
    out.push({
      start: mark.start,
      end: semantic?.end ?? mark.end,
      ...style,
      ...semantic?.semantics,
    });
  }
  for (const cell of semantics.cells) out.push(cell);
  // The embed geometry attributes, appended LAST so they sit innermost and
  // win over any covering construct's styling. Two fields, both load-bearing:
  //
  // - `lineHeight: content.height` is how the reservation's HEIGHT reaches
  //   both platforms: their line-height machinery CLAMPS lines (min AND max —
  //   RNSMAttributedText's paragraph styles, Android's RunLineHeightSpan), so
  //   without this entry a tall embed's attachment would be squashed into the
  //   body leading — measured *and* drawn wrong, consistently. A block embed
  //   is its own paragraph (block separators are '\n\n'), so the height lands
  //   exactly on the embed's line; an inline embed grows only its own line on
  //   Android and must fit the paragraph's leading on iOS (paragraph style
  //   resolves from the paragraph's first character) — the documented
  //   inline-chip constraint.
  //
  // - `color: 'transparent'` is version skew: a binary that predates the
  //   `embeds` prop renders the U+FFFC placeholder as an actual glyph (tofu
  //   on most fonts). Attributes predate embeds, so the transparent colour
  //   DOES reach such a binary and the degradation is an invisible
  //   one-character gap instead. On a current binary the attachment replaces
  //   the glyph and foreground colour is inert.
  if (projected.embeds !== undefined) {
    // Never shrink the line: both hosts clamp line height both ways, so the floor is
    // the tallest line height already on the placeholder.
    const floors = embedLineHeightFloors(out, projected.embeds);
    for (let i = 0; i < projected.embeds.length; i += 1) {
      const embed = projected.embeds[i];
      const geometry: RunTextAttribute = {
        start: embed.start,
        end: embed.end,
        color: 'transparent',
      };
      // An unreservable size gets no line height (`Infinity` breaks the measurer). The
      // transparent colour stays, or the bare U+FFFC renders as tofu.
      if (isReservableEmbedSize(embed.content)) {
        geometry.lineHeight = Math.max(embed.content.height, floors[i]);
      }
      out.push(geometry);
    }
  }
  return out;
}

interface CoveringLineHeight {
  lineHeight: number;
  end: number;
}

/**
 * The tallest `lineHeight` covering each embed's placeholder, 0 where none does,
 * in `embeds` order. A max-heap sweep whose lazy deletion requires placeholders
 * visited in non-decreasing `end` order.
 */
function embedLineHeightFloors(
  attributes: readonly RunTextAttribute[],
  embeds: readonly ProjectedRunEmbed[],
): number[] {
  const floors = new Array<number>(embeds.length).fill(0);
  const byStart: { start: number; span: CoveringLineHeight }[] = [];
  for (const attribute of attributes) {
    if (attribute.lineHeight === undefined) continue;
    byStart.push({
      start: attribute.start,
      span: { lineHeight: attribute.lineHeight, end: attribute.end },
    });
  }
  if (byStart.length === 0) {
    return floors;
  }
  byStart.sort((a, b) => a.start - b.start);
  // Sorted by `end` explicitly because retirement reads it; sorting indices keeps `embeds` order.
  const order = embeds
    .map((_, index) => index)
    .sort(
      (a, b) => embeds[a].end - embeds[b].end || embeds[a].start - embeds[b].start,
    );

  const heap: CoveringLineHeight[] = [];
  let next = 0;
  for (const index of order) {
    const embed = embeds[index];
    while (next < byStart.length && byStart[next].start <= embed.start) {
      heapPush(heap, byStart[next].span);
      next += 1;
    }
    while (heap.length > 0 && heap[0].end < embed.end) {
      heapPop(heap);
    }
    floors[index] = heap.length > 0 ? heap[0].lineHeight : 0;
  }
  return floors;
}

/** Binary max-heap on `lineHeight`; see `embedLineHeightFloors`. */
function heapPush(heap: CoveringLineHeight[], item: CoveringLineHeight): void {
  heap.push(item);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (heap[parent].lineHeight >= heap[child].lineHeight) break;
    const swap = heap[parent];
    heap[parent] = heap[child];
    heap[child] = swap;
    child = parent;
  }
}

function heapPop(heap: CoveringLineHeight[]): void {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return;
  heap[0] = last;
  let parent = 0;
  for (;;) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let largest = parent;
    if (left < heap.length && heap[left].lineHeight > heap[largest].lineHeight) {
      largest = left;
    }
    if (right < heap.length && heap[right].lineHeight > heap[largest].lineHeight) {
      largest = right;
    }
    if (largest === parent) break;
    const swap = heap[parent];
    heap[parent] = heap[largest];
    heap[largest] = swap;
    parent = largest;
  }
}
