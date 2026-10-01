import type { ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import type { BufferScheduler } from '../stream/StreamSession';
import { StreamSession } from '../stream/StreamSession';
import {
  bindMessageEvents,
  getOrCreateSession,
  resolveSessionInit,
  settleUnboundSession,
  type BufferedSessionSink,
  type SessionSink,
  type TextMessageEvents,
  type UseAgUiSessionOptions,
} from './useAgUiSession';

type DeltaCb = (messageId: string, delta: string) => void;
type EndCb = (messageId: string) => void;
type VoidCb = () => void;

class FakeEvents implements TextMessageEvents {
  private deltaCbs = new Set<DeltaCb>();
  private endCbs = new Set<EndCb>();
  private finalizedCbs = new Set<VoidCb>();
  private failedCbs = new Set<VoidCb>();

  onTextDelta(cb: DeltaCb): () => void {
    this.deltaCbs.add(cb);
    return () => this.deltaCbs.delete(cb);
  }

  onMessageEnd(cb: EndCb): () => void {
    this.endCbs.add(cb);
    return () => this.endCbs.delete(cb);
  }

  onRunFinalized(cb: VoidCb): () => void {
    this.finalizedCbs.add(cb);
    return () => this.finalizedCbs.delete(cb);
  }

  onRunFailed(cb: VoidCb): () => void {
    this.failedCbs.add(cb);
    return () => this.failedCbs.delete(cb);
  }

  emitDelta(messageId: string, delta: string): void {
    for (const cb of [...this.deltaCbs]) cb(messageId, delta);
  }

  emitMessageEnd(messageId: string): void {
    for (const cb of [...this.endCbs]) cb(messageId);
  }

  emitRunFinalized(): void {
    for (const cb of [...this.finalizedCbs]) cb();
  }

  emitRunFailed(): void {
    for (const cb of [...this.failedCbs]) cb();
  }

  get subscriptionCount(): number {
    return (
      this.deltaCbs.size +
      this.endCbs.size +
      this.finalizedCbs.size +
      this.failedCbs.size
    );
  }
}

interface RecordingSink extends SessionSink {
  appended: string[];
  finalizeReasons: (string | undefined)[];
}

function makeSink(): RecordingSink {
  const sink: RecordingSink = {
    appended: [],
    finalizeReasons: [],
    append(delta: string) {
      sink.appended.push(delta);
    },
    finalize(reason?: 'end' | 'aborted' | 'failed') {
      sink.finalizeReasons.push(reason);
    },
  };
  return sink;
}

interface RecordingBufferedSink extends BufferedSessionSink {
  calls: string[];
  finalizeReasons: (string | undefined)[];
}

function makeBufferedSink(): RecordingBufferedSink {
  const sink: RecordingBufferedSink = {
    calls: [],
    finalizeReasons: [],
    append(delta: string) {
      sink.calls.push(`append:${delta}`);
    },
    appendBuffered(delta: string) {
      sink.calls.push(`appendBuffered:${delta}`);
    },
    finalize(reason?: 'end' | 'aborted' | 'failed') {
      sink.calls.push(`finalize:${reason ?? ''}`);
      sink.finalizeReasons.push(reason);
    },
  };
  return sink;
}

describe('bindMessageEvents', () => {
  it('appends deltas for the bound messageId in order', () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitDelta('m1', 'Hello');
    events.emitDelta('m1', ' world');

    expect(sink.appended).toEqual(['Hello', ' world']);
    expect(sink.finalizeReasons).toEqual([]);
  });

  it('does not forward empty deltas', () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitDelta('m1', '');
    events.emitDelta('m1', 'a');
    events.emitDelta('m1', '');

    expect(sink.appended).toEqual(['a']);
  });

  it('ignores deltas and message end for other messageIds', () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitDelta('other', 'nope');
    events.emitMessageEnd('other');
    events.emitDelta('m1', 'yes');

    expect(sink.appended).toEqual(['yes']);
    expect(sink.finalizeReasons).toEqual([]);
  });

  it("finalizes with 'end' on message end for the bound messageId", () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitDelta('m1', 'text');
    events.emitMessageEnd('m1');

    expect(sink.finalizeReasons).toEqual(['end']);
  });

  it("finalizes with 'aborted' when the run finalizes without a message end", () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitDelta('m1', 'cut off mid-');
    events.emitRunFinalized();

    expect(sink.finalizeReasons).toEqual(['aborted']);
  });

  it("finalizes with 'end' when the run finalizes after the message ended", () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitMessageEnd('m1');
    events.emitRunFinalized();

    // Both deliveries carry 'end'; StreamSession.finalize is idempotent so
    // the second call is a no-op there.
    expect(sink.finalizeReasons).toEqual(['end', 'end']);
  });

  it("finalizes with 'failed' when the run fails", () => {
    const events = new FakeEvents();
    const sink = makeSink();
    bindMessageEvents(events, 'm1', sink);

    events.emitRunFailed();

    expect(sink.finalizeReasons).toEqual(['failed']);
  });

  it('stops routing after detach and unsubscribes every callback', () => {
    const events = new FakeEvents();
    const sink = makeSink();
    const detach = bindMessageEvents(events, 'm1', sink);
    expect(events.subscriptionCount).toBe(4);

    detach();

    expect(events.subscriptionCount).toBe(0);
    events.emitDelta('m1', 'late');
    events.emitMessageEnd('m1');
    events.emitRunFinalized();
    events.emitRunFailed();
    expect(sink.appended).toEqual([]);
    expect(sink.finalizeReasons).toEqual([]);
  });

  it('is safe to detach twice', () => {
    const events = new FakeEvents();
    const detach = bindMessageEvents(events, 'm1', makeSink());

    detach();
    expect(() => detach()).not.toThrow();
    expect(events.subscriptionCount).toBe(0);
  });

  it('routes two bindings for different messageIds independently', () => {
    const events = new FakeEvents();
    const sink1 = makeSink();
    const sink2 = makeSink();
    bindMessageEvents(events, 'm1', sink1);
    bindMessageEvents(events, 'm2', sink2);

    events.emitDelta('m1', 'one');
    events.emitDelta('m2', 'two');
    events.emitMessageEnd('m1');

    expect(sink1.appended).toEqual(['one']);
    expect(sink2.appended).toEqual(['two']);
    expect(sink1.finalizeReasons).toEqual(['end']);
    expect(sink2.finalizeReasons).toEqual([]);
  });
});

describe('getOrCreateSession', () => {
  it('creates once per messageId and returns the cached instance after', () => {
    const sessions = new Map<string, { id: number }>();
    let created = 0;
    const create = () => ({ id: (created += 1) });

    const first = getOrCreateSession(sessions, 'm1', create);
    const again = getOrCreateSession(sessions, 'm1', create);

    expect(again).toBe(first);
    expect(created).toBe(1);
  });

  it('creates separate sessions for separate messageIds', () => {
    const sessions = new Map<string, { id: number }>();
    let created = 0;
    const create = () => ({ id: (created += 1) });

    const a = getOrCreateSession(sessions, 'a', create);
    const b = getOrCreateSession(sessions, 'b', create);

    expect(a).not.toBe(b);
    expect(created).toBe(2);
    expect(sessions.size).toBe(2);
  });
});

describe('bindMessageEvents coalescing', () => {
  it('routes deltas through appendBuffered when coalescing is asked for', () => {
    const events = new FakeEvents();
    const sink = makeBufferedSink();
    bindMessageEvents(events, 'm1', sink, { coalesce: true });

    events.emitDelta('m1', 'Hello');
    events.emitDelta('m1', ' world');
    events.emitMessageEnd('m1');

    // Settling needs no explicit flush: finalize drains the pending buffer.
    expect(sink.calls).toEqual([
      'appendBuffered:Hello',
      'appendBuffered: world',
      'finalize:end',
    ]);
  });

  it('appends synchronously without coalescing, and with coalesce: false', () => {
    const events = new FakeEvents();
    const off = makeBufferedSink();
    const explicit = makeBufferedSink();
    bindMessageEvents(events, 'm1', off);
    bindMessageEvents(events, 'm1', explicit, { coalesce: false });

    events.emitDelta('m1', 'a');

    expect(off.calls).toEqual(['append:a']);
    expect(explicit.calls).toEqual(['append:a']);
  });

  it('falls back to append when the sink has no buffered entry point', () => {
    const events = new FakeEvents();
    const plain = makeSink();
    // The overloads reject this for typed callers; only untyped ones reach the runtime check.
    bindMessageEvents(events, 'm1', plain as unknown as BufferedSessionSink, {
      coalesce: true,
    });

    events.emitDelta('m1', 'a');

    expect(plain.appended).toEqual(['a']);
  });
});

describe('resolveSessionInit', () => {
  it('reads a bare EngineOptions argument as parse options', () => {
    const options = { smartPunctuation: true };

    expect(resolveSessionInit(options)).toEqual({ options, coalesce: false });
  });

  it('passes an init object through', () => {
    const engine: Engine = { name: 'x', parse: () => ({ source: '', blocks: [] }) };

    expect(resolveSessionInit({ engine })).toEqual({ engine, coalesce: false });
  });

  it('resolves to an empty init with no argument', () => {
    expect(resolveSessionInit()).toEqual({ coalesce: false });
  });

  it('coalesces by default when the init carries a buffering field', () => {
    const smoother = () => () => 4;

    expect(resolveSessionInit({ smoother }).coalesce).toBe(true);
    expect(resolveSessionInit({ holdBackChars: 3 }).coalesce).toBe(true);
    expect(resolveSessionInit({ holdIdleMs: 40 }).coalesce).toBe(true);
    expect(resolveSessionInit({ bufferScheduler: () => () => {} }).coalesce).toBe(
      true,
    );
    expect(resolveSessionInit({ idleScheduler: () => () => {} }).coalesce).toBe(
      true,
    );
  });

  it('honours an explicit coalesce over the inference', () => {
    const smoother = () => () => 4;

    expect(resolveSessionInit({ smoother, coalesce: false }).coalesce).toBe(false);
    expect(resolveSessionInit({ coalesce: true }).coalesce).toBe(true);
  });

  it('does not infer coalescing from repair or now, which work either way', () => {
    expect(resolveSessionInit({ repair: { hideUriLikeLabels: true } }).coalesce).toBe(
      false,
    );
    expect(resolveSessionInit({ now: () => 0 }).coalesce).toBe(false);
  });

  it('warns in DEV about an init that also carries parse options, and drops them', () => {
    const engine: Engine = {
      name: 'x',
      parse: () => ({ source: '', blocks: [] }),
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // What a JS caller writes: `{ ...presets.llmChat, engine }`. TypeScript rejects the literal.
      const mixed = {
        engine,
        smartPunctuation: true,
      } as unknown as UseAgUiSessionOptions;

      const resolved = resolveSessionInit(mixed);

      expect(resolved.engine).toBe(engine);
      expect(resolved.options).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('smartPunctuation');

      resolveSessionInit(mixed);
      expect(warn).toHaveBeenCalledTimes(1);
      resolveSessionInit({
        engine,
        html: 'raw',
      } as unknown as UseAgUiSessionOptions);
      expect(warn).toHaveBeenCalledTimes(2);

      resolveSessionInit({ engine, options: { smartPunctuation: true } });
      resolveSessionInit({ smartPunctuation: true });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('settleUnboundSession', () => {
  it("finalizes a still-streaming session with 'aborted'", () => {
    const reasons: (string | undefined)[] = [];
    const session = {
      snapshot: () => ({ phase: 'streaming' }),
      finalize: (reason?: 'end' | 'aborted' | 'failed') => reasons.push(reason),
    } as unknown as StreamSession;

    settleUnboundSession(session);

    expect(reasons).toEqual(['aborted']);
  });

  it('leaves a settled session alone', () => {
    const reasons: (string | undefined)[] = [];
    let phase = 'streaming';
    const session = {
      snapshot: () => ({ phase }),
      finalize: (reason?: 'end' | 'aborted' | 'failed') => {
        reasons.push(reason);
        phase = 'settled';
      },
    } as unknown as StreamSession;

    settleUnboundSession(session);
    settleUnboundSession(session);

    expect(reasons).toEqual(['aborted']);
  });
});

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

/** Satisfies the session's span invariant (text value === source slice) without the native addon. */
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

describe('bindMessageEvents over a real StreamSession', () => {
  it('commits once per frame when coalescing, not once per delta', () => {
    const frame = manualFrame();
    const session = new StreamSession({
      engine: wholeParagraphEngine,
      bufferScheduler: frame.scheduler,
      idleScheduler: () => () => {},
    });
    const revisions: number[] = [];
    session.subscribe((snap) => revisions.push(snap.revision));
    const events = new FakeEvents();
    bindMessageEvents(events, 'm1', session, { coalesce: true });

    events.emitDelta('m1', 'one ');
    events.emitDelta('m1', 'two ');
    events.emitDelta('m1', 'three');
    expect(revisions).toEqual([]);
    frame.fire();

    expect(revisions).toEqual([1]);
    expect(session.snapshot().document.source).toBe('one two three');
  });

  it('drains the pending buffer when the run settles the message', () => {
    const frame = manualFrame();
    const session = new StreamSession({
      engine: wholeParagraphEngine,
      bufferScheduler: frame.scheduler,
      idleScheduler: () => () => {},
      // Metered: 4 units per flush.
      smoother: () => 4,
    });
    const events = new FakeEvents();
    bindMessageEvents(events, 'm1', session, { coalesce: true });

    events.emitDelta('m1', 'a long enough tail');
    frame.fire();
    expect(session.snapshot().document.source).toBe('a lo');

    events.emitMessageEnd('m1');

    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe('a long enough tail');
    expect(session.pendingLength).toBe(0);
  });

  it('settling an unbound session commits its held-back tail once', () => {
    const frame = manualFrame();
    const session = new StreamSession({
      engine: wholeParagraphEngine,
      bufferScheduler: frame.scheduler,
      idleScheduler: () => () => {},
      holdBackChars: 4,
    });
    const events = new FakeEvents();
    // The hook's messageId switch: detach, then settle what was left open.
    const detach = bindMessageEvents(events, 'm1', session, { coalesce: true });

    events.emitDelta('m1', 'half a sentence and **bo');
    frame.fire();
    detach();
    expect(session.snapshot().phase).toBe('streaming');

    settleUnboundSession(session);

    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe(
      'half a sentence and **bo',
    );
  });
});
