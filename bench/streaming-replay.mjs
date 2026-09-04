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
//   - incremental-vs-full reparse ratio: what the streamed path costs versus
//     what a naive reparse-on-every-token renderer would pay. BOTH SIDES ARE
//     THE SAME STATISTIC — the median, across repeats, of one replay's total —
//     and the run prints the two totals it divided, because a ratio whose
//     numerator and denominator are computed differently is not a measurement
//     of anything. (It used to divide a SUM of every append time by a MEDIAN
//     full parse times the chunk count, so every append outlier — GC, a JIT
//     tier-up — landed in the numerator and none in the denominator. At this
//     fixture's size that is the whole signal: chunk p99 is ~30x p50.)
//
// TWO TRANSCRIPTS BY DEFAULT, AND WHY BOTH NUMBERS HAVE TO BE PUBLISHED
// ---------------------------------------------------------------------
// Tail-only reparse depends on the stream ANCHORING: a blank line closes a
// paragraph, the blocks before it freeze, and every later append parses only
// what came after. `StreamSession.isAnchorSafe` returns false for a list and
// for unclosed/indented code, and a blank line does not end a list — so the
// commonest long LLM answer shape, one bullet list, never anchors at all and
// reparses its whole accumulated text on every single append.
//
// So this bench replays two pinned transcripts and prints both:
//
//   transcript-sprint-review.json  headings, prose, a table, a fenced block —
//                                  anchors constantly; parse input per append
//                                  stays a few hundred characters no matter
//                                  how long the stream runs.
//   transcript-giant-list.json     one 420-item bullet list — never anchors;
//                                  `max/full` sits at ~1.0 and the
//                                  incremental-vs-full ratio approaches (and
//                                  can exceed) 1.
//
// Quoting only the first number as a property of the library is the mistake
// the second transcript exists to make impossible. `--transcript PATH` still
// narrows the run to one file.
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
// AND WHY THIS FILE IS ALSO A GATE
// --------------------------------
// `bench:pathological` gates the adversarial DOCUMENT shapes; the adversarial
// STREAMING shape is this file's never-anchoring transcript, and until
// --budget existed nothing anywhere failed on it. A stream that never anchors
// re-reads its whole accumulated text on every append, so a repair or splice
// pass that stops being linear shows up here first and in `ms/chunk` — the one
// number a user feels as jank — while every document-shaped gate stays green.
// So the workflows run this file too:
//
//   --budget MS           the default budget for both gated numbers below.
//   --budget-chunk MS     p99 append latency, per transcript. p99 rather than
//                         the max because one GC pause in 2484 chunks is not a
//                         regression, and rather than p50 because the tail is
//                         where a stall lives.
//   --budget-finalize MS  the single full clean parse `finalize` does.
//
// Both are per TRANSCRIPT: a run with no --transcript replays two of them and
// each is gated on its own numbers. Without a budget nothing fails, because
// the absolute milliseconds belong to the machine and `npm run bench:streaming`
// on a laptop should not go red.
//
// --require-engine turns "the addon did not resolve" (and "StreamSession could
// not take a character") from an exit-0 report into a failure, exactly as in
// bench/pathological.mjs: a gate that exits 0 having measured nothing is worse
// than no gate, and a protocol-version drift between the built addon and dist/
// is a likelier cause here than a missing compiler. Workflows pass it; a
// laptop with no toolchain should not.

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
// The anchoring transcript first: it is the one whose numbers the docs quote,
// and reading the never-anchoring one straight after it is the point.
const DEFAULT_TRANSCRIPTS = ['transcript-sprint-review.json', 'transcript-giant-list.json'];
const given = flagValue('transcript', null);
const transcriptPaths =
  given === null
    ? DEFAULT_TRANSCRIPTS.map((f) => path.join(fixtureDir, f))
    : [path.resolve(given)];
const repeat = numberFlag('repeat', quick ? 1 : 3);
const maxChunks = numberFlag('max-chunks', quick ? 150 : Infinity);
const replicas = numberFlag('replicas', 1);

// The two gated numbers, resolved before anything runs so the header line can
// print what is being gated — a threshold only visible by reading the source is
// one nobody re-tunes when the numbers move.
const budgetMs = numberFlag('budget', undefined);
const chunkBudgetMs = numberFlag('budget-chunk', budgetMs);
const finalizeBudgetMs = numberFlag('budget-finalize', budgetMs);
const gating = chunkBudgetMs !== undefined || finalizeBudgetMs !== undefined;

let anyOver = false;
// A budget over a replay that measured no chunk (`--max-chunks 0`, an empty
// transcript) is vacuous, which is the same failure as --require-engine
// catching an unresolvable addon. Tracked apart from `anyOver` so the closing
// message can say which of the two happened.
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

/**
 * Replays one transcript and prints its block of numbers.
 *
 * Everything is per-transcript state: each file gets its own fresh sessions,
 * its own warmup and its own naive baseline, so no transcript's numbers are
 * measured on a heap the previous one shaped.
 */
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
    // One entry per timed replay: the sum of that replay's append times. The
    // ratio below is the median of these, against the median of the naive
    // baseline's per-replay totals — same shape, same outlier exposure.
    replayTotals: [],
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

  // Warmup replay (untimed) so the session path is JIT-compiled before
  // measurement, matching the warmup the naive-baseline loop gets below.
  replay(false);

  for (let r = 0; r < repeat; r += 1) replay(true);

  const totalChars = deltas.reduce((acc, d) => acc + d.length, 0);
  const effectiveAppends = deltas.filter((d) => d.length > 0).length;

  // Resolved once, outside every timed region: reading it out of the snapshot
  // inside the loop would put a property walk inside the measurement.
  const finalSource = out.finalSnapshot ? out.finalSnapshot.document.source : deltas.join('');

  // Incremental-vs-full reparse ratio: what the streamed path costs against
  // what a naive reparse-on-every-token renderer would pay. Lower is better;
  // 1.0 means no win over naive reparse. With tail-only reparse + the
  // construct-free fast path this sits far below 1 and shrinks as documents
  // grow — on a transcript that ANCHORS. On one that never anchors it climbs
  // towards 1 and can pass it, because every append reparses the whole document
  // and pays the splice on top. The baseline is measured with the SAME engine
  // the streamed numbers came from, so what the ratio isolates is the
  // incremental strategy and nothing else — a naive loop timed on some other
  // parser would just be a parser comparison wearing a different name.
  //
  // MATCHED STATISTICS, WHICH IS WHY THE BASELINE IS A LOOP AND NOT A CONSTANT.
  // The naive side used to be `median(a few full parses) × chunk count`, while
  // the streamed side was the SUM of every append. A sum carries its outliers
  // and a median discards them, so the ratio was a measurement of this
  // machine's noise as much as of the library: on the 1.2 kB transcript chunk
  // p99 is ~30x p50, and repeated runs here swung the printed figure across
  // 1.0 in both directions. So the baseline now runs `repeat` REPLAYS of its
  // own — each one the full `chunk count` reparses, summed exactly the way the
  // streamed replay sums its appends — and the ratio divides the median of one
  // side's per-replay totals by the median of the other's. Same estimator, same
  // outlier exposure, same number of samples.
  //
  // It costs what it measures: the baseline is now the same order of work as
  // the streamed side (that is the point of the comparison), where the old
  // version was ten parses. That is the price of a number that means something.
  //
  // The naive renderer is modelled as reparsing the FINAL document on every
  // chunk rather than the accumulated prefix, which overstates it by roughly
  // the average prefix fraction. That approximation is unchanged, and it is
  // stated in the printed lines so nobody has to read this comment to know
  // what was divided.
  const naiveTotals = [];
  // One untimed warmup REPLAY, not one untimed parse: the streamed side gets a
  // whole untimed replay above, and warming the two sides by different amounts
  // is the same asymmetry in a different place — it left the naive side's
  // first timed replay carrying the JIT tier-up for all of them.
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
    // Said in words, not left to the reader to spot: a max parse input equal
    // to the whole document means the anchor never moved during the stream —
    // the tail-only story does not hold for this shape, and the mean tells you
    // how much of the document the average append re-read. `settledUntil` on
    // the final snapshot cannot say this, because finalize settles everything.
    if (pi.max / finalSource.length > 0.9) {
      console.log(
        `    NEVER ANCHORED: the largest append re-read ${((pi.max / finalSource.length) * 100).toFixed(1)}% of the ` +
          `final document and the average one ${((pi.mean / finalSource.length) * 100).toFixed(1)}%. ` +
          'A list (or an unclosed fence, or one giant paragraph) offers the session no safe anchor.',
      );
    }
  }
  // Every term of the ratio is printed, because "0.435" on its own is a number
  // nobody can check and two docs already managed to quote it in opposite
  // directions. The spread line is the honest caveat: where the two bands
  // overlap, the ratio is inside the noise and no ×1 reading of it is safe.
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

  // ---- the gate -----------------------------------------------------------
  //
  // Printed only when a budget was passed, so a plain `npm run bench:streaming`
  // stays a report. `ok`/`OVER` and the same padding as bench/pathological.mjs,
  // because the two are read (and grepped) together in a workflow log.
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

  // A budget over a replay that timed nothing passes over zero samples, which
  // is the failure --require-engine exists to stop one line further up. Both
  // ways in are reachable from flags alone: `--max-chunks 0` leaves no append
  // to time, `--repeat 0` leaves no recorded replay at all.
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
