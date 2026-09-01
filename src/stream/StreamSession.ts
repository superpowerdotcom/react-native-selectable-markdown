import type { Block, ParsedDocument } from '../document/nodes';
import { visit } from '../document/visit';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions, ResolvedEngineOptions } from '../engine/options';
import { resolveOptions } from '../engine/options';
import { trimTrailingPlaceholders } from './placeholders';
import type { RepairOptions, RepairSeed } from './repair';
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
   * rendering and being repaired a frame later. Never splits a surrogate
   * pair: the boundary moves one unit down so the pair stays pending.
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
   * answer, keeps the cut surrogate-safe, and keeps a flush scheduled while
   * releasable text remains, so the drain continues at the scheduler's
   * cadence with no further input. Only scheduled flushes are smoothed:
   * every synchronous drain
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
 * A trailing token that is (or is growing into) a bare autolink candidate.
 * Once "https:" or "www." sits anywhere in the last whitespace-delimited
 * token of the line, even a plain letter can complete or re-extend an
 * autolink (`https://example.` + `c` pulls the trimmed `.` back into the
 * URL), so the fast path must stand down and let the engine decide. Tested
 * against the raw source's final line, not just the final text node — the
 * token may span an already-emitted autolink node plus trimmed punctuation.
 */
const URLISH_TAIL = /(?:^|[\s*_~(])(?:https?:|www\.)\S*$/i;

/**
 * A line that is (so far) just an HTML-block opener stub: `<`, `</`, `<!`
 * or `<?` after up to three spaces. The very next letter would flip the
 * line from paragraph text into an HTML block (`<` parses as a paragraph,
 * `<h` starts an HTML block), so the fast path must stand down.
 */
const HTML_OPEN_TAIL = /^ {0,3}<[!/?]?$/;

/**
 * Block kinds that may anchor the frozen prefix. Appending text after a
 * blank line can never merge back into any of these:
 * paragraphs/headings/tables/blockquotes/HTML blocks all terminate at a
 * blank line, thematic breaks are single lines, and a closed fence ends at
 * its closing fence line.
 *
 * Deliberately excluded:
 * - `list` — a blank line does not end a list: an indented line after the
 *   blank continues the item, and a following `- b` merges into the same
 *   list while flipping it tight→loose;
 * - `codeBlock` with `fenced: false` — indented code spans blank lines;
 * - `codeBlock` with `closed: false` — still consuming everything.
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
    case 'htmlBlock':
      return true;
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
 * `appendBuffered` is the opt-in coalescing entry point for token streams
 * that outpace frames: deltas pool in a pending buffer and one scheduled
 * flush appends them together (minus an optional `holdBackChars` tail that
 * hides half-typed constructs; see `StreamSessionInit`). An optional
 * `smoother` meters how much of that buffer each flush releases (typewriter
 * pacing; see `smoothing.ts`), with the session re-scheduling flushes until
 * the buffer drains. Every synchronous operation drains the buffer first,
 * so `append`/`replace`/`finalize` semantics are unchanged and ordering is
 * preserved.
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
  /** Callers awaiting `drained()`; resolved whenever `pending` empties. */
  private drainedResolvers: Array<() => void> = [];

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
   */
  drained(): Promise<void> {
    if (this.pending === '') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainedResolvers.push(resolve);
    });
  }

  /**
   * Run-end lifecycle passthrough to the smoother: the stream feeding this
   * session is over, so a policy with a run-end drain (see
   * `AdaptiveSmoother.notifyRunFinalized`) switches to it — a short
   * remaining tail releases instantly, a longer one races a bounded
   * deadline instead of trailing out at the steady pacing rate. Call it
   * when there is pending text to drain, before awaiting `drained()`; a
   * no-op for sessions without a smoother or with a policy that has no
   * lifecycle method. Timestamped on this session's clock, so the policy
   * and the per-flush `SmootherContext.now` stay on one timeline.
   */
  notifyRunFinalized(): void {
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
   * Appends a delta; an empty delta is a no-op. Any pending `appendBuffered`
   * text is drained (appended synchronously) first, so mixing the two entry
   * points can never reorder the stream.
   */
  append(delta: string): void {
    this.drainPending();
    this.appendNow(delta);
  }

  /**
   * `append` minus the pending-buffer drain: the one path that actually
   * mutates the source. The buffered flush comes through here so it cannot
   * recursively re-drain the buffer it is flushing.
   */
  private appendNow(delta: string): void {
    if (delta === '') {
      return;
    }
    this.source += delta;
    this.phase = 'streaming';
    this.update(delta);
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
    if (delta === '') {
      return;
    }
    this.pending += delta;
    // New input means the stream is not stalled; the flush below re-arms the
    // idle drain if it again leaves held-back characters behind.
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
    this.drainPending();
  }

  /**
   * Prefix-diff replace: if `full` starts with the current text, append
   * the remainder; otherwise reset the session to `full`. Pending
   * `appendBuffered` text is drained first — the diff runs against
   * everything the caller has streamed, not a flush-timing-dependent prefix
   * of it.
   */
  replace(full: string): void {
    this.drainPending();
    if (full === this.source) {
      return;
    }
    if (full.startsWith(this.source)) {
      this.append(full.slice(this.source.length));
      return;
    }
    this.source = full;
    this.resetIncrementalState();
    this.phase = 'streaming';
    this.update(null);
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
    if (full === this.source + this.pending) {
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
    this.drainPending();
    if (this.phase === 'settled') {
      return;
    }
    this.phase = 'settled';
    // One last full clean parse of the raw source (O(n), once per stream);
    // previously frozen blocks are swapped back in by span identity so
    // settled content survives finalize with the same object references.
    const doc = this.parse(this.source);
    const blocks = doc.blocks.map((b) => this.remember(b));
    this.lastBlocks = blocks;
    this.lastRepairClean = true;
    this.advanceAnchor(blocks);
    this.commit({ source: doc.source, blocks }, this.source.length);
  }

  /**
   * The latest committed snapshot. Reflects only appended text: deltas
   * sitting in the `appendBuffered` pending buffer appear in no snapshot
   * until their flush.
   */
  snapshot(): SessionSnapshot {
    if (this.current) {
      return this.current;
    }
    return {
      document: { source: '', blocks: [] },
      settledUntil: 0,
      phase: this.phase,
      revision: this.revision,
    };
  }

  subscribe(fn: (s: SessionSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private resetIncrementalState(): void {
    this.anchor = 0;
    this.seedAtAnchor = CLEAN_SEED;
    this.frozen = [];
    this.lastBlocks = [];
    this.lastRepairClean = true;
    this.settledBlocks.clear();
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
    this.pending = '';
    this.appendNow(held);
    this.noteExternalDrain();
    this.resolveDrained();
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
   * Moves a proposed cut into `this.pending` down one unit when it would
   * land between a high and low surrogate, so the pair stays pending
   * (offsets are UTF-16 and repairs assume unsplit pairs).
   */
  private surrogatePairSafeCut(cut: number): number {
    if (cut > 0 && cut < this.pending.length) {
      const hi = this.pending.charCodeAt(cut - 1);
      const lo = this.pending.charCodeAt(cut);
      if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
        return cut - 1;
      }
    }
    return cut;
  }

  /**
   * True when the code point starting at `index` in `this.pending` extends
   * the code point before it into one visible glyph: a variation selector
   * (U+FE00–U+FE0F — VS16 turns '❤' into the emoji-presentation '❤️') or a
   * skin-tone modifier (U+1F3FB–U+1F3FF). A cut landing just before an
   * extender splits base from modifier, so the retreat below must treat
   * base + extenders as one unit — without this, the ZWJ walk on '❤️‍🔥'
   * stops between the '❤' and its VS16 and commits a bare
   * text-presentation heart.
   */
  private isExtenderAt(index: number): boolean {
    const unit = this.pending.charCodeAt(index);
    if (unit >= 0xfe00 && unit <= 0xfe0f) {
      return true;
    }
    const lo = this.pending.charCodeAt(index + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      const cp = (unit - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
      return cp >= 0x1f3fb && cp <= 0x1f3ff;
    }
    return false;
  }

  /**
   * Surrogate- AND cluster-safe cut into `this.pending`. Beyond the pair
   * rule, a cut landing immediately before or after a U+200D would split an
   * emoji ZWJ sequence — and one landing before a variation selector or
   * skin-tone modifier would split a base from its extender: released text
   * cannot be recalled, so the committed half paints as its own glyph —
   * releasing half a family emoji, or the bare '❤' out of '❤️‍🔥', is the
   * bug. The cut therefore moves DOWN (never up — pending text must stay
   * joined, and a full-buffer release is the drain's job, not a cut's) past
   * each adjacent joiner, extender, and the code point it glues, re-applying
   * the pair rule after every step, until the whole cluster stays pending.
   * Each iteration retreats at least one unit, so the walk is O(cluster
   * length) and bounded by the cluster's own extent.
   */
  private surrogateSafeCut(cut: number): number {
    cut = this.surrogatePairSafeCut(cut);
    const ZWJ = 0x200d;
    while (cut > 0 && cut < this.pending.length) {
      if (this.isExtenderAt(cut)) {
        // Between a base and its extender (VS16, skin tone): retreat past
        // the base so the glued pair stays pending together. Also the step
        // that finishes the ZWJ branch below when the glued element
        // carries extenders — '❤️‍🔥' retreats joiner → VS16 → base.
        cut = this.surrogatePairSafeCut(cut - 1);
      } else if (this.pending.charCodeAt(cut) === ZWJ) {
        // Between the joiner and the code point it glues to the left:
        // retreat past that code point so both stay pending together.
        cut = this.surrogatePairSafeCut(cut - 1);
      } else if (this.pending.charCodeAt(cut - 1) === ZWJ) {
        // Just past the joiner — the released text would END in a lone
        // ZWJ: retreat past it (the next iteration retreats past what it
        // glues).
        cut -= 1;
      } else {
        break;
      }
    }
    return cut;
  }

  /**
   * The scheduled flush: append the pending text up to the trailing
   * `holdBackChars` characters — or less, when a `smoother` meters the
   * release (its answer is clamped and made surrogate-safe; a non-finite
   * answer releases everything releasable). Whichever text a flush leaves
   * behind is never stranded: while releasable text remains the next flush
   * is scheduled immediately, so a smoothed drain keeps its cadence with no
   * further input, and once only the holdback tail is left the idle drain
   * takes over.
   */
  private flushHeld(): void {
    if (this.inFlush) {
      // A synchronous BufferScheduler fired the re-scheduled flush from
      // inside this very flush; without a real frame between calls a
      // smoother has no time base, so the outer call falls back to the
      // idle drain rather than looping synchronously.
      return;
    }
    const cut = this.surrogateSafeCut(this.pending.length - this.holdBackChars);
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
      // sourceLength + pendingLength is the total text arrived — the
      // monotone signal an adaptive smoother's arrival tracker samples.
      const context: SmootherContext = {
        now: this.now(),
        pendingLength: this.pending.length,
        sourceLength: this.source.length,
      };
      const want = this.smoother(this.pending.slice(0, cut), context);
      take = Number.isFinite(want)
        ? this.surrogateSafeCut(Math.min(cut, Math.max(0, Math.floor(want))))
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
        this.pending = this.pending.slice(take);
        this.appendNow(ready);
      }
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
        }
      } else {
        this.armIdleDrain();
      }
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
   * budget refill. The snap lands just past `)` (a BMP unit), so the cut
   * stays surrogate-safe, and the skipped characters are deliberately not
   * charged to the smoother — catch-up over invisible text must not indebt
   * the visible tail into a pause.
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
    return Math.min(cut, snapped - contextTail.length);
  }

  private resolveDrained(): void {
    if (this.pending !== '' || this.drainedResolvers.length === 0) {
      return;
    }
    const resolvers = this.drainedResolvers;
    this.drainedResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private armIdleDrain(): void {
    this.clearIdleDrain();
    this.cancelIdleDrain = this.idleScheduler(() => {
      this.cancelIdleDrain = null;
      this.drainPending();
    }, this.holdIdleMs);
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
    const repaired = repairTail(tail, CLEAN_SEED, this.resolved, this.repairOptions);
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
    if (trimmed === tail && this.frozen.length === 0) {
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
   * - the text does not end in a growing autolink candidate, nor (when
   *   `repair.hideBareUriSchemes` is set) in a token a listed scheme's
   *   hide may be about to blank.
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
    if (URLISH_TAIL.test(lastLine) || HTML_OPEN_TAIL.test(lastLine)) {
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
    const all = [...blocks.slice(0, -1), grown];
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
      this.frozen = blocks.slice(0, bestIndex + 1);
      for (const block of this.frozen) {
        this.rememberFrozen(block);
      }
    }
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
   * Identity cache lookup for finalize's fresh parse: a block with the same
   * kind and span as a previously frozen block is the same parse (the
   * source is append-only; a diverging replace clears the cache), so the
   * frozen object is returned and settled identity survives finalize.
   */
  private remember(block: Block): Block {
    const key = this.blockKey(block);
    const cached = this.settledBlocks.get(key);
    if (cached) {
      return cached;
    }
    this.settledBlocks.set(key, block);
    return block;
  }

  private commit(document: ParsedDocument, settledUntil: number): void {
    const snap: SessionSnapshot = {
      document,
      settledUntil,
      phase: this.phase,
      revision: ++this.revision,
    };
    this.current = snap;
    for (const fn of [...this.listeners]) {
      fn(snap);
    }
  }
}
