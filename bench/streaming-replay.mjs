#!/usr/bin/env node
// Streaming replay: feed a recorded delta transcript through a StreamSession
// and report per-chunk latency (p50/p95/p99) plus how many nodes changed
// identity per chunk — the number that predicts React re-render cost, since
// settled content is supposed to keep referential identity.
//
// Also reports the two incremental-parsing numbers:
//   - parse-input size: how many characters the engine actually read per
//     append (tail-only reparse means this tracks the unsettled tail, not
//     the accumulated document; construct-free appends skip the engine);
//   - incremental-vs-full reparse ratio: total streamed append time versus
//     what a naive reparse-on-every-token renderer would pay.
//
// Per-chunk cost is the library's actual differentiator, and it has to hold up
// on the engine that ships: a parser that is fast cold can still lose here if
// the JS<->native crossing dominates a 20-character append (see
// bench/crossing.mjs). That is the pairing to read this file with.
//
// Usage: node bench/streaming-replay.mjs [--quick] [--transcript PATH]
//        [--repeat N] [--max-chunks N] [--replicas N]
//
// --replicas N streams the transcript N times back-to-back (separated by a
// blank-line delta) as ONE growing session: the naive baseline's cost grows
// with the accumulated document while tail-only parsing stays flat, so the
// ratio shrinks as the stream gets longer.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  fixtureDir,
  fmtMs,
  hasFlag,
  loadLibrary,
  numberFlag,
  flagValue,
  resolveEngine,
  stats,
} from './support.mjs';

const quick = hasFlag('quick');
const transcriptPath = path.resolve(
  flagValue('transcript', path.join(fixtureDir, 'transcript-sprint-review.json')),
);
const repeat = numberFlag('repeat', quick ? 1 : 3);
const maxChunks = numberFlag('max-chunks', quick ? 150 : Infinity);

const lib = loadLibrary();
const { StreamSession, parseDocument, presets, visit } = lib;

const engine = await resolveEngine(lib, '[bench:streaming]');
if (!engine) process.exit(0);

// StreamSession gets its own probe on top of the engine probe resolveEngine
// already did: a session that cannot take even one character is a different
// (and more interesting) failure than a slow one, and it exercises code the
// plain parse never touches — the splice path calls the engine itself.
try {
  const probe = new StreamSession({ engine: engine.engine, options: presets.llmChat });
  probe.append('a');
  probe.finalize();
} catch (err) {
  console.log(`[bench:streaming] StreamSession unavailable (${err.message}) — nothing to measure yet.`);
  process.exit(0);
}

const replicas = numberFlag('replicas', 1);
const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
const baseDeltas = transcript.deltas.slice(0, maxChunks);
const deltas = [];
for (let i = 0; i < replicas; i++) {
  if (i > 0) deltas.push('\n\n');
  deltas.push(...baseDeltas);
}

function collectNodes(doc) {
  const seen = new Set();
  visit(doc, (n) => {
    seen.add(n);
  });
  return seen;
}

const out = {
  chunkTimes: [],
  changedCounts: [],
  // Parse-input sizes for the LAST replay: appends only (finalize's single
  // full clean parse is reported separately).
  parseInputs: [],
  finalizeInput: 0,
  finalizeMs: 0,
  totalMs: 0,
  finalSnapshot: null,
};

/**
 * One full replay of the transcript through a fresh session, timing each
 * append. The engine is wrapped so the bench can see how many characters the
 * splice actually handed the parser — that count, not the accumulated
 * document length, is what tail-only reparse is supposed to keep small.
 */
function replay(record) {
  const inputs = [];
  const recordingEngine = {
    name: `recording(${engine.name})`,
    parse(source, options) {
      inputs.push(source.length);
      return engine.engine.parse(source, options);
    },
  };
  const session = new StreamSession({
    engine: recordingEngine,
    options: presets.llmChat,
  });
  let previousNodes = new Set();
  const runStart = performance.now();

  for (const delta of deltas) {
    const t0 = performance.now();
    session.append(delta);
    const ms = performance.now() - t0;

    const doc = session.snapshot().document;
    const nodes = collectNodes(doc);
    let changed = 0;
    for (const node of nodes) {
      if (!previousNodes.has(node)) changed += 1;
    }
    previousNodes = nodes;
    if (record) {
      out.chunkTimes.push(ms);
      out.changedCounts.push(changed);
    }
  }

  const appendInputs = inputs.slice();
  const f0 = performance.now();
  session.finalize('end');
  const finalizeMs = performance.now() - f0;
  if (record) {
    out.parseInputs = appendInputs;
    out.finalizeMs = finalizeMs;
    out.totalMs = performance.now() - runStart;
    out.finalSnapshot = session.snapshot();
    out.finalizeInput = inputs.length > appendInputs.length ? inputs[inputs.length - 1] : 0;
  }
}

// Warmup replay (untimed) so the session path is JIT-compiled before
// measurement, matching the warmup the naive-baseline loop gets below.
replay(false);

for (let r = 0; r < repeat; r += 1) replay(true);

const totalChars = deltas.reduce((acc, d) => acc + d.length, 0);
const effectiveAppends = deltas.filter((d) => d.length > 0).length;

// Resolved once, outside every timed region: reading it out of the snapshot
// inside the loop would put a property walk inside the measurement.
const finalSource = out.finalSnapshot ? out.finalSnapshot.document.source : deltas.join('');

// Incremental-vs-full reparse ratio: total streamed append time versus what a
// naive reparse-on-every-token renderer would pay (chunks × full reparse of
// the final document). Lower is better; 1.0 means no win over naive reparse.
// With tail-only reparse + the construct-free fast path this should sit far
// below 1 and shrink as documents grow. The baseline is measured with the
// SAME engine the streamed numbers came from, so what the ratio isolates is
// the incremental strategy and nothing else — a naive loop timed on some
// other parser would just be a parser comparison wearing a different name.
const fullRuns = quick ? 3 : 10;
const fullTimes = [];
parseDocument(finalSource, presets.llmChat, engine.engine); // warmup
for (let i = 0; i < fullRuns; i += 1) {
  const t0 = performance.now();
  parseDocument(finalSource, presets.llmChat, engine.engine);
  fullTimes.push(performance.now() - t0);
}

const replicaNote = replicas > 1 ? ` × ${replicas} replicas` : '';
console.log(`streaming replay: ${transcript.name ?? path.basename(transcriptPath)}${replicaNote}`);
console.log(`  chunks:    ${deltas.length} (${totalChars} UTF-16 units), ${repeat} replay(s)${quick ? ' [quick]' : ''}`);

const t = stats(out.chunkTimes);
const c = stats(out.changedCounts);
const fullMs = stats(fullTimes).p50;
const streamedAppendMs = out.chunkTimes.reduce((acc, ms) => acc + ms, 0) / repeat;
const naiveMs = fullMs * deltas.length;
const reparseRatio = naiveMs > 0 ? streamedAppendMs / naiveMs : NaN;

console.log(`  engine: ${engine.name}`);
console.log(`    ms/chunk:  p50 ${fmtMs(t.p50)} | p95 ${fmtMs(t.p95)} | p99 ${fmtMs(t.p99)} | max ${fmtMs(t.max)}`);
console.log(
  `    changed-identity nodes/chunk: p50 ${c.p50} | p95 ${c.p95} | p99 ${c.p99} | max ${c.max} | mean ${c.mean.toFixed(1)}`,
);
console.log(`    last replay: ${fmtMs(out.totalMs)} total, finalize ${fmtMs(out.finalizeMs)}`);
if (out.parseInputs.length > 0) {
  const pi = stats(out.parseInputs);
  const fastPathAppends = effectiveAppends - out.parseInputs.length;
  console.log(
    `    parse input/append: mean ${pi.mean.toFixed(0)} | p95 ${pi.p95} | max ${pi.max} of ${finalSource.length} final chars (max/full = ${(pi.max / finalSource.length).toFixed(3)})`,
  );
  console.log(
    `    engine calls: ${out.parseInputs.length}/${effectiveAppends} appends (${fastPathAppends} construct-free appends skipped the engine); finalize parsed ${out.finalizeInput} chars once`,
  );
}
console.log(
  `    incremental-vs-full reparse ratio: ${reparseRatio.toFixed(3)} (streamed ${fmtMs(streamedAppendMs)} vs naive ${deltas.length} × ${fmtMs(fullMs)} = ${fmtMs(naiveMs)}; lower is better)`,
);
if (out.finalSnapshot) {
  console.log(
    `    final: phase=${out.finalSnapshot.phase}, blocks=${out.finalSnapshot.document.blocks.length}, settledUntil=${out.finalSnapshot.settledUntil}/${out.finalSnapshot.document.source.length}`,
  );
}
