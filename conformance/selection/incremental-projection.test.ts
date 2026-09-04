/**
 * Incremental projection, held over the corpus and over a real stream.
 *
 * WHY THIS FILE EXISTS. A settled prose run GROWS: `segmentRuns` merges every
 * adjacent settled flowing block into one run, so an ordinary answer is one run
 * that gains a block on every settle. Reprojecting it each time is O(document)
 * per settle and O(document²) over a message — measured at 668,995 characters
 * projected for a 14 kB document and 2,528,198 for a 28 kB one. `projectRun`
 * therefore takes a `previous` projection and extends it, and
 * `createRunProjectionCache` is what holds one per run.
 *
 * That optimisation is only safe if an extended projection is INDISTINGUISHABLE
 * from a fresh one, and "indistinguishable" is a strong claim: the projector
 * merges a chunk into the preceding piece when the two are linear in the
 * source, records marks as constructs close and sorts them at the end, numbers
 * embeds by position, and refuses to grow an embed's piece. All four are state
 * carried across a block boundary. Hand-built fixtures check the constructs
 * somebody thought of (src/selection/__tests__/mapSelection.test.ts, "projectRun
 * (incremental)"); this checks every construct in the CommonMark suite and every
 * shipped fixture, parsed by the engine the app actually runs.
 *
 * The second half measures rather than compares: it replays fixtures through a
 * real `StreamSession` and gates the amplification — projected characters over
 * document characters — at a constant, which is the invariant docs/
 * PERFORMANCE.md and docs/BENCHMARKS.md quote. bench/projection.mjs reports the
 * same number with the transcripts, in the open.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ParsedDocument } from '../../src/document/nodes';
import { parseDocument } from '../../src/engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../../src/engine/native/__tests__/support';
import { presets } from '../../src/engine/options';
import type { EngineOptions } from '../../src/engine/options';
import { projectRun } from '../../src/selection/mapSelection';
import { segmentRuns } from '../../src/selection/runs';
import type { EmbedLookup, RunSegment } from '../../src/selection/runs';
import { StreamSession } from '../../src/stream/StreamSession';
import { createRunProjectionCache } from '../../src/view/projectionCache';
import type { RunProjectionCache } from '../../src/view/projectionCache';
import { runKey } from '../../src/view/runIdentity';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const SPEC_PATH = path.resolve(__dirname, '..', 'vendor', 'spec.json');

interface Case {
  readonly label: string;
  readonly source: string;
}

function loadCorpus(): Case[] {
  const cases: Case[] = [];
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as {
    markdown: string;
    example: number;
  }[];
  for (const entry of spec) {
    cases.push({ label: `spec example ${entry.example}`, source: entry.markdown });
  }
  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md'))) {
    cases.push({
      label: `fixture ${file}`,
      source: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    });
  }
  return cases;
}

const corpus = loadCorpus();

linkNativeEngineAsDefault();

/** `run` restricted to its first `count` blocks. */
function prefixRun(run: RunSegment, count: number): RunSegment {
  const blocks = run.blocks.slice(0, count);
  return {
    ...run,
    blocks,
    span: {
      start: blocks[0].span.start,
      end: blocks[blocks.length - 1].span.end,
    },
  };
}

/**
 * Grows `run` one block at a time through a cache, asserting after every step
 * that the result deep-equals the projection from scratch. Returns the number
 * of steps taken, so a caller can prove the corpus actually exercised runs with
 * more than one block in them.
 */
function growAndCompare(
  run: RunSegment,
  doc: ParsedDocument,
  options?: { embed?: EmbedLookup },
): number {
  const cache = createRunProjectionCache();
  for (let count = 1; count <= run.blocks.length; count += 1) {
    const grown = prefixRun(run, count);
    expect(cache.project(grown, doc, options)).toEqual(
      projectRun(grown, doc, options),
    );
  }
  return run.blocks.length;
}

describeNative.each([
  ['llmChat', presets.llmChat],
  ['everything', presets.everything],
] as [string, EngineOptions][])('incremental projection (%s)', (_name, options) => {
  it('grows every corpus run to exactly the full projection', () => {
    let steps = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const run of segmentRuns(doc)) {
        if (run.standalone) {
          continue;
        }
        try {
          steps += growAndCompare(run, doc);
        } catch (err) {
          throw new Error(`${label}: ${(err as Error).message}`);
        }
      }
    }
    // The property is vacuous on one-block runs, so make the corpus prove it
    // supplied plenty of multi-block ones.
    expect(steps).toBeGreaterThan(500);
  });

  it('grows identically when an embed lookup is claiming nodes', () => {
    // Links and code blocks: one inline, one block, so the seam between two
    // projected blocks is crossed with an embed on either side of it.
    const embed: EmbedLookup = (node) =>
      node.kind === 'link' || node.kind === 'codeBlock'
        ? { width: 100, height: 40, text: '[card]' }
        : undefined;
    let claimed = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const run of segmentRuns(doc, { embed })) {
        if (run.standalone) {
          continue;
        }
        try {
          growAndCompare(run, doc, { embed });
        } catch (err) {
          throw new Error(`${label}: ${(err as Error).message}`);
        }
        claimed += projectRun(run, doc, { embed }).embeds?.length ?? 0;
      }
    }
    expect(claimed).toBeGreaterThan(50);
  });
});

/**
 * The measuring instrument: a pure `EmbedLookup` that claims nothing and sums
 * the source extent of the top-level nodes it is offered. The projector offers
 * a run's own blocks with `topLevel: true` and every descendant with false, so
 * that sum is exactly "source characters projected" — the number the audit
 * measured. Claiming nothing leaves the projection byte-identical to one with
 * no lookup at all (asserted by the corpus case above, which projects both
 * ways).
 */
function meter(): {
  embed: EmbedLookup;
  measure: <T>(body: () => T) => T;
  chars: () => number;
} {
  let counting = false;
  let chars = 0;
  return {
    embed: (node, context) => {
      if (counting && context.topLevel) {
        chars += node.span.end - node.span.start;
      }
      return undefined;
    },
    measure: (body) => {
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

interface Replay {
  /** Source characters handed to the projector across the whole stream. */
  projected: number;
  /** The finished document's length. */
  source: number;
  /** The largest single projection — the number an old late settle blew up. */
  worst: number;
}

/**
 * Streams `source` in `chunk`-character deltas through a real `StreamSession`
 * and runs the view pipeline on every commit: `segmentRuns`, one cache per
 * `runKey` (which is what `SelectableMarkdown` files its `RunView`s under), and
 * `cache.project` per prose run.
 */
function replay(source: string, chunk: number, options: EngineOptions): Replay {
  const gauge = meter();
  const caches = new Map<string, RunProjectionCache>();
  const session = new StreamSession({ options });
  let worst = 0;

  const draw = (): void => {
    const snapshot = session.snapshot();
    const doc = snapshot.document;
    const runs = segmentRuns(doc, {
      settledUntil: snapshot.settledUntil,
      embed: gauge.embed,
    });
    runs.forEach((run, index) => {
      if (run.standalone) {
        return;
      }
      const unsettledTail =
        snapshot.phase === 'streaming' && run.span.end > snapshot.settledUntil;
      const key = runKey(run, index, runs.length, unsettledTail);
      let cache = caches.get(key);
      if (cache === undefined) {
        cache = createRunProjectionCache();
        caches.set(key, cache);
      }
      const before = gauge.chars();
      gauge.measure(() => cache.project(run, doc, { embed: gauge.embed }));
      worst = Math.max(worst, gauge.chars() - before);
    });
  };

  for (let at = 0; at < source.length; at += chunk) {
    session.append(source.slice(at, at + chunk));
    draw();
  }
  session.finalize();
  draw();

  return { projected: gauge.chars(), source: source.length, worst };
}

/** The longest shipped fixture, repeated to make a document of a given size. */
function transcript(minimumLength: number): string {
  const parts = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8'));
  let out = '';
  while (out.length < minimumLength) {
    for (const part of parts) {
      out += `${part.trim()}\n\n`;
      if (out.length >= minimumLength) break;
    }
  }
  return out;
}

describeNative('projected-character amplification', () => {
  const CHUNK = 18;

  it('stays flat as the streamed document doubles', () => {
    const small = replay(transcript(7000), CHUNK, presets.llmChat);
    const large = replay(transcript(14000), CHUNK, presets.llmChat);

    const smallAmp = small.projected / small.source;
    const largeAmp = large.projected / large.source;

    // Before the cache this ratio grew with the document (47.7× at 14 kB,
    // 90.1× at 28 kB). It is now set by how long a block spends as the live
    // tail, which is a property of the delta size, not of the document.
    expect(largeAmp).toBeLessThan(smallAmp * 1.35);
    expect(largeAmp).toBeLessThan(40);
  });

  it('bounds the largest single projection well below the document', () => {
    const doc = transcript(14000);
    const { worst, source } = replay(doc, CHUNK, presets.llmChat);

    // The number the old design could not bound at all: with a whole message
    // in one growing run, the last settle reprojected the whole message.
    expect(worst).toBeLessThan(source / 4);
  });
});
