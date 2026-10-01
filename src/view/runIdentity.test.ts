import type { AnyNode, ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import { presets } from '../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import type { ProjectedRunEmbed } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { RunSegment } from '../selection/runs';
import {
  NO_EMBED_RECTS,
  applyEmbedRect,
  embedRectKey,
  runKey,
} from './runIdentity';

linkNativeEngineAsDefault();

function runsAt(
  doc: ParsedDocument,
  settledUntil: number,
  streaming = true,
): RunSegment[] {
  return segmentRuns(doc, { settledUntil, liveTail: streaming });
}

/** `streamed`: a stream drives the document, finished or not; `streaming`: it is still running. */
function keysAt(
  doc: ParsedDocument,
  settledUntil: number,
  streamed = true,
  streaming = streamed,
): string[] {
  const runs = runsAt(doc, settledUntil, streaming);
  return runs.map((run, index) => runKey(run, index, runs.length, streamed));
}

describeNative('runKey', () => {
  const source = 'One para.\n\nTwo para.\n\nThree para.\n';
  const document = (): ParsedDocument => parseDocument(source, presets.everything);

  test('the tail keeps one key while its span start walks the document', () => {
    const doc = document();
    const boundaries = doc.blocks.map((block) => block.span.end);
    expect(boundaries.length).toBeGreaterThan(2);

    const tailStarts: number[] = [];
    for (const settledUntil of boundaries.slice(0, -1)) {
      const runs = runsAt(doc, settledUntil);
      const tail = runs[runs.length - 1];
      tailStarts.push(tail.span.start);
      expect(keysAt(doc, settledUntil)).toContain('run:tail');
    }

    // Guard: a span-based key really would have moved.
    expect(new Set(tailStarts).size).toBe(tailStarts.length);
  });

  test('the settled run keeps its span key, so its host is never recycled', () => {
    const doc = document();
    for (const settledUntil of doc.blocks.map((block) => block.span.end)) {
      expect(keysAt(doc, settledUntil)[0]).toBe('run:0');
    }
  });

  test('a full settle mid-stream does not take the tail run with it', () => {
    // A chunk ending on a completed blank line settles everything; without `liveTail` that is one run.
    const doc = document();
    const lastBlock = doc.blocks[doc.blocks.length - 1];
    const everythingSettled = doc.source.length;
    expect(lastBlock.span.end).toBeLessThanOrEqual(everythingSettled);

    const before = keysAt(doc, lastBlock.span.start);
    expect(before[before.length - 1]).toBe('run:tail');

    const collapsed = keysAt(doc, everythingSettled);
    expect(collapsed).toEqual(before);

    const runs = runsAt(doc, everythingSettled);
    expect(runs.length).toBeGreaterThan(1);
    const tail = runs[runs.length - 1];
    expect(tail.blocks).toEqual([lastBlock]);
    expect(tail.selectable).toBe(true);
    expect(runs.every((run) => run.selectable)).toBe(true);

    // Guard: without the split this is one run.
    expect(segmentRuns(doc, { settledUntil: everythingSettled })).toHaveLength(
      1,
    );
  });

  test('the run that was the tail keeps its key when the stream ends', () => {
    const withIsland = parseDocument(
      'Intro.\n\n![alt](https://example.com/a.png)\n\nTail prose.\n',
      presets.everything,
    );
    const runs = runsAt(withIsland, withIsland.blocks[0].span.end);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs[runs.length - 1].standalone).toBe(false);

    const streamingKeys = keysAt(withIsland, withIsland.blocks[0].span.end);
    const settledKeys = keysAt(withIsland, withIsland.source.length, true, false);

    expect(streamingKeys[streamingKeys.length - 1]).toBe('run:tail');
    expect(settledKeys).toEqual(streamingKeys);
  });

  test('a document rendered from a plain source string is keyed on spans', () => {
    const doc = document();
    const keys = keysAt(doc, doc.source.length, false, false);
    expect(keys).not.toContain('run:tail');
    expect(keys[0]).toBe('run:0');
  });

  test('before anything settles the single run keeps its span key', () => {
    const doc = document();
    expect(keysAt(doc, 0)).toEqual(['run:0']);
    expect(keysAt(doc, doc.blocks[0].span.end)).toEqual(['run:0', 'run:tail']);
  });

  test('keys are unique within a frame, tail region included', () => {
    const withIsland = parseDocument(
      'Intro.\n\n![alt](https://example.com/a.png)\n\nTail prose still growing',
      presets.everything,
    );
    const settledUntil = withIsland.blocks[0].span.end;
    const runs = runsAt(withIsland, settledUntil);
    const unsettled = runs.filter((run) => run.span.end > settledUntil);
    expect(unsettled.length).toBeGreaterThan(1);

    const keys = keysAt(withIsland, settledUntil);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => key === 'run:tail')).toHaveLength(1);
    expect(keys[keys.length - 1]).toBe('run:tail');
  });

  test('a document that merges into one run at the end is keyed on its span', () => {
    const doc = document();
    const finished = keysAt(doc, doc.source.length, true, false);

    expect(finished).toEqual(['run:0']);
  });
});

describe('embed rects', () => {
  const nodeAt = (start: number, end: number): AnyNode =>
    ({ kind: 'link', span: { start, end } }) as AnyNode;

  const entry = (
    embedId: number,
    textStart: number,
    node: AnyNode,
  ): ProjectedRunEmbed => ({
    embedId,
    start: textStart,
    end: textStart + 1,
    node,
    content: { width: 200, height: 80 },
  });

  const layout = (embedId: number, y: number) => ({
    embedId,
    x: 0,
    y,
    width: 200,
    height: 80,
  });

  test('a rect survives a reprojection that keeps the node', () => {
    const claimed = nodeAt(23, 44);
    const before = [entry(0, 12, claimed)];
    const after = [entry(0, 12, nodeAt(23, 44)), entry(1, 90, nodeAt(80, 96))];

    const rects = applyEmbedRect(NO_EMBED_RECTS, before, layout(0, 40));

    expect(rects.get(embedRectKey(after[0]))).toEqual({
      x: 0,
      y: 40,
      width: 200,
      height: 80,
    });
  });

  test('an id that moved to another node does not position the old overlay', () => {
    const first = nodeAt(23, 44);
    const second = nodeAt(80, 96);
    const rects = applyEmbedRect(NO_EMBED_RECTS, [entry(0, 12, first)], layout(0, 40));
    const renumbered = [entry(0, 4, second), entry(1, 40, first)];

    expect(rects.get(embedRectKey(renumbered[0]))).toBeUndefined();
    expect(rects.get(embedRectKey(renumbered[1]))).toEqual({
      x: 0,
      y: 40,
      width: 200,
      height: 80,
    });
  });

  test('an out-of-range or repeated report changes nothing, so nothing re-renders', () => {
    const embeds = [entry(0, 12, nodeAt(23, 44))];
    const rects = applyEmbedRect(NO_EMBED_RECTS, embeds, layout(0, 40));

    expect(applyEmbedRect(rects, embeds, layout(0, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(1, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(-1, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(0.5, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(0, 41))).not.toBe(rects);
  });

  test('a retracted embed loses its rect rather than lingering forever', () => {
    const held = nodeAt(23, 44);
    const gone = nodeAt(80, 96);
    let rects = applyEmbedRect(NO_EMBED_RECTS, [entry(0, 12, held)], layout(0, 40));
    rects = applyEmbedRect(
      rects,
      [entry(0, 12, held), entry(1, 30, gone)],
      layout(1, 90),
    );
    expect(rects.size).toBe(2);

    rects = applyEmbedRect(rects, [entry(0, 12, held)], layout(0, 44));

    expect([...rects.keys()]).toEqual(['23:44']);
  });
});

describeNative('standalone tail identity', () => {
  test('appending prose preserves the standalone host key', () => {
    const before = parseDocument('first\n\n||secret||', presets.everything);
    const after = parseDocument('first\n\n||secret||\n\nnext', presets.everything);
    const standaloneKey = (doc: ParsedDocument) => {
      const runs = segmentRuns(doc);
      const index = runs.findIndex(run => run.standalone);
      return runKey(runs[index], index, runs.length, true);
    };
    expect(standaloneKey(before)).toBe('run:7');
    expect(standaloneKey(after)).toBe('run:7');
  });
});
