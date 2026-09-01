import type { SourceSpan } from '../document/span';
import type { ResolvedEngineOptions } from '../engine/options';

export interface RepairSeed {
  /**
   * Fence open at the settled/unsettled boundary: the fence character
   * ('`' or '~') and the length of its opening run.
   */
  openFence: { marker: string; length: number } | null;
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
   * A non-URI-like label keeps the default treatment (virtual close /
   * bracket strip), as do task boxes `[x]`, escaped `\[`, and brackets
   * inside code spans.
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
// `fhir:`, `fhir://Obs`, `https://x`.
const URI_LIKE_LABEL_RE = /^[a-z][a-z0-9+.-]*:[^\s]*$/i;

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
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A final, still-unterminated line matching one of these would flip the
 * document structure the moment it parses (setext heading, empty heading,
 * empty quote, empty list item, thematic break) even though the very next
 * chunk may turn it into plain prose. Ordered-list markers stop at three
 * digits so a year like "2026." stays visible as prose.
 */
const BARE_TAIL_LINE =
  /^ {0,3}(?:#{1,6}[ \t]*|(?:>[ \t]*)+|[-+*][ \t]+|\+|-+|=+|[*_~]+|\d{1,3}[.)][ \t]*)$/;

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
  let fence = seed.openFence
    ? { marker: seed.openFence.marker, length: seed.openFence.length }
    : null;
  let inMath = seed.inMath;
  let lineStart = 0;
  const settled = text;
  for (;;) {
    const nl = settled.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? settled.length : nl;
    const line = settled.slice(lineStart, lineEnd);
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.marker && m[1].length >= fence.length) {
        fence = null;
      }
    } else if (inMath) {
      if (countDollarPairs(line) % 2 === 1) {
        inMath = false;
      }
    } else {
      const m = FENCE_OPEN.exec(line);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { marker: m[1][0], length: m[1].length };
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
  open: { marker: string; length: number; lineStart: number } | null;
  /** Offset just past the last fence-closing line (== `from` if none). */
  lastCloseEnd: number;
}

function scanFences(
  text: string,
  seedFence: RepairSeed['openFence'],
  from: number,
): FenceScan {
  let open = seedFence
    ? { marker: seedFence.marker, length: seedFence.length, lineStart: from }
    : null;
  let lastCloseEnd = from;
  let lineStart = from;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    if (open) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === open.marker && m[1].length >= open.length) {
        open = null;
        lastCloseEnd = nl === -1 ? text.length : nl + 1;
      }
    } else {
      const m = FENCE_OPEN.exec(line);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { marker: m[1][0], length: m[1].length, lineStart };
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
  codeOpen: { pos: number; runLen: number } | null;
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
   * End offset of the last completed opaque construct (closed code span,
   * closed math span, finished link, '<...>'). A bare-URI tail token
   * starting before this is (partly) settled inert content, not a growing
   * URI, and must not be hidden.
   */
  inertEnd: number;
}

/**
 * One left-to-right pass over the unsettled inline region. Code spans win
 * over everything (their content is inert), link destinations are opaque,
 * `<...>` regions are opaque, and emphasis uses conservative flanking so
 * intraword `*`/`_` (hello*world, snake_case) never registers as open.
 */
function scanInline(s: string, options: ResolvedEngineOptions): InlineScan {
  const strikeOn = options.extensions.strikethrough;
  const mathOn = options.extensions.math;
  const emph: EmphOpen[] = [];
  const brackets: { image: boolean; pos: number }[] = [];
  let codeOpen: InlineScan['codeOpen'] = null;
  let mathOpen: InlineScan['mathOpen'] = null;
  let openLink: InlineScan['openLink'] = null;
  const imageCuts: number[] = [];
  const bracketStrips: number[] = [];
  let htmlTrim: number | null = null;
  let heldBracket: InlineScan['heldBracket'] = null;
  let inertEnd = 0;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (codeOpen) {
      if (c === '`') {
        const r = runLength(s, i, '`');
        if (r === codeOpen.runLen) {
          codeOpen = null;
          inertEnd = i + r;
        }
        i += r;
      } else {
        i++;
      }
      continue;
    }
    if (mathOpen) {
      if (c === '$' && s[i + 1] === '$') {
        mathOpen = null;
        inertEnd = i + 2;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === '`') {
      codeOpen = { pos: i, runLen: runLength(s, i, '`') };
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
        // Emphasis opened inside the bracket text can no longer be closed
        // once the destination starts; forget it rather than close across
        // the link boundary.
        while (emph.length && emph[emph.length - 1].pos > b.pos) {
          emph.pop();
        }
        let j = i + 2;
        let depth = 1;
        let quote: string | null = null;
        while (j < n) {
          const d = s[j];
          if (d === '\\') {
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
          if (d === '"' || d === "'") {
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
        i++;
      }
      continue;
    }
    if (c === '<') {
      const gt = s.indexOf('>', i + 1);
      if (gt !== -1) {
        i = gt + 1;
        inertEnd = i;
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
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const r = runLength(s, i, c);
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
    i++;
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
    inertEnd,
  };
}

/**
 * Repairs the unsettled tail before parsing so incomplete constructs never
 * flash mid-stream. Pure and stateless: same input, same output.
 *
 * Handler precedence (each guarded):
 *   0. a lone high surrogate at the cut (a split pair) is dropped first;
 *   1. open fence (seeded or tail-opened): close virtually, nothing else —
 *      no inline repairs inside code;
 *   2. inline code backticks: balance only an odd run open at tail end,
 *      and everything inside a code span is inert for later handlers;
 *   3. emphasis/strong/strike closers, half-complete closers completed,
 *      content-empty openers suppressed instead of closed;
 *   4. display math (only when the math extension is on);
 *   5. links closed virtually / lone '[' stripped / incomplete images
 *      dropped from display — with `repair.hideUriLikeLabels`, an
 *      unfinished trailing link with a URI-like label is dropped from
 *      display entirely instead;
 *   6. trailing partial HTML tag or autolink trimmed, and a growing bare
 *      URI of a `repair.hideBareUriSchemes` scheme dropped the same way;
 *   7. structure-flip guard: a bare, still-unterminated final line that
 *      would flip block structure is suppressed from the parse input.
 */
export function repairTail(
  tail: string,
  seed: RepairSeed,
  options: ResolvedEngineOptions,
  repair?: RepairOptions,
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
      return { text: tail + '$$', appended: '$$', touched };
    }
    cursor = close + 2;
  }

  const fences = scanFences(tail, seed.openFence, cursor);
  if (fences.open) {
    const closer = fences.open.marker.repeat(fences.open.length);
    const appended = (tail.endsWith('\n') ? '' : '\n') + closer;
    touched.push({ start: fences.open.lineStart, end: tail.length });
    return { text: tail + appended, appended, touched };
  }

  // The inline region is the last blank-line-separated segment of the tail
  // that sits outside every fenced region: earlier segments are complete
  // paragraphs whose inline state cannot be repaired by appending.
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
  const region = tail.slice(regionStart);
  const scan = scanInline(region, options);

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
  const stripsDesc = scan.bracketStrips.filter(alive).sort((a, b) => b - a);
  const stripsAsc = [...stripsDesc].reverse();
  const shift = (pos: number) =>
    pos - stripsAsc.filter((p) => p < pos).length;

  let edited = cutAt !== null ? region.slice(0, cutAt) : region;
  if (cutAt !== null) {
    touched.push({
      start: regionStart + cutAt,
      end: regionStart + region.length,
    });
  }
  for (const p of stripsDesc) {
    edited = edited.slice(0, p) + edited.slice(p + 1);
    touched.push({ start: regionStart + p, end: regionStart + p + 1 });
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
      opens.push({ pos: codeOpen.pos, closer: '`'.repeat(codeOpen.runLen) });
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
  // Where `edited` will end once the code/math run deletes above are
  // applied: a content-empty code/math run always occupies a suffix of the
  // region (its whole tail belongs to the span), so the emphasis check
  // below must measure against the post-delete end or an opener glued to
  // such a run would read as contentful.
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

  // When an open code span or math span owns the rest of the tail, its
  // content is literal — the text guards below must not touch it.
  const contentOwned = opens.some(
    (o) => o.closer[0] === '`' || o.closer === '$$',
  );
  if (!contentOwned) {
    const runChars = options.extensions.strikethrough
      ? '[\\*_~]+'
      : '[\\*_]+';
    const m = new RegExp(`(?:^|\\s)(${runChars})$`).exec(edited);
    if (m) {
      // A trailing delimiter run that neither opened nor closed anything:
      // it would flash as literal markers, then become an opener. Suppress.
      const start = edited.length - m[1].length;
      touched.push({
        start: regionStart + start,
        end: regionStart + edited.length,
      });
      edited = edited.slice(0, start);
    }
    if (!edited.endsWith('\n')) {
      // '\r' terminates a line too (bare CR, or CRLF split at the cut).
      const nl = Math.max(edited.lastIndexOf('\n'), edited.lastIndexOf('\r'));
      const line = edited.slice(nl + 1);
      if (line !== '' && BARE_TAIL_LINE.test(line)) {
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

  const appended = opens.map((o) => o.closer).join('');
  for (const o of opens) {
    touched.push({ start: regionStart + o.pos, end: tail.length });
  }
  return {
    text: tail.slice(0, regionStart) + edited + appended,
    appended,
    touched,
  };
}
