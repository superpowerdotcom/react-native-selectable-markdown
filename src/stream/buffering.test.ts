import type { Block, ParagraphNode, ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import type {
  BufferScheduler,
  IdleScheduler,
  SessionSnapshot,
  StreamSessionInit,
} from './StreamSession';
import { retreatToClusterBoundary } from './clusters';
import { StreamSession } from './StreamSession';
import type { SmootherContext } from './smoothing';
import { createAdaptiveSmoother, createSmoother } from './smoothing';

// ---------------------------------------------------------------------------
// appendBuffered / flushBuffered: coalescing, holdback, and the drains.
//
// Everything here is deterministic: both schedulers are injected manual
// triggers (nothing fires until the test says so), and the engine is a
// counting paragraph parser so "how many times did the engine run" is a
// first-class assertion, not an inference from timing. Deltas deliberately
// contain construct characters ('.', '*') where a parse count matters —
// pure-prose deltas would hit the session's parse-free fast path and make
// per-delta appends look as cheap as coalesced ones.
// ---------------------------------------------------------------------------

/** Manual stand-in for the frame scheduler: fires only when told to. */
function manualFrame() {
  let next: (() => void) | null = null;
  let scheduled = 0;
  let cancelled = 0;
  const scheduler: BufferScheduler = (flush) => {
    scheduled += 1;
    next = flush;
    return () => {
      cancelled += 1;
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
    get scheduled() {
      return scheduled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** Manual stand-in for the idle-drain scheduler; records the ms it was given. */
function manualIdle() {
  let next: (() => void) | null = null;
  let lastMs: number | null = null;
  let cancelled = 0;
  const scheduler: IdleScheduler = (flush, ms) => {
    next = flush;
    lastMs = ms;
    return () => {
      cancelled += 1;
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
    get lastMs() {
      return lastMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * Blank-line-separated paragraphs with exact spans (value === source slice —
 * the span invariant the session relies on), counting every parse call.
 */
function countingEngine() {
  let parses = 0;
  const engine: Engine = {
    name: 'counting-paragraphs',
    parse(source: string): ParsedDocument {
      parses += 1;
      const blocks: Block[] = [];
      let paraStart = -1;
      let paraEnd = -1;
      const flushPara = () => {
        if (paraStart === -1) {
          return;
        }
        const span = { start: paraStart, end: paraEnd };
        const node: ParagraphNode = {
          kind: 'paragraph',
          span,
          children: [
            { kind: 'text', span, value: source.slice(span.start, span.end) },
          ],
        };
        blocks.push(node);
        paraStart = -1;
      };
      let lineStart = 0;
      for (;;) {
        const nl = source.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? source.length : nl;
        if (/[^ \t\r]/.test(source.slice(lineStart, lineEnd))) {
          if (paraStart === -1) {
            paraStart = lineStart;
          }
          paraEnd = lineEnd;
        } else {
          flushPara();
        }
        if (nl === -1) {
          break;
        }
        lineStart = nl + 1;
      }
      flushPara();
      return { source, blocks };
    },
  };
  return {
    engine,
    get parses() {
      return parses;
    },
  };
}

function harness(init?: Partial<StreamSessionInit>) {
  const counted = countingEngine();
  const frame = manualFrame();
  const idle = manualIdle();
  const seen: SessionSnapshot[] = [];
  const session = new StreamSession({
    engine: counted.engine,
    bufferScheduler: frame.scheduler,
    idleScheduler: idle.scheduler,
    ...init,
  });
  session.subscribe((snap) => seen.push(snap));
  return { session, counted, frame, idle, seen };
}

describe('StreamSession.appendBuffered', () => {
  test('coalesces deltas: one parse and one notification per flush', () => {
    const { session, counted, frame, seen } = harness();
    session.appendBuffered('One.');
    session.appendBuffered(' Two.');
    session.appendBuffered(' Three.');
    expect(counted.parses).toBe(0);
    expect(seen).toHaveLength(0);
    expect(session.length).toBe(0); // length reflects only appended text
    expect(frame.scheduled).toBe(1); // never double-schedules
    frame.fire();
    expect(counted.parses).toBe(1);
    expect(seen).toHaveLength(1);
    expect(session.length).toBe(16);
    expect(session.snapshot().document.source).toBe('One. Two. Three.');
  });

  test('empty delta is a no-op: nothing pooled, nothing scheduled', () => {
    const { session, frame, seen } = harness();
    session.appendBuffered('');
    expect(frame.scheduled).toBe(0);
    frame.fire();
    expect(seen).toHaveLength(0);
    expect(session.snapshot().revision).toBe(0);
    session.appendBuffered('x.');
    expect(frame.scheduled).toBe(1);
    frame.fire();
    expect(seen.map((snap) => snap.document.source)).toEqual(['x.']);
  });

  test('engine runs fewer times than per-delta appends on the same stream', () => {
    const deltas = ['Alpha.', ' Beta.', ' Gamma.', ' Delta.'];

    const direct = countingEngine();
    const perDelta = new StreamSession({ engine: direct.engine });
    for (const d of deltas) {
      perDelta.append(d);
    }
    expect(direct.parses).toBe(deltas.length);

    const { session, counted, frame } = harness();
    for (const d of deltas) {
      session.appendBuffered(d);
    }
    frame.fire();
    expect(session.snapshot().document.source).toBe(deltas.join(''));
    expect(counted.parses).toBe(1);
    expect(counted.parses).toBeLessThan(direct.parses);
  });

  test('holdback keeps the trailing characters out of every snapshot', () => {
    const { session, frame, idle } = harness({ holdBackChars: 4 });
    session.appendBuffered('Hello **bo');
    frame.fire();
    // The half-typed "**bo" never reached the parser, so nothing needed
    // repair — the rendered document is clean prose, not a flagged repair.
    expect(session.length).toBe(6);
    const snap = session.snapshot();
    expect(snap.document.source).toBe('Hello ');
    expect(snap.document.blocks[0].incomplete).toBeUndefined();
    expect(idle.pending).toBe(true); // the held tail is not stranded
  });

  test('a flush that would fit entirely inside the holdback appends nothing but arms the idle drain', () => {
    const { session, frame, idle, seen } = harness({ holdBackChars: 10 });
    session.appendBuffered('short');
    frame.fire();
    expect(session.length).toBe(0);
    expect(seen).toHaveLength(0);
    expect(idle.pending).toBe(true);
    idle.fire();
    expect(session.snapshot().document.source).toBe('short');
  });

  test('the holdback cut never splits a surrogate pair', () => {
    const { session, frame, idle } = harness({ holdBackChars: 1 });
    session.appendBuffered('ab\u{1F600}');
    frame.fire();
    // The cut at length-1 would land between the emoji's surrogates; it
    // moves one unit down so the whole pair stays pending.
    expect(session.length).toBe(2);
    expect(session.snapshot().document.source).toBe('ab');
    idle.fire();
    expect(session.length).toBe(4);
    expect(session.snapshot().document.source).toBe('ab\u{1F600}');
  });

  test('surrogate adjustment that empties the flush still arms the idle drain', () => {
    const { session, frame, idle } = harness({ holdBackChars: 1 });
    session.appendBuffered('\u{1F600}');
    frame.fire();
    expect(session.length).toBe(0);
    expect(idle.pending).toBe(true);
    idle.fire();
    expect(session.snapshot().document.source).toBe('\u{1F600}');
  });

  test('idle drain flushes the held tail after holdIdleMs of silence', () => {
    const { session, frame, idle } = harness({
      holdBackChars: 3,
      holdIdleMs: 120,
    });
    session.appendBuffered('Watch **');
    frame.fire();
    expect(session.length).toBe(5); // "Watch"; " **" held
    expect(idle.lastMs).toBe(120);
    idle.fire();
    expect(session.length).toBe(8);
    expect(session.snapshot().phase).toBe('streaming');
  });

  test('a new buffered delta cancels the armed idle drain and reschedules the flush', () => {
    const { session, frame, idle } = harness({ holdBackChars: 3 });
    session.appendBuffered('First bit.');
    frame.fire();
    expect(idle.pending).toBe(true);
    session.appendBuffered(' More.');
    expect(idle.cancelled).toBe(1);
    expect(idle.pending).toBe(false);
    expect(frame.pending).toBe(true);
    frame.fire();
    // "First bit. More." is 16 chars; 3 held again, idle re-armed.
    expect(session.length).toBe(13);
    expect(idle.pending).toBe(true);
  });

  test('finalize drains pending first and settles every streamed character', () => {
    const { session, frame, seen } = harness({ holdBackChars: 4 });
    session.appendBuffered('Ending **bold');
    session.finalize();
    const snap = session.snapshot();
    expect(snap.phase).toBe('settled');
    expect(snap.document.source).toBe('Ending **bold');
    expect(session.length).toBe(13);
    expect(seen[seen.length - 1]).toBe(snap);
    // The scheduled flush was cancelled; firing it later changes nothing.
    expect(frame.cancelled).toBe(1);
    frame.fire();
    expect(session.snapshot()).toBe(snap);
  });

  test('replace drains pending first, then prefix-diffs against the full text', () => {
    const { session, frame } = harness();
    session.appendBuffered('abc');
    session.replace('abcdef');
    // Drain appended 'abc'; the replace then extended by 'def' — one stream,
    // in arrival order, regardless of flush timing.
    expect(session.length).toBe(6);
    expect(session.snapshot().document.source).toBe('abcdef');
    frame.fire();
    expect(session.length).toBe(6);
  });

  test('diverging replace still drains pending before resetting', () => {
    const { session, seen } = harness();
    session.appendBuffered('zzz.');
    session.replace('Brand new.');
    expect(seen.map((s) => s.document.source)).toEqual([
      'zzz.',
      'Brand new.',
    ]);
    expect(session.snapshot().document.source).toBe('Brand new.');
  });

  test('direct append drains pending first so ordering is preserved', () => {
    const { session, frame } = harness();
    session.appendBuffered('first.');
    session.append(' second.');
    expect(session.snapshot().document.source).toBe('first. second.');
    expect(frame.cancelled).toBe(1);
    frame.fire();
    expect(session.length).toBe(14);
  });

  test("append('') still drains: the empty delta is the no-op, not the call", () => {
    const { session, counted, seen } = harness();
    session.appendBuffered('metered text here');
    expect(session.length).toBe(0);
    session.append('');
    // `append('')` drains first, so with text buffered it parses, bumps the
    // revision and notifies like `flushBuffered()`.
    expect(session.length).toBe(17);
    expect(counted.parses).toBe(1);
    expect(seen).toHaveLength(1);
    expect(session.snapshot().document.source).toBe('metered text here');
    const snap = session.snapshot();
    session.append('');
    expect(session.snapshot()).toBe(snap);
    expect(seen).toHaveLength(1);
    session.appendBuffered('');
    expect(session.pendingLength).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test('flushBuffered drains immediately and is idempotent when empty', () => {
    const { session, seen } = harness({ holdBackChars: 4 });
    session.flushBuffered(); // nothing pending: complete no-op
    expect(seen).toHaveLength(0);
    session.appendBuffered('once.');
    session.flushBuffered(); // holdback does not apply to an explicit drain
    expect(session.snapshot().document.source).toBe('once.');
    const snap = session.snapshot();
    const emitted = seen.length;
    session.flushBuffered();
    session.flushBuffered();
    expect(seen).toHaveLength(emitted);
    expect(session.snapshot()).toBe(snap);
  });

  test('a scheduler that flushes synchronously never strands later deltas', () => {
    // The BufferScheduler contract only requires a cancel function — a host
    // may invoke the flush before returning when the frame budget is
    // already blown. Its returned cancel must not register as a scheduled
    // flush after the callback fired, or every later appendBuffered would
    // see one pending and mid-stream rendering would silently freeze.
    const counted = countingEngine();
    const seen: SessionSnapshot[] = [];
    const session = new StreamSession({
      engine: counted.engine,
      bufferScheduler: (flush) => {
        flush();
        return () => {};
      },
    });
    session.subscribe((snap) => seen.push(snap));
    session.appendBuffered('One.');
    session.appendBuffered(' Two.');
    session.appendBuffered(' Three.');
    expect(seen).toHaveLength(3); // every delta flushed, none stranded
    expect(session.snapshot().document.source).toBe('One. Two. Three.');
  });

  test('a smoother meters each flush and the drain keeps its own cadence', () => {
    const { session, frame, idle } = harness({ smoother: () => 3 });
    session.appendBuffered('0123456789');
    expect(session.pendingLength).toBe(10);
    frame.fire();
    expect(session.snapshot().document.source).toBe('012');
    // No new appendBuffered, yet the next flush is already scheduled — a
    // smoothed drain must not depend on further input to finish.
    expect(frame.pending).toBe(true);
    expect(idle.pending).toBe(false);
    frame.fire();
    frame.fire();
    expect(session.snapshot().document.source).toBe('012345678');
    frame.fire(); // only 1 releasable char remains; the answer is clamped
    expect(session.snapshot().document.source).toBe('0123456789');
    expect(session.pendingLength).toBe(0);
    expect(frame.pending).toBe(false);
    expect(idle.pending).toBe(false);
  });

  test('a smoother releasing nothing this flush keeps the flush scheduled', () => {
    let calls = 0;
    const { session, frame } = harness({
      smoother: () => (calls++ === 0 ? 0 : 3),
    });
    session.appendBuffered('abc');
    frame.fire();
    expect(session.length).toBe(0);
    expect(frame.pending).toBe(true);
    frame.fire();
    expect(session.snapshot().document.source).toBe('abc');
  });

  test('synchronous drains bypass the smoother entirely', () => {
    const { session, frame } = harness({ smoother: () => 1 });
    session.appendBuffered('First bit.');
    session.flushBuffered();
    expect(session.snapshot().document.source).toBe('First bit.');
    session.appendBuffered(' The end.');
    session.finalize();
    const snap = session.snapshot();
    expect(snap.phase).toBe('settled');
    expect(snap.document.source).toBe('First bit. The end.');
    frame.fire();
    expect(session.snapshot()).toBe(snap);
  });

  test("the smoother's cut never splits a surrogate pair", () => {
    const { session, frame, idle } = harness({ smoother: () => 3 });
    session.appendBuffered('ab\u{1F600}');
    frame.fire();
    // A cut at 3 would land inside the emoji; it moves down to 2.
    expect(session.snapshot().document.source).toBe('ab');
    // The emoji waits at the buffer end, where the next delta could extend
    // it; the idle drain releases it whole.
    frame.fire();
    expect(session.snapshot().document.source).toBe('ab');
    idle.fire();
    expect(session.snapshot().document.source).toBe('ab\u{1F600}');
  });

  test('a cluster split across two deltas still commits whole', () => {
    // The buffer's end is not the text's end: every case but the ASCII base
    // is held (see src/stream/clusters.ts).
    for (const [first, second] of [
      ['\u{1F1FA}', '\u{1F1F8} flag'],
      ['\u{1F468}', '\u200D\u{1F469} pair'],
      ['\u{1F469}', '\u{1F3FD} wave'],
      ['1\uFE0F', '\u20E3 key'],
      ['\u0939', '\u093F ok'],
    ]) {
      const { session, frame, seen } = harness();
      session.appendBuffered(first);
      frame.fire();
      // Nothing at all: the whole delta is one unfinished cluster.
      expect(session.length).toBe(0);
      session.appendBuffered(second);
      frame.fire();
      session.finalize('end');
      expect(session.snapshot().document.source).toBe(first + second);
      for (const snap of seen) {
        const src = snap.document.source;
        expect(src === '' || src.startsWith(first + second[0])).toBe(true);
      }
    }
  });

  test('regional-indicator parity counts the committed text too', () => {
    // A committed flag flips the parity of the pending run: counting inside
    // the buffer alone would release the '🇺' of '🇺🇸' alone.
    let release = 4;
    const { session, frame, seen } = harness({ smoother: () => release });
    // `append` commits unmetered, so the source starts with a half-typed flag.
    session.append('\u{1F1EB}');
    expect(session.length).toBe(2);
    session.appendBuffered('\u{1F1F7}\u{1F1FA}\u{1F1F8}!');
    frame.fire();
    expect(session.length % 4).toBe(0);
    expect(session.snapshot().document.source).toBe('\u{1F1EB}\u{1F1F7}');
    release = 6;
    frame.fire();
    session.finalize('end');
    expect(session.snapshot().document.source).toBe(
      '\u{1F1EB}\u{1F1F7}\u{1F1FA}\u{1F1F8}!',
    );
    for (const snap of seen.slice(1)) {
      // The first snapshot is the unmetered setup above.
      const src = snap.document.source;
      let run = 0;
      for (let at = src.length; at >= 2; at -= 2) {
        const cp = src.codePointAt(at - 2);
        if (cp === undefined || cp < 0x1f1e6 || cp > 0x1f1ff) break;
        run += 1;
      }
      expect(run % 2).toBe(0);
    }
  });

  test('smoothing composes with holdback: the smoother never sees the held tail', () => {
    const seen: string[] = [];
    const { session, frame, idle } = harness({
      holdBackChars: 2,
      smoother: (releasable) => {
        seen.push(releasable);
        return releasable.length;
      },
    });
    session.appendBuffered('hello**');
    frame.fire();
    expect(seen).toEqual(['hello']);
    expect(session.snapshot().document.source).toBe('hello');
    // Only the holdback tail remains, so the idle drain owns it from here.
    expect(frame.pending).toBe(false);
    expect(idle.pending).toBe(true);
    idle.fire();
    expect(session.snapshot().document.source).toBe('hello**');
  });

  test('a non-finite smoother answer releases everything releasable', () => {
    const { session, frame } = harness({ smoother: () => NaN });
    session.appendBuffered('all at once.');
    frame.fire();
    expect(session.snapshot().document.source).toBe('all at once.');
  });

  // Tail repair renders a link's destination as nothing until the `)` lands,
  // so a metered reveal typing through those characters reads as a stall.
  // The session charges them zero budget instead: a smoothed cut that lands
  // inside a completed destination snaps past the `)` in the same flush.
  // The reveal cursor is asserted through `session.length` (raw committed
  // units): `document.source` is the REPAIRED parse input, whose virtual
  // closers would mask exactly the cut positions under test.
  test('a smoothed cut inside a completed link destination snaps past it', () => {
    const text = 'see [ApoB](fhir://Observation/abc) high';
    const pastParen = text.indexOf(')') + 1;
    const { session, frame } = harness({ smoother: () => 3 });
    session.appendBuffered(text);
    frame.fire(); // 'see'
    frame.fire(); // ' [A'
    expect(session.length).toBe(6);
    // This cut lands exactly at the `]` — the label completes and the whole
    // destination releases with it, budget-free, in the same flush.
    frame.fire();
    expect(session.length).toBe(pastParen);
    frame.fire();
    frame.fire();
    expect(session.snapshot().document.source).toBe(text);
  });

  test('a cut parked inside an unclosed destination snaps once the ) arrives', () => {
    const { session, frame } = harness({ smoother: () => 3 });
    session.appendBuffered('see [ApoB](fhir://Ob');
    for (let i = 0; i < 4; i += 1) frame.fire();
    // No `)` buffered yet: the cut advances into the destination at the
    // metered rate (the characters are invisible under tail repair either
    // way) and must NOT jump ahead of what has arrived.
    expect(session.length).toBe(12);
    session.appendBuffered('servation/abc) done');
    frame.fire();
    expect(session.length).toBe('see [ApoB](fhir://Observation/abc)'.length);
  });

  test('a flush with no budget still snaps past a destination that just closed', () => {
    let release = 12;
    const { session, frame } = harness({ smoother: () => release });
    session.appendBuffered('see [ApoB](fhir://Ob');
    frame.fire(); // 'see [ApoB](f' — committed ends inside the destination
    expect(session.length).toBe(12);
    release = 0;
    session.appendBuffered('servation/abc) done');
    frame.fire();
    // Zero budget released, yet the destination completes: the snap is free,
    // so the wait is one arrival, not one budget refill.
    expect(session.length).toBe('see [ApoB](fhir://Observation/abc)'.length);
  });

  test('drained() resolves once the metered tail has fully flushed', async () => {
    const { session, frame } = harness({ smoother: () => 4 });
    await expect(session.drained()).resolves.toBeUndefined(); // empty: immediate
    session.appendBuffered('abcdefgh');
    let drained = false;
    const wait = session.drained().then(() => {
      drained = true;
    });
    frame.fire();
    await Promise.resolve();
    expect(drained).toBe(false);
    frame.fire();
    await wait;
    expect(session.snapshot().document.source).toBe('abcdefgh');
  });

  test('a synchronous scheduler cannot loop a smoothed drain: the idle drain takes over', () => {
    // Smoothing needs real frames; a scheduler that fires synchronously
    // provides none. The re-entry guard refuses the recursive flush and the
    // remainder falls back to the idle drain instead of spinning.
    const counted = countingEngine();
    const idle = manualIdle();
    const session = new StreamSession({
      engine: counted.engine,
      idleScheduler: idle.scheduler,
      bufferScheduler: (flush) => {
        flush();
        return () => {};
      },
      smoother: () => 1,
    });
    session.appendBuffered('abc');
    expect(session.snapshot().document.source).toBe('a');
    expect(idle.pending).toBe(true);
    idle.fire();
    expect(session.snapshot().document.source).toBe('abc');
  });

  test('the smoother receives {now, pendingLength, sourceLength} on the injected clock', () => {
    let t = 1000;
    const contexts: SmootherContext[] = [];
    const { session, frame } = harness({
      holdBackChars: 2,
      now: () => t,
      smoother: (releasable, context) => {
        contexts.push({ ...context! });
        return 3;
      },
    });
    session.appendBuffered('0123456789');
    frame.fire();
    // Lengths are sampled before the release mutates them: the FULL pending
    // buffer (holdback included, beyond the 8-unit releasable slice) and the
    // committed source at flush time — their sum is the total text arrived.
    expect(contexts[0]).toEqual({ now: 1000, pendingLength: 10, sourceLength: 0 });
    expect(session.snapshot().document.source).toBe('012');
    t = 1250;
    frame.fire();
    expect(contexts[1]).toEqual({ now: 1250, pendingLength: 7, sourceLength: 3 });
  });

  // U+1F468 ZWJ U+1F469 ZWJ U+1F467 — 8 UTF-16 units, one visible glyph.
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

  test('a metered cut never splits an emoji ZWJ sequence: the cluster releases whole', () => {
    let release = 5;
    const seen: string[] = [];
    const { session, frame, idle } = harness({ smoother: () => release });
    session.subscribe((snap) => seen.push(snap.document.source));
    session.appendBuffered(`Hi ${FAMILY}`);
    // A cut at 5 lands between the first emoji's pair and its joiner; the
    // walk retreats past the joiner's left code point, so only the plain
    // prefix releases and the family stays pending in one piece.
    frame.fire();
    expect(session.length).toBe(3);
    expect(session.snapshot().document.source).toBe('Hi ');
    // A cut inside the SECOND joiner pair walks all the way down to the
    // cluster start: releasing 👨\u200D👩 without 👧 would paint a different family.
    release = 6;
    frame.fire();
    expect(session.length).toBe(3);
    release = 8;
    frame.fire();
    // The family waits at the buffer end until the idle drain decides no
    // joiner is coming.
    expect(session.length).toBe(3);
    idle.fire();
    expect(session.snapshot().document.source).toBe(`Hi ${FAMILY}`);
    // No committed snapshot ever held a partial cluster.
    for (const source of seen) {
      expect(source.includes('\u200D') && !source.includes(FAMILY)).toBe(false);
    }
  });

  // U+2764 U+FE0F U+200D U+1F525 — 5 UTF-16 units, one visible glyph. The
  // VS16 between the base and the joiner is what the plain ZWJ walk used to
  // stop at, committing a bare text-presentation '❤'.
  const HEART_ON_FIRE = '\u2764\uFE0F\u200D\u{1F525}';

  test('a metered cut never splits a VS16 ZWJ sequence: base and selector stay pending together', () => {
    let release = 2;
    const seen: string[] = [];
    const { session, frame } = harness({ smoother: () => release });
    session.subscribe((snap) => seen.push(snap.document.source));
    session.appendBuffered(`${HEART_ON_FIRE} hot`);
    // A cut at 2 sits between the VS16 and the joiner: the retreat must
    // step past the joiner-glued VS16 AND its base, releasing nothing.
    frame.fire();
    expect(session.length).toBe(0);
    release = 4; // inside 🔥's surrogate pair — the same walk from further up
    frame.fire();
    expect(session.length).toBe(0);
    release = 5; // the whole cluster is finally affordable — it releases whole
    frame.fire();
    expect(session.length).toBe(5);
    expect(session.snapshot().document.source).toBe(HEART_ON_FIRE);
    for (const source of seen) {
      expect(source === '' || source.startsWith(HEART_ON_FIRE)).toBe(true);
    }
  });

  test('a metered cut never splits a skin-tone modifier off its base', () => {
    // U+1F469 U+1F3FD U+200D U+1F680 — 👩🏽‍🚀, 7 UTF-16 units.
    const ASTRONAUT = '\u{1F469}\u{1F3FD}\u200D\u{1F680}';
    let release = 2;
    const { session, frame } = harness({ smoother: () => release });
    session.appendBuffered(`${ASTRONAUT} go`);
    frame.fire(); // between 👩 and 🏽: the modifier is an extender — retreat past the base
    expect(session.length).toBe(0);
    release = 5; // just past the joiner: joiner walk, then the extender step
    frame.fire();
    expect(session.length).toBe(0);
    release = 7;
    frame.fire();
    expect(session.snapshot().document.source).toBe(ASTRONAUT);
  });

  test('a metered cut never leaves half a flag: regional indicators release in pairs', () => {
    // Two regional indicators, 4 UTF-16 units.
    const FLAG = '\u{1F1FA}\u{1F1F8}';
    const trailingIndicators = (text: string) =>
      [.../[\u{1F1E6}-\u{1F1FF}]*$/u.exec(text)![0]].length;
    let release = 2;
    const seen: string[] = [];
    const { session, frame } = harness({ smoother: () => release });
    session.subscribe((snap) => seen.push(snap.document.source));
    session.appendBuffered(`${FLAG}${FLAG} up`);
    frame.fire();
    expect(session.length).toBe(0);
    release = 4; // the whole first flag — the run before the cut is even
    frame.fire();
    expect(session.length).toBe(4);
    release = 2; // half of the second flag: held, exactly like the first
    frame.fire();
    expect(session.length).toBe(4);
    release = 4;
    frame.fire();
    expect(session.length).toBe(8);
    release = 3;
    frame.fire();
    expect(session.snapshot().document.source).toBe(`${FLAG}${FLAG} up`);
    for (const source of seen) {
      expect(trailingIndicators(source) % 2).toBe(0);
    }
  });

  test('a metered cut never splits a combining mark off its base', () => {
    // 'café' in NFD: 'cafe' + U+0301. A cut at 4 commits 'cafe' and repaints
    // it as 'café' on the next flush.
    const { session, frame } = harness({ smoother: () => 4 });
    session.appendBuffered('cafe\u0301 open');
    frame.fire();
    expect(session.snapshot().document.source).toBe('caf');
  });

  test('a metered cut never splits a keycap or an Indic matra off its base', () => {
    // '1️⃣' is '1' U+FE0F U+20E3: the keycap is a combining enclosing mark.
    let release = 1;
    const { session, frame } = harness({ smoother: () => release });
    session.appendBuffered('1\uFE0F\u20E3 first');
    frame.fire();
    expect(session.length).toBe(0);
    release = 2; // between the variation selector and the keycap
    frame.fire();
    expect(session.length).toBe(0);
    release = 3;
    frame.fire();
    expect(session.snapshot().document.source).toBe('1\uFE0F\u20E3');

    // Devanagari 'हि' is ह + the spacing matra ि (U+093F).
    const { session: hi, frame: hiFrame } = harness({ smoother: () => 1 });
    hi.appendBuffered('\u0939\u093F\u0928 ok');
    hiFrame.fire();
    expect(hi.length).toBe(0);
  });

  /**
   * A real `createSmoother` on a fake clock (16 ms frames, three-unit chunks),
   * which sees how the budget reacts when the session retreats its answer.
   */
  function typewriter(text: string, charsPerSecond: number) {
    let t = 0;
    // One box: TypeScript narrows a `let` written only from inside a closure
    // to `never` at the call site.
    const timers: { frame: (() => void) | null; idle: (() => void) | null } = {
      frame: null,
      idle: null,
    };
    let idleDeadline = 0;
    const counted = countingEngine();
    const commits: string[] = [];
    const session = new StreamSession({
      engine: counted.engine,
      now: () => t,
      bufferScheduler: (flush) => {
        timers.frame = flush;
        return () => {
          timers.frame = null;
        };
      },
      idleScheduler: (flush, ms) => {
        timers.idle = flush;
        idleDeadline = t + ms;
        return () => {
          timers.idle = null;
        };
      },
      smoother: createSmoother({ charsPerSecond, now: () => t }),
    });
    session.subscribe((snap) => commits.push(snap.document.source));
    let fed = 0;
    // 500 frames is 8 s of wall clock, long enough that a stall shows.
    for (let f = 0; f < 500; f += 1) {
      t += 16;
      if (fed < text.length && f % 2 === 0) {
        session.appendBuffered(text.slice(fed, fed + 3));
        fed += 3;
      }
      if (timers.idle !== null && t >= idleDeadline) {
        const fire = timers.idle;
        timers.idle = null;
        fire();
      }
      const frame = timers.frame;
      timers.frame = null;
      frame?.();
    }
    return { source: session.snapshot().document.source, commits };
  }

  test('a real createSmoother drains text whose glyphs are wider than one frame of budget', () => {
    // The cluster-safe retreat releases less than the smoother answered; the
    // budget must settle on what landed or a wide glyph never becomes
    // affordable.
    const cases: Array<[string, number]> = [
      ['\u{1F1FA}\u{1F1F8} flag', 100], // regional-indicator pair
      ['\u{1F1FA}\u{1F1F8} flag', 30], // …and a rate whose whole credit window is narrower than it
      ['1\uFE0F\u20E3 ok', 100], // keycap
      ['\u0939\u093F\u0928\u094D\u0926\u0940 \u0920\u0940\u0915 \u0939\u0948', 30], // Indic matras and viramas
      ['\u0939\u093F\u0928\u094D\u0926\u0940 \u0920\u0940\u0915 \u0939\u0948', 60],
      ['cafe\u0301 open', 30], // NFD combining accent
    ];
    for (const [text, charsPerSecond] of cases) {
      const { source, commits } = typewriter(text, charsPerSecond);
      expect([text, charsPerSecond, source]).toEqual([text, charsPerSecond, text]);
      expect(commits.length).toBeGreaterThan(1);
      for (const commit of commits) {
        expect(retreatToClusterBoundary(text, commit.length)).toBe(commit.length);
      }
    }
  });

  test('a stalled metered flush arms the idle drain, and progress disarms it', () => {
    // A cut inside a cluster releases nothing however often the frame fires,
    // so the idle drain is the backstop, and it must not outlive the release.
    let release = 4;
    const { session, frame, idle } = harness({ smoother: () => release });
    session.appendBuffered('cafe\u0301 open');
    frame.fire(); // 4 lands between 'e' and its accent: retreated to 'caf'
    expect(session.length).toBe(3);
    expect(idle.pending).toBe(false); // progress: no backstop needed
    release = 1; // now the cut is inside the 'e' + accent cluster itself
    frame.fire();
    expect(session.length).toBe(3); // nothing released…
    expect(idle.pending).toBe(true); // …so the backstop is armed
    frame.fire();
    expect(idle.cancelled).toBe(0); // armed once, not re-armed (and pushed out) per frame
    release = 2; // the whole cluster is affordable: the reveal resumes
    frame.fire();
    expect(session.length).toBe(5);
    expect(idle.pending).toBe(false);
  });

  test('with repair.hideUriLikeLabels a smoothed cut snaps from the [ past the )', () => {
    const text = 'see [fhir://Observation/abc](fhir://Observation/abc) ok';
    const pastParen = text.indexOf(') ') + 1;
    const { session, frame } = harness({
      smoother: () => 3,
      repair: { hideUriLikeLabels: true },
    });
    session.appendBuffered(text);
    frame.fire(); // 'see'
    expect(session.length).toBe(3);
    // The next cut lands inside the label. This session's tail repair hides
    // URI-like labels — none of `[label](dest` ever paints — so the snap
    // treats the whole construct as invisible and jumps from the `[` past
    // the `)` budget-free: the link appears atomically, no stalled reveal.
    frame.fire();
    expect(session.length).toBe(pastParen);
    expect(session.snapshot().document.source).toBe(text.slice(0, pastParen));
    // Without the option the same cut stays put: the default pipeline paints
    // the label, so the reveal meters through it at the normal rate.
    const plain = harness({ smoother: () => 3 });
    plain.session.appendBuffered(text);
    plain.frame.fire();
    plain.frame.fire();
    expect(plain.session.length).toBe(6);
  });

  test('default schedulers: flush on a ~frame timer, idle drain on holdIdleMs', () => {
    jest.useFakeTimers();
    try {
      const counted = countingEngine();
      // Node has no requestAnimationFrame, so the default buffer scheduler
      // falls back to setTimeout(flush, 16); the idle default is setTimeout.
      const session = new StreamSession({
        engine: counted.engine,
        holdBackChars: 2,
        holdIdleMs: 250,
      });
      session.appendBuffered('Hello.**');
      expect(session.length).toBe(0);
      jest.advanceTimersByTime(16);
      expect(session.snapshot().document.source).toBe('Hello.');
      jest.advanceTimersByTime(250);
      expect(session.length).toBe(8);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// External drains and the adaptive smoother. The adaptive policy remembers
// whether its last answer left text unreleased — that memory is what tells a
// timer suspension (big flush gap with text stranded mid-release → dump)
// from an idle stream resuming (big gap after a full drain → pace). The
// session releases text WITHOUT the smoother on two real paths — the
// synchronous drains (replace/flushBuffered/finalize/append, and the idle
// drain) and a link snap that empties the buffer — so it must hand the
// policy a zero-offer bookkeeping call on each, or the memory strands at
// "unreleased" and the next routine stream stall dumps the following burst
// in one commit. Every expected number below derives from the adaptive
// constants: fallback 180cps / measured-arrival pacing, ±30% controller,
// 100ms nominal tick.
// ---------------------------------------------------------------------------
describe('StreamSession external drains keep the adaptive smoother honest', () => {
  test('a replace() mid-stream does not turn the next stall into a dump', () => {
    let t = 0;
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => t,
    });
    session.appendBuffered('x'.repeat(200));
    // Gate open (200 ≥ 40), fallback 180cps, backlog above the high-lag
    // ratio → round(180 · 1.3 · 0.1) = 23 released, 177 left unreleased.
    frame.fire();
    expect(session.length).toBe(23);

    // A non-append correction (the app's marker renumber / recovery merge
    // path) drains the whole buffer behind the smoother's back.
    t = 300;
    session.replace('x'.repeat(200));
    expect(session.length).toBe(200);
    expect(session.pendingLength).toBe(0);

    // 1.9s of stream silence — a routine tool-call pause, NOT a timer
    // suspension (nothing was pending) — then a fresh burst. It must PACE:
    // measured arrival ≈ 38cps, catch-up ≈ 50cps, one nominal tick → 5.
    // Before the bookkeeping call this flush returned Infinity and dumped
    // all 84 characters in one commit.
    t = 2200;
    session.appendBuffered('y'.repeat(84));
    frame.fire();
    expect(session.length).toBe(205);
    expect(session.pendingLength).toBe(79);
    expect(frame.pending).toBe(true); // the metered drain continues
  });

  test('a link snap that empties the buffer does not poison the next burst', () => {
    let t = 0;
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => t,
    });
    // 45 units total; the pending text ends at the link's ')'.
    session.appendBuffered('Your latest ApoB level [ApoB](fhir://Obs/abc)');
    // Ease-off budget 14 word-snaps to 16 ('Your latest ApoB').
    frame.fire();
    expect(session.length).toBe(16);
    // Budget 14 again lands inside the completed destination — the snap
    // extends the take past the ')' and EMPTIES the buffer while the
    // smoother recorded a partial release.
    t = 100;
    frame.fire();
    expect(session.length).toBe(45);
    expect(session.pendingLength).toBe(0);

    // Routine 1.9s stall, then a burst: must pace (measured arrival 36cps,
    // catch-up ≈ 47cps, one nominal tick → 5), not dump all 72.
    t = 2000;
    session.appendBuffered('z'.repeat(72));
    frame.fire();
    expect(session.length).toBe(50);
    expect(session.pendingLength).toBe(67);
  });

  test('a genuine timer suspension still catches up in one commit', () => {
    let t = 0;
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => t,
    });
    session.appendBuffered('x'.repeat(200));
    frame.fire();
    expect(session.length).toBe(23);
    // No drain happened: 177 units really did sit stranded through the gap
    // (backgrounded app), so the late flush must dump, exactly as designed.
    t = 2000;
    frame.fire();
    expect(session.length).toBe(200);
    expect(session.pendingLength).toBe(0);
  });
});

describe('StreamSession.notifyRunFinalized', () => {
  test('suspends scheduled work and resumes the retained buffer', async () => {
    const { session, frame, idle } = harness();
    session.appendBuffered('First.');
    const drained = session.drained();
    session.suspend();
    expect(frame.pending).toBe(false);
    expect(idle.pending).toBe(false);
    session.appendBuffered(' Second.');
    expect(frame.pending).toBe(false);
    expect(session.length).toBe(0);
    session.resume();
    frame.fire();
    await expect(drained).resolves.toBeUndefined();
    expect(session.snapshot().document.source).toBe('First. Second.');
  });

  test.each(['中', 'café', '❤️‍🔥'])('releases the final cluster of %s without an idle delay', async (tail) => {
    const { session, frame, idle } = harness();
    session.appendBuffered(tail);
    frame.fire();
    expect(session.pendingLength).toBeGreaterThan(0);
    session.notifyRunFinalized();
    frame.fire();
    await expect(session.drained()).resolves.toBeUndefined();
    expect(session.snapshot().document.source).toBe(tail);
    expect(idle.pending).toBe(false);
    session.appendBuffered('中');
    frame.fire();
    expect(session.pendingLength).toBe(1);
  });

  function lifecycleSmoother() {
    const stamps: Array<number | undefined> = [];
    const smoother = Object.assign(() => Infinity, {
      notifyRunFinalized: (now?: number) => {
        stamps.push(now);
      },
    });
    return { smoother, stamps };
  }

  test('forwards to the smoother on the session clock', () => {
    const { smoother, stamps } = lifecycleSmoother();
    const { session } = harness({ smoother, now: () => 1234 });
    session.appendBuffered('tail');
    session.notifyRunFinalized();
    expect(stamps).toEqual([1234]);
  });

  test('with nothing pending it does not arm the policy at all', () => {
    // A policy armed with nothing to drain stays armed, so the next run's
    // first flush would be judged a run-end drain.
    const { smoother, stamps } = lifecycleSmoother();
    const { session, frame } = harness({ smoother, now: () => 1234 });
    session.notifyRunFinalized();
    expect(stamps).toEqual([]);
    // Not a one-shot suppression either: the next run still arms normally.
    session.appendBuffered('next run');
    session.notifyRunFinalized();
    expect(stamps).toEqual([1234]);
    frame.fire();
  });

  test('an empty session leaves an adaptive policy paced for its next run', () => {
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => 0,
    });
    session.notifyRunFinalized();
    // 20 units is below the 40-unit pre-buffer gate, so it stays held.
    session.appendBuffered('x'.repeat(20));
    frame.fire();
    expect(session.length).toBe(0);
    expect(session.pendingLength).toBe(20);
  });

  test('is a safe no-op without a smoother or without the lifecycle method', () => {
    const bare = harness();
    bare.session.notifyRunFinalized();
    expect(bare.frame.scheduled).toBe(0);
    expect(bare.seen).toHaveLength(0);
    bare.session.appendBuffered('ab.');
    bare.frame.fire();
    expect(bare.session.snapshot().document.source).toBe('ab.');
    const plain = harness({ smoother: () => 1 });
    plain.session.appendBuffered('abc');
    plain.session.notifyRunFinalized();
    plain.frame.fire();
    expect(plain.session.length).toBe(1);
    expect(plain.session.pendingLength).toBe(2);
    expect(plain.frame.pending).toBe(true);
  });

  test('switches an adaptive tail to the run-end drain: a short tail releases in one commit', () => {
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => 0,
    });
    session.appendBuffered('x'.repeat(100));
    session.notifyRunFinalized();
    // Without the notification this flush would pace: gate open (100 ≥ 40),
    // fallback 180cps with catch-up over one nominal tick → 23 units. The
    // run-end drain releases the whole ≤120-unit tail at once instead.
    frame.fire();
    expect(session.length).toBe(100);
    expect(session.pendingLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rewrite(): the metered-rewrite companion to replace(). A pipeline that
// rewrites only the unrevealed tail (chat's citation-link → marker transform
// on every citation completion) must not pay for it with a full drain — the
// reveal keeps typing through the swapped pending buffer.
// ---------------------------------------------------------------------------
describe('StreamSession.rewrite', () => {
  test('a rewrite confined to the unrevealed tail keeps the metered reveal', () => {
    const offered: string[] = [];
    const { session, frame, seen } = harness({
      smoother: (releasable) => {
        offered.push(releasable);
        return 3;
      },
    });
    session.appendBuffered('Your [ApoB](fh');
    frame.fire(); // 'You' committed; the raw partial link is still pending
    expect(session.length).toBe(3);

    // The digest completes the citation and rewrites the tail to its
    // marker form. Committed text is untouched, so nothing drains…
    session.rewrite('Your ApoB [1](#c-1) rest');
    expect(session.length).toBe(3);
    expect(session.pendingLength).toBe('r ApoB [1](#c-1) rest'.length);
    // …and the very next flush meters the NEW pending text.
    frame.fire();
    expect(offered[offered.length - 1]).toBe('r ApoB [1](#c-1) rest');
    expect(session.length).toBe(6);
    expect(frame.pending).toBe(true);
    // Identical full text is a complete no-op: no commit, no reschedule.
    const commits = seen.length;
    session.flushBuffered();
    session.rewrite(session.snapshot().document.source);
    expect(seen).toHaveLength(commits + 1); // only the explicit drain committed
  });

  test('a rewrite reaching into committed text falls back to replace semantics', () => {
    const { session, frame } = harness({ smoother: () => 3 });
    session.appendBuffered('Hello brave world');
    frame.fire(); // 'Hel'
    expect(session.length).toBe(3);
    // The correction touches text the reader has already seen: it must
    // paint at once — drain plus divergent reset, exactly like replace().
    session.rewrite('HELLO brave world');
    expect(session.length).toBe('HELLO brave world'.length);
    expect(session.pendingLength).toBe(0);
    expect(session.snapshot().document.source).toBe('HELLO brave world');
    // A full text SHORTER than the committed source is equally divergent.
    session.rewrite('HE');
    expect(session.snapshot().document.source).toBe('HE');
  });

  test('a rewrite that empties the pending tail resolves drained()', async () => {
    const { session, frame } = harness({ smoother: () => 3 });
    session.appendBuffered('abcdef');
    frame.fire(); // 'abc'
    let drained = false;
    const wait = session.drained().then(() => {
      drained = true;
    });
    session.rewrite('abc'); // deletes the whole unrevealed tail
    await wait;
    expect(drained).toBe(true);
    expect(session.pendingLength).toBe(0);
    expect(session.length).toBe(3);
    // The cancelled flush must not resurrect the deleted tail.
    frame.fire();
    expect(session.length).toBe(3);
  });

  test('rewrite composes with holdback: the swapped tail is held and idle-drained like appended text', () => {
    const { session, frame, idle } = harness({ holdBackChars: 4 });
    session.appendBuffered('Hello **bo');
    frame.fire(); // 'Hello ' committed, '**bo' held, idle armed
    expect(session.length).toBe(6);
    expect(idle.pending).toBe(true);
    // The swap is new buffered input: idle drain cancelled, flush
    // scheduled, holdback applied to the swapped tail at its flush.
    session.rewrite('Hello **bold**');
    expect(idle.pending).toBe(false);
    expect(frame.pending).toBe(true);
    frame.fire();
    expect(session.length).toBe(10); // '**bold**' minus the 4 held
    expect(idle.pending).toBe(true);
    idle.fire();
    expect(session.length).toBe(14);
    expect(session.snapshot().document.source).toBe('Hello **bold**');
  });

  test('a tail-emptying rewrite books an external drain with the adaptive smoother', () => {
    let t = 0;
    const { session, frame } = harness({
      smoother: createAdaptiveSmoother(),
      now: () => t,
    });
    session.appendBuffered('x'.repeat(200));
    frame.fire(); // releases 23, leaves 177 unreleased
    expect(session.length).toBe(23);
    // The rewrite deletes the unrevealed tail outright (full == committed).
    t = 300;
    session.rewrite('x'.repeat(23));
    expect(session.pendingLength).toBe(0);
    // The same 5-unit tick as after a replace() drain.
    t = 2200;
    session.appendBuffered('y'.repeat(84));
    frame.fire();
    expect(session.length).toBe(28);
    expect(session.pendingLength).toBe(79);
  });
});

describe('StreamSession buffered flush failures', () => {
  /** Paragraph engine that throws while `boom.on` is set. */
  function throwingHarness(init?: Partial<StreamSessionInit>) {
    const counted = countingEngine();
    const boom = { on: false };
    const engine: Engine = {
      name: 'throws-on-demand',
      parse(source, options) {
        if (boom.on) {
          throw new Error('engine boom');
        }
        return counted.engine.parse(source, options);
      },
    };
    return { boom, ...harness({ engine, ...init }) };
  }

  test('a throwing flush keeps the text pending and leaves a timer to retry it', async () => {
    const { session, boom, frame, idle } = throwingHarness({ holdBackChars: 2 });
    session.appendBuffered('hello world');
    let drained = false;
    void session.drained().then(() => {
      drained = true;
    });

    boom.on = true;
    // The scheduler wrapper clears the flush cancel before calling in, so the
    // throw itself must leave a timer armed.
    expect(() => frame.fire()).toThrow('engine boom');
    expect(session.length).toBe(0);
    expect(session.snapshot().revision).toBe(0);
    expect(session.pendingLength).toBe(11); // nothing lost, nothing doubled
    expect(idle.pending).toBe(true);

    boom.on = false;
    idle.fire();
    expect(session.length).toBe(11);
    expect(session.snapshot().document.source).toBe('hello world');
    await Promise.resolve();
    expect(drained).toBe(true);
  });

  test('a persistently throwing engine keeps retrying the tail instead of stranding it', async () => {
    const { session, boom, frame, idle } = throwingHarness({
      holdBackChars: 2,
      holdIdleMs: 250,
    });
    session.appendBuffered('hello world');
    let drained = false;
    void session.drained().then(() => {
      drained = true;
    });

    boom.on = true;
    expect(() => frame.fire()).toThrow('engine boom');
    expect(idle.pending).toBe(true);
    // The retry itself throws: a broken engine, such as an unlinked native
    // module, must keep being retried.
    const delays: Array<number | null> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(() => idle.fire()).toThrow('engine boom');
      expect(session.pendingLength).toBe(11); // nothing lost, nothing doubled
      expect(idle.pending).toBe(true);
      delays.push(idle.lastMs);
    }
    // …and it backs off rather than retrying a dead engine every 250ms.
    expect(delays).toEqual([250, 500, 1000, 2000]);

    boom.on = false;
    idle.fire();
    expect(session.snapshot().document.source).toBe('hello world');
    await Promise.resolve();
    expect(drained).toBe(true);
    // A later failure starts the backoff over.
    boom.on = true;
    session.appendBuffered('. more'); // released text with a construct char, so it parses
    expect(() => frame.fire()).toThrow('engine boom');
    expect(() => idle.fire()).toThrow('engine boom');
    expect(idle.lastMs).toBe(250);
  });

  test('a subscriber throwing past the commit still settles the smoother', () => {
    // The commit landed, so the answer was released and must be settled.
    const released: number[] = [];
    const smoother = Object.assign(() => 3, {
      notifyReleased(n: number) {
        released.push(n);
      },
    });
    const { session, frame } = harness({ smoother });
    session.subscribe(() => {
      throw new Error('subscriber boom');
    });
    session.appendBuffered('hello world');
    expect(() => frame.fire()).toThrow('subscriber boom');
    expect(session.length).toBe(3);
    expect(released).toEqual([3]);
  });

  test('an engine that never recovers ends the retries and settles drained()', async () => {
    const { session, boom, frame, idle } = throwingHarness({
      holdBackChars: 2,
      holdIdleMs: 250,
    });
    session.appendBuffered('hello world');
    let settled: string | null = null;
    void session.drained().then(
      () => {
        settled = 'resolved';
      },
      (error: Error) => {
        settled = error.message;
      },
    );

    boom.on = true;
    expect(() => frame.fire()).toThrow('engine boom');
    // Eight refused retries run the backoff ladder out and then stop.
    let retries = 0;
    while (idle.pending && retries < 20) {
      expect(() => idle.fire()).toThrow('engine boom');
      retries += 1;
    }
    expect(retries).toBe(9);
    await Promise.resolve();
    expect(settled).toBe('engine boom');
    // Nothing was dropped to get there…
    expect(session.pendingLength).toBe(11);
    expect(session.length).toBe(0);
    // …a later `drained()` fails fast…
    await expect(session.drained()).rejects.toThrow('engine boom');
    // …and an explicit drain still retries the tail.
    boom.on = false;
    session.flushBuffered();
    expect(session.snapshot().document.source).toBe('hello world');
    await expect(session.drained()).resolves.toBeUndefined();
  });

  test('new buffered input restarts the retry ladder', async () => {
    const { session, boom, frame, idle } = throwingHarness({ holdIdleMs: 100 });
    session.appendBuffered('hello');
    boom.on = true;
    expect(() => frame.fire()).toThrow('engine boom');
    while (idle.pending) {
      expect(() => idle.fire()).toThrow('engine boom');
    }
    await expect(session.drained()).rejects.toThrow('engine boom');
    // A delta is a fresh attempt, so `drained()` parks again.
    session.appendBuffered(' world');
    let settled = false;
    void session.drained().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    boom.on = false;
    frame.fire();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(session.snapshot().document.source).toBe('hello world');
  });

  describe('rewrite after an abandoned drain', () => {
    /** Runs the retry ladder out on `bad.` and brings the engine back. */
    async function abandoned(init: Partial<StreamSessionInit>) {
      const h = throwingHarness({ holdIdleMs: 100, ...init });
      h.session.appendBuffered('bad.');
      h.boom.on = true;
      expect(() => h.frame.fire()).toThrow('engine boom');
      while (h.idle.pending) {
        expect(() => h.idle.fire()).toThrow('engine boom');
      }
      await expect(h.session.drained()).rejects.toThrow('engine boom');
      h.boom.on = false;
      return h;
    }

    /** Settles to a label at once, so a stale rejection fails an assertion
     * instead of surfacing as an unhandled rejection. */
    function settle(promise: Promise<void>): Promise<string> {
      return promise.then(
        () => 'resolved',
        (error: Error) => `rejected: ${error.message}`,
      );
    }

    test('holdBack 0: drained() taken after the rewrite resolves', async () => {
      // A rewrite is a fresh attempt, like a delta.
      const { session, frame } = await abandoned({});
      session.rewrite('good.');
      const result = settle(session.drained());
      frame.fire();
      await expect(result).resolves.toBe('resolved');
      expect(session.snapshot().document.source).toBe('good.');
    });

    test('holdBack 2: drained() resolves across a partial commit', async () => {
      // The flush commits all but the held-back tail.
      const { session, frame, idle } = await abandoned({ holdBackChars: 2 });
      session.rewrite('good stuff.');
      const result = settle(session.drained());
      frame.fire();
      expect(session.snapshot().document.source).toBe('good stuf');
      expect(session.pendingLength).toBe(2);
      let settled: string | null = null;
      void settle(session.drained()).then((label) => {
        settled = label;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBeNull(); // parked on the held tail, not rejected
      idle.fire();
      await expect(result).resolves.toBe('resolved');
      expect(session.snapshot().document.source).toBe('good stuff.');
    });

    test('restarts the retry ladder', async () => {
      const { session, boom, frame, idle } = await abandoned({ holdBackChars: 2 });
      session.rewrite('good stuff.');
      frame.fire();
      boom.on = true;
      expect(() => idle.fire()).toThrow('engine boom');
      expect(idle.pending).toBe(true);
      expect(idle.lastMs).toBe(100);
      const result = settle(session.drained());
      boom.on = false;
      idle.fire();
      await expect(result).resolves.toBe('resolved');
      expect(session.snapshot().document.source).toBe('good stuff.');
    });
  });

  test('a throwing finalize leaves the session exactly as it was', () => {
    const { session, boom } = throwingHarness();
    session.append('one\n\ntwo\n\nthree');
    const before = session.snapshot();
    boom.on = true;
    expect(() => session.finalize('end')).toThrow('engine boom');
    // A throwing parse must restore all of finalize's anchor bookkeeping,
    // not just the phase.
    expect(session.snapshot()).toBe(before);
    expect(session.snapshot().phase).toBe('streaming');
    expect(session.length).toBe(15);
    // …and the session still finalizes normally afterwards.
    boom.on = false;
    session.finalize('end');
    expect(session.snapshot().phase).toBe('settled');
    expect(session.snapshot().document.source).toBe('one\n\ntwo\n\nthree');
  });

  test('a throwing replace leaves the session exactly as it was', () => {
    const { session, boom } = throwingHarness();
    session.append('hello world');
    const before = session.snapshot();
    boom.on = true;
    expect(() => session.replace('totally different text')).toThrow(
      'engine boom',
    );
    // `replace` resets the session before it parses, so a throw must restore
    // `length` too.
    expect(session.length).toBe(11);
    expect(session.snapshot()).toBe(before);
    expect(session.snapshot().document.source).toBe('hello world');
    // …and the session still works on the same terms afterwards.
    boom.on = false;
    session.append(' again');
    expect(session.snapshot().document.source).toBe('hello world again');
    session.replace('totally different text');
    expect(session.snapshot().document.source).toBe('totally different text');
  });

  test('a throwing append leaves length and snapshot in agreement', () => {
    const { session, boom } = throwingHarness();
    session.append('committed.');
    boom.on = true;
    expect(() => session.append(' lost.')).toThrow('engine boom');
    expect(session.length).toBe(10);
    expect(session.snapshot().document.source).toBe('committed.');
    boom.on = false;
    session.append(' kept.');
    expect(session.snapshot().document.source).toBe('committed. kept.');
    expect(session.length).toBe(16);
  });
});

describe('StreamSession.dispose', () => {
  test('cancels both timers and drops the pending tail', () => {
    const { session, frame, idle, seen } = harness({ holdBackChars: 3 });
    session.appendBuffered('Watch this **');
    frame.fire(); // 'Watch this' committed, ' **' held, idle armed
    expect(session.length).toBe(10);
    expect(idle.pending).toBe(true);

    session.dispose();
    expect(idle.pending).toBe(false);
    expect(idle.cancelled).toBe(1);
    expect(session.pendingLength).toBe(0); // dropped, not appended
    expect(session.length).toBe(10);

    // Nothing a stale timer or a late delta can do wakes it up again.
    idle.fire();
    frame.fire();
    session.appendBuffered('more');
    expect(frame.pending).toBe(false);
    expect(session.pendingLength).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test('a smoother cannot keep re-scheduling a disposed session', () => {
    // The flush re-schedules while the smoother withholds text; dispose()
    // is what stops it.
    const { session, frame, counted } = harness({ smoother: () => 2 });
    session.appendBuffered('x'.repeat(40));
    frame.fire();
    frame.fire();
    expect(frame.pending).toBe(true);
    const parses = counted.parses;

    session.dispose();
    expect(frame.pending).toBe(false);
    frame.fire();
    expect(counted.parses).toBe(parses);
    expect(session.length).toBe(4);
  });

  test('resolves outstanding drained() waiters instead of parking them', async () => {
    const { session, frame } = harness({ smoother: () => 2 });
    session.appendBuffered('x'.repeat(40));
    frame.fire();
    let drained = false;
    const wait = session.drained().then(() => {
      drained = true;
    });
    session.dispose();
    await wait;
    expect(drained).toBe(true);
    // And a fresh await after disposal resolves immediately too.
    await session.drained();
  });

  test('flushBuffered() before dispose() keeps the tail instead of dropping it', () => {
    const { session, frame, idle } = harness({ holdBackChars: 3 });
    session.appendBuffered('Keep every char');
    frame.fire();
    expect(session.length).toBe(12);
    session.flushBuffered();
    session.dispose();
    expect(session.length).toBe(15);
    expect(session.snapshot().document.source).toBe('Keep every char');
    expect(idle.pending).toBe(false);
  });
});

test.each(['frame', 'synchronous'] as const)('a subscriber failure after the last %s drain releases waiters', async mode => {
  const { session, frame, idle } = harness();
  session.appendBuffered('ready!');
  const resolved = jest.fn();
  const drained = session.drained().then(resolved);
  session.subscribe(() => { throw new Error('listener failed'); });
  expect(() => mode === 'frame' ? frame.fire() : session.flushBuffered()).toThrow('listener failed');
  await Promise.resolve();
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(session.snapshot().document.source).toBe('ready!');
  expect(session.pendingLength).toBe(0);
  expect(idle.pending).toBe(false);
  session.dispose();
  await drained;
});
