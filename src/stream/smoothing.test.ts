import {
  createAdaptiveSmoother,
  createSmoother,
  snapPastLinkDestination,
  type AdaptiveSmootherOptions,
  type SmootherContext,
} from './smoothing';

// ---------------------------------------------------------------------------
// createSmoother: the rate policy in isolation, on an injected clock. How the
// session applies a smoother's answers (clamping, surrogate safety, flush
// re-scheduling, the synchronous-scheduler fallback) is covered in
// buffering.test.ts alongside the rest of the flush machinery.
// ---------------------------------------------------------------------------

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    tick(ms: number) {
      t += ms;
    },
  };
}

describe('createSmoother', () => {
  test('char mode: budget accrues with elapsed time and carries fractions', () => {
    const c = clock();
    const smooth = createSmoother({ charsPerSecond: 500, now: c.now });
    expect(smooth('abcdef')).toBe(0); // first call: no elapsed time yet
    c.tick(10); // 5 chars accrued
    expect(smooth('abcdef')).toBe(5);
    c.tick(1); // 0.5 — floors to 0, fraction carries
    expect(smooth('f')).toBe(0);
    c.tick(1); // 1.0
    expect(smooth('f')).toBe(1);
  });

  test('release never exceeds the releasable text and spends only what it took', () => {
    const c = clock();
    const smooth = createSmoother({ charsPerSecond: 1000, now: c.now });
    smooth(''); // start the clock
    c.tick(10); // 10 chars accrued
    expect(smooth('ab')).toBe(2);
    // The unreleased 8 chars of budget stand for the next call.
    expect(smooth('abcdefghij')).toBe(8);
  });

  test('a stall credits at most the cap: a burst after silence types, not dumps', () => {
    const c = clock();
    const smooth = createSmoother({ charsPerSecond: 1000, now: c.now });
    smooth('x'); // start the clock
    c.tick(5000); // 5s stall would be 5000 chars; the cap credits 100ms worth
    expect(smooth('y'.repeat(300))).toBe(100);
  });

  test('word mode cuts after the last whitespace inside the budget', () => {
    const c = clock();
    const smooth = createSmoother({
      charsPerSecond: 1000,
      boundary: 'word',
      now: c.now,
    });
    smooth(''); // start the clock
    c.tick(7); // budget 7: window "hello w" — cut after "hello "
    expect(smooth('hello world')).toBe(6);
    c.tick(3); // budget 4: window "worl" has no whitespace — overdraw "world"
    expect(smooth('world')).toBe(5);
  });

  test('word mode overdraws a long word, then pauses while the debt repays', () => {
    const c = clock();
    const smooth = createSmoother({
      charsPerSecond: 100,
      boundary: 'word',
      now: c.now,
    });
    smooth(''); // start the clock
    c.tick(20); // budget 2 — window "ex" has no whitespace
    expect(smooth('extraordinary tail')).toBe(14); // "extraordinary " at once
    c.tick(100); // +10 against a -12 debt: still no budget
    expect(smooth('tail')).toBe(0);
    c.tick(30); // debt cleared, budget 1 — overdraw the last word
    expect(smooth('tail')).toBe(4);
  });

  test('word mode with budget covering everything releases mid-word', () => {
    const c = clock();
    const smooth = createSmoother({
      charsPerSecond: 1000,
      boundary: 'word',
      now: c.now,
    });
    smooth(''); // start the clock
    c.tick(100);
    expect(smooth('unbroken')).toBe(8);
  });

  test('maxLagChars snaps the backlog for free — catch-up incurs no debt', () => {
    const c = clock();
    const smooth = createSmoother({
      charsPerSecond: 100,
      maxLagChars: 10,
      now: c.now,
    });
    smooth('x');
    c.tick(10); // budget 1, backlog 50: snap to 10 behind
    expect(smooth('y'.repeat(50))).toBe(40);
    c.tick(10); // the snap charged only the budgeted 1, so this is a clean 1
    expect(smooth('y'.repeat(10))).toBe(1);
  });

  test('rejects a non-positive rate and a negative lag bound', () => {
    expect(() => createSmoother({ charsPerSecond: 0 })).toThrow();
    expect(() => createSmoother({ charsPerSecond: -5 })).toThrow();
    expect(() => createSmoother({ charsPerSecond: NaN })).toThrow();
    expect(() =>
      createSmoother({ charsPerSecond: 10, maxLagChars: -1 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createAdaptiveSmoother: the ported stream-pacer policy, driven directly
// with scripted (releasable, context) sequences on explicit context times.
// The clock injected via options is a tripwire: every context-carrying call
// must prefer context.now, so consulting options.now at all is a failure.
// ---------------------------------------------------------------------------

const ctxAt = (
  now: number,
  sourceLength: number,
  pendingLength: number,
): SmootherContext => ({ now, sourceLength, pendingLength });

/** Adaptive instance whose fallback clock throws — context.now must win. */
function strictAdaptive(options?: AdaptiveSmootherOptions) {
  return createAdaptiveSmoother({
    ...options,
    now: () => {
      throw new Error('options.now consulted despite context.now');
    },
  });
}

/**
 * Arrival-primed instance: two empty-offer samples 300ms apart, with totals
 * growing at `cps`, make `arrivalRate` measure exactly `cps` when probed with
 * a total continuing at that rate. `cps: 0` (flat totals) yields a zero
 * arrival estimate, which the clamp floors to MIN_RATE_CPS = 40 — handy for
 * forcing small, exact budget steps.
 */
function primed(cps: number, options?: AdaptiveSmootherOptions) {
  const smooth = strictAdaptive(options);
  smooth('', ctxAt(0, 1000, 0));
  smooth('', ctxAt(300, 1000 + cps * 0.3, 0));
  return {
    smooth,
    probe(offered: string, at = 400) {
      const total = 1000 + cps * (at / 1000);
      return smooth(
        offered,
        ctxAt(at, total - offered.length, offered.length),
      );
    },
  };
}

describe('createAdaptiveSmoother pre-buffer gate', () => {
  test('holds until 40 chars of total arrived, then releases', () => {
    const smooth = strictAdaptive();
    expect(smooth('hi', ctxAt(0, 0, 2))).toBe(0);
    expect(smooth('hi there', ctxAt(100, 0, 8))).toBe(0);
    // 45 total: gate opens. Rate window is still under its minimum span, so
    // the fallback 180cps applies; 45 releasable is under the low-lag ratio
    // → ease-off: round(180 * 0.75 * 0.1) = 14.
    expect(smooth('x'.repeat(45), ctxAt(200, 0, 45))).toBe(14);
  });

  test('opens by timeout for a slow trickle', () => {
    const smooth = strictAdaptive();
    expect(smooth('ten chars.', ctxAt(0, 0, 10))).toBe(0);
    expect(smooth('ten chars.', ctxAt(100, 0, 10))).toBe(0);
    expect(smooth('ten chars.', ctxAt(200, 0, 10))).toBe(0);
    // 300ms after the first nonzero-total sample the wait cap opens the
    // gate. Flat totals → arrival 0 → floor 40cps → step 4 ("ten " has its
    // whitespace at index 3, behind the cut, so no snap).
    expect(smooth('ten chars.', ctxAt(300, 0, 10))).toBe(4);
  });
});

describe('createAdaptiveSmoother steady pacing', () => {
  test('tracks the arrival rate with a bounded lag and drains after the stream stops', () => {
    const smooth = strictAdaptive();
    const chunkLen = 20; // 20 chars per 100ms = 200cps
    let total = 0;
    let released = 0;
    const releases: number[] = [];

    for (let step = 1; step <= 40; step += 1) {
      const now = step * 100;
      total += chunkLen;
      const offered = total - released;
      const take = smooth('x'.repeat(offered), ctxAt(now, released, offered));
      expect(Number.isFinite(take)).toBe(true);
      expect(take).toBeGreaterThanOrEqual(0);
      expect(take).toBeLessThanOrEqual(offered);
      // Never faster than the rate ceiling allows per 100ms tick.
      expect(take).toBeLessThanOrEqual(70);
      released += take;
      releases.push(take);
      if (step >= 10) {
        const backlog = total - released;
        expect(backlog).toBeGreaterThan(20);
        expect(backlog).toBeLessThan(150);
      }
    }

    // Steady state releases ≈ the 200cps arrival per 100ms call.
    const steady = releases.slice(9);
    const average = steady.reduce((sum, n) => sum + n, 0) / steady.length;
    expect(average).toBeGreaterThan(16);
    expect(average).toBeLessThan(25);

    // Arrivals stop; calls alone must drain the backlog (rate decays through
    // the stall, floored at 40cps — never a stutter, never a freeze).
    let now = 4000;
    for (let i = 0; i < 40 && released < total; i += 1) {
      now += 100;
      const offered = total - released;
      const take = smooth('x'.repeat(offered), ctxAt(now, released, offered));
      expect(take).toBeGreaterThan(0);
      released += take;
    }
    expect(released).toBe(total);
  });

  test('catch-up above the high lag ratio, ease-off below the low one', () => {
    // Arrival 150cps → target lag 60 chars; thresholds at 75 and 48.
    expect(primed(150).probe('x'.repeat(200))).toBe(20); // 150·1.3 → 19.5 → 20
    expect(primed(150).probe('x'.repeat(60))).toBe(15); // in the dead zone
    expect(primed(150).probe('x'.repeat(30))).toBe(11); // 150·0.75 → 11.25 → 11
  });

  test('rate clamps to [40, 700] cps', () => {
    // 2000cps · 1.3 catch-up = 2600 → ceiling 700 → 70/100ms.
    expect(primed(2000).probe('x'.repeat(1000))).toBe(70);
    // Flat arrival, tiny backlog: 0 · 0.75 = 0 → floor 40 → 4/100ms.
    expect(primed(0).probe('x'.repeat(10))).toBe(4);
  });

  test('a bulk rewrite jumps to the head instead of replaying', () => {
    const smooth = strictAdaptive();
    expect(smooth('x'.repeat(3500), ctxAt(0, 0, 3500))).toBe(Infinity);
  });
});

describe('createAdaptiveSmoother timer suspension', () => {
  test('a late flush with text left pending catches up in one commit', () => {
    const smooth = strictAdaptive();
    // Fallback 180cps, catch-up: round(180·1.3·0.1) = 23 — leaves a backlog.
    expect(smooth('x'.repeat(500), ctxAt(0, 0, 500))).toBe(23);
    // The next flush fires 2s late — the app was backgrounded mid-release.
    expect(smooth('x'.repeat(477), ctxAt(2000, 23, 477))).toBe(Infinity);
    // …and pacing resumes normally afterwards (state fully reset).
    const after = smooth('x'.repeat(20), ctxAt(2100, 500, 20));
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(0);
  });

  test('a fresh burst after an idle, fully-drained stretch types instead of dumping', () => {
    const smooth = strictAdaptive();
    // Fully drained: the last answer released everything it was offered.
    expect(smooth('', ctxAt(0, 50, 0))).toBe(0);
    // 2s of idle, then a new burst: sleep, not suspension — the gap credits
    // one nominal tick, not two seconds of budget.
    const take = smooth('x'.repeat(500), ctxAt(2000, 50, 500));
    expect(Number.isFinite(take)).toBe(true);
    expect(take).toBe(33); // 250cps window estimate · 1.3 · 100ms
  });
});

describe('createAdaptiveSmoother run-end drain', () => {
  test('a short tail releases instantly', () => {
    const smooth = strictAdaptive();
    expect(smooth('x'.repeat(130), ctxAt(0, 0, 130))).toBe(23);
    smooth.notifyRunFinalized(100);
    expect(smooth('x'.repeat(107), ctxAt(100, 23, 107))).toBe(Infinity);
  });

  test('a large tail drains across several flushes and meets the deadline', () => {
    const smooth = strictAdaptive();
    expect(smooth('', ctxAt(0, 0, 2500))).toBe(0); // gate opens, nothing releasable yet
    smooth.notifyRunFinalized(0);

    let released = 0;
    let now = 0;
    let calls = 0;
    while (released < 2500 && calls < 30) {
      now += 100;
      calls += 1;
      const remaining = 2500 - released;
      const take = smooth('x'.repeat(remaining), ctxAt(now, released, remaining));
      released += Number.isFinite(take) ? take : remaining;
    }
    expect(released).toBe(2500);
    expect(now).toBeLessThanOrEqual(1200); // DRAIN_MAX_MS
    expect(calls).toBeGreaterThan(5); // …but streamed, not flashed
  });

  test('the drain arrival term is capped, the deadline term is not', () => {
    // A one-burst answer leaves a 5000cps estimate; 3× that must clamp to
    // 700cps or the drain is a flash: round(700·0.1) = 70.
    const fast = primed(5000);
    fast.smooth.notifyRunFinalized(300);
    expect(fast.probe('x'.repeat(400))).toBe(70);
    // Past the deadline the bound wins outright.
    expect(fast.probe('x'.repeat(300), 1600)).toBe(Infinity);
  });
});

describe('createAdaptiveSmoother word snap and grapheme safety', () => {
  test('completes the word when a whitespace is within the lookahead', () => {
    // Flat arrival → floor 40cps → budget cut at 4, mid-"hello"; the
    // whitespace at index 5 is in reach, and the cut lands ON it.
    expect(primed(0).probe('hello world foo')).toBe(5);
  });

  test('accepts a mid-word cut when no boundary is within the lookahead', () => {
    expect(primed(0).probe('abcdefghijklmnop qrs')).toBe(4);
  });

  test('never splits a surrogate pair', () => {
    // dt 75ms at the floored 40cps → budget cut at 3, between the halves of
    // the emoji — the snap moves it past the pair.
    const text = 'ab😀cd';
    const cut = primed(0).probe(text, 375);
    expect(cut).toBe(4);
    expect(text.slice(0, cut)).toBe('ab😀');
  });

  test('never cuts inside a zero-width-joiner emoji sequence', () => {
    const family = '👨‍👩‍👧';
    // dt 50ms at the floored 40cps → budget cut at 2 — the ZWJ walk carries
    // the cut through the whole sequence.
    expect(primed(0).probe(family, 350)).toBe(family.length);
  });

  test('never splits a variation selector or skin-tone modifier off its base', () => {
    // '❤️‍🔥' = U+2764 U+FE0F U+200D U+1F525: a budget cut at 1 lands
    // between the base and its VS16 — no ZWJ on either side, so only the
    // extender step carries the walk into (and then through) the joiner
    // chain. dt 25ms at the floored 40cps → budget 1.
    const heart = '\u2764\uFE0F\u200D\u{1F525}';
    expect(primed(0).probe(`${heart}abcdefghijkl`, 325)).toBe(heart.length);
    // '👩🏽‍🚀': the cut between 👩 and 🏽 splits base from modifier the
    // same way. dt 50ms → budget 2.
    const astronaut = '\u{1F469}\u{1F3FD}\u200D\u{1F680}';
    expect(primed(0).probe(`${astronaut}abcdefghijkl`, 350)).toBe(
      astronaut.length,
    );
  });
});

describe('createAdaptiveSmoother without context', () => {
  test('gates on the releasable length and meters at the fallback rate', () => {
    const c = clock();
    const smooth = createAdaptiveSmoother({ now: c.now });
    // No ingress signal: the gate reads the offered length (5 < 40)…
    expect(smooth('short')).toBe(0);
    c.tick(300);
    // …and opens by timeout; the budget covers the whole trickle.
    expect(smooth('short')).toBe(5);
  });

  test('a large context-less offer releases at the fallback rate', () => {
    const c = clock();
    const smooth = createAdaptiveSmoother({ now: c.now });
    // First call bootstraps one nominal 100ms tick; no samples → fallback
    // 180cps, catch-up: round(180·1.3·0.1) = 23.
    expect(smooth('x'.repeat(100))).toBe(23);
  });

  test('works on the default clock with no options at all', () => {
    const smooth = createAdaptiveSmoother();
    // The first call never consults elapsed time (nominal-tick bootstrap),
    // so this is deterministic even on Date.now.
    expect(smooth('x'.repeat(100))).toBe(23);
    expect(() => smooth.notifyRunFinalized()).not.toThrow();
  });
});

describe('createAdaptiveSmoother tuning options', () => {
  test('preBufferMinChars lowers the arrival gate', () => {
    const smooth = strictAdaptive({ preBufferMinChars: 10 });
    // 12 total ≥ 10 opens the gate on the first call (default 40 holds);
    // the fallback-rate budget covers the whole trickle.
    expect(smooth('x'.repeat(12), ctxAt(0, 0, 12))).toBe(12);
  });

  test('preBufferMaxWaitMs shortens the timeout open', () => {
    const smooth = strictAdaptive({ preBufferMaxWaitMs: 150 });
    expect(smooth('ten chars.', ctxAt(0, 0, 10))).toBe(0);
    // 150ms after first content the gate opens (the default 300 would still
    // hold); span under the rate minimum → fallback 180cps covers all 10.
    expect(smooth('ten chars.', ctxAt(150, 0, 10))).toBe(10);
  });

  test('targetLagMs shifts the catch-up band', () => {
    // 200cps arrival: an 80-char backlog sits INSIDE the default 400ms lag
    // band (target 80 chars → neutral rate, step 20) but ABOVE a 250ms one
    // (target 50, high ratio 62.5 → catch-up ×1.3, step 26).
    expect(primed(200).probe('x'.repeat(80))).toBe(20);
    expect(primed(200, { targetLagMs: 250 }).probe('x'.repeat(80))).toBe(26);
  });

  test('drainInstantChars widens the flash-in threshold', () => {
    const paced = primed(200);
    paced.smooth.notifyRunFinalized(300);
    // 180 releasable > default 120: the drain paces.
    expect(Number.isFinite(paced.probe('x'.repeat(180)))).toBe(true);
    const instant = primed(200, { drainInstantChars: 200 });
    instant.smooth.notifyRunFinalized(300);
    expect(instant.probe('x'.repeat(180))).toBe(Infinity);
  });

  test('drainMaxMs tightens the drain deadline', () => {
    const fast = primed(200, { drainMaxMs: 400 });
    fast.smooth.notifyRunFinalized(300);
    // Deadline 700: at t=400 the 300-char tail must beat 300ms — the
    // deadline term (1000cps) outruns the capped arrival term.
    expect(fast.probe('x'.repeat(300))).toBe(100);
    // Past the deadline the bound wins outright.
    expect(fast.probe('x'.repeat(200), 800)).toBe(Infinity);
  });

  test('rate clamp overrides bound the release', () => {
    // One-burst 5000cps estimate: the drain's arrival term clamps at the
    // tuned ceiling 900 instead of 700 → round(900·0.1) = 90.
    const fast = primed(5000, { maxRateCps: 900 });
    fast.smooth.notifyRunFinalized(300);
    expect(fast.probe('x'.repeat(400))).toBe(90);
    // Flat arrival floors at the tuned 80cps instead of 40: budget 8, and
    // the word snap carries the cut to the space at index 11.
    expect(primed(0, { minRateCps: 80 }).probe('hello world foo')).toBe(11);
  });

  test('rejects non-positive or non-finite overrides', () => {
    expect(() => createAdaptiveSmoother({ targetLagMs: 0 })).toThrow(
      /targetLagMs/,
    );
    expect(() =>
      createAdaptiveSmoother({ preBufferMinChars: Number.NaN }),
    ).toThrow(/preBufferMinChars/);
    expect(() => createAdaptiveSmoother({ drainMaxMs: -5 })).toThrow(
      /drainMaxMs/,
    );
  });
});

// ---------------------------------------------------------------------------
// snapPastLinkDestination: the pure cut-adjuster. How the session applies it
// (committed-tail context, zero-budget snaps, composition with the smoother)
// is covered in buffering.test.ts.
// ---------------------------------------------------------------------------

describe('snapPastLinkDestination', () => {
  const text =
    'Your [ApoB](fhir://Observation/0198c3f5-1111-2222-3333-444455556666) is high.';
  const closeBracket = text.indexOf(']');
  const endParen = text.indexOf(')');

  test('leaves a cut inside the label alone — labels paint as they stream', () => {
    const midLabel = text.indexOf('poB');
    expect(snapPastLinkDestination(text, midLabel)).toBe(midLabel);
  });

  test('snaps a cut inside a completed destination past the )', () => {
    expect(snapPastLinkDestination(text, closeBracket)).toBe(endParen + 1);
    expect(snapPastLinkDestination(text, text.indexOf('Observation'))).toBe(
      endParen + 1,
    );
    expect(snapPastLinkDestination(text, endParen)).toBe(endParen + 1);
  });

  test('waits while the ) has not been buffered yet', () => {
    const open = text.slice(0, endParen); // destination still streaming
    const midHref = open.indexOf('Observation');
    expect(snapPastLinkDestination(open, midHref)).toBe(midHref);
  });

  test('leaves a cut past a completed link alone', () => {
    expect(snapPastLinkDestination(text, endParen + 1)).toBe(endParen + 1);
    expect(snapPastLinkDestination(text, text.indexOf('high'))).toBe(
      text.indexOf('high'),
    );
  });

  test('a URI-like label paints by default and skips under the option', () => {
    const uri = 'see [fhir://Obs/abc](fhir://Obs/abc) now';
    const open = uri.indexOf('[');
    const close = uri.indexOf(')');
    const closeBr = uri.indexOf(']');
    // Default: under this library's tail repair the label is visible, so a
    // cut inside it must not jump — only the destination snaps.
    expect(snapPastLinkDestination(uri, open + 5)).toBe(open + 5);
    expect(snapPastLinkDestination(uri, closeBr)).toBe(close + 1);
    // Opted in (a consumer pipeline that renders URI-labelled links as a
    // marker only): the whole construct is invisible once its `[` streamed.
    expect(
      snapPastLinkDestination(uri, open + 5, { skipUriLikeLabels: true }),
    ).toBe(close + 1);
  });

  test('never snaps an escaped bracket or a closed non-link bracket', () => {
    const escaped = 'literal \\[not](a-link) text';
    const inside = escaped.indexOf('a-link');
    expect(snapPastLinkDestination(escaped, inside)).toBe(inside);

    const note = 'see [note] more prose here';
    const after = note.indexOf('prose');
    expect(snapPastLinkDestination(note, after)).toBe(after);
  });

  test('is inert at the boundaries', () => {
    expect(snapPastLinkDestination(text, 0)).toBe(0);
    expect(snapPastLinkDestination(text, text.length)).toBe(text.length);
  });
});
