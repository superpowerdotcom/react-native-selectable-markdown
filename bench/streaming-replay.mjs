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
//   - incremental-vs-full reparse ratio: the streamed path against a naive
//     reparse-on-every-token renderer, both the median of per-replay totals.
//
// Two transcripts by default: sprint-review anchors constantly; giant-list is one
// bullet list that never anchors, so every append reparses the whole text.
// `--transcript PATH` narrows the run to one file.
//
// Per-chunk cost is the library's actual differentiator, and it has to hold up
// on the engine that ships: a parser that is fast cold can still lose here if
// the JS<->native crossing dominates a 20-character append (see
// bench/crossing.mjs). That is the pairing to read this file with.
//
// Usage: node bench/streaming-replay.mjs [--quick] [--transcript PATH]
//        [--repeat N] [--max-chunks N] [--replicas N] [--require-engine]
//        [--budget MS] [--budget-chunk MS] [--budget-finalize MS]
//
// --replicas N streams the transcript N times back-to-back (separated by a
// blank-line delta) as ONE growing session: the naive baseline's cost grows
// with the accumulated document while tail-only parsing stays flat, so the
// ratio shrinks as the stream gets longer.
//
// --budget MS sets both gated numbers, per transcript: --budget-chunk gates the
// p99 append (one GC pause in 2484 chunks is not a regression) and
// --budget-finalize the final clean parse. Without a budget nothing fails.
//
// --require-engine fails, instead of exiting 0, when the addon or the
// StreamSession probe does not resolve.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  exitWithoutEngine,
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
const DEFAULT_TRANSCRIPTS = ['transcript-sprint-review.json', 'transcript-giant-list.json'];
const given = flagValue('transcript', null);
const transcriptPaths =
  given === null
    ? DEFAULT_TRANSCRIPTS.map((f) => path.join(fixtureDir, f))
    : [path.resolve(given)];
const repeat = numberFlag('repeat', quick ? 1 : 3);
const maxChunks = numberFlag('max-chunks', quick ? 150 : Infinity);
const replicas = numberFlag('replicas', 1);

const budgetMs = numberFlag('budget', undefined);
const chunkBudgetMs = numberFlag('budget-chunk', budgetMs);
const finalizeBudgetMs = numberFlag('budget-finalize', budgetMs);
const gating = chunkBudgetMs !== undefined || finalizeBudgetMs !== undefined;

let anyOver = false;
let anyVacuous = false;

const lib = loadLibrary();
const { StreamSession, parseDocument, presets, visit } = lib;

const engine = await resolveEngine(lib, '[bench:streaming]');
if (!engine) exitWithoutEngine('[bench:streaming]');

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
  exitWithoutEngine('[bench:streaming]', `StreamSession threw on a one-character append (${err.message})`);
}

function collectNodes(doc) {
  const seen = new Set();
  visit(doc, (n) => {
    seen.add(n);
  });
  return seen;
}

function runTranscript(transcriptPath) {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  const baseDeltas = transcript.deltas.slice(0, maxChunks);
  const deltas = [];
  for (let i = 0; i < replicas; i++) {
    if (i > 0) deltas.push('\n\n');
    deltas.push(...baseDeltas);
  }

  const out = {
    chunkTimes: [],
    replayTotals: [],
    changedCounts: [],
    // The last recorded replay's appends; finalize's parse is reported separately.
    parseInputs: [],
    finalizeInput: 0,
    finalizeMs: 0,
    totalMs: 0,
    finalSnapshot: null,
  };

  /** One replay through a fresh session, with the engine wrapped to count parse input. */
  const replay = (record) => {
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
    let appendTotal = 0;

    for (const delta of deltas) {
      const t0 = performance.now();
      session.append(delta);
      const ms = performance.now() - t0;
      appendTotal += ms;

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
      out.replayTotals.push(appendTotal);
      out.parseInputs = appendInputs;
      out.finalizeMs = finalizeMs;
      out.totalMs = performance.now() - runStart;
      out.finalSnapshot = session.snapshot();
      out.finalizeInput = inputs.length > appendInputs.length ? inputs[inputs.length - 1] : 0;
    }
  };

  // Untimed warmup, matching the naive baseline's below.
  replay(false);

  for (let r = 0; r < repeat; r += 1) replay(true);

  const totalChars = deltas.reduce((acc, d) => acc + d.length, 0);
  const effectiveAppends = deltas.filter((d) => d.length > 0).length;

  const finalSource = out.finalSnapshot ? out.finalSnapshot.document.source : deltas.join('');

  // Naive baseline: same engine and same estimator (median of per-replay sums)
  // as the streamed side, so the ratio isolates the incremental strategy.
  const naiveTotals = [];
  // Untimed warmup replay, the same amount the streamed side got.
  for (let i = 0; i < deltas.length; i += 1) {
    parseDocument(finalSource, presets.llmChat, engine.engine);
  }
  for (let r = 0; r < repeat; r += 1) {
    let total = 0;
    for (let i = 0; i < deltas.length; i += 1) {
      const t0 = performance.now();
      parseDocument(finalSource, presets.llmChat, engine.engine);
      total += performance.now() - t0;
    }
    naiveTotals.push(total);
  }

  const replicaNote = replicas > 1 ? ` × ${replicas} replicas` : '';
  console.log(`streaming replay: ${transcript.name ?? path.basename(transcriptPath)}${replicaNote}`);
  console.log(`  chunks:    ${deltas.length} (${totalChars} UTF-16 units), ${repeat} replay(s)${quick ? ' [quick]' : ''}`);

  const t = stats(out.chunkTimes);
  const c = stats(out.changedCounts);
  const streamed = stats(out.replayTotals);
  const naive = stats(naiveTotals);
  const reparseRatio = naive.p50 > 0 ? streamed.p50 / naive.p50 : NaN;

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
    // `settledUntil` cannot show this: finalize settles everything.
    if (pi.max / finalSource.length > 0.9) {
      console.log(
        `    NEVER ANCHORED: the largest append re-read ${((pi.max / finalSource.length) * 100).toFixed(1)}% of the ` +
          `final document and the average one ${((pi.mean / finalSource.length) * 100).toFixed(1)}%. ` +
          'A list (or an unclosed fence, or one giant paragraph) offers the session no safe anchor.',
      );
    }
  }
  console.log(
    `    incremental-vs-full reparse ratio: ${reparseRatio.toFixed(3)} ` +
      '(lower is better; 1.0 = no cheaper than a full reparse per chunk)',
  );
  console.log(
    `      streamed ${fmtMs(streamed.p50)} = median of ${streamed.n} replay(s), each the SUM of its ` +
      `${deltas.length} append times`,
  );
  console.log(
    `      naive    ${fmtMs(naive.p50)} = median of ${naive.n} replay(s), each the SUM of ` +
      `${deltas.length} full reparses of the ${finalSource.length}-char final document`,
  );
  if (streamed.n > 1 || naive.n > 1) {
    console.log(
      `      spread   streamed ${fmtMs(streamed.min)}–${fmtMs(streamed.max)}, ` +
        `naive ${fmtMs(naive.min)}–${fmtMs(naive.max)} ` +
        `(ratio ${(streamed.min / naive.max).toFixed(3)}–${(streamed.max / naive.min).toFixed(3)} at the extremes)`,
    );
  }
  if (out.finalSnapshot) {
    const s = out.finalSnapshot;
    console.log(
      `    final: phase=${s.phase}, blocks=${s.document.blocks.length}, settledUntil=${s.settledUntil}/${s.document.source.length}`,
    );
  }

  // `ok`/`OVER` padding matches bench/pathological.mjs; workflow logs grep both.
  if (!gating) return;

  const gate = (label, ms, budget) => {
    if (budget === undefined) {
      console.log(`    ${'off'.padEnd(5)} ${label.padEnd(10)} ${fmtMs(ms)} (no budget passed for this one)`);
      return;
    }
    const over = ms > budget;
    if (over) anyOver = true;
    console.log(`    ${(over ? 'OVER' : 'ok').padEnd(5)} ${label.padEnd(10)} ${fmtMs(ms)} vs ${budget} ms`);
  };

  if (out.chunkTimes.length === 0 || out.replayTotals.length === 0) {
    anyVacuous = true;
    console.log(
      `    ${'none'.padEnd(5)} ${'gate'.padEnd(10)} nothing was timed — ` +
        `\`--max-chunks ${maxChunks}\` left ${deltas.length} chunk(s) and \`--repeat ${repeat}\` ` +
        `${out.replayTotals.length} recorded replay(s)`,
    );
    return;
  }

  gate('chunk p99', t.p99, chunkBudgetMs);
  gate('finalize', out.finalizeMs, finalizeBudgetMs);
}

if (gating) {
  console.log(
    `gating each transcript: chunk p99 ${chunkBudgetMs === undefined ? 'off' : `${chunkBudgetMs} ms`}, ` +
      `finalize ${finalizeBudgetMs === undefined ? 'off' : `${finalizeBudgetMs} ms`}`,
  );
}

for (const [i, transcriptPath] of transcriptPaths.entries()) {
  if (i > 0) console.log('');
  runTranscript(transcriptPath);
}

if (gating && (anyOver || anyVacuous)) {
  console.log('');
  console.log(
    anyVacuous && !anyOver
      ? 'a replay timed nothing — a gate over nothing is a failure.'
      : 'budget exceeded — failing.',
  );
  process.exit(1);
}
