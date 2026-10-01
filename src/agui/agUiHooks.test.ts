// No React renderer is a dependency, so the hooks run on a minimal dispatcher in React's own slot.
import * as React from 'react';
import type { ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import type { BufferScheduler } from '../stream/StreamSession';
import { useAgUiRunSessions } from './bindRunTextEvents';
import { useAgUiSession, type TextMessageEvents } from './useAgUiSession';

interface DispatcherSlot {
  current: unknown;
}

const reactInternals = (React as unknown as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const dispatcherSlot: DispatcherSlot = {
  get current() { return reactInternals.H; },
  set current(value) { reactInternals.H = value; },
};

interface RefSlot {
  kind: 'ref';
  ref: { current: unknown };
}
interface EffectSlot {
  kind: 'effect';
  deps: readonly unknown[] | undefined;
  armed: boolean;
  destroy: (() => void) | undefined;
  pending: (() => (() => void) | void) | null;
}
interface StateSlot {
  kind: 'state';
  value: unknown;
}
interface MemoSlot {
  kind: 'memo';
  deps: readonly unknown[] | undefined;
  value: unknown;
}
type Slot = RefSlot | EffectSlot | StateSlot | MemoSlot;

function depsChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (previous === undefined || next === undefined) {
    return true;
  }
  if (previous.length !== next.length) {
    return true;
  }
  return previous.some((value, i) => !Object.is(value, next[i]));
}

interface HookHost<P, R> {
  render(props: P): R;
  unmount(): void;
  hide(): void;
}

/** Implements only the hooks these components use; `useState`'s setter never re-renders. */
function renderHook<P, R>(hook: (props: P) => R): HookHost<P, R> {
  const slots: Slot[] = [];
  let index = 0;
  let unmounted = false;

  function slotAt<T extends Slot>(make: () => T): T {
    const at = index;
    index += 1;
    const existing = slots[at];
    if (existing !== undefined) {
      return existing as T;
    }
    const created = make();
    slots[at] = created;
    return created;
  }

  const dispatcher = {
    useRef<T>(initial: T): { current: T } {
      const slot = slotAt<RefSlot>(() => ({
        kind: 'ref',
        ref: { current: initial },
      }));
      return slot.ref as { current: T };
    },
    useEffect(
      create: () => (() => void) | void,
      deps?: readonly unknown[],
    ): void {
      const slot = slotAt<EffectSlot>(() => ({
        kind: 'effect',
        deps: undefined,
        armed: false,
        destroy: undefined,
        pending: null,
      }));
      if (!slot.armed || depsChanged(slot.deps, deps)) {
        slot.pending = create;
        slot.deps = deps;
      }
    },
    useState<T>(initial: T | (() => T)): [T, (next: T | ((p: T) => T)) => void] {
      const slot = slotAt<StateSlot>(() => ({
        kind: 'state',
        value: typeof initial === 'function' ? (initial as () => T)() : initial,
      }));
      const set = (next: T | ((p: T) => T)): void => {
        slot.value =
          typeof next === 'function'
            ? (next as (p: T) => T)(slot.value as T)
            : next;
      };
      return [slot.value as T, set];
    },
    useCallback<T>(fn: T, deps?: readonly unknown[]): T {
      const slot = slotAt<MemoSlot>(() => ({
        kind: 'memo',
        deps: undefined,
        value: fn,
      }));
      if (slot.deps === undefined || depsChanged(slot.deps, deps)) {
        slot.value = fn;
        slot.deps = deps;
      }
      return slot.value as T;
    },
  };

  function commit(): void {
    // React's passive phase: every cleanup for the fiber runs before any setup.
    const dirty = slots.filter(
      (slot): slot is EffectSlot => slot.kind === 'effect' && slot.pending !== null,
    );
    for (const slot of dirty) {
      slot.destroy?.();
      slot.destroy = undefined;
    }
    for (const slot of dirty) {
      const create = slot.pending;
      slot.pending = null;
      slot.armed = true;
      const destroy = create?.();
      slot.destroy = typeof destroy === 'function' ? destroy : undefined;
    }
  }

  return {
    render(props: P): R {
      if (unmounted) {
        throw new Error('rendered after unmount');
      }
      index = 0;
      const previous = dispatcherSlot.current;
      dispatcherSlot.current = dispatcher;
      let result: R;
      try {
        result = hook(props);
      } finally {
        dispatcherSlot.current = previous;
      }
      commit();
      return result;
    },
    hide(): void {
      for (const slot of slots) {
        if (slot.kind === 'effect') {
          slot.destroy?.();
          slot.destroy = undefined;
          slot.armed = false;
        }
      }
    },
    unmount(): void {
      unmounted = true;
      for (const slot of slots) {
        if (slot.kind === 'effect') {
          slot.destroy?.();
          slot.destroy = undefined;
        }
      }
    },
  };
}

async function macrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type DeltaCb = (messageId: string, delta: string) => void;
type EndCb = (messageId: string) => void;
type FinalizedCb = (runId?: string) => void;
type StartedCb = (
  existingMessageIds: ReadonlySet<string>,
  runId?: string,
) => void;

class FakeEvents implements TextMessageEvents {
  private deltaCbs = new Set<DeltaCb>();
  private endCbs = new Set<EndCb>();
  private finalizedCbs = new Set<FinalizedCb>();
  private failedCbs = new Set<() => void>();
  private startedCbs = new Set<StartedCb>();

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

  onRunFailed(cb: () => void): () => void {
    this.failedCbs.add(cb);
    return () => this.failedCbs.delete(cb);
  }

  onRunStarted(cb: StartedCb): () => void {
    this.startedCbs.add(cb);
    return () => this.startedCbs.delete(cb);
  }

  emitDelta(messageId: string, delta: string): void {
    for (const cb of [...this.deltaCbs]) cb(messageId, delta);
  }

  emitRunStarted(existingMessageIds: Iterable<string>, runId?: string): void {
    const snapshot = new Set(existingMessageIds);
    for (const cb of [...this.startedCbs]) cb(snapshot, runId);
  }
}

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
  };
}

/** Whole source as one paragraph — no native addon needed. */
const wholeParagraphEngine: Engine = {
  name: 'whole-paragraph',
  parse(source: string): ParsedDocument {
    const span = { start: 0, end: source.length };
    return {
      source,
      blocks: [
        {
          kind: 'paragraph',
          span,
          children: [{ kind: 'text', span, value: source }],
        },
      ],
    };
  },
};

describe('useAgUiSession lifecycle', () => {
  const mountSession = () => {
    const events = new FakeEvents();
    const frame = manualFrame();
    const host = renderHook((messageId: string) =>
      useAgUiSession(events, messageId, {
        engine: wholeParagraphEngine,
        bufferScheduler: frame.scheduler,
        idleScheduler: () => () => {},
      }),
    );
    return { events, frame, host };
  };

  it('leaves a session bound again in the same macrotask streaming', async () => {
    const { events, frame, host } = mountSession();

    const m1 = host.render('m1');
    events.emitDelta('m1', 'half a sentence and ');
    frame.fire();
    expect(m1.snapshot().phase).toBe('streaming');

    // Two commits in one macrotask (a setState in a passive effect, or flushSync): m1's setup must cancel the first pending settle.
    const away = host.render('m2');
    const back = host.render('m1');
    expect(back).toBe(m1);
    await macrotasks();

    expect(m1.snapshot().phase).toBe('streaming');
    events.emitDelta('m1', 'the rest.');
    frame.fire();
    expect(m1.snapshot().document.source).toBe('half a sentence and the rest.');
    expect(away.snapshot().phase).toBe('settled');

    host.unmount();
  });

  it("settles the session a messageId switch leaves behind with 'aborted'", async () => {
    const { events, frame, host } = mountSession();

    const m1 = host.render('m1');
    events.emitDelta('m1', 'cut off mid-');
    frame.fire();
    host.render('m2');
    await macrotasks();

    expect(m1.snapshot().phase).toBe('settled');
    expect(m1.snapshot().document.source).toBe('cut off mid-');

    host.unmount();
  });

  it('rebinding on an events identity change alone settles nothing', async () => {
    const frame = manualFrame();
    const host = renderHook((events: TextMessageEvents) =>
      useAgUiSession(events, 'm1', {
        engine: wholeParagraphEngine,
        bufferScheduler: frame.scheduler,
        idleScheduler: () => () => {},
      }),
    );

    const first = new FakeEvents();
    const session = host.render(first);
    first.emitDelta('m1', 'live ');
    frame.fire();

    const second = new FakeEvents();
    expect(host.render(second)).toBe(session);
    await macrotasks();

    expect(session.snapshot().phase).toBe('streaming');
    second.emitDelta('m1', 'text');
    frame.fire();
    expect(session.snapshot().document.source).toBe('live text');

    host.unmount();
  });
});

describe('useAgUiSession delta routing', () => {
  it('keeps a live message on the routing its session was created with', () => {
    const frame = manualFrame();
    const host = renderHook(
      (props: { events: TextMessageEvents; coalesce: boolean }) =>
        useAgUiSession(props.events, 'm1', {
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
          coalesce: props.coalesce,
        }),
    );

    const first = new FakeEvents();
    const session = host.render({ events: first, coalesce: false });
    first.emitDelta('m1', 'A');
    expect(session.snapshot().document.source).toBe('A');

    const second = new FakeEvents();
    expect(host.render({ events: second, coalesce: true })).toBe(session);
    second.emitDelta('m1', 'B');

    expect(session.snapshot().document.source).toBe('AB');
    expect(session.pendingLength).toBe(0);

    host.unmount();
  });

  it('does not dump a metered tail when a rebind carries coalesce: false', () => {
    const frame = manualFrame();
    const host = renderHook(
      (props: { events: TextMessageEvents; coalesce: boolean }) =>
        useAgUiSession(props.events, 'm1', {
          engine: wholeParagraphEngine,
          bufferScheduler: frame.scheduler,
          idleScheduler: () => () => {},
          smoother: () => () => 4, // metered release: 4 units per flush
          coalesce: props.coalesce,
        }),
    );

    const first = new FakeEvents();
    const session = host.render({ events: first, coalesce: true });
    first.emitDelta('m1', 'Hello world, a long tail');
    frame.fire();
    expect(session.snapshot().document.source).toBe('Hell');
    expect(session.pendingLength).toBe(20);

    const second = new FakeEvents();
    host.render({ events: second, coalesce: false });
    second.emitDelta('m1', '!');

    expect(session.snapshot().document.source).toBe('Hell');
    expect(session.pendingLength).toBe(21);

    host.unmount();
  });
});

describe('useAgUiRunSessions session init', () => {
  it('forwards holdIdleMs, idleScheduler and now to every session it creates', () => {
    const events = new FakeEvents();
    const frame = manualFrame();
    const idleWaits: number[] = [];
    const smootherClock: number[] = [];
    const host = renderHook((_: null) =>
      useAgUiRunSessions(events, {
        engine: wholeParagraphEngine,
        bufferScheduler: frame.scheduler,
        idleScheduler: (_flush, ms) => {
          idleWaits.push(ms);
          return () => {};
        },
        holdIdleMs: 999,
        holdBackChars: 4,
        now: () => 4242,
        smoother: () => (releasable, context) => {
          smootherClock.push(context?.now ?? -1);
          return releasable.length;
        },
      }),
    );

    const api = host.render(null);
    events.emitRunStarted([], 'run-1');
    events.emitDelta('m1', 'abcdefgh');
    frame.fire();

    // The tail holdBackChars withholds is what arms the idle drain.
    expect(idleWaits).toEqual([999]);
    expect(smootherClock).toEqual([4242]);
    expect(api.sessionFor('m1').snapshot().document.source).toBe('abcd');

    host.unmount();
  });
});


describe('effect disconnection', () => {
  it('preserves a message and buffered input across hide and reveal', async () => {
    const events = new FakeEvents();
    const frame = manualFrame();
    const host = renderHook(() => useAgUiSession(events, 'm1', {
      engine: wholeParagraphEngine, bufferScheduler: frame.scheduler,
      idleScheduler: () => () => {},
    }));
    const session = host.render(undefined);
    events.emitDelta('m1', 'first ');
    frame.fire();
    events.emitDelta('m1', 'pending ');
    host.hide();
    await macrotasks();
    frame.fire();
    expect(session.snapshot().document.source).toBe('first ');
    expect(session.pendingLength).toBe(8);
    expect(host.render(undefined)).toBe(session);
    events.emitDelta('m1', 'last');
    frame.fire();
    expect(session.snapshot().document.source).toBe('first pending last');
    host.unmount();
  });

  it('retains completed run rows across hide and reveal', async () => {
    const events = new FakeEvents();
    const host = renderHook(() => useAgUiRunSessions(events, { engine: wholeParagraphEngine }));
    const first = host.render(undefined).sessionFor('m1');
    first.append('finished');
    first.finalize();
    host.hide();
    await macrotasks();
    const revealed = host.render(undefined).sessionFor('m1');
    expect(revealed).toBe(first);
    expect(revealed.snapshot().document.source).toBe('finished');
    events.emitDelta('m1', ' more');
    expect(revealed.snapshot().document.source).toBe('finished more');
    host.unmount();
  });

  it('disposes rows evicted by the run policy', () => {
    const events = new FakeEvents();
    const host = renderHook(() => useAgUiRunSessions(events, {
      engine: wholeParagraphEngine, policy: { evictOnRunStart: () => true },
    }));
    const api = host.render(undefined);
    const session = api.sessionFor('old');
    session.append('before');
    events.emitRunStarted(['old']);
    session.append(' after');
    expect(session.snapshot().document.source).toBe('before');
    const fresh = api.sessionFor('old');
    expect(fresh).not.toBe(session);
    expect(fresh.snapshot().document.source).toBe('');
    fresh.append('again');
    expect(fresh.snapshot().document.source).toBe('again');
    host.unmount();
  });
});
