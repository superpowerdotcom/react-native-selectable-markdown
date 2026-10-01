/**
 * Span widening: md4c content ranges → document-model construct spans.
 *
 * WHY THIS MODULE EXISTS. md4c's callbacks carry offsets only for text, so
 * `OffsetParser` can report a node's *content* range — the union of its
 * descendants' text — but never its punctuation. The document model's
 * invariant is stronger: `source.slice(span.start, span.end)` must be the
 * construct's exact source, delimiters and markers included. Recovering
 * those is the JS binding's job (OffsetParser.h, constraint 2), and this is
 * where it happens.
 *
 * THE RULE EVERY FUNCTION HERE FOLLOWS: widening is *line-local and
 * pattern-matched*, never "expand to the start of the line". A container
 * prefix (`> `, list indentation) sits between the line start and the
 * construct, and swallowing it would break both copy fidelity and the
 * nesting invariant that a child's span lies inside its parent's. So each
 * function scans outward from the content edge and stops the moment the
 * characters stop being *this* construct's own syntax — which is exactly
 * what makes `> - nested` produce a list item starting at the `-`, not at
 * the `>`.
 *
 * Every function is pure and takes UTF-16 offsets, matching the model.
 */

import type { SourceSpan } from '../../document/span';

/** Widening never invents offsets: an unanchored input stays unanchored. */
export const NO_SPAN: SourceSpan = { start: -1, end: -1 };

export function isAnchored(span: SourceSpan): boolean {
  return span.start >= 0;
}

export function unionSpan(a: SourceSpan, b: SourceSpan): SourceSpan {
  if (!isAnchored(a)) return b;
  if (!isAnchored(b)) return a;
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

// ---------------------------------------------------------------------------
// Line geometry
// ---------------------------------------------------------------------------

/**
 * Line-terminator positions for the source currently being decoded. Each
 * entry is the offset of the terminator's FIRST character — the `\r` of a
 * `\r\n` pair, not its `\n` — so a line's content is always [start, entry)
 * and no caller has to know which of the three CommonMark line endings
 * (§2.1: `\n`, `\r\n`, bare `\r`) it is looking at.
 *
 * Indexing `\n` alone was a real bug, not a simplification: a bare-CR
 * document has no `\n` at all, so every `lineEnd` ran to the end of the file
 * and constructs that widen to their line — a heading, a setext underline, a
 * table row — swallowed the whole document.
 *
 * WHY A CACHE. The obvious implementations — `lastIndexOf` and `indexOf` per
 * call — are O(line length), which is fine until a line is long. `> `×1000
 * puts a thousand nested blockquotes on ONE line, and each one widening to
 * its own marker rescanned the whole line: quadratic, and measurably so
 * (5.2 ms to decode a 2 kB document, 97% of it here, against 0.16 ms for
 * md4c to parse it). With an index the same document decodes in a fraction
 * of that.
 *
 * A single-entry cache is the right shape: a decode walks exactly one source
 * from start to finish, and the identity check is a pointer comparison
 * because it is literally the same string object each time.
 */
let indexedSource: string | null = null;
let terminators: number[] = [];

function terminatorIndex(source: string): number[] {
  if (source === indexedSource) return terminators;
  const found: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0a) {
      found.push(i);
    } else if (ch === 0x0d) {
      found.push(i);
      if (source.charCodeAt(i + 1) === 0x0a) i += 1;
    }
  }
  indexedSource = source;
  terminators = found;
  return found;
}

/** How many characters the terminator starting at `at` occupies. */
function terminatorWidth(source: string, at: number): number {
  return source.charCodeAt(at) === 0x0d && source.charCodeAt(at + 1) === 0x0a ? 2 : 1;
}

/** Index of the first terminator starting at or after `pos`, or the length. */
function terminatorAtOrAfter(source: string, pos: number): number {
  const ends = terminatorIndex(source);
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ends[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the terminator that ends the line containing `pos`, or
 * `ends.length` when that line runs to the end of the source.
 *
 * The three accessors below are all this lookup plus one arithmetic step,
 * which is why it is factored out: they have to agree about which line a
 * position belongs to, and the interesting case — `pos` landing *inside* a
 * `\r\n` pair, which callers do produce by stepping one character back from
 * a line start — is exactly where an inconsistency would hide.
 */
function lineTerminator(source: string, pos: number): number {
  const ends = terminatorIndex(source);
  const at = Math.max(0, pos);
  const i = terminatorAtOrAfter(source, at);
  // A position on the LF of a CRLF pair still belongs to the line that pair
  // terminates, so step back onto it. At most one entry can contain `at`.
  if (i > 0 && ends[i - 1] + terminatorWidth(source, ends[i - 1]) > at) return i - 1;
  return i;
}

/** Offset of the first character of the line containing `pos`. */
export function lineStart(source: string, pos: number): number {
  const ends = terminatorIndex(source);
  const i = lineTerminator(source, pos);
  if (i === 0) return 0;
  const prev = ends[i - 1];
  return prev + terminatorWidth(source, prev);
}

/**
 * Offset just past the last character of the line containing `pos`,
 * excluding the line terminator itself (and the CR of a CRLF pair, which
 * is syntax, not content).
 */
export function lineEnd(source: string, pos: number): number {
  const ends = terminatorIndex(source);
  const i = lineTerminator(source, pos);
  return i < ends.length ? ends[i] : source.length;
}

/** Offset of the first character of the line after the one containing `pos`. */
export function nextLineStart(source: string, pos: number): number {
  const ends = terminatorIndex(source);
  const i = lineTerminator(source, pos);
  return i < ends.length ? ends[i] + terminatorWidth(source, ends[i]) : source.length;
}

/** Drop trailing spaces/tabs/newlines from a span's end. */
export function trimSpanEnd(source: string, span: SourceSpan): SourceSpan {
  let end = span.end;
  while (end > span.start && isTrimmableChar(source.charCodeAt(end - 1))) end -= 1;
  return end === span.end ? span : { start: span.start, end };
}

/** ` `, `\t`, `\r`, `\n` — the `[ \t\r\n]` class, without a regex per char. */
function isTrimmableChar(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

// ---------------------------------------------------------------------------
// Inline widening
// ---------------------------------------------------------------------------

/**
 * Symmetric delimiter runs (`*`/`_` emphasis, `~` strikethrough, `$` math).
 * Takes at most `count` delimiter characters from each side and only when
 * both sides actually have them, so a malformed range can never eat prose.
 *
 * `count` is the construct's own delimiter width, which is what makes
 * nesting work: for `***x***` the inner strong widens to `**x**` first, and
 * the outer emphasis then widens *that* result by one more `*` on each side.
 * Callers therefore pass the union of already-widened children, never the
 * raw content range.
 */
/**
 * `$$` display math may put its delimiters on their own lines
 * (`$$\nx\n$$`), where the characters immediately outside the content are
 * newlines and the plain delimiter scan finds nothing. Whitespace between
 * the content and the delimiter run is skipped here — and only here, because
 * for inline constructs that whitespace is prose that must stay outside.
 */
export function widenDisplayMath(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  const direct = widenDelimiters(source, span, 2, (ch) => ch === '$');
  if (direct.start !== span.start || direct.end !== span.end) return direct;

  let left = span.start;
  while (left > 0 && isTrimmableChar(source.charCodeAt(left - 1))) left -= 1;
  let right = span.end;
  while (right < source.length && isTrimmableChar(source.charCodeAt(right))) right += 1;
  const opens = left >= 2 && source[left - 1] === '$' && source[left - 2] === '$';
  const closes = source[right] === '$' && source[right + 1] === '$';
  return opens && closes ? { start: left - 2, end: right + 2 } : span;
}

export function widenDelimiters(
  source: string,
  span: SourceSpan,
  count: number,
  isDelim: (ch: string) => boolean,
): SourceSpan {
  if (!isAnchored(span)) return span;
  let left = 0;
  while (left < count && span.start - left - 1 >= 0 && isDelim(source[span.start - left - 1])) {
    left += 1;
  }
  let right = 0;
  while (right < count && span.end + right < source.length && isDelim(source[span.end + right])) {
    right += 1;
  }
  // Asymmetric hits mean the range did not line up with a delimiter pair;
  // widening by the smaller side keeps the span inside the construct.
  const take = Math.min(left, right);
  return take === 0 ? span : { start: span.start - take, end: span.end + take };
}

const isBacktick = (ch: string): boolean => ch === '`';

/**
 * Code spans: `` `x` ``, `` `` ` `` ``, and the CommonMark rule that one
 * space is stripped from each end when both are present. The backtick run
 * length is whatever is actually there — md4c matched it, so the source is
 * known to be balanced.
 */
export function widenCodeSpan(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  let start = span.start;
  let end = span.end;
  // The stripped space, if the parse consumed one on each side.
  if (start > 0 && end < source.length && source[start - 1] === ' ' && source[end] === ' ') {
    start -= 1;
    end += 1;
  }
  let left = 0;
  while (start - left - 1 >= 0 && isBacktick(source[start - left - 1])) left += 1;
  let right = 0;
  while (end + right < source.length && isBacktick(source[end + right])) right += 1;
  const take = Math.min(left, right);
  return take === 0 ? span : { start: start - take, end: end + take };
}

/**
 * `<https://…>` angle autolinks widen by their brackets; permissive
 * autolinks (`www.example.com` recognized without punctuation) have no
 * delimiters at all and must widen by nothing.
 */
export function widenAutolink(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  const hasAngles =
    span.start > 0 &&
    span.end < source.length &&
    source[span.start - 1] === '<' &&
    source[span.end] === '>';
  return hasAngles ? { start: span.start - 1, end: span.end + 1 } : span;
}

/**
 * `[text](dest "title")`, `![alt](…)`, and the reference forms
 * `[text][label]` / `[text][]` / `[text]`.
 *
 * The label side is exact (the `[` immediately precedes the content, plus
 * the `!` for images). The trailing side is scanned: `]` always, then an
 * optional destination — parenthesized with balanced nesting and
 * backslash escapes, or a second bracketed label. Anything that does not
 * close is not consumed, which keeps a streaming half-typed link inside its
 * own paragraph.
 */
export function widenLink(source: string, span: SourceSpan, isImage: boolean): SourceSpan {
  if (!isAnchored(span)) return span;
  let start = span.start;
  if (start > 0 && source[start - 1] === '[') {
    start -= 1;
    if (isImage && start > 0 && source[start - 1] === '!') start -= 1;
  }

  let end = span.end;
  if (end < source.length && source[end] === ']') {
    end += 1;
    end = skipLinkTail(source, end);
  }
  return { start, end };
}

/**
 * A parenthesized group is a link destination only if it looks like one:
 * `dest`, `<dest>`, optionally followed by a quoted or parenthesized title.
 * CommonMark forbids unescaped spaces in a bare destination, which is what
 * separates `[foo](https://e.com "t")` from `[foo](not a link)` — the latter
 * is a shortcut reference link followed by literal text, and consuming its
 * parentheses would make two siblings cover the same characters.
 */
const INLINE_DESTINATION =
  /^\(\s*(?:<[^<>\n]*>|(?:[^\s\\()]|\\.|\([^()]*\))*)\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))\s*)?\)$/;

/** After the closing `]`: `(dest)`, `[label]`, or nothing (shortcut ref). */
// Char codes, not one-character strings: this loop walks every byte of every
// link tail in the document, and it was the single hottest function in a
// decode profile (16% of the corpus decode) purely on string-compare cost.
function skipLinkTail(source: string, pos: number): number {
  const open = source.charCodeAt(pos);
  if (open !== 0x28 /* ( */ && open !== 0x5b /* [ */) return pos;
  const close = open === 0x28 ? 0x29 /* ) */ : 0x5d /* ] */;
  let depth = 0;
  let i = pos;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const end = i + 1;
        if (open === 0x5b) return end;
        return INLINE_DESTINATION.test(source.slice(pos, end)) ? end : pos;
      }
    }
    i += 1;
  }
  // Unterminated: consume nothing rather than swallowing the rest of the
  // paragraph. Streaming sees this constantly (`[label](https://exa` mid-token).
  return pos;
}

/**
 * A hard break's source is the trailing whitespace (or backslash) plus the
 * newline; md4c reports only the newline. Widening left over that run is
 * what makes a selection that ends at the break copy back byte-exactly.
 */
export function widenHardBreak(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  let start = span.start;
  if (start > 0 && source[start - 1] === '\\') return { start: start - 1, end: span.end };
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start -= 1;
  return { start, end: span.end };
}

/**
 * Text runs and backslash escapes. md4c points *past* the backslash of an
 * escaped character, so the raw source of a text run includes backslashes
 * the events never mention. Extending over a leading one (only when it
 * really escapes ASCII punctuation) restores the invariant.
 */
export function widenEscapedTextStart(source: string, start: number): number {
  if (start <= 0 || source[start - 1] !== '\\') return start;
  if (!isAsciiPunctuationChar(source[start])) return start;
  // An escaped backslash (`\\`) is itself escaped: only take the one.
  return start - 1;
}

// Runs once per text run (appendText), so no regex: the four ranges are
// `[!-/:-@[-`{-~]` — ASCII punctuation exactly as CommonMark defines it.
function isAsciiPunctuationChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x21 && c <= 0x2f) ||
    (c >= 0x3a && c <= 0x40) ||
    (c >= 0x5b && c <= 0x60) ||
    (c >= 0x7b && c <= 0x7e)
  );
}

/** True when everything between two text events is backslash escapes. */
export function isEscapeGap(source: string, from: number, to: number): boolean {
  if (to <= from) return to === from;
  for (let i = from; i < to; i += 1) if (source[i] !== '\\') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Block widening
// ---------------------------------------------------------------------------

const SETEXT_UNDERLINE = /^[ \t]{0,3}(=+|-+)[ \t]*$/;

/**
 * ATX (`## Title ##`) and setext (`Title\n=====`) headings. md4c reports
 * only the inline content, and the two forms need opposite treatment: ATX
 * grows left over its `#` run and right over the optional closing run,
 * setext grows down over its underline. Level alone cannot tell them apart
 * (a level-2 heading is either `##` or `---`), so both are probed.
 *
 * `hasContent` false keeps an empty ATX heading (`##`) out of the setext probe:
 * its span is the located marker line, which otherwise looks like setext.
 */
export function widenHeading(source: string, span: SourceSpan, hasContent = true): SourceSpan {
  if (!isAnchored(span)) return span;
  const marker = source.indexOf('#', span.start);
  const start = !hasContent && marker >= 0 && marker < lineEnd(source, span.start)
    ? marker
    : widenAtxMarker(source, span.start);
  let end = trimSpanEnd(source, { start, end: lineEnd(source, span.end) }).end;
  if (hasContent && start === span.start) {
    // No `#` run before the content: setext, if the next line is an underline.
    const under = nextLineStart(source, span.end);
    if (under < source.length) {
      const underEnd = lineEnd(source, under);
      if (SETEXT_UNDERLINE.test(source.slice(under, underEnd))) end = underEnd;
    }
  }
  return { start, end };
}

/** Backward scan of `#{1,6}[ \t]*` ending at `contentStart` (see widenBlockquote). */
function widenAtxMarker(source: string, contentStart: number): number {
  const from = lineStart(source, contentStart);
  let i = contentStart;
  while (i > from && isSpaceOrTab(source, i - 1)) i -= 1;
  let hashes = 0;
  while (i > from && hashes < 6 && source.charCodeAt(i - 1) === 0x23 /* # */) {
    i -= 1;
    hashes += 1;
  }
  return hashes > 0 ? i : contentStart;
}

/**
 * Fenced code blocks widen up to their opening fence line and down over the
 * closing one; indented code widens to the indentation that makes it code.
 * Returns `closed` too, because "is the fence closed" is the same scan and
 * the document model needs it for streaming (`closed: false` renders as an
 * open block instead of flashing literal backticks).
 *
 * `hasContent` false means `span` is the located fence line itself, so the
 * fence is not searched for on the line above.
 */
export function widenCodeBlock(
  source: string,
  span: SourceSpan,
  fenceChar: string | null,
  hasContent = true,
): { span: SourceSpan; closed: boolean } {
  if (!isAnchored(span)) return { span, closed: fenceChar === null };
  if (fenceChar === null) {
    // Indented code: the content starts after the 4-space (or tab) indent.
    const start = indentedCodeStart(source, span.start);
    return { span: trimSpanEnd(source, { start, end: span.end }), closed: true };
  }

  // The opening fence is on the line *before* the first code line. Search
  // for the fence run inside that line rather than anchoring at its start,
  // so a fenced block inside a blockquote keeps the `> ` outside its span.
  const contentLineStart = lineStart(source, span.start);
  const start = hasContent && contentLineStart > 0
    ? findFenceStart(source, lineStart(source, contentLineStart - 1), contentLineStart, fenceChar)
    : findFenceStart(source, contentLineStart, lineEnd(source, span.start), fenceChar);

  // The content range ends at the last code character; the closing fence,
  // if any, is on the next line.
  const trimmed = trimSpanEnd(source, { start, end: span.end });
  let closeStart = nextLineStart(source, trimmed.end);
  while (closeStart < source.length) {
    const end = lineEnd(source, closeStart);
    if (!/^(?:[ \t]*>[ \t]?)*[ \t\r]*$/.test(source.slice(closeStart, end))) break;
    closeStart = nextLineStart(source, end);
  }
  if (closeStart >= source.length) return { span: trimmed, closed: false };
  const closeEnd = lineEnd(source, closeStart);
  const closeLine = source.slice(closeStart, closeEnd);
  // The fence run is found by search rather than anchored at the line
  // start, so a fence inside a blockquote (`> ``` `) still closes the block.
  const at = closeLine.indexOf(fenceChar.repeat(3));
  if (at === -1) return { span: trimmed, closed: false };
  const rest = closeLine.slice(at).replace(/[ \t]+$/, '');
  for (const ch of rest) {
    if (ch !== fenceChar) return { span: trimmed, closed: false };
  }
  return { span: { start: trimmed.start, end: closeEnd }, closed: true };
}

/** Offset of a `\`\`\`` / `~~~` run inside [from, to), or `to` when absent. */
function findFenceStart(source: string, from: number, to: number, fenceChar: string): number {
  const run = fenceChar.repeat(3);
  const at = source.indexOf(run, from);
  return at !== -1 && at < to ? at : to;
}

/**
 * The indent stays inside the span, so the slice is the construct, though md4c
 * strips it from `literal`; `mapSelection.ts` aligns the two.
 */
function indentedCodeStart(source: string, contentStart: number): number {
  const from = lineStart(source, contentStart);
  if (from === contentStart) return contentStart;
  for (let i = from; i < contentStart; i += 1) {
    if (!isSpaceOrTab(source, i)) return contentStart;
  }
  return from;
}

/**
 * List markers, matched by backward scan for the same reason as the
 * blockquote marker: the prefix before a deeply indented item grows with
 * nesting, and slicing it per item is quadratic.
 *
 * Each returns the offset the marker starts at, or -1 for no match.
 */
function scanBackWhitespace(source: string, from: number, at: number): number {
  let i = at;
  while (i > from && isSpaceOrTab(source, i - 1)) i -= 1;
  return i;
}

function scanBulletMarker(source: string, from: number, at: number): number {
  const afterSpace = scanBackWhitespace(source, from, at);
  if (afterSpace === at) return -1; // a marker must be followed by whitespace
  const c = afterSpace > from ? source.charCodeAt(afterSpace - 1) : -1;
  const bullet = c === 0x2d /* - */ || c === 0x2a /* * */ || c === 0x2b /* + */;
  return bullet ? afterSpace - 1 : -1;
}

function scanOrderedMarker(source: string, from: number, at: number): number {
  const afterSpace = scanBackWhitespace(source, from, at);
  if (afterSpace === at) return -1;
  let i = afterSpace;
  const delim = i > from ? source.charCodeAt(i - 1) : -1;
  if (delim !== 0x2e /* . */ && delim !== 0x29 /* ) */) return -1;
  i -= 1;
  let digits = 0;
  while (i > from && digits < 9) {
    const d = source.charCodeAt(i - 1);
    if (d < 0x30 || d > 0x39) break;
    i -= 1;
    digits += 1;
  }
  return digits > 0 ? i : -1;
}

function scanTaskMarker(source: string, from: number, at: number): number {
  const afterSpace = scanBackWhitespace(source, from, at);
  if (afterSpace === at || afterSpace - from < 3) return -1;
  if (source.charCodeAt(afterSpace - 1) !== 0x5d /* ] */) return -1;
  const mark = source[afterSpace - 2];
  if (mark !== ' ' && mark !== 'x' && mark !== 'X') return -1;
  return source.charCodeAt(afterSpace - 3) === 0x5b /* [ */ ? afterSpace - 3 : -1;
}

/**
 * List items widen left over their own marker — and, for a task item, over
 * the `[x] ` checkbox md4c consumes as syntax. The scan is bounded to the
 * marker pattern, so an item nested in a blockquote stops at its `-` and
 * leaves the `> ` to the blockquote.
 */
export function widenListItem(
  source: string,
  span: SourceSpan,
  ordered: boolean,
  isTask: boolean,
): SourceSpan {
  if (!isAnchored(span)) return span;
  const from = lineStart(source, span.start);
  let cut = span.start;

  if (isTask) {
    // A task item's content range starts at the character *between* the
    // brackets, because that mark is the only source anchor an otherwise
    // empty item has. Step back over `[` first, then over the whole
    // `[x] ` marker when the range instead starts after it.
    if (cut > from && source.charCodeAt(cut - 1) === 0x5b /* [ */) {
      cut -= 1;
    } else {
      const task = scanTaskMarker(source, from, cut);
      if (task !== -1) cut = task;
    }
  }
  const marker = ordered
    ? scanOrderedMarker(source, from, cut)
    : scanBulletMarker(source, from, cut);
  const start = marker !== -1 ? marker : cut;
  // An EMPTY task item's content range is the mark character alone, so its
  // end stops between the brackets. Stepping back over `[` above without
  // stepping forward over `]` here would leave `- [ ` as the item's source.
  const end =
    isTask && source[span.end] === ']' && source[span.start - 1] === '['
      ? span.end + 1
      : span.end;
  return { start, end };
}

// `[ \t]*`, not `[ \t]?`: a tab-indented quote (`>\t\tfoo`) still starts
// at its `>`, and the whitespace between marker and content belongs to the
// blockquote either way.
/**
 * A blockquote widens left over the `>` and the whitespace after it on its
 * first line. Continuation markers on later lines are already inside the
 * content range, since the range spans from the first text to the last.
 *
 * Scanned backwards character by character rather than by slicing the line
 * prefix and matching a regex against it: `> `×1000 is a legal document with
 * a thousand nested quotes on ONE line, and slicing a prefix that grows with
 * depth, once per level, is quadratic.
 */
export function widenBlockquote(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  const from = lineStart(source, span.start);
  let i = span.start;
  while (i > from && isSpaceOrTab(source, i - 1)) i -= 1;
  if (i > from && source.charCodeAt(i - 1) === 0x3e /* > */) {
    return { start: i - 1, end: span.end };
  }
  return span;
}

function isSpaceOrTab(source: string, at: number): boolean {
  const c = source.charCodeAt(at);
  return c === 0x20 || c === 0x09;
}

/**
 * A table row is its whole line: md4c reports only the cell text, so the
 * pipes are recovered by scanning to the first `|` on the line (which keeps
 * a quoted table's `>` outside) and to the end of the line.
 */
export function widenTableRow(source: string, span: SourceSpan): SourceSpan {
  if (!isAnchored(span)) return span;
  const from = lineStart(source, span.start);
  const pipe = source.indexOf('|', from);
  const start = pipe !== -1 && pipe < span.start ? pipe : span.start;
  return { start, end: lineEnd(source, span.end) };
}

/**
 * A table's span covers its header row, the delimiter row, and every body
 * row. The delimiter row carries no text at all, so it exists only as the
 * line between the header and the body — which is why a header-only table
 * still has to reach one line further down than its content.
 */
export function widenTable(source: string, span: SourceSpan, headerEnd: number): SourceSpan {
  if (!isAnchored(span)) return span;
  const delimiterStart = nextLineStart(source, headerEnd);
  const delimiterEnd = lineEnd(source, delimiterStart);
  return { start: span.start, end: Math.max(span.end, delimiterEnd) };
}

/**
 * Where an empty table cell lives.
 *
 * A cell with no text anchors to nothing, and the generic "first non-blank
 * line at or after the cursor" rule is wrong for cells: it walks *out* of the
 * row, landing an empty cell on the delimiter line — or, at end of source,
 * finding nothing and leaving the cell unanchored, which the streaming
 * splice then rebases into a bogus offset. A cell's position is knowable
 * exactly, because cells are pipe-delimited: cell `index` sits between the
 * index-th and index+1-th unescaped `|` of its own row.
 *
 * Returns a zero-width span (there is no text to cover) at the end of the
 * cell's trimmed region, or at the row's end for a padding cell that has no
 * region at all — a short row padded out to the header's column count.
 */
export function locateEmptyTableCell(
  source: string,
  row: SourceSpan,
  index: number,
): SourceSpan {
  const pipes: number[] = [];
  for (let i = row.start; i < row.end; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === '|') pipes.push(i);
  }
  // Regions are between consecutive pipes; a row that does not start with a
  // pipe has a leading region too, which is why `from` falls back to the row.
  const from = index === 0 && (pipes.length === 0 || pipes[0] > row.start)
    ? row.start
    : (pipes[index] !== undefined ? pipes[index] + 1 : -1);
  const to = pipes[index + (from === row.start ? 0 : 1)] ?? row.end;
  if (from < 0 || from > row.end) return { start: row.end, end: row.end };
  let start = Math.min(from, to);
  const end = Math.min(Math.max(from, to), row.end);
  while (start < end && /[ \t]/.test(source[start])) start += 1;
  return { start, end: start };
}

const THEMATIC_BREAK_LINE = /^[ \t]{0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;

/**
 * Constructs with no text anchor at all — a thematic break, an empty list
 * item, an empty heading — reach the decoder with no offsets. They are
 * located by scanning the gap between the previous sibling's end and the
 * next sibling's start for the line that must have produced them. Returns
 * null when nothing in the gap matches, and the caller leaves the node
 * unanchored rather than guessing.
 */
export function locateThematicBreak(
  source: string,
  from: number,
  to: number,
): SourceSpan | null {
  const line = locateFirstNonBlankLine(source, from, to);
  if (line === null) return null;
  return THEMATIC_BREAK_LINE.test(source.slice(line.start, line.end)) ? line : null;
}

/**
 * Fallback for any other unanchored block: the first non-blank line in the
 * gap. Used for empty paragraphs and empty list items, where the source is
 * a marker with nothing after it.
 */
export function locateFirstNonBlankLine(
  source: string,
  from: number,
  to: number,
): SourceSpan | null {
  let pos = from;
  while (pos < to) {
    const end = Math.min(lineEnd(source, pos), to);
    const line = source.slice(pos, end);
    if (line.trim().length > 0) {
      // Leading space/tab only — narrower than the trim() blankness test
      // above on purpose (trim also knows Unicode whitespace), so the two
      // must not be merged into one scan.
      let lead = 0;
      while (lead < line.length && isSpaceOrTab(line, lead)) lead += 1;
      return { start: pos + lead, end };
    }
    const next = nextLineStart(source, pos);
    if (next <= pos) break;
    pos = next;
  }
  return null;
}
