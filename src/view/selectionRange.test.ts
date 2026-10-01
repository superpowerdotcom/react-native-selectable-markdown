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
    const source = '# Title';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 1,
      span: spanOf(source, '# Title'),
      children: [textNode(source, 'Title')],
    };
    const projected = projectOnlyRun(makeDoc(source, [heading]));

    expect(mapSourceToRunRange(projected, { start: 0, end: 2 })).toBeNull();
    // The heading's text right after it maps.
    expect(mapSourceToRunRange(projected, { start: 0, end: 7 })).toEqual({
      start: 0,
      end: 5,
    });
  });

  it('returns null for a span outside the run, and for an empty one', () => {
    const source = 'Alpha.';
    const projected = projectOnlyRun(
      makeDoc(source, [plainParagraph(source, source)]),
    );

    expect(mapSourceToRunRange(projected, { start: 40, end: 50 })).toBeNull();
    expect(mapSourceToRunRange(projected, { start: 3, end: 3 })).toBeNull();
    expect(mapSourceToRunRange(projected, { start: 3, end: 4 })).toEqual({
      start: 3,
      end: 4,
    });
  });

  it('orders a reversed span and refuses a non-finite one', () => {
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

    // Idempotent: mapping back and forward again does not widen further.
    const back = mapSelectionToSource(projected, range!);
    expect(back).toEqual(spanOf(source, '&hellip;'));
    expect(mapSourceToRunRange(projected, back!)).toEqual(range);
  });

  it('maps source inside a character reference to the character it shows', () => {
    // One indivisible piece, so the '&' on screen stands for all of '&amp;'.
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

    // 'amp;' alone: shown by the '&' it belongs to.
    expect(mapSourceToRunRange(projected, { start: 5, end: 9 })).toEqual({ start: 4, end: 5 });
    expect(mapSelectionToSource(projected, { start: 4, end: 5 })).toEqual(spanOf(source, '&amp;'));
    // The whole entity plus the word after it.
    expect(
      mapSourceToRunRange(projected, {
        start: spanOf(source, '&amp;').start,
        end: spanOf(source, 'Jerry').end,
      }),
    ).toEqual({ start: 4, end: 11 });
    expect(projected.text.slice(4, 11)).toBe('& Jerry');
  });

  it('sweeps up the synthetic glyphs between two list items', () => {
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
    const whole = mapSourceToRunRange(projected, { start: 0, end: source.length });
    expect(whole).toEqual({ start: 0, end: projected.text.length });
    expect(mapSelectionToSource(projected, whole!)).toEqual({ start: 0, end: source.length });

    const range = mapSourceToRunRange(projected, {
      start: firstText.span.start,
      end: secondText.span.end,
    });
    expect(range).not.toBeNull();
    const sliced = projected.text.slice(range!.start, range!.end);
    expect(sliced.startsWith('one')).toBe(true);
    expect(sliced.endsWith('two')).toBe(true);
  });
});

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
    // Android's live tail: mounted, mapped, and refused.
    const { candidates, asked } = runCandidates(() => false);

    expect(selectSpanInRuns(candidates, second.span)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('keeps looking past a run that refuses', () => {
    // Runs can show overlapping source under `maxRunChars`.
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
    expect(selectSpanInRuns([standalone, candidates[1]], second.span)).toBe(
      true,
    );
  });

  it('asks in document order however the runs were registered', () => {
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
    expect(selectSpanInRuns(candidates, { start: 0, end: 4 })).toBe(true);
    expect(asked).toEqual([[0, 0, 4]]);
  });
});
