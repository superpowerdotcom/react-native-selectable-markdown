import type { ProjectedRun } from '../selection/mapSelection';
import type { MarkdownTheme } from './theme';

/**
 * Block chrome for the native selection host.
 *
 * WHY THIS EXISTS. Flowing code blocks, tables and thematic breaks through
 * the native host (runs.ts, `PROSE_KINDS`) bought selection across them and
 * paid with their design: a code block became bare mono text with no box, a
 * table became tab-separated lines with no grid, and a rule vanished
 * entirely, because the host renders exactly the projected text and the
 * `attributes` channel can only style characters. This module is the other
 * half of that trade: it turns the projection's block marks into DRAW
 * INSTRUCTIONS — a box behind a range's lines, a rule at an offset, aligned
 * columns for a table — that the host paints around the text it already
 * renders.
 *
 * THE HOST STAYS SEMANTICS-FREE. Nothing on the wire says "code block" or
 * "table"; the kinds below are geometric primitives, and which construct gets
 * which chrome is decided here, in JS, from the theme. That is the same
 * boundary `pressables` draws (the href never crosses the bridge), and it is
 * what keeps the native code small and this module unit-testable.
 *
 * DECORATIONS NEVER CHANGE THE TEXT. A box or a rule is painted behind the
 * characters; offsets, the piece table and selection mapping are untouched,
 * which is the same property that makes `attributes` safe. The two
 * layout-affecting fields — `textInset` and `columns` — are applied inside
 * the platforms' single shared string builder (RNSMAttributedText,
 * RunAttributedText), so the measured string and the drawn string cannot
 * disagree about them; they move where glyphs sit, never which glyphs exist.
 */
export interface RunDecoration {
  /**
   * UTF-16 offsets into `ProjectedRun.text`, end-exclusive. A 'rule' has
   * `start === end`: it is an anchor, not a range.
   */
  start: number;
  end: number;
  kind: 'box' | 'rule' | 'columns' | 'indent';
  /** Box fill / rule colour. Any colour string React Native accepts. */
  color?: string;
  /** Box border. Absent = no border stroke. */
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  /**
   * Which corners `borderRadius` rounds. 'top' exists for the table header
   * band: it shares the table box's top corners and must not round its own
   * bottom edge, which sits mid-table on the first row rule.
   */
  corners?: 'all' | 'top';
  /**
   * 'box' only: a vertical stripe at the leading edge of the decoration band
   * (the blockquote bar), `barWidth` points wide, full band height including
   * the box's vertical padding, with rounded ends of radius `barWidth / 2`.
   * Painted in its own sweep between the fills and the strokes, so an
   * island's opaque fill inside the quote never severs it. Absent colour /
   * zero width = no bar — the same sentinel pattern as every other field
   * here.
   */
  barColor?: string;
  barWidth?: number;
  /**
   * How far a box extends above its first line / below its last, in points.
   * The '\n\n' block separators leave a blank body-height line on each side
   * of every block, which is the room this draws into — the host clamps to
   * its own bounds, so a box at the very edge of a run flattens against it
   * rather than painting over a neighbour.
   */
  paddingTop?: number;
  paddingBottom?: number;
  /**
   * Paragraph inset, in points. On a 'box': the code inside its box, the
   * cells inside the table border. On an 'indent': where the range's first
   * lines start — a list item's marker column, `(level - 1) × listIndent`.
   * LAYOUT-AFFECTING — applied in the shared string builder (as head/tail
   * indents on iOS, a leading margin on Android), so measurement sees it too.
   */
  textInset?: number;
  /**
   * 'indent' only: EXTRA inset for a paragraph's wrapped lines beyond
   * `textInset` — the hanging indent that puts a list item's continuation
   * lines under its text instead of under its bullet, which no amount of
   * injected space glyphs could ever do. Layout-affecting, like `textInset`.
   */
  hang?: number;
  /** Rule line weight, in points. */
  thickness?: number;
  /**
   * Where a rule sits relative to the line fragment containing `start`:
   * 'center' for a free-standing rule in a blank separator line (the hr),
   * 'top' for a boundary flush with the line above (a table row separator,
   * anchored to the first character of the row below it).
   */
  align?: 'center' | 'top';
  /**
   * Horizontal inset from each edge of the host, in points. On a 'rule': how
   * far the line stops short of the edges. On a 'box': how far the band is
   * pulled in — an island box (code, table) inside a blockquote carries the
   * enclosing quote depth × quoteStep here, so its chrome starts at the
   * quote body's edge instead of crossing the bar at x = 0, the same way the
   * fallback renderer nests the island inside the quote view's padding.
   * DRAW-ONLY, like every non-`textInset` field: an older binary ignores it
   * on a box and paints the band full-width, which is the pre-inset look.
   */
  inset?: number;
  /**
   * For 'columns': the gap appended to each column's widest cell when the
   * host computes tab stops for the tab-separated rows in [start, end).
   * LAYOUT-AFFECTING, like `textInset`, and applied in the same builder.
   * `textInset` on a 'columns' entry is where the first column starts (the
   * table box's own inset), not a paragraph indent — the box entry already
   * carries that.
   */
  gap?: number;
  /**
   * For 'columns': vertical padding, in points, between a row's text and the
   * row rules — applied at INTERIOR row boundaries only (spacing after every
   * row but the last, before every row but the first), so each boundary
   * carries `2 × rowPaddingV` and its rule sits centred in the gap. The
   * table's OUTER padding stays on the box's `paddingTop`/`paddingBottom`,
   * which paint into the block-separator slack: interior-only spacing never
   * touches the first or last paragraph edge of the range, so
   * `usedRectForTextContainer` measurement and first-paragraph
   * `paragraphSpacingBefore` semantics never come into play.
   * LAYOUT-AFFECTING, applied in the shared string builder like `gap`. An
   * older binary ignores it and rows abut as before.
   */
  rowPaddingV?: number;
}

/**
 * Derives the chrome for one projected run from its marks and the theme.
 *
 * Derived from `ProjectedRun.marks` rather than re-walked from the AST for
 * the same reason `resolveRunPressables` is: it cannot then disagree with
 * what the run visibly contains. Paint order is not encoded in the list —
 * both hosts draw all fills before all strokes, so a header band never
 * covers the border drawn around it.
 */
export function resolveRunDecorations(
  projected: ProjectedRun,
  theme: MarkdownTheme,
): RunDecoration[] {
  const out: RunDecoration[] = [];
  // What one enclosing blockquote adds to a paragraph's inset: the bar plus
  // the body's inset from it — the same sum the fallback's quote view
  // produces with `borderLeftWidth` + `paddingLeft`, per nesting level.
  // Applied through DISJOINT 'indent' entries (insetSegments) and folded
  // into the island boxes' own `textInset`, never through the quote box
  // itself: a layout inset on the quote box would overlap the insets of
  // everything inside the quote, and overlapping layout spans are exactly
  // what the two platforms disagree about (see insetSegments).
  const quoteStep = theme.quote.barWidth + theme.quote.indent;
  const quotes: { start: number; end: number }[] = [];
  for (const mark of projected.marks) {
    if (mark.kind === 'blockquote') {
      quotes.push({ start: mark.start, end: mark.end });
    }
  }
  const quoteInset = (start: number, end: number): number => {
    let depth = 0;
    for (const quote of quotes) {
      if (quote.start <= start && quote.end >= end) depth += 1;
    }
    return depth * quoteStep;
  };
  /**
   * The inset of a quote's OWN chrome (its bar and fill): one step per
   * ENCLOSING quote, so a nested quote's bar draws beside its parent's
   * instead of underneath it — without this every nesting level painted its
   * bar at x = 0 and a `> > nested` quote showed one bar where the fallback
   * renderer shows two rails. Order-aware rather than containment-only,
   * because an immediately nested quote (`> > text`) projects exactly its
   * parent's range and containment cannot rank equal spans; marks are
   * emitted outermost-first, so for a quote "encloses me" is "contains my
   * range AND appears earlier".
   */
  const enclosingQuoteInset = (ordinal: number): number => {
    const self = quotes[ordinal];
    let depth = 0;
    for (let i = 0; i < ordinal; i += 1) {
      if (quotes[i].start <= self.start && quotes[i].end >= self.end) {
        depth += 1;
      }
    }
    return depth * quoteStep;
  };
  let quoteOrdinal = 0;

  for (const mark of projected.marks) {
    switch (mark.kind) {
      case 'codeBlock': {
        const base = quoteInset(mark.start, mark.end);
        const box: RunDecoration = {
          start: mark.start,
          end: mark.end,
          kind: 'box',
          color: theme.colors.codeBackground,
          borderRadius: theme.code.borderRadius,
          textInset: theme.spacing.codePadding + base,
          paddingTop: theme.code.paddingVertical,
          paddingBottom: theme.code.paddingVertical,
        };
        // Inside a quote the box band itself moves off the bar, not just its
        // text: the fill would otherwise paint from x = 0 over the bar.
        if (base > 0) {
          box.inset = base;
        }
        out.push(box);
        break;
      }
      case 'blockquote': {
        // The bar rides the box: one decoration carries the fill (when the
        // theme sets one), the rounded corners, and the bar itself.
        // `background` is the one optional token — left out, the box paints
        // no fill and the bar alone marks the quote. DRAW-ONLY: the body's
        // inset from the bar travels in the 'indent' entries below. A
        // NESTED quote's chrome moves off its ancestors' bars the same way
        // an island's does (`enclosingQuoteInset` — its own step excluded),
        // so every nesting level shows its own rail.
        const base = enclosingQuoteInset(quoteOrdinal);
        quoteOrdinal += 1;
        const quote: RunDecoration = {
          start: mark.start,
          end: mark.end,
          kind: 'box',
          borderRadius: theme.quote.borderRadius,
          paddingTop: theme.quote.paddingVertical,
          paddingBottom: theme.quote.paddingVertical,
          barColor: theme.quote.barColor,
          barWidth: theme.quote.barWidth,
        };
        if (base > 0) {
          quote.inset = base;
        }
        if (theme.quote.background !== undefined) {
          quote.color = theme.quote.background;
        }
        out.push(quote);
        break;
      }
      case 'table': {
        const padH = theme.table.cellPaddingH;
        const base = quoteInset(mark.start, mark.end);
        const border: RunDecoration = {
          start: mark.start,
          end: mark.end,
          kind: 'box',
          borderColor: theme.colors.border,
          borderWidth: theme.table.borderWidth,
          borderRadius: theme.table.borderRadius,
          textInset: padH + base,
          paddingTop: theme.table.cellPaddingV,
          paddingBottom: theme.table.cellPaddingV,
        };
        if (base > 0) {
          border.inset = base;
        }
        out.push(border);
        out.push({
          start: mark.start,
          end: mark.end,
          kind: 'columns',
          gap: padH * 2,
          textInset: padH + base,
          rowPaddingV: theme.table.cellPaddingV,
        });
        // One rule per row boundary. Every '\n' inside the table range is one:
        // rows are single projected lines (ROW_SEPARATOR in mapSelection.ts)
        // and cells cannot contain newlines — a literal newline ends a GFM
        // table row in the source, so no inline inside a cell projects one.
        // Anchored to the first character AFTER the separator with
        // align 'top', so a row that wraps still gets its rule at the row
        // boundary rather than under every wrapped line.
        for (let i = mark.start; i < mark.end; i += 1) {
          if (projected.text.charCodeAt(i) === 10 /* '\n' */) {
            const rule: RunDecoration = {
              start: i + 1,
              end: i + 1,
              kind: 'rule',
              color: theme.colors.border,
              thickness: theme.table.rowRuleThickness,
              align: 'top',
            };
            // The same inset as the border box, so the rules' ends stay on
            // its edges when a quote pulls the table off the bar.
            if (base > 0) {
              rule.inset = base;
            }
            out.push(rule);
          }
        }
        break;
      }
      case 'tableHeader': {
        // The band's top padding matches the table box's so the two share a
        // top edge; its bottom padding is zero because the band must end
        // exactly where the first row rule sits — the bottom of the header
        // row's last line fragment, which is the same y that rule's 'top'
        // anchor resolves to. Its inset matches the table box's too, so the
        // band keeps sharing the border's edges inside a quote.
        const base = quoteInset(mark.start, mark.end);
        const band: RunDecoration = {
          start: mark.start,
          end: mark.end,
          kind: 'box',
          color: theme.colors.tableHeaderBackground,
          borderRadius: theme.table.borderRadius,
          corners: 'top',
          paddingTop: theme.table.cellPaddingV,
          paddingBottom: 0,
        };
        if (base > 0) {
          band.inset = base;
        }
        out.push(band);
        break;
      }
      case 'thematicBreak':
        // The zero-length anchor mapSelection leaves where the rule sits; the
        // block separators around it guarantee a blank line for 'center' to
        // resolve into. That guarantee holds because segmentRuns never lets a
        // thematic break flow alone: a mark like this one only ever appears in
        // a run that also projects text, so there is always a separator — and
        // its blank line — beside the anchor.
        // The quote inset folds into the rule's own: an hr inside a quote
        // stays off the bar and inside the quote body, as the fallback's
        // nested view does.
        out.push({
          start: mark.start,
          end: mark.end,
          kind: 'rule',
          color: theme.colors.border,
          thickness: theme.rule.thickness,
          align: 'center',
          inset: theme.rule.inset + quoteInset(mark.start, mark.end),
        });
        break;
      default:
        break;
    }
  }

  // Paragraph insets, from the 'listItem' and 'blockquote' marks. One
  // 'indent' per flattened segment: a list item's first line at the marker
  // column, wrapped lines hanging one `listIndent` deeper so they align
  // under the item's text rather than under its bullet; every enclosing
  // blockquote pushes the whole segment `quoteStep` further from the bar.
  const step = theme.spacing.listIndent;
  for (const segment of insetSegments(projected)) {
    const base = segment.quoteDepth * quoteStep;
    out.push({
      start: segment.start,
      end: segment.end,
      kind: 'indent',
      textInset: base + (segment.level > 0 ? (segment.level - 1) * step : 0),
      hang: segment.level > 0 ? step : 0,
    });
  }
  return out;
}

interface InsetSegment {
  start: number;
  end: number;
  /** Innermost list nesting depth covering the segment (0 = not in a list). */
  level: number;
  /** How many 'blockquote' marks enclose the segment. */
  quoteDepth: number;
}

/**
 * Flattens the (nested) 'listItem' and 'blockquote' marks into DISJOINT
 * segments of constant effective depth — innermost list mark wins, quote
 * marks count, exactly as nesting reads.
 *
 * Disjointness is load-bearing, not tidiness. Android's LeadingMarginSpans
 * are ADDITIVE: two spans overlapping one paragraph sum their margins, so if
 * a parent item's indent and its nested item's indent both covered the nested
 * range, Android would indent it twice while iOS (where the builder assigns
 * paragraph properties, last write wins) indented it once. Resolving the
 * overlap here, once, is what keeps the two platforms laying out the same
 * document — the same reason the string builder is shared. Blockquotes are
 * in the same resolution for the same reason: a quote's inset as a layout
 * span of its own would overlap every list, code block and table inside the
 * quote, so it travels as a depth that the segments and the island boxes
 * fold into their single inset instead.
 *
 * Two carve-outs while flattening:
 *
 * - Segment starts are snapped past leading '\n's. A separator newline
 *   belongs to the paragraph it TERMINATES, so a segment that started on one
 *   would overlap the previous paragraph and re-create on Android exactly the
 *   double-cover this function exists to prevent (the paragraph after a
 *   nested sublist is where it bites).
 * - Ranges covered by a 'codeBlock' or 'table' mark are skipped entirely.
 *   Those blocks' boxes carry their own `textInset` (with any enclosing
 *   quote's inset folded in), and a competing indent over the same
 *   paragraphs would assign-and-lose on iOS but SUM on Android. A code
 *   block or table inside a list item therefore renders flush, exactly like
 *   a top-level one — the same on both platforms.
 */
function insetSegments(projected: ProjectedRun): InsetSegment[] {
  const items: { start: number; end: number; level: number }[] = [];
  const islands: { start: number; end: number }[] = [];
  const quotes: { start: number; end: number }[] = [];
  for (const mark of projected.marks) {
    if (mark.kind === 'listItem') {
      items.push({ start: mark.start, end: mark.end, level: mark.level ?? 1 });
    } else if (mark.kind === 'codeBlock' || mark.kind === 'table') {
      islands.push({ start: mark.start, end: mark.end });
    } else if (mark.kind === 'blockquote') {
      quotes.push({ start: mark.start, end: mark.end });
    }
  }
  if (items.length === 0 && quotes.length === 0) {
    return [];
  }

  const boundaries = new Set<number>();
  for (const range of items) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const range of islands) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const range of quotes) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const out: InsetSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    let start = sorted[i];
    const end = sorted[i + 1];
    while (start < end && projected.text.charCodeAt(start) === 10 /* '\n' */) {
      start += 1;
    }
    if (start >= end) continue;
    // Boundaries include every island edge, so island coverage is uniform
    // within a segment: fully covered or not at all.
    if (islands.some((r) => r.start <= start && r.end >= end)) continue;
    let level = 0;
    for (const item of items) {
      if (item.start <= start && item.end >= end) {
        level = Math.max(level, item.level);
      }
    }
    let quoteDepth = 0;
    for (const quote of quotes) {
      if (quote.start <= start && quote.end >= end) {
        quoteDepth += 1;
      }
    }
    if (level === 0 && quoteDepth === 0) continue;
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.level === level &&
      previous.quoteDepth === quoteDepth &&
      previous.end === start
    ) {
      previous.end = end;
    } else {
      out.push({ start, end, level, quoteDepth });
    }
  }
  return out;
}
