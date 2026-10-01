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
 * glyph: the whole cluster stays pending.
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

/** Four doublings: 16 idle delays, 4s at the default. */
const MAX_DRAIN_BACKOFF_STEPS = 4;

/** Bounded so an engine that always throws cannot strand `drained()`. */
const MAX_DRAIN_RETRIES = 8;

/** Bounds a listener that mutates the session unconditionally. */
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

/** md4c's `scheme_map`; `incremental.test.ts` fails if this falls behind. */
const PERMISSIVE_AUTOLINK_SCHEMES = ['http', 'https', 'ftp'];

/**
 * A trailing token that is (or is growing into) a bare autolink candidate.
 * Even a plain letter can re-extend one (`https://example.` + `c`). Tested on
 * the raw final line, which may span an emitted autolink plus trimmed
 * punctuation.
 */
const URLISH_TAIL = new RegExp(
  `(?:^|[\\s*_~(])(?:(?:${PERMISSIVE_AUTOLINK_SCHEMES.join('|')}):|www\\.)\\S*$`,
  'i',
);

/**
 * The email half of GFM autolinks, which `URLISH_TAIL` cannot see:
 * `foo@example.` + `c` becomes a link with no construct character. Two native
 * scans, because a regex here backtracks on every '@'-free line.
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
 * md4c's start conditions for HTML block types 1-4
 * (`md_is_html_block_start_condition`), in its order, which differ from
 * CommonMark: type 1 needs no delimiter after the name, and type 4 takes `<!`
 * plus any ASCII, so type 5 is unreachable.
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

/** A literal matching no row is type 6 or 7, which a blank line ends. */
function htmlBlockClosed(literal: string): boolean {
  for (const [opener, ender] of HTML_BLOCK_END_CONDITIONS) {
    if (opener.test(literal)) {
      return ender.test(literal);
    }
  }
  return true;
}

const CONTAINER_PREFIX = /^ {0,3}(?:(?:>[ \t]?)+|(?:[-+*]|\d{1,9}[.)])[ \t]+)/;

const PARTIAL_CONTAINER = /^ {0,3}(?:[-+*>]|\d{1,9}[.)]?)?[ \t]*$/;

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
 * Strips the open containers' content indent before any marker: a definition
 * at an item's content column has no marker, and read from column 0 it looks
 * like indented code.
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

interface ReferenceFence {
  marker: string;
  length: number;
  indent: number;
  quotes: number;
}

function referenceFenceLine(
  line: string,
  previous: ReferenceFence | null,
  containerIndent: number,
): { fence: ReferenceFence | null; code: boolean } {
  if (previous !== null) {
    let offset = 0;
    let quotes = 0;
    while (quotes < previous.quotes) {
      const quote = /^[ \t]*>[ \t]?/.exec(line.slice(offset));
      if (!quote) break;
      offset += quote[0].length;
      quotes += 1;
    }
    while (offset < previous.indent && /[ \t]/.test(line[offset] ?? '')) offset += 1;
    const blank = /^[ \t\r]*$/.test(line);
    if (quotes === previous.quotes && (offset >= previous.indent || blank)) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line.slice(offset));
      const closed = closer !== null && closer[1][0] === previous.marker && closer[1].length >= previous.length;
      return { fence: closed ? null : previous, code: true };
    }
  }
  const offset = contentStart(line, containerIndent);
  const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.slice(offset));
  if (!opener || (opener[1][0] === '`' && opener[2].includes('`'))) {
    return { fence: null, code: false };
  }
  return {
    fence: {
      marker: opener[1][0], length: opener[1].length, indent: offset,
      quotes: (line.slice(0, offset).match(/>/g) ?? []).length,
    },
    code: true,
  };
}

/** No content column is this deep, and a candidate is re-read every append. */
const GROWING_PREFIX_LIMIT = 64;

/**
 * `'definition'` completes `[label]:`; `'open'` has a label a later line may
 * close; `'growing'` may still become one as this line arrives; `'no'` cannot.
 * `scanned` is where the next scan of the line may resume, so an open label is
 * not re-read end to end on every append.
 *
 * Errs toward `'definition'` (empty labels, labels md4c rejects, any resumed
 * open label): that costs anchoring, never correctness.
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
        // Unterminated, this "blank line" is just the newline that landed.
        return { state: terminated ? 'no' : 'growing', ...whole };
      }
      i = content;
    } else {
      const open = /^ {0,3}\[/.exec(rest);
      if (open === null) {
        // A fourth space past the content column is indented code; the length
        // bound stops an indentation-only line from being re-read forever.
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
      i += 1;
      continue;
    }
    if (line[i] !== ']') {
      continue;
    }
    if (i + 1 >= line.length) {
      return { state: 'open', scanned: i };
    }
    // The ':' must follow at once; a later ']' cannot open a second label.
    return { state: line[i + 1] === ':' ? 'definition' : 'no', ...whole };
  }
  // Resume one back: a trailing backslash or ']' depends on what comes next.
  return { state: 'open', scanned: Math.max(from, line.length - 1) };
}

/**
 * Only `finalize` calls this, to verify a cached settled block. Iterative:
 * depth is model-controlled.
 */
function sameStructure(a: unknown, b: unknown): boolean {
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
 *   span blank lines (see {@link HTML_BLOCK_END_CONDITIONS}).
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
   * `repairTail`'s carry-forward scan, valid only for its `anchor`; anything
   * but a plain append clears it.
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
  private pendingEndKnown = false;
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
  private suspended = false;
  /** Consecutive drains the engine refused; backs off the retry timer. */
  private drainFailures = 0;
  /**
   * Set after {@link MAX_DRAIN_RETRIES} refused drains: no retry is armed and
   * `drained()` rejects until a drain succeeds or new buffered input arrives.
   */
  private drainAbandoned: unknown = null;
  private notifying = false;
  /**
   * A listener committed re-entrantly: deliver it in another pass instead of
   * overtaking the listeners the outer pass has not reached.
   */
  private notifyPending = false;
  /** Always a line start: the first line the definition scan left open. */
  private refScanFrom = 0;
  private refFence: ReferenceFence | null = null;
  /** True when the partial line at `refScanFrom` can no longer open one. */
  private refLineRuledOut = false;
  /** How far into the line at `refScanFrom` the label scan has already got. */
  private refLineScanned = 0;
  /** True when a `[label` opened on an earlier line is still unterminated. */
  private refLabelOpen = false;
  /** Content column of the containers open above `refScanFrom`. */
  private refContainerIndent = 0;
  private refPrevBlank = true;
  /** Once set, the incremental anchor stays off for the rest of the stream. */
  private hasLinkReferenceDefinition = false;
  /** One object, so `useSyncExternalStore` cannot spin before a commit. */
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
   * Rejects with the engine's error once {@link MAX_DRAIN_RETRIES} scheduled
   * drains in a row threw. Nothing is dropped: an explicit drain or new
   * buffered input tries the tail again.
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
   * run end, before awaiting `drained()`. It also releases the final complete
   * cluster without waiting for another delta or the idle timer. With nothing
   * pending it is a no-op. Timestamped on this session's clock, so the policy
   * and the per-flush `SmootherContext.now` stay on one timeline.
   *
   * Not forwarded when empty: a drain-armed policy with no flush to reset it
   * would pace the next run's first flush as a run-end drain.
   */
  notifyRunFinalized(): void {
    if (this.disposed || this.pending === '') {
      return;
    }
    this.pendingEndKnown = true;
    this.smoother?.notifyRunFinalized?.(this.now());
    this.clearIdleDrain();
    this.scheduleFlush();
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
   * Atomic up to its commit through {@link captureState}: a throwing parse
   * is rolled back, a throwing subscriber is not.
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
    this.pendingEndKnown = false;
    // New input means the stream is not stalled, and is a fresh attempt at a
    // tail the session may have given up on.
    this.drainAbandoned = null;
    this.drainFailures = 0;
    this.clearIdleDrain();
    this.scheduleFlush();
  }

  /** Schedules the coalesced flush; a no-op while one is already scheduled. */
  private scheduleFlush(): void {
    if (this.disposed || this.suspended || this.cancelScheduledFlush !== null) {
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
   * Atomic up to its commit like `appendNow`, identity cache included.
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
    this.refScanFrom = 0;
    this.refFence = null;
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
      this.pendingEndKnown = false;
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
      // again leaves held-back characters behind); restart the retry ladder.
      this.drainAbandoned = null;
      this.drainFailures = 0;
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
    const restore = this.captureState();
    try {
      const doc = this.parse(this.source);
      // After the parse: a throwing engine must leave the session streaming.
      this.phase = 'settled';
      const blocks = doc.blocks.map((b) => this.remember(b));
      this.lastBlocks = blocks;
      this.lastRepairClean = true;
      this.tailScan = null;
      // Re-adopt the fresh objects so a resumed stream splices `lastBlocks`.
      if (this.frozen.length > 0) {
        this.frozen = blocks.slice(0, this.frozen.length);
      }
      this.advanceAnchor(blocks);
      this.commit({ source: doc.source, blocks }, this.source.length);
    } catch (error) {
      // A no-op past the commit (see {@link captureState}).
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
   * Registers a snapshot listener and returns its unsubscribe, in the
   * `useSyncExternalStore` subscribe shape.
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

  /** Stops scheduled work while retaining the snapshot and buffered input. */
  suspend(): void {
    this.suspended = true;
    this.clearScheduledFlush();
    this.clearIdleDrain();
  }

  /** Resumes buffered work after a hidden view's effects reconnect. */
  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    if (this.pending !== '') this.scheduleFlush();
  }

  /**
   * Ends the session and releases everything it holds. Idempotent.
   *
   * DROPS pending `appendBuffered` text, resolves every `drained()` promise
   * and drops every subscriber. Afterwards every mutator is a no-op, while
   * `snapshot()`, `length` and `parseContext` keep the last committed state.
   * To keep the tail, call `flushBuffered()` or `finalize()` first.
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
    this.resetIncrementalState();
    this.resolveDrained();
  }

  /**
   * Unfreezes everything: the next update reparses the whole source.
   *
   * `keepIdentityCache` is for invalidating the anchor, not the text:
   * `remember` re-verifies cached blocks before reusing them.
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
   * undo is a no-op once a commit lands: a subscriber's throw must not roll
   * the document back. Only the divergent `replace`, the one path that clears
   * the settled-block map, needs `includeIdentityCache`.
   */
  private captureState(includeIdentityCache = false): () => void {
    const revisionBefore = this.revision;
    const source = this.source;
    const phase = this.phase;
    const anchor = this.anchor;
    const seedAtAnchor = this.seedAtAnchor;
    const frozen = this.frozen;
    // `advanceAnchor` grows `frozen` in place, so its length is state too.
    const frozenLength = frozen.length;
    const lastBlocks = this.lastBlocks;
    const lastRepairClean = this.lastRepairClean;
    const tailScan = this.tailScan;
    const refScanFrom = this.refScanFrom;
    const refFence = this.refFence;
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
      this.refFence = refFence;
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
      // Rolled back, the text never landed; past the commit, it did.
      if (this.source.length === sourceLength) {
        this.pending = held;
        // Both timers were cleared on entry: without a backed-off retry the
        // tail is stranded and `drained()` never settles.
        this.drainFailures += 1;
        if (this.drainFailures > MAX_DRAIN_RETRIES) {
          this.abandonDrain(error);
        } else {
          this.armIdleDrain(this.retryDelay());
        }
      } else if (this.pending === '') {
        this.noteExternalDrain();
        this.resolveDrained();
      }
      throw error;
    }
    this.noteExternalDrain();
    this.resolveDrained();
  }

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
   * Only the metered flush settles; unmetered releases report through
   * {@link noteExternalDrain}.
   */
  private settleSmoother(released: number): void {
    this.smoother?.notifyReleased?.(released);
  }

  /**
   * Moves the cut down only, judged with the committed text, and holds back a
   * last cluster the next delta could extend (see
   * {@link retreatToStreamBoundary}).
   */
  private clusterSafeCut(cut: number): number {
    return retreatToStreamBoundary(this.source, this.pending, cut, !this.pendingEndKnown);
  }

  /**
   * The scheduled flush: append the pending text up to the trailing
   * `holdBackChars` characters, or less when a `smoother` meters it. Leftover
   * releasable text schedules the next flush; a holdback-only tail falls to
   * the idle drain.
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
      // sourceLength + pendingLength is the total text arrived.
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
          // Same atomicity as `drainPending`. Settle either way, or a budget
          // policy keeps a phantom charge.
          if (this.source.length === sourceLength) {
            this.pending = ready + this.pending;
            this.settleSmoother(0);
          } else {
            // A subscriber threw past the commit: the text landed in full.
            this.settleSmoother(take);
          }
          throw error;
        }
      }
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
          // A cut parked inside an unfinished cluster retreats to 0 every
          // frame. Arm the idle drain once as the backstop: re-arming every
          // frame would push its deadline out of reach.
          if (this.cancelIdleDrain === null) {
            this.armIdleDrain();
          }
        } else {
          // Progress: a drain armed by an earlier stall must not dump the rest.
          this.clearIdleDrain();
        }
      } else {
        this.armIdleDrain();
      }
    } catch (error) {
      // The re-schedule branches above never ran, so without a timer the held
      // text is stranded and `drained()` never settles.
      if (this.pending !== '') {
        this.armIdleDrain();
      } else {
        if (metered !== null && take > metered) this.noteExternalDrain();
        this.resolveDrained();
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
   * any other, and the skipped characters are not charged to the smoother.
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

  /** The text stays in `pending`; see {@link drained}. */
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
    if (this.disposed || this.suspended) return;
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
    // Before the anchor: a definition can change how text anywhere parses,
    // frozen blocks included.
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
      // `all` is always frozen ++ tail, so it already is the answer.
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
      // A moved anchor renames every offset in the carried repair scan.
      this.tailScan = null;
      // Blocks below `frozen.length` are unchanged, so register only new ones.
      for (let i = this.frozen.length; i <= bestIndex; i += 1) {
        this.frozen.push(blocks[i]);
        this.rememberFrozen(blocks[i]);
      }
    }
  }

  /**
   * On the first link reference definition, switches the incremental anchor
   * off for the rest of the stream: a definition rewrites a `[foo]` before or
   * after it, frozen blocks included. A source scan, because md4c emits no
   * node for a definition. A growing line resumes at `refLineScanned`.
   */
  private scanForLinkReferenceDefinitions(): void {
    if (this.hasLinkReferenceDefinition) {
      return;
    }
    let lineStart = this.refScanFrom;
    for (;;) {
      const nl = this.source.indexOf('\n', lineStart);
      if (this.refLineRuledOut && nl === -1) {
        this.refScanFrom = lineStart;
        return;
      }
      const line = this.source.slice(lineStart, nl === -1 ? undefined : nl);
      const fence = referenceFenceLine(line, this.refFence, this.refContainerIndent);
      if (nl !== -1) this.refFence = fence.fence;
      if (fence.code) {
        this.refLabelOpen = false;
        if (nl === -1) this.refLineRuledOut = true;
      } else if (!this.refLineRuledOut) {
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
          // An indentation-only line was measured, not read: re-test it from
          // column 0 on the next append.
          this.refLineScanned =
            this.refLineRuledOut || scan.state === 'growing' ? 0 : scan.scanned;
        } else {
          this.refLabelOpen = scan.state === 'open';
        }
      } else if (nl !== -1) {
        this.refLabelOpen = false;
      }
      if (nl === -1) {
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
   * The indent only drops after a blank line: a shallower line without one is
   * a lazy continuation, and erring high only costs anchoring.
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
   * Kind and span alone do not pin content: a construct resolving at a
   * distance can change what a span means without moving it.
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
      document: { ...document, blocks: document.blocks.slice() },
      settledUntil,
      phase: this.phase,
      revision: ++this.revision,
    };
    this.notify();
  }

  /**
   * Hands `this.current` to every listener in revision order: a re-entrant
   * commit marks the pass dirty instead of recursing, so no listener ends on
   * an older revision. A throwing listener does not cost the others their
   * snapshot; the first error is rethrown after delivery.
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
          // Unreachable: only `commit` calls this, right after assigning it.
          break;
        }
        passes += 1;
        if (passes > MAX_NOTIFY_PASSES) {
          if (failure !== null) throw failure.error;
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
