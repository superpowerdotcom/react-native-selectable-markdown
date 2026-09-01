#!/usr/bin/env node
// Cold-parse throughput: parse a concatenated markdown corpus N times and
// report MB/s. Corpus = every CommonMark spec example's markdown plus the
// conformance fixtures, replicated to a workload-sized document.
//
// Usage: node bench/throughput.mjs [--quick] [--iterations N] [--replicas R]
//
// The number to quote from here is MB/s. Both a mean and a best-of-run are
// printed: the mean is what a sustained workload sees, the best is the
// cleanest clock the machine gave us, and a wide gap between them says the
// measurement was taken on a busy or throttling laptop rather than that the
// parser is erratic.

import {
  buildCorpus,
  fmtBytes,
  fmtMs,
  hasFlag,
  loadLibrary,
  measure,
  numberFlag,
  resolveEngine,
  stats,
} from './support.mjs';

const quick = hasFlag('quick');
const iterations = numberFlag('iterations', quick ? 3 : 20);
const replicas = numberFlag('replicas', quick ? 1 : 4);
const warmup = quick ? 1 : 3;

const lib = loadLibrary();
const { parseDocument, presets } = lib;

const engine = await resolveEngine(lib, '[bench:throughput]');
if (!engine) process.exit(0);

const corpus = buildCorpus(replicas);
const bytes = Buffer.byteLength(corpus, 'utf8');
const options = presets.llmChat;

// Timed through parseDocument rather than engine.parse: that is the call the
// app makes, so the extensions hop and the options resolution are inside the
// measurement exactly as they are in production. `.blocks.length` is read in
// the timed region on purpose — it is one property access, and it forces the
// result to be observed so nothing can be optimised away as dead.
const { samples, last } = measure({
  iterations,
  warmup,
  run: () => parseDocument(corpus, options, engine.engine).blocks.length,
});

const s = stats(samples);
const mbPerSecMean = bytes / 1e6 / (s.mean / 1000);
const mbPerSecBest = bytes / 1e6 / (s.min / 1000);

console.log('parse throughput (preset: llmChat)');
console.log(`  corpus:     ${fmtBytes(bytes)} (${corpus.length} UTF-16 units)`);
console.log(`  iterations: ${iterations} (+${warmup} warmup)${quick ? ' [quick]' : ''}`);
console.log(
  `  ${'engine'.padEnd(10)} ${'blocks'.padStart(7)}  ` +
    `${'min'.padStart(9)} ${'mean'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)}  ` +
    `${'MB/s mean'.padStart(10)} ${'MB/s best'.padStart(10)}`,
);
// The `blocks` column is not decoration: it is the one cheap check that the
// corpus was actually parsed. A build that started handing back empty
// documents would post a spectacular MB/s, and this is the column where that
// shows up.
console.log(
  `  ${engine.name.padEnd(10)} ${String(last).padStart(7)}  ` +
    `${fmtMs(s.min).padStart(9)} ${fmtMs(s.mean).padStart(9)} ${fmtMs(s.p95).padStart(9)} ${fmtMs(s.max).padStart(9)}  ` +
    `${mbPerSecMean.toFixed(2).padStart(10)} ${mbPerSecBest.toFixed(2).padStart(10)}`,
);
