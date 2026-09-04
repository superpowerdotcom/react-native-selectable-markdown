/**
 * Where a release cut may land, so a committed prefix never paints half a
 * glyph.
 *
 * Two places choose that point, from opposite directions. `StreamSession`
 * moves a proposed cut DOWN (released text cannot be recalled, so the whole
 * cluster has to stay pending), and the adaptive smoother's `snapReleaseCut`
 * moves its own answer UP (a want the session clamps afterwards anyway).
 * Both ask the same question — would a cut here land inside one visible
 * glyph? — so the predicate lives here once and the two walks share it.
 *
 * This is a deliberate approximation of UAX #29 extended grapheme clusters,
 * not an implementation of it: `Intl.Segmenter` is unavailable on Hermes and
 * a full segmenter is far more table than a cut point is worth. What is
 * covered:
 *
 * - surrogate pairs (a cut between the halves is not even valid UTF-16);
 * - ZWJ sequences (`👨‍👩‍👧`, `❤️‍🔥`);
 * - variation selectors and skin-tone modifiers (`❤️`, `👩🏽`);
 * - combining marks — Unicode Mn/Mc/Me: NFD accents (`e` + U+0301), Indic
 *   matras and viramas, Thai vowel signs, the U+20E3 keycap;
 * - regional-indicator pairs, i.e. flags (`🇺🇸` never releases as a lone
 *   `🇺`), counted across the COMMITTED text as well as the pending buffer,
 *   and the tag sequences behind subdivision flags (`🏴󠁧󠁢󠁳󠁣󠁴󠁿`).
 *
 * What is NOT covered: Hangul jamo composition, and Indic conjuncts across a
 * virama — `न` keeps its own `्`, but the `द` the virama conjoins with may
 * still be cut off. A cut this module calls safe can therefore still split
 * one of those, which costs a single frame showing a different glyph; it can
 * never produce invalid UTF-16, because every answer is at least code-point
 * aligned.
 *
 * A CLUSTER SPLIT ACROSS DELTAS is a separate problem, and
 * {@link retreatToStreamBoundary} is where it is solved: the end of the
 * pending buffer is not the end of the text, it is where the stream has got
 * to, so a non-ASCII code point sitting there ('👨' before its ZWJ, 'ह'
 * before its matra, a lone '🇺') is held until a following code point proves
 * the cluster finished. Its cost is one code point of latency, released by
 * the next delta, by the idle drain, or by `finalize`.
 */

const ZWJ = 0x200d;

/**
 * Combining marks, via a Unicode property escape. Every engine this library
 * runs on (Hermes, JSC, V8) supports `\p{…}`; the try/catch is only so an
 * engine that does not degrades to the explicit emoji sets below — the
 * coverage this module had before marks were added — instead of throwing at
 * module load.
 */
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

/**
 * The code point starting at `index`. A lone surrogate (the halves of a pair
 * a chunk boundary split) is returned as itself, which no predicate here
 * matches — exactly right, since the missing half decides what the cluster
 * is.
 */
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

/** Regional indicator symbols — two of them make one flag. */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * True when `cp` extends the code point before it into one visible glyph:
 * a variation selector (U+FE00–U+FE0F — VS16 turns '❤' into the
 * emoji-presentation '❤️'), a skin-tone modifier (U+1F3FB–U+1F3FF), a tag
 * character (U+E0020–U+E007F, the subdivision-flag suffix), or any combining
 * mark. Variation selectors 17–256 (U+E0100–U+E01EF) are themselves marks,
 * so the property escape covers them.
 */
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

/**
 * Number of regional indicators immediately before `cut`. Flags are pairs,
 * so an ODD count means the cut would leave a half-typed flag behind — the
 * first indicator of `🇺🇸` renders as a lone letter tile before its partner
 * arrives. The count has to run back over ALL of them, committed text
 * included ({@link retreatToStreamBoundary} passes the committed tail in
 * front of the pending buffer for exactly this): a flag already released
 * makes the parity of the pending run the opposite of what it looks like on
 * its own.
 */
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

/**
 * True when cutting `text` at `cut` would split one visible glyph. Cuts at
 * the very start and the very end are always safe HERE: there is nothing on
 * one side to split from, and at the end this function has no way of knowing
 * whether more is coming. A caller streaming text does know, and says so
 * with `retreatToClusterBoundary`'s `openEnd` — see
 * {@link retreatToStreamBoundary}.
 */
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

/** Start index of the code point ending at `index` (exclusive). */
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

/** End index of the code point starting at `index`. */
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
 * The nearest cut at or below `cut` that splits no cluster — the session's
 * direction, because a release is irrevocable and pending text can always
 * wait for the rest of its cluster. Each step retreats by one code point, so
 * the walk is O(cluster length); a pathological run (a mark bomb) walks to 0
 * and releases nothing. Nothing is stranded by that: `StreamSession` settles
 * the smoother's budget against what it really released (so a policy is not
 * charged for a glyph it never got, which is what used to stall the reveal
 * for good) and arms the idle drain as the backstop that lets the run
 * through.
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
 * True when the code point ending at `at` is one this module will not hold
 * back at an open end, so a cut there is safe even though more text is
 * coming.
 *
 * The line is drawn at ASCII. Every continuer this module knows — a low
 * surrogate's high half, ZWJ, a variation selector, a skin-tone modifier, a
 * tag character, a combining mark, a regional indicator — is above U+007F,
 * and so is every base that takes one in practice: an emoji before its ZWJ
 * or skin tone, a Devanagari consonant before its matra. So a stream of
 * ASCII prose keeps releasing every character it has, and only text that
 * could actually be mid-cluster pays the one-code-point wait.
 *
 * THE GAP this leaves is an ASCII base with a combining mark behind it —
 * decomposed `cafe` + U+0301, which commits `cafe` for one frame before it
 * becomes `café`. Closing it would mean holding the last character of every
 * plain-prose flush, one code point of latency on every delta of every
 * ordinary stream, to cover a form (NFD Latin) that streams essentially
 * never carry. `holdBackChars: 1` buys it for a caller who needs it.
 */
function endsUnextendable(text: string, at: number): boolean {
  return text.charCodeAt(at - 1) < 0x80;
}

/**
 * How much committed text {@link retreatToStreamBoundary} looks back over.
 * Enough for any real cluster (the longest emoji ZWJ sequences run about 20
 * code units) and for the regional-indicator run of a few flags typed in a
 * row; a longer unbroken run than this is judged on the window alone, which
 * can only make the answer more conservative than it needs to be.
 */
const COMMITTED_CONTEXT_UNITS = 128;

/**
 * The largest cut into `pending` at or below `cut` that commits no partial
 * cluster — the session's answer, and the one place the stream's two truths
 * are both applied:
 *
 * - the text on the LEFT of the cut is not just `pending`, it is everything
 *   committed so far, so a cluster the last flush already split (a lone 🇫,
 *   an ⁠emoji base) is still counted;
 * - the text on the RIGHT of the cut may still grow, so a cut at the end of
 *   `pending` is not automatically safe: the next delta can extend the last
 *   cluster ('👨' + ZWJ, 'ह' + a matra, '1️' + U+20E3), and released text
 *   cannot be recalled. A last cluster that could still grow is therefore
 *   held back, and the following delta, the idle drain or `finalize`
 *   releases it — see {@link endsUnextendable} for where that line is drawn
 *   and what it deliberately leaves out.
 *
 * Returns an offset into `pending`. A retreat that walks past the start of
 * `pending` into committed text answers 0 — nothing can be released this
 * flush, which is what the idle drain backstop exists for.
 */
export function retreatToStreamBoundary(
  committed: string,
  pending: string,
  cut: number,
): number {
  let start = Math.max(0, committed.length - COMMITTED_CONTEXT_UNITS);
  if (start > 0 && isLowSurrogate(committed.charCodeAt(start))) {
    // Never start the window between the halves of a pair: the missing high
    // half would hide a regional indicator from the parity count.
    start -= 1;
  }
  const context = committed.slice(start);
  const wanted = Math.max(0, Math.min(cut, pending.length));
  const at = retreatToClusterBoundary(
    context + pending,
    context.length + wanted,
    true,
  );
  return Math.max(0, at - context.length);
}

/**
 * The nearest cut at or above `cut` that splits no cluster — the smoother's
 * direction: its answer is a want, and releasing the rest of a cluster one
 * frame early is invisible where releasing half of it is not.
 */
export function advanceToClusterBoundary(text: string, cut: number): number {
  let at = Math.max(0, Math.min(cut, text.length));
  while (at < text.length && splitsCluster(text, at)) {
    at = nextCodePointEnd(text, at);
  }
  return at;
}
