import type { SourceSpan } from '../document/span';
import type { ProjectedRun, RunMark } from '../selection/mapSelection';
import type { RunDecoration } from './runDecorations';
import type { RunTextAttribute } from './runAttributes';
import type { RunPressable } from './runPressables';
import { mapSourceToRunRange } from './selectionRange';
import type { MarkdownTheme, ThemeFontWeight } from './theme';

/** What a pressable presentation callback is told about one range. */
export interface PressableInfo {
  href: string;
  blocked: boolean;
  /** The range's projected text, e.g. a citation's `[3]`. */
  text: string;
}

export interface PressableAccessibility {
  /** Announced instead of the range's text. */
  label?: string;
  /**
   * Default 'link'.
   * - 'text': still a tap target that reaches `onLinkPress`, but not an
   *   accessibility element; a screen reader reads it as part of the prose.
   * - 'none': inert. No tap target, no accessibility element, no
   *   `onLinkPress` — for identifiers that only look like links.
   */
  role?: 'link' | 'button' | 'text' | 'none';
}

/** Feedback painted behind a pressable while a finger is down on it. */
export interface PressedStyle {
  backgroundColor: string;
  /** Unset: a chip's own radius, else square. */
  borderRadius?: number;
}

/**
 * A rounded fill behind a mark, with room reserved beside it. Horizontal
 * padding and `minWidth` move the neighbouring text; vertical padding only
 * paints.
 */
export interface ChipStyle {
  backgroundColor: string;
  borderRadius?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  /** The text centres in the chip when it is narrower. */
  minWidth?: number;
  borderColor?: string;
  borderWidth?: number;
  /** Text inside the chip; unset keeps the mark's own styling. */
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: ThemeFontWeight;
  letterSpacing?: number;
}

/**
 * Ranges to highlight: source spans (a search hit's offsets), or a query
 * matched against what each run shows.
 */
export type Highlights =
  | readonly SourceSpan[]
  | {
      query: string;
      /** Default false. */
      caseSensitive?: boolean;
      /**
       * Where a run has no match for the whole phrase, match its words
       * instead (letters and digits, two or more characters). Default false.
       */
      matchTokens?: boolean;
    };

export interface PressablePresentation {
  accessibilityForPressable?: (pressable: PressableInfo) => PressableAccessibility | undefined;
  pressedStyle?: PressedStyle | ((pressable: PressableInfo) => PressedStyle | undefined);
  hitSlop?: number;
}

/** Applies the presentation callbacks; an inert ('none') range is dropped. */
export function presentPressables(
  pressables: RunPressable[],
  text: string,
  presentation: PressablePresentation,
): RunPressable[] {
  const { accessibilityForPressable, pressedStyle, hitSlop } = presentation;
  if (accessibilityForPressable === undefined && pressedStyle === undefined && hitSlop === undefined) {
    return pressables;
  }
  const out: RunPressable[] = [];
  for (const pressable of pressables) {
    const info: PressableInfo = {
      href: pressable.href,
      blocked: pressable.blocked === true,
      text: text.slice(pressable.start, pressable.end),
    };
    const accessibility = accessibilityForPressable?.(info);
    if (accessibility?.role === 'none') continue;
    const next: RunPressable = { ...pressable };
    if (accessibility?.label !== undefined) next.accessibilityLabel = accessibility.label;
    if (accessibility?.role !== undefined) next.accessibilityRole = accessibility.role;
    const pressed = typeof pressedStyle === 'function' ? pressedStyle(info) : pressedStyle;
    if (pressed !== undefined) {
      next.pressedColor = pressed.backgroundColor;
      if (pressed.borderRadius !== undefined) next.pressedRadius = pressed.borderRadius;
    }
    if (hitSlop !== undefined && Number.isFinite(hitSlop) && hitSlop > 0) next.hitSlop = hitSlop;
    out.push(next);
  }
  return out;
}

export interface RunChips {
  decorations: RunDecoration[];
  /** The chips' text styling, for `resolveRunAttributes`' `extra`. */
  attributes: RunTextAttribute[];
}

/**
 * One 'chip' decoration per mark `chipForMark` styles, plus an attribute
 * for any font settings. Both hosts measure a chip after attributes apply,
 * so its width fits the chip's own font.
 */
export function resolveChips(
  projected: ProjectedRun,
  chipForMark: (mark: RunMark) => ChipStyle | undefined,
): RunChips {
  const out: RunDecoration[] = [];
  const attributes: RunTextAttribute[] = [];
  for (const mark of projected.marks) {
    if (mark.end <= mark.start || mark.kind === 'embed') continue;
    const chip = chipForMark(mark);
    if (chip === undefined) continue;
    const text: RunTextAttribute = { start: mark.start, end: mark.end };
    if (chip.color !== undefined) text.color = chip.color;
    if (chip.fontFamily !== undefined) text.fontFamily = chip.fontFamily;
    if (chip.fontSize !== undefined) text.fontSize = chip.fontSize;
    if (chip.fontWeight !== undefined) text.fontWeight = chip.fontWeight;
    if (chip.letterSpacing !== undefined) text.letterSpacing = chip.letterSpacing;
    if (Object.keys(text).length > 2) attributes.push(text);
    const decoration: RunDecoration = {
      start: mark.start,
      end: mark.end,
      kind: 'chip',
      color: chip.backgroundColor,
    };
    if (chip.borderRadius !== undefined) decoration.borderRadius = chip.borderRadius;
    if (chip.paddingHorizontal !== undefined) decoration.paddingH = chip.paddingHorizontal;
    if (chip.paddingVertical !== undefined) {
      decoration.paddingTop = chip.paddingVertical;
      decoration.paddingBottom = chip.paddingVertical;
    }
    if (chip.minWidth !== undefined) decoration.minWidth = chip.minWidth;
    if (chip.borderColor !== undefined) decoration.borderColor = chip.borderColor;
    if (chip.borderWidth !== undefined) decoration.borderWidth = chip.borderWidth;
    out.push(decoration);
  }
  return { decorations: out, attributes };
}

/** Highlight attributes for one run, applied over everything but embeds. */
export function resolveRunHighlights(
  projected: ProjectedRun,
  highlights: Highlights | undefined,
  theme: MarkdownTheme,
): RunTextAttribute[] {
  if (highlights === undefined) return [];
  const ranges = Array.isArray(highlights)
    ? spanRanges(projected, highlights as readonly SourceSpan[])
    : queryRanges(projected.text, highlights as Exclude<Highlights, readonly SourceSpan[]>);
  const style: Pick<RunTextAttribute, 'backgroundColor' | 'color'> = {
    backgroundColor: theme.colors.highlight,
  };
  if (theme.colors.highlightText !== undefined) style.color = theme.colors.highlightText;
  const embeds = projected.embeds;
  if (embeds === undefined || embeds.length === 0) return ranges.map((range) => ({ ...range, ...style }));
  const out: RunTextAttribute[] = [];
  const sortedEmbeds = [...embeds].sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    let start = range.start;
    for (const embed of sortedEmbeds) {
      if (embed.end <= start) continue;
      if (embed.start >= range.end) break;
      if (embed.start > start) out.push({ start, end: embed.start, ...style });
      start = Math.max(start, embed.end);
      if (start >= range.end) break;
    }
    if (start < range.end) out.push({ start, end: range.end, ...style });
  }
  return out;
}

function spanRanges(
  projected: ProjectedRun,
  spans: readonly SourceSpan[],
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const span of spans) {
    const range = mapSourceToRunRange(projected, span);
    if (range !== null) out.push(range);
  }
  return out;
}

/** Display-text matches; non-overlapping, left to right. */
export function queryRanges(
  text: string,
  highlights: { query: string; caseSensitive?: boolean; matchTokens?: boolean },
): { start: number; end: number }[] {
  const phrase = phraseRanges(text, highlights.query, highlights.caseSensitive === true);
  if (phrase.length > 0 || highlights.matchTokens !== true) return phrase;
  const tokens = searchTokens(highlights.query, highlights.caseSensitive === true);
  // A lone token equal to the phrase is the search that just found nothing.
  const folded = highlights.caseSensitive === true ? highlights.query : highlights.query.toLowerCase();
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === folded.trim())) {
    return phrase;
  }
  const hits = tokens
    .flatMap((token) => phraseRanges(text, token, highlights.caseSensitive === true))
    .sort((a, b) => a.start - b.start);
  // Merged, so overlapping hits paint one range.
  const merged: { start: number; end: number }[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last !== undefined && hit.start <= last.end) last.end = Math.max(last.end, hit.end);
    else merged.push({ ...hit });
  }
  return merged;
}

function searchTokens(query: string, caseSensitive: boolean): string[] {
  const source = caseSensitive ? query : query.toLowerCase();
  return [...new Set((source.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length >= 2))];
}

function phraseRanges(
  text: string,
  query: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  if (query.length === 0) return [];
  let haystack = text;
  let needle = query;
  if (!caseSensitive) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    // Lower-casing can change a string's length (İ), which would misplace every offset.
    if (lowerText.length === text.length && lowerQuery.length === query.length) {
      haystack = lowerText;
      needle = lowerQuery;
    }
  }
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return out;
    out.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
}
