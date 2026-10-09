import { IS_DEV } from '../dev';
import { useEffect, useRef } from 'react';
import type { Engine } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import type { RepairOptions } from '../stream/repair';
import type { Smoother } from '../stream/smoothing';
import {
  StreamSession,
  type BufferScheduler,
  type IdleScheduler,
} from '../stream/StreamSession';

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
 * bivariance keeps sources typed against the older, narrower callbacks assignable.
 *
 * RUN IDENTITY. Pass `runId` when the host has one: `bindRunTextEvents`
 * ignores a `RUN_FINISHED` / `RUN_ERROR` for a run it saw end or be
 * superseded. An id it never saw start, or saw start again, still settles.
 * Without ids, a host that can forward a stale run's events must filter them.
 */
export interface TextMessageEvents {
  onTextDelta(cb: (messageId: string, delta: string) => void): () => void;
  onMessageEnd(cb: (messageId: string) => void): () => void;
  onRunFinalized(cb: (runId?: string) => void): () => void;
  onRunFailed(cb: (info?: RunFailureInfo, runId?: string) => void): () => void;
  /**
   * Optional run-lifecycle event, consumed by `bindRunTextEvents`: fired at
   * run init with the ids of every message already present in the timeline.
   * That snapshot is the authority on which rows pre-exist the run — rows in
   * it must never be typed out again (attach/resume semantics).
   */
  onRunStarted?(
    cb: (existingMessageIds: ReadonlySet<string>, runId?: string) => void,
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
   * re-type, and the run-identity memory is cleared.
   */
  onAttached?(cb: () => void): () => void;
}

/**
 * The slice of StreamSession the event binding drives. Structural so the
 * binding core is testable with a recording fake instead of a real session.
 */
export type SessionSink = Pick<StreamSession, 'append' | 'finalize'>;

/** A `SessionSink` that can also coalesce; `bindMessageEvents` requires it with `coalesce`. */
export type BufferedSessionSink = SessionSink &
  Pick<StreamSession, 'appendBuffered'>;

export interface MessageBindingOptions {
  /** Route deltas through `appendBuffered` (one commit per frame) instead of `append`. Default false. */
  coalesce?: boolean;
}

/**
 * The React-free core of the adapter: routes one message's events into a
 * session sink. Deltas for other messageIds are ignored; empty deltas are
 * a no-op. The sink is finalized on message end AND on run finalized/failed,
 * because aborted streams never deliver a message END — a run that finalizes
 * without this message ending is treated as aborted, and session.finalize is
 * idempotent so double delivery is harmless. Returns a detach function that
 * unsubscribes everything (safe to call more than once).
 *
 * Run end finalizes immediately, committing a metered tail in one revision;
 * the drained hold belongs to `bindRunTextEvents`. Detach only unsubscribes:
 * it never flushes, settles or disposes the sink.
 */
export function bindMessageEvents(
  events: TextMessageEvents,
  messageId: string,
  sink: SessionSink,
): () => void;
export function bindMessageEvents(
  events: TextMessageEvents,
  messageId: string,
  sink: BufferedSessionSink,
  options: MessageBindingOptions,
): () => void;
export function bindMessageEvents(
  events: TextMessageEvents,
  messageId: string,
  sink: SessionSink | BufferedSessionSink,
  options?: MessageBindingOptions,
): () => void {
  let messageEnded = false;
  // The `in` check keeps an untyped caller passing `coalesce` with a plain sink on `append`.
  const buffered =
    options?.coalesce === true && 'appendBuffered' in sink ? sink : null;

  const offDelta = events.onTextDelta((id, delta) => {
    if (id !== messageId || delta === '') {
      return;
    }
    if (buffered !== null) {
      buffered.appendBuffered(delta);
    } else {
      sink.append(delta);
    }
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

/** A message that ended already finalized on END, so one still streaming here is 'aborted'. */
export function settleUnboundSession(
  session: Pick<StreamSession, 'snapshot' | 'finalize'>,
): void {
  if (session.snapshot().phase === 'settled') {
    return;
  }
  session.finalize('aborted');
}

/**
 * Read once, when a messageId's session is created: later changes reach only
 * new messageIds. Vary a live message's pacing through the smoother, which is
 * consulted per flush. Fields not documented here forward to `StreamSessionInit`.
 */
export interface UseAgUiSessionInit {
  /** Defaults to the native md4c engine. */
  engine?: Engine;
  options?: EngineOptions;
  /**
   * Defaults to true when `smoother`, `holdBackChars`, `holdIdleMs`,
   * `bufferScheduler` or `idleScheduler` is set, else false; `repair` and
   * `now` do not imply buffering.
   */
  coalesce?: boolean;
  /** A factory: stateful smoothers must not be shared, so each session gets its own. */
  smoother?: () => Smoother;
  holdBackChars?: number;
  holdIdleMs?: number;
  repair?: RepairOptions;
  bufferScheduler?: BufferScheduler;
  idleScheduler?: IdleScheduler;
  now?: () => number;
}

/** Bare `EngineOptions` or a {@link UseAgUiSessionInit}, told apart by their disjoint keys. */
export type UseAgUiSessionOptions =
  | (EngineOptions & { [K in keyof UseAgUiSessionInit]?: never })
  | (UseAgUiSessionInit & { [K in keyof EngineOptions]?: never });

/** A Record so a new init field fails to compile until listed here. */
const SESSION_INIT_KEYS: Record<keyof UseAgUiSessionInit, true> = {
  engine: true,
  options: true,
  coalesce: true,
  smoother: true,
  holdBackChars: true,
  holdIdleMs: true,
  repair: true,
  bufferScheduler: true,
  idleScheduler: true,
  now: true,
};

const ENGINE_OPTIONS_KEYS: Record<keyof EngineOptions, true> = {
  extensions: true,
  html: true,
  smartPunctuation: true,
  maxSourceLength: true,
  urlPolicy: true,
};

// `UseAgUiSessionOptions` discriminates on these key sets staying disjoint.
type SharedInitOptionKey = Extract<
  keyof UseAgUiSessionInit,
  keyof EngineOptions
>;
type AssertNever<T extends never> = T;
type _InitAndOptionKeysAreDisjoint = AssertNever<SharedInitOptionKey>;



const warnedMixedInits = new Set<string>();

function warnMixedSessionInit(strayOptionKeys: string[]): void {
  const label = strayOptionKeys.join(',');
  if (warnedMixedInits.has(label)) {
    return;
  }
  warnedMixedInits.add(label);
  console.warn(
    `[react-native-selectable-markdown] useAgUiSession was given an init ` +
      `object that also carries parse options (${label}). Parse options ` +
      `belong under \`options\` in an init, so these are IGNORED and the ` +
      `message parses with defaults. Write ` +
      `{ options: { ${label}: ... }, engine } instead of ` +
      `{ ...options, engine }.`,
  );
}

/** Exported for tests only; not part of the root API. */
export function resolveSessionInit(
  init?: UseAgUiSessionOptions,
): UseAgUiSessionInit & { coalesce: boolean } {
  const isInit =
    init !== undefined &&
    Object.keys(SESSION_INIT_KEYS).some((key) => key in init);
  if (IS_DEV && isInit) {
    const stray = Object.keys(ENGINE_OPTIONS_KEYS).filter(
      (key) => key in (init as object),
    );
    if (stray.length > 0) {
      warnMixedSessionInit(stray);
    }
  }
  const shaped: UseAgUiSessionInit =
    init === undefined
      ? {}
      : isInit
        ? (init as UseAgUiSessionInit)
        : { options: init as EngineOptions };
  return {
    ...shaped,
    coalesce:
      shaped.coalesce ??
      (shaped.smoother !== undefined ||
        shaped.holdBackChars !== undefined ||
        shaped.holdIdleMs !== undefined ||
        shaped.bufferScheduler !== undefined ||
        shaped.idleScheduler !== undefined),
  };
}

/** Effects can disconnect while React retains the component's sessions. */
export function useSessionActivity(sessions: Map<string, StreamSession>): { current: boolean } {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    for (const session of sessions.values()) session.resume();
    return () => {
      active.current = false;
      for (const session of sessions.values()) session.suspend();
    };
  }, [sessions]);
  return active;
}

/**
 * Bridges streamed text deltas into a StreamSession: one session per
 * messageId, kept in a ref map for the lifetime of the calling component
 * (so a settled message's document survives messageId switches and
 * re-renders). The third argument is read when a messageId's session is created.
 *
 * - A messageId switch settles a still-streaming outgoing session with
 *   `'aborted'`, one macrotask later, unless that session is bound again first.
 * - Effect cleanup suspends each session's timers; reconnecting resumes them.
 * - An `events` identity change only rebinds; it never settles or disposes.
 * - Run end commits a metered tail in one revision; the drained hold is
 *   `useAgUiRunSessions`'.
 */
export function useAgUiSession(
  events: TextMessageEvents,
  messageId: string,
  init?: UseAgUiSessionOptions,
): StreamSession {
  const sessionsRef = useRef<Map<string, StreamSession> | null>(null);
  if (sessionsRef.current === null) {
    sessionsRef.current = new Map();
  }
  const sessions = sessionsRef.current;

  const initRef = useRef(init);
  initRef.current = init;

  // Latched per session: the binding effect reruns on every `events` identity change.
  const coalesceRef = useRef<Map<StreamSession, boolean> | null>(null);
  if (coalesceRef.current === null) {
    coalesceRef.current = new Map();
  }
  const coalesceBySession = coalesceRef.current;

  const session = getOrCreateSession(sessions, messageId, () => {
    const resolved = resolveSessionInit(initRef.current);
    const created = new StreamSession({
      engine: resolved.engine,
      options: resolved.options,
      smoother: resolved.smoother?.(),
      holdBackChars: resolved.holdBackChars,
      holdIdleMs: resolved.holdIdleMs,
      repair: resolved.repair,
      bufferScheduler: resolved.bufferScheduler,
      idleScheduler: resolved.idleScheduler,
      now: resolved.now,
    });
    coalesceBySession.set(created, resolved.coalesce);
    return created;
  });

  const active = useSessionActivity(sessions);

  useEffect(() => {
    return coalesceBySession.get(session) === true
      ? bindMessageEvents(events, messageId, session, { coalesce: true })
      : bindMessageEvents(events, messageId, session);
  }, [coalesceBySession, events, messageId, session]);

  // Keyed by session: several cleanups can run before any timer fires (m1 -> m2 -> m1 in one macrotask).
  const pendingSettlesRef = useRef<Map<StreamSession, () => void> | null>(null);
  if (pendingSettlesRef.current === null) {
    pendingSettlesRef.current = new Map();
  }
  const pendingSettles = pendingSettlesRef.current;
  useEffect(() => {
    const cancel = pendingSettles.get(session);
    if (cancel !== undefined) {
      cancel();
      pendingSettles.delete(session);
    }
    return () => {
      const timer = setTimeout(() => {
        pendingSettles.delete(session);
        if (active.current) settleUnboundSession(session);
      }, 0);
      pendingSettles.set(session, () => clearTimeout(timer));
    };
  }, [active, pendingSettles, session]);

  return session;
}
