/**
 * Approximates UAX #29 cluster boundaries, since `Intl.Segmenter` is missing
 * on Hermes. Not covered: Hangul jamo and Indic conjuncts across a virama.
 */

const ZWJ = 0x200d;

// The try/catch keeps an engine without `\p{…}` from throwing at load.
const COMBINING_MARK: RegExp | null = (() => {
  try {
    return new RegExp('^\\p{M}$', 'u');
  } catch {
    return null;
  }
})();

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** A lone surrogate comes back as itself, which no predicate here matches. */
function codePointAt(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if (isHighSurrogate(unit)) {
    const lo = text.charCodeAt(index + 1);
    if (isLowSurrogate(lo)) {
      return (unit - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
    }
  }
  return unit;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/** Variation selectors, skin-tone modifiers, tag characters, combining marks. */
function isExtender(cp: number): boolean {
  if (cp >= 0xfe00 && cp <= 0xfe0f) {
    return true;
  }
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) {
    return true;
  }
  if (cp >= 0xe0020 && cp <= 0xe007f) {
    return true;
  }
  return COMBINING_MARK !== null && COMBINING_MARK.test(String.fromCodePoint(cp));
}

/** Include committed text in `text`, or an earlier flag flips the parity. */
function regionalIndicatorsBefore(text: string, cut: number): number {
  let count = 0;
  let at = cut;
  while (
    at >= 2 &&
    isHighSurrogate(text.charCodeAt(at - 2)) &&
    isLowSurrogate(text.charCodeAt(at - 1)) &&
    isRegionalIndicator(codePointAt(text, at - 2))
  ) {
    count += 1;
    at -= 2;
  }
  return count;
}

/** The end of `text` counts as safe; streaming callers pass `openEnd`. */
export function splitsCluster(text: string, cut: number): boolean {
  if (cut <= 0 || cut >= text.length) {
    return false;
  }
  const unit = text.charCodeAt(cut);
  if (isLowSurrogate(unit) && isHighSurrogate(text.charCodeAt(cut - 1))) {
    return true;
  }
  if (unit === ZWJ || text.charCodeAt(cut - 1) === ZWJ) {
    return true;
  }
  const cp = codePointAt(text, cut);
  if (isExtender(cp)) {
    return true;
  }
  return (
    isRegionalIndicator(cp) && regionalIndicatorsBefore(text, cut) % 2 === 1
  );
}

function previousCodePointStart(text: string, index: number): number {
  if (
    index >= 2 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2))
  ) {
    return index - 2;
  }
  return index - 1;
}

function nextCodePointEnd(text: string, index: number): number {
  if (
    isHighSurrogate(text.charCodeAt(index)) &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return index + 2;
  }
  return index + 1;
}

/**
 * A run of marks can walk the cut to 0 and release nothing; the session's
 * idle drain is the backstop.
 */
export function retreatToClusterBoundary(
  text: string,
  cut: number,
  openEnd = false,
): number {
  let at = Math.max(0, Math.min(cut, text.length));
  if (openEnd && at === text.length && at > 0 && !endsUnextendable(text, at)) {
    at = previousCodePointStart(text, at);
  }
  while (at > 0 && splitsCluster(text, at)) {
    at = previousCodePointStart(text, at);
  }
  return at;
}

/**
 * ASCII is never held back, so NFD Latin (`cafe` + U+0301) can show `cafe`
 * for one frame; `holdBackChars: 1` covers that case.
 */
function endsUnextendable(text: string, at: number): boolean {
  return text.charCodeAt(at - 1) < 0x80;
}

/** Covers ZWJ sequences (about 20 units); longer flag runs widen the window. */
const COMMITTED_CONTEXT_UNITS = 128;

/**
 * Returns an offset into `pending`, holding back a last cluster the next
 * delta could extend. 0 when the retreat reaches committed text.
 */
export function retreatToStreamBoundary(
  committed: string,
  pending: string,
  cut: number,
  openEnd = true,
): number {
  let start = Math.max(0, committed.length - COMMITTED_CONTEXT_UNITS);
  if (start > 0 && isLowSurrogate(committed.charCodeAt(start))) {
    // A missing high half would hide a regional indicator from the count.
    start -= 1;
  }
  while (start > 0 && isRegionalIndicator(codePointAt(committed, start))) {
    const previous = previousCodePointStart(committed, start);
    if (!isRegionalIndicator(codePointAt(committed, previous))) break;
    start = previous;
  }
  const context = committed.slice(start);
  const wanted = Math.max(0, Math.min(cut, pending.length));
  const at = retreatToClusterBoundary(
    context + pending,
    context.length + wanted,
    openEnd,
  );
  return Math.max(0, at - context.length);
}

export function advanceToClusterBoundary(text: string, cut: number): number {
  let at = Math.max(0, Math.min(cut, text.length));
  while (at < text.length && splitsCluster(text, at)) {
    at = nextCodePointEnd(text, at);
  }
  return at;
}
