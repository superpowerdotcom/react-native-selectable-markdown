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
// `--budget-<stage>` overrides --budget for that stage; passing only overrides
// gates only those stages.
//
// --require-engine fails, instead of exiting 0, when the addon does not resolve.
//
// md4c is linear; the TypeScript stages after it are the ones worth gating.
// Streaming is gated by bench:streaming, not here.

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

// Mirrors CLEAN_SEED in src/stream/StreamSession.ts, the only seed a clean anchor yields.
const CLEAN_SEED = { openFence: null, inMath: false };

const cases = [
  { name: 'decoded entities in one paragraph', input: '中' + '&hellip;'.repeat(scale(65_536, 4096)), options: presets.commonmark },
  { name: 'smart quotes in one paragraph', input: '中' + '"a" '.repeat(scale(131_072, 8192)), options: { ...presets.commonmark, smartPunctuation: true } },
  {
    name: 'less-than prose without a closer',
    input: 'a < '.repeat(scale(12_000, 1_200)),
    options: presets.commonmark,
  },
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

/** Timed one by one; each `run` reads the state earlier stages left, so order matters. */
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

const budgets = new Map(
  STAGES.map((stage) => [stage.name, numberFlag(`budget-${stage.name}`, budgetMs)]),
);
const gating = [...budgets.values()].some((ms) => ms !== undefined);

let anyOver = false;
let anyCrash = false;
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
  // collected before it are not comparable to a case that completed.
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
    // A throw outranks samples from earlier runs.
    if (crash && crash.stage === stage.name) {
      anyCrash = true;
      console.log(
        `    ${'CRASH'.padEnd(5)} ${stage.name.padEnd(8)} ${String(crash.err.message || crash.err).split('\n')[0]}`,
      );
      continue;
    }
    if (samples.length === 0) {
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

// Repair scaling: `'x [ '` (unclosed link openers, once quadratic in `repairTail`)
// against `'x y '`, a same-length control, so the ratio isolates the bracket cost.

const REPAIR_SCALE_NS = quick ? [500, 1_000, 2_000] : [500, 1_000, 2_000, 4_000, 8_000];
const REPAIR_SCALE_OPTIONS = resolveOptions(presets.commonmark);

/**
 * Warmed, unlike the cases above: a cold first sample would skew the smallest n.
 * `batch` averages calls in one timed region for the microsecond-scale control.
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
  const ratio = controlMs > 0 ? bracketMs / controlMs : null;
  perBracket.push({ n, msPerBracket: bracketMs / n });
  const repairBudget = budgets.get('repair');
  const over = repairBudget !== undefined && bracketMs > repairBudget;
  if (over) anyOver = true;
  console.log(
    `  ${(over ? 'OVER' : 'ok').padEnd(5)} n=${String(n).padStart(5)} ` +
      `${fmtBytes(Buffer.byteLength(brackets, 'utf8')).padStart(9)}  ` +
      // Microseconds: `fmtMs` would print every control as `0.00 ms`.
      `brackets ${fmtMs(bracketMs)}  control ${(controlMs * 1000).toFixed(0).padStart(4)} us  ` +
      `xctl ${ratio === null ? '   n/a' : ratio.toFixed(1).padStart(6)}`,
  );
}

// Per-bracket cost, not `xctl`: the control's timer noise would swamp the drift.
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
