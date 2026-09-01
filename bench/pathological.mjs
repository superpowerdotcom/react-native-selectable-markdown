#!/usr/bin/env node
// Pathological-input timing: adversarial documents that punish quadratic
// parsers. Reports per-case wall-clock; with --budget it becomes a DoS
// regression gate (exit 1 when any case exceeds the budget or crashes).
//
// Usage: node bench/pathological.mjs [--quick] [--budget MS] [--runs N]
//
// --budget turns the run into a gate: any case whose median exceeds it, or
// that throws, exits 1. Without it the cases are only reported, because the
// absolute numbers depend on the machine and a bare `npm run bench:*` should
// not fail on a busy laptop.

import {
  deepBlockquoteSource,
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
const { parseDocument, presets } = lib;

const engine = await resolveEngine(lib, '[bench:pathological]');
if (!engine) process.exit(0);

const scale = (full, small) => (quick ? small : full);

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

let anyOver = false;
let anyCrash = false;

console.log(
  `pathological inputs (${runs} run(s) per case${quick ? ', quick' : ''}${
    budgetMs !== undefined ? `, budget ${budgetMs} ms` : ''
  })`,
);

for (const c of cases) {
  const times = [];
  let crash = null;

  // Deliberately no warmup: these inputs are about worst-case cold behaviour,
  // and a warmed-up JIT is not what a DoS attempt meets. The first throw ends
  // the case — the remaining runs would only reproduce it, and the timings
  // collected before it are not comparable to a case that completed.
  for (let i = 0; i < runs && !crash; i += 1) {
    const t0 = performance.now();
    try {
      parseDocument(c.input, c.options, engine.engine);
      times.push(performance.now() - t0);
    } catch (err) {
      crash = err;
    }
  }

  console.log(`  ${c.name.padEnd(30)} ${fmtBytes(Buffer.byteLength(c.input, 'utf8')).padStart(9)}`);

  let status;
  let detail;
  if (crash) {
    anyCrash = true;
    status = 'CRASH';
    detail = String(crash.message || crash).split('\n')[0];
  } else {
    const median = percentile(times, 50);
    const over = budgetMs !== undefined && median > budgetMs;
    if (over) anyOver = true;
    status = over ? 'OVER' : 'ok';
    detail = `median ${fmtMs(median)} (min ${fmtMs(Math.min(...times))}, max ${fmtMs(Math.max(...times))})`;
  }
  console.log(`    ${status.padEnd(5)} ${engine.name.padEnd(10)} ${detail}`);
}

if (budgetMs !== undefined && (anyOver || anyCrash)) {
  console.log('budget exceeded — failing.');
  process.exit(1);
}
if (anyCrash) {
  console.log('note: crashes above are reported but not gating (pass --budget to gate).');
}
