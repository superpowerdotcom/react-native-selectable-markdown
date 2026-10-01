#!/usr/bin/env node
// Projection amplification: source characters handed to `projectRun` over a
// streamed message, per character of the message, at two document sizes.
//
// `cached` (what ships) growing past GROWTH_LIMIT per doubling exits 1. The
// counts are exact, so the gate holds on any machine; `ms` is for scale only.
//
// The giant-list transcript never anchors, so nothing settles and both
// pipelines stay high on it by construction.
//
// Usage: node bench/projection.mjs [--quick] [--transcript PATH] [--chunk N]
//        [--require-engine]
//
// --quick measures one size, which leaves no growth ratio and nothing to gate.
// --require-engine fails, instead of exiting 0, when the addon or dist/ is missing.

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

// Not in loadLibrary's Node-safe list, but react-native-free, so required from dist/.
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

/** Re-chunked to `chunkSize`, because amplification depends on delta size. */
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

/** Linear reuse measures ~1.00 per doubling; the pipeline it replaced, ~2.00. */
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
