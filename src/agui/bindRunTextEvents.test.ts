import type { ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import type { BufferScheduler } from '../stream/StreamSession';
import { StreamSession } from '../stream/StreamSession';
import { createAdaptiveSmoother } from '../stream/smoothing';
import {
  bindRunTextEvents,
  type RunBindingPolicy,
  type RunSessionSink,
  type RunSessionStore,
} from './bindRunTextEvents';
import type { RunFailureInfo, TextMessageEvents } from './useAgUiSession';

type DeltaCb = (messageId: string, delta: string) => void;
type EndCb = (messageId: string) => void;
type VoidCb = () => void;
type FinalizedCb = (runId?: string) => void;
type FailedCb = (info?: RunFailureInfo, runId?: string) => void;
type StartedCb = (
  existingMessageIds: ReadonlySet<string>,
  runId?: string,
) => void;
type ReplacedCb = (messageId: string, content: string) => void;

class FakeEvents implements TextMessageEvents {
  private deltaCbs = new Set<DeltaCb>();
  private endCbs = new Set<EndCb>();
  private finalizedCbs = new Set<FinalizedCb>();
  private failedCbs = new Set<FailedCb>();
  private startedCbs = new Set<StartedCb>();
  private replacedCbs = new Set<ReplacedCb>();
  private attachedCbs = new Set<VoidCb>();

  onTextDelta(cb: DeltaCb): () => void {
    this.deltaCbs.add(cb);
    return () => this.deltaCbs.delete(cb);
  }

  onMessageEnd(cb: EndCb): () => void {
    this.endCbs.add(cb);
    return () => this.endCbs.delete(cb);
  }

  onRunFinalized(cb: FinalizedCb): () => void {
    this.finalizedCbs.add(cb);
    return () => this.finalizedCbs.delete(cb);
  }

  onRunFailed(cb: FailedCb): () => void {
    this.failedCbs.add(cb);
    return () => this.failedCbs.delete(cb);
  }

  onRunStarted(cb: StartedCb): () => void {
    this.startedCbs.add(cb);
    return () => this.startedCbs.delete(cb);
  }

  onMessageReplaced(cb: ReplacedCb): () => void {
    this.replacedCbs.add(cb);
    return () => this.replacedCbs.delete(cb);
  }

  onAttached(cb: VoidCb): () => void {
    this.attachedCbs.add(cb);
    return () => this.attachedCbs.delete(cb);
  }

  emitDelta(messageId: string, delta: string): void {
    for (const cb of [...this.deltaCbs]) cb(messageId, delta);
  }

  emitMessageEnd(messageId: string): void {
    for (const cb of [...this.endCbs]) cb(messageId);
  }

  emitRunFinalized(runId?: string): void {
    for (const cb of [...this.finalizedCbs]) cb(runId);
  }

  emitRunFailed(info?: RunFailureInfo, runId?: string): void {
    for (const cb of [...this.failedCbs]) cb(info, runId);
  }

  emitRunStarted(existingMessageIds: Iterable<string>, runId?: string): void {
    // A Set passes through BY REFERENCE: snapshotting belongs to the
    // binding (it must copy at the event boundary — hosts hand over their
    // live timeline-id set), and copying here would mask a regression in
    // that contract. Arrays still need materializing into a set.
    const snapshot: ReadonlySet<string> =
      existingMessageIds instanceof Set
        ? existingMessageIds
        : new Set(existingMessageIds);
    for (const cb of [...this.startedCbs]) cb(snapshot, runId);
  }

  emitMessageReplaced(messageId: string, content: string): void {
    for (const cb of [...this.replacedCbs]) cb(messageId, content);
  }

  emitAttached(): void {
    for (const cb of [...this.attachedCbs]) cb();
  }

  get subscriptionCount(): number {
    return (
      this.deltaCbs.size +
      this.endCbs.size +
      this.finalizedCbs.size +
      this.failedCbs.size +
      this.startedCbs.size +
      this.replacedCbs.size +
      this.attachedCbs.size
    );
  }
}

/**
 * Recording sink with a controllable pending buffer: `pending` backs
 * `pendingLength`, `settle()` empties it and resolves outstanding
 * `drained()` promises (simulating the smoother finishing its playout), and
 * `flushBuffered` empties it synchronously (as the real session's does).
 */
interface RecordingRunSink extends RunSessionSink {
  calls: string[];
  finalizeReasons: (string | undefined)[];
  pending: number;
  settle(): void;
}

function makeRunSink(): RecordingRunSink {
  let resolvers: Array<() => void> = [];
  const resolveDrained = () => {
    const pending = resolvers;
    resolvers = [];
    for (const resolve of pending) resolve();
  };
  const sink: RecordingRunSink = {
    calls: [],
    finalizeReasons: [],
    pending: 0,
    append(delta: string) {
      sink.calls.push(`append:${delta}`);
    },
    appendBuffered(delta: string) {
      sink.calls.push(`appendBuffered:${delta}`);
    },
    replace(full: string) {
      sink.calls.push(`replace:${full}`);
    },
    rewrite(full: string) {
      sink.calls.push(`rewrite:${full}`);
    },
    flushBuffered() {
      sink.calls.push('flushBuffered');
      sink.pending = 0;
      resolveDrained();
    },
    finalize(reason?: 'end' | 'aborted' | 'failed') {
      sink.calls.push(`finalize:${reason ?? ''}`);
      sink.finalizeReasons.push(reason);
    },
    notifyRunFinalized() {
      sink.calls.push('notifyRunFinalized');
    },
    drained(): Promise<void> {
      if (sink.pending === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    get pendingLength(): number {
      return sink.pending;
    },
    settle() {
      sink.pending = 0;
      resolveDrained();
    },
  };
  return sink;
}

function makeStore() {
  const sinks = new Map<string, RecordingRunSink>();
  const created: string[] = [];
  const evicted: string[] = [];
  const store: RunSessionStore = {
    get: (id) => sinks.get(id),
    create: (id) => {
      created.push(id);
      const sink = makeRunSink();
      sinks.set(id, sink);
      return sink;
    },
    evict: (id) => {
      evicted.push(id);
      sinks.delete(id);
    },
    ids: () => sinks.keys(),
  };
  const sink = (id: string): RecordingRunSink => {
    const found = sinks.get(id);
    if (found === undefined) {
      throw new Error(`no sink for ${id}`);
    }
    return found;
  };
  return { store, sinks, created, evicted, sink };
}

/** Yields the microtask queue so parked drained() continuations run. */
async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Lets a parked run-end continuation finish: after `drained()` resolves it
 * defers one macrotask and re-checks `pendingLength` before finalizing, so
 * settling crosses two timer turns, not just the microtask queue.
 */
async function drainSettles(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('bindRunTextEvents', () => {
  it('seeds a pre-existing id (in the run-start snapshot) via replace, never typed', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted(['m1']);
    events.emitDelta('m1', 'Hello');
    events.emitDelta('m1', ' world');

    expect(sink('m1').calls).toEqual(['replace:Hello', 'replace:Hello world']);
  });

  it('seeds a pre-existing id from policy.getContent when the host provides it', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    // The authority knows about text that arrived before this binding did.
    bindRunTextEvents(events, store, {
      getContent: (id) => `[before-attach for ${id}] + delta`,
    });

    events.emitRunStarted(['m1']);
    events.emitDelta('m1', 'delta');

    expect(sink('m1').calls).toEqual(['replace:[before-attach for m1] + delta']);
  });

  it('routes an id born after an observed run start through appendBuffered, however large the first delta', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    const burst = 'x'.repeat(5000); // one-burst answer must still stream
    events.emitDelta('fresh', burst);
    events.emitDelta('fresh', ' more');

    expect(sink('fresh').calls).toEqual([
      `appendBuffered:${burst}`,
      'appendBuffered: more',
    ]);
  });

  it('treats every id as pre-existing while no run start was observed (preRunIds null)', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    // Attach mid-run / resume: no emitRunStarted.
    events.emitDelta('m1', 'resumed');

    expect(sink('m1').calls).toEqual(['replace:resumed']);
  });

  it('flushes the previous session on a row switch without finalizing it', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'one');
    events.emitDelta('m2', 'two');

    // Deferred one microtask: a render-loop-fed host emits the successor's
    // first delta from render, and an inline flush would notify the
    // previous session's still-subscribed view mid-render.
    expect(sink('m1').calls).toEqual(['appendBuffered:one']);
    await microtasks();
    expect(sink('m1').calls).toEqual(['appendBuffered:one', 'flushBuffered']);
    expect(sink('m1').finalizeReasons).toEqual([]);
    expect(sink('m2').calls).toEqual(['appendBuffered:two']);
  });

  it('routes a rewrite to replace, creating the session as pre-existing if absent', () => {
    const events = new FakeEvents();
    const { store, sink, created } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitMessageReplaced('m9', 'merged content');
    // Subsequent deltas keep the created-as-pre-existing routing: one
    // revision per delta via replace's prefix diff, never typed.
    events.emitDelta('m9', ' tail');

    expect(created).toEqual(['m9']);
    expect(sink('m9').calls).toEqual([
      'replace:merged content',
      'replace:merged content tail',
    ]);
  });

  it('keeps a streaming row streaming across a mid-run rewrite, routed through rewrite', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'live');
    // A born row's rewrite goes through `rewrite`, not `replace`: an edit
    // confined to the unrevealed tail (the digest's link→marker transform
    // at every citation completion) must keep the metered reveal typing
    // instead of dumping the smoother's withheld backlog in one commit.
    // `rewrite` itself escalates to replace semantics when the edit reaches
    // committed text, so this routing is safe for divergent rewrites too.
    events.emitMessageReplaced('m1', 'patched live');
    events.emitDelta('m1', ' on');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:live',
      'rewrite:patched live',
      'appendBuffered: on',
    ]);
  });

  it('keeps replace semantics for a mid-run rewrite of a pre-existing row', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted(['m1']);
    events.emitDelta('m1', 'seeded');
    events.emitMessageReplaced('m1', 'rebased');

    // Pre-existing rows have no metered reveal to protect: their rewrites
    // commit in one revision, exactly like their deltas.
    expect(sink('m1').calls).toEqual(['replace:seeded', 'replace:rebased']);
  });

  it('holds run end for pending sessions, finalizing after drained() with per-id reasons', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('ended', 'a');
    events.emitDelta('cut', 'b');
    events.emitMessageEnd('ended');
    sink('ended').pending = 3;
    sink('cut').pending = 5;

    events.emitRunFinalized();
    expect(holds).toEqual([true]);
    // Held sinks are told the run is over (before their parked finalize —
    // nothing has finalized yet), so an adaptive smoother switches to its
    // bounded run-end drain instead of trailing out at the pacing rate.
    expect(sink('ended').calls).toContain('notifyRunFinalized');
    expect(sink('cut').calls).toContain('notifyRunFinalized');
    expect(sink('ended').finalizeReasons).toEqual([]);
    expect(sink('cut').finalizeReasons).toEqual([]);

    sink('ended').settle();
    await drainSettles();
    expect(sink('ended').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true]); // one session still held

    sink('cut').settle();
    await drainSettles();
    expect(sink('cut').finalizeReasons).toEqual(['aborted']);
    expect(holds).toEqual([true, false]); // last held session settled
  });

  it('parks a drained-but-fed session through the one-macrotask re-check at run end', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'text');
    events.emitMessageEnd('m1');
    events.emitRunFinalized();

    // Fed this run: even with nothing pending, the settle waits one
    // macrotask for a final render-loop feed before finalizing.
    expect(sink('m1').finalizeReasons).toEqual([]);
    expect(holds).toEqual([true]);
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
    // No run-over notification for a session with nothing pending: it would
    // arm a drain state nothing drains (and so nothing resets) before the
    // smoother's next run.
    expect(sink('m1').calls).not.toContain('notifyRunFinalized');
  });

  it('finalizes a session untouched this run synchronously at run end', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'text');
    events.emitMessageEnd('m1');
    events.emitRunFinalized();
    events.emitRunStarted(['m1']);
    // A run that never touched m1 (tool-only shape): its settle is
    // synchronous — no hold, no macrotask tax.
    events.emitRunFinalized();
    expect(
      sink('m1').finalizeReasons[sink('m1').finalizeReasons.length - 1],
    ).toBe('aborted');
    expect(holds).toEqual([true, false]);
  });

  it('a final feed landing in the re-check window is typed, notified lazily', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'stalled tail');
    events.emitMessageEnd('m1');
    // Smoother fully drained before run end; the final throttle window of
    // text is still riding the host's render loop.
    events.emitRunFinalized();
    expect(holds).toEqual([true]);
    sink('m1').pending = 4; // the late feed lands before the re-check

    await drainSettles();
    // Caught: the session was told the run is over (lazily — it was parked
    // empty) and stays held until it drains.
    expect(sink('m1').calls).toContain('notifyRunFinalized');
    expect(sink('m1').finalizeReasons).toEqual([]);
    expect(holds).toEqual([true]);

    sink('m1').settle();
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
  });

  it('releases the hold and reports the error when a session abandons its drain', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const engineError = new Error('engine refused every drain');
    try {
      bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

      events.emitRunStarted([]);
      events.emitDelta('m1', 'tail');
      events.emitMessageEnd('m1');
      const held = sink('m1');
      held.pending = 4;
      // Stands in for a session that abandoned its drain after MAX_DRAIN_RETRIES failures.
      held.drained = () => Promise.reject(engineError);
      events.emitRunFinalized();
      expect(holds).toEqual([true]);

      await drainSettles();

      // Released without finalizing: finalize would drain into the same failing engine.
      expect(holds).toEqual([true, false]);
      expect(held.finalizeReasons).toEqual([]);
      expect(held.calls).toEqual(['appendBuffered:tail', 'notifyRunFinalized']);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain('m1');
      expect(consoleError.mock.calls[0]?.[1]).toBe(engineError);
      expect(unhandled).toEqual([]);
    } finally {
      consoleError.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('finalizes immediately on terminal failure: flush first, no hold', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'partial');
    sink('m1').pending = 4;
    events.emitRunFailed({ disposition: 'failed' });

    expect(sink('m1').calls).toEqual([
      'appendBuffered:partial',
      'flushBuffered',
      'finalize:failed',
    ]);
    expect(holds).toEqual([]);
  });

  it("maps an absent disposition to 'failed' and 'aborted' to 'aborted'", () => {
    for (const [info, reason] of [
      [undefined, 'failed'],
      [{ disposition: 'aborted' }, 'aborted'],
    ] as const) {
      const events = new FakeEvents();
      const { store, sink } = makeStore();
      bindRunTextEvents(events, store);
      events.emitRunStarted([]);
      events.emitDelta('m1', 'x');
      events.emitRunFailed(info);
      expect(sink('m1').finalizeReasons).toEqual([reason]);
    }
  });

  it('cancels an up hold on terminal failure and ignores the stale drained resolution', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'tail');
    sink('m1').pending = 4;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    events.emitRunFailed({ disposition: 'failed' });
    expect(holds).toEqual([true, false]);
    // flushBuffered emptied pending, which resolved drained(): the parked
    // run-end continuation must not double-finalize or re-fire the hold.
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['failed']);
    expect(holds).toEqual([true, false]);
  });

  it('treats a benign failure as a no-op and keeps the stream appendable', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'before');
    events.emitRunFailed({ disposition: 'benign' });
    events.emitDelta('m1', ' after'); // the follow-up resume keeps appending

    expect(sink('m1').finalizeReasons).toEqual([]);
    expect(sink('m1').calls).toEqual([
      'appendBuffered:before',
      'appendBuffered: after',
    ]);
    expect(holds).toEqual([]);
  });

  it('detaches idempotently, unsubscribing everything and cancelling the hold', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    const detach = bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
    });
    expect(events.subscriptionCount).toBe(7);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'tail');
    sink('m1').pending = 4;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    detach();
    expect(events.subscriptionCount).toBe(0);
    expect(holds).toEqual([true, false]);
    expect(() => detach()).not.toThrow();

    // The dropped hold callback must not finalize after detach.
    sink('m1').settle();
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual([]);

    // Unsubscribed: late emissions route nothing.
    events.emitDelta('m1', 'late');
    events.emitRunFinalized();
    expect(sink('m1').calls).toEqual([
      'appendBuffered:tail',
      'notifyRunFinalized', // from the pre-detach run end's hold
    ]);
  });

  it('flushes a leftover hold on a new run start and re-arms preRunIds', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'run one');
    sink('m1').pending = 7;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    // New run while the drain is still playing out: the held session flushes
    // and settles with its run-end reason ('aborted' — m1 never ended).
    events.emitRunStarted(['m1', 'm2']);
    expect(sink('m1').calls).toEqual([
      'appendBuffered:run one',
      'notifyRunFinalized',
      'flushBuffered',
      'finalize:aborted',
    ]);
    expect(holds).toEqual([true, false]);
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['aborted']); // stale continuation no-oped

    // The new snapshot is the authority now: m2 pre-exists (replace),
    // a genuinely new row streams (appendBuffered) — and m1's routing was
    // re-judged against the new snapshot too.
    events.emitDelta('m2', 'adopted');
    expect(sink('m2').calls).toEqual(['replace:adopted']);
    events.emitDelta('m3', 'fresh');
    expect(sink('m3').calls).toEqual(['appendBuffered:fresh']);
    await microtasks(); // the row-switch flush is deferred one microtask
    expect(sink('m2').calls).toEqual(['replace:adopted', 'flushBuffered']);
    events.emitDelta('m1', ' resumed');
    expect(sink('m1').calls[sink('m1').calls.length - 1]).toBe(
      'replace:run one resumed',
    );
  });

  it('consults evictOnRunStart per stored id and evicts through the store', () => {
    const events = new FakeEvents();
    const { store, sink, evicted, created } = makeStore();
    bindRunTextEvents(events, store, {
      evictOnRunStart: (id) => id === 'stale',
    });

    events.emitRunStarted([]);
    events.emitDelta('stale', 'old');
    events.emitDelta('kept', 'still here');
    events.emitRunFinalized();

    events.emitRunStarted(['kept']);
    expect(evicted).toEqual(['stale']);

    // An evicted id starts over: a fresh session, seeded only from what
    // arrives now (its old accumulated content is gone with its record).
    events.emitDelta('stale', 'new');
    expect(created).toEqual(['stale', 'kept', 'stale']);
    expect(sink('stale').calls).toEqual(['appendBuffered:new']);
  });

  it('settles store sessions a fresh binding never routed at run end (rebind mid-run)', async () => {
    const events1 = new FakeEvents();
    const { store, sink, created } = makeStore();
    const detach = bindRunTextEvents(events1, store);
    events1.emitRunStarted([]);
    events1.emitDelta('m1', 'first');
    events1.emitMessageEnd('m1');
    // Transport reconnect: the hook re-binds a NEW instance on the same
    // ref-held store; the old instance's rows map is gone with it.
    detach();

    const events2 = new FakeEvents();
    bindRunTextEvents(events2, store);
    events2.emitDelta('m2', 'second');
    events2.emitMessageEnd('m2');
    events2.emitRunFinalized();

    // m1 was routed only by the detached binding — untouched for binding
    // #2, it settles synchronously: 'aborted', since binding #2 never saw
    // its message end — dropping its tail repairs instead of leaving it
    // 'streaming' forever. m2 was fed, so it takes the macrotask re-check.
    expect(sink('m1').finalizeReasons).toEqual(['aborted']);
    await drainSettles();
    expect(sink('m2').finalizeReasons).toEqual(['end']);
    // Settling reads the store, it never mints sessions.
    expect(created).toEqual(['m1', 'm2']);
  });

  it('settles store sessions a fresh binding never routed on terminal failure', () => {
    const events1 = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events1, store);
    events1.emitRunStarted([]);
    events1.emitDelta('m1', 'first');
    sink('m1').pending = 5;
    detach();

    const events2 = new FakeEvents();
    bindRunTextEvents(events2, store);
    events2.emitDelta('m2', 'second');
    events2.emitRunFailed({ disposition: 'failed' });

    // The inherited session's buffered tail flushes and it settles with the
    // failure reason, same as the rows this instance routed itself.
    expect(sink('m1').calls).toEqual([
      'appendBuffered:first',
      'flushBuffered',
      'finalize:failed',
    ]);
    expect(sink('m2').finalizeReasons).toEqual(['failed']);
  });

  it('snapshots preRunIds at run start: a live host set mutated before the first delta cannot flip routing', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    // The host wires its LIVE timeline-id collection, as the interface's
    // "ids of every message already present" naturally invites.
    const liveIds = new Set<string>(['old']);
    events.emitRunStarted(liveIds);
    // Standard AG-UI order: the host adds the newborn id at
    // TEXT_MESSAGE_START — before the binding's lazy pre-existing check
    // runs at the row's first content delta.
    liveIds.add('fresh');
    events.emitDelta('fresh', 'should be typed out');

    // Judged against the run-start snapshot, not the mutated live set: the
    // newborn row still streams instead of committing in one revision.
    expect(sink('fresh').calls).toEqual(['appendBuffered:should be typed out']);
  });

  it('skips content accumulation when a getContent authority is latched at bind', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const policy: RunBindingPolicy = { getContent: () => 'authoritative' };
    bindRunTextEvents(events, store, policy);

    events.emitRunStarted(['pre']);
    events.emitDelta('pre', 'dead');
    events.emitDelta('pre', ' weight');
    events.emitMessageReplaced('pre', 'rebased');
    expect(sink('pre').calls).toEqual([
      'replace:authoritative',
      'replace:authoritative',
      'replace:rebased',
    ]);

    // White-box probe of the memory contract: presence is latched at bind
    // (the property must stay present — see `RunBindingPolicy.getContent`),
    // so the fallback copy must never have been built. Removing the
    // implementation out-of-contract exposes the fallback directly: an
    // empty replace proves the text was skipped, not merely shadowed.
    delete policy.getContent;
    events.emitDelta('pre', '!');
    expect(sink('pre').calls[sink('pre').calls.length - 1]).toBe('replace:');
  });

  it('drops orphaned row records at run start after a direct host eviction through the store', () => {
    const events = new FakeEvents();
    const { store, sink, created } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'old text');
    events.emitRunFinalized();

    // Host trims memory DIRECTLY through its store — sanctioned by the
    // `RunSessionStore` doc — bypassing `evictOnRunStart` entirely.
    store.evict('m1');

    // The next observed run start reconciles rows against the store: the
    // orphaned record goes with its accumulated content, so the id starts
    // over seeded only from what arrives now (exactly the semantics of an
    // `evictOnRunStart` eviction) — not from a leaked stale base.
    events.emitRunStarted(['m1']);
    events.emitDelta('m1', 'fresh');
    expect(created).toEqual(['m1', 'm1']);
    expect(sink('m1').calls).toEqual(['replace:fresh']);
  });

  it('does not forward empty deltas', () => {
    const events = new FakeEvents();
    const { store, sink, created } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', '');
    expect(created).toEqual([]);
    events.emitDelta('m1', 'a');
    events.emitDelta('m1', '');

    expect(created).toEqual(['m1']);
    expect(sink('m1').calls).toEqual(['appendBuffered:a']);
  });

  it('remains satisfiable by a source typed with the legacy zero-arg onRunFailed', () => {
    // Compile-time contract, both directions: (1) a legacy source — no
    // optional members, zero-arg failure callback — still satisfies the
    // widened interface; (2) a legacy zero-arg callback is still accepted
    // by a source typed with the widened shape.
    let emitDelta: (messageId: string, delta: string) => void = () => {};
    let emitFailed: () => void = () => {};
    const legacy = {
      onTextDelta: (cb: (messageId: string, delta: string) => void) => {
        emitDelta = cb;
        return () => {};
      },
      onMessageEnd: (_cb: (messageId: string) => void) => () => {},
      onRunFinalized: (_cb: () => void) => () => {},
      onRunFailed: (cb: () => void) => {
        emitFailed = cb;
        return () => {};
      },
    };
    const asEvents: TextMessageEvents = legacy;
    const widened: TextMessageEvents = new FakeEvents();
    const off = widened.onRunFailed(() => {});
    off();

    const { store, sink } = makeStore();
    bindRunTextEvents(asEvents, store);
    // No observed run start, so the row is pre-existing; a zero-arg failure maps to 'failed'.
    emitDelta('m1', 'hi');
    emitFailed();

    expect(sink('m1').calls).toEqual([
      'replace:hi',
      'flushBuffered',
      'finalize:failed',
    ]);
  });

  it('re-checks pending one macrotask after the drain and re-parks while new text appears', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'burst');
    events.emitMessageEnd('m1');
    sink('m1').pending = 5;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    // The smoother finishes its playout — but the host's final snapshot is
    // still riding a render effect: new pending appears before the parked
    // continuation's macrotask re-check runs.
    sink('m1').settle();
    sink('m1').pending = 3;
    await drainSettles();
    // Re-parked, not finalized: draining what the session HAD was not yet
    // proof it had everything.
    expect(sink('m1').finalizeReasons).toEqual([]);
    expect(holds).toEqual([true]);

    sink('m1').settle();
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
  });

  it("arms a bounded run-end grace and adopts the late row's first delta into the drain", async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 2000,
      expectsLateRow: (id) => (id === null ? true : id === 'late'),
    });

    events.emitRunStarted([]);
    // One-burst answer: run end arrives in the same task as the answer
    // text, before any of it has reached this binding through the host's
    // render loop.
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    events.emitDelta('late', 'the whole answer');
    // Adopted: routed born (so it types), told the run is over, and held.
    expect(sink('late').calls).toEqual([
      'appendBuffered:the whole answer',
      'notifyRunFinalized',
    ]);
    sink('late').pending = 6;
    await drainSettles();
    expect(sink('late').finalizeReasons).toEqual([]);
    expect(holds).toEqual([true]); // still draining

    sink('late').settle();
    await drainSettles();
    // A clean run end delivered late is still a clean end.
    expect(sink('late').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
  });

  it('adopts a born row first fed while a predecessor still drains, extending the hold', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 2000,
      expectsLateRow: (id) => id !== null,
    });

    events.emitRunStarted([]);
    events.emitDelta('predecessor', 'still typing at run end');
    events.emitMessageEnd('predecessor');
    sink('predecessor').pending = 9;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    // The final snapshot resegmented the tail: the successor stretch mounts
    // and takes its first feed while the predecessor drains. Adopted: it
    // types, and the hold now waits for BOTH.
    events.emitDelta('successor', 'the closing stretch');
    expect(sink('successor').calls).toEqual([
      'appendBuffered:the closing stretch',
      'notifyRunFinalized',
    ]);
    sink('successor').pending = 6;

    sink('predecessor').settle();
    await drainSettles();
    expect(sink('predecessor').finalizeReasons).toEqual(['end']);
    // The successor keeps the run open — its reveal must not be cut short.
    expect(holds).toEqual([true]);

    sink('successor').settle();
    await drainSettles();
    expect(sink('successor').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
  });

  it('releases an unanswered grace when the bound expires', async () => {
    const events = new FakeEvents();
    const { store } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 40,
      expectsLateRow: (id) => id === null,
    });

    events.emitRunStarted([]);
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    await sleep(80);
    expect(holds).toEqual([true, false]);
  });

  it('never arms the grace when the host expects no late row', () => {
    const events = new FakeEvents();
    const { store } = makeStore();
    const holds: boolean[] = [];
    let expecting = false;
    const detach = bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 2000,
      expectsLateRow: () => expecting,
    });

    events.emitRunStarted([]);
    events.emitRunFinalized();
    // Synchronous release: a run with nothing to wait for must not tax
    // status with the grace bound.
    expect(holds).toEqual([]);

    expecting = true;
    events.emitRunStarted([]);
    events.emitRunFinalized();
    expect(holds).toEqual([true]);
    detach();
  });

  it('never arms the grace for the finalize that follows a terminal failure', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 2000,
      expectsLateRow: (id) => id === null,
    });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'partial');
    events.emitRunFailed({ disposition: 'failed' });
    // AG-UI's failure lifecycle: failed THEN finalized. The failure settled
    // everything — the finalize that follows must not re-open the run.
    events.emitRunFinalized();

    expect(holds).toEqual([]);
    expect(sink('m1').finalizeReasons[0]).toBe('failed');
  });

  it('a new run start cancels an armed grace; the late row joins the new run instead', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 2000,
      expectsLateRow: () => true,
    });

    events.emitRunStarted([]);
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    events.emitRunStarted([]);
    expect(holds).toEqual([true, false]);

    // Not adopted into the superseded run end: no run-over notification,
    // no parked finalize — just a born row of the new run.
    events.emitDelta('late', 'steer answer');
    expect(sink('late').calls).toEqual(['appendBuffered:steer answer']);
  });

  it("a pre-existing row's delta during the grace is not adopted and leaves it armed", async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, {
      onHoldChanged: (h) => holds.push(h),
      runEndGraceMs: 40,
      expectsLateRow: (id) => id === null,
    });

    events.emitRunStarted(['old']);
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    // A late replace-shaped catch-up for an old row is not the awaited
    // one-burst answer: it paints, and the grace keeps waiting for its row.
    events.emitDelta('old', 'tail');
    expect(sink('old').calls).toEqual(['replace:tail']);
    expect(sink('old').finalizeReasons).toEqual([]);
    expect(holds).toEqual([true]);

    await sleep(80);
    expect(holds).toEqual([true, false]);
  });

  it('attach flushes buffered sessions, drops run observation, and re-judges rows pre-existing', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('born', 'typing');
    events.emitAttached();

    // One-commit catch-up: the buffered backlog reveals...
    expect(sink('born').calls).toEqual([
      'appendBuffered:typing',
      'flushBuffered',
    ]);

    // ...and every row re-judges pre-existing (run observation dropped), so
    // nothing re-types after an attach — not the row that was typing, not a
    // row first seen now.
    events.emitDelta('born', ' more');
    expect(sink('born').calls[sink('born').calls.length - 1]).toBe(
      'replace:typing more',
    );
    events.emitDelta('fresh', 'post-attach');
    expect(sink('fresh').calls).toEqual(['replace:post-attach']);
  });

  it('attach during a run-end hold flushes the held session, which settles with its run-end reason', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'tail');
    events.emitMessageEnd('m1');
    sink('m1').pending = 4;
    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    events.emitAttached();
    // The flush emptied the session, so the parked continuation finalizes
    // with the reason captured at run end and releases the hold itself.
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
    expect(holds).toEqual([true, false]);
  });

  it('appends for a row whose session predates this binding instead of replacing it with the tail it saw', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'Hello ');
    events.emitDelta('m1', 'world. ');

    // Rebind mid-run, as the hook does on an `events` identity change.
    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', 'and it ');
    events.emitDelta('m1', 'continues.');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:Hello ',
      'appendBuffered:world. ',
      'appendBuffered:and it ',
      'appendBuffered:continues.',
    ]);
  });

  it('replaces from the authority after a rebind, which knows the whole row', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    let content = '';
    const policy: RunBindingPolicy = { getContent: () => content };
    const detach = bindRunTextEvents(events, store, policy);

    events.emitRunStarted([]);
    content = 'Hello ';
    events.emitDelta('m1', 'Hello ');

    detach();
    bindRunTextEvents(events, store, policy);
    content = 'Hello world.';
    events.emitDelta('m1', 'world.');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:Hello ',
      'replace:Hello world.',
    ]);
  });

  it("appends into a session the host created before the row's first delta", () => {
    const events = new FakeEvents();
    const { store, sink, created } = makeStore();
    bindRunTextEvents(events, store);
    // What the hook's `sessionFor` does when the host renders a row before its text.
    store.create('m1');

    events.emitRunStarted(['m1']);
    events.emitDelta('m1', 'first');
    events.emitDelta('m1', ' second');

    expect(created).toEqual(['m1']);
    expect(sink('m1').calls).toEqual(['append:first', 'append: second']);
  });

  it('a rewrite ends adoption: the row goes back to replacing with the full text', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'streamed');
    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', ' tail');
    events.emitMessageReplaced('m1', 'whole text');
    events.emitDelta('m1', ' more');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:streamed',
      'appendBuffered: tail',
      'replace:whole text',
      'replace:whole text more',
    ]);
  });

  it('keeps a row adopted across a later run start, whose snapshot re-seeds nothing', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'Hello ');
    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', 'world. ');

    events.emitRunStarted(['m1'], 'run-2');
    events.emitDelta('m1', 'More.');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:Hello ',
      'appendBuffered:world. ',
      'append:More.',
    ]);
  });

  it('ends adoption when the host evicts the row at run start', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'Hello ');
    detach();
    bindRunTextEvents(events, store, { evictOnRunStart: (id) => id === 'm1' });
    events.emitDelta('m1', 'world. ');

    events.emitRunStarted(['m1'], 'run-2');
    events.emitDelta('m1', 'fresh');

    expect(sink('m1').calls).toEqual(['replace:fresh']);
  });

  it('keeps an adopted row metered when the takeover caught it mid-reveal', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'Hello world, a long answer. ');
    // The smoother still owes 24 characters when the rebind happens.
    sink('m1').pending = 24;

    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', 'x');
    events.emitDelta('m1', 'yz');

    expect(sink('m1').calls).toEqual([
      'appendBuffered:Hello world, a long answer. ',
      'appendBuffered:x',
      'appendBuffered:yz',
    ]);
  });

  it('ignores a run finalize belonging to a run it watched be superseded', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitRunStarted([], 'run-2');
    events.emitDelta('m1', 'live');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual([]);

    events.emitRunFinalized('run-2');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
  });

  it('ignores a run failure belonging to a run it watched be superseded', () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitRunStarted([], 'run-2');
    events.emitDelta('m1', 'live');
    events.emitRunFailed({ disposition: 'failed' }, 'run-1');
    expect(sink('m1').finalizeReasons).toEqual([]);

    events.emitRunFailed({ disposition: 'failed' }, 'run-2');
    expect(sink('m1').finalizeReasons).toEqual(['failed']);
  });

  it('settles a run whose start it never saw: an unknown id is not a stale one', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'first answer');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    events.emitDelta('m2', 'second answer');
    events.emitMessageEnd('m2');
    events.emitRunFinalized('run-2');
    await drainSettles();

    expect(sink('m2').finalizeReasons).toEqual(['end']);
  });

  it('drops a repeat of a run end it already acted on', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'live');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    events.emitDelta('m2', 'next answer');
    events.emitRunFinalized('run-1');
    await drainSettles();

    expect(sink('m2').finalizeReasons).toEqual([]);
  });

  it('settles a run that starts again under an id it watched end', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'first answer');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    events.emitRunStarted(['m1'], 'run-1');
    events.emitDelta('m2', 'second answer');
    events.emitMessageEnd('m2');
    events.emitRunFinalized('run-1');
    await drainSettles();

    expect(sink('m2').finalizeReasons).toEqual(['end']);
  });

  it('revives an id that comes back into observation after being superseded', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitRunStarted([], 'run-2');
    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'live');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    // run-2 was never revived, so its late end is still filtered.
    events.emitDelta('m2', 'next answer');
    events.emitRunFinalized('run-2');
    await drainSettles();

    expect(sink('m2').finalizeReasons).toEqual([]);
  });

  it('clears the spent-run memory on attach, so a retried id can finalize', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'before the gap');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-1');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    events.emitAttached();
    events.emitDelta('m2', 'after the gap');
    events.emitMessageEnd('m2');
    events.emitRunFinalized('run-1');
    await drainSettles();

    expect(sink('m2').finalizeReasons).toEqual(['end']);
  });

  it('filters nothing when the observed run start carried no id', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'live');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-9');
    await drainSettles();

    expect(sink('m1').finalizeReasons).toEqual(['end']);
  });

  it('drops run identity on attach, so the caught-up run can still finalize', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'live');
    events.emitAttached();
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-2');
    await drainSettles();

    expect(sink('m1').finalizeReasons).toEqual(['end']);
  });

  it('ignores a finalize naming a different run than the one in flight, and still settles the observed run', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-A');
    events.emitDelta('m1', 'Hello');
    events.emitRunFinalized('run-B');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual([]);

    events.emitDelta('m1', ' world');
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-A');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    // The foreign run-B end still marked run-B spent.
    events.emitDelta('m2', 'next');
    events.emitRunFinalized('run-B');
    await drainSettles();
    expect(sink('m2').finalizeReasons).toEqual([]);
  });

  it('ignores a failure naming a different run than the one in flight', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-A');
    events.emitDelta('m1', 'live');
    events.emitRunFailed({ disposition: 'failed' }, 'run-B');
    expect(sink('m1').finalizeReasons).toEqual([]);

    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-A');
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);
  });

  it('settles the observed run on a finalize that carries no id', async () => {
    const events = new FakeEvents();
    const { store, sink } = makeStore();
    bindRunTextEvents(events, store);

    events.emitRunStarted([], 'run-A');
    events.emitDelta('m1', 'live');
    events.emitMessageEnd('m1');
    events.emitRunFinalized();
    await drainSettles();
    expect(sink('m1').finalizeReasons).toEqual(['end']);

    // The id-less end retired run-A, so its late duplicate is filtered.
    events.emitDelta('m2', 'next');
    events.emitRunFinalized('run-A');
    await drainSettles();
    expect(sink('m2').finalizeReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real StreamSessions where the fake sink is not enough: the drained-hold
// against a session actually metering text out through a smoother, driven by
// a manual scheduler (nothing fires until the test says so — the pattern
// from stream/buffering.test.ts).
// ---------------------------------------------------------------------------

/** Manual stand-in for the frame scheduler: fires only when told to. */
function manualFrame() {
  let next: (() => void) | null = null;
  const scheduler: BufferScheduler = (flush) => {
    next = flush;
    return () => {
      next = null;
    };
  };
  return {
    scheduler,
    fire() {
      const f = next;
      next = null;
      f?.();
    },
    get pending() {
      return next !== null;
    },
  };
}

/**
 * Whole-source-as-one-paragraph engine: satisfies the session's span
 * invariant (text value === source slice) without the native md4c addon.
 */
const wholeParagraphEngine: Engine = {
  name: 'whole-paragraph',
  parse(source: string): ParsedDocument {
    const span = { start: 0, end: source.length };
    return {
      source,
      blocks: [
        { kind: 'paragraph', span, children: [{ kind: 'text', span, value: source }] },
      ],
    };
  },
};

describe('bindRunTextEvents over real StreamSessions', () => {
  it('holds run end until the smoothed tail drains, then finalizes settled', async () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          // Idle drain suppressed: the test drives every flush explicitly.
          idleScheduler: () => () => {},
          smoother: () => 4, // metered release: 4 units per fired flush
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    events.emitRunStarted([]);
    events.emitDelta('m1', 'Hello world.'); // 12 units, 3 metered flushes
    events.emitMessageEnd('m1');
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }

    frame.fire(); // reveals 'Hell', 8 still pending
    events.emitRunFinalized();
    expect(holds).toEqual([true]);
    expect(session.snapshot().phase).toBe('streaming'); // not cut short
    expect(session.pendingLength).toBe(8);

    frame.fire();
    frame.fire(); // pending drains to 0 → drained() resolves
    expect(session.pendingLength).toBe(0);
    await drainSettles();

    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe('Hello world.');
    expect(holds).toEqual([true, false]);
  });

  it('run end switches an adaptive smoother to its bounded drain', async () => {
    const frame = manualFrame();
    const clock = () => 0;
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
          smoother: createAdaptiveSmoother({ now: clock }),
          now: clock,
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    const holds: boolean[] = [];
    bindRunTextEvents(events, store, { onHoldChanged: (h) => holds.push(h) });

    const text = 'word '.repeat(20); // 100 units — a drain-instant-sized tail
    events.emitRunStarted([]);
    events.emitDelta('m1', text);
    events.emitMessageEnd('m1');
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    expect(session.pendingLength).toBe(100);

    events.emitRunFinalized();
    expect(holds).toEqual([true]);

    // The hold notified the smoother, so this flush takes the run-end drain:
    // a ≤120-char tail releases in ONE commit. Under steady pacing the same
    // flush would release ~23 units (fallback 180cps × catch-up 1.3 over one
    // 100ms nominal tick) and strand the rest behind further frames.
    frame.fire();
    expect(session.pendingLength).toBe(0);
    await drainSettles();

    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe(text);
    expect(holds).toEqual([true, false]);
  });

  it('a benign failure leaves a real session streaming and a resume keeps appending', () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'first half');
    frame.fire();
    events.emitRunFailed({ disposition: 'benign' });

    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    expect(session.snapshot().phase).toBe('streaming');

    events.emitDelta('m1', ' and the rest');
    frame.fire();
    expect(session.snapshot().document.source).toBe('first half and the rest');
    expect(session.snapshot().phase).toBe('streaming');
  });

  it("a born row's rewrite confined to the unrevealed tail keeps the metered reveal", () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
          smoother: () => 4, // metered release: 4 units per fired flush
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'abcdefgh'); // born → appendBuffered
    frame.fire(); // commits 'abcd', 'efgh' still pending
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    expect(session.snapshot().document.source).toBe('abcd');

    // The rewrite lands entirely inside the unrevealed tail (the committed
    // text is a prefix of the new full text): the binding routes it through
    // `rewrite`, which swaps only the pending buffer — nothing dumps, the
    // committed prefix stays, and the reveal keeps metering.
    events.emitMessageReplaced('m1', 'abcdWXYZ12');
    expect(session.snapshot().document.source).toBe('abcd');
    expect(session.pendingLength).toBe(6);

    frame.fire();
    expect(session.snapshot().document.source).toBe('abcdWXYZ');
    frame.fire();
    expect(session.snapshot().document.source).toBe('abcdWXYZ12');
  });

  it('a rebind mid-run keeps the streamed document instead of resetting it to the next delta', () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    // No `getContent`, so only adoption keeps the earlier text.
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'Hello ');
    events.emitDelta('m1', 'world, ');
    events.emitDelta('m1', 'this is a long answer. ');
    frame.fire();
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    expect(session.snapshot().document.source).toBe(
      'Hello world, this is a long answer. ',
    );

    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', 'and it continues.');
    expect(session.pendingLength).toBeGreaterThan(0);
    session.flushBuffered();

    expect(session.snapshot().document.source).toBe(
      'Hello world, this is a long answer. and it continues.',
    );
    expect(session.snapshot().phase).toBe('streaming');
  });

  it('a rebind mid-reveal keeps pacing the row instead of dumping its tail', () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
          smoother: () => 4, // metered release: 4 units per fired flush
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    const detach = bindRunTextEvents(events, store);

    events.emitRunStarted([]);
    events.emitDelta('m1', 'Hello world, a long answer. ');
    frame.fire();
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    expect(session.snapshot().document.source).toBe('Hell');
    expect(session.pendingLength).toBe(24);

    detach();
    bindRunTextEvents(events, store);
    events.emitDelta('m1', 'x');

    expect(session.snapshot().document.source).toBe('Hell');
    expect(session.pendingLength).toBe(25);

    frame.fire();
    expect(session.snapshot().document.source).toBe('Hello wo');
    expect(session.snapshot().phase).toBe('streaming');
  });

  it('settles the observed run after a finalize for an unseen run arrived mid-stream', async () => {
    const frame = manualFrame();
    const sessions = new Map<string, StreamSession>();
    const store: RunSessionStore = {
      get: (id) => sessions.get(id),
      create: (id) => {
        const session = new StreamSession({
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
        });
        sessions.set(id, session);
        return session;
      },
      evict: (id) => {
        sessions.delete(id);
      },
      ids: () => sessions.keys(),
    };
    const events = new FakeEvents();
    bindRunTextEvents(events, store);
    const flush = () => {
      while (frame.pending) frame.fire();
    };

    events.emitRunStarted([], 'run-A');
    events.emitDelta('m1', 'Hello');
    flush();
    const session = sessions.get('m1');
    if (session === undefined) {
      throw new Error('session not created');
    }
    events.emitRunFinalized('run-B');
    flush();
    await drainSettles();
    expect(session.snapshot().phase).toBe('streaming');

    events.emitDelta('m1', ' world');
    flush();
    events.emitMessageEnd('m1');
    events.emitRunFinalized('run-A');
    flush();
    await drainSettles();

    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe('Hello world');
  });
});

test('rebinding adopts a run-end hold and finalizes it after the drain', async () => {
  const events = new FakeEvents();
  const { store, sink } = makeStore();
  const detach = bindRunTextEvents(events, store);
  events.emitRunStarted([]);
  events.emitDelta('m1', 'tail');
  events.emitMessageEnd('m1');
  sink('m1').pending = 4;
  events.emitRunFinalized();
  detach();
  const holds: boolean[] = [];
  const detachNext = bindRunTextEvents(events, store, { onHoldChanged: value => holds.push(value) });
  expect(holds).toEqual([true]);
  sink('m1').settle();
  await drainSettles();
  expect(sink('m1').finalizeReasons).toEqual(['end']);
  expect(holds).toEqual([true, false]);
  detachNext();
});

test('a transferred empty hold notifies the smoother when its late tail arrives', async () => {
  const events = new FakeEvents();
  const { store, sink } = makeStore();
  const detach = bindRunTextEvents(events, store);
  events.emitRunStarted([]);
  events.emitDelta('m1', 'body');
  events.emitMessageEnd('m1');
  events.emitRunFinalized();
  expect(sink('m1').calls).not.toContain('notifyRunFinalized');
  sink('m1').pending = 4;
  detach();
  const detachNext = bindRunTextEvents(events, store);
  expect(sink('m1').calls.filter(call => call === 'notifyRunFinalized')).toHaveLength(1);
  sink('m1').settle();
  await drainSettles();
  expect(sink('m1').finalizeReasons).toEqual(['end']);
  detachNext();
});


test('reused run IDs finalize each message without a run-start subscription', async () => {
  const events = new FakeEvents();
  const { store, sink } = makeStore();
  const detach = bindRunTextEvents({
    onTextDelta: events.onTextDelta.bind(events),
    onMessageEnd: events.onMessageEnd.bind(events),
    onRunFinalized: events.onRunFinalized.bind(events),
    onRunFailed: events.onRunFailed.bind(events),
  }, store);
  for (const id of ['first', 'second']) {
    events.emitDelta(id, id);
    events.emitMessageEnd(id);
    events.emitRunFinalized('thread-id');
    await drainSettles();
    expect(sink(id).finalizeReasons).toEqual(['end']);
  }
  detach();
});
