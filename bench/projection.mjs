#!/usr/bin/env node
// Projection amplification: how many source characters the view layer hands
// `projectRun` over a whole streamed message, against how many characters the
// message contains.
//
// WHY THIS NUMBER, AND WHY NO OTHER BENCH SEES IT
// ----------------------------------------------
// bench/throughput.mjs times a parse, bench/streaming-replay.mjs times an
// append, bench/crossing.mjs times the JS<->native hop, bench/pathological.mjs
// times one segment+project pass over a finished document. Not one of them
// replays the VIEW: segment the snapshot, then project each run, on every
// commit, the way `SelectableMarkdown` does. That is where the library's one
// superlinear step lived.
//
// The shape of it: `segmentRuns` merges every adjacent settled flowing block
// into one run, so an ordinary answer is ONE run that gains a block each time
// the stream settles. Reprojecting the whole run per settle costs O(document)
// per settle and O(document^2) over the message — the audit measured 47.7x the
// document at 14 kB and 90.1x at 28 kB, with a single late settle reprojecting
// 25 kB. `projectRun`'s `previous` option and `createRunProjectionCache` make
// growth cost the growth instead.
//
// So this bench prints, for each transcript and at two document sizes:
//
//   projected/doc   total source characters projected / document length. The
//                   invariant is that this ratio is FLAT in document size: it
//                   is set by how long a block spends as the redrawn tail
//                   (a function of delta size), not by the document in front
//                   of it.
//   worst           the largest single projection. Bounded by the tail plus
//                   the block that just settled — never the whole message.
//   growth          the ratio between the two sizes' amplification. ~1.0 is
//                   linear; the old design roughly doubled it per doubling.
//
// Both pipelines are measured side by side — `cached` is what ships, `full` is
// the same replay with the cache taken away — because the number only means
// something next to the one it replaced.
//
// TWO TRANSCRIPTS, AND THE SECOND ONE IS THE HONEST HALF. Incremental
// projection can only help a run whose blocks SETTLE, because a settled block
// is the same object on the next tick and that identity is the whole reuse
// test. `transcript-giant-list.json` is one 420-item bullet list, and a list
// never anchors (`StreamSession.isAnchorSafe`), so the entire document is one
// unsettled tail block that is reparsed — new object, new spans — on every
// delta. Nothing here can reuse anything, and its amplification stays enormous
// on both pipelines. That is the same pathology bench/streaming-replay.mjs
// exists to keep visible, one layer up; quoting only the first transcript's
// numbers as a property of the library is the mistake both benches refuse to
// let anyone make.
//
// `ms` is one un-warmed pass over the whole replay, printed for scale only.
// The counts are the measurement; they are exact and deterministic.
//
// THIS IS A GATE, NOT A REPORT, and it can be one precisely because the counts
// are exact. Nothing here is a wall-clock threshold that a busy runner can
// trip: `projected/doc` is a count of source characters handed to the
// projector, so the same transcript at the same `--chunk` gives the same
// number on every machine. So `cached` growth above GROWTH_LIMIT (below) exits
// 1 — the epilogue used to call itself "the gate" while never returning
// anything but 0, and no workflow ran it at all.
//
// Usage: node bench/projection.mjs [--quick] [--transcript PATH] [--chunk N]
//        [--require-engine]
//
// --quick measures one document size, which leaves no growth ratio to compare
// and therefore nothing to gate — the gate needs both sizes. --require-engine
// turns a missing addon (or a dist/ built before src/view/projectionCache.ts)
// from an exit-0 report into a failure, so a CI step cannot pass having
// measured nothing.
//
// The counting instrument is an `EmbedLookup` that claims nothing: the
// projector offers a run's own blocks with `topLevel: true`, so summing their
// spans is exactly "source characters projected", and claiming nothing leaves
// the projection byte-identical (conformance/selection/incremental-projection.test.ts
// asserts that equivalence over the whole corpus).

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  exitWithoutEngine,
  fixtureDir,
  flagValue,
  hasFlag,
  loadLibrary,
  numberFlag,
  refuseEngineFlag,
  repoRoot,
  resolveEngine,
} from './support.mjs';

refuseEngineFlag();

const quick = hasFlag('quick');
const chunkSize = numberFlag('chunk', 18);
const DEFAULT_TRANSCRIPTS = ['transcript-sprint-review.json', 'transcript-giant-list.json'];
const given = flagValue('transcript', null);
const transcriptPaths =
  given === null
    ? DEFAULT_TRANSCRIPTS.map((f) => path.join(fixtureDir, f))
    : [path.resolve(given)];

const lib = loadLibrary();
const { StreamSession, presets, projectRun, segmentRuns } = lib;

// The view-layer half of the pipeline is not in `loadLibrary`'s namespace (that
// list is the Node-safe engine/stream/selection modules). These two modules are
// react-native-free for exactly this reason — see the note at the top of
// src/view/runIdentity.ts — so they are required straight out of dist/.
const require = createRequire(import.meta.url);
const viewDir = path.join(repoRoot, 'dist', 'view');
const cachePath = path.join(viewDir, 'projectionCache.js');
if (!existsSync(cachePath)) {
  console.log(
    '[bench:projection] dist/ predates src/view/projectionCache.ts — run `npm run build` first.',
  );
  exitWithoutEngine('[bench:projection]', 'dist/ has no view/projectionCache.js to measure');
}
const { createRunProjectionCache } = require(cachePath);
const { runKey } = require(path.join(viewDir, 'runIdentity.js'));

const engine = await resolveEngine(lib, '[bench:projection]');
if (!engine) exitWithoutEngine('[bench:projection]');

/** A pure EmbedLookup that claims nothing and sums the top-level spans it sees. */
function meter() {
  let counting = false;
  let chars = 0;
  return {
    embed: (node, context) => {
      if (counting && context.topLevel) chars += node.span.end - node.span.start;
      return undefined;
    },
    measure(body) {
      counting = true;
      try {
        return body();
      } finally {
        counting = false;
      }
    },
    chars: () => chars,
  };
}

/**
 * Replays `deltas` through a real StreamSession and runs the view pipeline on
 * every commit. With `cached` false the cache is skipped entirely, which is the
 * pre-fix behaviour: every run is reprojected in full on every commit that
 * changed it.
 */
function replay(deltas, cached) {
  const gauge = meter();
  const caches = new Map();
  const session = new StreamSession({ engine: engine.engine, options: presets.llmChat });
  let worst = 0;
  let commits = 0;
  let runsAtEnd = 0;

  const draw = () => {
    const snapshot = session.snapshot();
    const doc = snapshot.document;
    const runs = segmentRuns(doc, {
      settledUntil: snapshot.settledUntil,
      embed: gauge.embed,
    });
    runsAtEnd = runs.length;
    commits += 1;
    runs.forEach((run, index) => {
      if (run.standalone) return;
      const unsettledTail =
        snapshot.phase === 'streaming' && run.span.end > snapshot.settledUntil;
      const key = runKey(run, index, runs.length, unsettledTail);
      const before = gauge.chars();
      if (cached) {
        let cache = caches.get(key);
        if (cache === undefined) {
          cache = createRunProjectionCache();
          caches.set(key, cache);
        }
        gauge.measure(() => cache.project(run, doc, { embed: gauge.embed }));
      } else {
        gauge.measure(() => projectRun(run, doc, { embed: gauge.embed }));
      }
      worst = Math.max(worst, gauge.chars() - before);
    });
  };

  const started = performance.now();
  for (const delta of deltas) {
    session.append(delta);
    draw();
  }
  session.finalize();
  draw();
  const ms = performance.now() - started;

  return {
    projected: gauge.chars(),
    source: session.snapshot().document.source.length,
    worst,
    commits,
    runsAtEnd,
    ms,
  };
}

/** The transcript's deltas, re-chunked to `chunkSize` so both files are read at
 * the same delta granularity — amplification is a function of it. */
function deltasOf(transcriptPath, replicas) {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  let text = '';
  for (let i = 0; i < replicas; i += 1) {
    if (i > 0) text += '\n\n';
    text += transcript.deltas.join('');
  }
  const out = [];
  for (let at = 0; at < text.length; at += chunkSize) {
    out.push(text.slice(at, at + chunkSize));
  }
  return out;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

console.log(
  `[bench:projection] engine=md4c chunk=${chunkSize} — projected characters per document character\n`,
);

/**
 * The most `cached` amplification may grow when the document doubles.
 *
 * Linear reuse is ~1.00 (measured: 0.99 and 1.00 on the two transcripts) and
 * the pipeline this replaced is ~2.00 (measured: 1.98 and 2.09), so the
 * threshold sits between them, nearer the good end: the counts are exact, so
 * the only slack this needs to leave is for a transcript or `--chunk` change
 * shifting how long a block spends as the redrawn tail. Anything that reaches
 * 1.25 has stopped tracking the deltas and started tracking the document.
 */
const GROWTH_LIMIT = 1.25;
const overGrowth = [];

for (const transcriptPath of transcriptPaths) {
  const name = path.basename(transcriptPath);
  console.log(name);
  const sizes = quick ? [1] : [1, 2];
  const amps = { cached: [], full: [] };

  for (const replicas of sizes) {
    const deltas = deltasOf(transcriptPath, replicas);
    for (const mode of ['cached', 'full']) {
      const r = replay(deltas, mode === 'cached');
      const amp = r.projected / r.source;
      amps[mode].push(amp);
      console.log(
        `  ${String(replicas).padStart(2)}x ${mode.padEnd(6)} ` +
          `doc=${fmt(r.source).padStart(8)}  projected=${fmt(r.projected).padStart(11)}  ` +
          `projected/doc=${amp.toFixed(1).padStart(7)}  worst=${fmt(r.worst).padStart(7)}  ` +
          `runs=${String(r.runsAtEnd).padStart(3)}  ${r.ms.toFixed(1)}ms`,
      );
    }
  }

  if (sizes.length > 1) {
    const growth = (mode) => amps[mode][1] / amps[mode][0];
    const cachedGrowth = growth('cached');
    const over = cachedGrowth > GROWTH_LIMIT;
    if (over) overGrowth.push({ name, growth: cachedGrowth });
    console.log(
      `     growth  ${over ? 'OVER  ' : ''}cached=${cachedGrowth.toFixed(2)}x  ` +
        `full=${growth('full').toFixed(2)}x ` +
        `  (per doubling; ~1.00 is linear, ~2.00 is quadratic; gate: cached <= ${GROWTH_LIMIT.toFixed(2)}x)`,
    );
  }
  console.log('');
}

console.log(
  'Read `cached` as the shipped pipeline and `full` as what it replaced. The gate is\n' +
    `that \`cached\` growth stays at or under ${GROWTH_LIMIT.toFixed(2)}x per doubling — projection work must\n` +
    'track the deltas, not the document they accumulate into. Exceeding it exits 1.\n' +
    'docs/PERFORMANCE.md carries the invariant.\n' +
    '\nA document that never anchors has no settled blocks to reuse, so both columns\n' +
    'stay high for the giant-list transcript — the reuse is real, the anchoring is\n' +
    'what it depends on. The GATE is the growth column, not the absolute\n' +
    'amplification: an unanchored stream is expensive on both pipelines by\n' +
    'construction, and gating that number would only pin the fixture.',
);

if (overGrowth.length > 0) {
  for (const { name, growth } of overGrowth) {
    console.error(
      `[bench:projection] ${name}: cached amplification grew ${growth.toFixed(2)}x per doubling, ` +
        `over the ${GROWTH_LIMIT.toFixed(2)}x limit — incremental projection is no longer reusing ` +
        'settled blocks. Start at src/view/projectionCache.ts and runKey in src/view/runIdentity.ts.',
    );
  }
  process.exit(1);
}
