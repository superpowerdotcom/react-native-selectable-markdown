import { processColor } from 'react-native';

/**
 * `processColor` results, keyed by the colour string that produced them.
 *
 * WHY A MEMO AT ALL. The attribute array is rebuilt and re-sent on every
 * streamed snapshot, and every colour in it is one of a dozen constant theme
 * tokens — the same '#1f2328' re-normalized over and over, because
 * `processColor` re-parses its argument on every call. Measurement of a real
 * streamed transcript put `.map(toNativeAttribute)` at 3.5x the cost of
 * `resolveRunAttributes` itself for that reason alone, which made colour
 * conversion the most expensive step in a pipeline that also parses markdown.
 *
 * Keyed by the string and not by the attribute object, because the strings are
 * what repeat: two marks that both resolve to `theme.colors.codeText` are two
 * distinct objects carrying one identical colour. A theme's own palette is a
 * handful of tokens, so for a themed document the cache is that handful and
 * nothing more.
 *
 * WHY IT IS BOUNDED. The palette is not the only source of colour strings.
 * `attributeForMark` is documented as the channel for PER-INSTANCE styling —
 * its worked example is two blocked schemes that must look different, keyed on
 * `mark.href` — so a consumer deriving a colour per href, per heading level or
 * per citation id mints a new string for every distinct instance. This map is
 * module scope: it outlives every component, every theme switch and every
 * document, and nothing else would ever remove such an entry.
 *
 * WHY IT EVICTS RATHER THAN FREEZING. Filling the cap and then refusing every
 * later insert keeps the bound, but it hands the whole memo to whichever
 * strings happened to arrive first: a theme switch or an appearance flip after
 * that mints a dozen tokens that can never be cached, and every one of them
 * re-parses on every snapshot for the rest of the process — exactly the cost
 * this exists to remove, made permanent. Clearing the map instead costs the
 * live palette one re-parse per token (a dozen calls, on the snapshot after
 * the clear) and leaves every later token cacheable. It is a generational
 * cache, not an LRU: an LRU here would carry a linked list and a touch on
 * every hit to protect a dozen entries that are re-earned in microseconds.
 */
const processedColors = new Map<string, ReturnType<typeof processColor>>();

/**
 * How many distinct colour strings the cache holds before it is emptied.
 * Generous next to a theme's dozen tokens and small next to a leak: the
 * entries are one string and one packed integer each.
 */
export const MAX_PROCESSED_COLORS = 512;

/**
 * `processColor`, memoized. Same return value, including the `null` it gives
 * for a string it cannot parse.
 *
 * Separated from `RunHost` so the eviction rule above is reachable from a
 * test: this module imports one function from `react-native` and nothing else,
 * which a jest factory mock can stand in for, while `RunHost` pulls in the
 * native component and needs a renderer.
 */
export function memoizedProcessColor(
  color: string,
): ReturnType<typeof processColor> {
  // `has`, not a truthiness test on `get`: `processColor` returns null for a
  // string it cannot parse, and that null is worth caching too — otherwise a
  // theme with one unparseable token pays the full parse on every snapshot,
  // which is the exact cost this exists to remove.
  if (processedColors.has(color)) {
    return processedColors.get(color);
  }
  const processed = processColor(color);
  if (processedColors.size >= MAX_PROCESSED_COLORS) {
    processedColors.clear();
  }
  processedColors.set(color, processed);
  return processed;
}

/** How many entries the cache currently holds. For tests — nothing in the
 * library reads it, and the number is not part of any contract. */
export function processedColorCacheSize(): number {
  return processedColors.size;
}
