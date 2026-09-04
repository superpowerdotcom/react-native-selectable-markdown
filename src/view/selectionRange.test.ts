/**
 * `mapSourceToRunRange` — the source → display direction of the projection,
 * which is what the imperative `setSelection(span)` runs on.
 *
 * The tests are paired with `mapSelectionToSource` throughout, because the
 * only useful statement about this function is how it relates to the one that
 * already exists: where it round-trips exactly, and where it cannot. Documents
 * are hand-built with the shared selection fixtures — no parser is involved,
 * so a failure here points at the mapping rather than at md4c.
 */

import type {
  Block,
  HeadingNode,
  ListNode,
  ParagraphNode,
  ParsedDocument,
  TextNode,
} from '../document/nodes';
import { mapSelectionToSource, projectRun } from '../selection/mapSelection';
import type { ProjectedRun } from '../selection/mapSelection';
import {
  makeDoc,
  plainParagraph,
  spanOf,
  textNode,
} from '../selection/__tests__/fixtures';
import { segmentRuns } from '../selection/runs';
import { mapSourceToRunRange, selectSpanInRuns } from './selectionRange';
import type { RunSelectionCandidate } from './selectionRange';

function projectOnlyRun(doc: ParsedDocument): ProjectedRun {
  const runs = segmentRuns(doc);
  expect(runs).toHaveLength(1);
  return projectRun(runs[0], doc);
}

describe('mapSourceToRunRange', () => {
  it('maps a span inside one paragraph to the exact display range', () => {
    const source = 'Alpha beta gamma.';
    const projected = projectOnlyRun(
      makeDoc(source, [plainParagraph(source, source)]),
    );

    const span = spanOf(source, 'beta');
    expect(mapSourceToRunRange(projected, span)).toEqual({
      start: 6,
      end: 10,
    });
    // The projection is the source verbatim here, so the display slice is the
    // source slice — the property every other case is measured against.
    expect(projected.text.slice(6, 10)).toBe('beta');
  });

  it('round-trips a plain-prose selection through both directions', () => {
    const source = 'First para.\n\nSecond para.';
    const projected = projectOnlyRun(
      makeDoc(source, [
        plainParagraph(source, 'First para.'),
        plainParagraph(source, 'Second para.'),
      ]),
    );

    const selection = { start: 6, end: 18 };
    const span = mapSelectionToSource(projected, selection);
    expect(span).not.toBeNull();
    expect(mapSourceToRunRange(projected, span!)).toEqual(selection);
  });

  it('spans the hidden syntax between two pieces rather than returning two ranges', () => {
    // A selection is one contiguous range in one text view, so a source span
    // that skips over characters the projection does not show — a heading's
    // '# ' and the blank line after it — has to come back as the hull.
    const source = '# Title\n\nBody text.';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 1,
      span: spanOf(source, '# Title'),
      children: [textNode(source, 'Title')],
    };
    const projected = projectOnlyRun(
      makeDoc(source, [heading, plainParagraph(source, 'Body text.')]),
    );

    expect(projected.text).toBe('Title\n\nBody text.');
    // From inside the heading text to inside the body, across the marker.
    const range = mapSourceToRunRange(projected, {
      start: spanOf(source, 'Title').start,
      end: spanOf(source, 'Body').end,
    });
    expect(range).toEqual({ start: 0, end: 11 });
    expect(projected.text.slice(0, 11)).toBe('Title\n\nBody');
  });

  it('returns null for a span that covers only unshown syntax', () => {
    // The '# ' of a heading projects no character at all, so there is nothing
    // to select. Returning an empty range at the nearest piece would be a
    // plausible-looking lie; null is the honest answer, and it is what makes
    // `SelectableMarkdownHandle.setSelection` able to report false.
    const source = '# Title';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 1,
      span: spanOf(source, '# Title'),
      children: [textNode(source, 'Title')],
    };
    const projected = projectOnlyRun(makeDoc(source, [heading]));

    expect(mapSourceToRunRange(projected, { start: 0, end: 2 })).toBeNull();
  });

  it('returns null for a span outside the run, and for an empty one', () => {
    const source = 'Alpha.';
    const projected = projectOnlyRun(
      makeDoc(source, [plainParagraph(source, source)]),
    );

    expect(mapSourceToRunRange(projected, { start: 40, end: 50 })).toBeNull();
    expect(mapSourceToRunRange(projected, { start: 3, end: 3 })).toBeNull();
  });

  it('orders a reversed span and refuses a non-finite one', () => {
    // Reachable from a consumer's imperative call with any two numbers in it,
    // so neither may throw.
    const source = 'Alpha beta.';
    const projected = projectOnlyRun(
      makeDoc(source, [plainParagraph(source, source)]),
    );

    expect(mapSourceToRunRange(projected, { start: 10, end: 6 })).toEqual({
      start: 6,
      end: 10,
    });
    expect(
      mapSourceToRunRange(projected, { start: Number.NaN, end: 4 }),
    ).toBeNull();
    expect(
      mapSourceToRunRange(projected, {
        start: 0,
        end: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it('takes a whole indivisible piece when a span lands inside one', () => {
    // '&hellip;' decodes to a character the source never spells, so the
    // projector cannot align the two and the piece has no interior
    // correspondence in either direction. The forward mapping already pins
    // the whole piece; this is the same rule mirrored, and it is why
    // `setSelection` documents that the resulting selection can be wider than
    // the span asked for.
    const source = 'a &hellip; b';
    const paragraph: ParagraphNode = {
      kind: 'paragraph',
      span: spanOf(source, source),
      children: [
        { kind: 'text', value: 'a ', span: spanOf(source, 'a ') },
        { kind: 'text', value: '…', span: spanOf(source, '&hellip;') },
        { kind: 'text', value: ' b', span: spanOf(source, ' b') },
      ],
    };
    const projected = projectOnlyRun(makeDoc(source, [paragraph]));
    expect(projected.text).toBe('a … b');

    // Four of the eight source characters of '&hellip;'.
    const inside = { start: 4, end: 8 };
    const range = mapSourceToRunRange(projected, inside);
    expect(range).toEqual({ start: 2, end: 3 });
    expect(projected.text.slice(2, 3)).toBe('…');

    // And the widening is idempotent: mapping the result back and forward
    // again lands on the same range rather than growing each time.
    const back = mapSelectionToSource(projected, range!);
    expect(back).toEqual(spanOf(source, '&hellip;'));
    expect(mapSourceToRunRange(projected, back!)).toEqual(range);
  });

  it('drops source that projects nothing, keeping only what is on screen', () => {
    // The linear-alignment split means an escape or a spelled-out entity
    // costs only itself: '&amp;' is projected as pieces that cover the '&'
    // and skip 'amp;', so a span landing purely in those four characters has
    // no display range at all — the same "null means unshowable" answer as a
    // heading marker, one construct down.
    const source = 'Tom &amp; Jerry';
    const paragraph: ParagraphNode = {
      kind: 'paragraph',
      span: spanOf(source, source),
      children: [
        { kind: 'text', value: 'Tom ', span: spanOf(source, 'Tom ') },
        { kind: 'text', value: '&', span: spanOf(source, '&amp;') },
        { kind: 'text', value: ' Jerry', span: spanOf(source, ' Jerry') },
      ],
    };
    const projected = projectOnlyRun(makeDoc(source, [paragraph]));
    expect(projected.text).toBe('Tom & Jerry');

    // 'amp;' alone: shown by nothing.
    expect(mapSourceToRunRange(projected, { start: 5, end: 9 })).toBeNull();
    // The whole entity plus the word after it: the hull covers the '&' and
    // reaches into ' Jerry'.
    expect(
      mapSourceToRunRange(projected, {
        start: spanOf(source, '&amp;').start,
        end: spanOf(source, 'Jerry').end,
      }),
    ).toEqual({ start: 4, end: 11 });
    expect(projected.text.slice(4, 11)).toBe('& Jerry');
  });

  it('sweeps up the synthetic glyphs between two list items', () => {
    // A bullet is a piece with no source, so no span can ask for it — but the
    // hull covers it whenever the span touches real text on both sides, which
    // is what makes a programmatic selection across a list look like one
    // selection rather than two.
    const source = '- one\n- two';
    const firstText = textNode(source, 'one');
    const secondText = textNode(source, 'two');
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: spanOf(source, source),
      items: [
        {
          kind: 'listItem',
          span: spanOf(source, '- one'),
          children: [
            {
              kind: 'paragraph',
              span: firstText.span,
              children: [firstText as TextNode],
            },
          ],
        },
        {
          kind: 'listItem',
          span: spanOf(source, '- two'),
          children: [
            {
              kind: 'paragraph',
              span: secondText.span,
              children: [secondText as TextNode],
            },
          ],
        },
      ],
    };
    const projected = projectOnlyRun(makeDoc(source, [list as Block]));

    const range = mapSourceToRunRange(projected, {
      start: firstText.span.start,
      end: secondText.span.end,
    });
    expect(range).not.toBeNull();
    // The glyphs between the two items are inside the hull, so the display
    // slice is contiguous and starts at 'one'.
    const sliced = projected.text.slice(range!.start, range!.end);
    expect(sliced.startsWith('one')).toBe(true);
    expect(sliced.endsWith('two')).toBe(true);
  });
});

/**
 * `selectSpanInRuns` — the walk behind `SelectableMarkdownHandle.setSelection`.
 *
 * The defect these pin: the walk used to return true the moment a run MAPPED
 * the span, without ever learning whether the host took it. Both native hosts
 * refuse the command on a non-selectable text view, and JS makes runs
 * non-selectable on purpose — the unsettled streaming tail on Android, and any
 * run a consumer rendered `selectable={false}` — so mid-stream on Android
 * `setSelection` over the live tail reported success for a selection nobody
 * made. A binary older than the selection commands did the same thing.
 */
describe('selectSpanInRuns', () => {
  const source = 'Alpha beta gamma.\n\nDelta epsilon zeta.';
  const first = plainParagraph(source, 'Alpha beta gamma.');
  const second = plainParagraph(source, 'Delta epsilon zeta.');
  const doc = makeDoc(source, [first as Block, second as Block]);

  /** One run per block, so a span can be shown by exactly one of them. */
  function runCandidates(
    takes: (index: number) => boolean,
  ): { candidates: RunSelectionCandidate[]; asked: number[][] } {
    const asked: number[][] = [];
    const candidates = doc.blocks.map((block, index) => {
      const oneBlock = makeDoc(source, [block]);
      const projected = projectRun(segmentRuns(oneBlock)[0], oneBlock);
      return {
        span: block.span,
        projected,
        host: {
          current: {
            setSelection(start: number, end: number): boolean {
              asked.push([index, start, end]);
              return takes(index);
            },
          },
        },
      };
    });
    return { candidates, asked };
  }

  it('selects in the run that shows the span, and says so', () => {
    const { candidates, asked } = runCandidates(() => true);

    expect(selectSpanInRuns(candidates, second.span)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBe(1);
  });

  it('reports false when the run that shows the span refuses it', () => {
    // Android, mid-stream, span inside the live tail: the host is mounted and
    // the mapping succeeds, and nothing is selected.
    const { candidates, asked } = runCandidates(() => false);

    expect(selectSpanInRuns(candidates, second.span)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('keeps looking past a run that refuses', () => {
    // Reachable under `maxRunChars`, where several runs can show overlapping
    // source: a refusal must not end the search.
    const { candidates, asked } = runCandidates((index) => index === 1);
    const whole = { start: 0, end: source.length };

    expect(selectSpanInRuns(candidates, whole)).toBe(true);
    expect(asked.map((call) => call[0])).toEqual([0, 1]);
  });

  it('skips a standalone run and one that has not committed', () => {
    const { candidates } = runCandidates(() => true);
    const standalone = { ...candidates[0], projected: null };
    const uncommitted = { ...candidates[1], host: { current: null } };

    expect(selectSpanInRuns([standalone, uncommitted], second.span)).toBe(
      false,
    );
  });

  it('asks in document order however the runs were registered', () => {
    // A registry iterates in MOUNT order, and a run that remounted mid-stream
    // sits at the end of it.
    const { candidates, asked } = runCandidates(() => false);
    const whole = { start: 0, end: source.length };

    selectSpanInRuns([candidates[1], candidates[0]], whole);
    expect(asked.map((call) => call[0])).toEqual([0, 1]);
  });

  it('refuses a non-finite span without asking anyone', () => {
    const { candidates, asked } = runCandidates(() => true);

    expect(
      selectSpanInRuns(candidates, { start: Number.NaN, end: 4 }),
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});
