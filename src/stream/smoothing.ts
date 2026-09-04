/**
 * Smoothing: metered release for `appendBuffered` flushes.
 *
 * A `Smoother` is the injectable release policy behind
 * `StreamSessionInit.smoother`. Each scheduled flush hands it the releasable
 * pending text (everything pooled by `appendBuffered`, minus the
 * `holdBackChars` tail) and it answers with how many UTF-16 units to release
 * this flush. Returning less than everything keeps a flush scheduled, so the
 * drain continues at the scheduler's cadence — one call per frame under the
 * default `requestAnimationFrame` scheduler — with no further input. That is
 * the whole contract; the session owns clamping, cluster safety, and the
 * ordering invariant (synchronous drains bypass the smoother entirely, so
 * smoothing can never reorder or strand text — see `StreamSession`).
 *
 * `createSmoother` builds the standard policy: a characters-per-second
 * budget, optionally cut at word boundaries, with a hard bound on how far
 * the visible text may lag the stream. `createAdaptiveSmoother` builds the
 * jitter-buffer policy: pre-buffer, arrival-rate-tracked release, run-end
 * drain. Policies are stateful (they carry a clock and a budget), so create
 * one per session — never share an instance.
 */

// The label test `skipUriLikeLabels` snaps on. Imported rather than
// re-declared: `repair.ts` exports it precisely so the playout layers agree
// with the repair on which labels are invisible, and two copies of the same
// regex is exactly the drift that contract exists to prevent.
import { advanceToClusterBoundary } from './clusters';
import { isUriLikeLabel } from './repair';

/**
 * Release policy for scheduled `appendBuffered` flushes. Called once per
 * flush with the releasable pending text; returns how many UTF-16 units to
 * release now. The session clamps the answer to `[0, releasable.length]`,
 * moves it down to a cluster boundary if it would split one visible glyph,
 * and treats a non-finite answer as "release everything".
 *
 * The optional `context` describes the stream at the moment of the flush.
 * Fixed-rate policies ignore it (a one-parameter smoother remains a valid
 * `Smoother`); an adaptive policy samples it for arrival tracking, and falls
 * back to its own clock when a caller doesn't pass one.
 *
 * The session also makes one ZERO-OFFER call — empty releasable text,
 * `context.pendingLength` 0 — after any release that emptied the buffer
 * without consulting the policy (a synchronous drain, the idle drain, a
 * link snap). The answer is irrelevant (nothing is pending); the call
 * exists so a stateful policy can re-base its clock and reset any
 * released-state memory instead of concluding, at the next flush, that
 * text sat stranded through the gap.
 *
 * `notifyRunFinalized` is the optional run-end lifecycle channel: a policy
 * with a bounded run-end drain (see `AdaptiveSmoother`) implements it, and
 * `StreamSession.notifyRunFinalized` forwards to it on the session's clock.
 * A plain pacing function remains a valid `Smoother` without it.
 *
 * `notifyReleased` is the optional settlement channel, called once per
 * metered flush with the number of units the session ACTUALLY released.
 * That is rarely the answer: the cluster-safe retreat releases less when the
 * cut lands inside one visible glyph (possibly nothing at all), and the link
 * snap releases more, budget-free. A policy that charges a budget for its
 * own answer must implement this and settle up, or a glyph it cannot yet
 * afford charges it every frame and the reveal stalls for good —
 * `createSmoother` does. A stateless pacing function needs nothing.
 */
export type Smoother = ((
  releasable: string,
  context?: SmootherContext,
) => number) & {
  notifyRunFinalized?(now?: number): void;
  notifyReleased?(released: number): void;
};

/** Stream state handed to a `Smoother` at each flush. */
export interface SmootherContext {
  /** Flush time in ms, on the caller's clock. A policy that also carries its
   * own clock (`AdaptiveSmootherOptions.now`) prefers this one, so the
   * session and the policy stay on a single timeline. */
  now: number;
  /** UTF-16 length of the FULL pending buffer at call time — including any
   * `holdBackChars` tail beyond the releasable slice this call was handed. */
  pendingLength: number;
  /** UTF-16 length of the committed source (everything already released into
   * the document). `sourceLength + pendingLength` is therefore the total text
   * that has arrived so far — the signal an arrival-rate tracker samples. It
   * only grows while text is appended, but it is not guaranteed monotone:
   * `StreamSession.rewrite` swaps the unrevealed tail for a shorter one (the
   * citation rewrite `[ApoB](fhir://…)` → `ApoB [1](#…)` shrinks it on every
   * completion), and `replace` can shorten it for good, which lowers the
   * pair. A tracker must therefore REBASE when it sees a drop — subtract it
   * from the history the window still holds, as `createAdaptiveSmoother`
   * does — so the next sample measures real arrival again. Sampling the dip
   * raw reads as negative arrival and depresses the estimate for a whole
   * rate window; merely clamping to a high-water mark depresses it for
   * longer still, because arrival then has to re-fill the deleted region
   * before the series moves at all. */
  sourceLength: number;
}

export interface SmootherOptions {
  /** Reveal rate, in UTF-16 code units per second. Must be positive. */
  charsPerSecond: number;
  /**
   * Where release cuts may land (default 'char'). 'word' only releases up
   * to a whitespace boundary, so words appear whole: a word longer than the
   * accrued budget is released at once and paid off as a pause afterwards,
   * which keeps the average rate honest.
   *
   * Only meaningful for space-delimited scripts. Text written without
   * spaces — Chinese, Japanese, Thai, Lao, Khmer — has no whitespace to cut
   * at, so once the current "word" runs more than ~32 units past the
   * accrued budget this mode degrades to 'char' instead of dumping the whole
   * buffer in one flush and freezing while the debt repays; the same guard
   * bounds an over-long word in any script (a long URL). Pick 'char'
   * outright for text that is mostly not space-delimited.
   */
  boundary?: 'char' | 'word';
  /**
   * Hard bound on how many releasable characters may remain unrevealed
   * (default Infinity). When a burst — a reconnect catch-up, a multi-KB
   * chunk — puts the backlog past this, the excess is released immediately
   * and free of budget, so the tail types out at `charsPerSecond` from at
   * most `maxLagChars` behind instead of minutes behind.
   */
  maxLagChars?: number;
  /** Clock (ms). Injectable for tests; default `Date.now`. */
  now?: () => number;
}

/**
 * Gaps between flushes longer than this credit only this much budget. Flushes
 * only run while text is pending, so a longer gap is a stream stall, not
 * render lag — crediting it in full would let a burst after silence dump
 * seconds of accrued budget in one frame instead of typing out at the rate.
 * The same value caps the standing budget a trickle can hoard.
 */
const MAX_CREDIT_MS = 100;

/**
 * How far past the accrued budget `boundary: 'word'` may overdraw to finish
 * a word. Long enough for any real word (the longest words in common use are
 * around 20 units, and the overdraw is measured on top of whatever budget
 * already accrued); short enough that a whitespace-free run — a script
 * written without spaces, a bare URL — cannot be dumped in one flush.
 */
const WORD_OVERDRAW_LIMIT = 32;

/**
 * The standard rate-based `Smoother`. Stateful — one instance per session.
 *
 * Charges its budget for the answer it gives, then settles up through
 * `notifyReleased` with what the session really released — the retreat off a
 * cluster boundary can be as little as nothing. A driver that meters with
 * this policy but never settles (a hand-rolled loop) still paces correctly
 * on plain text; it can stall on a glyph wider than one credit window.
 */
export function createSmoother(options: SmootherOptions): Smoother {
  const rate = options.charsPerSecond;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `createSmoother: charsPerSecond must be a positive finite number, got ${rate}`,
    );
  }
  const boundary = options.boundary ?? 'char';
  const maxLag = options.maxLagChars ?? Infinity;
  if (Number.isNaN(maxLag) || maxLag < 0) {
    throw new Error(
      `createSmoother: maxLagChars must be non-negative, got ${options.maxLagChars}`,
    );
  }
  const now = options.now ?? Date.now;
  /** Standing budget may not exceed one credit window (but at least 1 char). */
  const budgetCap = Math.max(1, rate * (MAX_CREDIT_MS / 1000));
  let last: number | null = null;
  let budget = 0;
  /** What the last answer was charged, until `notifyReleased` settles it. */
  let charged = 0;
  /**
   * The last settlement released nothing while something was charged: the
   * session's cut is parked inside a cluster it cannot cut, so the budget is
   * free to accrue past `budgetCap` until the whole glyph is affordable. Any
   * cluster is shorter than the text it sits in, so the growth is bounded by
   * the releasable length — and the cap's job (stopping a trickle from
   * hoarding seconds of budget across a stall) still holds everywhere else.
   *
   * Cleared by a settlement that DID release, and by the zero-offer call
   * that reports a drain behind this policy's back: with the buffer empty
   * there is nothing left to be blocked on, and carrying the flag past it
   * would hand the next flush a lifted cap it never earned.
   */
  let blocked = false;

  const meter = (releasable: string): number => {
    const t = now();
    const elapsed = last === null ? 0 : Math.min(Math.max(t - last, 0), MAX_CREDIT_MS);
    last = t;
    if (releasable === '') {
      // The session's zero-offer bookkeeping call: the buffer emptied
      // WITHOUT this policy metering it (a synchronous drain, the idle
      // drain, a link snap). Nothing is blocked when nothing is pending, and
      // there is no answer left to settle — leaving either standing would
      // lift the budget cap on the next real flush, spending credit the
      // stall never earned.
      blocked = false;
      charged = 0;
      budget = Math.min(budget + (elapsed / 1000) * rate, budgetCap);
      return 0;
    }
    // Word-mode overdraw drives the budget negative; debt is repaid by
    // accrual before the cap re-applies, so a long word buys a real pause.
    const cap = blocked ? Math.max(budgetCap, releasable.length) : budgetCap;
    budget = Math.min(budget + (elapsed / 1000) * rate, cap);

    const budgeted = Math.max(0, Math.floor(budget));
    let take: number;
    if (boundary === 'char' || budgeted >= releasable.length) {
      take = Math.min(budgeted, releasable.length);
    } else if (budgeted < 1) {
      take = 0;
    } else {
      // Cut after the last whitespace inside the budgeted window so words
      // appear whole. A window that is all one word overdraws — bounded, see
      // below: the word plus its trailing whitespace is released and the
      // budget goes negative, pausing until the debt is repaid.
      take = 0;
      for (let i = budgeted - 1; i >= 0; i -= 1) {
        if (/\s/.test(releasable[i])) {
          take = i + 1;
          break;
        }
      }
      if (take === 0) {
        // No whitespace inside the budgeted window: the word runs past the
        // budget. Release it whole — the overdraw is charged and paid off as
        // a pause — but only while it is word-sized. Beyond that there is no
        // usable boundary at all (Chinese, Japanese and Thai are written
        // without spaces, so `\S+` matches the entire buffer and 'word'
        // would dump thousands of characters in one flush and then freeze
        // for seconds paying the debt), so the cut falls back to the
        // budgeted char-mode one.
        const firstWord = /^\s*\S+\s*/.exec(releasable);
        const wordEnd = firstWord ? firstWord[0].length : releasable.length;
        take =
          wordEnd <= budgeted + WORD_OVERDRAW_LIMIT
            ? Math.min(wordEnd, releasable.length)
            : budgeted;
      }
    }

    // Everything the budget (or overdraw) chose is charged; the lag snap
    // below is free — catch-up must not indebt the tail into a stall.
    const charge = take;
    const lagFloor = releasable.length - maxLag;
    if (lagFloor > take) {
      take = lagFloor;
    }
    budget -= charge;
    charged = charge;
    return take;
  };

  return Object.assign(meter, {
    /**
     * Settle the last answer against what the session actually released.
     * Charging for text the cluster-safe retreat held back is what used to
     * stall this policy for good: a flag, a keycap or an Indic matra at the
     * head of the buffer released nothing, yet each frame's accrual was
     * spent on that answer, so the budget could never reach the whole
     * glyph. The unreleased part is refunded; releasing MORE than the answer
     * (the link snap, the lag snap) stays free, exactly as it is charged.
     */
    notifyReleased(released: number): void {
      const unreleased = charged - Math.max(0, released);
      if (unreleased > 0) {
        budget += unreleased;
      }
      blocked = charged > 0 && released <= 0;
      charged = 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Adaptive smoother — jitter-buffer playout policy
// ---------------------------------------------------------------------------
//
// Ported 1:1 from a production chat client's stream pacer: the policy half of
// an A/V-style jitter buffer for token playout. Network deltas arrive in
// jitter-sized bursts (radio wake-ups, SSE proxy buffering, model stalls), so
// releasing them as they land shows text in uneven lumps that freeze whenever
// the network hiccups. The adaptive policy decouples arrival from display:
// pre-buffer a little runway, then release at a rate that tracks the
// estimated arrival rate, holding a small target lag behind the head so
// bursts are absorbed and short stalls are bridged without freezing — and
// when the run ends, drain the tail within a bound instead of holding a
// finished answer hostage. Controller shape follows llm-ui's `throttleBasic`
// (rate window + proportional catch-up/ease-off), with the lag expressed in
// time rather than chars so it holds across model speeds.
//
// The pacing constants below are DEFAULTS: every latency-shaping one
// (pre-buffer, target lag, drain bounds, rate clamp) is overridable per
// instance through `AdaptiveSmootherOptions`, so a consumer can trade
// smoothness for immediacy without forking the policy. The estimator
// internals (rate window, controller ratios, suspension/bulk thresholds)
// are not knobs — they are what keeps any tuning stable.

/** Budget window credited when there is no previous flush to measure from
 * (first call, and a flush chain restarting after an idle, fully-drained
 * stretch): one nominal scheduler tick's worth. */
const NOMINAL_TICK_MS = 100;

/** Pre-buffer gate: start releasing once this much total text has arrived… */
const PREBUFFER_MIN_CHARS = 40;
/** …or this long after the first arrival, whichever comes first (caps the
 * synthetic delay the pre-buffer adds). */
const PREBUFFER_MAX_WAIT_MS = 300;

/** How far (in time) the release aims to trail the stream head. ≥2 network
 * throttle windows so inter-chunk gaps are bridged. */
const TARGET_LAG_MS = 400;
const TARGET_LAG_MIN_CHARS = 16;
const TARGET_LAG_MAX_CHARS = 240;

/** Arrival-rate estimation window and the minimum span it needs before the
 * estimate beats the fallback. */
const RATE_WINDOW_MS = 2000;
const RATE_MIN_SPAN_MS = 250;
const FALLBACK_RATE_CPS = 180;

/** Proportional controller: speed up/slow down when the lag drifts off
 * target. Ratios gate the correction so steady state doesn't oscillate. */
const CATCH_UP_FACTOR = 1.3;
const EASE_OFF_FACTOR = 0.75;
const LAG_HIGH_RATIO = 1.25;
const LAG_LOW_RATIO = 0.8;

/** Release-rate clamp: floor ≈ 2× reading speed so a near-empty buffer slows
 * down instead of stuttering; ceiling keeps catch-up from strobing. */
const MIN_RATE_CPS = 40;
const MAX_RATE_CPS = 700;

/** Run-end drain: instant below the threshold, otherwise bounded so the
 * pacing never holds a finished answer hostage. The bound is generous enough
 * that a fast run which finalized with most of its answer unreleased (a
 * no-reasoning response arriving in one burst) still reads as streaming
 * rather than flashing in — the instant threshold keeps short tails snappy. */
const DRAIN_INSTANT_CHARS = 120;
const DRAIN_MAX_MS = 1200;
const DRAIN_ARRIVAL_FACTOR = 3;

/** A flush arriving this late while the previous answer left releasable text
 * unreleased means the JS timers were suspended (backgrounded app) — catch
 * up in one commit instead of replaying. */
const SUSPEND_FLUSH_GAP_MS = 1500;

/** Backstop for bulk rewrites (recovery merges): a lag this large is not
 * streaming anymore, jump to the head. Real bursts stay well under it. */
const BULK_JUMP_CHARS = 3000;

/** How far past the budgeted cut to look for a whitespace to finish the word. */
const WORD_SNAP_LOOKAHEAD = 8;

/**
 * Cut point for a budgeted release: finish the current word when a
 * whitespace is within reach (the cut lands ON the whitespace so the slice
 * ends with a complete word), then move up to a cluster boundary so the
 * release never paints half a glyph. `Intl.Segmenter` is deliberately not
 * used — Hermes ships a limited Intl subset; `advanceToClusterBoundary`
 * documents which clusters the hand-rolled walk recognises (surrogate
 * pairs, ZWJ sequences, extenders, combining marks, flag pairs, tag
 * sequences) and which it does not. Mid-word cuts beyond the lookahead are
 * fine: network chunk boundaries land mid-word anyway, and tail repair
 * already withholds incomplete trailing constructs.
 *
 * The walk moves the cut UP, which is why the adaptive smoother does not
 * depend on the session's own retreat: the answer is already off a cluster
 * boundary when it leaves here.
 */
function snapReleaseCut(text: string, target: number): number {
  let cut = Math.max(0, Math.min(target, text.length));
  if (cut >= text.length) return text.length;

  const windowEnd = Math.min(cut + WORD_SNAP_LOOKAHEAD + 1, text.length);
  for (let i = cut; i < windowEnd; i += 1) {
    if (/\s/.test(text[i])) {
      cut = i;
      break;
    }
  }
  return advanceToClusterBoundary(text, cut);
}

interface ArrivalSample {
  readonly at: number;
  readonly total: number;
}

export interface AdaptiveSmootherOptions {
  /** Clock (ms) used when a call arrives without a `SmootherContext` and as
   * the default timestamp for `notifyRunFinalized`. A provided `context.now`
   * always wins over it. Injectable for tests; default `Date.now`. */
  now?: () => number;
  /** Pre-buffer gate: hold the first release until this much total text has
   * arrived (default 40)… */
  preBufferMinChars?: number;
  /** …or until this long after the first arrival, whichever comes first —
   * the cap on the synthetic delay the pre-buffer adds (default 300). */
  preBufferMaxWaitMs?: number;
  /** How far (in time) the release aims to trail the stream head (default
   * 400). Keep it at ≥2 of the feeding transport's publish windows, so
   * inter-chunk gaps are bridged instead of freezing the reveal. */
  targetLagMs?: number;
  /** Floor under the time-derived target lag, in chars (default 16). */
  targetLagMinChars?: number;
  /** Ceiling over the time-derived target lag, in chars (default 240). */
  targetLagMaxChars?: number;
  /** Run-end drain: a tail at or under this many releasable chars at the
   * first post-finalize flush releases instantly (default 120). */
  drainInstantChars?: number;
  /** Run-end drain deadline for longer tails, in ms (default 1200). */
  drainMaxMs?: number;
  /** Release-rate floor in chars/sec (default 40): a near-empty buffer
   * slows down instead of stuttering. */
  minRateCps?: number;
  /** Release-rate ceiling in chars/sec (default 700): keeps catch-up from
   * strobing. */
  maxRateCps?: number;
}

/** A tuning override must be a positive finite number; absent keeps the
 * module default. */
function tuned(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `createAdaptiveSmoother: ${name} must be a positive finite number, got ${value}`,
    );
  }
  return value;
}

/**
 * The adaptive policy is a callable `Smoother` with one lifecycle method
 * bolted on — the session calls the function per flush and the owner of the
 * run calls the method once at run end (owners driving a `StreamSession`
 * call the session's `notifyRunFinalized`, which forwards here on the
 * session's clock; the run-scoped AG-UI binding does that itself).
 */
export interface AdaptiveSmoother extends Smoother {
  /**
   * The stream is over: switch to the run-end drain. Short tails (≤120
   * releasable chars at the next flush, by default) release instantly;
   * longer ones race a deadline (default 1200ms) so the tail still reads as
   * streaming rather than
   * flashing in. There is no run-start counterpart: a new run either gets a
   * new smoother instance, or — when a session outlives its run — reuses
   * one whose drain state cleared itself when that drain finished (every
   * exit from the drain resets it, including the zero-offer call a
   * synchronous drain makes).
   */
  notifyRunFinalized(now?: number): void;
}

/**
 * The adaptive jitter-buffer `Smoother` (see the section comment above for
 * the model). Stateful — one instance per session, never shared.
 *
 * Contract notes:
 * - Arrival tracking samples `context.sourceLength + context.pendingLength`
 *   per call. Without a context there is no ingress signal: no samples are
 *   recorded (the rate stays at the fallback) and the pre-buffer gate reads
 *   `releasable.length` as its lower bound on the total arrived.
 * - Returning 0 (the pre-buffer gate) relies on the session keeping a flush
 *   scheduled while releasable text remains, so the drain is never stalled.
 * - `Infinity` is the free catch-up channel (bulk jump, timer suspension,
 *   drain) — the session treats any non-finite answer as release-everything.
 * - Finite answers are word-snapped and cluster-safe (`snapReleaseCut`),
 *   and never negative.
 */
export function createAdaptiveSmoother(
  options?: AdaptiveSmootherOptions,
): AdaptiveSmoother {
  const clock = options?.now ?? Date.now;
  const preBufferMinChars = tuned(
    'preBufferMinChars',
    options?.preBufferMinChars,
    PREBUFFER_MIN_CHARS,
  );
  const preBufferMaxWaitMs = tuned(
    'preBufferMaxWaitMs',
    options?.preBufferMaxWaitMs,
    PREBUFFER_MAX_WAIT_MS,
  );
  const targetLagMs = tuned('targetLagMs', options?.targetLagMs, TARGET_LAG_MS);
  const targetLagMinChars = tuned(
    'targetLagMinChars',
    options?.targetLagMinChars,
    TARGET_LAG_MIN_CHARS,
  );
  const targetLagMaxChars = tuned(
    'targetLagMaxChars',
    options?.targetLagMaxChars,
    TARGET_LAG_MAX_CHARS,
  );
  const drainInstantChars = tuned(
    'drainInstantChars',
    options?.drainInstantChars,
    DRAIN_INSTANT_CHARS,
  );
  const drainMaxMs = tuned('drainMaxMs', options?.drainMaxMs, DRAIN_MAX_MS);
  const minRateCps = tuned('minRateCps', options?.minRateCps, MIN_RATE_CPS);
  const maxRateCps = tuned('maxRateCps', options?.maxRateCps, MAX_RATE_CPS);

  let gateOpen = false;
  /** Previous raw `sourceLength + pendingLength`; a lower one is a rewrite
   * or a replace deleting text, and rebases the window. See `release`. */
  let lastArrived: number | null = null;
  let firstContentAt: number | null = null;
  let samples: ArrivalSample[] = [];
  let lastCallAt: number | null = null;
  /** Whether the previous answer released less than it was offered. This is
   * what disambiguates a late flush: a big gap while text sat unreleased is
   * a timer suspension (dump in one commit), while a big gap after a full
   * drain is just idle streaming resuming (the pacer this ports solved that
   * case with an explicit `resetTickClock`; here the memory of the last
   * answer stands in for it). The memory is honest only because the session
   * reports releases that bypass the policy — a synchronous drain, the idle
   * drain, a link snap emptying the buffer — as zero-offer calls, which
   * reset it through the `offered <= 0` branch below; without that channel
   * an external drain would strand this flag true and the next routine
   * stream stall would dump the following burst un-paced. */
  let leftUnreleased = false;
  let draining = false;
  /** First flush after `notifyRunFinalized`: the instant-vs-paced decision
   * is made once, on the tail size seen then — a paced drain must not flash
   * its last ≤120 chars. */
  let drainFresh = false;
  let drainDeadline = 0;

  // Keep one sample at/before the cutoff as the span baseline.
  const pruneSamples = (now: number) => {
    const cutoff = now - RATE_WINDOW_MS;
    let firstKeep = 0;
    while (
      firstKeep < samples.length - 1 &&
      samples[firstKeep + 1].at <= cutoff
    ) {
      firstKeep += 1;
    }
    if (firstKeep > 0) samples = samples.slice(firstKeep);
  };

  /** Chars/sec over the lookback window, measured against `now` so the
   * estimate decays through a stall instead of freezing at the last burst. */
  const arrivalRate = (now: number): number => {
    pruneSamples(now);
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const span = now - first.at;
      if (span >= RATE_MIN_SPAN_MS) {
        return ((last.total - first.total) / span) * 1000;
      }
    }
    // Too little signal yet (fresh stream) — assume a typical one.
    return FALLBACK_RATE_CPS;
  };

  const release = (releasable: string, context?: SmootherContext): number => {
    const t = context?.now ?? clock();
    const total =
      context != null
        ? context.sourceLength + context.pendingLength
        : releasable.length;
    if (context != null) {
      // `sourceLength + pendingLength` is arrival, and arrival cannot
      // un-happen — but a `rewrite()` that shortens the unrevealed tail does
      // lower it, and a divergent `replace()` can lower it for good (see
      // `SmootherContext.sourceLength`). Sampling the dip raw would feed
      // `arrivalRate` a negative slope for a full RATE_WINDOW_MS: the release
      // rate would drop below the real arrival rate, the backlog would grow,
      // and a large enough rewrite would pin the reveal at `minRateCps`.
      //
      // So rebase rather than clamp: the deletion is subtracted from the
      // samples the window still holds, which puts the whole series on the
      // post-rewrite scale and leaves the SLOPE across the event untouched.
      // The next sample then measures real arrival immediately. (Clamping to
      // a high-water mark keeps the series monotone but flattens it until
      // arrival re-fills the deleted region — a depression that outlasts a
      // rate window and gets worse the more was deleted.)
      if (lastArrived !== null && total < lastArrived) {
        const dropped = lastArrived - total;
        samples = samples.map((sample) => ({
          at: sample.at,
          total: sample.total - dropped,
        }));
      }
      lastArrived = total;
      samples.push({ at: t, total });
      pruneSamples(t);
    }
    if (firstContentAt === null && total > 0) firstContentAt = t;

    const offered = releasable.length;
    const sinceLast = lastCallAt === null ? null : Math.max(t - lastCallAt, 1);
    lastCallAt = t;

    let dt: number;
    if (sinceLast !== null && sinceLast > SUSPEND_FLUSH_GAP_MS) {
      if (leftUnreleased) {
        // Timers were suspended mid-release — catch up in one commit.
        leftUnreleased = false;
        draining = false;
        return Infinity;
      }
      // Fresh burst after an idle, fully-drained stretch: normal streaming.
      // Crediting the whole gap would dump it in one frame; restart the
      // budget clock at one nominal tick instead.
      dt = NOMINAL_TICK_MS;
    } else {
      dt = sinceLast ?? NOMINAL_TICK_MS;
    }

    if (!gateOpen) {
      const waited =
        firstContentAt !== null && t - firstContentAt >= preBufferMaxWaitMs;
      if (total >= preBufferMinChars || waited || draining) {
        gateOpen = true;
      } else {
        // The session keeps a flush scheduled while releasable text remains,
        // so buffering behind the gate never stalls the drain.
        leftUnreleased = offered > 0;
        return 0;
      }
    }

    if (offered <= 0) {
      draining = false;
      leftUnreleased = false;
      return 0;
    }

    if (offered > BULK_JUMP_CHARS) {
      draining = false;
      leftUnreleased = false;
      return Infinity;
    }

    if (draining && drainFresh) {
      drainFresh = false;
      if (offered <= drainInstantChars) {
        draining = false;
        leftUnreleased = false;
        return Infinity;
      }
    }

    const arrival = arrivalRate(t);
    let rate: number;
    if (draining) {
      const remainingMs = drainDeadline - t;
      if (remainingMs <= 0) {
        // Past the deadline — the bound always wins over smoothness.
        draining = false;
        leftUnreleased = false;
        return Infinity;
      }
      // The arrival term is capped: a one-burst answer leaves an estimate
      // in the thousands of cps, and an uncapped drain at 3× that is a
      // flash, not a stream. The deadline term stays uncapped — meeting
      // DRAIN_MAX_MS always wins over smoothness.
      rate = Math.max(
        Math.min(DRAIN_ARRIVAL_FACTOR * arrival, maxRateCps),
        (offered / remainingMs) * 1000,
        minRateCps,
      );
    } else {
      const targetLagChars = Math.min(
        Math.max(arrival * (targetLagMs / 1000), targetLagMinChars),
        targetLagMaxChars,
      );
      rate = arrival;
      if (offered > targetLagChars * LAG_HIGH_RATIO) rate *= CATCH_UP_FACTOR;
      else if (offered < targetLagChars * LAG_LOW_RATIO)
        rate *= EASE_OFF_FACTOR;
      rate = Math.min(Math.max(rate, minRateCps), maxRateCps);
    }

    const step = Math.max(1, Math.round((rate * dt) / 1000));
    const cut = snapReleaseCut(releasable, step);
    if (cut >= offered) {
      draining = false;
      leftUnreleased = false;
      return offered;
    }
    leftUnreleased = true;
    return cut;
  };

  return Object.assign(release, {
    notifyRunFinalized(now?: number): void {
      draining = true;
      drainFresh = true;
      // Drain must run even when the gate never opened (a short answer that
      // finished inside the pre-buffer window).
      gateOpen = true;
      drainDeadline = (now ?? clock()) + drainMaxMs;
    },
  });
}

// ---------------------------------------------------------------------------
// Link-destination playout snap
// ---------------------------------------------------------------------------

/** Scan bound for {@link snapPastLinkDestination}, backward to the enclosing
 * `[` and forward to the closing `)`. Generous for real links (an in-app
 * scheme URI runs ~60 units, pasted https URLs rarely approach this); a
 * longer construct simply paces through at the normal rate. Keeps the
 * per-call scan O(1) no matter how long the text grows. Exported so a caller
 * assembling scan context (committed tail + pending) can size the tail. */
export const LINK_SNAP_WINDOW = 600;

// `[label](destination` — optionally closed — anchored at a `[`: single-line
// label without `]`, whitespace/paren-free destination. The same grammar the
// tail repair closes virtually, which is what makes these characters
// invisible during streaming.
const LINK_AT_OPEN_RE = /^\[([^\]\n]*)\]\(([^()\s]*)(\)?)/;

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export interface SnapPastLinkDestinationOptions {
  /**
   * Treat a label that is itself a scheme-prefixed URI as invisible too, so
   * the snap starts at the `[` rather than the `]`. Default false — under
   * this library's own tail repair the label always paints, and skipping it
   * would lump visible text. For consumers whose pipeline hides URI-like
   * labels (rendering such links as a marker only), true matches what their
   * reader actually sees.
   */
  skipUriLikeLabels?: boolean;
}

/**
 * Charge a link destination zero playout time: the cursor-advance companion
 * to tail repair, for any typewriter reveal that paces raw source characters
 * (a `Smoother`, or a consumer's own pacer).
 *
 * Tail repair closes a streaming `[label](href` virtually, so mid-stream the
 * label paints and the destination never does. A reveal that meters RAW
 * characters doesn't know that: once its cursor crosses the `](` it spends
 * real budget typing out characters that render as nothing — the text
 * visibly freezes for href-length ÷ reveal-rate, and then the link pops
 * complete. Jitter buffering cannot help; by the time the cursor arrives the
 * `)` is usually already buffered, so the cost is traversal, not
 * availability.
 *
 * Given the text and a prospective cut, this returns the cut to use instead:
 * when the cut lands inside a link destination whose `)` has already been
 * buffered, it advances to just past the `)`. Every skipped character was
 * invisible, so the jump cannot lurch — the link simply completes the moment
 * its label finishes. A destination whose `)` has NOT arrived is left alone;
 * the snap fires on the first reveal after the close lands, so the residual
 * wait is one frame, not an href.
 *
 * Deliberately heuristic, because playout is presentation: the scan is
 * bounded by an internal window (600 units) and does not know about code
 * spans, so a literal `[x](y)` inside inline code snaps a few visible
 * characters early — a one-frame lump no bigger than the ones network bursts
 * already produce. Moving the cut forward can never corrupt text; the parse
 * sees whatever the reveal ends with.
 */
export function snapPastLinkDestination(
  content: string,
  cursor: number,
  options?: SnapPastLinkDestinationOptions,
): number {
  if (cursor <= 0 || cursor >= content.length) return cursor;

  // Bounded backward scan for the enclosing `[` — searched in a slice so a
  // bracketless text never costs a full-content lastIndexOf per call.
  const floor = Math.max(0, cursor - LINK_SNAP_WINDOW);
  const behind = content.slice(floor, cursor);
  let rel = behind.lastIndexOf('[');
  while (rel >= 0 && isEscapedAt(content, floor + rel)) {
    rel = rel > 0 ? behind.lastIndexOf('[', rel - 1) : -1;
  }
  if (rel < 0) return cursor;
  const open = floor + rel;

  const match = LINK_AT_OPEN_RE.exec(
    content.slice(open, open + LINK_SNAP_WINDOW),
  );
  // No `](` after the label, or the `)` hasn't been buffered yet — wait.
  if (match == null || match[3] !== ')') return cursor;

  const closeBracket = open + 1 + match[1].length; // index of `]`
  const endParen = open + match[0].length - 1; // index of `)`
  // Every cut in [closeBracket, endParen] renders the identical text;
  // endParen + 1 is where the link completes.
  const snapFrom =
    options?.skipUriLikeLabels && isUriLikeLabel(match[1])
      ? open
      : closeBracket;
  return cursor >= snapFrom && cursor <= endParen ? endParen + 1 : cursor;
}
