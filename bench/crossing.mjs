#!/usr/bin/env node
// JS<->native boundary cost: what the "one crossing, near-zero copies" claim
// actually costs, split into the two halves that can each be the bottleneck.
//
//   (a) native parse + encode — the raw `parse()` from native/node/index.mjs.
//       md4c's SAX walk, the FlatBuffer.cpp encoder, and the one ArrayBuffer
//       the result is handed back in. This is everything C++ does plus the
//       allocation of the buffer that crosses.
//   (b) JS decode -> AST — decodeFlatBuffer over a PRE-COMPUTED buffer, so
//       nothing native is running inside the measurement. This is the JS half
//       of the protocol: span widening, text slicing, the string table's UTF-8
//       decode, policy. Entities are resolved natively (OffsetParser.cpp), not here.
//   (c) total — the engine's real parse() call, (a) + (b) plus the glue.
//
// Reading it: if (a) dominates, the parser is the bottleneck and a faster
// protocol buys nothing. If (b) dominates, the WIRE FORMAT is the bottleneck
// and the win is in moving work back into C++ (or shrinking the event stream).
// The buffer-to-source ratio is the other half of that story — a fat buffer is
// bytes the decoder has to walk.
//
// End-to-end throughput is deliberately NOT the headline here — that is
// `node bench/throughput.mjs`, which shares this file's corpus builder so the
// two outputs line up on the same bytes. This bench exists to split that one
// number into the halves nobody can otherwise see.
//
// Usage: node bench/crossing.mjs [--quick] [--replicas R] [--iterations N]

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildCorpus,
  deepBlockquoteSource,
  fixtureDir,
  fmtBytes,
  hasFlag,
  loadLibrary,
  loadNativeProtocol,
  manyCellTableSource,
  numberFlag,
  repoRoot,
  resolveEngine,
  stats,
} from './support.mjs';

const quick = hasFlag('quick');
const replicas = numberFlag('replicas', quick ? 1 : 4);

const lib = loadLibrary();
const native = await resolveEngine(lib, '[bench:crossing]');
if (!native) process.exit(0);

const P = loadNativeProtocol();
const { decodeFlatBuffer, resolveOptions, presets } = lib;
const options = resolveOptions(presets.llmChat);
const extBits = P.extensionBits(options);
const htmlPolicy = P.htmlPolicyBit();
const rawParse = native.parse;
const engine = native.engine;

/**
 * Workloads span three orders of magnitude on purpose. The crossing has a
 * fixed per-call cost (argument marshalling, one ArrayBuffer allocation, the
 * 48-byte header) that is invisible at corpus scale and dominant on a
 * streaming append — and the streaming append is the call this library makes
 * most often.
 */
const workloads = [
  {
    name: 'append tail',
    source: 'and then **bold** text with a [link](https://example.com) here.\n',
  },
  {
    name: 'chat reply (fixture)',
    source: readFileSync(path.join(fixtureDir, 'assistant-overview.md'), 'utf8'),
  },
  {
    name: `spec corpus ×${replicas}`,
    source: buildCorpus(replicas),
  },
  // The last two are the shapes `bench:pathological` finds most expensive,
  // and they are here because the per-byte cost it reports for them is not
  // explained by the parse. Both are node-count-bound rather than byte-bound
  // — 1500 nested containers from 3 kB of source, 16,000 cells from 113 kB —
  // which is exactly the condition under which the decode half stops being a
  // rounding error. Without these rows the (a)/(b) split is only ever
  // measured on prose, and a claim about where the time goes on adversarial
  // input would have no committed command behind it.
  //
  // Same generators as `bench:pathological` (support.mjs), so the cold
  // numbers there and the warm split here describe the same bytes. The
  // iteration counts are pinned per workload: the byte-budget heuristic below
  // assumes roughly uniform cost per byte, and these two are the documents
  // that break that assumption in both directions.
  {
    name: 'deep blockquotes (1500 levels)',
    source: deepBlockquoteSource(quick ? 150 : 1_500),
    iterations: quick ? 3 : 400,
  },
  {
    name: 'many-cell table (32 × 500)',
    source: manyCellTableSource(32, quick ? 50 : 500),
    iterations: quick ? 3 : 60,
  },
];

// Iteration count is chosen per workload so every row spends roughly the same
// wall-clock budget: a 64-byte input timed 20 times measures the clock, not
// the code. `--iterations N` pins all rows to N when an exact count matters.
const pinned = numberFlag('iterations', undefined);
const targetBytes = quick ? 4e6 : 4e7;
const MIN_ITERS = quick ? 3 : 20;
const MAX_ITERS = 200_000;

function iterationsFor(bytes, perWorkload) {
  if (pinned !== undefined) return pinned;
  if (perWorkload !== undefined) return perWorkload;
  return Math.min(MAX_ITERS, Math.max(MIN_ITERS, Math.round(targetBytes / bytes)));
}

/** Signed on purpose: the a+b residual below is allowed to come out negative. */
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  const sign = ms < 0 ? '-' : '';
  const m = Math.abs(ms);
  if (m >= 1) return `${sign}${m.toFixed(3)} ms`;
  if (m >= 0.001) return `${sign}${(m * 1000).toFixed(3)} µs`;
  return `${sign}${(m * 1e6).toFixed(0)} ns`;
}

function mbPerSec(bytes, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return NaN;
  return bytes / 1e6 / (ms / 1000);
}

/**
 * What an EMPTY timed region costs on this machine. The `append tail` stages
 * are only a few microseconds each, which is close enough to the clock's own
 * cost that the reader has to be told what it is — otherwise the fixed
 * per-crossing overhead this bench exists to expose could just be
 * performance.now(). Reported, never subtracted: a correction applied
 * silently is a number nobody can check.
 */
function timerFloorMs() {
  const probes = [];
  for (let i = 0; i < 20_000; i += 1) {
    const t0 = performance.now();
    probes.push(performance.now() - t0);
  }
  return stats(probes).mean;
}

const timerFloor = timerFloorMs();

console.log('JS<->native crossing (preset: llmChat)');
console.log(
  `  protocol v${lib.PROTOCOL_VERSION}, addon ${native.addonPath ? path.relative(repoRoot, native.addonPath) : '(unknown path)'}`,
);
console.log(`  node ${process.version} on ${process.platform}/${process.arch}${quick ? ' [quick]' : ''}`);
console.log(`  timer floor: ${fmtDuration(timerFloor)} per timed region (not subtracted below)`);

for (const w of workloads) {
  const bytes = Buffer.byteLength(w.source, 'utf8');
  const iterations = iterationsFor(bytes, w.iterations);
  const warmup = Math.min(1000, Math.max(1, Math.round(iterations / 10)));

  // The buffer stage (b) reads is produced once, before any timing: decoding
  // must not pay for the parse that produced its input. It is reused across
  // every iteration, which is also what happens for real — the decoder always
  // reads a buffer the native side has just written and is therefore hot.
  const buffer = rawParse(w.source, extBits, htmlPolicy);
  const header = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
  const eventCount = header[P.HEADER_EVENT_COUNT];
  const parseOk = (header[P.HEADER_FLAGS] & P.FLAG_PARSE_OK) !== 0;

  // Stages are round-robined inside each iteration, and that ordering is the
  // measurement: over a multi-second run the CPU drifts (turbo, thermals, a
  // background process), and timing all of (a) before any of (b) would charge
  // that drift entirely to whichever stage ran late — baking it straight into
  // the (a)/(b) split, which is the only number this bench exists for.
  const stages = [
    { key: 'a', label: '(a) native parse + encode', run: () => rawParse(w.source, extBits, htmlPolicy) },
    { key: 'b', label: '(b) JS decode -> AST', run: () => decodeFlatBuffer(w.source, buffer, options) },
    { key: 'c', label: '(c) total (engine.parse)', run: () => engine.parse(w.source, options) },
  ];
  const samples = new Map(stages.map((s) => [s.key, []]));

  for (let i = 0; i < warmup; i += 1) {
    for (const s of stages) s.run();
  }
  for (let i = 0; i < iterations; i += 1) {
    for (const s of stages) {
      const t0 = performance.now();
      s.run();
      samples.get(s.key).push(performance.now() - t0);
    }
  }

  const mean = new Map(stages.map((s) => [s.key, stats(samples.get(s.key)).mean]));
  const total = mean.get('c');

  console.log(`  workload: ${w.name} — ${fmtBytes(bytes)} source, ${w.source.length} UTF-16 units`);
  console.log(`    ${iterations} iterations (+${warmup} warmup), stages interleaved a,b,c,a,b,c…`);
  console.log(
    `    ${'stage'.padEnd(26)} ${'mean/call'.padStart(11)} ${'p95/call'.padStart(11)} ` +
      `${'MB/s'.padStart(9)} ${'share'.padStart(7)}`,
  );
  for (const s of stages) {
    const st = stats(samples.get(s.key));
    const share = s.key === 'c' ? 100 : (st.mean / total) * 100;
    console.log(
      `    ${s.label.padEnd(26)} ${fmtDuration(st.mean).padStart(11)} ${fmtDuration(st.p95).padStart(11)} ` +
        `${mbPerSec(bytes, st.mean).toFixed(1).padStart(9)} ${(share.toFixed(1) + '%').padStart(7)}`,
    );
  }

  // (a)+(b) should land within noise of the measured total; the remainder is
  // the engine wrapper. Printing the residual keeps the split honest — a
  // large gap means the two halves are not measuring what (c) actually does.
  // A small NEGATIVE residual is expected, not a bug: (a) and (b) are timed
  // separately and so carry two timer pairs where (c) carries one, which is
  // worth about one timer floor.
  const sum = mean.get('a') + mean.get('b');
  console.log(
    `    a+b ${fmtDuration(sum)} vs measured total ${fmtDuration(total)} (residual ${fmtDuration(total - sum)}, timer floor ${fmtDuration(timerFloor)})`,
  );
  console.log(
    `    buffer: ${fmtBytes(buffer.byteLength)} for ${fmtBytes(bytes)} of source ` +
      `(${(buffer.byteLength / bytes).toFixed(2)}× source), ${eventCount} events, ` +
      `${(buffer.byteLength / Math.max(1, eventCount)).toFixed(1)} B/event, parseOk=${parseOk}`,
  );
  // Decode throughput measured against its OWN input (the buffer) rather than
  // the source, because that is the work it is actually walking.
  console.log(
    `    decode over the wire buffer: ${mbPerSec(buffer.byteLength, mean.get('b')).toFixed(1)} MB/s of buffer`,
  );
}
