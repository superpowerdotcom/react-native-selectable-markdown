import { processColor } from 'react-native';

// Bounded because `attributeForMark` can mint a colour per instance; cleared, not frozen, so later theme tokens still cache.
const processedColors = new Map<string, ReturnType<typeof processColor>>();

export const MAX_PROCESSED_COLORS = 512;

export function memoizedProcessColor(
  color: string,
): ReturnType<typeof processColor> {
  // `has`, not `get`: the null for an unparseable string is cached too.
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

export function processedColorCacheSize(): number {
  return processedColors.size;
}
