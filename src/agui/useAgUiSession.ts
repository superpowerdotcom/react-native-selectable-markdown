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
 * bivariance keeps a source typed against a narrower callback assignable to
 * this interface — the original zero-arg `onRunFailed`, or a lifecycle
 * callback written before the optional `runId` argument existed — and each
 * widened callback type is itself assignable to the narrower one, so the
 * relation holds under strict function-type checking too.
 *
 * RUN IDENTITY. The three run-lifecycle callbacks take an optional `runId`.
 * A host that has one should pass it: `bindRunTextEvents` remembers the ids
 * of the runs it watched end or be superseded, and ignores a `RUN_FINISHED`
 * / `RUN_ERROR` carrying one of those, so a superseded run's late event
 * cannot settle the live run's sessions. It drops only an id it KNOWS is
 * spent right now: an id it never saw start — a resumed run, a run created
 * elsewhere, a run whose `onRunStarted` the host does not emit — still
 * settles, and so does one it saw end and then saw START AGAIN, since a run
 * that is running is not spent (announce a retry that reuses its id with
 * `onRunStarted` and it keeps its right to finalize). Filtering any of
 * those out would strand its sessions in phase 'streaming' forever, while a
 * premature settle self-heals on the next delta. `onAttached` clears the
 * memory outright: catch-up covers a gap the binding cannot see into.
 * Without ids the binding has no run identity to filter on (nor
 * does the per-message `bindMessageEvents`, which never observes a run
 * start), so a host that can forward events from a run it no longer
 * observes must filter them at the adapter seam itself.
 */
export interface TextMessageEvents {
  onTextDelta(cb: (messageId: string, delta: string) => void): () => void;
  onMessageEnd(cb: (messageId: string) => void): () => void;
  /** Run finished cleanly. `runId` optional; see RUN IDENTITY above. */
  onRunFinalized(cb: (runId?: string) => void): () => void;
  /** Run failed. `runId` optional; see RUN IDENTITY above. */
  onRunFailed(cb: (info?: RunFailureInfo, runId?: string) => void): () => void;
  /**
   * Optional run-lifecycle event, consumed by `bindRunTextEvents`: fired at
   * run init with the ids of every message already present in the timeline.
   * That snapshot is the authority on which rows pre-exist the run — rows in
   * it must never be typed out again (attach/resume semantics). `runId` is
   * the identity the binding filters later lifecycle events against.
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
   * re-type, and the run-identity filter starts over (see RUN IDENTITY).
   */
  onAttached?(cb: () => void): () => void;
}

/**
 * The slice of StreamSession the event binding drives. Structural so the
 * binding core is testable with a recording fake instead of a real session.
 */
export type SessionSink = Pick<StreamSession, 'append' | 'finalize'>;

/**
 * A `SessionSink` that can also coalesce: deltas pool in the session's
 * pending buffer and one scheduled flush appends them together, which is
 * what a `holdBackChars` tail and a `smoother` meter. Required by
 * `bindMessageEvents` when `MessageBindingOptions.coalesce` is set — nothing
 * else is needed there, because settling drains the buffer on its own
 * (`finalize` appends everything pending first).
 */
export type BufferedSessionSink = SessionSink &
  Pick<StreamSession, 'appendBuffered'>;

/** Optional routing switches for `bindMessageEvents`. */
export interface MessageBindingOptions {
  /**
   * Route deltas through `appendBuffered` instead of `append`, so a wire
   * that outpaces frames commits once per frame rather than once per delta
   * (and a smoother can meter the reveal). Off by default: the original
   * three-argument form appends synchronously and must keep doing so.
   */
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
 * With `options.coalesce` the delta path is `appendBuffered`, which is what
 * makes per-frame coalescing and a smoother reachable through the
 * per-message adapter; without it every delta appends synchronously, as it
 * always has.
 *
 * What this binding deliberately does NOT do, in contrast to
 * `bindRunTextEvents`: it never calls `notifyRunFinalized`, and run end
 * finalizes straight through a metered tail — `finalize` drains the pending
 * buffer synchronously, so a smoothed reveal ends by committing the rest in
 * one revision rather than playing out against a deadline. A run-end
 * drained-hold needs the run-scoped binding, which owns the whole run.
 *
 * Detach unsubscribes only. It does not flush or settle the sink: a rebind
 * (a host handing a fresh `events` object every render) must not dump a
 * smoother's withheld backlog, and a session's own timers keep draining
 * whatever is pending, so nothing is stranded. A session dropped for good
 * needs `dispose()` — `useAgUiSession` does that at unmount.
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
  // Latched once: the overloads make `coalesce` with a plain sink a compile
  // error, and the runtime check keeps an untyped caller appending rather
  // than throwing on a missing method.
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

/**
 * Settles a session that is being unbound while its stream is still open —
 * `useAgUiSession`'s messageId switching mid-message. Nothing will feed it
 * again, so left alone it would sit in phase 'streaming' for the life of the
 * component, showing the last streaming tail repair (a virtual fence closer,
 * a hidden growing URI) instead of the honest text. `'aborted'` is the right
 * reason: a message that ended already finalized itself on END, so whatever
 * is still streaming here never finished. A settled session is left alone
 * (and `finalize` is idempotent and inert after `dispose()` anyway).
 */
export function settleUnboundSession(
  session: Pick<StreamSession, 'snapshot' | 'finalize'>,
): void {
  if (session.snapshot().phase === 'settled') {
    return;
  }
  session.finalize('aborted');
}

/**
 * Everything `useAgUiSession` can pass to the sessions it creates: the
 * `StreamSessionInit` surface (minus the smoother instance, which must be a
 * factory here — see below) plus the delta-routing switch. This is the shape
 * that makes the replaceable engine, per-frame coalescing and the typewriter
 * smoother reachable through the per-message hook; without it a session
 * could only be given parse options.
 *
 * LATCHED PER SESSION, NOT LIVE SWITCHES. Every field here is read once, when
 * a messageId's session is CREATED, and holds for that session's life:
 * `engine`, `options`, `repair`, `now`, the smoother instance the factory
 * returns, `holdBackChars`, `holdIdleMs` and both schedulers are constructor
 * arguments, and `coalesce` is recorded against the session at the same
 * moment and read back from there when the binding rebinds — so an init that
 * changes shape on a later render re-routes nothing and re-configures
 * nothing, however often the host's `events` object changes identity. The
 * change reaches the next NEW messageId, not the one already streaming. Vary
 * the pacing of a live message through the smoother itself (it is consulted
 * per flush), not by swapping this object.
 */
export interface UseAgUiSessionInit {
  /**
   * Parser for every session this hook creates. Absent, sessions use the
   * package default (the native md4c engine) — pass one where native code
   * cannot run, or to swap the parser wholesale.
   */
  engine?: Engine;
  /**
   * Parse options, captured when a messageId's session is first created;
   * later changes do not re-parse an in-flight session.
   */
  options?: EngineOptions;
  /**
   * Route deltas through `appendBuffered` (one coalesced flush per frame)
   * instead of appending each delta synchronously. Defaults to true when
   * this init carries any buffering field — `smoother`, `holdBackChars`,
   * `holdIdleMs`, `bufferScheduler` or `idleScheduler` — since none of them
   * does anything on the synchronous path, and false otherwise, which is
   * what the bare-`EngineOptions` form has always done. Set it explicitly
   * for frame coalescing with every other default.
   *
   * `repair` and `now` are deliberately NOT part of that inference, though
   * they sit next to the fields that are: `repair` threads into the tail
   * repair of EVERY commit, synchronous appends included, and `now` is only
   * the clock a smoother's context reads. Neither implies buffering, so
   * inferring from them would silently coalesce for a caller who configured
   * display repairs or injected a deterministic clock and asked for nothing
   * else. Pass `coalesce: true` alongside them if that is what you want.
   *
   * Latched with the rest of the init (see the note on this interface): the
   * value is recorded against the session when that session is created, and
   * every later bind of it — including the rebind a new `events` identity
   * causes, which is every render for a host building that object inline —
   * routes the way the session was latched. Flipping this on a later render
   * therefore cannot re-route a message already streaming, in either
   * direction; the flip that would hurt most is true -> false, which would
   * send the next delta through `append` and dump a smoother's whole
   * withheld tail in one commit.
   *
   * Coalescing paces the STREAM, not the settle: run end (and message end)
   * finalizes through `StreamSession.finalize`, which drains everything
   * pending first, so a metered tail is committed in one revision rather
   * than played out to its end. Holding the run open until the smoother
   * finishes is `useAgUiRunSessions`' drained-hold, which needs the whole
   * run's events; this hook sees one message.
   */
  coalesce?: boolean;
  /**
   * Smoother FACTORY, not a smoother: this hook creates one session per
   * messageId over the component's life, and stateful smoothers
   * (`createSmoother`, `createAdaptiveSmoother`) must not be shared between
   * sessions, so every created session gets its own instance.
   */
  smoother?: () => Smoother;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  holdBackChars?: number;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  holdIdleMs?: number;
  /** Forwarded to each created session (see `StreamSessionInit.repair`). */
  repair?: RepairOptions;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  bufferScheduler?: BufferScheduler;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  idleScheduler?: IdleScheduler;
  /** Forwarded to each created session (see `StreamSessionInit`). */
  now?: () => number;
}

/**
 * `useAgUiSession`'s third argument: either bare `EngineOptions` (the
 * original form — `useAgUiSession(events, id, presets.llmChat)` still reads
 * as "parse with these options") or a full {@link UseAgUiSessionInit}. Their
 * keys are disjoint, which is what the runtime tells them apart by; the
 * `?: never` members make a literal that mixes the two a compile error
 * rather than a silently half-applied init.
 */
export type UseAgUiSessionOptions =
  | (EngineOptions & { [K in keyof UseAgUiSessionInit]?: never })
  | (UseAgUiSessionInit & { [K in keyof EngineOptions]?: never });

/**
 * Every {@link UseAgUiSessionInit} key, as a record so adding a field to the
 * interface without listing it here fails to compile — the discrimination
 * below is only correct while this stays complete.
 */
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

/**
 * Every `EngineOptions` key, for the DEV check below — the same
 * add-a-field-and-it-fails-to-compile discipline as `SESSION_INIT_KEYS`.
 */
const ENGINE_OPTIONS_KEYS: Record<keyof EngineOptions, true> = {
  extensions: true,
  html: true,
  smartPunctuation: true,
  urlPolicy: true,
};

/**
 * Type-only, no runtime cost: `UseAgUiSessionOptions` discriminates on the
 * two key sets being disjoint, so a field added to either interface under a
 * name the other already uses must fail the build rather than collapse the
 * union into something no literal satisfies. If this line stops compiling,
 * the error names the colliding key.
 */
type SharedInitOptionKey = Extract<
  keyof UseAgUiSessionInit,
  keyof EngineOptions
>;
type AssertNever<T extends never> = T;
type _InitAndOptionKeysAreDisjoint = AssertNever<SharedInitOptionKey>;

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

/** Key combinations already warned about, so the warning fires once each. */
const warnedMixedInits = new Set<string>();

/**
 * DEV warning for the one mistake the type system cannot catch: an untyped
 * (JavaScript) caller writing `useAgUiSession(events, id, { ...presets.llmChat,
 * engine })`. That object carries an init key, so it resolves as an init —
 * and every parse option in the spread is dropped on the floor, silently,
 * because an init keeps them under `options`. TypeScript rejects the same
 * literal outright (the `?: never` members); JS callers get this instead.
 */
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

/**
 * Normalizes `useAgUiSession`'s third argument into the init it describes,
 * with `coalesce` resolved (see {@link UseAgUiSessionInit.coalesce}). An
 * argument carrying none of the init's keys is bare `EngineOptions` — that
 * includes `{}`, which means the same thing either way. An object carrying
 * BOTH shapes' keys resolves as an init (its parse options are dropped) and
 * warns in DEV; see {@link warnMixedSessionInit}.
 *
 * Exported because the hook's own logic is otherwise unreachable without a
 * React renderer, the same reason `getOrCreateSession` is exported.
 */
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

/**
 * Runs `teardown` when the component really unmounts, one macrotask late.
 *
 * The delay is what makes tearing sessions down safe: React 18's StrictMode
 * mounts, unmounts and remounts effects in one commit, and the remount's
 * setup lands here synchronously right after the cleanup — in time to cancel
 * a teardown that would otherwise dispose sessions the caller is already
 * rendering (they are created during render, so no re-render would replace
 * them). A real unmount has no such setup, so the timer fires.
 */
export function useDeferredUnmount(teardown: () => void): void {
  const teardownRef = useRef(teardown);
  teardownRef.current = teardown;
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    return () => {
      const timer = setTimeout(() => {
        cancelRef.current = null;
        teardownRef.current();
      }, 0);
      cancelRef.current = () => clearTimeout(timer);
    };
  }, []);
}

/**
 * Bridges streamed text deltas into a StreamSession: one session per
 * messageId, kept in a ref map for the lifetime of the calling component
 * (so a settled message's document survives messageId switches and
 * re-renders). The third argument is either bare `EngineOptions` or a
 * {@link UseAgUiSessionInit} carrying an `engine`, a smoother factory, and
 * the rest of the session's buffering knobs; either way it is read when a
 * messageId's session is first created, so later changes do not re-parse an
 * in-flight session.
 *
 * Lifecycle beyond the event binding:
 * - A messageId switch settles the outgoing session if its stream is still
 *   open (`finalize('aborted')`), instead of stranding it in phase
 *   'streaming' with its last tail repair — see
 *   {@link settleUnboundSession}. The session stays in the map, so
 *   switching back shows the settled document. The settle is deferred one
 *   macrotask and cancelled if that same session is bound again first, so
 *   neither StrictMode's mount/unmount/remount nor a switch away and back
 *   inside one tick ends a live message.
 * - Unmount disposes every session in the map: their scheduled flushes and
 *   idle drains are timers the sessions own, and unsubscribing a view does
 *   not stop them (see `StreamSession.dispose`). Pending text is dropped —
 *   nothing renders it any more.
 * - An `events` identity change alone (a host building the object inline
 *   every render) only rebinds. It never settles or disposes anything.
 *
 * Run end here settles through `finalize`, which drains a metered tail in
 * one commit rather than playing it out: the drained-hold and
 * `notifyRunFinalized` belong to `useAgUiRunSessions`, which observes the
 * whole run.
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

  // The delta routing each session was created with. Latched HERE, next to
  // the session, rather than re-resolved by the binding effect below: that
  // effect re-runs on every `events` identity change — every render, for a
  // host building its event object inline — and re-reading the init there
  // would flip a live message between the synchronous and the buffered path
  // mid-stream. Turning coalescing off that way is visibly lossy: the next
  // delta takes `append`, which drains a smoother's whole withheld tail into
  // one commit.
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

  // Declared FIRST so its cleanup is scheduled before the ones below: at
  // unmount the sessions are disposed, which makes the outgoing-session
  // settle a no-op (no last parse into a document nobody reads).
  useDeferredUnmount(() => {
    for (const dropped of sessions.values()) {
      dropped.dispose();
    }
    sessions.clear();
    coalesceBySession.clear();
  });

  useEffect(() => {
    // The routing latched when this session was created, not whatever the
    // current init says — see `coalesceBySession` above. A session always
    // has an entry (it is written where the session is made); the fallback
    // is the synchronous path this hook has always defaulted to.
    return coalesceBySession.get(session) === true
      ? bindMessageEvents(events, messageId, session, { coalesce: true })
      : bindMessageEvents(events, messageId, session);
  }, [coalesceBySession, events, messageId, session]);

  // Settling the outgoing session is keyed on the session alone, not on the
  // binding's deps: a host passing an inline `events` object rebinds on
  // every render, and settling there would end the stream mid-message.
  // Deferred like the unmount teardown, and for the same StrictMode reason —
  // with the pending settle cancelled only when the SAME session comes back,
  // so a real messageId switch still settles the one it left behind.
  //
  // Keyed BY SESSION, not one slot: more than one cleanup can run before any
  // timer does (switching m1 -> m2 -> m1 in a single macrotask, which a
  // parent setState inside a passive effect or a flushSync produces), and a
  // single slot would drop the first cancel handle on the floor — the timer
  // it belonged to would then settle the session the component is rendering,
  // mid-stream. Entries are removed when their timer fires or is cancelled,
  // so the map holds only genuinely pending settles.
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
        settleUnboundSession(session);
      }, 0);
      pendingSettles.set(session, () => clearTimeout(timer));
    };
  }, [pendingSettles, session]);

  return session;
}
