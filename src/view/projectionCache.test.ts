/**
 * The projection cache, and the streaming property it exists for.
 *
 * WHY THE STREAM IS EMULATED BY HAND HERE. The property under test is about
 * BLOCK IDENTITY across snapshots — settled blocks are the same objects, the
 * tail is a new one every tick — and that is a contract `StreamSession` keeps
 * regardless of which parser is behind it. Building the frames directly states
 * that contract in the test file instead of depending on a compiler being
 * present, and keeps a failure pointing at the cache rather than at md4c. The
 * counterpart over a real `StreamSession` and a real parse is
 * conformance/selection/incremental-projection.test.ts.
 */
import type { ParagraphNode, ParsedDocument } from '../document/nodes';
import { projectRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { EmbedLookup, RunSegment } from '../selection/runs';
import { createRunProjectionCache } from './projectionCache';
import type { RunProjectionCache } from './projectionCache';
import { runKey } from './runIdentity';

/** A paragraph whose text is exactly the given source slice. */
function paragraph(source: string, start: number, end: number): ParagraphNode {
  const span = { start, end };
  return {
    kind: 'paragraph',
    span,
    children: [{ kind: 'text', value: source.slice(start, end), span }],
  };
}

/** `count` paragraphs of `width` characters, blank-line separated. */
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

/**
 * The frames a stream of `doc` would commit: `ticks` per paragraph, each one
 * extending the tail paragraph, and every settled paragraph handed back as the
 * SAME OBJECT it will be for the rest of the stream — which is exactly what
 * `StreamSession` does with its frozen prefix.
 */
function frames(doc: ParsedDocument, ticks: number): Frame[] {
  const out: Frame[] = [];
  for (let index = 0; index < doc.blocks.length; index += 1) {
    const block = doc.blocks[index];
    const settled = doc.blocks.slice(0, index);
    const settledUntil = index === 0 ? 0 : settled[index - 1].span.end;
    const length = block.span.end - block.span.start;
    for (let tick = 1; tick <= ticks; tick += 1) {
      const grown = Math.max(1, Math.round((length * tick) / ticks));
      // The final tick hands over the settled object itself; every earlier one
      // is a fresh node, as a reparsed tail always is.
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

/**
 * A pure `EmbedLookup` that claims nothing and records what it was offered.
 *
 * IT IS THE MEASURING INSTRUMENT, not a feature under test. The projector
 * offers every node it projects to the lookup, and offers a run's own blocks
 * with `topLevel: true` — so the summed span of the top-level offers is exactly
 * "how many source characters were projected", the number the audit measured
 * and the one this file gates. Claiming nothing keeps the projection identical
 * to a projection with no lookup at all.
 */
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

/**
 * Replays a document as a stream through the real view pipeline —
 * `segmentRuns`, one cache per run key (`runKey` is what `SelectableMarkdown`
 * files its `RunView`s under), `cache.project` per run — and reports the
 * characters projected against the characters in the document.
 */
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

    // A fresh RunSegment over the same blocks — what `segmentRuns` returns on
    // a tick that changed nothing. Downstream memos key on the projection's
    // identity, so this is what makes such a tick free.
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
    // …and back again, which is the direction that would splice placeholder
    // text onto full text if the key were only checked one way.
    expect(cache.project(grown, doc)).toEqual(projectRun(grown, doc));
  });

  it('reprojects when the run is not an extension of the last one', () => {
    const cache = createRunProjectionCache();
    cache.project(prefixRun(4), doc);

    // The tail run: different blocks entirely, same cache would be wrong.
    const other: RunSegment = {
      ...run,
      blocks: doc.blocks.slice(4),
      span: { start: doc.blocks[4].span.start, end: doc.blocks[5].span.end },
    };
    expect(cache.project(other, doc)).toEqual(projectRun(other, doc));
  });
});

/**
 * THE AMPLIFICATION GATE.
 *
 * Before the cache, a settled prose run was reprojected in full on every
 * settle, so a message of n characters cost O(n²) projection over its stream:
 * measured at 47.7× the document for 14 kB and 90.1× for 28 kB — doubling the
 * document quadrupled the work, and one late settle reprojected a 25 kB run.
 *
 * What replaces it is a constant: every block is projected once when it
 * settles, plus once per tick while it is the live tail. So the ratio of
 * projected characters to document characters must not grow with the document
 * — that is the invariant, and it is the one docs/PERFORMANCE.md and
 * docs/BENCHMARKS.md quote. The bench that reports the same number over real
 * transcripts is bench/projection.mjs.
 */
describe('projected-character amplification', () => {
  const TICKS = 4;

  it('stays flat as the document doubles', () => {
    const small = replay(proseDocument(20, 150), TICKS);
    const large = replay(proseDocument(40, 150), TICKS);

    const smallAmp = small.projected / small.source;
    const largeAmp = large.projected / large.source;

    // Linear, with the constant set by how many ticks each paragraph spends as
    // the live tail: ~TICKS + 1, not ~document/2.
    expect(smallAmp).toBeLessThan(TICKS + 3);
    expect(largeAmp).toBeLessThan(smallAmp * 1.2);
  });

  it('never reprojects more than the tail plus one settling block', () => {
    // The single number the old design could not bound: with a whole message
    // in one growing run, the LAST settle reprojected the whole message.
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

    // Two blocks' worth of source is the ceiling: the block that just settled,
    // and the tail block being redrawn. Nothing scales with the prefix.
    expect(worst).toBeLessThan(400);
    expect(doc.source.length).toBeGreaterThan(4000);
  });
});

/**
 * A very long document is several runs, so no single native host holds — and
 * re-measures — the whole thing. See `DEFAULT_MAX_RUN_CHARS`; the cap is a
 * selection boundary, so it sits far above ordinary message lengths.
 */
describe('run-size budget as the view sees it', () => {
  it('splits a document past the cap into several prose runs', () => {
    const doc = proseDocument(200, 150);
    const runs = segmentRuns(doc);

    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((run) => !run.standalone)).toBe(true);
    // Every run keeps a distinct, stable React key.
    const keys = runs.map((run, index) =>
      runKey(run, index, runs.length, false),
    );
    expect(new Set(keys).size).toBe(runs.length);
  });
});

/** Nothing above may claim an embed; the meter has to be inert. */
it('meters without changing what is projected', () => {
  const doc = proseDocument(4, 80);
  const run = segmentRuns(doc)[0];
  const gauge = meter();

  expect(projectRun(run, doc, { embed: gauge.embed })).toEqual(
    projectRun(run, doc),
  );
});
