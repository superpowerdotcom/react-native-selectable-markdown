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
 * A block-level role a screen reader has to be able to hear, carried over a
 * character range of the run.
 *
 * WHY IT IS A CHANNEL OF ITS OWN AND NOT A STYLE. Run merging is what makes
 * this library's headline feature work — one sweep selects across a whole
 * answer — and it is also what flattens the JS renderer tree's semantics:
 * `accessibilityRole="header"` in `renderers.tsx` runs for standalone blocks
 * only, so a heading that flows into a run reached a screen reader as
 * ordinary prose in a larger font. The hosts cannot recover the role from the
 * styling, and the one that tried had to guess from a font-size-plus-line-
 * height-plus-weight shape that any `attributeForMark` could counterfeit or
 * erase. This field is what ends the guessing: the mark kind, said out loud,
 * on the same ranges the styling already travels on.
 *
 * THE SET IS BOUNDED BY WHAT THE PLATFORMS CAN SAY WITHOUT A STRING FROM US.
 * Every role here is announced by the reader in the reader's own language,
 * because each maps to a platform primitive:
 *
 * - 'heading' — `UIAccessibilityTraits.header`, `AccessibilityNodeInfo
 *   .setHeading(true)`. Also what the headings rotor and TalkBack's
 *   heading-by-heading navigation filter on.
 * - 'listItem' — `AccessibilityNodeInfo.CollectionItemInfo` against the
 *   host's `CollectionInfo`, which is what makes TalkBack say "item 2 of 5"
 *   in its own words. iOS has no list trait, so there the role buys
 *   navigation granularity instead: one VoiceOver element per item rather
 *   than one for the whole run. An item's range is its OWN text and stops
 *   where a nested sublist or table begins — see `resolveRunSemantics`.
 * - 'tableCell' — the same `CollectionItemInfo`, with a column as well as a
 *   row, and the header row flagged so TalkBack can name the column. Again
 *   an element per cell on iOS.
 *
 * WHAT IS DELIBERATELY ABSENT, and why. A code block and a blockquote have
 * no primitive on either platform, so announcing them would mean shipping an
 * English word this library cannot translate — the same reason neither host
 * ships a role description string for a link. They stay flat, and
 * docs/SELECTION.md says so.
 *
 * Links are NOT here either, for a different reason. They already cross as
 * `pressables` (`runPressables.ts`), which is the list both hosts hit-test
 * and vend accessibility elements from, so a second copy of the same ranges
 * would be two sources of truth for one construct.
 *
 * WHAT IT COSTS ON THE WIRE, because the attribute array crosses on every
 * streamed snapshot: one extra entry per list item and per table cell, each
 * carrying nothing but its role and two or four small integers. A
 * twenty-item list is twenty entries. That is the reason the set stays this
 * small — a role neither host could announce would be entries bought and
 * never spent — and the reason the entries carry no styling: a role-only
 * entry sets no span on Android and no attribute but the semantic one on
 * iOS, so it cannot move a glyph.
 */
export type RunSemanticRole = 'heading' | 'listItem' | 'tableCell';

export interface RunTextAttribute {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
  /**
   * What this range IS, for a screen reader — see `RunSemanticRole`. Absent
   * on the ranges that only say what the text looks like, which is most of
   * them.
   *
   * NOT REACHABLE FROM `attributeForMark`, on purpose, and the type says so:
   * `MarkAttribute` returns a `RunMarkStyle`, which is this interface without
   * the two semantic fields. A styling hook may restyle a heading into
   * anything a design wants and may not turn it into something a screen
   * reader no longer calls a heading — the same reasoning that keeps an
   * embed's geometry attribute outside that hook.
   *
   * THE ENTRY'S RANGE IS THE CONSTRUCT'S OWN TEXT. For a heading and a table
   * cell that is the mark's whole range; for a `listItem` holding a sublist
   * or a table it stops where that nested construct begins, because the
   * nested construct vends entries of its own and both hosts turn an entry
   * into a focus stop (`resolveRunSemantics` has the whole argument). A
   * consumer's `attributeForMark` styling for that mark rides the same
   * narrowed entry, which costs it only the separator between the item's
   * text and its sublist — every nested item carries the same override on
   * its own entry.
   */
  role?: RunSemanticRole;
  /**
   * The role's DEPTH, where its role has one: a heading's level (1-6), or a
   * list item's nesting depth (1 for a top-level list's items). Absent
   * otherwise.
   *
   * SENT, AND DROPPED BY BOTH HOSTS TODAY, because neither platform has a
   * primitive that carries a rank: `UIAccessibilityTraits.header` is a bit,
   * `AccessibilityNodeInfo.setHeading(true)` is a boolean, and
   * `CollectionItemInfo` — where a list item's depth would have to go — has
   * no depth field. The only vehicle left on either side is the announced
   * label, and putting "heading level 2" there means shipping an English
   * string this library cannot translate. Both hosts say so at the place they
   * drop it. It crosses anyway because a role that arrives without its level
   * could not be given one later without a second wire change, and because a
   * consumer reading the attributes directly can use what the platforms
   * cannot.
   */
  roleLevel?: number;
  /**
   * The range's ONE-BASED position among its siblings: a list item's place in
   * its own list, a table cell's row (the header row is row 1). Absent for a
   * role that is not part of a collection, and for the first three fields'
   * sake it is one-based rather than zero-based — every count and index on
   * this struct uses 0 as the absent sentinel, and a zero-based first row
   * could not be told from an absent one.
   *
   * BOTH HOSTS SUBTRACT ONE. `AccessibilityNodeInfo.CollectionItemInfo` is
   * zero-based, and that conversion is the hosts' whole arithmetic: the
   * counting itself happens here, once, off the render path, where the marks
   * that define a list's extent are.
   *
   * A list item's position is POSITIONAL, not the number in its marker
   * glyph: `1. ` in a list that starts at 5 projects "5. " into the text a
   * reader hears anyway, while "item 1 of 3" is about where in the list the
   * focus is.
   */
  roleRow?: number;
  /**
   * How many siblings the range has in total: the length of its list, or the
   * table's row count including the header row. Absent with `roleRow`.
   */
  roleRowCount?: number;
  /**
   * The range's one-based column, for a role laid out in two dimensions —
   * `tableCell` only. Absent for a list item, which both hosts read as a
   * one-column collection.
   */
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

/**
 * What a mark may say about how its range LOOKS: `RunTextAttribute` without
 * the range and without the semantic fields, which are not a look and are not
 * negotiable (see `RunTextAttribute.role`).
 */
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
    //
    // An empty object means `resolveRunAttributes` drops the mark from the
    // wire UNLESS it also carries a role, which is what 'listItem' now does:
    // its entry exists to say "item 3 of 7" and carries no styling at all. A
    // 'table' likewise seeds the `tableCell` entries without acquiring a
    // look of its own.
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

/**
 * What a range IS, as opposed to what it looks like — see `RunSemanticRole`
 * for why the two are separate channels and what bounds the set.
 */
type RunSemantics = Pick<
  RunTextAttribute,
  'role' | 'roleLevel' | 'roleRow' | 'roleRowCount' | 'roleColumn' | 'roleColumnCount'
>;

/**
 * Every semantic range of one run.
 *
 * TWO HALVES BECAUSE THE PROJECTION HAS TWO SHAPES. A heading and a list item
 * each ARE a mark, so their roles ride on the entry that mark already
 * produces (`forMark`, keyed by mark identity). A table CELL is not a mark —
 * the projector emits a table as one 'table' mark over tab-separated,
 * newline-separated text — so cells come back as free-standing attribute
 * entries the caller appends (`cells`).
 */
interface RunSemanticsIndex {
  readonly forMark: Map<RunMark, MarkSemantics>;
  readonly cells: readonly RunTextAttribute[];
}

/** One mark's role, plus the range it covers when that is narrower than the
 * mark. */
interface MarkSemantics {
  readonly semantics: RunSemantics;
  /**
   * Where the entry ends, when a nested construct cut the mark short. Absent
   * means the mark's own `end`. There is no narrowed START: every construct
   * with a role opens at its mark (a list item at its marker glyph), and only
   * what it CONTAINS can shorten it.
   */
  readonly end?: number;
}

/** Whether `outer` fully covers `inner`. */
function covers(outer: RunMark, inner: RunMark): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** One list being accumulated: the items seen so far under one parent. */
interface OpenList {
  level: number;
  items: RunMark[];
  /** Where the last item ended, for the blank-line test below. */
  lastEnd: number;
}

/**
 * The roles of every range in a run, derived from the marks (and, for table
 * cells, from the text those marks cover).
 *
 * HEADINGS are one mark each and carry their own level.
 *
 * LIST ITEMS need their SIBLINGS, which is the whole reason this is a pass
 * over the run rather than a function of one mark: "item 2 of 5" cannot be
 * derived from item 2. Items are grouped by their parent item — marks are
 * sorted outermost-first, so the innermost enclosing `listItem` mark is the
 * parent, and a parent mark is unique, which makes it a usable key. Two
 * ADJACENT lists under the same parent are separated by the blank line the
 * projector puts between blocks (`BLOCK_SEPARATOR`, where items inside one
 * list are one `ITEM_SEPARATOR` apart), so that is the split. The one shape
 * this approximates is two sublists inside a single list item — `- a` then
 * `* b` under one bullet — which are one line apart and merge into one
 * collection; the announcement is then "1 of 2" instead of "1 of 1", which is
 * the mildest way to be wrong about a construct almost nobody writes.
 *
 * TABLE CELLS have no mark at all. The projector emits a table as its header
 * row and body rows joined by `ROW_SEPARATOR` ('\n'), each row's cells joined
 * by `CELL_SEPARATOR` ('\t'), all under one 'table' mark — so the geometry is
 * recovered by splitting that mark's text, which is exactly what the hosts
 * already do for the table's column decoration (`runDecorations.ts`, kind
 * 'columns'). A cell cannot contain a newline (a literal newline ends a GFM
 * table row in the source), so the row split is exact; a cell CAN contain a
 * literal tab, which would read as an extra column — the same approximation
 * the column decoration has always made, and the reason both live off one
 * documented rule rather than two.
 *
 * ROW 1 IS THE HEADER ROW, and the hosts may rely on it: a GFM table has
 * exactly one header row and it is first, which is what lets Android flag
 * those cells so TalkBack can name a column without this library shipping the
 * word "header" in English.
 *
 * AN ITEM'S RANGE IS ITS OWN TEXT, NOT ITS SUBTREE. A `listItem` mark covers
 * its marker glyph and everything the item contains, nested sublists and
 * tables included (`mapSelection.ts` says so), and both hosts turn one entry
 * into one focus stop — so sending the mark's whole range made a parent item
 * announce its sublist as part of itself AND the sublist announce itself
 * again. Each host got that wrong in its own direction, which is worse than
 * either: iOS reads the ranges back off attribute runs, so the parent's value
 * sat over the child's and the two sublist items lost their focus stops
 * entirely; Android builds a node per entry, so it vended parent and children
 * and read the sublist twice. The entry therefore stops at the first nested
 * construct that vends ranges of its own — a `listItem` or a `table` — with
 * the separator between them trimmed off, so the two hosts agree: one element
 * per item, covering exactly the characters that item alone contributes, and
 * every character announced once.
 *
 * The trim is load-bearing on iOS and not just tidiness: an item's text and
 * its sublist are one `ITEM_SEPARATOR` apart, and `enumerateAttribute` merges
 * ADJACENT runs carrying an equal value — so a parent range left touching its
 * first child's would come back as the single range this narrowing exists to
 * split.
 */
function resolveRunSemantics(projected: ProjectedRun): RunSemanticsIndex {
  const forMark = new Map<RunMark, MarkSemantics>();
  const cells: RunTextAttribute[] = [];
  // The enclosing `listItem` marks, innermost last.
  const open: RunMark[] = [];
  // Where each list item's own text stops, for the items a nested construct
  // cut short. Keyed by the item MARK, which is unique.
  const ownEnd = new Map<RunMark, number>();
  // The list currently open under each parent item (`null` = top level).
  // Keyed by the parent MARK, which is unique, so an entry can never be
  // reused by an unrelated list.
  const openLists = new Map<RunMark | null, OpenList>();
  const finished: OpenList[] = [];

  for (const mark of projected.marks) {
    if (mark.kind === 'heading') {
      forMark.set(mark, { semantics: headingSemantics(mark) });
      continue;
    }
    // Both kinds vend ranges of their own, so both close the enclosing item's
    // own text — which is why the stack is unwound for a table too and not
    // only for the items it is built from.
    if (mark.kind !== 'listItem' && mark.kind !== 'table') continue;
    while (open.length > 0 && !covers(open[open.length - 1], mark)) {
      open.pop();
    }
    const parent = open.length > 0 ? open[open.length - 1] : null;
    // First nested construct wins: marks arrive in document order, so this is
    // the earliest offset at which the parent stops speaking for itself.
    if (parent !== null && !ownEnd.has(parent)) ownEnd.set(parent, mark.start);
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
      // 0 is this struct's absent sentinel, so a depth the projector did not
      // state is left off rather than sent as a level nobody claimed.
      if (list.level > 0) semantics.roleLevel = list.level;
      const cut = ownEnd.get(item);
      if (cut === undefined) {
        forMark.set(item, { semantics });
        continue;
      }
      const end = trimTrailingSpace(projected.text, item.start, cut);
      // An item whose own text is nothing but the separator in front of its
      // sublist has no characters to focus or announce, so it gets no entry —
      // the same rule `collectTableCells` applies to an empty cell, and like
      // an empty cell it is still COUNTED, so its siblings keep their real
      // positions.
      if (end <= item.start) continue;
      forMark.set(item, { semantics, end });
    }
  }
  return { forMark, cells };
}

/** `to`, backed off any trailing whitespace, never past `from`. */
function trimTrailingSpace(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/.test(text.charAt(end - 1))) end -= 1;
  return end;
}

function headingSemantics(mark: RunMark): RunSemantics {
  const level = mark.level;
  // A level outside 1-6 is not a heading level; the role still holds (the
  // range IS a heading), so it goes without one rather than with a wrong one.
  // `styleForMark` treats an absent level as 1 for SIZING, which is a
  // reasonable default for a look and would be a false claim here.
  if (level === undefined || level < 1 || level > 6) return { role: 'heading' };
  return { role: 'heading', roleLevel: level };
}

/** `[start, end)` of every cell in one row of a table's projected text. */
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

/** Appends one `tableCell` entry per non-empty cell of `table`. */
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
  // The widest row, not the header's width: GFM normalizes a table to its
  // header, but `resolveRunAttributes` also runs on projections a consumer
  // built, and a column index past the declared count is a worse answer than
  // a count that is one too generous.
  let columnCount = 0;
  for (const row of rows) columnCount = Math.max(columnCount, row.length);
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      const cell = rows[row][column];
      // An empty cell has no characters to focus or announce, so it gets no
      // entry — it is still counted, so the columns either side keep their
      // real indices.
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
 * TWO RULES ABOUT `lineHeight`, BOTH OF WHICH THE THEME PATH ALREADY KEEPS
 * AND NEITHER OF WHICH THE TYPE CAN STATE.
 *
 * 1. A `fontSize` MUST CARRY A MATCHING `lineHeight`. The returned object
 *    REPLACES the theme's styling for that mark rather than merging with it,
 *    so `{ fontSize: 28 }` on a heading leaves the base run's leading in
 *    place — 28pt glyphs pinned to a 22.4pt line box, because both hosts
 *    clamp lines in both directions (min AND max), and the ascenders are
 *    clipped by the line above. That is the same failure the `heading` case
 *    of `styleForMark` avoids by returning the two together; do the same
 *    here (`{ fontSize: 28, lineHeight: 34 }`). Only a size ABOVE the base
 *    clips, so a smaller size merely sits in a roomier box, and DEV warns
 *    once for the case that clips.
 *
 * 2. A `lineHeight` ON A MID-PARAGRAPH MARK IS PLATFORM-DIVERGENT, so only
 *    return one for a mark that spans a whole block (`heading`, `codeBlock`,
 *    a `paragraph`-wide construct). iOS resolves `NSParagraphStyle` from the
 *    paragraph's FIRST character, so a line height on a `strong`, `code` or
 *    `link` that starts mid-paragraph is dropped; Android's
 *    `RunLineHeightSpan` is a `LineHeightSpan` and applies to every line the
 *    mark touches. Same input, two different documents. This is why
 *    `resolveRunAttributes` itself only ever sets `lineHeight` alongside a
 *    font size, on the base run and on headings.
 */
export type MarkAttribute = (mark: RunMark) => RunMarkStyle | undefined;

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

/**
 * Mark kinds already warned about, so the DEV warning below fires once per
 * kind per JS runtime rather than once per streamed snapshot. Same
 * warn-once discipline as the unknown-renderer warning in `renderers.tsx`.
 */
const warnedUnpairedFontSize = new Set<string>();

/**
 * Empties that Set. FOR TESTS ONLY — nothing in the library calls it, and it
 * is deliberately not exported from the package entry.
 *
 * It exists because the Set is module state that outlives every test in a
 * file: a test asserting "warns" and a test asserting "does not warn a second
 * time" otherwise depend on the order jest happened to run them in, and the
 * second one passes for the wrong reason (nothing warned at all) whenever it
 * runs first or alone. A test that clears the Set in `beforeEach` states its
 * own precondition and can then assert the once-per-kind rule by warning and
 * failing to warn inside a single case.
 */
export function resetUnpairedFontSizeWarningsForTests(): void {
  warnedUnpairedFontSize.clear();
}

/**
 * Warns once when an `attributeForMark` override returns a font size larger
 * than the base run's with no line height to sit in — rule 1 on
 * `MarkAttribute`, which is invisible on the wire (the attribute is perfectly
 * well-formed) and shows up on device as a heading whose ascenders are
 * clipped by the line above it.
 */
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
 *
 * Returned in application order — the base run first, then marks
 * outermost-first — so a host that applies them in sequence ends up with the
 * innermost construct winning. Ranges deliberately overlap rather than being
 * flattened into disjoint runs: both platforms' text stores apply attributes
 * to arbitrary ranges natively (NSMutableAttributedString.addAttributes,
 * SpannableString.setSpan), and flattening here would mean re-deriving
 * "which marks cover this character" for every character.
 */
export function resolveRunAttributes(
  projected: ProjectedRun,
  theme: MarkdownTheme,
  attributeForMark?: MarkAttribute,
): RunTextAttribute[] {
  if (projected.text.length === 0) return [];
  const out: RunTextAttribute[] = [baseAttribute(projected.text.length, theme)];
  // One pass over the marks, before the styling pass, because a role can
  // need more than its own mark: "item 2 of 5" is a fact about a list, and a
  // cell's row and column are facts about a table.
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
    // What the range IS, which no consumer hook can restyle away — spread
    // AFTER the style for exactly that reason, and computed from the marks
    // rather than from whatever the hook returned.
    const semantic = semantics.forMark.get(mark);
    // A mark that contributes neither a look nor a role is dropped rather
    // than sent as an empty attribute: the array crosses the bridge on every
    // snapshot. A mark with a role but no styling — a list item, or a heading
    // whose `attributeForMark` returned `{}` — is NOT dropped: the role is
    // the whole reason the entry exists.
    if (Object.keys(style).length === 0 && semantic === undefined) continue;
    // A list item holding a sublist ends where the sublist begins, so that
    // each item is one focus stop covering its own text on both hosts
    // (`resolveRunSemantics`). Every other mark ends where it ends.
    out.push({
      start: mark.start,
      end: semantic?.end ?? mark.end,
      ...style,
      ...semantic?.semantics,
    });
  }
  // The table cells, which are the one semantic range with no mark of its
  // own. Appended after the marks so they cannot be read as styling that
  // lost a fight: they carry no styling at all, and a host applies them for
  // their role alone.
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
    // Never SHRINK the line: both platforms' line-height machinery clamps in
    // both directions (min AND max), so an inline chip declared shorter than
    // its line would squash the prose around it — the reservation may only
    // ever raise the line to fit. The floor is the tallest line height any
    // mark attribute puts on the placeholder, which is exactly what the
    // native side would apply without this entry. Computed for every embed in
    // one sweep, before the first geometry entry is pushed; see
    // `embedLineHeightFloors`.
    const floors = embedLineHeightFloors(out, projected.embeds);
    for (let i = 0; i < projected.embeds.length; i += 1) {
      const embed = projected.embeds[i];
      const geometry: RunTextAttribute = {
        start: embed.start,
        end: embed.end,
        color: 'transparent',
      };
      // A size neither host would reserve for (non-positive, or infinite —
      // see `isReservableEmbedSize`) gets NO line height: the placeholder
      // keeps the line it is on. Sending one anyway would inflate a line for
      // a card that is never drawn, and `Infinity` would cross the bridge as
      // the line height of a run the measurer then cannot lay out. The
      // transparent colour stays either way: with no attachment over it, the
      // U+FFFC would otherwise render as tofu.
      if (isReservableEmbedSize(embed.content)) {
        geometry.lineHeight = Math.max(embed.content.height, floors[i]);
      }
      out.push(geometry);
    }
  }
  return out;
}

/** One covering attribute, as the sweep below holds it. */
interface CoveringLineHeight {
  lineHeight: number;
  end: number;
}

/**
 * The line-height floor for each entry of `embeds`, in the same order: the
 * tallest `lineHeight` any attribute in `attributes` puts on that embed's
 * placeholder character, or 0 where none covers it.
 *
 * WHY THIS IS A SWEEP AND NOT A SCAN. It used to be a scan of the whole
 * accumulated attribute array per embed — including the geometry entries
 * already pushed, which cover one placeholder each and so can never cover
 * another embed. That is O(embeds x attributes): fine for the handful of
 * claims a chat message carries, and 100+ ms per committed snapshot for a
 * document with thousands of them, re-paid on every settle because the
 * attribute memo is keyed on the projection.
 *
 * Both inputs are walked once in offset order instead. Attributes whose
 * `start` is behind the current placeholder go into a max-heap keyed on line
 * height; the heap's top is popped while it ENDS before the placeholder, and
 * whatever is left on top is the floor. Cost is O((attributes + embeds) log
 * attributes), and the common shape — one base attribute covering the whole
 * run — never grows the heap past a couple of entries.
 *
 * THE INVARIANT THE LAZY DELETION RESTS ON: placeholders are visited in
 * NON-DECREASING `end` order. A pop is permanent, so an attribute retired at
 * one placeholder must be incapable of covering a later one, which is true
 * exactly when the ends never go backwards. `ProjectedRunEmbed` guarantees
 * it — `end === start + 1` always, entries recorded in ascending `start`, so
 * the two orders are one order — and the sort below asks for `end`
 * explicitly rather than inheriting it from `start`, because retirement is
 * the half a malformed input would silently corrupt: admitting an attribute
 * too early only OVERSTATES a floor (a taller line than needed), while
 * retiring one too early understates it and squashes the embed the entry
 * exists to make room for.
 */
function embedLineHeightFloors(
  attributes: readonly RunTextAttribute[],
  embeds: readonly ProjectedRunEmbed[],
): number[] {
  const floors = new Array<number>(embeds.length).fill(0);
  // Only attributes that state a line height can raise a floor, and once one
  // is in the heap only its height and end offset matter.
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
  // Placeholder order, by the offset the retirement reads: `end`, with
  // `start` only as a tie-break. `projected.embeds` is already in that order
  // under its own contract; sorting the INDICES keeps the result aligned with
  // the caller's array without depending on either.
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
