import type {
  BlockquoteNode,
  CodeBlockNode,
  HeadingNode,
  LinkNode,
  ListNode,
  ParagraphNode,
  TableNode,
  TextNode,
} from '../../document/nodes';
import type { ParsedDocument } from '../../document/nodes';
import { mapSelectionToSource, projectRun } from '../mapSelection';
import { segmentRuns } from '../runs';
import type { RunSegment } from '../runs';
import {
  expectTiling,
  makeDoc,
  plainParagraph,
  spanOf,
  textNode,
} from './fixtures';

function onlyRun(doc: ParsedDocument): RunSegment {
  const runs = segmentRuns(doc);
  expect(runs).toHaveLength(1);
  return runs[0];
}

describe('projectRun', () => {
  it('is deterministic and tiles the text with pieces', () => {
    const source = 'Alpha beta.\n\nGamma delta.\n\nOmega end.';
    const doc = makeDoc(source, [
      plainParagraph(source, 'Alpha beta.'),
      plainParagraph(source, 'Gamma delta.'),
      plainParagraph(source, 'Omega end.'),
    ]);
    const run = onlyRun(doc);
    const first = projectRun(run, doc);
    const second = projectRun(run, doc);

    expect(second).toEqual(first);
    expectTiling(first);
    expect(first.text).toBe(source);
    expect(first.pieces).toEqual([
      { textStart: 0, textEnd: 11, source: { start: 0, end: 11 } },
      { textStart: 11, textEnd: 13, source: null },
      { textStart: 13, textEnd: 25, source: { start: 13, end: 25 } },
      { textStart: 25, textEnd: 27, source: null },
      { textStart: 27, textEnd: 37, source: { start: 27, end: 37 } },
    ]);
  });

  it('projects heading text without markers, separated by a blank line', () => {
    const source = '## Title\n\nBody text here.';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 2,
      span: spanOf(source, '## Title'),
      children: [textNode(source, 'Title')],
    };
    const doc = makeDoc(source, [heading, plainParagraph(source, 'Body text here.')]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('Title\n\nBody text here.');
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 5, source: { start: 3, end: 8 } },
      { textStart: 5, textEnd: 7, source: null },
      { textStart: 7, textEnd: 22, source: { start: 10, end: 25 } },
    ]);
  });

  it('renders unordered lists with synthetic bullets and \\n between items', () => {
    const source = '- one\n- two\n- three';
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: { start: 0, end: source.length },
      items: [
        {
          kind: 'listItem',
          span: spanOf(source, '- one'),
          children: [plainParagraph(source, 'one')],
        },
        {
          kind: 'listItem',
          span: spanOf(source, '- two'),
          children: [plainParagraph(source, 'two')],
        },
        {
          kind: 'listItem',
          span: spanOf(source, '- three'),
          children: [plainParagraph(source, 'three')],
        },
      ],
    };
    const doc = makeDoc(source, [list]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('• one\n• two\n• three');
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 2, source: null },
      { textStart: 2, textEnd: 5, source: { start: 2, end: 5 } },
      { textStart: 5, textEnd: 8, source: null },
      { textStart: 8, textEnd: 11, source: { start: 8, end: 11 } },
      { textStart: 11, textEnd: 14, source: null },
      { textStart: 14, textEnd: 19, source: { start: 14, end: 19 } },
    ]);
  });

  it("nests a 'listMarker' mark over each item's marker glyph", () => {
    const source = '- one\n- two';
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: { start: 0, end: source.length },
      items: [
        {
          kind: 'listItem',
          span: spanOf(source, '- one'),
          children: [plainParagraph(source, 'one')],
        },
        {
          kind: 'listItem',
          span: spanOf(source, '- two'),
          children: [plainParagraph(source, 'two')],
        },
      ],
    };
    const doc = makeDoc(source, [list]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('\u2022 one\n\u2022 two');
    // One marker mark per item, covering exactly the synthetic glyph and
    // nested inside that item's 'listItem' mark — so a consumer can mute the
    // bullet without touching the item's text.
    expect(
      projected.marks.filter((mark) => mark.kind === 'listMarker'),
    ).toEqual([
      { kind: 'listMarker', start: 0, end: 2 },
      { kind: 'listMarker', start: 6, end: 8 },
    ]);
  });

  it('numbers ordered items from list.start with synthetic number glyphs', () => {
    const source = '3. a\n4. b';
    const list: ListNode = {
      kind: 'list',
      ordered: true,
      start: 3,
      tight: true,
      span: { start: 0, end: source.length },
      items: [
        {
          kind: 'listItem',
          span: spanOf(source, '3. a'),
          children: [plainParagraph(source, 'a', 3)],
        },
        {
          kind: 'listItem',
          span: spanOf(source, '4. b'),
          children: [plainParagraph(source, 'b')],
        },
      ],
    };
    const doc = makeDoc(source, [list]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('3. a\n4. b');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 3, source: null },
      { textStart: 3, textEnd: 4, source: { start: 3, end: 4 } },
      { textStart: 4, textEnd: 8, source: null },
      { textStart: 8, textEnd: 9, source: { start: 8, end: 9 } },
    ]);
  });

  it('replaces the bullet with a task glyph for task items', () => {
    const source = '- [x] done\n- [ ] todo';
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: { start: 0, end: source.length },
      items: [
        {
          kind: 'listItem',
          task: 'checked',
          span: spanOf(source, '- [x] done'),
          children: [plainParagraph(source, 'done')],
        },
        {
          kind: 'listItem',
          task: 'unchecked',
          span: spanOf(source, '- [ ] todo'),
          children: [plainParagraph(source, 'todo')],
        },
      ],
    };
    const doc = makeDoc(source, [list]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('☑ done\n☐ todo');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 2, source: null },
      { textStart: 2, textEnd: 6, source: { start: 6, end: 10 } },
      { textStart: 6, textEnd: 9, source: null },
      { textStart: 9, textEnd: 13, source: { start: 17, end: 21 } },
    ]);
  });

  it('projects blockquote content without the > chrome', () => {
    const source = 'Above.\n\n> quoted text';
    const quote: BlockquoteNode = {
      kind: 'blockquote',
      span: spanOf(source, '> quoted text'),
      children: [plainParagraph(source, 'quoted text')],
    };
    const doc = makeDoc(source, [plainParagraph(source, 'Above.'), quote]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('Above.\n\nquoted text');
    expect(projected.pieces[2]).toEqual({
      textStart: 8,
      textEnd: 19,
      source: { start: 10, end: 21 },
    });
  });

  it('pins a fenced code block piece to the literal inside the fence', () => {
    const source = '```js\nconst x = 1;\n```';
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      language: 'js',
      literal: 'const x = 1;\n',
      fenced: true,
      closed: true,
      span: { start: 0, end: source.length },
    };
    const doc = makeDoc(source, [code]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe('const x = 1;\n');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 13, source: { start: 6, end: 19 } },
    ]);
  });

  it('pins code span content inside the backticks', () => {
    const source = 'Use `npm i` now.';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'Use '),
        { kind: 'codeSpan', value: 'npm i', span: spanOf(source, '`npm i`') },
        textNode(source, ' now.'),
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('Use npm i now.');
    expect(projected.pieces[1]).toEqual({
      textStart: 4,
      textEnd: 9,
      source: { start: 5, end: 10 },
    });
  });

  it('projects tables as tab-separated cells and newline-separated rows', () => {
    const source = '| a | b |\n| - | - |\n| c | d |';
    const cell = (value: string): TableNode['header']['cells'][number] => ({
      kind: 'tableCell',
      span: spanOf(source, value),
      children: [textNode(source, value)],
    });
    const table: TableNode = {
      kind: 'table',
      align: [null, null],
      span: { start: 0, end: source.length },
      header: {
        kind: 'tableRow',
        span: spanOf(source, '| a | b |'),
        cells: [cell('a'), cell('b')],
      },
      rows: [
        {
          kind: 'tableRow',
          span: spanOf(source, '| c | d |'),
          cells: [cell('c'), cell('d')],
        },
      ],
    };
    const doc = makeDoc(source, [table]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe('a\tb\nc\td');
    expectTiling(projected);
    expect(projected.pieces.map((p) => p.source)).toEqual([
      { start: 2, end: 3 },
      null,
      { start: 6, end: 7 },
      null,
      { start: 22, end: 23 },
      null,
      { start: 26, end: 27 },
    ]);
  });

  it('keeps a decoded entity as a whole-span piece and maps alt text into images', () => {
    const source = 'Sign &copy; ![logo](https://x.io/l.png)';
    const entity: TextNode = {
      kind: 'text',
      value: '©',
      span: spanOf(source, '&copy;'),
    };
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'Sign '),
        entity,
        textNode(source, ' ', 11),
        {
          kind: 'image',
          src: 'https://x.io/l.png',
          alt: 'logo',
          span: spanOf(source, '![logo](https://x.io/l.png)'),
        },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('Sign © logo');
    // Entity: display '©' (1 unit) covers the raw '&copy;' (6 units).
    expect(projected.pieces[1]).toEqual({
      textStart: 5,
      textEnd: 6,
      source: { start: 5, end: 11 },
    });
    // Image alt is found verbatim inside the construct, so it maps 1:1.
    expect(projected.pieces[3]).toEqual({
      textStart: 7,
      textEnd: 11,
      source: { start: 14, end: 18 },
    });
  });

  it('projects a soft break as a space mapped to the source newline', () => {
    // A soft break is where the author wrapped the line, not a break they
    // asked for; CommonMark renders it as a space and so does the fallback
    // (`softBreak: () => ' '`). Hard-wrapped prose that projected '\n' here
    // rendered on the native host as forced line breaks mid-sentence.
    const source = 'line one\nline two';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'line one'),
        { kind: 'softBreak', span: { start: 8, end: 9 } },
        textNode(source, 'line two'),
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('line one line two');
    // The offset-neutrality claim, asserted rather than argued: one code unit
    // either way against the same one-unit source span, so the pieces merge
    // exactly as they did when the glyph was '\n' — one linear piece covering
    // the whole run — and the space still maps to the newline it replaced.
    expect(projected.text.length).toBe(source.length);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 17, source: { start: 0, end: 17 } },
    ]);
    expect(mapSelectionToSource(projected, { start: 8, end: 9 })).toEqual({
      start: 8,
      end: 9,
    });
  });

  it('projects a hard break as a newline: the two break kinds differ', () => {
    // The contract table in docs/SELECTION.md used to conflate them. A hard
    // break is an explicit line break in the source, so it keeps its '\n' —
    // and it is one code unit here too, so the piece table has the same shape
    // as the soft-break case above.
    const source = 'line one  \nline two';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'line one'),
        { kind: 'hardBreak', span: { start: 8, end: 11 } },
        textNode(source, 'line two'),
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('line one\nline two');
    // The '  \n' the break was written as is three units of source behind one
    // unit of display, so this piece is non-linear and maps as a unit — which
    // is why the hard break gets its own piece and the soft break did not.
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 8, source: { start: 0, end: 8 } },
      { textStart: 8, textEnd: 9, source: { start: 8, end: 11 } },
      { textStart: 9, textEnd: 17, source: { start: 11, end: 19 } },
    ]);
  });

  it('marks synthetic nodes and out-of-source spans as unmapped pieces', () => {
    const source = 'wait';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: 4 },
      incomplete: true,
      children: [
        textNode(source, 'wait'),
        { kind: 'text', value: '…', span: { start: 4, end: 5 }, synthetic: true },
        { kind: 'text', value: '**', span: { start: 4, end: 6 } },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('wait…**');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 4, source: { start: 0, end: 4 } },
      { textStart: 4, textEnd: 7, source: null },
    ]);
  });

  it('projects a thematic break as empty text with a zero-length mark', () => {
    const source = '---';
    const doc = makeDoc(source, [
      { kind: 'thematicBreak', span: { start: 0, end: 3 } },
    ]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    // No characters — a rule is chrome, not text — but the zero-length mark
    // is the anchor runDecorations turns into a drawn rule.
    expect(projected).toEqual({
      text: '',
      pieces: [],
      marks: [{ kind: 'thematicBreak', start: 0, end: 0 }],
    });
  });
});

describe('mapSelectionToSource', () => {
  const source = '- one\n- two\n- three';
  const list: ListNode = {
    kind: 'list',
    ordered: false,
    tight: true,
    span: { start: 0, end: source.length },
    items: [
      {
        kind: 'listItem',
        span: spanOf(source, '- one'),
        children: [plainParagraph(source, 'one')],
      },
      {
        kind: 'listItem',
        span: spanOf(source, '- two'),
        children: [plainParagraph(source, 'two')],
      },
      {
        kind: 'listItem',
        span: spanOf(source, '- three'),
        children: [plainParagraph(source, 'three')],
      },
    ],
  };
  const doc = makeDoc(source, [list]);
  const projected = projectRun(onlyRun(doc), doc);
  // projected.text === '• one\n• two\n• three'

  it('maps a selection inside one text piece to the exact source range', () => {
    expect(mapSelectionToSource(projected, { start: 2, end: 5 })).toEqual({
      start: 2,
      end: 5,
    });
    expect(source.slice(2, 5)).toBe('one');
  });

  it('clamps a selection that starts on a bullet glyph into the item text', () => {
    expect(mapSelectionToSource(projected, { start: 0, end: 5 })).toEqual({
      start: 2,
      end: 5,
    });
  });

  it('bridges synthetic glyphs strictly inside the selection', () => {
    expect(mapSelectionToSource(projected, { start: 3, end: 9 })).toEqual({
      start: 3,
      end: 9,
    });
    expect(source.slice(3, 9)).toBe('ne\n- t');
  });

  it('returns null for an all-synthetic selection', () => {
    expect(mapSelectionToSource(projected, { start: 0, end: 2 })).toBeNull();
    expect(mapSelectionToSource(projected, { start: 5, end: 8 })).toBeNull();
  });

  it('returns null for empty or out-of-range selections', () => {
    expect(mapSelectionToSource(projected, { start: 3, end: 3 })).toBeNull();
    expect(mapSelectionToSource(projected, { start: 100, end: 200 })).toBeNull();
    expect(mapSelectionToSource(projected, { start: -10, end: -2 })).toBeNull();
    expect(mapSelectionToSource(projected, { start: NaN, end: 4 })).toBeNull();
  });

  it('normalizes reversed selections and clamps to the text bounds', () => {
    expect(mapSelectionToSource(projected, { start: 5, end: 0 })).toEqual({
      start: 2,
      end: 5,
    });
    expect(mapSelectionToSource(projected, { start: -4, end: 3 })).toEqual({
      start: 2,
      end: 3,
    });
    expect(mapSelectionToSource(projected, { start: 14, end: 999 })).toEqual({
      start: 14,
      end: 19,
    });
  });

  it('expands to the whole construct for non-linear pieces', () => {
    const entitySource = 'Sign &copy; here';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: entitySource.length },
      children: [
        textNode(entitySource, 'Sign '),
        { kind: 'text', value: '©', span: spanOf(entitySource, '&copy;') },
        textNode(entitySource, ' here'),
      ],
    };
    const entityDoc = makeDoc(entitySource, [para]);
    const entityProjected = projectRun(onlyRun(entityDoc), entityDoc);

    expect(entityProjected.text).toBe('Sign © here');
    expect(
      mapSelectionToSource(entityProjected, { start: 5, end: 6 }),
    ).toEqual({ start: 5, end: 11 });
    expect(
      mapSelectionToSource(entityProjected, { start: 2, end: 6 }),
    ).toEqual({ start: 2, end: 11 });
    expect(entitySource.slice(2, 11)).toBe('gn &copy;');
  });

  it('skips synthetic streaming nodes entirely', () => {
    const tailSource = 'wait';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: 4 },
      children: [
        textNode(tailSource, 'wait'),
        { kind: 'text', value: '…', span: { start: 4, end: 5 }, synthetic: true },
      ],
    };
    const tailDoc = makeDoc(tailSource, [para]);
    const tailProjected = projectRun(onlyRun(tailDoc), tailDoc);

    expect(tailProjected.text).toBe('wait…');
    expect(mapSelectionToSource(tailProjected, { start: 0, end: 5 })).toEqual({
      start: 0,
      end: 4,
    });
    expect(mapSelectionToSource(tailProjected, { start: 4, end: 5 })).toBeNull();
  });
});
