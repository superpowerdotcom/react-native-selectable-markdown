import type { Block, ParsedDocument } from '../document/nodes';
import { visit } from '../document/visit';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions, ResolvedEngineOptions } from '../engine/options';
import { resolveOptions } from '../engine/options';
import { retreatToStreamBoundary } from './clusters';
import { trimTrailingPlaceholders } from './placeholders';
import type { RepairOptions, RepairSeed } from './repair';
import type { RepairScan } from './repair';
import { continueSeed, repairTail } from './repair';
import { shiftSpans } from './shiftSpans';
import type { Smoother, SmootherContext } from './smoothing';
import { LINK_SNAP_WINDOW, snapPastLinkDestination } from './smoothing';

export type SessionPhase = 'streaming' | 'settled';

export interface SessionSnapshot {
  document: ParsedDocument;
  /** End offset of the last block boundary that can no longer change. */
  settledUntil: number;
  phase: SessionPhase;
  revision: number;
}

/**
 * Schedules the coalesced flush for `appendBuffered`. Called at most once per
 * pending batch (the session never double-schedules); must return a cancel
 * function, which the session invokes when the batch is drained early by
 * `append`/`flushBuffered`/`replace`/`finalize`.
 */
export type BufferScheduler = (flush: () => void) => () => void;

/**
 * Schedules the idle drain that flushes held-back characters after `ms` of
 * appendBuffered silence. Same cancel contract as `BufferScheduler`.
 */
export type IdleScheduler = (flush: () => void, ms: number) => () => void;

export interface StreamSessionInit {
  engine?: Engine;
  options?: EngineOptions;
  /**
   * Flush scheduler for `appendBuffered`. Default: one animation frame where
   * `requestAnimationFrame` exists, else `setTimeout(flush, 16)`. Injectable
   * so tests (and hosts with their own frame source) control flush timing.
   */
  bufferScheduler?: BufferScheduler;
  /**
   * Characters withheld from the end of every scheduled flush (default 0),
   * so a half-typed construct ("**bo") sits in the pending buffer instead of
   * rendering and being repaired a frame later. Never cuts inside a visible
   * glyph: the boundary moves down to the nearest cluster boundary (see
   * `retreatToClusterBoundary`), so the whole cluster stays pending.
   */
  holdBackChars?: number;
  /**
   * How long (ms, default 250) held-back characters may sit with no new
   * `appendBuffered` before they are flushed anyway — a stalled stream must
   * not strand its tail behind `holdBackChars`.
   */
  holdIdleMs?: number;
  /** Idle-drain scheduler (default `setTimeout`-based). Injectable for tests. */
  idleScheduler?: IdleScheduler;
  /**
   * Release policy for scheduled flushes ("smoothing", e.g. a typewriter
   * reveal — see `createSmoother`). Given the releasable pending text
   * (holdback excluded) and a `SmootherContext` — `{ now, pendingLength,
   * sourceLength }`, with `now` read from this init's clock — it returns
   * how many UTF-16 units to release this flush; the session clamps the
   * answer, keeps the cut on a cluster boundary, and keeps a flush
   * scheduled while releasable text remains, so the drain continues at the
   * scheduler's cadence with no further input. Only scheduled flushes are
   * smoothed: every synchronous drain
   * (`append`/`flushBuffered`/`replace`/`finalize`) still releases
   * everything immediately — smoothing is presentation pacing and can never
   * reorder or strand text. Whenever the buffer empties outside a smoothed
   * flush (a synchronous drain, the idle drain, a link snap), the session
   * makes one zero-offer bookkeeping call — empty releasable, pendingLength
   * 0 — so a stateful policy learns the release happened; see `Smoother`.
   * Stateful smoothers (like `createSmoother`'s) must not be shared between
   * sessions.
   */
  smoother?: Smoother;
  /**
   * Optional display repairs (see {@link RepairOptions}) threaded into
   * every streaming tail repair: hiding an unfinished link whose label is
   * itself a URI, hiding a growing bare URI of a listed scheme. Streaming
   * display only — `finalize`'s clean reparse runs repair-free by design,
   * so nothing is ever hidden from the settled document. With
   * `hideUriLikeLabels` set, a smoothed reveal also snaps budget-free from
   * the link's `[` (not just its `]`) past a completed destination — the
   * two describe the same "reader never sees the label" pipeline and must
   * track each other.
   */
  repair?: RepairOptions;
  /**
   * Clock (ms) behind the `SmootherContext.now` handed to the smoother at
   * each scheduled flush. Injectable for tests — mirrors
   * `SmootherOptions.now`; default `Date.now`.
   */
  now?: () => number;
}

const CLEAN_SEED: RepairSeed = { openFence: null, inMath: false };

/**
 * How many times the retry delay for a refused drain may double. Four steps
 * is 16 idle delays — 4s at the default — which is often enough to catch an
 * engine that recovers and rare enough not to be a timer storm behind one
 * that never will.
 */
const MAX_DRAIN_BACKOFF_STEPS = 4;

/**
 * How many refused drains the session retries before it gives up on the
 * buffered tail. Eight attempts run the ladder above out to the end and then
 * hold at its ceiling — about 20 seconds at the default idle delay — which
 * is far past any transient engine failure and well short of forever.
 *
 * The bound exists because "retry until it works" is not a terminal state.
 * An engine that throws on EVERY call (the unlinked native module
 * docs/STREAMING.md names) would otherwise throw out of a host timer
 * callback every four seconds for the life of the session, and every caller
 * parked on `drained()` — `bindRunTextEvents` awaits it at run end — would
 * wait for a drain that is never coming. See {@link StreamSession.drained}
 * for what the session does instead.
 */
const MAX_DRAIN_RETRIES = 8;

/**
 * How many times `notify` will re-run its listener pass because a listener
 * mutated the session from inside its own callback. Generous — a re-entrant
 * chain thousands of commits deep is unusual but legitimate, and used to
 * work until the stack ran out — while still bounding a listener that
 * mutates unconditionally, which would otherwise spin forever.
 */
const MAX_NOTIFY_PASSES = 10_000;

const defaultBufferScheduler: BufferScheduler = (flush) => {
  // Environment-neutral: RN and browsers have requestAnimationFrame, Node
  // (and jest's default env) does not — es2020 lib types carry neither, so
  // both are reached through a typed globalThis view.
  const g = globalThis as {
    requestAnimationFrame?: (cb: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  if (typeof g.requestAnimationFrame === 'function') {
    const id = g.requestAnimationFrame(flush);
    return () => g.cancelAnimationFrame?.(id);
  }
  const id = setTimeout(flush, 16);
  return () => clearTimeout(id);
};

const defaultIdleScheduler: IdleScheduler = (flush, ms) => {
  const id = setTimeout(flush, ms);
  return () => clearTimeout(id);
};

/**
 * Characters that can open, close, or alter a markdown construct when they
 * arrive in an append. A delta containing none of these can only extend
 * plain prose, which is what makes the parse-free fast path sound.
 *
 * Beyond the obvious syntax set, ';' is included because it can complete an
 * entity reference already sitting at the tail ("&amp" + ";" decodes), which
 * would change an existing text node's value.
 */
const CONSTRUCT_CHARS = /[\n\r\\`*_~$[\]()<>#|!&\-=+.:'";]/;

/**
 * Every scheme md4c's permissive autolinker recognises — its `scheme_map` is
 * {http, https, ftp} (platform/cpp/vendor/md4c/md4c.c) — kept as one list so
 * a future md4c bump is a one-line change here rather than a silent
 * divergence between the guard and the parser.
 * `src/stream/incremental.test.ts` reads that table out of the vendored C
 * source and fails if this list falls behind it.
 */
const PERMISSIVE_AUTOLINK_SCHEMES = ['http', 'https', 'ftp'];

/**
 * A trailing token that is (or is growing into) a bare autolink candidate.
 * Once a permissive scheme or "www." sits anywhere in the last
 * whitespace-delimited token of the line, even a plain letter can complete
 * or re-extend an autolink (`https://example.` + `c` pulls the trimmed `.`
 * back into the URL), so the fast path must stand down and let the engine
 * decide. Tested against the raw source's final line, not just the final
 * text node — the token may span an already-emitted autolink node plus
 * trimmed punctuation.
 */
const URLISH_TAIL = new RegExp(
  `(?:^|[\\s*_~(])(?:(?:${PERMISSIVE_AUTOLINK_SCHEMES.join('|')}):|www\\.)\\S*$`,
  'i',
);

/**
 * Whether the line's last whitespace-delimited token holds an '@' — the
 * EMAIL half of GFM's autolink extension, which `URLISH_TAIL` cannot see
 * because a bare email has no scheme to look for.
 *
 * The divergence it prevents: `mail foo@example.` is plain text (md4c wants
 * a dot inside the host), and the delta that turns it into an autolink is
 * the bare letter `c` — no construct character, no `https:` or `www.` token.
 * The fast path would extend the text node while a fresh parse of the same
 * source yields `mailto:foo@example.c`, and nothing corrects it until a
 * construct character or a trailing space happens along.
 *
 * Written as two native scans rather than as a regex alternative in
 * `URLISH_TAIL`: `[^\s@]+@` inside that pattern backtracks through the whole
 * token on every line that has no '@' in it, which is every line of ordinary
 * prose, and this runs per append against a line that can be kilobytes long.
 * `lastIndexOf` fails in one pass instead. Deliberately not conditioned on
 * `extensions.autolinks`: standing down when the extension is off costs one
 * parse of a tail that was going to be parsed anyway the moment the token
 * ended.
 */
function hasEmailTail(line: string): boolean {
  const at = line.lastIndexOf('@');
  // Whitespace after the LAST '@' means no '@' is in the final token at all.
  return at !== -1 && !/\s/.test(line.slice(at + 1));
}

/**
 * A line that is (so far) just an HTML-block opener stub: `<`, `</`, `<!`
 * or `<?` after up to three spaces. The very next letter would flip the
 * line from paragraph text into an HTML block (`<` parses as a paragraph,
 * `<h` starts an HTML block), so the fast path must stand down.
 */
const HTML_OPEN_TAIL = /^ {0,3}<[!/?]?$/;

/**
 * Opener → end condition for the HTML block types that do NOT end at a blank
 * line (CommonMark types 1-4), transcribed from md4c's own start conditions
 * (`md_is_html_block_start_condition`, platform/cpp/vendor/md4c/md4c.c) and
 * tested in md4c's order, because that is the parser this session's blocks
 * come from and CommonMark's prose differs from it in ways that decide
 * whether a literal anchors:
 *
 * - type 1 needs no delimiter after the tag name — md4c compares the name
 *   alone, so `<pretty` opens a raw-text block that runs to `</pre>`;
 * - type 2 (`<!--`) needs at least one character AFTER the four, so the
 *   literal `<!--` on its own is type 4 and ends at the first `>`;
 * - type 4 is `<!` followed by ANY ASCII character, not just a letter (the
 *   comment above md4c's test says "uppercase letter", the code accepts all
 *   of ASCII), which is what makes `<!5`, `<!-`, `<! ` and the partial
 *   `<![CDATA` blank-line-spanning blocks that end at a `>`;
 * - type 5 (`<![CDATA[` … `]]>`) is therefore unreachable in md4c: `[` is
 *   ASCII, so type 4 claims the literal first and it ends at the first `>`.
 *   It has no row here for that reason.
 *
 * Types 6 and 7 end at a blank line, so a literal matching no row here needs
 * nothing waited for — see {@link htmlBlockClosed}.
 *
 * A block whose own literal already holds its end condition is CLOSED, and a
 * closed block cannot grow — which makes it as anchor-safe as a closed
 * fence. Refusing to anchor those as well cost every raw-HTML stream its
 * anchor entirely: a document of 40 one-line `<!-- … -->` blocks reparsed
 * from offset 0 on every append.
 */
const HTML_BLOCK_END_CONDITIONS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [
    /^ {0,3}<(?:pre|script|style|textarea)/i,
    /<\/(?:pre|script|style|textarea)>/i,
  ],
  [/^ {0,3}<!--[\s\S]/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![\x00-\x7f]/, />/],
];

/**
 * Whether an HTML block literal has reached the end condition that lets it
 * stop growing. True for a type 6 or 7 block (nothing to wait for: those end
 * at the blank line the anchor scan already found) and for a type 1-4 block
 * whose literal holds its terminator.
 *
 * The fall-through is deliberately the SAFE answer, not the convenient one:
 * a literal that matches no row is one md4c did not start as type 1-4, so a
 * blank line really does end it. What must never happen is the reverse — a
 * type-4 literal falling through and being called closed, which froze
 * `<!5 note` at eight characters and rendered the rest of the block as
 * markdown for the remainder of the stream. Every row's opener is therefore
 * md4c's, exactly (see {@link HTML_BLOCK_END_CONDITIONS}), so the shapes
 * that used to fall through — `<!5`, `<!-`, `<! `, `<![CDATA` — now match
 * the type-4 row and wait for their `>`.
 */
function htmlBlockClosed(literal: string): boolean {
  for (const [opener, ender] of HTML_BLOCK_END_CONDITIONS) {
    if (opener.test(literal)) {
      return ender.test(literal);
    }
  }
  return true;
}

/**
 * Container prefixes a link reference definition can sit behind — any mix of
 * blockquote markers and one list-item marker per level, as deep as the
 * writer nested them (`> - [foo]: /url`). Applied repeatedly until the line
 * stops shrinking, so the label test below sees the definition's own
 * content rather than its containers.
 */
const CONTAINER_PREFIX = /^ {0,3}(?:(?:>[ \t]?)+|(?:[-+*]|\d{1,9}[.)])[ \t]+)/;

/**
 * A line that is so far ONLY indentation and a half-typed container marker
 * ('-', '1.', '>', '- >'): the next characters could still make it a
 * definition, so it must not be ruled out yet. Tested on what
 * {@link containerPrefixLength} left behind.
 */
const PARTIAL_CONTAINER = /^ {0,3}(?:[-+*>]|\d{1,9}[.)]?)?[ \t]*$/;

/** Offset of a line's content, past every container marker opening it. */
function containerPrefixLength(line: string): number {
  let at = 0;
  for (;;) {
    const m = CONTAINER_PREFIX.exec(line.slice(at));
    if (m === null || m[0].length === 0) {
      return at;
    }
    at += m[0].length;
  }
}

/**
 * Offset of a line's content, past both halves of a container prefix: the
 * CONTENT INDENT of the containers already open above this line, and then any
 * marker this line opens for itself.
 *
 * Markers alone are not enough. A definition inside a list item is written at
 * the item's content column with no marker of its own —
 * `- outer` / `  - inner` / blank / `    [foo]: /url` — and reading that line
 * from column 0 finds four spaces, which looks like indented code and rules
 * the definition out. It is also what lets the marker scan reach past three
 * spaces of indentation: `CONTAINER_PREFIX` only allows ` {0,3}` before a
 * marker, so the `- c` of a third-level item is only found once the two
 * levels above it have been taken off.
 */
function contentStart(line: string, containerIndent: number): number {
  let at = 0;
  while (
    at < line.length &&
    at < containerIndent &&
    (line[at] === ' ' || line[at] === '\t')
  ) {
    at += 1;
  }
  return at + containerPrefixLength(line.slice(at));
}

/**
 * How far a line may be nothing but indentation and a half-typed marker and
 * still count as a definition that has not arrived yet. Past this it is ruled
 * out: no container's content column is 64 characters deep, and a line that
 * stays a candidate is re-read from its start on every append.
 */
const GROWING_PREFIX_LIMIT = 64;

/**
 * How a source line relates to a link reference definition (`[label]: dest`).
 * `'definition'` — the line completes the `[label]:` opener; `'open'` — its
 * label is unterminated, so the definition may still complete on a LATER
 * line (`[foo` / `bar]: /url`, which md4c reads as one definition);
 * `'growing'` — nothing but indentation or a half-typed container marker so
 * far, which could still become one when more of THIS line arrives; `'no'`
 * — it cannot, whatever follows.
 *
 * `from` resumes a scan of the same line a previous append already walked,
 * and the returned `scanned` is where the next one may resume: a paragraph
 * line that opens with `[` and has no `]` yet would otherwise be re-read end
 * to end on every append, which is quadratic in the line.
 *
 * Deliberately loose, in every direction that costs anchoring rather than
 * correctness — being wrong the other way would mean serving a stale parse.
 * All of these read as `'definition'`: an empty label; a label md4c would
 * reject; a definition-shaped line inside a fenced code block (this is a line
 * scan and knows nothing about fences); and any line reached by RESUMING a
 * label left open above, which hunts for `]:` and no longer asks whether the
 * line could open one — `- item one` / `- item two [x]: y` is two list items
 * to md4c and a definition here. The only consequence is a session that stops
 * freezing blocks it could have frozen (see
 * {@link StreamSession.scanForLinkReferenceDefinitions}).
 *
 * `containerIndent` is the content column of the containers open above this
 * line; see {@link contentStart}.
 */
function linkReferenceDefinitionState(
  line: string,
  labelOpen: boolean,
  from: number,
  terminated: boolean,
  containerIndent: number,
): {
  state: 'definition' | 'open' | 'growing' | 'no';
  scanned: number;
} {
  const whole = { scanned: line.length };
  let i = from;
  if (from === 0) {
    const content = contentStart(line, containerIndent);
    const rest = line.slice(content);
    if (labelOpen) {
      if (/^[ \t]*$/.test(rest)) {
        // A blank line ends a label — but a line that has not arrived yet is
        // not a blank line, it is the newline that just landed.
        return { state: terminated ? 'no' : 'growing', ...whole };
      }
      i = content;
    } else {
      const open = /^ {0,3}\[/.exec(rest);
      if (open === null) {
        // Indentation, or a container marker still being typed, is still a
        // possible opener; a fourth space past the content column is indented
        // code, and any other character rules the line out for good. The
        // length bound keeps a line that is ONLY indentation from being
        // re-read from the start on every append forever.
        return {
          state:
            rest.length <= GROWING_PREFIX_LIMIT && PARTIAL_CONTAINER.test(rest)
              ? 'growing'
              : 'no',
          ...whole,
        };
      }
      i = content + open[0].length;
    }
  }
  for (; i < line.length; i += 1) {
    if (line[i] === '\\') {
      // An escaped ']' stays inside the label.
      i += 1;
      continue;
    }
    if (line[i] !== ']') {
      continue;
    }
    if (i + 1 >= line.length) {
      return { state: 'open', scanned: i };
    }
    // The ':' must follow the label immediately; a later ']' cannot open a
    // second label, so anything else ends the line's chances.
    return { state: line[i + 1] === ':' ? 'definition' : 'no', ...whole };
  }
  // The label is still open. Resume one character back, so a trailing
  // backslash (which may yet escape the character that has not arrived) and
  // a trailing ']' (whose next character decides everything) are re-read.
  return { state: 'open', scanned: Math.max(from, line.length - 1) };
}

/**
 * Deep structural equality over two parsed blocks — same kinds, spans,
 * values, children, and streaming flags. Used by `finalize` to check a
 * cached settled block against the fresh parse of the same span before
 * substituting it (see {@link StreamSession.remember}); nothing on the
 * per-append path calls it.
 *
 * Iterative, like every other walk over a parsed tree in this library: the
 * tree's depth is whatever the model emitted, and a blockquote 20 000 levels
 * deep (40 kB of `'> '`, which md4c parses happily) recursed one frame per
 * level here and threw `RangeError: Maximum call stack size exceeded` out of
 * `finalize` — after the whole document had already streamed successfully.
 * A pair stack costs the same comparisons and is bounded by the heap.
 */
function sameStructure(a: unknown, b: unknown): boolean {
  // Pairs still to compare; order does not matter, since a mismatch anywhere
  // is the whole answer.
  const left: unknown[] = [a];
  const right: unknown[] = [b];
  while (left.length > 0) {
    const x = left.pop();
    const y = right.pop();
    if (x === y) {
      continue;
    }
    if (
      typeof x !== 'object' ||
      typeof y !== 'object' ||
      x === null ||
      y === null
    ) {
      return false;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        return false;
      }
      for (let i = 0; i < x.length; i += 1) {
        left.push(x[i]);
        right.push(y[i]);
      }
      continue;
    }
    const lx = x as Record<string, unknown>;
    const ry = y as Record<string, unknown>;
    const keys = Object.keys(lx);
    if (keys.length !== Object.keys(ry).length) {
      return false;
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(ry, key)) {
        return false;
      }
      left.push(lx[key]);
      right.push(ry[key]);
    }
  }
  return true;
}

/**
 * Block kinds that may anchor the frozen prefix. Appending text after a
 * blank line can never merge back into any of these:
 * paragraphs/headings/tables/blockquotes terminate at a blank line,
 * thematic breaks are single lines, and a closed fence ends at its closing
 * fence line.
 *
 * Deliberately excluded:
 * - `list` — a blank line does not end a list: an indented line after the
 *   blank continues the item, and a following `- b` merges into the same
 *   list while flipping it tight→loose;
 * - `codeBlock` with `fenced: false` — indented code spans blank lines;
 * - `codeBlock` with `closed: false` — still consuming everything;
 * - `htmlBlock` of type 1-4 that has NOT reached its end condition — those
 *   span blank lines (see {@link HTML_BLOCK_END_CONDITIONS}). The anchor
 *   scan evaluates the PREVIOUS parse's block end against the already-grown
 *   source, so a comment or `<script>` md4c had to cut at the old
 *   end-of-source would look blank-line-terminated and freeze truncated,
 *   with the rest of the block parsed as markdown for the remainder of the
 *   stream. One whose literal already holds its `-->`, `?>` or closing tag
 *   is finished and anchors like anything else ({@link htmlBlockClosed}) —
 *   keying on the opener alone made every raw-HTML stream quadratic. Only
 *   reachable with `html: 'raw'`; under the default 'strip' the decoder
 *   emits no htmlBlock node at all.
 * These freeze only once a safe-kind block after them is itself followed by
 * a blank line.
 */
function isAnchorSafe(block: Block): boolean {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
    case 'thematicBreak':
    case 'table':
    case 'blockquote':
      return true;
    case 'htmlBlock':
      return htmlBlockClosed(block.literal);
    case 'codeBlock':
      return block.fenced && block.closed;
    default:
      return false;
  }
}

/**
 * Where the frozen prefix would end if `blockEnd` closed an anchor block:
 * the start offset of the first non-blank line after it, provided at least
 * one entirely blank line lies in between (and nothing but whitespace fills
 * the gap). Returns null when the block is not blank-line-separated from
 * what follows, or when nothing non-blank follows yet.
 */
function anchorCandidate(source: string, blockEnd: number): number | null {
  const nl = source.indexOf('\n', blockEnd);
  if (nl === -1) {
    return null;
  }
  if (/[^ \t\r]/.test(source.slice(blockEnd, nl))) {
    return null;
  }
  let lineStart = nl + 1;
  let sawBlank = false;
  while (lineStart < source.length) {
    const next = source.indexOf('\n', lineStart);
    const lineEnd = next === -1 ? source.length : next;
    if (/[^ \t\r]/.test(source.slice(lineStart, lineEnd))) {
      return sawBlank ? lineStart : null;
    }
    sawBlank = true;
    if (next === -1) {
      break;
    }
    lineStart = next + 1;
  }
  return null;
}

/**
 * Owns the streamed markdown text and parses it incrementally. After each
 * parse the session computes a safe anchor — the end (through its trailing
 * blank line) of the last block that can no longer change — and from then
 * on each append parses only `source.slice(anchor)` (tail-repaired as
 * before), shifts the resulting spans by the anchor, and splices the frozen
 * prefix blocks back in front. Frozen blocks keep referential identity by
 * construction; construct-free deltas skip the engine entirely and extend
 * the trailing paragraph immutably. `finalize` reparses the raw text once
 * without repairs so every virtual closer vanishes from the final document.
 *
 * The one construct that defeats the anchor is a link reference definition,
 * which changes how text elsewhere in the document parses; the session
 * detects one and stops freezing for the rest of the stream (see
 * `scanForLinkReferenceDefinitions`).
 *
 * `appendBuffered` is the opt-in coalescing entry point for token streams
 * that outpace frames: deltas pool in a pending buffer and one scheduled
 * flush appends them together (minus an optional `holdBackChars` tail that
 * hides half-typed constructs; see `StreamSessionInit`). An optional
 * `smoother` meters how much of that buffer each flush releases (typewriter
 * pacing; see `smoothing.ts`), with the session re-scheduling flushes until
 * the buffer drains. Every synchronous operation drains the buffer first,
 * so `append`/`replace`/`finalize` semantics are unchanged and ordering is
 * preserved. Those flushes are timers the session owns, so a consumer that
 * drops a session before its stream ends must call `dispose()` —
 * unsubscribing alone leaves them running.
 */
export class StreamSession {
  private source = '';
  private readonly engine: Engine | undefined;
  private readonly options: EngineOptions | undefined;
  private readonly resolved: ResolvedEngineOptions;
  private readonly listeners = new Set<(s: SessionSnapshot) => void>();
  private readonly settledBlocks = new Map<string, Block>();
  private current: SessionSnapshot | null = null;
  private revision = 0;
  private phase: SessionPhase = 'streaming';

  /** Frozen-prefix end: a line-start offset the parse never crosses back over. */
  private anchor = 0;
  /** Fence/math scan state at `anchor`; anchors are only accepted clean. */
  private seedAtAnchor: RepairSeed = CLEAN_SEED;
  /** Blocks with span.end <= anchor; reused verbatim by every splice. */
  private frozen: Block[] = [];
  /** Pre-trim blocks of the last parse — the anchor scan's input. */
  private lastBlocks: Block[] = [];
  /** True when the last tail repair changed nothing (fast-path gate). */
  private lastRepairClean = true;
  /**
   * `repairTail`'s carry-forward state for the CURRENT anchor, so a tail
   * that keeps growing without ever anchoring is not re-scanned from its
   * start on every append (see {@link RepairScan}).
   *
   * The session owns it because the session is what knows the tail is
   * growing: `repairTail` itself is pure and takes it as an argument. The
   * anchor travels with it and is checked before use, because the tail is
   * `source.slice(anchor)` — an anchor that moved leaves every offset in the
   * record pointing at a different string. Anything that is not a plain
   * append clears it outright: a divergent replace and a reset through
   * `resetIncrementalState`, a `finalize` (which reparses the whole source
   * with no repairs at all, and whose blocks a resumed stream then splices
   * against), and an anchor advance below. `appendNow` saves and restores it
   * with the rest of the incremental state, so a parse that throws does not
   * leave a record describing a tail no snapshot contains.
   */
  private tailScan: { anchor: number; scan: RepairScan } | null = null;

  private readonly bufferScheduler: BufferScheduler;
  private readonly idleScheduler: IdleScheduler;
  private readonly holdBackChars: number;
  private readonly holdIdleMs: number;
  private readonly smoother: Smoother | undefined;
  /** Display-repair options threaded into every streaming tail repair. */
  private readonly repairOptions: RepairOptions | undefined;
  /**
   * Fast-path stand-down for `repair.hideBareUriSchemes`, the scheme-hide
   * analogue of `URLISH_TAIL`: '/' is not a construct character, so once
   * `scheme:` sits in the last whitespace-delimited token even a
   * construct-free delta (`/5f3a`) can commit the token to being hidden —
   * the parse path must run the repair. Built once from the listed schemes
   * (same `\b`-anchored shape the repair itself matches with); null when
   * the option is off, costing sessions without it nothing.
   */
  private readonly bareUriTailGuard: RegExp | null;
  /** Clock behind SmootherContext.now (default Date.now). */
  private readonly now: () => number;
  /** Deltas accepted by appendBuffered but not yet appended. */
  private pending = '';
  /** Cancel for the scheduled flush; null means none is scheduled. */
  private cancelScheduledFlush: (() => void) | null = null;
  /** Cancel for the armed idle drain; null means none is armed. */
  private cancelIdleDrain: (() => void) | null = null;
  /** Re-entry guard: a synchronous BufferScheduler may fire inside flushHeld. */
  private inFlush = false;
  /** Callers awaiting `drained()`; settled whenever `pending` empties. */
  private drainedWaiters: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];
  /** Set by `dispose()`; every mutating entry point is inert afterwards. */
  private disposed = false;
  /** Consecutive drains the engine refused; backs off the retry timer. */
  private drainFailures = 0;
  /**
   * The error the session gave up on after {@link MAX_DRAIN_RETRIES} refused
   * drains, or null while the buffered path is healthy. While it is set no
   * retry timer is armed and `drained()` rejects with it; the next drain that
   * succeeds — or new buffered input, which is a fresh attempt — clears it.
   */
  private drainAbandoned: unknown = null;
  /** True while `commit` is delivering a snapshot to the listener set. */
  private notifying = false;
  /**
   * Set when a commit lands re-entrantly (a listener appended or finalized
   * from inside its own callback): the delivery loop makes one more pass with
   * the newest snapshot instead of letting the nested one overtake the
   * listeners the outer pass has not reached yet.
   */
  private notifyPending = false;
  /**
   * Start of the first line the link-reference-definition scan has not
   * settled — always a line start (0, or just past a '\n').
   */
  private refScanFrom = 0;
  /** True when the partial line at `refScanFrom` can no longer open one. */
  private refLineRuledOut = false;
  /** How far into the line at `refScanFrom` the label scan has already got. */
  private refLineScanned = 0;
  /** True when a `[label` opened on an earlier line is still unterminated. */
  private refLabelOpen = false;
  /**
   * Content column of the containers open above `refScanFrom` — the column a
   * definition inside a list item or blockquote is written at. See
   * {@link contentStart}.
   */
  private refContainerIndent = 0;
  /** Whether the line above `refScanFrom` was blank. */
  private refPrevBlank = true;
  /**
   * True once a link reference definition has been seen anywhere in the
   * source, which switches the incremental anchor off for the rest of the
   * stream — see {@link scanForLinkReferenceDefinitions}.
   */
  private hasLinkReferenceDefinition = false;
  /**
   * The snapshot `snapshot()` returns before the first commit. Built once so
   * the getter is referentially stable from construction — a fresh object per
   * call would spin
   * `useSyncExternalStore((cb) => session.subscribe(cb), () => session.snapshot())`
   * until React gives up ("Maximum update depth exceeded") on every session
   * whose stream has not started yet. `this.current` is null only in that
   * window, where phase is 'streaming' and revision 0 by construction.
   */
  private readonly emptySnapshot: SessionSnapshot = {
    document: { source: '', blocks: [] },
    settledUntil: 0,
    phase: 'streaming',
    revision: 0,
  };

  constructor(init?: StreamSessionInit) {
    this.engine = init?.engine;
    this.options = init?.options;
    this.resolved = resolveOptions(init?.options);
    this.bufferScheduler = init?.bufferScheduler ?? defaultBufferScheduler;
    this.idleScheduler = init?.idleScheduler ?? defaultIdleScheduler;
    this.holdBackChars = Math.max(0, init?.holdBackChars ?? 0);
    this.holdIdleMs = init?.holdIdleMs ?? 250;
    this.smoother = init?.smoother;
    this.repairOptions = init?.repair;
    this.now = init?.now ?? Date.now;
    const schemes = init?.repair?.hideBareUriSchemes;
    this.bareUriTailGuard =
      schemes !== undefined && schemes.length > 0
        ? new RegExp(
            `\\b(?:${schemes
              .map((s) => s.replace(/[^A-Za-z0-9]/g, '\\$&'))
              .join('|')}):\\S*$`,
            'i',
          )
        : null;
  }

  /**
   * UTF-16 length of the accumulated source. Reflects only appended text —
   * deltas sitting in the `appendBuffered` pending buffer are not counted
   * until their flush.
   */
  get length(): number {
    return this.source.length;
  }

  /**
   * UTF-16 length of the `appendBuffered` text not yet appended — holdback
   * plus whatever a smoother is still metering out. Zero for sessions that
   * only ever call `append`.
   */
  get pendingLength(): number {
    return this.pending.length;
  }

  /**
   * Resolves when the pending buffer is empty (immediately if it already
   * is). The finalize companion for smoothing: `finalize()` drains
   * synchronously by design, so a caller that wants the metered tail to
   * finish playing out awaits this first —
   * `await session.drained(); session.finalize()`. New `appendBuffered`
   * deltas after resolution pend as usual; await again if the stream
   * resumed.
   *
   * REJECTS with the engine's own error when the session has given up on the
   * tail: {@link MAX_DRAIN_RETRIES} scheduled drains in a row threw, so no
   * further retry is armed and no drain is coming. That is a terminal state
   * for the buffered path and callers must handle it — awaiting a promise
   * that can never settle is worse, and resolving it would claim a buffer
   * that is not empty. Nothing is dropped: the text stays in `pending`
   * (`pendingLength` still counts it) and any explicit drain —
   * `append`, `flushBuffered`, `replace`, `finalize` — tries it again, so a
   * session whose engine comes back keeps every character. New buffered
   * input clears the state too, since it schedules a fresh attempt.
   */
  drained(): Promise<void> {
    if (this.pending === '') {
      return Promise.resolve();
    }
    if (this.drainAbandoned !== null) {
      return Promise.reject(this.drainAbandoned);
    }
    return new Promise((resolve, reject) => {
      this.drainedWaiters.push({ resolve, reject });
    });
  }

  /**
   * Run-end lifecycle passthrough to the smoother: the stream feeding this
   * session is over, so a policy with a run-end drain (see
   * `AdaptiveSmoother.notifyRunFinalized`) switches to it — a short
   * remaining tail releases instantly, a longer one races a bounded
   * deadline instead of trailing out at the steady pacing rate. Call it at
   * run end, before awaiting `drained()`; a no-op for sessions without a
   * smoother, with a policy that has no lifecycle method, or with nothing
   * pending. Timestamped on this session's clock, so the policy
   * and the per-flush `SmootherContext.now` stay on one timeline.
   *
   * With nothing pending it is a no-op rather than a forward, because there
   * is no drain to switch to and nothing would ever switch the policy back:
   * a drain-armed policy resets on its next smoother call, and an empty
   * session makes none — not even the zero-offer bookkeeping call, which
   * only fires on a release that emptied the buffer. The armed state would
   * then leak into the NEXT run on a reused session and release its first
   * flush as a run-end drain instead of pacing it. `bindRunTextEvents`
   * skips the call for empty sessions for the same reason.
   */
  notifyRunFinalized(): void {
    if (this.disposed || this.pending === '') {
      return;
    }
    this.smoother?.notifyRunFinalized?.(this.now());
  }

  /**
   * The parse context this session was created with, so consumers (e.g. the
   * copy pipeline's slice reparse) can parse under the same syntax the
   * document was parsed with.
   */
  get parseContext(): { engine?: Engine; options?: EngineOptions } {
    return { engine: this.engine, options: this.options };
  }

  /**
   * Appends a delta; an empty delta appends nothing. Any pending
   * `appendBuffered` text is drained (appended synchronously) first, so mixing
   * the two entry points can never reorder the stream — which is why
   * `append('')` is a full no-op only when nothing is buffered: with a pending
   * buffer it drains exactly like `flushBuffered()` (reparse, revision bump,
   * notification) and then appends nothing.
   */
  append(delta: string): void {
    if (this.disposed) {
      return;
    }
    this.drainPending();
    this.appendNow(delta);
  }

  /**
   * `append` minus the pending-buffer drain: the one path that actually
   * mutates the source. The buffered flush comes through here so it cannot
   * recursively re-drain the buffer it is flushing.
   *
   * Atomic up to its commit through {@link captureState}: a parse that
   * throws — an unlinked native module throws on its first call — puts
   * everything back, leaving `length` and `snapshot()` in agreement instead
   * of counting text no snapshot contains. Past the commit the new state IS
   * the truth: a throw from a subscriber propagates with nothing rolled
   * back.
   */
  private appendNow(delta: string): void {
    if (delta === '') {
      return;
    }
    const restore = this.captureState();
    this.source += delta;
    this.phase = 'streaming';
    try {
      this.update(delta);
    } catch (error) {
      restore();
      throw error;
    }
  }

  /**
   * Accumulates a delta and schedules one coalesced flush (via
   * `bufferScheduler`; never double-scheduled). Nothing parses and no
   * snapshot is committed until the flush, which appends everything pending
   * except the trailing `holdBackChars` characters — those wait for more
   * input, the idle drain (`holdIdleMs`), or any of the draining calls
   * (`append`/`flushBuffered`/`replace`/`finalize`). Opt-in: sessions that
   * only ever call `append` never touch a scheduler.
   */
  appendBuffered(delta: string): void {
    if (delta === '' || this.disposed) {
      return;
    }
    this.pending += delta;
    // New input means the stream is not stalled; the flush below re-arms the
    // idle drain if it again leaves held-back characters behind. It is also
    // a fresh attempt at a tail the session may have given up on, so the
    // retry ladder starts over.
    this.drainAbandoned = null;
    this.drainFailures = 0;
    this.clearIdleDrain();
    this.scheduleFlush();
  }

  /** Schedules the coalesced flush; a no-op while one is already scheduled. */
  private scheduleFlush(): void {
    if (this.cancelScheduledFlush !== null) {
      return;
    }
    // The BufferScheduler contract only requires a cancel function — a
    // host whose frame budget is already blown may invoke the flush
    // before returning. Storing its cancel then would resurrect a stale
    // "flush scheduled" state after the callback nulled it, and every
    // later appendBuffered would wait forever on a flush that already
    // fired; `fired` keeps the cancel from being stored in that case
    // (and from clobbering a flush the callback scheduled reentrantly).
    let fired = false;
    const cancel = this.bufferScheduler(() => {
      fired = true;
      this.cancelScheduledFlush = null;
      this.flushHeld();
    });
    if (!fired) {
      this.cancelScheduledFlush = cancel;
    }
  }

  /**
   * Drains the pending `appendBuffered` text through the normal append path
   * immediately, holdback included. Idempotent: with nothing pending it does
   * not parse, bump the revision, or notify.
   */
  flushBuffered(): void {
    if (this.disposed) {
      return;
    }
    this.drainPending();
  }

  /**
   * Prefix-diff replace: if `full` starts with the current text, append
   * the remainder; otherwise reset the session to `full`. Pending
   * `appendBuffered` text is drained first — the diff runs against
   * everything the caller has streamed, not a flush-timing-dependent prefix
   * of it.
   *
   * Atomic up to its commit, exactly like `appendNow`: the divergent path
   * throws the whole incremental prefix away before it parses, so a parse
   * that throws would otherwise leave `length` counting text no snapshot
   * contains AND an anchor, frozen prefix and identity cache belonging to a
   * document that was discarded. The identity cache is restored too, because
   * unlike an append this path clears it outright.
   */
  replace(full: string): void {
    if (this.disposed) {
      return;
    }
    this.drainPending();
    if (full === this.source) {
      return;
    }
    if (full.startsWith(this.source)) {
      this.append(full.slice(this.source.length));
      return;
    }
    const restore = this.captureState(true);
    this.source = full;
    this.resetIncrementalState();
    // A divergent replace throws the old text away, so the
    // link-reference-definition scan starts over on the new text.
    this.refScanFrom = 0;
    this.refLineRuledOut = false;
    this.refLineScanned = 0;
    this.refLabelOpen = false;
    this.refContainerIndent = 0;
    this.refPrevBlank = true;
    this.hasLinkReferenceDefinition = false;
    this.phase = 'streaming';
    try {
      this.update(null);
    } catch (error) {
      restore();
      throw error;
    }
  }

  /**
   * Metered-rewrite companion to `replace`: apply a full-text rewrite that
   * only touches the not-yet-committed tail WITHOUT collapsing the metered
   * reveal. `replace` drains the pending buffer first — right for
   * corrections the reader has already seen wrong text for, and wrong for a
   * pipeline that rewrites only the unrevealed tail: the motivating
   * consumer is a chat live-tail protocol whose digest rewrites a
   * completing citation link into its marker form (`[ApoB](fhir://…)` →
   * `ApoB [1](#…)`) on every citation completion. That edit lands entirely
   * inside text the reader has not seen, so routing it through `replace`
   * would dump the smoother's whole withheld backlog in one commit at
   * every citation — `rewrite` swaps the pending buffer instead and lets
   * the reveal keep typing through the rewritten tail.
   *
   * Three cases, decided against the COMMITTED source only:
   * - `full` equals committed + pending: nothing changed — no-op;
   * - `full` starts with the committed source: the pending buffer becomes
   *   `full.slice(source.length)` with NO drain — the flush stays (or gets)
   *   scheduled exactly as `appendBuffered` would arrange, so a smoother
   *   keeps metering as if the new tail had streamed in normally, and
   *   `drained()` resolves if the rewrite emptied the tail;
   * - anything else — the rewrite reaches into committed text — falls back
   *   to full `replace(full)` semantics: revealed text can only be
   *   corrected by re-committing it, immediately.
   */
  rewrite(full: string): void {
    if (this.disposed || full === this.source + this.pending) {
      return;
    }
    if (full.startsWith(this.source)) {
      this.pending = full.slice(this.source.length);
      if (this.pending === '') {
        // The rewrite deleted the whole unrevealed tail: nothing left to
        // flush, hold, or meter — and the buffer emptied outside a smoothed
        // flush, so the smoother gets the same bookkeeping call a drain
        // makes.
        this.clearScheduledFlush();
        this.clearIdleDrain();
        this.noteExternalDrain();
        this.resolveDrained();
        return;
      }
      // The swapped tail is new buffered input: cancel the stalled-stream
      // idle drain and keep one coalesced flush scheduled, exactly as
      // `appendBuffered` would (the flush re-arms the idle drain if it
      // again leaves held-back characters behind).
      this.clearIdleDrain();
      this.scheduleFlush();
      return;
    }
    this.replace(full);
  }

  /**
   * Reparse WITHOUT repairs, phase becomes 'settled'. Idempotent. Pending
   * `appendBuffered` text is drained first — finalizing must settle every
   * character the caller streamed, not strand a held-back tail.
   */
  finalize(reason?: 'end' | 'aborted' | 'failed'): void {
    // Aborted and failed runs settle exactly like a clean end: whatever
    // text arrived is final, and every virtual repair must vanish.
    void reason;
    if (this.disposed) {
      return;
    }
    this.drainPending();
    if (this.phase === 'settled') {
      return;
    }
    // Atomic up to its commit, exactly like `appendNow` and `replace`: the
    // parse is what throws in practice, but everything after it mutates the
    // anchor bookkeeping, and a session left half-finalized would report a
    // frozen prefix belonging to a snapshot it never committed.
    const restore = this.captureState();
    try {
      // One last full clean parse of the raw source (O(n), once per stream);
      // previously frozen blocks are swapped back in by kind, span and
      // structure so settled content survives finalize with the same object
      // references.
      const doc = this.parse(this.source);
      // Only past the parse: an engine that throws must leave the session
      // streaming rather than settled with no settled snapshot to show.
      this.phase = 'settled';
      const blocks = doc.blocks.map((b) => this.remember(b));
      this.lastBlocks = blocks;
      this.lastRepairClean = true;
      // Nothing was repaired, so there is no scan of a repaired tail to
      // carry; a stream that resumes after this starts its next tail cold.
      this.tailScan = null;
      // The fresh parse supersedes the incremental blocks, so the frozen
      // prefix re-adopts its objects: a resumed stream then splices the same
      // blocks `lastBlocks` holds. `remember` hands back the cached object
      // for every block that still matches, so this is identity-preserving
      // in the common case and corrects the prefix in the case where it does
      // not.
      if (this.frozen.length > 0) {
        this.frozen = blocks.slice(0, this.frozen.length);
      }
      this.advanceAnchor(blocks);
      this.commit({ source: doc.source, blocks }, this.source.length);
    } catch (error) {
      // A no-op past the commit, where the new state IS the truth and the
      // throw came from a subscriber (see {@link captureState}).
      restore();
      throw error;
    }
  }

  /**
   * The latest committed snapshot. Reflects only appended text: deltas
   * sitting in the `appendBuffered` pending buffer appear in no snapshot
   * until their flush.
   *
   * Referentially stable between commits, including before the first one, so
   * it can be used as a `useSyncExternalStore` getSnapshot directly.
   */
  snapshot(): SessionSnapshot {
    return this.current ?? this.emptySnapshot;
  }

  /**
   * Registers a snapshot listener and returns its unsubscribe — the
   * `useSyncExternalStore` subscribe shape, so
   * `useSyncExternalStore((cb) => session.subscribe(cb), () => session.snapshot())`
   * is a correct integration.
   *
   * Listeners are called synchronously, in registration order, with the
   * snapshot of the commit that woke them. A listener MAY mutate the session
   * (append, finalize); the nested commit is delivered to everyone after the
   * current pass finishes, so no listener is ever handed an older revision
   * after a newer one. Unsubscribing during a pass takes effect on the next
   * one. After `dispose()` this registers nothing and returns a no-op.
   */
  subscribe(fn: (s: SessionSnapshot) => void): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Ends the session and releases everything it holds. Idempotent.
   *
   * Concretely: cancels the scheduled flush and the armed idle drain, DROPS
   * whatever `appendBuffered` text is still pending (it is never parsed,
   * never committed, and appears in no snapshot), resolves every outstanding
   * `drained()` promise, and drops every subscriber. Afterwards the session
   * is inert — `append`, `appendBuffered`, `flushBuffered`, `replace`,
   * `rewrite`, `finalize` and `notifyRunFinalized` do nothing, `subscribe`
   * returns a no-op unsubscribe without registering, `drained()` resolves
   * immediately — while `snapshot()`, `length` and `parseContext` keep
   * reporting the last committed state, so a view mid-unmount reads
   * something consistent.
   *
   * This is the cleanup for a session dropped before its stream ended: a row
   * unmounting mid-run, a screen popping. Unsubscribing does not stop the
   * work — a smoother re-schedules its flush every frame while it withholds
   * text, and holdback arms an idle drain — so without `dispose()` a dropped
   * session keeps parsing and committing into a document nobody reads. To
   * KEEP the tail instead of discarding it, call `flushBuffered()` (or
   * `finalize()`) first and then `dispose()`.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearScheduledFlush();
    this.clearIdleDrain();
    this.pending = '';
    this.listeners.clear();
    this.resolveDrained();
  }

  /**
   * Unfreezes everything: the next update reparses the whole source.
   *
   * `keepIdentityCache` keeps the settled-block map, for the caller that is
   * invalidating the ANCHOR rather than the text (a link reference
   * definition). `remember` verifies a cached block structurally before
   * reusing it, so blocks the event did not actually change keep their
   * objects through finalize while the changed ones are replaced. A divergent
   * `replace` passes it up: the text under those spans is gone.
   */
  private resetIncrementalState(keepIdentityCache = false): void {
    this.anchor = 0;
    this.seedAtAnchor = CLEAN_SEED;
    this.frozen = [];
    this.lastBlocks = [];
    this.lastRepairClean = true;
    this.tailScan = null;
    if (!keepIdentityCache) {
      this.settledBlocks.clear();
    }
  }

  /**
   * Snapshots everything a parse touches and returns the undo for it. The
   * undo is a no-op once a commit has landed: past the commit the new state
   * IS the truth (a throw from a subscriber must not roll the document
   * back), which is why it tests the revision rather than trusting the
   * caller.
   *
   * Used by every path that mutates the source before parsing it, so a parse
   * that throws — an unlinked native module throws on its first call — can
   * never leave `length` counting text no snapshot contains.
   *
   * `includeIdentityCache` copies the settled-block map as well. Only the
   * divergent `replace` needs it, because only that path CLEARS the map; an
   * append merely adds entries, and the blocks those cache are the same
   * objects a retry freezes (`remember` re-verifies structure anyway), so
   * the hot path does not pay for a copy of the whole cache.
   */
  private captureState(includeIdentityCache = false): () => void {
    const revisionBefore = this.revision;
    const source = this.source;
    const phase = this.phase;
    const anchor = this.anchor;
    const seedAtAnchor = this.seedAtAnchor;
    const frozen = this.frozen;
    // `advanceAnchor` appends to `frozen` in place, so the length is part of
    // the state — restoring the reference alone would keep the new entries.
    const frozenLength = frozen.length;
    const lastBlocks = this.lastBlocks;
    const lastRepairClean = this.lastRepairClean;
    const tailScan = this.tailScan;
    const refScanFrom = this.refScanFrom;
    const refLineRuledOut = this.refLineRuledOut;
    const refLineScanned = this.refLineScanned;
    const refLabelOpen = this.refLabelOpen;
    const refContainerIndent = this.refContainerIndent;
    const refPrevBlank = this.refPrevBlank;
    const hasLinkReferenceDefinition = this.hasLinkReferenceDefinition;
    const settledBlocks = includeIdentityCache
      ? new Map(this.settledBlocks)
      : null;
    return () => {
      if (this.revision !== revisionBefore) {
        return;
      }
      this.source = source;
      this.phase = phase;
      this.anchor = anchor;
      this.seedAtAnchor = seedAtAnchor;
      this.frozen = frozen;
      this.frozen.length = frozenLength;
      this.lastBlocks = lastBlocks;
      this.lastRepairClean = lastRepairClean;
      this.tailScan = tailScan;
      this.refScanFrom = refScanFrom;
      this.refLineRuledOut = refLineRuledOut;
      this.refLineScanned = refLineScanned;
      this.refLabelOpen = refLabelOpen;
      this.refContainerIndent = refContainerIndent;
      this.refPrevBlank = refPrevBlank;
      this.hasLinkReferenceDefinition = hasLinkReferenceDefinition;
      if (settledBlocks !== null) {
        this.settledBlocks.clear();
        for (const [key, block] of settledBlocks) {
          this.settledBlocks.set(key, block);
        }
      }
    };
  }

  /**
   * Appends everything pending, holdback included, cancelling both timers.
   * Every synchronous entry point (`append`, `flushBuffered`, `replace`,
   * `finalize`) routes through here first, which is what keeps buffered and
   * direct input in arrival order.
   */
  private drainPending(): void {
    this.clearScheduledFlush();
    this.clearIdleDrain();
    if (this.pending === '') {
      return;
    }
    const held = this.pending;
    const sourceLength = this.source.length;
    this.pending = '';
    try {
      this.appendNow(held);
    } catch (error) {
      // `appendNow` is atomic up to its commit: when it rolled the source
      // back the text never landed, so it goes back in the buffer rather than
      // disappearing between the two. (A throw from a subscriber lands past
      // the commit — that text IS in the source and must not be drained
      // twice.)
      if (this.source.length === sourceLength) {
        this.pending = held;
        // This method cleared both timers on the way in, so without a fresh
        // one the tail sits in the buffer with nothing left to release it
        // and `drained()` never settles — a run parked behind it holds
        // forever. An engine can fail transiently, so it is retried, backing
        // off so a dead one is not polled every idle delay; and the retries
        // are COUNTED, so an engine that never recovers ends in a terminal
        // state instead of a permanent timer. The throw still propagates —
        // out of whatever called in, which for a scheduled drain is the
        // timer callback.
        this.drainFailures += 1;
        if (this.drainFailures > MAX_DRAIN_RETRIES) {
          // The ladder is out. Retrying forever is not a terminal state:
          // stop the timers and settle the waiters instead — see
          // {@link abandonDrain}.
          this.abandonDrain(error);
        } else {
          this.armIdleDrain(this.retryDelay());
        }
      }
      throw error;
    }
    this.noteExternalDrain();
    this.resolveDrained();
  }

  /**
   * Delay before the next retry of a drain the engine refused: the idle
   * delay, doubled per consecutive failure up to
   * {@link MAX_DRAIN_BACKOFF_STEPS}. A transient failure is retried
   * promptly; a permanent one settles into an occasional attempt rather than
   * a timer storm, and the tail is still waiting whenever the engine works
   * again.
   */
  private retryDelay(): number {
    const steps = Math.min(this.drainFailures - 1, MAX_DRAIN_BACKOFF_STEPS);
    return this.holdIdleMs * 2 ** Math.max(0, steps);
  }

  /**
   * Zero-offer bookkeeping flush after the pending buffer was released
   * WITHOUT consulting the smoother — a synchronous drain
   * (`append`/`flushBuffered`/`replace`/`finalize`), the idle drain, or a
   * link snap that emptied the buffer. A stateful policy remembers whether
   * its last answer left text unreleased, to tell a timer suspension (big
   * flush gap with text stranded mid-release → catch up in one commit)
   * from an idle stream resuming (big gap after a full drain → resume
   * pacing); a drain behind its back strands that memory at "unreleased"
   * with nothing actually pending, and the next routine stream stall would
   * misread as a suspension and dump the following burst un-paced. The
   * empty offer travels the normal `Smoother` contract — pendingLength 0,
   * nothing releasable, the answer is irrelevant — so stateless smoothers
   * are unaffected and `createAdaptiveSmoother` resets through the same
   * branch a genuinely empty flush would take.
   */
  private noteExternalDrain(): void {
    this.smoother?.('', {
      now: this.now(),
      pendingLength: 0,
      sourceLength: this.source.length,
    });
  }

  /**
   * Tell the smoother how much of its last answer actually made it into the
   * document — see {@link Smoother.notifyReleased}. Only the metered flush
   * calls it: an unmetered release (a synchronous drain, the idle drain)
   * reports itself through {@link noteExternalDrain} instead, and the
   * zero-offer call it makes has no answer to settle.
   */
  private settleSmoother(released: number): void {
    this.smoother?.notifyReleased?.(released);
  }

  /**
   * Cluster-safe cut into `this.pending`: the largest cut at or below the
   * proposed one that splits no visible glyph. Released text cannot be
   * recalled, so a committed half-cluster paints as its own glyph for a
   * frame — half a family emoji, the bare '❤' out of '❤️‍🔥', a lone '🇺'
   * out of a flag, 'cafe' before its combining accent. The cut therefore
   * moves DOWN only (never up — pending text can always wait for the rest of
   * its cluster, and a full-buffer release is the drain's job, not a cut's).
   *
   * Judged against the committed source as well as the buffer, and against
   * the fact that the buffer's end is not the text's end: the last cluster
   * of a metered flush is held back until a following code point proves it
   * finished, because otherwise a cluster split across two deltas commits
   * its first half. With `holdBackChars` 0 that costs one code point of
   * latency per flush, released by the next delta, the idle drain or
   * `finalize`. {@link retreatToStreamBoundary} documents both rules, and
   * which clusters are recognised — Hangul jamo and Indic conjuncts across a
   * virama are not.
   */
  private clusterSafeCut(cut: number): number {
    return retreatToStreamBoundary(this.source, this.pending, cut);
  }

  /**
   * The scheduled flush: append the pending text up to the trailing
   * `holdBackChars` characters — or less, when a `smoother` meters the
   * release (its answer is clamped and retreated to a cluster boundary; a
   * non-finite answer releases everything releasable). Whichever text a
   * flush leaves behind is never stranded: while releasable text remains the
   * next flush is scheduled immediately, so a smoothed drain keeps its
   * cadence with no further input, and once only the holdback tail is left
   * the idle drain takes over.
   */
  private flushHeld(): void {
    if (this.inFlush) {
      // A synchronous BufferScheduler fired the re-scheduled flush from
      // inside this very flush; without a real frame between calls a
      // smoother has no time base, so the outer call falls back to the
      // idle drain rather than looping synchronously.
      return;
    }
    const cut = this.clusterSafeCut(this.pending.length - this.holdBackChars);
    if (cut <= 0) {
      if (this.pending !== '') {
        this.armIdleDrain();
      }
      return;
    }
    let take = cut;
    /** The smoother's own clamped answer when it withheld text — the link
     * snap may extend `take` past it, and if that empties the buffer the
     * smoother must be told (see the external-drain note below). */
    let metered: number | null = null;
    if (this.smoother) {
      // Context lengths are read before the release mutates them, so
      // sourceLength + pendingLength is the total text arrived — the signal
      // an adaptive smoother's arrival tracker samples. It only fails to be
      // monotone when `rewrite` swaps a shorter tail in or a divergent
      // `replace` shortens the document; the shipped policy rebases its
      // window on the drop for that (see `SmootherContext`).
      const context: SmootherContext = {
        now: this.now(),
        pendingLength: this.pending.length,
        sourceLength: this.source.length,
      };
      const want = this.smoother(this.pending.slice(0, cut), context);
      take = Number.isFinite(want)
        ? this.clusterSafeCut(Math.min(cut, Math.max(0, Math.floor(want))))
        : cut;
      if (take < cut) {
        metered = take;
        take = this.snapTakePastLinkDestination(take, cut);
      }
    }
    this.inFlush = true;
    try {
      if (take > 0) {
        const ready = this.pending.slice(0, take);
        const sourceLength = this.source.length;
        // Sliced before the append, so a subscriber reading `pendingLength`
        // from the commit sees the buffer the release left behind.
        this.pending = this.pending.slice(take);
        try {
          this.appendNow(ready);
        } catch (error) {
          // Same atomicity as `drainPending`: text `appendNow` rolled back
          // goes back in front of the buffer, in order. Either way the
          // smoother is settled before the throw leaves: a policy that
          // charged a budget for this answer must not be left holding it —
          // `createSmoother` would run the next flush with a lifted cap and
          // a phantom charge.
          if (this.source.length === sourceLength) {
            this.pending = ready + this.pending;
            this.settleSmoother(0);
          } else {
            // The throw came from a subscriber, PAST the commit: the text is
            // in the document, so the answer was released in full.
            this.settleSmoother(take);
          }
          throw error;
        }
      }
      // Settle the smoother against what actually landed — the retreat
      // above releases less than the answer, the link snap more. A policy
      // that charges a budget needs this or a cluster it cannot yet afford
      // charges it every frame and the reveal never resumes.
      this.settleSmoother(take);
      if (this.pending === '') {
        this.resolveDrained();
        if (metered !== null && take > metered) {
          // The link snap emptied the buffer past the smoother's partial
          // answer: without the bookkeeping call its "left text
          // unreleased" memory would outlive the release and misclassify
          // the next stream stall as a timer suspension.
          this.noteExternalDrain();
        }
      } else if (take < cut) {
        // The smoother withheld releasable text: keep the drain moving even
        // if no more input ever arrives.
        this.scheduleFlush();
        if (this.cancelScheduledFlush === null) {
          // The scheduler fired synchronously and the re-entry guard above
          // refused it; the idle drain is the fallback cadence (it releases
          // the rest at once — smoothing needs an asynchronous scheduler).
          this.armIdleDrain();
        } else if (take === 0) {
          // Nothing was released at all, and the next flush may answer the
          // same: a cut parked inside a cluster whose tail has not arrived
          // retreats to 0 for as long as that lasts, and a budget smaller
          // than the whole glyph never affords it. Frames alone would spin
          // there forever, so the idle drain backs them up — it releases
          // everything at once, which is the right answer for a stream that
          // has stopped making progress. Armed only once per stalled run
          // (re-arming every frame would push its deadline out of reach);
          // progress disarms it below, and so does new input.
          if (this.cancelIdleDrain === null) {
            this.armIdleDrain();
          }
        } else {
          // Progress: the frame cadence owns the drain again, and a timer
          // armed by an earlier stalled flush must not fire into it and
          // dump the rest of the buffer in one commit.
          this.clearIdleDrain();
        }
      } else {
        this.armIdleDrain();
      }
    } catch (error) {
      // The engine (or a subscriber) threw inside a scheduled flush. The
      // scheduler wrapper cleared the flush cancel before calling in, and the
      // re-schedule/arm branches above never ran, so without this the held
      // text would sit in the buffer with no timer left to release it:
      // `drained()` would never resolve and a run parked behind it would hold
      // forever. The throw still propagates — out of the scheduler callback,
      // which is where a buffered session surfaces an engine failure — it
      // just does not strand the tail as well.
      if (this.pending !== '') {
        this.armIdleDrain();
      }
      throw error;
    } finally {
      this.inFlush = false;
    }
  }

  /**
   * Extend a smoothed cut, free of budget, past a link destination whose
   * closing `)` is already buffered — see {@link snapPastLinkDestination}.
   * Tail repair makes those characters render as nothing, so a metered
   * reveal typing through them reads as a stall; skipping them cannot lurch.
   *
   * The scan context prepends the committed tail: earlier flushes may
   * already have revealed the `[label](`, leaving the cut inside a
   * destination whose opener `pending` no longer contains. Runs at
   * `take === 0` too — a flush with no budget still snaps a cut parked at a
   * destination whose `)` just arrived, so the wait is one arrival, not one
   * budget refill. The snapped cut is retreated to a cluster boundary like
   * any other (the landing spot, just past `)`, is a boundary unless a
   * combining mark follows the paren — the retreat can only pull the cut
   * back inside the destination the next flush skips again), and the
   * skipped characters are deliberately not charged to the smoother —
   * catch-up over invisible text must not indebt the visible tail into a
   * pause.
   */
  private snapTakePastLinkDestination(take: number, cut: number): number {
    const contextTail = this.source.slice(-LINK_SNAP_WINDOW);
    const snapped = snapPastLinkDestination(
      contextTail + this.pending.slice(0, cut),
      contextTail.length + take,
      // With `repair.hideUriLikeLabels` the tail repair cuts the whole
      // construct — the label never paints either — so the snap must treat
      // it as invisible too and start at the `[`: the reveal and the repair
      // describe the same "reader never sees the label" pipeline and must
      // track each other.
      this.repairOptions?.hideUriLikeLabels
        ? { skipUriLikeLabels: true }
        : undefined,
    );
    return this.clusterSafeCut(Math.min(cut, snapped - contextTail.length));
  }

  private resolveDrained(): void {
    if (this.pending !== '') {
      return;
    }
    // An empty buffer is a healthy one, however it emptied.
    this.drainAbandoned = null;
    this.drainFailures = 0;
    if (this.drainedWaiters.length === 0) {
      return;
    }
    const waiters = this.drainedWaiters;
    this.drainedWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /**
   * Give up on the buffered tail after {@link MAX_DRAIN_RETRIES} refused
   * drains: arm no further timer, and settle everyone parked on `drained()`
   * with the engine's own error rather than leaving them waiting on a drain
   * that is not coming. The text stays in `pending` — see
   * {@link drained} — and the error itself still propagates out of the
   * caller that hit the limit (the idle timer callback, for a scheduled
   * drain), which is where a buffered session has always surfaced an engine
   * failure.
   */
  private abandonDrain(error: unknown): void {
    this.drainAbandoned = error;
    if (this.drainedWaiters.length === 0) {
      return;
    }
    const waiters = this.drainedWaiters;
    this.drainedWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private armIdleDrain(delayMs = this.holdIdleMs): void {
    this.clearIdleDrain();
    this.cancelIdleDrain = this.idleScheduler(() => {
      this.cancelIdleDrain = null;
      this.drainPending();
    }, delayMs);
  }

  private clearScheduledFlush(): void {
    if (this.cancelScheduledFlush !== null) {
      this.cancelScheduledFlush();
      this.cancelScheduledFlush = null;
    }
  }

  private clearIdleDrain(): void {
    if (this.cancelIdleDrain !== null) {
      this.cancelIdleDrain();
      this.cancelIdleDrain = null;
    }
  }

  /**
   * One streamed update. `delta` is the just-appended text (null for a
   * divergent replace, which can take no shortcut).
   */
  private update(delta: string | null): void {
    // Before the anchor, because a link reference definition can change how
    // text ANYWHERE in the document parses — including inside a block the
    // anchor already froze.
    this.scanForLinkReferenceDefinitions();
    // The delta may have completed a blank-line boundary that lets blocks
    // from the previous parse freeze now, shrinking this parse's input.
    this.advanceAnchor(this.lastBlocks);

    if (delta !== null && this.tryFastPath(delta)) {
      return;
    }

    const anchor = this.anchor;
    const tail = this.source.slice(anchor);
    // The anchor was accepted only with a clean fence/math scan state, so
    // the tail inherits no open construct from the frozen prefix.
    const carried =
      this.tailScan !== null && this.tailScan.anchor === anchor
        ? this.tailScan.scan
        : null;
    const repaired = repairTail(
      tail,
      CLEAN_SEED,
      this.resolved,
      this.repairOptions,
      carried,
    );
    // `RepairResult.scan` is optional on the type (a wrapper around
    // `repairTail` need not produce one); absent means the same as null —
    // nothing to resume from next append.
    this.tailScan = repaired.scan ? { anchor, scan: repaired.scan } : null;
    const tailDoc = this.parse(repaired.text);
    const shifted = tailDoc.blocks.map((b) => shiftSpans(b, anchor));

    let earliest = Infinity;
    for (const t of repaired.touched) {
      earliest = Math.min(earliest, anchor + t.start);
    }
    const realEnd = anchor + repaired.text.length - repaired.appended.length;
    if (earliest !== Infinity || repaired.appended !== '') {
      for (const block of shifted) {
        visit(block, (n) => {
          if (n.span.end > earliest) {
            (n as { incomplete?: true }).incomplete = true;
          }
          if (repaired.appended !== '' && n.span.start >= realEnd) {
            (n as { synthetic?: true }).synthetic = true;
          }
        });
      }
    }
    this.lastRepairClean =
      repaired.appended === '' && repaired.touched.length === 0;

    const all = [...this.frozen, ...shifted];
    this.lastBlocks = all;
    // Newly parsed blocks may themselves be freezable already (e.g. one
    // append delivered several blank-line-separated blocks); advancing here
    // keeps the reported settledUntil in step with the anchor.
    this.advanceAnchor(all);

    this.commit(
      {
        source: this.source.slice(0, anchor) + repaired.text,
        blocks: this.displayBlocks(all),
      },
      this.anchor,
    );
  }

  /**
   * Placeholder trimming applies only to the unsettled tail: frozen blocks
   * are fully-arrived constructs (a heading with no text after its `#` is
   * real content, exactly what finalize would show), and hiding one would
   * make settled content disappear from a snapshot.
   */
  private displayBlocks(all: Block[]): Block[] {
    const tail = all.slice(this.frozen.length);
    const trimmed = trimTrailingPlaceholders(tail);
    if (trimmed === tail) {
      // Nothing to trim, and every caller builds `all` as frozen prefix ++
      // tail, so it already is the answer: re-splicing would copy the whole
      // block list a second time on every append.
      return all;
    }
    return [...this.frozen, ...trimmed];
  }

  /**
   * Parse-free append. Sound only when every one of these holds:
   * - the delta has no construct character (and no trailing space/tab that
   *   a fresh parse would right-trim off the paragraph), and does not end
   *   in a lone high surrogate that repairTail would have to drop;
   * - the last parsed block is a paragraph whose final inline is a plain
   *   text node mapping 1:1 onto the raw source (no entity or smart-quote
   *   divergence) and reaching exactly to the end of the pre-append source;
   * - the previous tail repair changed nothing (no virtual closers or
   *   suppressions are in flight);
   * - the text does not end in a growing autolink candidate — a `https:`,
   *   `www.` or bare-email token (see `URLISH_TAIL` and `hasEmailTail`) —
   *   nor (when `repair.hideBareUriSchemes` is set) in a token a listed
   *   scheme's hide may be about to blank.
   * Then the appended characters extend that text node and nothing else,
   * so the last block is rebuilt immutably and the engine is skipped.
   */
  private tryFastPath(delta: string): boolean {
    if (!this.lastRepairClean || this.current === null) {
      return false;
    }
    if (CONSTRUCT_CHARS.test(delta) || /[ \t]$/.test(delta)) {
      return false;
    }
    // A chunk boundary can split a surrogate pair (normal for byte-chunked
    // streams). A delta ending in a lone high surrogate must not be
    // committed as-is — that invalid UTF-16 would reach subscribers and the
    // native measure pipeline — so bail to the parse path, whose repairTail
    // drops the lone half; the low half rejoins it next chunk.
    const lastUnit = delta.charCodeAt(delta.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      return false;
    }
    const blocks = this.lastBlocks;
    const last = blocks[blocks.length - 1];
    if (
      last === undefined ||
      last.kind !== 'paragraph' ||
      last.incomplete ||
      last.synthetic
    ) {
      return false;
    }
    const prevLen = this.source.length - delta.length;
    if (last.span.end !== prevLen) {
      return false;
    }
    const text = last.children[last.children.length - 1];
    if (
      text === undefined ||
      text.kind !== 'text' ||
      text.incomplete ||
      text.synthetic ||
      text.span.end !== prevLen
    ) {
      return false;
    }
    const raw = this.source.slice(text.span.start, prevLen);
    if (text.value !== raw) {
      return false;
    }
    const lineStart = this.source.lastIndexOf('\n', prevLen - 1) + 1;
    const lastLine = this.source.slice(lineStart, prevLen);
    if (
      URLISH_TAIL.test(lastLine) ||
      hasEmailTail(lastLine) ||
      HTML_OPEN_TAIL.test(lastLine)
    ) {
      return false;
    }
    // A delta introducing `scheme:` itself contains ':' (a construct char),
    // so testing the pre-delta line — exactly like URLISH_TAIL — covers
    // every way a hidden-scheme token can grow through this path.
    if (this.bareUriTailGuard !== null && this.bareUriTailGuard.test(lastLine)) {
      return false;
    }

    const end = prevLen + delta.length;
    const children = last.children.slice();
    children[children.length - 1] = {
      ...text,
      value: text.value + delta,
      span: { start: text.span.start, end },
    };
    const grown: Block = {
      ...last,
      children,
      span: { start: last.span.start, end },
    };
    const all = blocks.slice();
    all[all.length - 1] = grown;
    this.lastBlocks = all;
    // Zero repairs in flight means the committed source is the raw source,
    // so extending it by the delta keeps the invariant.
    this.commit(
      {
        source: this.current.document.source + delta,
        blocks: this.displayBlocks(all),
      },
      this.anchor,
    );
    return true;
  }

  /**
   * Advances the anchor over `blocks` (which must extend the current frozen
   * prefix): the anchor moves to the candidate boundary of the LAST block
   * that is anchor-safe, unflagged, blank-line-separated from following
   * non-blank content, and reachable with a clean fence/math scan state.
   * The scan state is carried incrementally from the current anchor, so
   * each region of the source is scanned once over the whole stream.
   */
  private advanceAnchor(blocks: Block[]): void {
    if (this.hasLinkReferenceDefinition) {
      // Nothing can be frozen once a definition is in play: it can rewrite
      // any block in the document. See `scanForLinkReferenceDefinitions`.
      return;
    }
    let scanned = this.anchor;
    let state = this.seedAtAnchor;
    let bestAnchor = -1;
    let bestIndex = -1;
    let bestState = state;
    for (let i = this.frozen.length; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.incomplete || block.synthetic || !isAnchorSafe(block)) {
        continue;
      }
      const candidate = anchorCandidate(this.source, block.span.end);
      if (candidate === null || candidate <= scanned) {
        continue;
      }
      state = continueSeed(state, this.source.slice(scanned, candidate));
      scanned = candidate;
      if (state.openFence !== null) {
        continue;
      }
      // Belt and braces: a candidate always sits after a blank line, and
      // `continueSeed` clears `inMath` there (a math span is inline and
      // cannot cross a block boundary), so this cannot fire today. It stays
      // as the guard for any future seed state that CAN reach a candidate.
      if (state.inMath && this.resolved.extensions.math) {
        continue;
      }
      bestAnchor = candidate;
      bestIndex = i;
      bestState = state;
    }
    if (bestAnchor > this.anchor) {
      this.anchor = bestAnchor;
      this.seedAtAnchor = bestState;
      // The tail is `source.slice(anchor)`, so a moved anchor renames every
      // offset in the carried repair scan. (`update` checks the recorded
      // anchor too; dropping it here is what keeps the record from outliving
      // the tail it describes.)
      this.tailScan = null;
      // Only the newly frozen blocks are appended and registered. Rebuilding
      // the prefix and re-walking ALL of it through `rememberFrozen` on every
      // advance made a stream's anchor bookkeeping quadratic in its block
      // count; the blocks below `frozen.length` are the same objects they
      // were, by the precondition above.
      for (let i = this.frozen.length; i <= bestIndex; i += 1) {
        this.frozen.push(blocks[i]);
        this.rememberFrozen(blocks[i]);
      }
    }
  }

  /**
   * Watches the source for a link reference definition (`[label]: dest`) and,
   * on the first one, switches the incremental anchor off for the rest of the
   * stream.
   *
   * Definitions act at a distance, in both directions. One arriving at the
   * END of a document turns a `[foo]` written in its first paragraph into a
   * resolved reference link — a block the anchor may long since have frozen
   * as literal text. One written EARLY turns a `[foo]` typed later into a
   * link that the anchored tail parse, which never sees the definition
   * because it sits before the anchor, would leave as literal text. Either
   * way "settled" would stop meaning settled, so the session gives up
   * freezing and reparses the whole source per append. The identity cache is
   * KEPT (`resetIncrementalState(true)`): `remember` verifies a cached block
   * structurally before reusing it, so blocks the definition did not
   * actually change keep their objects through finalize while the rewritten
   * ones are replaced.
   *
   * It has to be a source scan: md4c reports a definition through no block of
   * its own (the line simply produces nothing), so there is no node to notice
   * afterwards.
   *
   * Definitions are found behind container markers (`- [foo]: /url`,
   * `> [foo]: /url`), behind the CONTENT INDENT those containers establish
   * (a definition written at a list item's content column, with no marker of
   * its own — see {@link noteContainerIndent}), and across a line break in
   * the label (`[foo` / `bar]: /url`), because md4c honours all of those and
   * each one rewrites text above it just the same.
   *
   * Each line is examined once, and a line still growing resumes where the
   * last append left off (`refLineScanned`) rather than being re-read from
   * its start — including the paragraph line that opens with `[` and has no
   * `]` yet, which is the shape that would otherwise cost a full rescan per
   * append.
   */
  private scanForLinkReferenceDefinitions(): void {
    if (this.hasLinkReferenceDefinition) {
      return;
    }
    let lineStart = this.refScanFrom;
    for (;;) {
      const nl = this.source.indexOf('\n', lineStart);
      const line = this.source.slice(lineStart, nl === -1 ? undefined : nl);
      if (!this.refLineRuledOut) {
        const scan = linkReferenceDefinitionState(
          line,
          this.refLabelOpen,
          this.refLineScanned,
          nl !== -1,
          this.refContainerIndent,
        );
        if (scan.state === 'definition') {
          this.hasLinkReferenceDefinition = true;
          this.resetIncrementalState(true);
          return;
        }
        if (nl === -1) {
          this.refLineRuledOut = scan.state === 'no';
          // A line that is still only indentation or a half-typed marker has
          // not been READ yet, it has been measured — so the next append must
          // re-run the candidate test from column 0 rather than resume the
          // label hunt. Resuming it made a char-by-char stream answer
          // differently from a line-by-line one on the same source: '- ' seen
          // on its own left `from > 0`, which skips the "could this line even
          // be a definition" test, and `- see [a]: b` then read as one.
          this.refLineScanned =
            this.refLineRuledOut || scan.state === 'growing' ? 0 : scan.scanned;
        } else {
          // A label left open by a finished line continues on the next one.
          this.refLabelOpen = scan.state === 'open';
        }
      } else if (nl !== -1) {
        // A ruled-out line opens no label for the next one either.
        this.refLabelOpen = false;
      }
      if (nl === -1) {
        // The last line is still growing: leave the cursor on it.
        this.refScanFrom = lineStart;
        return;
      }
      this.noteContainerIndent(line);
      this.refLineRuledOut = false;
      this.refLineScanned = 0;
      lineStart = nl + 1;
    }
  }

  /**
   * Carry the container context of a FINISHED line to the next one, so a
   * definition written at a list item's content column is read at that
   * column ({@link contentStart}).
   *
   * The indent only comes DOWN on evidence that the containers really
   * closed: a non-blank line at a shallower column that follows a blank one,
   * which in CommonMark starts a new top-level block. A shallower line that
   * does NOT follow a blank one is a lazy paragraph continuation and leaves
   * every container open — dropping the indent there would put the scan back
   * to reading `    [foo]: /url` as indented code, which is the miss this
   * whole mechanism exists to prevent. Erring high only costs anchoring.
   */
  private noteContainerIndent(line: string): void {
    const blank = /^[ \t\r]*$/.test(line);
    if (!blank) {
      const content = contentStart(line, this.refContainerIndent);
      if (content >= this.refContainerIndent || this.refPrevBlank) {
        this.refContainerIndent = content;
      }
    }
    this.refPrevBlank = blank;
  }

  private parse(source: string): ParsedDocument {
    if (source === '') {
      return { source: '', blocks: [] };
    }
    return parseDocument(source, this.options, this.engine);
  }

  private blockKey(block: Block): string {
    return `${block.kind}:${block.span.start}:${block.span.end}`;
  }

  /** Registers a frozen block so finalize can restore its identity. */
  private rememberFrozen(block: Block): void {
    const key = this.blockKey(block);
    if (!this.settledBlocks.has(key)) {
      this.settledBlocks.set(key, block);
    }
  }

  /**
   * Identity cache lookup for finalize's fresh parse: a previously frozen
   * block with the same kind, span AND structure is the same parse, so the
   * frozen object is returned and settled identity survives finalize.
   *
   * The structural check is what makes "finalize equals a fresh
   * `parseDocument`" unconditional. Kind and span do not pin a block's
   * content — a construct that resolves at a distance can change what a span
   * means without moving it — and substituting a cached block that no longer
   * matches would smuggle a stale parse into the settled document. On a
   * mismatch the fresh block wins and takes over the cache entry. It costs
   * one structural walk of the settled prefix, once per stream, on a path
   * that already reparses the whole source.
   */
  private remember(block: Block): Block {
    const key = this.blockKey(block);
    const cached = this.settledBlocks.get(key);
    if (cached !== undefined && sameStructure(cached, block)) {
      return cached;
    }
    this.settledBlocks.set(key, block);
    return block;
  }

  private commit(document: ParsedDocument, settledUntil: number): void {
    this.current = {
      document,
      settledUntil,
      phase: this.phase,
      revision: ++this.revision,
    };
    this.notify();
  }

  /**
   * Hands `this.current` to every listener, in revision order even when a
   * listener mutates the session from inside its own callback.
   *
   * Delivery is a synchronous loop over the listener set, so a listener that
   * appends (or finalizes) commits revision N+1 while the outer pass is only
   * part-way through revision N. Recursing there would deliver N+1 to the
   * listeners after it and only then hand THEM the older N — a listener that
   * stores its argument would end on a stale document. The nested commit
   * therefore just marks the pass dirty; the outer loop finishes, then runs
   * again with the newest snapshot for everyone.
   *
   * Two failure modes are handled explicitly, because this loop is the one
   * place a consumer's code runs inside the session:
   *
   * - A listener that mutates on EVERY callback never lets the loop settle.
   *   Recursion used to end that in a stack overflow; a loop would simply
   *   hang, which is worse to diagnose, so `MAX_NOTIFY_PASSES` ends it with
   *   an error that names the cause.
   * - A listener that throws must not cost the listeners after it their
   *   snapshot, and must not abandon a pending pass — that would leave every
   *   other listener a revision behind `snapshot()` for good. Delivery
   *   therefore completes, and the first error is rethrown once the loop is
   *   done.
   */
  private notify(): void {
    if (this.notifying) {
      this.notifyPending = true;
      return;
    }
    this.notifying = true;
    let failure: { error: unknown } | null = null;
    try {
      let passes = 0;
      do {
        this.notifyPending = false;
        const snap = this.current;
        if (snap === null) {
          // Unreachable: `notify` is only ever called by `commit`, which has
          // just assigned it.
          break;
        }
        passes += 1;
        if (passes > MAX_NOTIFY_PASSES) {
          throw new Error(
            `StreamSession: a subscriber kept mutating the session from its own callback for ${MAX_NOTIFY_PASSES} rounds of notifications. A listener that appends, replaces or finalizes on every snapshot never terminates — mutate conditionally, or schedule the mutation outside the callback.`,
          );
        }
        for (const fn of [...this.listeners]) {
          try {
            fn(snap);
          } catch (error) {
            failure ??= { error };
          }
        }
      } while (this.notifyPending);
    } finally {
      this.notifying = false;
      this.notifyPending = false;
    }
    if (failure !== null) {
      throw failure.error;
    }
  }
}
