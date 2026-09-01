import { useEffect, useRef } from 'react';
import type { EngineOptions } from '../engine/options';
import { StreamSession } from '../stream/StreamSession';

/**
 * Failure metadata delivered to `onRunFailed` subscribers. Additive: the
 * argument is optional, so callbacks written against the original zero-arg
 * shape keep compiling, and sources that never construct one still satisfy
 * the interface.
 */
export interface RunFailureInfo {
  /**
   * How the failure should settle in-flight streams:
   * - `'failed'` / `'aborted'` (and absent, which reads as `'failed'`) —
   *   terminal: sessions settle immediately with that reason.
   * - `'benign'` — not terminal (reconnect handoff, 409-conflict with a
   *   follow-up resume, stale interrupt): sessions must stay streaming so
   *   the follow-up run keeps appending where this one stopped.
   * Only the run-scoped binding (`bindRunTextEvents`) triages this; the
   * per-message `bindMessageEvents` keeps its original treat-as-terminal
   * semantics.
   */
  disposition?: 'failed' | 'aborted' | 'benign';
}

/**
 * Minimal structural view of an ag-ui-style event source. Defined locally
 * on purpose: this package takes no dependency on ag-ui packages. Each
 * subscription method returns its unsubscribe function.
 *
 * The members are method declarations deliberately: method parameter
 * bivariance keeps a source typed against the original zero-arg
 * `onRunFailed` callback assignable to this interface (and the widened
 * callback type is itself assignable to `() => void`, so the relation holds
 * under strict function-type checking too).
 */
export interface TextMessageEvents {
  onTextDelta(cb: (messageId: string, delta: string) => void): () => void;
  onMessageEnd(cb: (messageId: string) => void): () => void;
  onRunFinalized(cb: () => void): () => void;
  onRunFailed(cb: (info?: RunFailureInfo) => void): () => void;
  /**
   * Optional run-lifecycle event, consumed by `bindRunTextEvents`: fired at
   * run init with the ids of every message already present in the timeline.
   * That snapshot is the authority on which rows pre-exist the run — rows in
   * it must never be typed out again (attach/resume semantics).
   */
  onRunStarted?(
    cb: (existingMessageIds: ReadonlySet<string>) => void,
  ): () => void;
  /**
   * Optional: wholesale content rewrite of one message (recovery merge,
   * adoption of a server-side row, timeline patch). The content is the
   * row's full new text, not a delta.
   */
  onMessageReplaced?(
    cb: (messageId: string, content: string) => void,
  ): () => void;
  /**
   * Optional host-lifecycle event, consumed by `bindRunTextEvents` (its
   * behavior h): the host (re)attached to its event source after a detached
   * stretch (screen blur, background). Catch-up covers the gap, so the
   * binding flushes every buffered session in one commit and drops run
   * observation — post-attach rows re-judge as pre-existing and never
   * re-type.
   */
  onAttached?(cb: () => void): () => void;
}

/**
 * The slice of StreamSession the event binding drives. Structural so the
 * binding core is testable with a recording fake instead of a real session.
 */
export type SessionSink = Pick<StreamSession, 'append' | 'finalize'>;

/**
 * The React-free core of the adapter: routes one message's events into a
 * session sink. Deltas for other messageIds are ignored; empty deltas are
 * a no-op. The sink is finalized on message end AND on run finalized/failed,
 * because aborted streams never deliver a message END — a run that finalizes
 * without this message ending is treated as aborted, and session.finalize is
 * idempotent so double delivery is harmless. Returns a detach function that
 * unsubscribes everything (safe to call more than once).
 */
export function bindMessageEvents(
  events: TextMessageEvents,
  messageId: string,
  sink: SessionSink,
): () => void {
  let messageEnded = false;

  const offDelta = events.onTextDelta((id, delta) => {
    if (id !== messageId || delta === '') {
      return;
    }
    sink.append(delta);
  });
  const offEnd = events.onMessageEnd((id) => {
    if (id !== messageId) {
      return;
    }
    messageEnded = true;
    sink.finalize('end');
  });
  const offFinalized = events.onRunFinalized(() => {
    sink.finalize(messageEnded ? 'end' : 'aborted');
  });
  const offFailed = events.onRunFailed(() => {
    sink.finalize('failed');
  });

  let detached = false;
  return () => {
    if (detached) {
      return;
    }
    detached = true;
    offDelta();
    offEnd();
    offFinalized();
    offFailed();
  };
}

/** Returns the session for `messageId`, creating (and caching) it once. */
export function getOrCreateSession<S>(
  sessions: Map<string, S>,
  messageId: string,
  create: () => S,
): S {
  const existing = sessions.get(messageId);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  sessions.set(messageId, created);
  return created;
}

/**
 * Bridges streamed text deltas into a StreamSession: one session per
 * messageId, kept in a ref map for the lifetime of the calling component
 * (so a settled message's document survives messageId switches and
 * re-renders). `options` are captured when a messageId's session is first
 * created; later option changes do not re-parse an in-flight session.
 */
export function useAgUiSession(
  events: TextMessageEvents,
  messageId: string,
  options?: EngineOptions,
): StreamSession {
  const sessionsRef = useRef<Map<string, StreamSession> | null>(null);
  if (sessionsRef.current === null) {
    sessionsRef.current = new Map();
  }

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const session = getOrCreateSession(
    sessionsRef.current,
    messageId,
    () => new StreamSession({ options: optionsRef.current }),
  );

  useEffect(
    () => bindMessageEvents(events, messageId, session),
    [events, messageId, session],
  );

  return session;
}
