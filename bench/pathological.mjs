#!/usr/bin/env node
// Pathological-input timing: adversarial documents that punish quadratic
// parsers. Reports per-case, per-STAGE wall-clock; with --budget it becomes a
// DoS regression gate (exit 1 when any stage exceeds the budget or crashes).
//
// Usage: node bench/pathological.mjs [--quick] [--runs N] [--require-engine]
//          [--budget MS] [--budget-parse MS] [--budget-repair MS]
//          [--budget-segment MS] [--budget-project MS]
//
// --budget turns the run into a gate: any stage whose median exceeds it, or
// that throws, exits 1. Without it the cases are only reported, because the
// absolute numbers depend on the machine and a bare `npm run bench:*` should
// not fail on a busy laptop.
//
// ONE BUDGET IS THE WRONG SHAPE FOR FOUR STAGES that differ by four orders of
// magnitude. `segment` is tens of microseconds on these inputs and `parse` is
// tens of milliseconds, so a single number loose enough for the parse (CI ran
// 1000 ms) is ~20000x the segment's real cost: that stage could get a hundred
// times slower and still pass. `--budget-<stage>` overrides the global for one
// stage, so each is gated near its own scale and the workflows pass four
// numbers instead of one. The global remains the default for any stage with no
// override, and passing only overrides gates only those stages.
//
// --require-engine turns "the addon did not resolve" from an exit-0 report
// into a failure. A gate that exits 0 having measured nothing is worse than no
// gate, and the likeliest cause here is not a missing compiler but a
// protocol-version drift between the built addon and dist/. Workflows pass it;
// a laptop with no toolchain should not.
//
// WHY THIS TIMES FOUR STAGES AND NOT JUST THE PARSE
// -------------------------------------------------
// md4c is linear on every shape below — that is the whole reason it was
// picked, and it means a parse-only gate is a gate on the one stage that was
// never going to fail. Everything a consumer runs *after* the parse is
// TypeScript over the decoded tree, and none of it is obviously linear:
//
//   parse    md4c + the FlatBuffer decode. The linear one.
//   repair   `repairTail` over the whole input, which is what a stream that
//            never anchors actually hands it (a list, a giant paragraph, an
//            unclosed fence — see docs/BENCHMARKS.md). Its scanners walk the
//            tail per construct, so this is where an adversarial run of
//            emphasis openers costs far more than parsing them.
//   segment  `segmentRuns` over every block: the per-snapshot cost the view
//            pays before anything renders.
//   project  `projectRun` over every run: the per-run cost that produces the
//            text the native hosts actually measure and select. It walks the
//            block tree, so deep nesting is priced here rather than in the
//            parse.
//
// A throw anywhere in the four is a CRASH for that case, and --budget fails on
// it: a `RangeError: Maximum call stack size exceeded` on 3 kB of `> ` is a
// denial of service whatever its runtime, and reporting it as a fast case
// would be the worst possible reading of these numbers.
//
// Streaming is deliberately NOT a stage here. `bench:streaming` owns that
// question and gates it: it replays the pinned never-anchoring transcript
// (conformance/fixtures/transcript-giant-list.json) — the adversarial
// *streaming* shape, in the same way these four are the adversarial *document*
// shapes — and takes the same `--budget`/`--require-engine` flags, so ci.yml
// and release.yml run it in the step next to this one. Until it did, the
// sentence here pointed at a report and called it coverage.
//
// AND WHY THERE IS A SECOND, SCALING SECTION
// ------------------------------------------
// The four cases above are each ONE size, so they price a shape but cannot
// tell a slow linear pass from a fast quadratic one — and a quadratic pass is
// exactly what the repair's unmatched-bracket strip loop used to be. The
// `repair scaling` section below therefore runs one shape at five sizes and
// reports each against a linear control of the same length, because the ratio
// between them is machine-independent in a way wall-clock milliseconds are
// not: a flat ratio column is linear, a doubling one is quadratic, and that
// reading holds on a busy laptop and in CI alike.

import {
  deepBlockquoteSource,
  exitWithoutEngine,
  fmtBytes,
  fmtMs,
  hasFlag,
  loadLibrary,
  manyCellTableSource,
  numberFlag,
  percentile,
  resolveEngine,
} from './support.mjs';

const quick = hasFlag('quick');
const budgetMs = numberFlag('budget', undefined);
const runs = numberFlag('runs', quick ? 1 : 3);

const lib = loadLibrary();
const { parseDocument, presets, projectRun, repairTail, resolveOptions, segmentRuns } = lib;

const engine = await resolveEngine(lib, '[bench:pathological]');
if (!engine) exitWithoutEngine('[bench:pathological]');

const scale = (full, small) => (quick ? small : full);

// The seed `repairTail` gets from a StreamSession whose anchor sits at a clean
// boundary — no open fence, not inside math. Identical to `CLEAN_SEED` in
// src/stream/StreamSession.ts, and the only seed reachable there, because an
// anchor is accepted only with a clean fence/math scan state.
const CLEAN_SEED = { openFence: null, inMath: false };

const cases = [
  {
    name: 'nested brackets',
    input: '['.repeat(scale(10_000, 1_000)) + 'core' + ']'.repeat(scale(10_000, 1_000)),
    options: presets.commonmark,
  },
  {
    name: 'alternating emphasis openers',
    input: '*tick **tock '.repeat(scale(8_000, 800)),
    options: presets.commonmark,
  },
  {
    name: 'deep blockquotes',
    input: deepBlockquoteSource(scale(1_500, 150)),
    options: presets.commonmark,
  },
  {
    name: 'many-cell table',
    input: manyCellTableSource(32, scale(500, 50)),
    options: presets.llmChat,
  },
];

/**
 * The pipeline, split at the seams a consumer actually crosses.
 *
 * Each stage is timed on its own so a regression names the stage it is in;
 * timing the four together would only say "slower". `run` receives the
 * carry-over from the stages before it (the parsed document, then the runs),
 * because re-parsing per stage would price the parse four times.
 */
const STAGES = [
  {
    name: 'parse',
    run: (c, state) => {
      state.doc = parseDocument(c.input, c.options, engine.engine);
    },
  },
  {
    name: 'repair',
    run: (c, state) => {
      repairTail(c.input, CLEAN_SEED, state.resolved, undefined);
    },
  },
  {
    name: 'segment',
    run: (c, state) => {
      state.runs = segmentRuns(state.doc);
    },
  },
  {
    name: 'project',
    run: (c, state) => {
      for (const segment of state.runs) projectRun(segment, state.doc);
    },
  },
];

/**
 * The budget each stage is gated at: `--budget-<stage>` when given, otherwise
 * the global `--budget`, otherwise none (report only).
 *
 * Resolved once, up front, so the header line can print exactly what is being
 * gated — a gate whose thresholds are only visible by reading the source is
 * one nobody re-tunes when the numbers move.
 */
const budgets = new Map(
  STAGES.map((stage) => [stage.name, numberFlag(`budget-${stage.name}`, budgetMs)]),
);
const gating = [...budgets.values()].some((ms) => ms !== undefined);

let anyOver = false;
let anyCrash = false;
// A gate that produced no samples at all (`--runs 0`) is vacuous, which is the
// same failure as `--require-engine` catching an unresolvable addon: green,
// and over nothing. Tracked separately from `anyOver` so the message can say
// which of the two happened.
let anyVacuous = false;

const budgetSummary = gating
  ? `, budgets ${STAGES.map((stage) => {
      const ms = budgets.get(stage.name);
      return `${stage.name} ${ms === undefined ? 'off' : `${ms} ms`}`;
    }).join(', ')}`
  : '';

console.log(`pathological inputs (${runs} run(s) per case${quick ? ', quick' : ''}${budgetSummary})`);

for (const c of cases) {
  console.log(`  ${c.name.padEnd(30)} ${fmtBytes(Buffer.byteLength(c.input, 'utf8')).padStart(9)}`);

  const times = new Map(STAGES.map((s) => [s.name, []]));
  let crash = null;

  // Deliberately no warmup: these inputs are about worst-case cold behaviour,
  // and a warmed-up JIT is not what a DoS attempt meets. The first throw ends
  // the case — the remaining runs would only reproduce it, and the timings
  // collected before it are not comparable to a case that completed. The
  // stage it threw in is kept, because "which stage" is most of the answer.
  for (let i = 0; i < runs && !crash; i += 1) {
    const state = { resolved: resolveOptions(c.options), doc: null, runs: [] };
    for (const stage of STAGES) {
      const t0 = performance.now();
      try {
        stage.run(c, state);
      } catch (err) {
        crash = { stage: stage.name, err };
        break;
      }
      times.get(stage.name).push(performance.now() - t0);
    }
  }

  for (const stage of STAGES) {
    const samples = times.get(stage.name);
    // A stage that threw is a CRASH even when an earlier run of it completed:
    // one input, one throw, and averaging that away is how a gate stops
    // gating.
    if (crash && crash.stage === stage.name) {
      anyCrash = true;
      console.log(
        `    ${'CRASH'.padEnd(5)} ${stage.name.padEnd(8)} ${String(crash.err.message || crash.err).split('\n')[0]}`,
      );
      continue;
    }
    if (samples.length === 0) {
      // Two ways to get here, and `crash` is null in one of them: a stage
      // after the throw was never reached, or `--runs 0` asked for no runs at
      // all. Dereferencing `crash.stage` unconditionally is what made
      // `--runs 0` die with a TypeError instead of reporting.
      if (crash) {
        console.log(`    ${'n/a'.padEnd(5)} ${stage.name.padEnd(8)} not reached — \`${crash.stage}\` threw`);
      } else {
        anyVacuous = true;
        console.log(
          `    ${'none'.padEnd(5)} ${stage.name.padEnd(8)} no samples — \`--runs ${runs}\` asked for none`,
        );
      }
      continue;
    }
    const median = percentile(samples, 50);
    const budget = budgets.get(stage.name);
    const over = budget !== undefined && median > budget;
    if (over) anyOver = true;
    console.log(
      `    ${(over ? 'OVER' : 'ok').padEnd(5)} ${stage.name.padEnd(8)} median ${fmtMs(median)} ` +
        `(min ${fmtMs(Math.min(...samples))}, max ${fmtMs(Math.max(...samples))})` +
        `${budget === undefined ? '' : ` vs ${budget} ms`}`,
    );
  }
}

// ---------------------------------------------------------------------------
// repair scaling: unmatched brackets against a linear control
// ---------------------------------------------------------------------------

/*
 * `'x [ '` repeated is the shape that used to make `repairTail` quadratic: every
 * `[` opens a link candidate that never closes, so the repair ends up with a
 * stack of openers to strip, and stripping them one at a time — each strip
 * rescanning the rest of the tail — is O(brackets * tail). Nothing above would
 * have caught it. `nested brackets` is 10 000 `[` in a row followed by 10 000
 * `]`, which is a different (matched, deeply nested) shape, and it is measured
 * at one size, so a quadratic pass there just reads as "repair is slow on
 * brackets".
 *
 * `'x y '` is the control: identical length, identical word/space rhythm, no
 * construct characters at all. Dividing by it cancels the per-character cost of
 * simply walking the tail, so what is left is the price of the brackets — and
 * that price must not grow with n.
 *
 * HOW TO READ IT. The `xctl` column is how much the brackets cost over the bare
 * walk — tens of times the control, and roughly FLAT across the five sizes when
 * the pass is linear, climbing with each doubling of n when it is not. It is
 * coarse, because the control is microseconds and the clock is not much finer,
 * so the gated number below it divides the bracket cost by n instead. The
 * milliseconds are for scale only: ~1-2 ms at n = 8000 after the fix, ~17 ms
 * before it.
 */

const REPAIR_SCALE_NS = quick ? [500, 1_000, 2_000] : [500, 1_000, 2_000, 4_000, 8_000];
const REPAIR_SCALE_OPTIONS = resolveOptions(presets.commonmark);

/**
 * Median cost of one `repairTail` over the whole tail, in ms.
 *
 * THE WARMUP IS THE ONE PLACE THIS FILE WANTS ONE, and it is not a
 * contradiction of the no-warmup rule above. The four cases up there each
 * report an absolute cost at one size, where cold is the honest number. This
 * section reports a SHAPE across five sizes, and a cold first sample lands
 * entirely on the smallest n — the one every later size is compared against —
 * so an unwarmed run reads as the smallest input being the slowest and says
 * nothing at all about growth.
 *
 * `batch` repeats the call inside the timed region and divides, which is only
 * for the control: at these sizes one pass over 2 kB of `'x y '` costs about as
 * much as `performance.now()` can resolve, and a quantised denominator makes
 * the ratio column wobble by 2x for no reason. The bracket side is milliseconds
 * on its own and is timed one call at a time.
 */
const REPAIR_SCALE_SAMPLES = Math.max(runs, 5);

function medianRepairMs(input, batch = 1) {
  repairTail(input, CLEAN_SEED, REPAIR_SCALE_OPTIONS, undefined);
  const samples = [];
  for (let i = 0; i < REPAIR_SCALE_SAMPLES; i += 1) {
    const t0 = performance.now();
    for (let j = 0; j < batch; j += 1) {
      repairTail(input, CLEAN_SEED, REPAIR_SCALE_OPTIONS, undefined);
    }
    samples.push((performance.now() - t0) / batch);
  }
  return percentile(samples, 50);
}

/** Repeats of the control per timed region — see `medianRepairMs`. */
const CONTROL_BATCH = 32;

console.log('');
console.log(
  `repair scaling: unmatched brackets vs. a linear control ` +
    `(${REPAIR_SCALE_SAMPLES} run(s) per size, after a warmup)`,
);

const perBracket = [];
for (const n of REPAIR_SCALE_NS) {
  const brackets = 'x [ '.repeat(n);
  const control = 'x y '.repeat(n);
  const bracketMs = medianRepairMs(brackets);
  const controlMs = medianRepairMs(control, CONTROL_BATCH);
  // A control fast enough to round to zero would make the ratio meaningless
  // rather than large; report it as unavailable instead of dividing by it.
  const ratio = controlMs > 0 ? bracketMs / controlMs : null;
  perBracket.push({ n, msPerBracket: bracketMs / n });
  // The repair stage's budget, not the global one: this section times
  // `repairTail` and nothing else.
  const repairBudget = budgets.get('repair');
  const over = repairBudget !== undefined && bracketMs > repairBudget;
  if (over) anyOver = true;
  console.log(
    `  ${(over ? 'OVER' : 'ok').padEnd(5)} n=${String(n).padStart(5)} ` +
      `${fmtBytes(Buffer.byteLength(brackets, 'utf8')).padStart(9)}  ` +
      // The control is microseconds at these sizes; `fmtMs` would print
      // every row as `0.00 ms`.
      `brackets ${fmtMs(bracketMs)}  control ${(controlMs * 1000).toFixed(0).padStart(4)} us  ` +
      `xctl ${ratio === null ? '   n/a' : ratio.toFixed(1).padStart(6)}`,
  );
}

// The linearity read, made explicit so nobody has to eyeball the column.
//
// It divides the BRACKET cost by n rather than dividing the ratio column by
// itself, and the difference matters: the control is the smallest quantity on
// the line, so a drift computed from `xctl` inherits all of the control's
// timer noise on top of the signal. Cost per bracket is flat when the pass is
// linear (a constant amount of work per `[`) and grows with n when it is not,
// and it is read off the one column that is comfortably above the clock's
// resolution.
//
// 2.0 is the threshold, against a 16x growth in input from the first size to
// the last: generous enough that JIT warmth and a busy laptop cannot trip it,
// far below the ~16x a restored quadratic loop would show.
const GROWTH_LIMIT = 2;
if (perBracket.length >= 2) {
  const first = perBracket[0];
  const last = perBracket[perBracket.length - 1];
  const growth = last.msPerBracket / first.msPerBracket;
  const grew = growth > GROWTH_LIMIT;
  if (grew) anyOver = true;
  console.log(
    `  ${(grew ? 'OVER' : 'ok').padEnd(5)} cost per bracket ${growth.toFixed(2)}x ` +
      `from n=${first.n} to n=${last.n} (flat ~1.00x is linear; ` +
      `${(last.n / first.n).toFixed(0)}x would be quadratic)`,
  );
}

if (gating && (anyOver || anyCrash || anyVacuous)) {
  console.log(
    anyVacuous && !anyOver && !anyCrash
      ? `no stage produced a sample (--runs ${runs}) — a gate over nothing is a failure.`
      : 'budget exceeded — failing.',
  );
  process.exit(1);
}
if (anyCrash) {
  console.log('note: crashes above are reported but not gating (pass --budget to gate).');
}
