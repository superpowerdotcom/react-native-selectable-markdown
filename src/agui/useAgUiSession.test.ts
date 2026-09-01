import {
  bindMessageEvents,
  getOrCreateSession,
  type SessionSink,
  type TextMessageEvents,
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

    expect(sink.appended).toEqual([]);
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
