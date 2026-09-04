import type { SourceSpan } from '../document/span';
import type { ResolvedEngineOptions } from '../engine/options';

export interface RepairSeed {
  /**
   * Fence open at the settled/unsettled boundary: the fence character
   * ('`' or '~'), the length of its opening run, and the column that run
   * starts at. `indent` is optional and defaults to 0 (a fence at top
   * level); it is non-zero for a fence sharing a line with list markers
   * ("- ```sh" opens at column 2), whose closing run carries the item's
   * indentation.
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
   * Carry-forward state for the NEXT call on this tail — see
   * {@link RepairScan}. Null when this call learned nothing reusable.
   *
   * OPTIONAL on the type, always present on a `repairTail` result: a
   * wrapper that builds a `RepairResult` of its own (a decorator around
   * `repairTail`, a test double) has nothing to carry and must not be forced
   * to invent one. Omitting it costs only the resume — the next call
   * re-derives the scan, exactly as it did before the carry existed.
   */
  scan?: RepairScan | null;
}

/**
 * Opaque carry-forward state between two {@link repairTail} calls on the
 * same growing tail. Hand back what the previous call returned and the pass
 * resumes its inline scan where it left off instead of re-deriving it from
 * the start of the tail; hand back nothing and the call behaves exactly as
 * it always did.
 *
 * `repairTail` stays PURE — its result is still a function of its arguments
 * alone — which is why this is a parameter and a return value rather than a
 * module-level cache. Ownership belongs to whoever knows how the tail is
 * changing: `StreamSession` keeps one of these per anchor and drops it on
 * anything that is not a plain append (a divergent replace or rewrite, a
 * finalize, an anchor move).
 *
 * MISUSING IT IS A WRONG ANSWER, NOT AN ERROR. The state only describes the
 * tail it was produced from, so it is valid only when passed back with a tail
 * that has that one as a PREFIX, the same resolved options, and the same
 * anchor. The guards are exactly the four fields below — the tail length, a
 * fingerprint of four sampled characters of it, the packed extension flags,
 * and the derived region start — checked before the resume is used. They
 * catch the mistakes that come from wiring; they do NOT catch a caller that
 * hands back state from a different document of the same length, which
 * silently repairs against a scan of the wrong text. Nothing here is a
 * checksum, and no misuse throws. When in doubt, pass nothing: the pass then
 * derives everything itself, which is only slower.
 */
export interface RepairScan {
  /** Length of the tail this was derived from (after any surrogate trim). */
  readonly tailLength: number;
  /** A few sampled characters of that tail — a fingerprint, not a checksum. */
  readonly tailMark: number;
  /** The extension flags the scan depended on. */
  readonly flags: number;
  /** Where the inline region started, so a moved region invalidates. */
  readonly regionStart: number;
  /** The resume point inside that region. */
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
   * The exact test is {@link isUriLikeLabel}: a whitespace-free token whose
   * scheme run is followed by `:` and then either `/` or nothing yet. A
   * label that merely holds a colon is prose and keeps the default
   * treatment (virtual close / bracket strip) — `[Bug:123`, `[a:b` and
   * `[C:\Users\me` all paint while they grow — as do task boxes `[x]`,
   * escaped `\[`, and brackets inside code spans.
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
// `fhir:`, `fhir:/`, `fhir://Obs`, `https://x`. The `:` must be followed by
// `/`, or by nothing yet — the same "at least `scheme:/` has arrived" bar
// `hideBareUriSchemes` applies to bare tokens. Without it EVERY
// whitespace-free token holding a colon qualified, so ordinary prose labels
// (`[Bug:123`, `[a:b`, `[C:\Users\me`) were blanked from the render for as
// long as their construct stayed unfinished and then popped in whole.
const URI_LIKE_LABEL_RE = /^[a-z][a-z0-9+.-]*:(?:\/[^\s]*)?$/i;

/**
 * The label test behind {@link RepairOptions.hideUriLikeLabels}, exported
 * so playout layers (the session, a link-destination snap) can agree with
 * the repair on which labels are invisible without importing them here.
 * True for a whitespace-free `scheme:`, `scheme:/…` token and nothing else:
 * a colon alone does not make prose a URI. Trims first: a growing label
 * streams in padding-first.
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

/**
 * A list-item marker a fence can share a line with. "- ```sh" opens a fence
 * at the item's content column, not at column 0, and the matching closer
 * arrives indented to that column. Matched repeatedly so nested markers on
 * one line ("- - ```js") strip too.
 */
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;

interface OpenFence {
  marker: string;
  length: number;
  /** Column the opening run starts at, past any list-item markers. */
  indent: number;
}

/**
 * The fence `line` opens, or null.
 *
 * Container-aware for list markers, because md4c is: "- ```sh" is a code
 * fence inside the item and its closer carries the item's indentation.
 * Reading the raw line would miss that opener and then mistake the indented
 * closer for an opener of its own — leaving a fence "open" for the rest of
 * the document, which freezes the streaming anchor and turns every later
 * append into a full reparse.
 *
 * Blockquote prefixes are deliberately NOT stripped: "> ```" matches neither
 * this nor {@link matchesFenceClose}, so a quoted fence stays invisible to
 * the scan symmetrically (opener and closer both) rather than half-seen,
 * which is the same clean state as before.
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
        indent: indent + (rest.length - m[1].length - m[2].length),
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
 * Whether `line` closes `open`: a bare run of the same character, at least
 * as long as the opener's, indented no more than three columns past the
 * opener's own column. A closer less indented than that ends the list item
 * (and its code block) just as surely, so it counts too. List markers are
 * not stripped here — a "- ```" line INSIDE a fenced block is content, not
 * a closer.
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

/** A line with nothing but spaces, tabs, and a possible CRLF remnant. */
const BLANK_LINE = /^[ \t\r]*$/;

/**
 * A final, still-unterminated line matching one of these would flip the
 * document structure the moment it parses (setext heading, empty heading,
 * empty quote, empty list item, thematic break) even though the very next
 * chunk may turn it into plain prose. Ordered-list markers stop at three
 * digits so a year like "2026." stays visible as prose. Every alternative
 * allows the trailing spaces/tabs md4c allows: "Title\n= " is already a
 * setext heading to the parser, so without the `[ \t]*` the heading flashes
 * for the snapshot between the space arriving and the next content
 * character.
 */
const BARE_TAIL_LINE =
  /^ {0,3}(?:#{1,6}[ \t]*|(?:>[ \t]*)+|[-+*][ \t]+|\+|-+[ \t]*|=+[ \t]*|[*_~]+[ \t]*|\d{1,3}[.)][ \t]*)$/;

/**
 * The GFM half of the same guard, live only with `extensions.tables`: a
 * final, still-unterminated line made of nothing but table punctuation —
 * `|`, `| `, `| --`, a whole `| --- | --- |` delimiter row, a headerless
 * `---|`. md4c flips the paragraph above into a table as soon as `| -`
 * arrives, so without this the bare `|` typed under a header row paints as
 * a literal pipe on a line of its own for the snapshot or two before the
 * delimiter row absorbs it.
 *
 * What this does NOT fix: the header row itself paints as a literal-pipe
 * paragraph until its own line ends. That is CommonMark — the row is only a
 * table once a delimiter row follows it — so no tail guard can remove it;
 * `holdBackChars` is the knob for that.
 */
const BARE_TABLE_TAIL_LINE = /^ {0,3}(?:\||:?-+:?[ \t]*\|)[-:| \t\r]*$/;

/** {@link BARE_TAIL_LINE}, plus the table rows only GFM makes structural. */
function isBareTailLine(line: string, tablesOn: boolean): boolean {
  return (
    BARE_TAIL_LINE.test(line) || (tablesOn && BARE_TABLE_TAIL_LINE.test(line))
  );
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
      // The empty remainder after a trailing newline is not a line, so
      // `seedFromSettled('$$\nx\n')` must still report open math; a real
      // blank line ends the block and clears it.
      //
      // md4c's `$$…$$` spans are INLINE: they end with their block, so a
      // blank line can only leave them unclosed, never carry them on.
      // Without this reset one paragraph holding a doubled currency sign
      // ("costs $$5") leaves `inMath` true for the rest of the stream and
      // the anchor — which skips every candidate while `inMath` is set —
      // never advances again.
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
   * `partialClose` is the length of a trailing backtick run too short to
   * close the opener (0 when the tail ends anywhere else): the closer is
   * still arriving, so only the missing backticks may be appended.
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
   * Starts of the '||' runs that {@link applySpoilers} would read as
   * markers (exactly two pipes, outside code/math spans and link
   * destinations), in order. Empty unless `extensions.spoilers` is on.
   */
  spoilerMarkers: number[];
  /**
   * Parallel to {@link spoilerMarkers}: for each marker, the start of the
   * TEXT NODE it will land in — the end of the last opaque construct before
   * it ({@link inertEnd} as of that marker), which is where md4c starts a
   * fresh text node. `applySpoilers` decides per text node whether a node's
   * pipes can be matched to its source at all, so this is the span the
   * repair has to judge an escaped pipe against (see {@link ESCAPED_PIPE}).
   * Only inline constructs that make the scan opaque move it; emphasis also
   * splits a text node and does not, which errs towards the repair standing
   * down.
   */
  spoilerNodeStarts: number[];
  /**
   * End offset of the last completed opaque construct (closed code span,
   * closed math span, finished link, '<...>'). A bare-URI tail token
   * starting before this is (partly) settled inert content, not a growing
   * URI, and must not be hidden.
   */
  inertEnd: number;
  /**
   * The furthest point this pass may be RESUMED from on a longer region
   * with the same prefix, or null when there is none. See
   * {@link InlineResume}.
   */
  cut: InlineResume | null;
}

/**
 * A replayable point in an inline region: scanning `[pos, end)` of any string
 * whose first `pos` characters are the ones this scan saw reproduces the rest
 * of the scan exactly.
 *
 * WHY A RESUME POINT EXISTS AT ALL. `repairTail` runs over the whole
 * unsettled tail on every streamed append, and a paragraph that never reaches
 * a blank line never shrinks that tail: a 32 kB answer streamed in 18-char
 * deltas scans 32 kB about 1800 times. The scan is a left-to-right state
 * machine, so almost all of that is re-deriving a state it already had.
 *
 * WHY IT IS A CUT AND NOT A SNAPSHOT. Resuming needs the scan's whole state,
 * and most of that state is stacks (`emph`, open brackets) that would have to
 * be copied to be carried. A cut is only recorded where the state is EMPTY —
 * no open code span, no open math span, no open bracket, no unclosed emphasis
 * — so the three scalars below are the entire carry: the position, the
 * `inertEnd` reached so far, and the spoiler markers found so far (the one
 * output that accumulates without opening anything). That covers the shape
 * this exists for, ordinary prose, where the state is empty between every two
 * constructs, and quietly declines on the shapes where it is not (a paragraph
 * with a stray `[` in it never empties its bracket stack, and simply rescans).
 *
 * WHY A CUT IS ONLY EVER TAKEN AT THE TOP OF AN ITERATION. Every decision the
 * pass makes that depends on the string ENDING where it does — a delimiter
 * run that may still grow, a `]` that may still be followed by `(`, a `$` that
 * may still become `$$` — is made in an iteration that then ends the loop, so
 * the state ARRIVING at any iteration was produced without consulting the end
 * and stays true when more text arrives. The one exception is a `<` with no
 * `>` anywhere after it: a later append can supply that `>` and turn
 * everything between into one opaque span, so a scan that meets one stops
 * recording cuts for the rest of the region.
 */
interface InlineResume {
  /** Region offset to resume from. */
  pos: number;
  /** {@link InlineScan.inertEnd} as of `pos`. */
  inertEnd: number;
  /** {@link InlineScan.spoilerMarkers} as of `pos`. */
  spoilerMarkers: readonly number[];
  /** {@link InlineScan.spoilerNodeStarts} as of `pos`. */
  spoilerNodeStarts: readonly number[];
}

const NO_SPOILER_MARKERS: readonly number[] = [];

/**
 * Every character {@link scanInline} reacts to. Prose between two of them
 * cannot change any scan state, so the pass jumps from one to the next in a
 * single regex scan instead of stepping character by character.
 *
 * That constant used to be worth watching: the pass runs once per streamed
 * delta over the whole unsettled tail, and a paragraph that never anchors
 * never shrinks it, so on a multi-kB paragraph this scan was the dominant
 * per-append cost — more than the md4c parse next to it. It is not any more,
 * because the pass now RESUMES (see {@link InlineResume}) instead of
 * restarting: the jump table is what a resumed pass walks over the new
 * delta, and only a region that offers no resume point is scanned whole.
 */
const INLINE_SPECIAL = /[\\`$!\[\]<*_~|]/g;

/** The first {@link INLINE_SPECIAL} at or after `from`, or `s.length`. */
function nextSpecial(s: string, from: number): number {
  if (from >= s.length) {
    return s.length;
  }
  INLINE_SPECIAL.lastIndex = from;
  const m = INLINE_SPECIAL.exec(s);
  return m === null ? s.length : m.index;
}

/**
 * Handler 6's HTML flavours whose terminator is NOT a bare '>': a comment
 * ('-->'), a CDATA section (']]>'), a processing instruction ('?>') and a
 * declaration ('<!' + letter, which does end at '>' but shares their
 * two-character opener). Returns the offset just past the terminator, -1
 * when the construct is still open at end of tail (a half-arrived opener
 * like '<!', '<!-' or '<![CDA' included), or null when '<!'/'<?' here opens
 * nothing md4c recognises ('<! ', '<!5', '<!-x') and the text is literal
 * prose.
 *
 * The tag and autolink tests below both require a letter right after '<',
 * so before this every one of these shapes fell through: an unfinished
 * comment body painted as ordinary prose while it grew and then vanished
 * outright when '-->' landed — a worse flash than the one handler 6 exists
 * to prevent, because the content is deleted rather than restyled.
 *
 * Unlike a tag, none of these has a length bound. A comment or CDATA
 * section stays withheld however long it runs: its body is deleted outright
 * under `html: 'strip'` and becomes markup under 'raw', so holding it back
 * costs nothing WHEN IT TERMINATES — and when it never does, the text
 * reappears at the next blank line or at `finalize`, which is the trade this
 * makes deliberately.
 *
 * Declarations and processing instructions do NOT get that benefit of the
 * doubt, because `<!` or `<?` in front of ordinary prose is far more often a
 * stray character than a construct: `use <!important rules here` would
 * otherwise blank the rest of a streaming paragraph for as long as the
 * writer keeps typing. They stay withheld only to the end of the line they
 * opened on — see {@link openDeclaration}.
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
    // '<!' at end of tail: every continuation md4c recognises is one of the
    // constructs below, so hold it rather than paint a '<!' about to go.
    return -1;
  }
  if (c2 === '-') {
    if (s[i + 3] === undefined) {
      return -1;
    }
    if (s[i + 3] !== '-') {
      return null;
    }
    // The empty comments '<!-->' and '<!--->': the terminator overlaps the
    // opener, so a search from i+4 walks straight past it and reads the rest
    // of the paragraph as comment body (verified against md4c, which ends
    // the comment here and paints what follows).
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
    // Still arriving ('<![', '<![CDA') vs. settled prose ('<![x'). Compared
    // against a bounded prefix of CDATA rather than `s.slice(i)`: that slice
    // copies the whole rest of the tail on every '<![' in it.
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
 * -1 (keep withholding) while an unterminated declaration or PI body
 * starting at `from` may still be one, and null (paint it as prose) once it
 * cannot.
 *
 * The bound is THE END OF THE LINE. md4c's `?>`, `>` and `-->` may all sit
 * lines below their opener, but a real inline `<?php echo the thing?>` or
 * `<!ENTITY nbsp "&#160;">` is written on one line, so a line ending with no
 * terminator on it is the point where `<!`/`<?` is far likelier to be the
 * stray character it usually is. Bounding by BODY SHAPE instead — a
 * character budget, or "no second whitespace run" — re-opened the very flash
 * this handler exists to prevent: `note <?php echo the thing?> end` paints
 * `<?php echo `, then `the thing?`, and then has the whole body DELETED when
 * the `?>` lands, which is worse than never painting it. A line is the
 * smallest bound that no single-line construct can cross, and it keeps the
 * cost of a stray opener to the one line it sits on.
 */
function openDeclaration(s: string, from: number): number | null {
  // `indexOf` rather than a character loop: this runs on every '<!'/'<?' in
  // the region that has no terminator yet, and a long single-line region
  // would otherwise pay a JS loop over all of it for each one.
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
/** Characters that end an unquoted attribute value. */
const UNQUOTED_VALUE_STOP = /[\s"'=<>`]/;
/** An autolink body: a 2-32 character scheme, then anything but space/</>. */
const URI_AUTOLINK_BODY = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
/** An email autolink body, deliberately loose about the domain. */
const EMAIL_AUTOLINK_BODY = /^[^\s<>@]+@[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Offset just past the '>' when the '<' at `i` opens a complete CommonMark
 * open tag or closing tag, {@link HTML_INCOMPLETE} when more text could
 * still make it one, and -1 when nothing ever will.
 *
 * Hand-written rather than one regex because the attribute loop is exactly
 * the shape that backtracks catastrophically (`(?:\s+name(?:=value)?)*`
 * against a run of spaces with no '>' after it), and this pass runs over the
 * whole unsettled tail on every append.
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
        // The value may still close — and a '>' inside it belongs to the
        // value, not to the tag, which is why the first '>' is never the
        // answer on its own.
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
  // An autolink body holds no whitespace and no '<', so the token ends the
  // search — scanning to the next '>' instead would be O(tail) on every '<'
  // of a paragraph that has none.
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
 * Offset just past the '>' of a region md4c would read as inline raw HTML (a
 * tag) or as an autolink, {@link HTML_INCOMPLETE} while more text could
 * still make it one, and -1 when it is ordinary prose that merely contains
 * '<' and '>'.
 *
 * The scan used to jump from any '<' to the next '>' and call everything
 * between opaque. md4c does not: `a <x||y> then ||z` holds no tag, so its
 * pipes are ordinary text and the two markers inside pair with each other —
 * while the skip hid them, left `||z` looking like the only marker on the
 * line, and appended a closer that painted two pipes the source never had.
 * Comments, PIs, declarations and CDATA are decided earlier, by
 * {@link htmlSpecialEnd}; this covers what is left.
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
  // A resume carries exactly three things, because a cut is only ever taken
  // where the rest of the state is empty — see InlineResume.
  const from = resume ?? null;
  const spoilerMarkers: number[] =
    from === null ? [] : from.spoilerMarkers.slice();
  const spoilerNodeStarts: number[] =
    from === null ? [] : from.spoilerNodeStarts.slice();
  let inertEnd = from === null ? 0 : from.inertEnd;
  const n = s.length;
  // The replayable point (see InlineResume): the latest position reached with
  // an empty state. `sealed` closes cut recording for good once the pass meets
  // a construct whose reading a later append could change from behind.
  let cutPos = -1;
  let cutInert = 0;
  let cutSpoilers = 0;
  let sealed = false;
  // Set by the branches that read the string's END, and cleared per
  // iteration. It decides only whether the FINAL position may be a cut,
  // because every branch that sets it also ends the loop — the one
  // end-dependent decision that does NOT is the '<' with no '>' after it,
  // and that one sets `sealed` instead.
  let endTouched = false;
  // Every advance below either lands on a construct character or jumps to
  // the next one; ordinary prose is never stepped through.
  let i = nextSpecial(s, from === null ? 0 : from.pos);
  while (i < n) {
    // `openLink`, `htmlTrim`, `heldBracket`, `imageCuts` and `bracketStrips`
    // are deliberately not tested: every branch that sets one of them ends
    // the loop, so at the top of an iteration they are always empty.
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
    if (c === '\\') {
      // A backslash at the very end escapes a character that has not arrived:
      // what it escapes — and therefore whether the next append's '*' opens
      // emphasis — is not decided yet.
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
        // A run at the end of the string decides everything below on a length
        // that may still grow: '`x`' is a closed span, '`x``' is not, and the
        // span closing is exactly what would otherwise leave an empty state
        // that looks safe to resume from.
        if (i + r >= n) {
          endTouched = true;
        }
        if (r === open.runLen) {
          codeOpen = null;
          inertEnd = i + r;
        } else if (r < open.runLen && i + r === n) {
          // The closing run, still arriving one backtick at a time. Record
          // how much of it is here: appending a full run on top would fuse
          // into `runLen + r` backticks, a run CommonMark can never use as
          // a closer, so the span would stay literal with `runLen` visible
          // backticks that are nowhere in the source.
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
            // A backslash before a line ending is not an escape (CommonMark
            // makes it a hard break, and a destination still cannot span the
            // break), so it must not swallow the newline the check below
            // depends on: '[x](/u\' + '\n' + 'more prose' would otherwise
            // run the destination into the next line and append a ')' there.
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
            // A CommonMark link destination cannot contain a line break —
            // but the whitespace before the closing ')' may, so '[a](/u "t"
            // \n)' is still a link. Skip the run and see which this is: a
            // ')' (or end of tail, where one may yet arrive) keeps the
            // construct alive, anything else kills it. A break inside a
            // quoted TITLE is legal and never reaches here — the quote
            // branch below consumes it, and only a quote that really opens a
            // title (one preceded by whitespace) enters that branch.
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
            // Only a quote PRECEDED BY WHITESPACE opens a title: CommonMark
            // reads `[a](/u "t")` as destination + title, and
            // `[a](/don't-panic)` as one destination with an apostrophe in
            // it. Entering the branch on any quote let an apostrophe inside
            // a URL swallow the line ending below, so the construct ran on
            // into the next line and a `')` closer was appended there —
            // characters painted on a LATER line that the source never had.
            // (`j > i + 2` is implied: `s[i + 2]` is the '(' this scan
            // started past, which is not whitespace.)
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
          // This '](' can never close: md4c keeps the whole run literal and
          // no later append changes that. Leave it exactly as it arrived —
          // the label's emphasis included — and keep scanning the rest as
          // ordinary text. Treating it as an open link instead appended a
          // virtual ')' at end of TAIL, which lands inside a real text node
          // on a LATER line and paints a character the source never had.
          i = nextSpecial(s, i + 1);
          continue;
        }
        // Emphasis opened inside the bracket text can no longer be closed
        // once the destination starts; forget it rather than close across
        // the link boundary.
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
        // A '<!' or '<?' that `htmlSpecialEnd` declined is still waiting on
        // a terminator that may sit lines below (it declined because the
        // line ended, not because the construct is impossible), so its
        // reading stays end-dependent and it seals like the branch below.
        s[i + 1] !== '!' &&
        s[i + 1] !== '?' &&
        // With no '>' yet the trims below may still want to withhold a
        // half-arrived tag or autolink; that decision reads the end.
        s.indexOf('>', i + 1) !== -1
      ) {
        // Prose that merely holds a '<' and a '>': no continuation can make
        // raw HTML of it, so it is scanned like any other text — and, unlike
        // the branch below, the reading is final, so cuts keep being
        // recorded.
        i = nextSpecial(s, i + 1);
        continue;
      }
      // This '<' may still open raw HTML: a tag or autolink whose '>' has not
      // arrived, or an attribute value whose quote has not closed. That is a
      // reading a later append can overturn wholesale by supplying the rest
      // and making this whole stretch one opaque span. Unlike every other
      // end-dependent decision in this pass, that one does not end the loop,
      // so it cannot be handled by `endTouched`: no position past it is
      // replayable, and cut recording stops for the rest of the region.
      sealed = true;
      // Both tests below need '/' or a letter right after '<'. Checking that
      // first keeps the O(tail) `slice` off prose full of '<' comparisons,
      // where it would make the pass quadratic.
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
      // Handler 4b's evidence. `applySpoilers` pairs runs of EXACTLY two
      // pipes (src/engine/extensions/spoilers.ts): a run of one, or of three
      // or more, is prose. Recording each marker's start is enough —
      // repairTail pairs them off and closes the odd one out.
      const r = runLength(s, i, '|');
      if (r === 2) {
        spoilerMarkers.push(i);
        spoilerNodeStarts.push(inertEnd);
      }
      // A run that touches the end may still grow: '||' is a marker, '|||' is
      // prose.
      if (i + r >= n) {
        endTouched = true;
      }
      i += r;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const r = runLength(s, i, c);
      // A run at the end of the string is doubly unsettled: it may still
      // grow, and its right flank (`next` below, empty here) is whatever
      // arrives next.
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
    // Nothing here reacted to this character — but a '$' or a '!' at the very
    // end is inert only because the character that would pair with it ('$',
    // '[') has not arrived.
    if (i + 1 >= n) {
      endTouched = true;
    }
    i = nextSpecial(s, i + 1);
  }
  // The end of the region is itself a cut when the pass got there with an
  // empty state and the last thing it did was not end-dependent. This is the
  // case that matters most: it is what stops a settled multi-kB paragraph
  // from being re-scanned in full for the sake of the 18 characters that just
  // arrived.
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
 * A line that OPENS a new leaf block, judged on the line's content past any
 * blockquote markers: a list item, an ATX heading, a fence, or a thematic
 * break. Nothing opened on an earlier line can bind into one of these.
 */
const LEAF_BLOCK_START =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|`{3,}|~{3,}|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/**
 * A line that IS a whole leaf block, so the next line necessarily starts a
 * new one: an ATX heading, a thematic break, or a setext underline. (A
 * paragraph, list-item or blockquote line is not — the line after it may
 * continue it.)
 */
const SELF_CONTAINED_LINE =
  /^ {0,3}(?:#{1,6}(?:[ \t].*)?|=+[ \t]*|-+[ \t]*|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * A line opening a CommonMark HTML block, conditions 1-6: `<script`/`<pre`/
 * `<style`/`<textarea`, `<!--`, `<?`, `<!` + letter, `<![CDATA[`, and an
 * open or closing tag from the block-element list. Condition 7 (any complete
 * tag alone on its line) is deliberately absent: it cannot interrupt a
 * paragraph, and after a blank line the region has already restarted.
 *
 * Without this an emphasis opener in the paragraph above `<div>` had its
 * closer appended INSIDE the HTML block — invisible under the default
 * `html: 'strip'` (md4c drops the block whole) and a stray character painted
 * into the markup under `html: 'raw'`.
 */
const HTML_BLOCK_START =
  /^ {0,3}<(?:\?|!(?:--|\[CDATA\[|[A-Za-z])|\/?(?:script|pre|style|textarea|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>]|\/>|$))/i;

/**
 * An escaped pipe. `applySpoilers` gives up on a whole TEXT NODE that holds
 * one (`markersIn` returns null for it, because `\||` is one escaped pipe
 * beside a real one and pairing across that would put the spoiler's span
 * inside the construct the author wrote). A closer appended for markers the
 * transform then refuses to pair paints two pipes that are not in the
 * source, so the repair gives up on the same evidence — one snapshot of a
 * body in the clear beats a character the reader can select and copy.
 *
 * Tested over the same span the transform judges, not the whole region:
 * from the start of the text node holding the opener
 * ({@link InlineScan.spoilerNodeStarts}) to the end, which is where the
 * closer lands. A region-wide test stood the repair down in strictly more
 * places than the transform does — `a \`x \| y\` and ||secret` has its
 * escaped pipe inside a code span, so the transform builds the spoiler
 * happily while the repair left the body in the clear.
 */
const ESCAPED_PIPE = /\\\|/;

/** A GFM table row or headerless delimiter row; each row is its own block. */
const TABLE_ROW_LINE = /^ {0,3}(?:\||:?-+:?[ \t]*\|)/;

/**
 * Start of the LAST cell on the line holding the end of `region` when that
 * line is a GFM table row, and -1 otherwise (tables off, not a row, or no
 * unescaped `|` on it).
 *
 * GFM splits a row into cells before any inline parsing runs, so the cells of
 * one row are separate inline contexts even though they share a line. A
 * virtual closer is always appended at the END of the tail — inside the last
 * cell — so an opener in an earlier cell cannot be closed by it: the closer
 * would bind a delimiter in a cell that has none, eating a real character
 * there and painting one that is not in the source (`| a _b | c _d |`). The
 * region itself stays line-granular; the openers behind this offset simply
 * get no closer and stay literal, the same trade `leafBlockStart` makes at a
 * block boundary.
 *
 * Only `\|` escapes a pipe in a row — code spans, math and autolinks do not
 * protect one, because cell splitting happens first. And only a REAL table
 * counts (see {@link insideTable}): a lone line full of pipes with no
 * delimiter row under it is still a paragraph, where emphasis binds right
 * across them.
 *
 * `hasOpenerBefore` is asked before the table test, which is the expensive
 * half: a row with nothing to filter — the overwhelming majority — pays only
 * for the backwards scan of its own last line.
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
  // `lastIndexOf` rather than a character loop: this runs on every repair,
  // and a pipe-free 100 kB paragraph would otherwise pay a JS loop over all
  // of it just to learn there is no row here.
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

/**
 * A GFM delimiter row — the line under a table's header — including one
 * still arriving ('| -', '| --- | :-'). Requires a '-' and a '|', which is
 * what separates it from a thematic break and from prose.
 */
const DELIMITER_ROW =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-*:?[ \t]*)*\|?[ \t]*$/;

/** How far up {@link tableBodyRow} looks for a delimiter row. */
const TABLE_LOOKBACK_ROWS = 1024;

/**
 * A line that may be a table HEADER row whose delimiter row has not arrived
 * yet: it opens with a single pipe and holds another one, which is how a row
 * is written and is not how a spoiler is. A spoiler opening a line starts
 * with the doubled pipe the negative lookahead rejects, so `||secret` stays
 * repairable while `| a || c |` — a header row with an empty middle cell —
 * keeps its pipes instead of having the cell hidden behind a virtual closer
 * for the snapshots before its delimiter row lands.
 */
const POSSIBLE_HEADER_ROW = /^ {0,3}\|(?!\|)[^|]*\|/;

function isDelimiterRow(line: string): boolean {
  return (
    line.includes('|') && line.includes('-') && DELIMITER_ROW.test(line)
  );
}

/**
 * Line bounds (start, end-exclusive, terminator excluded) around `pos`.
 * `pos` may be the index of a line terminator, which reads as the end of the
 * line it terminates — that is how {@link previousLine} walks upwards.
 */
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

/** The line above the one starting at `lineStart`, or null at the top. */
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
 * Whether `pos` sits inside a REAL GFM table. `|` is structural syntax
 * there — an unescaped '||' splits cells before `applySpoilers` ever runs,
 * which is why that transform excludes table cells outright — so the
 * spoiler repair must leave those pipes alone rather than append a closer
 * that would grow the row a phantom cell.
 *
 * Membership is decided the way the parse decides it: a table needs a
 * delimiter row under a header line. Testing "the line starts with a pipe"
 * instead stood the repair down on any paragraph or list item that merely
 * OPENS with one — '||secret', '  ||secret', '- ||secret' — which is the
 * commonest way to write a spoiler and the one shape where leaking the body
 * matters most.
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
 * {@link insideTable}, plus a header row STILL ARRIVING — the one shape
 * where membership is undecidable, because the delimiter row that would
 * settle it cannot have landed yet.
 *
 * Only the spoiler repair asks this. A wrong "not a table" there appends a
 * virtual `||` inside a row, which hides a cell and paints a pipe the source
 * never had (`| a || c |` → `| a || c ||`) for every snapshot until the
 * delimiter row arrives. The emphasis repair's cell rule
 * ({@link lastCellStart}) has no such failure — a wrong answer there only
 * decides whether an opener in an earlier cell gets a closer at all — so it
 * keeps the strict structural test and lets emphasis bind across the pipes
 * of a line that is still, for now, a paragraph.
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
 * Whether the line starting at `lineStart` is a BODY row — one under a
 * delimiter row that already has a header line above it. Walks up, stopping
 * at anything that would have ended the table before this line: a blank
 * line, or a line opening a block of its own.
 *
 * Split out of {@link insideTable} because a line's own shape is not
 * evidence here: `| --- |` reads as a delimiter row wherever it sits, and
 * asking that question of the line ITSELF would call a delimiter row still
 * arriving under a header a table before GFM does (the cell counts have to
 * match, so the row is only a table once its line ends).
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
      // Every line for this many rows was pipe-bearing and opened no block of
      // its own, and no delimiter row turned up. The walk has to stop
      // somewhere — it runs per repair, and an unbounded one would pay for a
      // table's whole height on every append — and it stops on "not a table":
      // a paragraph of pipe-bearing lines that reads as a table suppresses
      // the spoiler repair, and the body of a spoiler streaming in the clear
      // is the failure this whole predicate exists to prevent. A table taller
      // than this pays a virtual closer inside an empty cell for one
      // snapshot instead, which corrects itself on the next append.
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
 * Start of the trailing `*`/`_`/`~` run in `s` when that run is preceded by
 * whitespace or by the start of the string, and -1 otherwise — handler 7's
 * "a delimiter run that neither opened nor closed anything" test.
 *
 * Scanned backwards rather than matched with `/(?:^|\s)([*_~]+)$/`, and that
 * is the difference between O(run) and O(tail): the regex is anchored at the
 * END only, so V8 walks the whole string looking for a place to start it, and
 * on a 32 kB paragraph that single line was ~56 us — MOST of the per-append
 * repair cost on a stream that never anchors. Identical semantics: the
 * greedy `+` inside the group can only match the maximal trailing run (a
 * shorter suffix of it is preceded by another run character, which is not
 * `\s`), so finding that run and testing the one character before it decides
 * the same way. `WS` is `/\s/`, the same class the regex used, so the
 * Unicode spaces it accepts are still accepted.
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

/** Blockquote markers opening a line, e.g. "> " or ">> ". */
const QUOTE_PREFIX = /^ {0,3}(?:>[ \t]?)+/;

/**
 * What {@link leafBlockStart}'s single pass over the tail's lines learns.
 *
 * `lastLineStart` is a by-product the caller would otherwise have to pay for
 * twice: handler 7 needs the start of the tail's final line, and asking for
 * it with `lastIndexOf('\n')` costs a full backwards scan of the string — on
 * a multi-kB paragraph with no line break in it at all (the unanchored case),
 * two of them, one per line terminator. This pass has already walked every
 * break with a forward regex, which is an order of magnitude cheaper, so it
 * hands the answer over instead.
 */
interface LeafBlockScan {
  /** Where the last leaf block starts — the value the region is cut at. */
  start: number;
  /** Start of the tail's final line (== `from` when it holds no break). */
  lastLineStart: number;
}

/**
 * Where the last leaf block inside `tail.slice(from)` starts — the point
 * past which inline scope cannot reach backwards.
 *
 * The blank-line split above is not enough: a list item, heading,
 * blockquote, thematic break or table row also ends the previous block's
 * inline scope, and an opener left behind in one of them can never be
 * closed by appending at the end of the tail. Appending anyway paints
 * delimiters into a LATER block and swallows real ones there — "- a _b\n- c
 * _d" would close item 1's `_` with a `_` glued to item 2, turning item 2
 * italic and deleting the `_` the source actually has. The repair therefore
 * restarts at the last block-opening line and leaves earlier lines exactly
 * as they arrived (an unclosed delimiter there stays literal, which is a
 * flash, not a lie).
 *
 * A trailing line handler 7 is about to suppress is not a boundary: it is
 * about to leave the parse input, so "**a\n-" must still close its `**`.
 * The returned offset includes the boundary line's own terminator so that
 * suppression can still delete the whole line.
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
  // No previous line yet: -1 matches no real depth, so the first line after
  // `from` is never a boundary by depth alone.
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
      // Entering or leaving a blockquote, a quote-internal blank line, a
      // finished single-line block, or a line that opens one: all four end
      // the previous block. Consecutive `>` lines of the same depth do NOT
      // — they are one paragraph inside the quote, where emphasis binds
      // across the line break exactly as in an unquoted one.
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
 * flash mid-stream. Pure and stateless: same arguments, same result, and no
 * state kept between calls.
 *
 * `carry` is the one qualification, and it is a qualification about SPEED,
 * not about the answer: hand back the {@link RepairScan} the previous call
 * on a shorter prefix of this same tail returned and the inline pass resumes
 * where it left off instead of re-deriving its state from the start of the
 * tail — which is what a stream that never anchors would otherwise do on
 * every append, forever. Every result below is identical either way (the
 * fuzz case in repair.test.ts pins that across random documents, delta sizes
 * and option sets); pass nothing and this is exactly the function it was.
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
 *      gets a virtual closing run so the body arrives hidden instead of in
 *      the clear, appending only the pipe a half-arrived closer is missing;
 *      a content-empty opener is suppressed, and pipes on a table row are
 *      left alone (there '|' is cell syntax);
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
      // No inline pass ran, so there is nothing to carry — and returning the
      // state that came IN would describe a scan of a different region.
      return { text: tail + '$$', appended: '$$', touched, scan: null };
    }
    cursor = close + 2;
  }

  const fences = scanFences(tail, seed.openFence, cursor);
  if (fences.open) {
    // Indented to the opener's own column: a fence opened inside a list
    // item ("- ```sh") is closed by a run at the item's content column, and
    // one appended at column 0 would end the item instead, leaving an empty
    // top-level fence behind.
    const closer =
      ' '.repeat(fences.open.indent) +
      fences.open.marker.repeat(fences.open.length);
    const appended = (tail.endsWith('\n') ? '' : '\n') + closer;
    touched.push({ start: fences.open.lineStart, end: tail.length });
    return { text: tail + appended, appended, touched, scan: null };
  }

  // The inline region is the last block of the tail that sits outside every
  // fenced region: earlier blocks — split off by a blank line above, or by a
  // leaf-block boundary in `leafBlockStart` below — are finished, and their
  // inline state cannot be repaired by appending at the end of the tail.
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
  /**
   * A region offset mapped through the bracket strips, by binary search
   * over the ascending strip list. A linear count here made the whole
   * repair O(strips x region) — a 32 KB tail full of unmatched '[' cost
   * 16 ms per delta.
   */
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
    // One pass over the surviving slices, joined once. Rebuilding `edited`
    // per strip was quadratic in the strip count, and the strip count grows
    // with the tail on the shape that produces it (prose full of unmatched
    // '[').
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
      // Only the backticks the closing run is still missing: "x ``y`" needs
      // one more, not two (see InlineScan.partialClose).
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
  // Handler 4b: an unpaired '||' (only when `extensions.spoilers`). The
  // spoiler transform runs AFTER the parse and builds nothing at all until
  // it sees a closing run, so without a virtual closer the body of a
  // spoiler renders in the clear for every snapshot until its own '||'
  // lands — the one construct whose entire job is to not be read.
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
      // The text the closer would pair across: the opener's own text node,
      // through to the end of the region where the closer lands.
      const nodeStart = Math.min(nodeStarts[nodeStarts.length - 1], pos);
      if (shift(pos + 2) >= edited.length) {
        // Content-empty opener. Closing it would fuse into '||||', a run of
        // four the transform never reads as markers at all, leaving both
        // pairs painted as literal pipes. Suppress the run instead, exactly
        // as a content-empty code or math opener is suppressed above.
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

  // Cells of one GFM row are separate inline contexts, and every closer is
  // appended in the last one: an opener left in an earlier cell keeps no
  // closer at all (see {@link lastCellStart}). Filtered here, after the
  // content-empty suppressions, so those still see the openers they measure
  // against.
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
      //
      // `edited === region` means no handler above cut, stripped or deleted
      // anything, so the region's own last line IS this string's last line and
      // the scan `leafBlockStart` already did answers for free. Only an edited
      // tail pays for the two backwards scans, and an edited tail is by
      // definition one where something was found and the repair is not the
      // per-append steady state.
      const nl =
        edited === region
          ? leaf.lastLineStart - regionStart - 1
          : Math.max(edited.lastIndexOf('\n'), edited.lastIndexOf('\r'));
      const line = edited.slice(nl + 1);
      // A '||' still standing on that line may be a COMPLETED spoiler's
      // closer: this guard runs after the pairing above, so deleting the
      // line would take the closer with it and expose the body as prose for
      // that snapshot ('hint: ||one' + newline + '||'). The test cannot tell
      // that from table punctuation still arriving ('| a | b |' + newline +
      // '|| '), so it errs towards keeping the line: pipes that stay a
      // snapshot too long beat a hidden body in the clear.
      const spoilerCloser =
        options.extensions.spoilers && line.includes('||');
      // Only the TABLE half of the guard needs a line above it. Its whole
      // job is the bare '|' typed under a header row, where the delimiter
      // row is about to absorb it; with nothing above, no table can form and
      // '|' is a paragraph md4c paints — deleting it emptied the entire
      // parse input for that snapshot, blanking the document.
      const above = previousLine(tail, leaf.lastLineStart);
      const tableLine =
        options.extensions.tables &&
        above !== null &&
        !BLANK_LINE.test(tail.slice(above.start, above.end)) &&
        BARE_TABLE_TAIL_LINE.test(line) &&
        // …and a genuine BODY row made of nothing but table punctuation
        // ('| - | - |', '| :- | -: |') is content, not a structure flip: the
        // table above it already exists, so md4c paints the row and
        // withholding it made a real row vanish until its line terminated.
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
    const trimmed = edited.replace(/[ \t\r]+$/, '');
    touched.push({
      start: regionStart + trimmed.length,
      end: regionStart + edited.length,
    });
    edited = trimmed;
  }
  if (!contentOwned && /(?:^|[^\\])(?:\\\\)*\\$/.test(edited)) {
    // An ODD trailing backslash escapes whatever is appended after it, so
    // every closer here is either eaten (the construct stays open anyway) or
    // painted as a literal marker the source never had — 'a *b\\' + '*'
    // renders 'a *b*' with BOTH stars visible. Nothing is appended instead.
    // An open code span, math span or fence is exempt (`contentOwned`):
    // backslash is not an escape inside those, so their closer still closes.
    opens.length = 0;
  }
  // A LINE ENDING cannot be trimmed the same way — deleting it would join two
  // lines that the source keeps apart — so a closer that would land after one
  // is dropped instead. It could not bind there (a delimiter run preceded by
  // whitespace is not right-flanking), so appending it painted a marker the
  // source never had ON TOP of the opener that was going to paint anyway:
  // 'a *b' + '\n' would show two literal stars where the source has one.
  while (
    opens.length > 0 &&
    /[*_~]/.test(opens[0].closer[0]) &&
    (edited === '' || /\s$/.test(edited))
  ) {
    opens.shift();
  }

  if (spoilerOpen !== null && opens[0] === spoilerOpen) {
    // Closers are emitted in `opens` order, so the spoiler's goes first —
    // right against `edited` — only when nothing opened after it. Then a
    // closing run already half here fuses with it: '||secret|' + '||' is a
    // run of three, and the transform never reads three pipes as a marker,
    // the same trap a partial backtick closer springs. Append only what is
    // missing. (With an inner opener between them the two runs cannot
    // touch, so the full '||' is right and this branch is skipped.)
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

/**
 * Four characters of `tail[0, length)` mixed into one number: enough that
 * handing back state from an unrelated document of the same length is caught
 * in practice, cheap enough to compute on every append, and explicitly NOT a
 * proof that the two strings share a prefix (see {@link RepairScan}). The
 * caller's own bookkeeping is what makes the reuse sound.
 */
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

/**
 * The extension flags {@link scanInline} and the region derivation read,
 * packed so a resolved-options change invalidates a carried scan instead of
 * replaying under rules it was not made with.
 */
function scanFlags(options: ResolvedEngineOptions): number {
  const ext = options.extensions;
  return (
    (ext.math ? 1 : 0) |
    (ext.strikethrough ? 2 : 0) |
    (ext.spoilers ? 4 : 0) |
    (ext.tables ? 8 : 0)
  );
}

/**
 * The resume point a carried scan offers for THIS tail, or null when it
 * cannot be trusted for it. See {@link RepairScan} for what these checks do
 * and do not prove.
 */
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
