// Frames are hand-built to pin block identity; conformance/selection/incremental-projection.test.ts runs a real StreamSession.
import type { ParagraphNode, ParsedDocument } from '../document/nodes';
import { projectRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { EmbedLookup, RunSegment } from '../selection/runs';
import { createRunProjectionCache } from './projectionCache';
import type { RunProjectionCache } from './projectionCache';
import { runKey } from './runIdentity';

function paragraph(source: string, start: number, end: number): ParagraphNode {
  const span = { start, end };
  return {
    kind: 'paragraph',
    span,
    children: [{ kind: 'text', value: source.slice(start, end), span }],
  };
}

function proseDocument(count: number, width: number): ParsedDocument {
  let source = '';
  const bounds: { start: number; end: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      source += '\n\n';
    }
    const start = source.length;
    source += `${String(index).padStart(4, '0')}${'x'.repeat(width - 4)}`;
    bounds.push({ start, end: source.length });
  }
  return {
    source,
    blocks: bounds.map((b) => paragraph(source, b.start, b.end)),
  };
}

interface Frame {
  doc: ParsedDocument;
  settledUntil: number;
}

function frames(doc: ParsedDocument, ticks: number): Frame[] {
  const out: Frame[] = [];
  for (let index = 0; index < doc.blocks.length; index += 1) {
    const block = doc.blocks[index];
    const settled = doc.blocks.slice(0, index);
    const settledUntil = index === 0 ? 0 : settled[index - 1].span.end;
    const length = block.span.end - block.span.start;
    for (let tick = 1; tick <= ticks; tick += 1) {
      const grown = Math.max(1, Math.round((length * tick) / ticks));
      // Only the final tick hands over the settled object; earlier ticks are fresh, like a reparsed tail.
      const tail =
        grown === length
          ? block
          : paragraph(doc.source, block.span.start, block.span.start + grown);
      out.push({
        doc: { source: doc.source, blocks: [...settled, tail] },
        settledUntil,
      });
    }
  }
  return out;
}

/** Claims nothing; the top-level offers sum to the source characters projected. */
function meter(): {
  embed: EmbedLookup;
  on: () => void;
  off: () => void;
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
    on: () => {
      counting = true;
    },
    off: () => {
      counting = false;
    },
    chars: () => chars,
  };
}

function replay(
  doc: ParsedDocument,
  ticks: number,
): { projected: number; source: number } {
  const gauge = meter();
  const caches = new Map<string, RunProjectionCache>();
  for (const frame of frames(doc, ticks)) {
    const runs = segmentRuns(frame.doc, {
      settledUntil: frame.settledUntil,
      embed: gauge.embed,
    });
    runs.forEach((run, index) => {
      if (run.standalone) {
        return;
      }
      const key = runKey(
        run,
        index,
        runs.length,
        run.span.end > frame.settledUntil,
      );
      let cache = caches.get(key);
      if (cache === undefined) {
        cache = createRunProjectionCache();
        caches.set(key, cache);
      }
      gauge.on();
      cache.project(run, frame.doc, { embed: gauge.embed });
      gauge.off();
    });
  }
  return { projected: gauge.chars(), source: doc.source.length };
}

describe('createRunProjectionCache', () => {
  const doc = proseDocument(6, 100);
  const run = segmentRuns(doc)[0];

  function prefixRun(count: number): RunSegment {
    const blocks = doc.blocks.slice(0, count);
    return {
      ...run,
      blocks,
      span: {
        start: blocks[0].span.start,
        end: blocks[blocks.length - 1].span.end,
      },
    };
  }

  it('grows a run to exactly what a full projection would produce', () => {
    const cache = createRunProjectionCache();
    for (let count = 1; count <= doc.blocks.length; count += 1) {
      const grown = prefixRun(count);
      expect(cache.project(grown, doc)).toEqual(projectRun(grown, doc));
    }
  });

  it('hands back the identical object when the run has not changed', () => {
    const cache = createRunProjectionCache();
    const first = cache.project(run, doc);
    expect(first).toEqual(projectRun(run, doc));

    // A fresh RunSegment over the same blocks, as `segmentRuns` returns on an unchanged tick.
    expect(cache.project({ ...run }, doc)).toBe(first);
  });

  it('reprojects from scratch when a marker glyph changes', () => {
    const cache = createRunProjectionCache();
    cache.project(prefixRun(3), doc, { glyphs: { bullet: '- ' } });
    const grown = prefixRun(4);

    expect(cache.project(grown, doc, { glyphs: { bullet: '* ' } })).toEqual(
      projectRun(grown, doc, { glyphs: { bullet: '* ' } }),
    );
  });

  it('reprojects from scratch when the embed lookup changes', () => {
    const claim: EmbedLookup = (node) =>
      node.kind === 'paragraph' ? { width: 10, height: 10 } : undefined;
    const cache = createRunProjectionCache();
    const grown = prefixRun(4);

    cache.project(prefixRun(3), doc);
    const claimed = cache.project(grown, doc, { embed: claim });

    expect(claimed).toEqual(projectRun(grown, doc, { embed: claim }));
    expect(claimed.embeds).toHaveLength(4);
    // Dropping the lookup must reproject too, or placeholder text splices onto full text.
    expect(cache.project(grown, doc)).toEqual(projectRun(grown, doc));
  });

  it('reprojects when the run is not an extension of the last one', () => {
    const cache = createRunProjectionCache();
    cache.project(prefixRun(4), doc);

    const other: RunSegment = {
      ...run,
      blocks: doc.blocks.slice(4),
      span: { start: doc.blocks[4].span.start, end: doc.blocks[5].span.end },
    };
    expect(cache.project(other, doc)).toEqual(projectRun(other, doc));
  });
});

// docs/PERFORMANCE.md and docs/BENCHMARKS.md quote the ratio this gates.
describe('projected-character amplification', () => {
  const TICKS = 4;

  it('stays flat as the document doubles', () => {
    const small = replay(proseDocument(20, 150), TICKS);
    const large = replay(proseDocument(40, 150), TICKS);

    const smallAmp = small.projected / small.source;
    const largeAmp = large.projected / large.source;

    // Each paragraph is reprojected once per tick while it is the tail: ~TICKS + 1.
    expect(smallAmp).toBeLessThan(TICKS + 3);
    expect(largeAmp).toBeLessThan(smallAmp * 1.2);
    expect(smallAmp).toBeGreaterThanOrEqual(1);
    expect(largeAmp).toBeGreaterThanOrEqual(1);
  });

  it('never reprojects more than the tail plus one settling block', () => {
    const doc = proseDocument(30, 150);
    const gauge = meter();
    const caches = new Map<string, RunProjectionCache>();
    let worst = 0;

    for (const frame of frames(doc, TICKS)) {
      const runs = segmentRuns(frame.doc, {
        settledUntil: frame.settledUntil,
        embed: gauge.embed,
      });
      runs.forEach((run, index) => {
        const key = runKey(
          run,
          index,
          runs.length,
          run.span.end > frame.settledUntil,
        );
        let cache = caches.get(key);
        if (cache === undefined) {
          cache = createRunProjectionCache();
          caches.set(key, cache);
        }
        const before = gauge.chars();
        gauge.on();
        cache.project(run, frame.doc, { embed: gauge.embed });
        gauge.off();
        worst = Math.max(worst, gauge.chars() - before);
      });
    }

    // Ceiling: the block that just settled plus the tail being redrawn.
    expect(worst).toBeLessThan(400);
    expect(worst).toBe(150);
    expect(doc.source.length).toBeGreaterThan(4000);
  });
});

describe('run-size budget as the view sees it', () => {
  it('splits a document past the cap into several prose runs', () => {
    const doc = proseDocument(200, 150);
    const runs = segmentRuns(doc);

    expect(runs.length).toBe(4);
    expect(runs.every((run) => !run.standalone)).toBe(true);
    const keys = runs.map((run, index) =>
      runKey(run, index, runs.length, false),
    );
    expect(new Set(keys).size).toBe(runs.length);
  });
});

it('meters without changing what is projected', () => {
  const doc = proseDocument(4, 80);
  const run = segmentRuns(doc)[0];
  const gauge = meter();

  const metered = projectRun(run, doc, { embed: gauge.embed });
  expect(metered).toEqual(projectRun(run, doc));
  expect(metered.text).toBe(doc.source);
  expect(metered.embeds).toBeUndefined();
});

test('a changed second block invalidates a cached prefix', () => {
  const doc = proseDocument(3, 10);
  const run = segmentRuns(doc)[0];
  const cache = createRunProjectionCache();
  cache.project(run, doc);
  const source = doc.source.slice(0, 12) + 'changed!!!' + doc.source.slice(22);
  const changed = { source, blocks: [doc.blocks[0], paragraph(source, 12, 22), doc.blocks[2]] };
  const next = segmentRuns(changed)[0];
  expect(cache.project(next, changed)).toEqual(projectRun(next, changed));
});

test('truncated source refuses reuse even when a caller retains block identities', () => {
  const doc = proseDocument(2, 10);
  const run = segmentRuns(doc)[0];
  const cache = createRunProjectionCache();
  const previous = cache.project(run, doc);
  const truncated = { ...doc, source: doc.source.slice(0, 4) };
  const projected = cache.project(run, truncated);
  expect(projected).not.toBe(previous);
  expect(projected).toEqual(projectRun(run, truncated));
});
