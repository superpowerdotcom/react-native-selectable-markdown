import { IS_DEV } from '../dev';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import {
  StreamSession,
  type BufferScheduler,
  type IdleScheduler,
} from '../stream/StreamSession';
import type { RepairOptions } from '../stream/repair';
import type { Smoother } from '../stream/smoothing';
import {
  getOrCreateSession,
  useSessionActivity,
  type TextMessageEvents,
} from './useAgUiSession';

/**
 * The slice of StreamSession the run-scoped binding drives. Structural (like
 * `SessionSink`) so the binding core is testable with a recording fake:
 * `replace` for pre-existing rows and their rewrites (its prefix diff keeps
 * the common append-shaped case incremental), `appendBuffered` for rows born
 * inside an observed run or adopted mid-reveal (so a smoother can meter them
 * out), `rewrite` for
 * rewrites of those born rows (an edit confined to the unrevealed tail keeps
 * the metered reveal typing; `rewrite` itself escalates to replace semantics
 * when the edit reaches committed text), and
 * `flushBuffered`/`drained`/`pendingLength`/`finalize`/`notifyRunFinalized`
 * for row switching and run-end settling. `append` carries adopted rows (see
 * `RunBindingPolicy.getContent`), so a store must implement it.
 */
export type RunSessionSink = Pick<
  StreamSession,
  | 'append'
  | 'appendBuffered'
  | 'replace'
  | 'rewrite'
  | 'flushBuffered'
  | 'finalize'
  | 'drained'
  | 'pendingLength'
  | 'notifyRunFinalized'
>;

/**
 * Host-owned session storage. The binding creates sessions lazily on first
 * sighting of an id and never clears the store wholesale — settled documents
 * must survive re-renders, so eviction is the host's call (directly, or via
 * `RunBindingPolicy.evictOnRunStart`).
 */
export interface RunSessionStore {
  get(id: string): RunSessionSink | undefined;
  create(id: string): RunSessionSink;
  /**
   * Hosts may call this directly (not only via `evictOnRunStart`); the
   * binding reconciles its per-id records against the store at the next
   * observed run start, so a direct eviction also releases the binding's
   * bookkeeping for the id.
   */
  evict(id: string): void;
  ids(): Iterable<string>;
}

/** Optional host hooks for `bindRunTextEvents`. All structural, no ag-ui. */
export interface RunBindingPolicy {
  /**
   * Authoritative full content of a row (e.g. the transport's message
   * snapshot). When provided it seeds and re-syncs pre-existing rows —
   * covering text that arrived before this binding attached, which the
   * binding's own delta accumulation cannot know about. Absent, the binding
   * falls back to the deltas this binding instance has observed, except for
   * an adopted row, whose session existed before this binding first routed
   * it (a rebind mid-run): its deltas `append` (or `appendBuffered` mid-reveal),
   * since `replace` would reset it to the truncated tail.
   *
   * Presence is latched when the binding attaches (matching the hook's
   * policy latching): with an authority present the binding skips its own
   * accumulation entirely — the fallback copy would never be read, only
   * double every row's text memory — so the property must stay present for
   * the binding's lifetime (the implementation may still swap per call, as
   * the hook's composed policy does).
   */
  getContent?(id: string): string;
  /**
   * Observes the run-end drained-hold (see `bindRunTextEvents` behavior d):
   * `true` when run end left at least one session still metering out pending
   * text, `false` once the last of them settles (or the hold is cancelled by
   * a new run, a terminal failure, or detach). Drives "keep status streaming
   * while the tail plays out" UI.
   */
  onHoldChanged?(holding: boolean): void;
  /**
   * Consulted once per stored id on each observed run start; returning true
   * evicts that id from the store. The binding never evicts on its own.
   */
  evictOnRunStart?(id: string): boolean;
  /**
   * Bounded run-end grace for hosts whose text deltas ride a render loop
   * (see `bindRunTextEvents` behavior d). At an observed clean run end the
   * binding asks `expectsLateRow(null)`: answered true, the run-end hold
   * stays up for at most this many ms, waiting for the first delta of a row
   * that has no session yet — a one-burst answer whose run end arrives in
   * the same task as its text, before the host's render loop has delivered
   * any of it to this binding. When such a delta arrives and
   * `expectsLateRow(id)` confirms the row belongs to the ended run, the row
   * is adopted into the run-end drain: routed normally (a born row types),
   * told the run is over (`notifyRunFinalized`), and held until drained,
   * then finalized `'end'`. The grace never arms after a terminal failure
   * (that settle already chose how the run ends). Both grace members must
   * be present for the grace to exist — presence is latched at bind time,
   * like `getContent` — and the bound is read per arm.
   */
  runEndGraceMs?: number;
  /**
   * Late-row authority (see `runEndGraceMs`). Called with `null` at run
   * end — "might a row this binding has not seen still deliver its first
   * delta?" — and with the row's id when a born row takes its first
   * routing decision of the run while the run-end hold is up (the grace,
   * or a predecessor's drain): answered true, the row is adopted into the
   * drain. A natural host implementation of the id form is "this id was
   * first fed during the current run observation".
   */
  expectsLateRow?(id: string | null): boolean;
}

type FinalizeReason = 'end' | 'aborted' | 'failed';

const SPENT_RUN_ID_MEMORY = 64;

/** The binding has no error channel of its own, so an abandoned drain is reported here. */
function reportAbandonedDrain(id: string, error: unknown): void {
  if (!IS_DEV) {
    return;
  }
  console.error(
    `[react-native-selectable-markdown] bindRunTextEvents: session "${id}" ` +
      `abandoned its drain at run end — its engine refused every retry, so ` +
      `the run-end hold was released without finalizing and the session's ` +
      `pending text stays unrendered until a later drain succeeds.`,
    error,
  );
}

const pacedSessions = new WeakSet<RunSessionSink>();

interface RowRecord {
  /**
   * Routing decision for the id, made at its first delta of the current run
   * and reset (to null) by the next observed run start, so a row that
   * continues across runs is re-judged against the new pre-run snapshot.
   */
  preexisting: boolean | null;
  /**
   * Every character this binding has routed for the id — the seed/replace
   * fallback when the host provides no `getContent` authority. A rewrite
   * rebases it wholesale. With an authority latched at bind time this stays
   * `''`: the fallback is never read then, so accumulating would only keep
   * a dead second copy of every row's text for the binding's lifetime.
   */
  content: string;
  /**
   * The session existed before this binding first routed the id, so `content`
   * is only a tail: deltas `append` instead of `replace(content)`. Cleared by a
   * rewrite; kept across run starts, which do not re-seed `content`.
   */
  adopted: boolean;
  /** Adopted mid-reveal: deltas stay on `appendBuffered` so the smoother keeps metering. */
  paced: boolean;
}

/**
 * The React-free run-scoped core of the adapter: routes a whole run's text
 * events into per-message session sinks. Where `bindMessageEvents` binds one
 * known messageId, this binding owns the run lifecycle — which rows
 * pre-exist the run, row switching, rewrites, failure triage, and the
 * run-end drained-hold — so a transport adopting it moves only its
 * `Map<messageId, session>` bookkeeping. Behaviors:
 *
 * (a) Pre-existing seeding. Until an `onRunStarted` fires, EVERY id counts
 *     as pre-existing — never pace rows from a run whose beginning this
 *     binding did not see (attach mid-run, stream resume). A pre-existing
 *     row's text goes through `replace` (authoritative content when
 *     `policy.getContent` exists, else the accumulated deltas): committed in
 *     one revision, never typed. An ADOPTED row (its session predates this
 *     binding, no authority) `append`s instead, or `appendBuffered` if
 *     caught mid-reveal.
 *     A row born after an observed run start
 *     routes through `appendBuffered` — typed out when the session has a
 *     smoother — no matter how large its first delta is, so a one-burst
 *     answer still streams.
 * (b) Row switching. A delta for a different id than the previous delta's
 *     flushes the previous session's buffer (implicit flush; message end /
 *     run end own settling, so no finalize here). The flush is deferred one
 *     microtask: a render-loop-fed host emits the successor row's first
 *     delta from render, and flushing the previous session inline would
 *     commit and notify its still-subscribed view mid-render.
 * (c) Rewrites. `onMessageReplaced` on a PRE-EXISTING (or unjudged) row →
 *     `replace(content)`, created as pre-existing if absent; `replace`'s
 *     prefix diff keeps append-shaped rewrites incremental and a divergent
 *     one is one clean reparse. A row BORN in the observed run routes
 *     through `rewrite(content)` instead: an edit confined to the session's
 *     unrevealed tail swaps only the pending buffer, so the metered reveal
 *     keeps typing straight through it (the motivating host rewrites a
 *     completing citation link into its marker form at every citation
 *     completion — systematic, not rare), and `rewrite` itself falls back
 *     to replace semantics when the edit reaches committed text.
 * (d) Run end with drained-hold. `onMessageEnd(id)` only marks the id (as
 *     the per-message binding's `messageEnded` latch does); settling is
 *     deferred to `onRunFinalized` so a metered tail is not cut short.
 *     At run end, sessions untouched this run with nothing pending
 *     finalize immediately (`'end'` for ended ids, `'aborted'` otherwise);
 *     sessions still metering text are told the run is over
 *     (`notifyRunFinalized`, so an adaptive smoother drains against its
 *     bounded deadline) and hold — `policy.onHoldChanged(true)`, finalize
 *     after `drained()`, `onHoldChanged(false)` when the last one settles.
 *     A session fed this run but drained at run end parks through the same
 *     hold WITHOUT the run-over notification (arming an empty session's
 *     drain state would leave it set into the smoother's next run; the
 *     re-check notifies lazily if text appears).
 *     After a held session's `drained()` resolves, one macrotask passes
 *     before `pendingLength` is re-checked, looping while new text
 *     appeared: a render-loop-fed host publishes its final snapshot
 *     synchronously at run end while the append reaches the session
 *     through a later effect, so draining what the session HAS is not yet
 *     proof it has everything.
 *     With `runEndGraceMs` + `expectsLateRow` configured, a clean run end
 *     can also wait — bounded, host-gated — for a row that has no session
 *     yet, and any born row taking its first routing decision while the
 *     hold is up (the awaited one-burst answer, or a successor row
 *     mounting mid-drain) is adopted into the drain (see the policy docs).
 *     A session whose `drained()` rejects (see `StreamSession.drained`)
 *     releases the hold without finalizing, and DEV reports the error.
 *     Settling spans `store.ids()`, never just the rows this instance
 *     routed: a rebind mid-run (fresh binding, same store — the hook does
 *     this on an events identity change) must still settle sessions the
 *     previous binding streamed, or they stay 'streaming' with their tail
 *     repairs forever.
 * (e) Failure triage. `disposition: 'benign'` is a no-op: sessions stay
 *     streaming so a follow-up resume keeps appending. Anything else
 *     finalizes every store session immediately with that reason (absent
 *     reads as `'failed'`), `flushBuffered` first — errors surface against
 *     the honest state, no drain, no hold.
 * (f) New run start. Captures the new pre-run id snapshot (copied at the
 *     event boundary — hosts may hand over their live id set); any leftover
 *     hold flushes and finalizes first (with its run-end reasons); then
 *     `policy.evictOnRunStart` is consulted per stored id, and row records
 *     are reconciled against the store so direct host evictions release
 *     their bookkeeping too. Per-run state (routing decisions, ended ids,
 *     last-delta id) resets.
 * (g) Detach. The returned function unsubscribes everything, is idempotent,
 *     and drops any pending hold callbacks (a stale `drained()` resolution
 *     neither finalizes nor flips the hold flag). It does not flush or
 *     settle the sessions; a binding that takes over the same store resumes
 *     their held run-end drains and keeps adopted reveals metered. A session
 *     dropped for good needs `dispose()`; `useAgUiRunSessions` disposes on
 *     eviction.
 * (h) Attach/catch-up. `onAttached` (optional event): the host (re)attached
 *     to its event source after a detached stretch, and catch-up covers the
 *     gap — every buffered session flushes in one commit, run observation
 *     drops (`preRunIds = null`, and the spent-run memory of behavior i
 *     with it), per-row routing re-judges pre-existing, and any armed grace
 *     cancels. Held sessions are not dropped: the flush
 *     empties them, so their parked continuations finalize with their
 *     run-end reasons and release the hold.
 * (i) Run identity. With run ids, `onRunFinalized` / `onRunFailed` is
 *     ignored for a run this binding saw end or be superseded, and, while an
 *     id-carrying run is in flight, for any other id (a foreign finalize
 *     still marks its id spent). A fresh `onRunStarted` revives a spent id;
 *     catch-up clears the memory (behavior h). Unknown ids fail open:
 *     dropping a real run end strands sessions in 'streaming', while a
 *     premature settle self-heals on the next delta. Without ids nothing is
 *     filtered.
 */
interface RunHold {
  sink: RunSessionSink;
  reason: FinalizeReason;
  notified: boolean;
}

const detachedRunHolds = new WeakMap<RunSessionStore, Map<string, RunHold>>();

export function bindRunTextEvents(
  events: TextMessageEvents,
  store: RunSessionStore,
  policy?: RunBindingPolicy,
): () => void {
  /**
   * Ids present when the current run started; null = no observed run start
   * yet, which means every id is pre-existing (see behavior a).
   */
  let preRunIds: ReadonlySet<string> | null = null;
  /** `undefined` when no id-carrying run is in flight here (see behavior i). */
  let observedRunId: string | undefined;
  const spentRunIds = new Set<string>();
  const markRunSpent = (runId: string | undefined): void => {
    if (runId === undefined || events.onRunStarted === undefined) {
      return;
    }
    spentRunIds.add(runId);
    // Set iteration is insertion order, so this evicts the oldest.
    while (spentRunIds.size > SPENT_RUN_ID_MEMORY) {
      const oldest = spentRunIds.values().next();
      if (oldest.done === true) {
        break;
      }
      spentRunIds.delete(oldest.value);
    }
  };
  const staleRun = (runId: string | undefined): boolean =>
    runId !== undefined && spentRunIds.has(runId);
  const foreignRun = (runId: string | undefined): boolean =>
    runId !== undefined &&
    observedRunId !== undefined &&
    runId !== observedRunId;
  /**
   * Content-authority presence, latched at bind time (the same latch the
   * hook applies to the composed policy). With an authority, the per-row
   * `content` fallback is never read, so accumulation is skipped entirely
   * (see `RowRecord.content`).
   */
  const hasAuthority = policy?.getContent !== undefined;
  /** Per-id routing state for every id this binding has touched. */
  const rows = new Map<string, RowRecord>();
  /** Ids whose message END arrived in the current run (run-end reason). */
  const endedIds = new Set<string>();
  /** The id of the previous delta; a switch flushes that id's session. */
  let lastDeltaId: string | null = null;

  /** Sessions whose run-end finalize is parked behind `drained()`. */
  const held = new Map<string, RunHold>();
  /** Ids whose row-switch flush is parked on a microtask (behavior b). */
  const pendingSwitchFlushes = new Set<string>();
  /**
   * Invalidates in-flight `drained()` continuations: bumped by run start,
   * terminal failure, and detach. A continuation from a superseded hold must
   * neither finalize (the supersession already chose how the session
   * settles) nor fire a stale `onHoldChanged`.
   */
  let holdEpoch = 0;
  let holding = false;
  let detached = false;
  /**
   * Set by a terminal failure, cleared by the next run start (or attach):
   * AG-UI's failure lifecycle is failed THEN finalized, and the finalize
   * that follows a failure must not arm the run-end grace — the failure
   * already settled every session.
   */
  let terminalFailureSeen = false;
  /** True while the bounded run-end late-row window is open (behavior d). */
  let graceArmed = false;
  let cancelGraceTimer: (() => void) | null = null;
  /** Presence of the late-row grace, latched at bind time like getContent. */
  const hasGrace =
    policy?.runEndGraceMs !== undefined && policy?.expectsLateRow !== undefined;

  const nextMacrotask = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const setHolding = (next: boolean): void => {
    if (holding === next) {
      return;
    }
    holding = next;
    policy?.onHoldChanged?.(next);
  };

  const cancelGrace = (): void => {
    graceArmed = false;
    if (cancelGraceTimer !== null) {
      cancelGraceTimer();
      cancelGraceTimer = null;
    }
  };

  /**
   * Flush + finalize every still-held session with the reason captured at
   * its run end, cancelling the hold (used by run start; behavior f).
   */
  const settleHeld = (): void => {
    holdEpoch += 1;
    cancelGrace();
    for (const { sink, reason } of held.values()) {
      sink.flushBuffered();
      sink.finalize(reason);
    }
    held.clear();
    setHolding(false);
  };

  /**
   * Park a session's run-end finalize behind its drain (behavior d). After
   * `drained()` resolves, one macrotask passes before `pendingLength` is
   * re-checked — a render-loop-fed host publishes its final snapshot
   * synchronously at run end, but the append reaches the session through a
   * later effect, so draining what the session HAS is not yet proof it has
   * everything; the loop re-awaits while new text appeared. Staleness
   * guards re-run after every await: the epoch check covers run start /
   * failure / detach having superseded this hold; the held check covers
   * double `onRunFinalized` delivery registering two continuations for one
   * id.
   */
  const parkDrained = (
    id: string,
    sink: RunSessionSink,
    reason: FinalizeReason,
    epoch: number,
    notified: boolean,
  ): void => {
    if (!notified && sink.pendingLength > 0) {
      sink.notifyRunFinalized();
      notified = true;
    }
    const hold: RunHold = { sink, reason, notified };
    held.set(id, hold);
    setHolding(true);
    void (async () => {
      try {
        for (;;) {
          await sink.drained();
          if (epoch !== holdEpoch || !held.has(id)) {
            return;
          }
          await nextMacrotask();
          if (epoch !== holdEpoch || !held.has(id)) {
            return;
          }
          if (sink.pendingLength === 0) {
            break;
          }
          if (!hold.notified) {
            sink.notifyRunFinalized();
            hold.notified = true;
          }
        }
      } catch (error) {
        if (epoch !== holdEpoch || !held.has(id)) {
          return;
        }
        // `finalize` would drain into the same failing engine and throw, so release without it.
        held.delete(id);
        if (held.size === 0) {
          cancelGrace();
          setHolding(false);
        }
        reportAbandonedDrain(id, error);
        return;
      }
      held.delete(id);
      sink.finalize(reason);
      if (held.size === 0) {
        // An armed grace dies with the drain it was holding for: its only
        // job was to keep the run open until an adopted row settled.
        cancelGrace();
        setHolding(false);
      }
    })();
  };

  const recordFor = (id: string): RowRecord => {
    let rec = rows.get(id);
    if (rec === undefined) {
      rec = { preexisting: null, content: '', adopted: false, paced: false };
      rows.set(id, rec);
    }
    return rec;
  };

  const sinkFor = (id: string): RunSessionSink =>
    store.get(id) ?? store.create(id);

  const offDelta = events.onTextDelta((id, delta) => {
    if (delta === '') {
      return;
    }
    if (lastDeltaId !== null && lastDeltaId !== id) {
      // Implicit flush on row switch: the previous row stops accumulating,
      // so its buffered tail should surface promptly. Never finalize here —
      // AG-UI can return to a row, and settling belongs to message/run end.
      // Deferred one microtask, NOT run inline: a render-loop-fed host
      // emits its successor row's first delta from render, and flushing the
      // previous row's session synchronously would commit and notify that
      // session's still-subscribed view mid-render.
      const previousId = lastDeltaId;
      if (!pendingSwitchFlushes.has(previousId)) {
        pendingSwitchFlushes.add(previousId);
        queueMicrotask(() => {
          if (!pendingSwitchFlushes.delete(previousId) || detached) {
            return;
          }
          store.get(previousId)?.flushBuffered();
        });
      }
    }
    lastDeltaId = id;

    // Read before `recordFor`, which mints the record.
    const known = rows.has(id);
    const rec = recordFor(id);
    // A row's FIRST routing decision of this run observation — the moment
    // late-row adoption (behavior d) can apply, judged below.
    const unjudged = rec.preexisting === null;
    if (unjudged) {
      rec.preexisting = preRunIds === null || preRunIds.has(id);
    }
    const existing = store.get(id);
    const sink = existing ?? store.create(id);
    if (!known && existing !== undefined) {
      // The session predates this binding (a rebind mid-run, or a host-created session).
      rec.adopted = true;
      rec.paced = pacedSessions.has(existing) || existing.pendingLength > 0;
    }
    if (!hasAuthority) {
      rec.content += delta;
    }
    if (rec.preexisting) {
      // One-revision commit, never typed. `replace` drains pending and
      // prefix-diffs, so the steady state is a plain append under the hood;
      // it needs the full text, which an adopted row does not have.
      const authoritative = policy?.getContent?.(id);
      if (authoritative !== undefined) {
        sink.replace(authoritative);
      } else if (rec.adopted) {
        if (rec.paced) {
          sink.appendBuffered(delta);
        } else {
          sink.append(delta);
        }
      } else {
        sink.replace(rec.content);
      }
    } else {
      pacedSessions.add(sink);
      sink.appendBuffered(delta);
    }

    if (
      hasGrace &&
      holding &&
      unjudged &&
      rec.preexisting === false &&
      policy?.expectsLateRow?.(id) === true
    ) {
      // A born row's first delta while the run-end hold is still up — the
      // awaited one-burst answer during the grace, or a successor stretch
      // mounting while a predecessor drains. It missed the run-end settle,
      // so adopt it: it types (routed born above), drains against the
      // smoother's run-end deadline, and settles as a clean end — the hold
      // stays up until it finishes instead of cutting its reveal short.
      sink.notifyRunFinalized();
      parkDrained(id, sink, 'end', holdEpoch, true);
    }
  });

  const offEnd = events.onMessageEnd((id) => {
    // Mark only. Finalizing here would drain a smoothed session's pending
    // text synchronously, cutting the metered reveal short — run end owns
    // settling, via the drained-hold (behavior d).
    endedIds.add(id);
  });

  const offFinalized = events.onRunFinalized((runId) => {
    if (staleRun(runId)) {
      return;
    }
    if (foreignRun(runId)) {
      markRunSpent(runId);
      return;
    }
    // Cleared so a next run whose start this binding misses fails open.
    markRunSpent(observedRunId);
    markRunSpent(runId);
    observedRunId = undefined;
    const epoch = holdEpoch;
    // Settle across the STORE, not the binding-local `rows` map: a rebind
    // mid-run hands a fresh instance a store holding sessions it never
    // routed a delta for, and those must still get finalize's repair-free
    // reparse (behavior d). `store.get` only — settling never mints
    // sessions. Snapshot the ids: finalize must not fight store mutation.
    for (const id of [...store.ids()]) {
      const sink = store.get(id);
      if (sink === undefined) {
        continue;
      }
      const reason: FinalizeReason = endedIds.has(id) ? 'end' : 'aborted';
      if (sink.pendingLength === 0) {
        if (terminalFailureSeen || rows.get(id)?.preexisting == null) {
          // Untouched this run (or a failure already settled everything) —
          // settle now. Idempotent for sessions a previous run end (or
          // double delivery) already settled.
          sink.finalize(reason);
          continue;
        }
        // Drained but fed THIS run: park it through the one-macrotask
        // pending re-check anyway. A render-loop-fed host can publish its
        // final snapshot synchronously at run end while the append reaches
        // the session through a later effect — a drained tail is not yet
        // proof it has everything. No run-over notification here: the
        // session is empty, and the re-check notifies lazily if text
        // appears (arming an empty session's drain state would leave it
        // set, never reset, into the smoother's next run).
        parkDrained(id, sink, reason, epoch, false);
        continue;
      }
      // Tell the session's smoother the run is over BEFORE parking behind
      // `drained()`: an adaptive policy switches to its bounded run-end
      // drain, so the tail settles against a deadline instead of trailing
      // out at the steady pacing rate.
      sink.notifyRunFinalized();
      parkDrained(id, sink, reason, epoch, true);
    }
    // Bounded late-row window (behavior d): a render-loop-fed host can see
    // run end in the same task that delivered a one-burst answer, before
    // any of that text has reached this binding. When the host expects such
    // a row, hold the run open for at most `runEndGraceMs` — released early
    // by the row arriving (adopted in the delta handler) or by the drain of
    // everything already held — and never armed after a terminal failure,
    // whose settle already chose how this run ends.
    if (
      hasGrace &&
      !terminalFailureSeen &&
      policy?.expectsLateRow?.(null) === true
    ) {
      const graceMs = policy?.runEndGraceMs ?? 0;
      if (graceMs > 0) {
        cancelGrace();
        graceArmed = true;
        setHolding(true);
        const timer = setTimeout(() => {
          if (epoch !== holdEpoch || !graceArmed) {
            return;
          }
          graceArmed = false;
          cancelGraceTimer = null;
          if (held.size === 0) {
            setHolding(false);
          }
        }, graceMs);
        cancelGraceTimer = () => clearTimeout(timer);
      }
    }
  });

  const offFailed = events.onRunFailed((info, runId) => {
    if (staleRun(runId) || foreignRun(runId)) {
      return;
    }
    if (info?.disposition === 'benign') {
      // Reconnect handoff / conflict-with-resume / stale interrupt: the
      // stream is not over. Leave every session streaming (an existing hold
      // included) so the follow-up run keeps appending.
      return;
    }
    const reason: FinalizeReason =
      info?.disposition === 'aborted' ? 'aborted' : 'failed';
    // Not marked spent: AG-UI sends failed THEN finalized, and that finalize retires the id.
    terminalFailureSeen = true;
    holdEpoch += 1;
    held.clear();
    cancelGrace();
    // Store-wide for the same reason as run-end settling: rows this
    // instance never routed (rebind mid-run) must not outlive the failure
    // still marked 'streaming'.
    for (const id of [...store.ids()]) {
      const sink = store.get(id);
      if (sink === undefined) {
        continue;
      }
      // Errors surface against the honest state: flush the buffered tail so
      // it appears instantly — no drain, no hold — then settle.
      sink.flushBuffered();
      sink.finalize(reason);
    }
    setHolding(false);
  });

  const offStarted = events.onRunStarted?.((existingMessageIds, runId) => {
    // A new run start flushes any leftover drain: still-held sessions from
    // the previous run settle (with their run-end reasons) before the new
    // run's rows begin. (This also cancels an armed late-row grace.)
    settleHeld();
    terminalFailureSeen = false;
    if (runId !== undefined) {
      spentRunIds.delete(runId);
    }
    if (observedRunId !== runId) {
      markRunSpent(observedRunId);
    }
    observedRunId = runId;
    // Copy at the event boundary: hosts naturally pass their LIVE
    // timeline-id set, and the standard AG-UI order lets them add the
    // newborn id at TEXT_MESSAGE_START — before this binding's lazy
    // pre-existing check at the row's first delta. Held by reference, that
    // mutation would judge every newborn row pre-existing and silently
    // disable pacing; the copy freezes pre-run membership here.
    preRunIds = new Set(existingMessageIds);
    for (const id of preRunIds) {
      const sink = store.get(id);
      if (sink) pacedSessions.delete(sink);
      const rec = rows.get(id);
      if (rec) rec.paced = false;
    }
    endedIds.clear();
    lastDeltaId = null;
    for (const rec of rows.values()) {
      rec.preexisting = null;
    }
    const evictOnRunStart = policy?.evictOnRunStart;
    if (evictOnRunStart) {
      // Snapshot the ids first — evict mutates the store mid-iteration.
      for (const id of [...store.ids()]) {
        if (evictOnRunStart(id)) {
          store.evict(id);
        }
      }
    }
    // Reconcile row records against the store: eviction is the host's call
    // and may happen DIRECTLY on the store (see `RunSessionStore.evict`),
    // which this binding cannot observe. A record whose id the store no
    // longer holds is an orphan — drop it (the sweep above included) so an
    // evicted id starts over with nothing, exactly like an
    // `evictOnRunStart` eviction, instead of leaking its content string
    // until detach.
    const live = new Set(store.ids());
    for (const id of [...rows.keys()]) {
      if (!live.has(id)) {
        rows.delete(id);
      }
    }
  });

  const offReplaced = events.onMessageReplaced?.((id, content) => {
    const rec = rows.get(id);
    if (rec === undefined) {
      // Created by a rewrite = adopted content, pre-existing by definition:
      // it must render in one revision, never type out. Content retained
      // only without an authority — the same gate as the delta path.
      rows.set(id, {
        preexisting: true,
        content: hasAuthority ? '' : content,
        adopted: false,
        paced: false,
      });
    } else if (!hasAuthority) {
      // An already-routed row keeps its routing decision (a mid-run patch
      // of a streaming row keeps streaming its subsequent deltas); only the
      // accumulated base rebases, and the full text ends adoption.
      rec.content = content;
      rec.adopted = false;
      rec.paced = false;
    }
    const sink = sinkFor(id);
    if (rec !== undefined && rec.preexisting === false) {
      // A rewrite of a row born in this observed run keeps its metered
      // reveal (behavior c): an edit confined to the unrevealed tail swaps
      // only the pending buffer — routing it through `replace` would dump
      // the smoother's whole withheld backlog in one commit — and `rewrite`
      // itself falls back to replace semantics when the edit reaches
      // committed text.
      sink.rewrite(content);
    } else {
      sink.replace(content);
    }
  });

  const offAttached = events.onAttached?.(() => {
    // The host (re)attached after a detached stretch (behavior h): reveal
    // the caught-up backlog in one commit and drop run observation —
    // whatever exists now is pre-existing, and a run start this binding
    // never heard must not leave a stale capture that types pre-attach
    // rows. Held sessions are NOT dropped: the flush below empties them, so
    // their parked continuations finalize with their run-end reasons and
    // release the hold on their own.
    cancelGrace();
    if (held.size === 0) {
      setHolding(false);
    }
    preRunIds = null;
    // Not marked spent: it may still be running.
    observedRunId = undefined;
    spentRunIds.clear();
    endedIds.clear();
    lastDeltaId = null;
    terminalFailureSeen = false;
    for (const rec of rows.values()) {
      rec.preexisting = null;
      rec.paced = false;
    }
    // Flush across the STORE, like run-end settling: sessions a previous
    // binding streamed (rebind mid-run) must also reveal their backlog.
    for (const id of [...store.ids()]) {
      const sink = store.get(id);
      if (sink) {
        pacedSessions.delete(sink);
        sink.flushBuffered();
      }
    }
  });

  const inheritedHolds = detachedRunHolds.get(store);
  detachedRunHolds.delete(store);
  for (const [id, { sink, reason, notified }] of inheritedHolds ?? []) {
    if (store.get(id) === sink) parkDrained(id, sink, reason, holdEpoch, notified);
  }

  return () => {
    if (detached) {
      return;
    }
    detached = true;
    if (held.size > 0) detachedRunHolds.set(store, new Map(held));
    // Drop pending hold callbacks without settling the sessions — detach
    // must not mutate what it hands back to the host — but do release the
    // hold flag so a host tracking it is not stranded at `true`.
    holdEpoch += 1;
    held.clear();
    pendingSwitchFlushes.clear();
    cancelGrace();
    setHolding(false);
    offDelta();
    offEnd();
    offFinalized();
    offFailed();
    offStarted?.();
    offReplaced?.();
    offAttached?.();
  };
}

/**
 * The session fields of `UseAgUiSessionInit` minus `coalesce` (born rows
 * always buffer), each read when a row's session is created. Only `policy` is
 * live.
 */
export interface UseAgUiRunSessionsInit {
  /** Defaults to the native md4c engine. */
  engine?: Engine;
  /** Parse options, captured when each session is created. */
  options?: EngineOptions;
  /**
   * Smoother FACTORY, not a smoother: stateful smoothers (`createSmoother`)
   * must not be shared between sessions, so every created session gets its
   * own instance.
   */
  smoother?: () => Smoother;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  holdBackChars?: number;
  holdIdleMs?: number;
  /** Forwarded to each created session (see `StreamSessionInit.repair`). */
  repair?: RepairOptions;
  /**
   * Forwarded to each created session (see
   * `StreamSessionInit.bufferScheduler`).
   */
  bufferScheduler?: BufferScheduler;
  idleScheduler?: IdleScheduler;
  now?: () => number;
  /**
   * Host policy, composed with (not replaced by) the hook's own
   * `onHoldChanged`, which drives the returned `holding` state. The
   * presence of the optional methods is latched when the binding attaches
   * (the `[events]` effect); their implementations are read per call, so a
   * re-render swapping the function identity takes effect immediately.
   */
  policy?: RunBindingPolicy;
}

/** Internal narrowing: this hook's store always holds real StreamSessions. */
interface StreamSessionStore extends RunSessionStore {
  get(id: string): StreamSession | undefined;
  create(id: string): StreamSession;
}

/**
 * Run-scoped companion to `useAgUiSession`: one `bindRunTextEvents` binding
 * over a ref-held Map of sessions kept for the component's lifetime, so
 * settled documents survive re-renders and row switches. `sessionFor` is
 * stable and lazily creates (behind the same store the binding uses), for
 * rows the host renders before their first delta arrives. `holding` mirrors
 * the run-end drained-hold — `true` while a finished run's tail is still
 * metering out, the cue to keep streaming chrome up.
 *
 * Effect cleanup suspends session timers and reconnection resumes them; store
 * eviction disposes a session.
 */
export function useAgUiRunSessions(
  events: TextMessageEvents,
  init?: UseAgUiRunSessionsInit,
): { sessionFor(messageId: string): StreamSession; holding: boolean } {
  const sessionsRef = useRef<Map<string, StreamSession> | null>(null);
  if (sessionsRef.current === null) {
    sessionsRef.current = new Map();
  }
  const sessions = sessionsRef.current;

  const initRef = useRef(init);
  initRef.current = init;

  const storeRef = useRef<StreamSessionStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = {
      get: (id) => sessions.get(id),
      create: (id) =>
        getOrCreateSession(sessions, id, () => {
          const current = initRef.current;
          return new StreamSession({
            engine: current?.engine,
            options: current?.options,
            smoother: current?.smoother?.(),
            holdBackChars: current?.holdBackChars,
            holdIdleMs: current?.holdIdleMs,
            repair: current?.repair,
            bufferScheduler: current?.bufferScheduler,
            idleScheduler: current?.idleScheduler,
            now: current?.now,
          });
        }),
      evict: (id) => {
        sessions.get(id)?.dispose();
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
  }
  const store = storeRef.current;

  const [holding, setHolding] = useState(false);

  useSessionActivity(sessions);

  useEffect(() => {
    const latched = initRef.current?.policy;
    const composed: RunBindingPolicy = {
      onHoldChanged: (h) => {
        setHolding(h);
        initRef.current?.policy?.onHoldChanged?.(h);
      },
    };
    if (latched?.getContent) {
      const fallback = latched.getContent.bind(latched);
      composed.getContent = (id) =>
        initRef.current?.policy?.getContent?.(id) ?? fallback(id);
    }
    if (latched?.evictOnRunStart) {
      const fallback = latched.evictOnRunStart.bind(latched);
      composed.evictOnRunStart = (id) =>
        initRef.current?.policy?.evictOnRunStart?.(id) ?? fallback(id);
    }
    if (latched?.expectsLateRow) {
      const fallback = latched.expectsLateRow.bind(latched);
      composed.expectsLateRow = (id) =>
        initRef.current?.policy?.expectsLateRow?.(id) ?? fallback(id);
    }
    if (latched?.runEndGraceMs !== undefined) {
      // A plain value, so unlike the methods above it is captured at bind
      // time — re-renders changing the bound take effect at the next bind.
      composed.runEndGraceMs = latched.runEndGraceMs;
    }
    return bindRunTextEvents(events, store, composed);
  }, [events, store]);

  const sessionFor = useCallback(
    (messageId: string): StreamSession => store.create(messageId),
    [store],
  );

  return { sessionFor, holding };
}
