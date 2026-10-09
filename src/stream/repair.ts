import type { SourceSpan } from '../document/span';
import type { ResolvedEngineOptions } from '../engine/options';

export interface RepairSeed {
  /**
   * Fence open at the settled/unsettled boundary: the fence character
   * ('`' or '~'), the length of its opening run, and the column that run
   * starts at (`indent`, default 0; "- ```sh" opens at column 2).
   */
  openFence: { marker: string; length: number; indent?: number } | null;
  inMath: boolean;
}

export interface RepairResult {
  /** Tail text as it should be fed to the parser. */
  text: string;
  /** Pure suffix appended past all real offsets (virtual closers). */
  appended: string;
  /**
   * Tail-relative regions that were altered, suppressed, or virtually
   * closed. Consumers treat any node overlapping these as incomplete.
   */
  touched: SourceSpan[];
  /**
   * Carry-forward state for the next call on this tail ({@link RepairScan}),
   * or null when nothing is reusable. Always set by `repairTail`; optional so
   * wrappers and test doubles need not invent one.
   */
  scan?: RepairScan | null;
}

/**
 * Opaque state that lets one {@link repairTail} call resume the previous
 * call's inline scan on the same growing tail; omit it and the scan starts
 * over.
 *
 * Valid only with a tail that has the producing tail as a prefix, the same
 * resolved options, and the same anchor. The guard fields catch wiring
 * mistakes, not a different document of the same length: misuse silently
 * repairs against the wrong scan and never throws.
 */
export interface RepairScan {
  /** Measured after any surrogate trim. */
  readonly tailLength: number;
  /** Fingerprint of a few sampled tail characters, not a checksum. */
  readonly tailMark: number;
  readonly flags: number;
  readonly regionStart: number;
  readonly inline: InlineResume;
}

/**
 * Optional display-repair behaviors layered on the structural repairs.
 * Absent (or all-off) options reproduce the default output bit-for-bit.
 * Each hide routes through the same delete-to-end cut machinery as
 * incomplete images, so touched spans, the opens filtering, and the
 * pure-suffix `appended` contract hold unchanged — in particular a hide
 * always reports a touched span, which disables any caller's
 * clean-repair fast path exactly as a structural repair would.
 */
export interface RepairOptions {
  /**
   * Hide an unfinished trailing link whose label-so-far is itself a
   * scheme-prefixed URI — `[fhir://Obs](fhir://Ob`, `[fhir://Obs]`,
   * `[fhir://Obs` — from its `[` to end of tail. Such a label is either a
   * raw URI the writer pasted as its own link text or the first tokens of
   * one; a consumer that renders URI-labeled links as a marker shows none
   * of the source once complete, so none of it should paint while growing.
   * The test is {@link isUriLikeLabel}; `[Bug:123`, `[C:\Users\me`, task
   * boxes, escaped `\[` and brackets in code spans keep painting.
   */
  hideUriLikeLabels?: boolean;
  /**
   * Schemes whose growing bare-URI token at end of tail (`message://5f3a-`
   * with `['message']`) is hidden until it stops growing. Applies to the
   * tail's last whitespace-delimited token, case-insensitively, and only
   * once at least `scheme:/` has arrived — prose ending in the bare word
   * `scheme:` is never blanked for a chunk. A preceding `(` stays visible.
   * Tokens inside code spans/fences, inside an unfinished link (the link
   * handlers own those), or inside completed opaque constructs are left
   * alone. Unlisted schemes are never touched.
   */
  hideBareUriSchemes?: readonly string[];
}

// A label that is (so far) a scheme-prefixed URI with no whitespace:
// `fhir:/`, `fhir://Obs`. The `:` needs a `/` after it, as in `hideBareUriSchemes`:
// `[Note:` is prose, and hiding it would flash it away for one chunk.
const URI_LIKE_LABEL_RE = /^[a-z][a-z0-9+.-]*:\/[^\s]*$/i;

/**
 * The label test behind {@link RepairOptions.hideUriLikeLabels}, exported
 * so playout layers (the session, a link-destination snap) can agree with
 * the repair on which labels are invisible without importing them here.
 * Trims first: a growing label streams in padding-first.
 */
export function isUriLikeLabel(label: string): boolean {
  return URI_LIKE_LABEL_RE.test(label.trim());
}

/**
 * `\bscheme:/` running whitespace-free to end of tail: the smallest prefix
 * that commits the token to being a URI of a listed scheme (`scheme:`
 * alone is still prose). The `\S*$` shape confines any match to the last
 * whitespace-delimited token. One-entry cache: streams call repairTail
 * once per update with a stable scheme list.
 */
let bareUriCache: { key: string; re: RegExp } | null = null;
function bareUriTailRe(schemes: readonly string[]): RegExp {
  const key = schemes.join('\n');
  if (bareUriCache === null || bareUriCache.key !== key) {
    const alt = schemes
      .map((s) => s.replace(/[^A-Za-z0-9]/g, '\\$&'))
      .join('|');
    bareUriCache = {
      key,
      re: new RegExp(`\\b(?:${alt}):\\/(?:\\/\\S*)?$`, 'i'),
    };
  }
  return bareUriCache.re;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RUN = /^( *)(`{3,}|~{3,})[ \t\r]*$/;

/** Matched repeatedly so nested markers on one line ("- - ```js") strip too. */
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;

interface OpenFence {
  marker: string;
  length: number;
  /** Column the opening run starts at, past any list-item markers. */
  indent: number;
}

/**
 * Strips list markers as md4c does: missing "- ```sh" would read its
 * indented closer as an opener and leave a fence open for the rest of the
 * document. Blockquote prefixes are not stripped, so a quoted fence's opener
 * and closer are both invisible to the scan.
 */
function matchFenceOpen(line: string): OpenFence | null {
  let indent = 0;
  let rest = line;
  for (;;) {
    const m = FENCE_OPEN.exec(rest);
    if (m !== null) {
      // A backtick fence's info string may not contain a backtick, so
      // "``x`y" is inline code rather than a fence.
      if (m[1][0] === '`' && m[2].includes('`')) {
        return null;
      }
      return {
        marker: m[1][0],
        length: m[1].length,
        indent,
      };
    }
    const marker = LIST_MARKER.exec(rest);
    if (marker === null) {
      return null;
    }
    indent += marker[0].length;
    rest = rest.slice(marker[0].length);
  }
}

/**
 * A less-indented closer counts because it ends the list item, and its code
 * block, too. List markers are not stripped: "- ```" inside a fence is content.
 */
function matchesFenceClose(line: string, open: OpenFence): boolean {
  const m = FENCE_CLOSE_RUN.exec(line);
  return (
    m !== null &&
    m[1].length <= open.indent + 3 &&
    m[2][0] === open.marker &&
    m[2].length >= open.length
  );
}

const BLANK_LINE = /^[ \t\r]*$/;

/**
 * A final, still-unterminated line matching one of these would flip the
 * document structure the moment it parses (setext heading, empty heading,
 * empty quote, empty list item, thematic break) even though the very next
 * chunk may turn it into plain prose. Ordered-list markers stop at three
 * digits so a year like "2026." stays visible as prose. Trailing blanks
 * match because md4c already reads "Title\n= " as a setext heading.
 */
const BARE_TAIL_LINE =
  /^ {0,3}(?:#{1,6}[ \t]*|(?:>[ \t]*)+|[-+*][ \t]+|\+|-+[ \t]*|=+[ \t]*|[*_~]+[ \t]*|\d{1,3}[.)][ \t]*)$/;

/**
 * The GFM half of the same guard: a partial delimiter row (`|`, `| --`,
 * `---|`), which md4c turns into a table once `| -` arrives. The header row
 * above still paints as a pipe paragraph until a delimiter row follows; that
 * is CommonMark, and `holdBackChars` is the knob for it.
 */
const BARE_TABLE_TAIL_LINE = /^ {0,3}(?:\||:?-+:?[ \t]*\|)[-:| \t\r]*$/;

function isBareTailLine(line: string, tablesOn: boolean): boolean {
  return (
    BARE_TAIL_LINE.test(line) || (tablesOn && BARE_TABLE_TAIL_LINE.test(line))
  );
}

const PARTIAL_TASK_BOX = /\[(?:[ xX]\]?)?[ \t]*$/;
const QUOTE_MARKERS = /^(?: {0,3}>[ \t]?)*/;

/**
 * Where a final line's half-typed task box ('- [', '- [x', '- [x]', with
 * trailing blanks) starts, or -1. Cut there, the line is a bare list marker
 * and the guard suppresses it; stripped like a lone '[' instead, '- [x' would
 * flash as an item reading 'x'. Markers are peeled one at a time: a single
 * regex over the whole prefix backtracks exponentially on a long '> > >' line.
 */
function partialTaskBox(line: string): number {
  const box = PARTIAL_TASK_BOX.exec(line);
  if (box === null) return -1;
  let rest = line.slice(0, box.index);
  rest = rest.slice(QUOTE_MARKERS.exec(rest)![0].length);
  let markers = 0;
  for (let m = LIST_MARKER.exec(rest); m !== null; m = LIST_MARKER.exec(rest)) {
    rest = rest.slice(m[0].length);
    markers++;
  }
  return markers > 0 && rest === '' ? box.index : -1;
}

const WS = /\s/;
const ALNUM = /[\p{L}\p{N}]/u;

function countDollarPairs(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '$' && line[i + 1] === '$') {
      count++;
      i++;
    }
  }
  return count;
}

function findDollarPair(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '$') {
      return i;
    }
  }
  return -1;
}

/** Derives the repair seed from the settled prefix. */
export function seedFromSettled(settled: string): RepairSeed {
  return continueSeed({ openFence: null, inMath: false }, settled);
}

/**
 * Advances a seed state across `text` (which must start at a line
 * boundary). `seedFromSettled(a + b)` equals
 * `continueSeed(seedFromSettled(a), b)` whenever `a` ends at a line
 * boundary — the property the incremental anchor scan relies on so it never
 * has to rescan the frozen prefix.
 */
export function continueSeed(seed: RepairSeed, text: string): RepairSeed {
  let fence: OpenFence | null = seed.openFence
    ? {
        marker: seed.openFence.marker,
        length: seed.openFence.length,
        indent: seed.openFence.indent ?? 0,
      }
    : null;
  let inMath = seed.inMath;
  let lineStart = 0;
  const settled = text;
  for (;;) {
    const nl = settled.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? settled.length : nl;
    const line = settled.slice(lineStart, lineEnd);
    if (fence) {
      if (matchesFenceClose(line, fence)) {
        fence = null;
      }
    } else if (BLANK_LINE.test(line) && !(nl === -1 && line === '')) {
      // The empty remainder after a trailing newline is not a line. A real
      // blank line clears math: md4c's `$$…$$` is inline and ends with its
      // block, so "costs $$5" must not hold the anchor for the whole stream.
      inMath = false;
    } else if (inMath) {
      if (countDollarPairs(line) % 2 === 1) {
        inMath = false;
      }
    } else {
      const open = matchFenceOpen(line);
      if (open !== null) {
        fence = open;
      } else if (countDollarPairs(line) % 2 === 1) {
        inMath = true;
      }
    }
    if (nl === -1) {
      break;
    }
    lineStart = nl + 1;
  }
  return { openFence: fence, inMath };
}

interface FenceScan {
  open: (OpenFence & { lineStart: number }) | null;
  /** Offset just past the last fence-closing line (== `from` if none). */
  lastCloseEnd: number;
}

function scanFences(
  text: string,
  seedFence: RepairSeed['openFence'],
  from: number,
): FenceScan {
  let open: FenceScan['open'] = seedFence
    ? {
        marker: seedFence.marker,
        length: seedFence.length,
        indent: seedFence.indent ?? 0,
        lineStart: from,
      }
    : null;
  let lastCloseEnd = from;
  let lineStart = from;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    if (open) {
      if (matchesFenceClose(line, open)) {
        open = null;
        lastCloseEnd = nl === -1 ? text.length : nl + 1;
      }
    } else {
      const m = matchFenceOpen(line);
      if (m !== null) {
        open = { ...m, lineStart };
      }
    }
    if (nl === -1) {
      return { open, lastCloseEnd };
    }
    lineStart = nl + 1;
  }
}

function runLength(s: string, i: number, c: string): number {
  let j = i;
  while (j < s.length && s[j] === c) {
    j++;
  }
  return j - i;
}

interface EmphOpen {
  char: string;
  remaining: number;
  pos: number;
}

interface InlineScan {
  emph: EmphOpen[];
  /**
   * `partialClose`: length of a trailing backtick run too short to close the
   * opener, so only the missing backticks get appended.
   */
  codeOpen: { pos: number; runLen: number; partialClose: number } | null;
  mathOpen: { pos: number } | null;
  /** `labelEnd` is the position of the label's ']'. */
  openLink: { pos: number; labelEnd: number; closer: string } | null;
  /** Starts of incomplete images: everything from here to EOT is dropped. */
  imageCuts: number[];
  /** Positions of unmatched plain '[' openers: only the bracket is dropped. */
  bracketStrips: number[];
  /** Start of a trailing partial HTML tag, dropped to EOT. */
  htmlTrim: number | null;
  /**
   * A '[label]' whose ']' is the tail's last char, held back as a possible
   * link (both its positions are also in bracketStrips); recorded so the
   * URI-like-label hide can read the label between them.
   */
  heldBracket: { pos: number; close: number } | null;
  /**
   * Starts of the '||' runs {@link applySpoilers} would read as markers.
   * Empty unless `extensions.spoilers` is on.
   */
  spoilerMarkers: number[];
  /**
   * Parallel to {@link spoilerMarkers}: the start of the md4c text node each
   * marker lands in, the span `applySpoilers` judges an escaped pipe against.
   * Emphasis splits text nodes but does not move it, erring towards the
   * repair standing down.
   */
  spoilerNodeStarts: number[];
  /**
   * End offset of the last completed opaque construct (closed code span,
   * closed math span, finished link, '<...>'). A bare-URI tail token
   * starting before this is (partly) settled inert content, not a growing
   * URI, and must not be hidden.
   */
  inertEnd: number;
  /** Furthest point a longer region with the same prefix may resume from. */
  cut: InlineResume | null;
}

/**
 * A replayable point: scanning `[pos, end)` of any string sharing this scan's
 * first `pos` characters reproduces the rest of the scan; the other fields
 * are the scan's outputs as of `pos`.
 *
 * Cuts are recorded only where the scan state is empty (no open code, math,
 * bracket or emphasis), so these fields are the whole carry, and only at the
 * top of an iteration, because every decision that depends on where the
 * string ends also ends the loop. A `<` with no later `>` stops cut
 * recording for the region: a later `>` could make it one opaque span.
 */
interface InlineResume {
  pos: number;
  inertEnd: number;
  spoilerMarkers: readonly number[];
  spoilerNodeStarts: readonly number[];
}

const NO_SPOILER_MARKERS: readonly number[] = Object.freeze([]);

/**
 * Every character {@link scanInline} reacts to: prose between two of them
 * cannot change scan state, so the pass jumps between them.
 */
const INLINE_SPECIAL = /[\\`$!\[\]<*_~|]/g;

function nextSpecial(s: string, from: number): number {
  if (from >= s.length) {
    return s.length;
  }
  INLINE_SPECIAL.lastIndex = from;
  const m = INLINE_SPECIAL.exec(s);
  return m === null ? s.length : m.index;
}

/**
 * Handler 6's comments, CDATA, processing instructions and declarations.
 * Returns the offset past the terminator, -1 while still open at end of tail
 * (a half-arrived '<!-' included), or null when md4c recognises nothing here
 * ('<! ', '<!5'). Comments and CDATA are withheld however long they run;
 * declarations and PIs only to the end of their line ({@link openDeclaration}).
 */
function htmlSpecialEnd(s: string, i: number): number | null {
  const c1 = s[i + 1];
  if (c1 === '?') {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? openDeclaration(s, i + 2) : e + 2;
  }
  if (c1 !== '!') {
    return null;
  }
  const c2 = s[i + 2];
  if (c2 === undefined) {
    // Every continuation of '<!' md4c recognises is a construct below.
    return -1;
  }
  if (c2 === '-') {
    if (s[i + 3] === undefined) {
      return -1;
    }
    if (s[i + 3] !== '-') {
      return null;
    }
    // md4c ends the empty comments '<!-->' and '<!--->' here; a search from
    // i+4 would walk past the overlapping terminator.
    if (s[i + 4] === '>') {
      return i + 5;
    }
    if (s[i + 4] === '-' && s[i + 5] === '>') {
      return i + 6;
    }
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (c2 === '[') {
    const CDATA = '<![CDATA[';
    if (s.startsWith(CDATA, i)) {
      const e = s.indexOf(']]>', i + CDATA.length);
      return e === -1 ? -1 : e + 3;
    }
    // Still arriving ('<![CDA') vs. prose ('<![x'). A bounded CDATA prefix,
    // not `s.slice(i)`, which would copy the rest of the tail per '<!['.
    const here = s.length - i;
    return here < CDATA.length && s.startsWith(CDATA.slice(0, here), i)
      ? -1
      : null;
  }
  if (/[A-Za-z]/.test(c2)) {
    const e = s.indexOf('>', i + 2);
    return e === -1 ? openDeclaration(s, i + 2) : e + 1;
  }
  return null;
}

/**
 * -1 (keep withholding) while an unterminated declaration or PI may still be
 * one, null (paint as prose) once its line ends: md4c allows a multi-line
 * body, but a stray `<!`/`<?` in prose is far likelier than one.
 */
function openDeclaration(s: string, from: number): number | null {
  const lf = s.indexOf('\n', from);
  const cr = s.indexOf('\r', from);
  return lf === -1 && cr === -1 ? -1 : null;
}

/** {@link inlineHtmlEnd}: this '<' may still open raw HTML once more arrives. */
const HTML_INCOMPLETE = -2;

const ASCII_ALPHA = /[A-Za-z]/;
const TAG_NAME_CHAR = /[A-Za-z0-9-]/;
const ATTR_NAME_START = /[A-Za-z_:]/;
const ATTR_NAME_CHAR = /[A-Za-z0-9_.:-]/;
const UNQUOTED_VALUE_STOP = /[\s"'=<>`]/;
const URI_AUTOLINK_BODY = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
const EMAIL_AUTOLINK_BODY = /^[^\s<>@]+@[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Offset past the '>' when the '<' at `i` opens a complete open or closing
 * tag, {@link HTML_INCOMPLETE} when more text could make one, -1 otherwise.
 * Hand-written: the attribute loop as a regex backtracks catastrophically.
 */
function htmlTagEnd(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  if (j >= n) {
    return HTML_INCOMPLETE;
  }
  const closing = s[j] === '/';
  if (closing) {
    j += 1;
    if (j >= n) {
      return HTML_INCOMPLETE;
    }
  }
  if (!ASCII_ALPHA.test(s[j])) {
    return -1;
  }
  j += 1;
  while (j < n && TAG_NAME_CHAR.test(s[j])) {
    j += 1;
  }
  if (j >= n) {
    return HTML_INCOMPLETE;
  }
  if (closing) {
    while (j < n && WS.test(s[j])) {
      j += 1;
    }
    if (j >= n) {
      return HTML_INCOMPLETE;
    }
    return s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    const wsStart = j;
    while (j < n && WS.test(s[j])) {
      j += 1;
    }
    if (j >= n) {
      return HTML_INCOMPLETE;
    }
    if (s[j] === '>') {
      return j + 1;
    }
    if (s[j] === '/') {
      if (j + 1 >= n) {
        return HTML_INCOMPLETE;
      }
      return s[j + 1] === '>' ? j + 2 : -1;
    }
    // Every attribute needs whitespace in front of it.
    if (j === wsStart || !ATTR_NAME_START.test(s[j])) {
      return -1;
    }
    j += 1;
    while (j < n && ATTR_NAME_CHAR.test(s[j])) {
      j += 1;
    }
    let k = j;
    while (k < n && WS.test(s[k])) {
      k += 1;
    }
    if (k >= n) {
      return HTML_INCOMPLETE;
    }
    if (s[k] !== '=') {
      // A valueless attribute; the next pass reads the whitespace again.
      continue;
    }
    k += 1;
    while (k < n && WS.test(s[k])) {
      k += 1;
    }
    if (k >= n) {
      return HTML_INCOMPLETE;
    }
    const quote = s[k];
    if (quote === '"' || quote === "'") {
      const close = s.indexOf(quote, k + 1);
      if (close === -1) {
        // A '>' inside an unclosed quoted value belongs to the value.
        return HTML_INCOMPLETE;
      }
      j = close + 1;
    } else {
      const start = k;
      while (k < n && !UNQUOTED_VALUE_STOP.test(s[k])) {
        k += 1;
      }
      if (k === start) {
        return -1;
      }
      if (k >= n) {
        return HTML_INCOMPLETE;
      }
      j = k;
    }
  }
}

/** {@link htmlTagEnd} for the two autolink forms. */
function autolinkEnd(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  // An autolink body holds no whitespace and no '<', so the token bounds the
  // search instead of the next '>'.
  while (j < n && !WS.test(s[j]) && s[j] !== '<' && s[j] !== '>') {
    j += 1;
  }
  if (j >= n) {
    return HTML_INCOMPLETE;
  }
  if (s[j] !== '>') {
    return -1;
  }
  const body = s.slice(i + 1, j);
  return URI_AUTOLINK_BODY.test(body) || EMAIL_AUTOLINK_BODY.test(body)
    ? j + 1
    : -1;
}

/**
 * {@link htmlTagEnd} for a tag or an autolink. Prose that merely holds '<'
 * and '>' is not opaque: `a <x||y> then ||z` holds two spoiler markers.
 */
function inlineHtmlEnd(s: string, i: number): number {
  const tag = htmlTagEnd(s, i);
  if (tag >= 0) {
    return tag;
  }
  const link = autolinkEnd(s, i);
  if (link >= 0) {
    return link;
  }
  return tag === HTML_INCOMPLETE || link === HTML_INCOMPLETE
    ? HTML_INCOMPLETE
    : -1;
}

/**
 * One left-to-right pass over the unsettled inline region. Code spans win
 * over everything (their content is inert), link destinations are opaque,
 * `<...>` regions are opaque, and emphasis uses conservative flanking so
 * intraword `*`/`_` (hello*world, snake_case) never registers as open.
 */
function scanInline(
  s: string,
  options: ResolvedEngineOptions,
  resume?: InlineResume | null,
): InlineScan {
  const strikeOn = options.extensions.strikethrough;
  const mathOn = options.extensions.math;
  const spoilersOn = options.extensions.spoilers;
  const emph: EmphOpen[] = [];
  const brackets: { image: boolean; pos: number }[] = [];
  let codeOpen: InlineScan['codeOpen'] = null;
  let mathOpen: InlineScan['mathOpen'] = null;
  let openLink: InlineScan['openLink'] = null;
  const imageCuts: number[] = [];
  const bracketStrips: number[] = [];
  let htmlTrim: number | null = null;
  let heldBracket: InlineScan['heldBracket'] = null;
  const from = resume ?? null;
  const spoilerMarkers: number[] =
    from === null ? [] : from.spoilerMarkers.slice();
  const spoilerNodeStarts: number[] =
    from === null ? [] : from.spoilerNodeStarts.slice();
  let inertEnd = from === null ? 0 : from.inertEnd;
  const n = s.length;
  // `sealed` stops cut recording once a later append could reread a construct
  // from behind.
  let cutPos = -1;
  let cutInert = 0;
  let cutSpoilers = 0;
  let sealed = false;
  // Set by branches that read the string's end. It decides only whether the
  // final position may be a cut: every branch that sets it ends the loop.
  let endTouched = false;
  const lastGreaterThan = s.lastIndexOf('>');
  let i = nextSpecial(s, from === null ? 0 : from.pos);
  while (i < n) {
    // The other outputs are not tested: every branch setting one ends the loop.
    if (
      !sealed &&
      codeOpen === null &&
      mathOpen === null &&
      brackets.length === 0 &&
      emph.length === 0
    ) {
      cutPos = i;
      cutInert = inertEnd;
      cutSpoilers = spoilerMarkers.length;
    }
    endTouched = false;
    const c = s[i];
    if (c === '\\' && codeOpen === null) {
      // A trailing backslash escapes a character that has not arrived yet.
      if (i + 2 > n) {
        endTouched = true;
      }
      i = nextSpecial(s, i + 2);
      continue;
    }
    if (codeOpen) {
      const open: NonNullable<InlineScan['codeOpen']> = codeOpen;
      if (c === '`') {
        const r = runLength(s, i, '`');
        // A run at the end may still grow: '`x`' is closed, '`x``' is not.
        if (i + r >= n) {
          endTouched = true;
        }
        if (r === open.runLen) {
          codeOpen = null;
          inertEnd = i + r;
        } else if (r < open.runLen && i + r === n) {
          // The closer is still arriving; a full run appended on top would
          // fuse into a longer run that cannot close the span.
          codeOpen = { ...open, partialClose: r };
        }
        i += r;
      } else {
        i = nextSpecial(s, i + 1);
      }
      continue;
    }
    if (mathOpen) {
      if (c === '$' && s[i + 1] === '$') {
        mathOpen = null;
        inertEnd = i + 2;
        i += 2;
      } else {
        i = nextSpecial(s, i + 1);
      }
      continue;
    }
    if (c === '`') {
      codeOpen = { pos: i, runLen: runLength(s, i, '`'), partialClose: 0 };
      i += codeOpen.runLen;
      continue;
    }
    if (c === '$' && mathOn && s[i + 1] === '$') {
      mathOpen = { pos: i };
      i += 2;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      brackets.push({ image: true, pos: i });
      i += 2;
      continue;
    }
    if (c === '[') {
      brackets.push({ image: false, pos: i });
      i++;
      continue;
    }
    if (c === ']') {
      const b = brackets.pop();
      if (b && s[i + 1] === '(') {
        let j = i + 2;
        let depth = 1;
        let quote: string | null = null;
        let brokeAtLineEnd = false;
        while (j < n) {
          const d = s[j];
          if (d === '\\' && s[j + 1] !== '\n' && s[j + 1] !== '\r') {
            // A backslash before a line ending is a hard break, not an
            // escape, and must not swallow the newline checked below.
            j += 2;
            continue;
          }
          if (quote) {
            if (d === quote) {
              quote = null;
            }
            j++;
            continue;
          }
          if (d === '\n' || d === '\r') {
            // A destination cannot span a line break, but the whitespace
            // before ')' can: only a ')' or end of tail keeps the link alive.
            let k = j;
            while (k < n && WS.test(s[k])) {
              k++;
            }
            if (k < n && s[k] !== ')') {
              brokeAtLineEnd = true;
              break;
            }
            j = k;
            continue;
          }
          if ((d === '"' || d === "'") && WS.test(s[j - 1])) {
            // Only a quote after whitespace opens a title: `[a](/don't-panic)`
            // is one destination.
            quote = d;
            j++;
            continue;
          }
          if (d === '(') {
            depth++;
          } else if (d === ')' && --depth === 0) {
            break;
          }
          j++;
        }
        if (brokeAtLineEnd) {
          // This '](' can never close, so md4c keeps it literal; scan on as
          // text rather than append a ')' on a later line.
          i = nextSpecial(s, i + 1);
          continue;
        }
        // Emphasis opened inside the label cannot close across the destination.
        while (emph.length && emph[emph.length - 1].pos > b.pos) {
          emph.pop();
        }
        if (j >= n) {
          if (b.image) {
            imageCuts.push(b.pos);
          } else {
            openLink = {
              pos: b.pos,
              labelEnd: i,
              closer: (quote ?? '') + ')'.repeat(depth),
            };
          }
          i = n;
          break;
        }
        i = j + 1;
        inertEnd = i;
      } else if (b && i + 1 === n) {
        // ']' is the tail's last char, so '(' may open the destination as
        // the very next chunk. Hold the construct back — drop the would-be
        // image, strip the link's brackets — instead of letting brackets
        // flash in (and, for an image, the whole "![alt]" flash as prose
        // before vanishing). A later non-'(' char reveals the literal.
        if (b.image) {
          imageCuts.push(b.pos);
        } else {
          bracketStrips.push(b.pos, i);
          heldBracket = { pos: b.pos, close: i };
        }
        i++;
      } else {
        i = nextSpecial(s, i + 1);
      }
      continue;
    }
    if (c === '<') {
      const special = htmlSpecialEnd(s, i);
      if (special !== null) {
        if (special === -1) {
          htmlTrim = i;
          i = n;
          break;
        }
        i = special;
        inertEnd = i;
        continue;
      }
      const html = inlineHtmlEnd(s, i);
      if (html >= 0) {
        i = html;
        inertEnd = i;
        continue;
      }
      if (
        html === -1 &&
        // A declined '<!' or '<?' may still find its terminator lines below.
        s[i + 1] !== '!' &&
        s[i + 1] !== '?' &&
        // With no '>' yet, the trims below read the end.
        lastGreaterThan > i
      ) {
        // Prose that merely holds '<' and '>': the reading is final, so cuts
        // keep being recorded.
        i = nextSpecial(s, i + 1);
        continue;
      }
      // A later append could make this '<' one opaque span, and unlike the
      // `endTouched` cases this does not end the loop.
      sealed = true;
      // Both tests below need '/' or a letter after '<'; checking first keeps
      // the O(tail) `slice` off prose full of '<' comparisons.
      const head = s[i + 1];
      if (head !== '/' && !(head !== undefined && /[A-Za-z]/.test(head))) {
        i = nextSpecial(s, i + 1);
        continue;
      }
      const rest = s.slice(i + 1);
      if (
        /^\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^<>]*)?$/.test(rest) ||
        // Partial autolink: a URI scheme with no closing '>' yet. Without
        // this, "<http://ex" flashes as literal prose until '>' arrives.
        // The scheme is 2-32 characters, as the autolink spec requires:
        // outside that range ("<b:x", a 33-char scheme) no future append can
        // make an autolink, so trimming would withhold guaranteed-literal
        // prose for an unbounded number of chunks.
        /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/.test(rest)
      ) {
        htmlTrim = i;
        i = n;
        break;
      }
      i = nextSpecial(s, i + 1);
      continue;
    }
    if (c === '|' && spoilersOn) {
      // `applySpoilers` pairs runs of exactly two pipes; others are prose.
      const r = runLength(s, i, '|');
      if (r === 2) {
        spoilerMarkers.push(i);
        spoilerNodeStarts.push(inertEnd);
      }
      // A run at the end may still grow: '||' is a marker, '|||' is prose.
      if (i + r >= n) {
        endTouched = true;
      }
      i += r;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const r = runLength(s, i, c);
      // A run at the end may still grow, and its right flank has not arrived.
      if (i + r >= n) {
        endTouched = true;
      }
      if (c === '~' && !strikeOn) {
        i += r;
        continue;
      }
      const prev = i > 0 ? s[i - 1] : '';
      const next = i + r < n ? s[i + r] : '';
      const prevWS = prev === '' || WS.test(prev);
      const nextWS = next === '' || WS.test(next);
      let remaining = r;
      if (!prevWS) {
        while (remaining > 0 && emph.length) {
          const top = emph[emph.length - 1];
          if (top.char !== c) {
            break;
          }
          const take = Math.min(remaining, top.remaining);
          top.remaining -= take;
          remaining -= take;
          if (top.remaining === 0) {
            emph.pop();
          }
        }
      }
      if (remaining > 0 && !nextWS && !(prev !== '' && ALNUM.test(prev))) {
        if (c === '~') {
          if (remaining >= 2) {
            emph.push({ char: c, remaining: 2, pos: i + (r - remaining) });
          }
        } else {
          emph.push({ char: c, remaining, pos: i + (r - remaining) });
        }
      }
      i += r;
      continue;
    }
    // A trailing '$' or '!' is inert only until its partner ('$', '[') arrives.
    if (i + 1 >= n) {
      endTouched = true;
    }
    i = nextSpecial(s, i + 1);
  }
  if (
    !sealed &&
    !endTouched &&
    codeOpen === null &&
    mathOpen === null &&
    openLink === null &&
    htmlTrim === null &&
    heldBracket === null &&
    brackets.length === 0 &&
    emph.length === 0 &&
    imageCuts.length === 0 &&
    bracketStrips.length === 0
  ) {
    cutPos = n;
    cutInert = inertEnd;
    cutSpoilers = spoilerMarkers.length;
  }
  for (const b of brackets) {
    if (b.image) {
      imageCuts.push(b.pos);
    } else {
      bracketStrips.push(b.pos);
    }
  }
  return {
    emph,
    codeOpen,
    mathOpen,
    openLink,
    imageCuts,
    bracketStrips,
    htmlTrim,
    heldBracket,
    spoilerMarkers,
    spoilerNodeStarts,
    inertEnd,
    cut:
      cutPos === -1
        ? null
        : {
            pos: cutPos,
            inertEnd: cutInert,
            spoilerMarkers:
              cutSpoilers === 0
                ? NO_SPOILER_MARKERS
                : spoilerMarkers.slice(0, cutSpoilers),
            spoilerNodeStarts:
              cutSpoilers === 0
                ? NO_SPOILER_MARKERS
                : spoilerNodeStarts.slice(0, cutSpoilers),
          },
  };
}

/**
 * Tested on the content past any blockquote markers. Nothing opened on an
 * earlier line can bind into a block this starts.
 */
const LEAF_BLOCK_START =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|`{3,}|~{3,}|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/** A line that is a whole leaf block, so the next line starts a new one. */
const SELF_CONTAINED_LINE =
  /^ {0,3}(?:#{1,6}(?:[ \t].*)?|=+[ \t]*|-+[ \t]*|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * CommonMark HTML block conditions 1-6. Condition 7 is absent: it cannot
 * interrupt a paragraph, and after a blank line the region has restarted.
 */
const HTML_BLOCK_START =
  /^ {0,3}<(?:\?|!(?:--|\[CDATA\[|[A-Za-z])|\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|$))/i;

/**
 * `applySpoilers` skips a text node holding an escaped pipe, so the repair
 * stands down on the same evidence, tested over the same span: from the
 * opener's {@link InlineScan.spoilerNodeStarts} to the end.
 */
const ESCAPED_PIPE = /\\\|/;

/** A GFM table row or headerless delimiter row; each row is its own block. */
const TABLE_ROW_LINE = /^ {0,3}(?:\||:?-+:?[ \t]*\|)/;

/**
 * Start of the last cell when the region's final line is a real GFM table
 * row, else -1. Cells are separate inline contexts and the closer lands in
 * the last one, so openers in earlier cells get none (`| a _b | c _d |`).
 * Only `\|` escapes a pipe here: cell splitting runs before code spans.
 */
function lastCellStart(
  tail: string,
  regionStart: number,
  region: string,
  options: ResolvedEngineOptions,
  hasOpenerBefore: (cell: number) => boolean,
): number {
  if (!options.extensions.tables) {
    return -1;
  }
  const lineStart =
    Math.max(region.lastIndexOf('\n'), region.lastIndexOf('\r')) + 1;
  for (let i = region.lastIndexOf('|'); i >= lineStart; ) {
    let backslashes = 0;
    while (
      i - 1 - backslashes >= lineStart &&
      region[i - 1 - backslashes] === '\\'
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      const cell = i + 1;
      return hasOpenerBefore(cell) &&
        insideTable(tail, regionStart + lineStart, options)
        ? cell
        : -1;
    }
    i = region.lastIndexOf('|', i - 1);
  }
  return -1;
}

/** A GFM delimiter row, including one still arriving ('| -', '| --- | :-'). */
const DELIMITER_ROW =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?[ \t]*$/;

const TABLE_LOOKBACK_ROWS = 1024;

/**
 * A header row whose delimiter row has not arrived. The lookahead keeps a
 * line-opening `||secret` repairable while `| a || c |` keeps its pipes.
 */
const POSSIBLE_HEADER_ROW = /^ {0,3}\|(?!\|)[^|]*\|/;

function isDelimiterRow(line: string): boolean {
  return (
    line.includes('|') && line.includes('-') && DELIMITER_ROW.test(line)
  );
}

/** A `pos` on a line terminator belongs to the line it ends. */
function lineAround(s: string, pos: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(pos, s.length));
  const start =
    at === 0
      ? 0
      : Math.max(s.lastIndexOf('\n', at - 1), s.lastIndexOf('\r', at - 1)) + 1;
  let end = start;
  while (end < s.length && s[end] !== '\n' && s[end] !== '\r') {
    end += 1;
  }
  return { start, end };
}

function previousLine(
  s: string,
  lineStart: number,
): { start: number; end: number } | null {
  if (lineStart <= 0) {
    return null;
  }
  // Step onto the terminator, and over both halves of a CRLF.
  let at = lineStart - 1;
  if (at > 0 && s[at] === '\n' && s[at - 1] === '\r') {
    at -= 1;
  }
  return lineAround(s, at);
}

/**
 * A table needs a delimiter row under a header, as the parse decides; a
 * line that merely opens with a pipe ('||secret') is not one.
 */
function insideTable(
  s: string,
  pos: number,
  options: ResolvedEngineOptions,
): boolean {
  if (!options.extensions.tables) {
    return false;
  }
  const here = lineAround(s, pos);
  const line = s.slice(here.start, here.end);
  // The delimiter row itself: every pipe on it is structural.
  if (isDelimiterRow(line)) {
    return true;
  }
  if (line.includes('|')) {
    // A header row, once its delimiter row has arrived under it.
    if (here.end < s.length) {
      const belowStart = here.end + (s.startsWith('\r\n', here.end) ? 2 : 1);
      const below = lineAround(s, belowStart);
      if (
        below.start === belowStart &&
        isDelimiterRow(s.slice(below.start, below.end))
      ) {
        return true;
      }
    }
  }
  return tableBodyRow(s, here.start, options);
}

/**
 * {@link insideTable}, plus a header row still arriving. Only the spoiler
 * repair asks: a wrong "not a table" there paints a phantom `||` into a row,
 * while {@link lastCellStart}'s wrong answer only withholds a closer.
 */
function tablePipesHere(
  s: string,
  pos: number,
  options: ResolvedEngineOptions,
): boolean {
  if (insideTable(s, pos, options)) {
    return true;
  }
  if (!options.extensions.tables) {
    return false;
  }
  const here = lineAround(s, pos);
  return (
    here.end >= s.length &&
    POSSIBLE_HEADER_ROW.test(s.slice(here.start, here.end))
  );
}

/**
 * Whether the line at `lineStart` sits under a delimiter row with a header
 * above it. The line's own shape is not evidence: a delimiter row still
 * arriving is not a table until its cell count can be checked.
 */
function tableBodyRow(
  s: string,
  lineStart: number,
  options: ResolvedEngineOptions,
): boolean {
  if (!options.extensions.tables) {
    return false;
  }
  let at = lineStart;
  for (let rows = 0; ; rows += 1) {
    if (rows >= TABLE_LOOKBACK_ROWS) {
      // Giving up reads as "not a table": a taller table pays one snapshot
      // of virtual closer, which beats a spoiler body streaming in the clear.
      return false;
    }
    const above = previousLine(s, at);
    if (above === null) {
      return false;
    }
    const content = s.slice(above.start, above.end);
    if (BLANK_LINE.test(content)) {
      return false;
    }
    if (isDelimiterRow(content)) {
      // …and the delimiter row needs a header line above it.
      const header = previousLine(s, above.start);
      if (header === null) {
        return false;
      }
      const headerLine = s.slice(header.start, header.end);
      return !BLANK_LINE.test(headerLine) && headerLine.includes('|');
    }
    if (
      !content.includes('|') ||
      LEAF_BLOCK_START.test(content) ||
      HTML_BLOCK_START.test(content) ||
      QUOTE_PREFIX.test(content)
    ) {
      return false;
    }
    at = above.start;
  }
}

/**
 * Start of the trailing `*`/`_`/`~` run when whitespace or the string start
 * precedes it, else -1. Scanned backwards: `/(?:^|\s)([*_~]+)$/` is O(tail)
 * in V8 because it is anchored only at the end.
 */
function trailingDelimiterRun(s: string, strikeOn: boolean): number {
  let i = s.length;
  while (i > 0) {
    const c = s[i - 1];
    if (c === '*' || c === '_' || (strikeOn && c === '~')) {
      i -= 1;
    } else {
      break;
    }
  }
  if (i === s.length) {
    return -1;
  }
  return i === 0 || WS.test(s[i - 1]) ? i : -1;
}

const QUOTE_PREFIX = /^ {0,3}(?:>[ \t]?)+/;

interface LeafBlockScan {
  start: number;
  /** Start of the tail's final line (== `from` when it holds no break). */
  lastLineStart: number;
}

/**
 * Where the last leaf block in `tail.slice(from)` starts: an opener in an
 * earlier block cannot be closed by appending ("- a _b\n- c _d"), so it stays
 * literal. A trailing line handler 7 suppresses is not a boundary ("**a\n-"
 * still closes). The offset includes the boundary line's terminator so
 * suppression can delete the whole line.
 */
function leafBlockStart(
  tail: string,
  from: number,
  options: ResolvedEngineOptions,
): LeafBlockScan {
  const tablesOn = options.extensions.tables;
  const opensLeaf = (content: string): boolean =>
    LEAF_BLOCK_START.test(content) ||
    HTML_BLOCK_START.test(content) ||
    (tablesOn && TABLE_ROW_LINE.test(content));
  const closesLeaf = (content: string): boolean =>
    SELF_CONTAINED_LINE.test(content) ||
    (tablesOn && TABLE_ROW_LINE.test(content));

  const breaks = /\r\n|\n|\r/g;
  breaks.lastIndex = from;
  let boundary = from;
  let lineStart = from;
  // -1 matches no real depth, so the first line is never a boundary by depth.
  let prevDepth = -1;
  let prevBlank = false;
  let prevClosed = false;
  for (;;) {
    const m = breaks.exec(tail);
    const lineEnd = m === null ? tail.length : m.index;
    const raw = tail.slice(lineStart, lineEnd);
    const quote = QUOTE_PREFIX.exec(raw);
    const depth = quote === null ? 0 : quote[0].split('>').length - 1;
    const content = quote === null ? raw : raw.slice(quote[0].length);
    if (lineStart > from) {
      // Consecutive `>` lines of the same depth are one paragraph, where
      // emphasis binds across the line break.
      const startsBlock =
        depth !== prevDepth || prevBlank || prevClosed || opensLeaf(content);
      const suppressed = m === null && isBareTailLine(raw, tablesOn);
      if (startsBlock && !suppressed) {
        boundary = lineStart;
      }
    }
    prevDepth = depth;
    prevBlank = BLANK_LINE.test(content);
    prevClosed = closesLeaf(content);
    if (m === null) {
      break;
    }
    lineStart = m.index + m[0].length;
  }
  if (boundary === from) {
    return { start: from, lastLineStart: lineStart };
  }
  const before = tail[boundary - 1];
  return {
    start: before === '\n' || before === '\r' ? boundary - 1 : boundary,
    lastLineStart: lineStart,
  };
}

/**
 * Repairs the unsettled tail before parsing so incomplete constructs never
 * flash mid-stream. Pure: same arguments, same result. `carry` (the
 * {@link RepairScan} a call on a shorter prefix returned) changes only speed.
 *
 * Handler precedence (each guarded):
 *   0. a lone high surrogate at the cut (a split pair) is dropped first;
 *   1. open fence (seeded or tail-opened): close virtually, nothing else —
 *      no inline repairs inside code;
 *   2. inline code backticks: balance only a run open at tail end, appending
 *      just the backticks a partial closer is still missing, and everything
 *      inside a code span is inert for later handlers;
 *   3. emphasis/strong/strike closers, half-complete closers completed,
 *      content-empty openers suppressed instead of closed;
 *   4. display math (only when the math extension is on);
 *  4b. spoilers (only when the spoilers extension is on): an unpaired '||'
 *      gets a virtual closer, a content-empty opener is suppressed, and
 *      pipes on a table row are left alone;
 *   5. links closed virtually / lone '[' stripped / incomplete images
 *      dropped from display — with `repair.hideUriLikeLabels`, an
 *      unfinished trailing link with a URI-like label is dropped from
 *      display entirely instead. A '](' whose destination runs into a line
 *      break can never close, so it is left literal rather than closed;
 *   6. trailing partial HTML tag, autolink, comment, CDATA section,
 *      processing instruction or declaration trimmed, and a growing bare
 *      URI of a `repair.hideBareUriSchemes` scheme dropped the same way;
 *   7. structure-flip guard: a bare, still-unterminated final line that
 *      would flip block structure is suppressed from the parse input —
 *      setext/heading/quote/list/break shapes always, and with
 *      `extensions.tables` a pipes-and-dashes table row too.
 */
export function repairTail(
  tail: string,
  seed: RepairSeed,
  options: ResolvedEngineOptions,
  repair?: RepairOptions,
  carry?: RepairScan | null,
): RepairResult {
  const touched: SourceSpan[] = [];
  const mathOn = options.extensions.math;

  // A chunk boundary can split a surrogate pair. The lone high half is not
  // valid UTF-16 — the parser/encoder would mangle it into U+FFFD — so drop
  // it before any handler sees the tail; the low half rejoins it next chunk.
  const last = tail.charCodeAt(tail.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    touched.push({ start: tail.length - 1, end: tail.length });
    tail = tail.slice(0, -1);
  }

  let cursor = 0;
  if (seed.inMath && mathOn) {
    const close = findDollarPair(tail, 0);
    if (close === -1) {
      if (tail.length > 0) {
        touched.push({ start: 0, end: tail.length });
      }
      // Returning the incoming carry would describe a different region's scan.
      return { text: tail + '$$', appended: '$$', touched, scan: null };
    }
    cursor = close + 2;
  }

  const fences = scanFences(tail, seed.openFence, cursor);
  if (fences.open) {
    // A column-0 closer would end the list item and leave the fence open.
    const closer =
      ' '.repeat(fences.open.indent) +
      fences.open.marker.repeat(fences.open.length);
    const appended = (tail.endsWith('\n') ? '' : '\n') + closer;
    touched.push({ start: fences.open.lineStart, end: tail.length });
    return { text: tail + appended, appended, touched, scan: null };
  }

  let regionStart = Math.max(cursor, fences.lastCloseEnd);
  // Line-ending agnostic, like the bare-tail-line guard above: a CRLF
  // stream's blank line separates paragraphs exactly as an LF one does, and
  // missing it here would "close" emphasis across a paragraph boundary where
  // emphasis cannot bind — literal asterisks in every snapshot of a CRLF
  // stream. The lookahead in `\r(?!\n)` is load-bearing: a plain `\r|\n`
  // alternation lets the engine backtrack a single CRLF pair into CR-then-LF
  // — two "terminators" — and read one ordinary line break as a blank line.
  const blankRun = /(?:\r\n|\r(?!\n)|\n)(?:[ \t]*(?:\r\n|\r(?!\n)|\n))+/g;
  let bm: RegExpExecArray | null;
  while ((bm = blankRun.exec(tail))) {
    const end = bm.index + bm[0].length;
    if (end > regionStart) {
      regionStart = end;
    }
  }
  const leaf = leafBlockStart(tail, regionStart, options);
  regionStart = leaf.start;
  const region = tail.slice(regionStart);
  const flags = scanFlags(options);
  const scan = scanInline(region, options, resumeFrom(carry, tail, regionStart, flags));

  // Delete-to-end cut: incomplete images and trailing partial HTML tags
  // are removed from display entirely.
  let cutAt: number | null = null;
  for (const p of scan.imageCuts) {
    cutAt = cutAt === null ? p : Math.min(cutAt, p);
  }
  if (scan.htmlTrim !== null) {
    cutAt = cutAt === null ? scan.htmlTrim : Math.min(cutAt, scan.htmlTrim);
  }
  if (options.extensions.tasklists) {
    const lineStart = Math.max(region.lastIndexOf('\n'), region.lastIndexOf('\r')) + 1;
    const task = partialTaskBox(region.slice(lineStart));
    if (task >= 0 && lineStart + task >= scan.inertEnd) {
      const box = lineStart + task;
      cutAt = cutAt === null ? box : Math.min(cutAt, box);
    }
  }
  if (repair?.hideUriLikeLabels) {
    // An unfinished trailing link whose label-so-far is URI-like is hidden
    // from its '[' to EOT — cut like an incomplete image — instead of
    // virtually closed (open destination), held (']' at EOT), or
    // bracket-stripped (unmatched '['). All three constructs run to EOT by
    // construction, so the label-so-far is at hand in each.
    const link = scan.openLink;
    if (link && isUriLikeLabel(region.slice(link.pos + 1, link.labelEnd))) {
      cutAt = cutAt === null ? link.pos : Math.min(cutAt, link.pos);
    }
    const held = scan.heldBracket;
    if (held && isUriLikeLabel(region.slice(held.pos + 1, held.close))) {
      cutAt = cutAt === null ? held.pos : Math.min(cutAt, held.pos);
    }
    for (const p of scan.bracketStrips) {
      // The held pair was judged by its bracketed label above; every other
      // strip is an unmatched '[' whose label-so-far runs to EOT.
      if (held !== null && (p === held.pos || p === held.close)) {
        continue;
      }
      if (isUriLikeLabel(region.slice(p + 1))) {
        cutAt = cutAt === null ? p : Math.min(cutAt, p);
      }
    }
  }
  const bareSchemes = repair?.hideBareUriSchemes;
  if (bareSchemes !== undefined && bareSchemes.length > 0) {
    // The regex's \S*$ shape confines any match to the tail's last
    // whitespace-delimited token, so the cut starts at the scheme and a
    // preceding '(' stays visible. Guards: a token inside an open
    // code/math span is inert, one inside an unfinished link belongs to
    // the link handlers, and one starting inside a completed opaque
    // construct is settled content, not a growing URI.
    const m = bareUriTailRe(bareSchemes).exec(region);
    if (
      m !== null &&
      m.index >= scan.inertEnd &&
      !(scan.codeOpen && scan.codeOpen.pos < m.index) &&
      !(scan.mathOpen && scan.mathOpen.pos < m.index) &&
      !(scan.openLink && scan.openLink.pos < m.index)
    ) {
      cutAt = cutAt === null ? m.index : Math.min(cutAt, m.index);
    }
  }
  const alive = (pos: number) => cutAt === null || pos < cutAt;
  const codeOpen =
    scan.codeOpen && alive(scan.codeOpen.pos) ? scan.codeOpen : null;
  const mathOpen =
    scan.mathOpen && alive(scan.mathOpen.pos) ? scan.mathOpen : null;
  const openLink =
    scan.openLink && alive(scan.openLink.pos) ? scan.openLink : null;
  const emphLive = scan.emph.filter((e) => alive(e.pos));
  const stripsAsc = scan.bracketStrips.filter(alive).sort((a, b) => a - b);
  /** A region offset mapped through the bracket strips. */
  const shift = (pos: number): number => {
    let lo = 0;
    let hi = stripsAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (stripsAsc[mid] < pos) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return pos - lo;
  };

  let edited = cutAt !== null ? region.slice(0, cutAt) : region;
  if (cutAt !== null) {
    touched.push({
      start: regionStart + cutAt,
      end: regionStart + region.length,
    });
  }
  if (stripsAsc.length > 0) {
    const parts: string[] = [];
    let from = 0;
    for (const p of stripsAsc) {
      parts.push(edited.slice(from, p));
      from = p + 1;
      touched.push({ start: regionStart + p, end: regionStart + p + 1 });
    }
    parts.push(edited.slice(from));
    edited = parts.join('');
  }

  const opens: { pos: number; closer: string }[] = [];
  const runDeletes: { start: number; end: number }[] = [];
  if (codeOpen) {
    if (codeOpen.pos + codeOpen.runLen >= region.length) {
      // Content-empty opener: suppress instead of emitting an empty span.
      runDeletes.push({
        start: codeOpen.pos,
        end: codeOpen.pos + codeOpen.runLen,
      });
    } else {
      // Only the backticks the closing run still misses: "x ``y`" needs one.
      opens.push({
        pos: codeOpen.pos,
        closer: '`'.repeat(codeOpen.runLen - codeOpen.partialClose),
      });
    }
  }
  if (mathOpen) {
    if (mathOpen.pos + 2 >= region.length) {
      runDeletes.push({ start: mathOpen.pos, end: mathOpen.pos + 2 });
    } else {
      opens.push({ pos: mathOpen.pos, closer: '$$' });
    }
  }
  if (openLink) {
    opens.push({ pos: openLink.pos, closer: openLink.closer });
  }
  // Handler 4b: the spoiler transform builds nothing until it sees a closing
  // run, so without a virtual closer the body renders in the clear.
  let spoilerOpen: { pos: number; closer: string } | null = null;
  if (options.extensions.spoilers) {
    const markers: number[] = [];
    const nodeStarts: number[] = [];
    scan.spoilerMarkers.forEach((m, idx) => {
      if (alive(m)) {
        markers.push(m);
        nodeStarts.push(scan.spoilerNodeStarts[idx] ?? 0);
      }
    });
    if (markers.length % 2 === 1) {
      const pos = markers[markers.length - 1];
      // The opener's text node through to the region end.
      const nodeStart = Math.min(nodeStarts[nodeStarts.length - 1], pos);
      if (shift(pos + 2) >= edited.length) {
        // Content-empty: a closer would fuse into '||||', which the
        // transform never reads as markers.
        runDeletes.push({ start: pos, end: pos + 2 });
      } else if (
        !tablePipesHere(tail, regionStart + pos, options) &&
        !ESCAPED_PIPE.test(region.slice(nodeStart))
      ) {
        spoilerOpen = { pos, closer: '||' };
        opens.push(spoilerOpen);
      }
    }
  }
  // Where `edited` will end once the code/math/spoiler run deletes above
  // are applied: a content-empty code, math or spoiler run always occupies
  // a suffix of the region (its whole tail belongs to the span), so the
  // emphasis check below must measure against the post-delete end or an
  // opener glued to such a run would read as contentful.
  let editedEnd = edited.length;
  for (const d of runDeletes) {
    editedEnd = Math.min(editedEnd, shift(d.start));
  }
  // Innermost-first (openers are recorded in scan order), so a deleted
  // opener exposes the one left of it: stacked openers emptied by the same
  // cut ('a *_[uri…') all suppress, not just the rightmost.
  for (let i = emphLive.length - 1; i >= 0; i -= 1) {
    const e = emphLive[i];
    // An opener whose delimiter run is the last thing left in `edited` — a
    // delete-to-end cut (hidden link/URI, incomplete image), a bracket
    // strip, or a content-empty suppression removed everything after it —
    // is itself content-empty: pairing it with a virtual closer would emit
    // an empty emphasis span, and the trailing-run guard below would then
    // delete the opener text while its closer still ships in `appended`,
    // leaving an unmatched literal '*'/'**' in the parse input
    // ('text *[fhir://…' painting 'text*' under hideUriLikeLabels).
    // Suppress the run instead, mirroring the content-empty code/math
    // openers above. The run end is re-measured from the region because
    // `remaining` understates it for a clamped '~' run; comparing through
    // `shift` keeps the check honest when bracket strips sit between the
    // run and the cut.
    const runEnd = e.pos + runLength(region, e.pos, e.char);
    if (shift(runEnd) >= editedEnd) {
      runDeletes.push({ start: e.pos, end: runEnd });
      editedEnd = Math.min(editedEnd, shift(e.pos));
    } else {
      opens.push({ pos: e.pos, closer: e.char.repeat(e.remaining) });
    }
  }

  runDeletes.sort((a, b) => b.start - a.start);
  for (const d of runDeletes) {
    edited = edited.slice(0, shift(d.start)) + edited.slice(shift(d.end));
    touched.push({ start: regionStart + d.start, end: regionStart + d.end });
  }

  // Filtered after the content-empty suppressions, so those still see the
  // openers they measure against.
  const cellStart =
    opens.length === 0
      ? -1
      : lastCellStart(tail, regionStart, region, options, (cell) =>
          opens.some((o) => o.pos < cell),
        );
  if (cellStart > 0) {
    for (let i = opens.length - 1; i >= 0; i -= 1) {
      if (opens[i].pos < cellStart) {
        opens.splice(i, 1);
      }
    }
  }

  // When an open code span or math span owns the rest of the tail, its
  // content is literal — the text guards below must not touch it.
  const contentOwned = opens.some(
    (o) => o.closer[0] === '`' || o.closer === '$$',
  );
  if (!contentOwned) {
    const runStart = trailingDelimiterRun(
      edited,
      options.extensions.strikethrough,
    );
    if (runStart !== -1) {
      // A trailing delimiter run that neither opened nor closed anything:
      // it would flash as literal markers, then become an opener. Suppress.
      touched.push({
        start: regionStart + runStart,
        end: regionStart + edited.length,
      });
      edited = edited.slice(0, runStart);
    }
    if (!edited.endsWith('\n')) {
      // '\r' terminates a line too (bare CR, or CRLF split at the cut).
      // When nothing was edited, `leafBlockStart` already found the last line.
      const nl =
        edited === region
          ? leaf.lastLineStart - regionStart - 1
          : Math.max(edited.lastIndexOf('\n'), edited.lastIndexOf('\r'));
      const line = edited.slice(nl + 1);
      // A '||' here may close a completed spoiler ('hint: ||one\n||');
      // deleting the line would expose the body, so keep it.
      const spoilerCloser =
        options.extensions.spoilers && line.includes('||');
      // Only the table half needs a line above: with none, '|' is a
      // paragraph, and deleting it can blank the whole document.
      const above = previousLine(tail, leaf.lastLineStart);
      const tableLine =
        options.extensions.tables &&
        above !== null &&
        !BLANK_LINE.test(tail.slice(above.start, above.end)) &&
        BARE_TABLE_TAIL_LINE.test(line) &&
        // …and a body row of table punctuation ('| - | - |') is content:
        // the table above it already exists.
        !tableBodyRow(tail, leaf.lastLineStart, options);
      if (
        line !== '' &&
        !spoilerCloser &&
        (BARE_TAIL_LINE.test(line) || tableLine)
      ) {
        const from = nl >= 0 ? nl : 0;
        touched.push({
          start: regionStart + from,
          end: regionStart + edited.length,
        });
        edited = edited.slice(0, from);
      }
    }
  }

  opens.sort((a, b) => b.pos - a.pos);
  if (
    opens.length > 0 &&
    /[*_~]/.test(opens[0].closer[0]) &&
    /[ \t\r]$/.test(edited)
  ) {
    // An emphasis closer appended after whitespace would not bind — '\r'
    // included: a CRLF split at the cut leaves the CR as trailing space.
    // A scan, not `/[ \t\r]+$/`, which is quadratic on a long whitespace run.
    let cut = edited.length;
    while (cut > 0) {
      const c = edited.charCodeAt(cut - 1);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0d) break;
      cut -= 1;
    }
    const trimmed = edited.slice(0, cut);
    touched.push({
      start: regionStart + trimmed.length,
      end: regionStart + edited.length,
    });
    edited = trimmed;
  }
  if (!contentOwned && /(?:^|[^\\])(?:\\\\)*\\$/.test(edited)) {
    // An odd trailing backslash escapes any closer ('a *b\\' + '*' shows both
    // stars). Code and math are exempt: backslash does not escape there.
    opens.length = 0;
  }
  // A line ending cannot be trimmed like other whitespace, and a closer after
  // it cannot bind, so drop the closer ('a *b\n' would show two stars).
  while (
    opens.length > 0 &&
    /[*_~]/.test(opens[0].closer[0]) &&
    (edited === '' || /\s$/.test(edited))
  ) {
    opens.shift();
  }

  if (spoilerOpen !== null && opens[0] === spoilerOpen) {
    // Only a first closer touches `edited`, where a half-arrived closer
    // would fuse: '||secret|' + '||' is three pipes, never a marker.
    let run = 0;
    while (run < edited.length && edited[edited.length - 1 - run] === '|') {
      run += 1;
    }
    if (run === 1) {
      spoilerOpen.closer = '|';
    } else if (run !== 0) {
      // Two or more pipes already at end of tail: no append can pair them
      // off, so leave the spoiler alone for this snapshot.
      opens.shift();
    }
  }

  const appended = opens.map((o) => o.closer).join('');
  for (const o of opens) {
    touched.push({ start: regionStart + o.pos, end: tail.length });
  }
  return {
    text: tail.slice(0, regionStart) + edited + appended,
    appended,
    touched,
    scan:
      scan.cut === null
        ? null
        : {
            tailLength: tail.length,
            tailMark: fingerprint(tail, tail.length),
            flags,
            regionStart,
            inline: scan.cut,
          },
  };
}

/** Not proof of a shared prefix; see {@link RepairScan}. */
function fingerprint(tail: string, length: number): number {
  if (length === 0) {
    return 0;
  }
  let mark = length;
  for (const at of [0, length >> 2, length >> 1, length - 1]) {
    mark = (Math.imul(mark, 31) + tail.charCodeAt(at)) | 0;
  }
  return mark;
}

/** Every extension flag the scan and region derivation read. */
function scanFlags(options: ResolvedEngineOptions): number {
  const ext = options.extensions;
  return (
    (ext.math ? 1 : 0) |
    (ext.strikethrough ? 2 : 0) |
    (ext.spoilers ? 4 : 0) |
    (ext.tables ? 8 : 0)
  );
}

function resumeFrom(
  carry: RepairScan | null | undefined,
  tail: string,
  regionStart: number,
  flags: number,
): InlineResume | null {
  if (carry === undefined || carry === null) {
    return null;
  }
  if (
    carry.flags !== flags ||
    carry.regionStart !== regionStart ||
    carry.tailLength > tail.length ||
    fingerprint(tail, carry.tailLength) !== carry.tailMark
  ) {
    return null;
  }
  return carry.inline;
}
