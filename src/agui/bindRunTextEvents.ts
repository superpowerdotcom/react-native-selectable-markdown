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
  useDeferredUnmount,
  type TextMessageEvents,
} from './useAgUiSession';

/**
 * The slice of StreamSession the run-scoped binding drives. Structural (like
 * `SessionSink`) so the binding core is testable with a recording fake:
 * `replace` for pre-existing rows and their rewrites (its prefix diff keeps
 * the common append-shaped case incremental), `appendBuffered` for rows born
 * inside an observed run (so a smoother can meter them out) and for an
 * adopted row this binding took over mid-reveal, `rewrite` for
 * rewrites of those born rows (an edit confined to the unrevealed tail keeps
 * the metered reveal typing; `rewrite` itself escalates to replace semantics
 * when the edit reaches committed text), and
 * `flushBuffered`/`drained`/`pendingLength`/`finalize`/`notifyRunFinalized`
 * for row switching and run-end settling. `append` carries a pre-existing
 * row whose session predates this binding (an adopted row — see
 * `RunBindingPolicy.getContent`), where the binding knows the delta but not
 * the full text `replace` would need; hosts driving the sink directly
 * alongside the binding use it too.
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
   * falls back to the deltas THIS BINDING INSTANCE has observed for the id,
   * and only where that fallback is the whole story: a row whose session
   * already existed when this binding first routed a delta for it (a rebind
   * mid-run hands a fresh instance the previous one's store) is adopted
   * instead — its deltas `append` onto whatever the session holds (or
   * `appendBuffered`, if the takeover caught it mid-reveal), because the
   * accumulated fallback would be a truncation and `replace` would reset
   * the row to it.
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

/**
 * How many spent run ids one binding remembers for its stale-event filter
 * (behavior i). A late lifecycle event arrives within a run or two of its
 * run ending; anything older is not worth the retained strings.
 */
const SPENT_RUN_ID_MEMORY = 64;

/**
 * `__DEV__` is React Native's global; where it is undefined (a node test
 * run, a plain web build) this reads as a dev build — the same gate the rest
 * of the package's DEV diagnostics use.
 */
const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

/**
 * DEV report for a session that gave up on its buffered tail:
 * `StreamSession.drained()` REJECTS once the session has abandoned the drain
 * (its engine threw on every scheduled retry, so no retry is armed and no
 * drain is coming). The binding releases that session's run-end hold without
 * finalizing it — `finalize` drains synchronously, so it would hand the same
 * text to the same broken engine and throw straight back out — which leaves
 * nothing else to say that a row is stuck holding text it can no longer
 * render. The binding has no error channel of its own to route that through
 * (its policy hooks are all inputs, and the run-failure events are inbound
 * too), so the engine's own error is reported here, once per abandoned hold.
 */
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
   * True when this binding started routing an id whose session ALREADY
   * existed — a rebind mid-run (fresh binding, same store), or a host that
   * created the session itself before the first delta. `content` then holds
   * only the tail this instance saw, so a pre-existing row's deltas go
   * through `sink.append(delta)` — a call the binding makes ONLY for
   * adopted rows, so a store whose `append` is a stub drops their text —
   * rather than `replace(content)`, which would reset the session to that
   * tail and drop everything streamed before the rebind. An adopted row
   * caught mid-reveal keeps metering instead of appending; see `paced`.
   *
   * Cleared by a rewrite (`onMessageReplaced`), which hands over the row's
   * full text and so makes the accumulation whole again — with a
   * `getContent` authority latched there is no accumulation to rebase, so
   * the rewrite leaves the flag alone and the authority outranks it on
   * every delta regardless. Deliberately NOT cleared by a later run start,
   * unlike `preexisting`: nothing about a new run re-seeds `content`, so it
   * is still the same truncation, and re-judging the row as pre-existing
   * would hand that truncation to `replace` and drop the earlier text after
   * all — the very defect adoption exists to prevent. A row therefore stays
   * adopted for the binding's life unless the host evicts the id (directly
   * or via `evictOnRunStart`, either of which drops the record at the next
   * observed run start) or supplies a `getContent` authority.
   */
  adopted: boolean;
  /**
   * Set alongside `adopted` when the session being taken over still had
   * text pending — a row born in an observed run, mid-reveal (a smoother's,
   * or plain per-frame coalescing) when the rebind happened. Its deltas
   * then go through `sink.appendBuffered(delta)`, so that reveal keeps
   * playing out; plain `append` would drain the whole withheld tail into
   * one commit and the row would never pace again.
   *
   * Judged once, from `pendingLength` at the moment of adoption, because
   * that is the only evidence a fresh binding has that the row was being
   * metered: the previous instance's routing decisions went with it. A row
   * whose buffer happened to be empty at the takeover therefore reads as
   * unpaced and appends — the one-revision commit every other pre-existing
   * row gets. Cleared with `adopted` by a rewrite.
   */
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
 *     one revision, never typed. The exception is an ADOPTED row — its
 *     session already existed when this binding first routed a delta for it
 *     (a rebind mid-run, a host-created session) and no authority is
 *     configured, so the accumulation is only a tail: its deltas `append`,
 *     which commits in one revision without resetting the row to that tail.
 *     An adopted row whose session still had text PENDING at the takeover
 *     was mid-reveal, so it keeps going through `appendBuffered` instead
 *     and the smoother finishes typing it out (see `RowRecord.paced`).
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
 *     A session that has given up on its tail settles the other way: its
 *     `drained()` rejects (the engine refused every scheduled retry — see
 *     `StreamSession.drained`), so the hold is released WITHOUT finalizing
 *     — finalize drains, which would hand the same text back to the same
 *     broken engine — and the error is reported in DEV. The binding never
 *     reports `holding: true` for a session whose drain is never coming.
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
 *     settle the sessions — a rebind must not dump a smoother's withheld
 *     backlog, and a session drains its own pending text on its own timers
 *     with no binding attached, so nothing is stranded by detaching. The
 *     binding that takes over keeps that reveal metered rather than ending
 *     it: a row it adopts with text still pending stays on the buffered
 *     path (behavior a, `RowRecord.paced`). A
 *     session dropped for good (the screen popped) needs `dispose()`, which
 *     is what stops those timers; `useAgUiRunSessions` does that for its
 *     whole map at unmount.
 * (h) Attach/catch-up. `onAttached` (optional event): the host (re)attached
 *     to its event source after a detached stretch, and catch-up covers the
 *     gap — every buffered session flushes in one commit, run observation
 *     drops (`preRunIds = null`, and the spent-run memory of behavior i
 *     with it), per-row routing re-judges pre-existing, and any armed grace
 *     cancels. Held sessions are not dropped: the flush
 *     empties them, so their parked continuations finalize with their
 *     run-end reasons and release the hold.
 * (i) Run identity. When the host passes a `runId` to `onRunStarted`, the
 *     binding remembers which runs it watched go SPENT — superseded by a
 *     later run start, or ended by their own `onRunFinalized` — and ignores
 *     an `onRunFinalized` / `onRunFailed` carrying one of those, so a
 *     superseded run's late event cannot settle the run being observed. An
 *     id stays spent only until that run starts again: a fresh
 *     `onRunStarted` for it means it is live, so it is revived and can
 *     finalize (a retried run reusing its id, a replayed start). Catch-up
 *     empties the memory outright, with the rest of the run observation
 *     (behavior h). Fail-open everywhere else, and deliberately: an id this
 *     binding never saw start (a resumed run, a run that began during a
 *     detached stretch, a host that ids its lifecycle events but does not
 *     always announce a start) settles normally, because dropping a
 *     legitimate run end would strand its sessions in 'streaming' forever,
 *     while a premature settle self-heals on the next delta. With no id on
 *     either side nothing is filtered at all, so a host without run ids
 *     must not forward events from a run it no longer observes.
 */
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
  /**
   * Identity of the run being observed right now, when the host supplies
   * one (see behavior i). `undefined` = none in flight here: no run start
   * observed, one that carried no id, or the observed run has since ended.
   * Only used to decide which id goes into `spentRunIds`.
   */
  let observedRunId: string | undefined;
  /**
   * Run ids this binding watched go spent: superseded by a later observed
   * run start, or settled by their own clean run end. A lifecycle event
   * carrying one of these is late and must not settle anything.
   *
   * The filter drops ONLY these, and an id leaves the set the moment its
   * run starts again (`onRunStarted` revives it) or catch-up empties the
   * whole memory. An id this binding never saw start — or saw start again —
   * proves nothing: a resumed or reconnected run, a run created before this
   * binding attached, a retry reusing its id, a host that puts ids on its
   * lifecycle events but emits `onRunStarted` only for runs it started
   * itself. Dropping such a finalize strands its sessions in phase
   * 'streaming' for good, which is a strictly worse failure than the one
   * this filter exists to prevent (a premature settle self-heals: the next
   * delta puts the session back to 'streaming'). So the unknown id settles,
   * and only a run last seen to be over is filtered out.
   */
  const spentRunIds = new Set<string>();
  const markRunSpent = (runId: string | undefined): void => {
    if (runId === undefined) {
      return;
    }
    spentRunIds.add(runId);
    // Only the newest spent runs can plausibly still have an event in
    // flight, and this set lives as long as the binding does. Insertion
    // order is Set iteration order, so the oldest goes first.
    while (spentRunIds.size > SPENT_RUN_ID_MEMORY) {
      const oldest = spentRunIds.values().next();
      if (oldest.done === true) {
        break;
      }
      spentRunIds.delete(oldest.value);
    }
  };
  /** A run-lifecycle event belonging to a run known to be over. */
  const staleRun = (runId: string | undefined): boolean =>
    runId !== undefined && spentRunIds.has(runId);
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
  const held = new Map<string, { sink: RunSessionSink; reason: FinalizeReason }>();
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
   *
   * `drained()` can also REJECT, and this continuation must survive it: a
   * session that has given up on its tail (its engine refused every
   * scheduled retry — see `StreamSession.drained`) settles the promise with
   * the engine's error, and no drain is ever coming. The hold is released
   * WITHOUT finalizing — `finalize` drains synchronously, so it would hand
   * the same text to the same broken engine and throw out of this
   * continuation — and the error is reported once (see
   * `reportAbandonedDrain`), because nothing else would say the row is
   * stuck. The staleness guards run first there too, so a hold something
   * else already superseded settles silently, as its resolution would.
   * Uncaught, the rejection would be an unhandled promise rejection AND
   * leave `onHoldChanged(true)` standing for the binding's life.
   */
  const parkDrained = (
    id: string,
    sink: RunSessionSink,
    reason: FinalizeReason,
    epoch: number,
    notified: boolean,
  ): void => {
    held.set(id, { sink, reason });
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
          if (!notified) {
            // The re-check caught text on a session parked empty (the final
            // render-loop feed): tell its smoother the run is over now, so
            // the late tail drains against the bounded deadline instead of
            // the steady pacing rate.
            sink.notifyRunFinalized();
            notified = true;
          }
        }
      } catch (error) {
        // The session gave up on its tail: no drain is coming, so waiting
        // is the one thing this continuation must not keep doing. Same
        // staleness guards as a resolution — a superseded hold has already
        // chosen how the session settles, and reporting its engine error
        // now would be noise about a hold nobody is waiting on.
        if (epoch !== holdEpoch || !held.has(id)) {
          return;
        }
        // Release the hold WITHOUT finalizing: `finalize` drains, which
        // hands the same text back to the engine that just refused it
        // MAX_DRAIN_RETRIES times in a row and throws from here. The
        // session keeps its pending text (a later append or flush retries
        // it), and the binding stops reporting `holding: true` for a row it
        // can no longer wait on.
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

    // Whether this binding has ever routed the id BEFORE this delta — the
    // adoption question below, which `recordFor` would erase by minting.
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
      // The session predates this binding: a rebind mid-run (the hook does
      // this on an `events` identity change, which an inline event object
      // makes every render), or a host that created the row's session
      // itself. Whatever it already holds, this instance did not route and
      // cannot reconstruct — so its deltas append onto it instead of
      // replacing it (see `RowRecord.adopted`).
      rec.adopted = true;
      // Text still pending means a reveal is in flight on this row: it was
      // born in a run somebody observed and is being metered out. Stay on
      // the buffered path, because `append` would drain that withheld tail
      // into one commit (see `RowRecord.paced`).
      rec.paced = existing.pendingLength > 0;
    }
    if (!hasAuthority) {
      rec.content += delta;
    }
    if (rec.preexisting) {
      // One-revision commit, never typed. `replace` drains pending and
      // prefix-diffs, so the steady state is a plain append under the hood —
      // but only the full text may be handed to it: the authority's, or the
      // accumulation when this binding has seen the row from its first
      // character. An adopted row appends its delta instead, which is the
      // same one-revision commit without the reset a truncated `replace`
      // would cause — unless the takeover caught it mid-reveal, in which
      // case it keeps metering (see `RowRecord.paced`).
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
      // A spent run's late RUN_FINISHED (behavior i): settling here would
      // end the run this binding is actually observing.
      return;
    }
    // This run is over, so its identity stops meaning "in flight" and
    // starts meaning "spent" — both the id the event carried and the one
    // the observed run start gave us (the same id, for a host that sends
    // both). Clearing `observedRunId` is what keeps a NEXT run whose start
    // this binding never sees able to finalize: its id is unknown, not
    // spent, so it fails open.
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
    if (staleRun(runId)) {
      // A spent run's failure is not this run's failure (behavior i).
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
    // Deliberately NOT marked spent here: AG-UI's failure lifecycle is
    // failed THEN finalized, and that follow-on RUN_FINISHED is a path this
    // binding handles (`terminalFailureSeen` below settles anything the
    // failure did not reach). Filtering it out would skip that. The run is
    // marked spent when the finalize arrives, like any other run end.
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
      // A run that is STARTING is live, whatever this binding remembers
      // about the id: a retry reusing it, a replayed RUN_STARTED, an
      // interleaving that comes back to it. Leaving it spent would filter
      // out the end of a run happening right now and strand its sessions in
      // 'streaming' for the binding's life (behavior i).
      spentRunIds.delete(runId);
    }
    if (observedRunId !== runId) {
      // Whatever was in flight has just been superseded: from here its late
      // RUN_FINISHED / RUN_ERROR must not settle this new run's sessions
      // (behavior i). A repeated start for the same id is not a supersession.
      markRunSpent(observedRunId);
    }
    // The run being observed from here on — including `undefined` from a
    // host that sends no ids, which leaves nothing to mark spent at this
    // run's end rather than carrying the previous run's identity forward.
    observedRunId = runId;
    // Copy at the event boundary: hosts naturally pass their LIVE
    // timeline-id set, and the standard AG-UI order lets them add the
    // newborn id at TEXT_MESSAGE_START — before this binding's lazy
    // pre-existing check at the row's first delta. Held by reference, that
    // mutation would judge every newborn row pre-existing and silently
    // disable pacing; the copy freezes pre-run membership here.
    preRunIds = new Set(existingMessageIds);
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
      // accumulated base rebases. The rewrite is the row's full text, so an
      // adopted row stops being adopted: the fallback is the whole story
      // again and its next delta can go back through `replace`.
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
    // Run observation is gone, and with it the identity of whatever was in
    // flight: the run finishing next may well be one that started during
    // the detached stretch. It is NOT marked spent — it may still be
    // running, and a run this binding cannot see the end of must keep its
    // right to finalize.
    observedRunId = undefined;
    // The spent-run memory goes too, deliberately. Everything in it was
    // learned before a gap this binding cannot see into: a run it watched
    // end may have been retried under the same id, and the catch-up stream
    // may replay that run's lifecycle. Keeping the memory would filter a
    // legitimate run end and strand its sessions in 'streaming' forever;
    // dropping it can at worst let a genuinely late event settle rows early,
    // which the next delta undoes (behavior i's fail-open). Attach clears
    // every other piece of run observation for the same reason.
    spentRunIds.clear();
    endedIds.clear();
    lastDeltaId = null;
    terminalFailureSeen = false;
    for (const rec of rows.values()) {
      rec.preexisting = null;
    }
    // Flush across the STORE, like run-end settling: sessions a previous
    // binding streamed (rebind mid-run) must also reveal their backlog.
    for (const id of [...store.ids()]) {
      store.get(id)?.flushBuffered();
    }
  });

  return () => {
    if (detached) {
      return;
    }
    detached = true;
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
 * What `useAgUiRunSessions` passes to the sessions it creates: the
 * `StreamSessionInit` surface (with the smoother as a factory — one session
 * per row), plus the host `policy`. The same session fields as
 * `UseAgUiSessionInit`, so a host can move between the two hooks without
 * losing a knob; there is no `coalesce` here because the run-scoped binding
 * always buffers a row born inside an observed run.
 *
 * Every session field is read when a row's session is CREATED and holds for
 * that session's life — changing this object on a later render reaches the
 * next new row, not one already streaming. Only `policy` is live (see its
 * own note).
 */
export interface UseAgUiRunSessionsInit {
  /**
   * Parser for every session this hook creates. Absent, sessions use the
   * package default (the native md4c engine) — pass one where native code
   * cannot run, or to swap the parser wholesale.
   */
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
  /** Forwarded to each created session (see `StreamSessionInit`). */
  holdIdleMs?: number;
  /** Forwarded to each created session (see `StreamSessionInit.repair`). */
  repair?: RepairOptions;
  /**
   * Forwarded to each created session (see
   * `StreamSessionInit.bufferScheduler`).
   */
  bufferScheduler?: BufferScheduler;
  /**
   * Forwarded to each created session (see
   * `StreamSessionInit.idleScheduler`).
   */
  idleScheduler?: IdleScheduler;
  /** Forwarded to each created session (see `StreamSessionInit.now`). */
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
 * At unmount every session in the map is disposed: the component owned them,
 * and their flush and idle-drain timers outlive both the view's unsubscribe
 * and the binding's detach (see `StreamSession.dispose`). A host that keeps
 * rendering a session past this component's life must own it itself, through
 * its own store and `bindRunTextEvents`.
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
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
  }
  const store = storeRef.current;

  const [holding, setHolding] = useState(false);

  // Declared before the binding effect so its cleanup is scheduled first.
  // A session's scheduled flushes and idle drains are timers IT owns:
  // unsubscribing a view does not stop them, and detaching the binding does
  // not either, so a screen popping mid-run would leave every held session
  // parsing and committing into a document nobody reads until it drained.
  // Pending text goes with them — nothing renders it any more.
  useDeferredUnmount(() => {
    for (const session of sessions.values()) {
      session.dispose();
    }
    sessions.clear();
  });

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
