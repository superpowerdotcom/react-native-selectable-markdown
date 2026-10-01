/**
 * The projector carries merge, mark, and embed-numbering state across block
 * boundaries, so an extended projection is checked against a fresh one.
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
    // Vacuous on one-block runs, so the corpus must supply many multi-block
    // ones.
    expect(steps).toBeGreaterThan(500);
  });

  it('grows identically when an embed lookup is claiming nodes', () => {
    // One inline and one block embed, so block seams are crossed with an embed
    // on either side.
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
 * Claims nothing; summing the spans of `topLevel` nodes counts source
 * characters projected.
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
  /** Source characters projected, summed over every commit. */
  projected: number;
  source: number;
  /** Largest single projection, in source characters. */
  worst: number;
}

/**
 * Mirrors the view pipeline: one cache per `runKey`, as `SelectableMarkdown`
 * keys its `RunView`s.
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
      liveTail: true,
    });
    runs.forEach((run, index) => {
      if (run.standalone) {
        return;
      }
      const key = runKey(run, index, runs.length, true);
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

    // Amplification is set by how long a block stays the live tail, so by delta
    // size, not document size.
    expect(largeAmp).toBeLessThan(smallAmp * 1.35);
    expect(largeAmp).toBeLessThan(40);
  });

  it('bounds the largest single projection well below the document', () => {
    const doc = transcript(14000);
    const { worst, source } = replay(doc, CHUNK, presets.llmChat);

    expect(worst).toBeLessThan(source / 4);
  });
});
