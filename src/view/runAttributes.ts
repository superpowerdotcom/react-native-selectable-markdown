import type { MarkKind, ProjectedRun, RunMark } from '../selection/mapSelection';
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
export interface RunTextAttribute {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
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
 * One mark's contribution. Sparse on purpose: a mark says only what it
 * changes, so `strong` inside a `heading` keeps the heading's size and
 * colour and overrides nothing else.
 */
function styleForMark(mark: RunMark, theme: MarkdownTheme): Omit<RunTextAttribute, 'start' | 'end'> {
  const kind: MarkKind = mark.kind;
  switch (kind) {
    case 'emphasis':
      return { fontStyle: 'italic' };
    case 'strong': {
      // `strongFamily` / `colors.strong` contribute only when set: a design
      // whose bold is a family swap (one font file per family — a weight
      // alone silently renders regular on iOS) states it in the theme
      // instead of via `attributeForMark`.
      const strong: Omit<RunTextAttribute, 'start' | 'end'> = {
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
    // rules, the horizontal rule, the list indents. An empty object here
    // means `resolveRunAttributes` drops them from the wire entirely.
    case 'table':
    case 'thematicBreak':
    case 'listItem':
      return {};
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
 */
export type MarkAttribute = (
  mark: RunMark,
) => Omit<RunTextAttribute, 'start' | 'end'> | undefined;

export function resolveRunAttributes(
  projected: ProjectedRun,
  theme: MarkdownTheme,
  attributeForMark?: MarkAttribute,
): RunTextAttribute[] {
  if (projected.text.length === 0) return [];
  const out: RunTextAttribute[] = [baseAttribute(projected.text.length, theme)];
  for (const mark of projected.marks) {
    const style = attributeForMark?.(mark) ?? styleForMark(mark, theme);
    // A mark whose kind contributes nothing is dropped rather than sent as
    // an empty attribute: the array crosses the bridge on every snapshot.
    if (Object.keys(style).length === 0) continue;
    out.push({ start: mark.start, end: mark.end, ...style });
  }
  return out;
}
