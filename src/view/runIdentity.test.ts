/**
 * The two identities a streaming document must not recompute into something
 * new on every commit: a run's React key, and the key a reported embed rect is
 * filed under.
 *
 * Both had the same defect and the same symptom class — an identity derived
 * from a value that moves whenever the stream settles a block, so React (or
 * the rect map) threw away state that was still perfectly valid. The tail run
 * was remounted once per settled paragraph, taking any live selection with it;
 * every reported embed rect was dropped on the same event, and since the hosts
 * only re-report a rect that MOVED, a settled card unmounted mid-stream and
 * never came back.
 */

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

/**
 * The runs `SelectableMarkdown` would segment for one frame — including the
 * `liveTail` split it asks for while the stream is running, which is what
 * keeps the tail run in existence when a chunk ends on a completed blank line
 * and every block is momentarily settled.
 */
function runsAt(
  doc: ParsedDocument,
  settledUntil: number,
  streaming = true,
): RunSegment[] {
  return segmentRuns(doc, { settledUntil, liveTail: streaming });
}

/**
 * The keys `SelectableMarkdown` would render for one frame. The flag is
 * whether a STREAM is driving the document — true for the whole life of a
 * session-backed one, settled included — not whether a given run is unsettled.
 */
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
    // The settled boundary after each block: what a stream reports as blocks
    // freeze, in order.
    const boundaries = doc.blocks.map((block) => block.span.end);
    expect(boundaries.length).toBeGreaterThan(2);

    const tailStarts: number[] = [];
    for (const settledUntil of boundaries.slice(0, -1)) {
      const runs = runsAt(doc, settledUntil);
      const tail = runs[runs.length - 1];
      tailStarts.push(tail.span.start);
      expect(keysAt(doc, settledUntil)).toContain('run:tail');
    }

    // The span the key used to be built from really does move — without this
    // the case above would pass for the wrong reason.
    expect(new Set(tailStarts).size).toBe(tailStarts.length);
  });

  test('the settled run keeps its span key, so its host is never recycled', () => {
    const doc = document();
    for (const settledUntil of doc.blocks.map((block) => block.span.end)) {
      expect(keysAt(doc, settledUntil)[0]).toBe('run:0');
    }
  });

  test('a full settle mid-stream does not take the tail run with it', () => {
    // THE REPRO: a chunk that ends on a completed blank line settles the whole
    // document, so nothing is unsettled and the settled/tail break has nothing
    // to break at. Without `liveTail` the document collapses to ONE run for as
    // long as the next chunk takes to arrive, 'run:tail' disappears, and the
    // tail host — with whatever the reader had selected in it — is unmounted
    // and recycled. It happens several times per message.
    const doc = document();
    const lastBlock = doc.blocks[doc.blocks.length - 1];
    const everythingSettled = doc.source.length;
    expect(lastBlock.span.end).toBeLessThanOrEqual(everythingSettled);

    // The frame before: the last block is still unsettled.
    const before = keysAt(doc, lastBlock.span.start);
    expect(before[before.length - 1]).toBe('run:tail');

    // The collapse frame, keyed the same way — same count, same keys, so no
    // host mounts and none is destroyed.
    const collapsed = keysAt(doc, everythingSettled);
    expect(collapsed).toEqual(before);

    // And the tail run really is the last block alone, still selectable: this
    // is a run boundary, not a claim that the text is still being repaired.
    const runs = runsAt(doc, everythingSettled);
    expect(runs.length).toBeGreaterThan(1);
    const tail = runs[runs.length - 1];
    expect(tail.blocks).toEqual([lastBlock]);
    expect(tail.selectable).toBe(true);
    expect(runs.every((run) => run.selectable)).toBe(true);

    // Without the split it is one run, which is the shape that killed the
    // host — the guard that keeps this test honest.
    expect(segmentRuns(doc, { settledUntil: everythingSettled })).toHaveLength(
      1,
    );
  });

  test('the run that was the tail keeps its key when the stream ends', () => {
    // A standalone block in front of the last prose run means the tail does
    // NOT merge into the settled prefix at the end of the stream: the run goes
    // on existing unchanged. Keyed on "is this run unsettled" its key flipped
    // 'run:tail' -> `run:${start}` the instant streaming stopped, remounting
    // the host — destroying a selection, and blanking any embed overlay in it
    // for a layout pass — exactly when the reader is finally free to select.
    const withIsland = parseDocument(
      'Intro.\n\n![alt](https://example.com/a.png)\n\nTail prose.\n',
      presets.everything,
    );
    const runs = runsAt(withIsland, withIsland.blocks[0].span.end);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs[runs.length - 1].standalone).toBe(false);

    const streamingKeys = keysAt(withIsland, withIsland.blocks[0].span.end);
    // Settled: the stream is over, but the document still came from one.
    const settledKeys = keysAt(withIsland, withIsland.source.length, true, false);

    expect(streamingKeys[streamingKeys.length - 1]).toBe('run:tail');
    expect(settledKeys).toEqual(streamingKeys);
  });

  test('a document rendered from a plain source string is keyed on spans', () => {
    // No stream, no tail: `runKey`'s flag is "a stream is driving this", and a
    // static document that grows (a consumer re-rendering with a longer
    // `source`) must not re-key the run that used to be last.
    const doc = document();
    const keys = keysAt(doc, doc.source.length, false, false);
    expect(keys).not.toContain('run:tail');
    expect(keys[0]).toBe('run:0');
  });

  test('before anything settles the single run keeps its span key', () => {
    // A run that is both first and last is the whole document. Keyed
    // 'run:tail' it would be matched to the TAIL at the first split and the
    // settled prefix — the host that goes on holding most of the message —
    // would mount fresh; keyed on its span it is matched to the settled run it
    // grows into, and the tail is the one that mounts.
    const doc = document();
    expect(keysAt(doc, 0)).toEqual(['run:0']);
    expect(keysAt(doc, doc.blocks[0].span.end)).toEqual(['run:0', 'run:tail']);
  });

  test('keys are unique within a frame, tail region included', () => {
    // An unsettled STANDALONE block ahead of the tail prose (a paragraph
    // carrying an image) gives two unsettled runs in one frame; only the last
    // may answer to 'run:tail', or React sees a duplicate key.
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
    // At the end of a stream a plain prose document's runs merge into one,
    // whose start is the settled run's start: keying it 'run:tail' would have
    // handed the whole document to the tail's short-lived host and unmounted
    // the long-lived one holding everything above it. The count falling to 1
    // is what puts the key back on the span, which is why the rule is
    // positional AND `count > 1`.
    const doc = document();
    const finished = keysAt(doc, doc.source.length, true, false);

    expect(finished).toEqual(['run:0']);
  });
});

/*
 * Rect keying needs no parser: it reads the projection entries alone.
 */
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
    // The settle case: the run grows, so it is reprojected and the projection
    // object is new — but the embed is in the settled prefix, its source span
    // is unchanged, and no host will ever re-report a rect that did not move.
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
    // Ids are per-projection ordinals: when a claim ahead of this one appears,
    // the same id belongs to a different node. Filing by span is what keeps
    // the rect with its own card.
    const first = nodeAt(23, 44);
    const second = nodeAt(80, 96);
    const rects = applyEmbedRect(NO_EMBED_RECTS, [entry(0, 12, first)], layout(0, 40));
    const renumbered = [entry(0, 4, second), entry(1, 40, first)];

    expect(rects.get(embedRectKey(renumbered[0]))).toBeUndefined();
    expect(rects.get(embedRectKey(renumbered[1]))).toBeDefined();
  });

  test('an out-of-range or repeated report changes nothing, so nothing re-renders', () => {
    const embeds = [entry(0, 12, nodeAt(23, 44))];
    const rects = applyEmbedRect(NO_EMBED_RECTS, embeds, layout(0, 40));

    expect(applyEmbedRect(rects, embeds, layout(0, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(1, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(-1, 40))).toBe(rects);
    expect(applyEmbedRect(rects, embeds, layout(0.5, 40))).toBe(rects);
    // A rect that actually moved does replace the held one.
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

    // Repair takes the second claim away; the next report rebuilds the map
    // from the embeds that are left.
    rects = applyEmbedRect(rects, [entry(0, 12, held)], layout(0, 44));

    expect([...rects.keys()]).toEqual([embedRectKey(entry(0, 12, held))]);
  });
});
