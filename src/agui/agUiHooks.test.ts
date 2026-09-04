/**
 * The React wiring of the two ag-ui hooks — effect ordering, cleanup
 * scheduling, what a re-render does to a live session — which the other two
 * suites cannot reach: they exercise the React-free cores
 * (`bindMessageEvents`, `bindRunTextEvents`, `resolveSessionInit`).
 *
 * This package has no React renderer to lean on (react-dom and
 * react-test-renderer are neither dependencies nor devDependencies; `react`
 * alone is), so the hooks run against a minimal dispatcher installed in
 * React's own dispatcher slot. The hooks import the real `useRef`,
 * `useEffect`, `useState` and `useCallback`, each of which is a one-line
 * delegation to whatever sits in that slot, so the code under test is the
 * shipped code. `renderHook` commits the way React 18 does — every changed
 * effect's cleanup first, then every setup — which is the ordering these
 * tests turn on.
 */
import * as React from 'react';
import type { ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import type { BufferScheduler } from '../stream/StreamSession';
import { useAgUiRunSessions } from './bindRunTextEvents';
import { useAgUiSession, type TextMessageEvents } from './useAgUiSession';

// ---------------------------------------------------------------------------
// The hook runtime
// ---------------------------------------------------------------------------

interface DispatcherSlot {
  current: unknown;
}

const dispatcherSlot: DispatcherSlot = (
  React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: DispatcherSlot;
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;

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
  /** One commit: render, then run the changed effects. Returns what the hook returned. */
  render(props: P): R;
  /** Real unmount: every effect's cleanup, in declaration order. */
  unmount(): void;
}

/**
 * Renders `hook` on demand. Only the four hooks these two components use are
 * implemented — anything else throws (a missing dispatcher method is not a
 * function), which is the behaviour we want if a hook is added later.
 *
 * `useState`'s setter records the value but schedules no re-render: nothing
 * here asserts on rendered state, and a synchronous re-render from inside a
 * commit would be a worse lie than no re-render at all.
 */
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
    // React 18's passive phase: ALL cleanups for the fiber, then all setups.
    // The hooks rely on that split — `useAgUiSession` declares its unmount
    // teardown before the effects whose cleanup it must precede.
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

/** Two timer turns: enough for a deferred settle and a deferred unmount. */
async function macrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

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

    // Two commits with no timer turn between them — what a parent setState
    // inside a passive effect, or a flushSync, produces. The cleanup for m1
    // queues a settle, the cleanup for m2 queues another, and the setup for
    // m1 must cancel the FIRST one: with a single pending slot its cancel
    // handle is overwritten and the still-bound session settles under the
    // component (streaming chrome drops, the tail repair reparses away, a
    // held-back tail is dumped).
    const away = host.render('m2');
    const back = host.render('m1');
    expect(back).toBe(m1);
    await macrotasks();

    expect(m1.snapshot().phase).toBe('streaming');
    events.emitDelta('m1', 'the rest.');
    frame.fire();
    expect(m1.snapshot().document.source).toBe('half a sentence and the rest.');
    // The one genuinely left behind still settles.
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

    // A host building its event object inline re-renders with a new
    // identity every time; the session is the same one, so nothing settles.
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

    // A new inline events object rebinds — every render, for the host shape
    // this package endorses — and this one carries a flipped switch. The
    // routing is latched with the session, so the message already streaming
    // keeps appending synchronously.
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
    first.emitDelta('m1', 'Hello world, a long tail'); // 24 units
    frame.fire();
    expect(session.snapshot().document.source).toBe('Hell');
    expect(session.pendingLength).toBe(20);

    // The direction that would be visibly lossy: re-routing to `append`
    // here would drain the smoother's 20 withheld characters into one
    // commit mid-message.
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

    // holdBackChars withheld the last four, which arms the idle drain on
    // the injected scheduler with the injected wait...
    expect(idleWaits.length).toBeGreaterThan(0);
    expect(idleWaits.every((ms) => ms === 999)).toBe(true);
    // ...and the smoother the factory made reads the injected clock.
    expect(smootherClock.length).toBeGreaterThan(0);
    expect(smootherClock.every((now) => now === 4242)).toBe(true);
    expect(api.sessionFor('m1').snapshot().document.source).toBe('abcd');

    host.unmount();
  });
});
