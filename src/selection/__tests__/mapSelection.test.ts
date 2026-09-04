import type {
  Block,
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
import type { EmbedLookup, RunSegment } from '../runs';
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

  it('replaces the ORDINAL too when an ordered item is a task', () => {
    // `item.task` is tested before `node.ordered`, so an ordered task item
    // projects the checkbox alone and its number is gone from the display.
    // The ordinal is still in the source, so copying the item yields it; what
    // the reader sees is one marker rather than two.
    const source = '1. [x] done\n2. [ ] todo';
    const list: ListNode = {
      kind: 'list',
      ordered: true,
      start: 1,
      tight: true,
      span: { start: 0, end: source.length },
      items: [
        {
          kind: 'listItem',
          task: 'checked',
          span: spanOf(source, '1. [x] done'),
          children: [plainParagraph(source, 'done')],
        },
        {
          kind: 'listItem',
          task: 'unchecked',
          span: spanOf(source, '2. [ ] todo'),
          children: [plainParagraph(source, 'todo')],
        },
      ],
    };
    const doc = makeDoc(source, [list]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('\u2611 done\n\u2610 todo');
    expect(projected.text).not.toContain('1.');
    expect(
      projected.marks.filter((mark) => mark.kind === 'listMarker'),
    ).toEqual([
      { kind: 'listMarker', start: 0, end: 2 },
      { kind: 'listMarker', start: 7, end: 9 },
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

  it('pins a fenced code block past its info string, not inside it', () => {
    // The node's source slice opens with the fence line, so a body that also
    // occurs inside the INFO STRING used to win the search: this block pinned
    // to the "js\n" of "```js\n" instead of to the code. The lengths matched,
    // so the piece read as linear and every offset in the block mapped one
    // construct to the left — copying the block duplicated the code line and
    // dropped the opening fence.
    const source = '```js\njs\n```';
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      language: 'js',
      literal: 'js\n',
      fenced: true,
      closed: true,
      span: { start: 0, end: source.length },
    };
    const doc = makeDoc(source, [code]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe('js\n');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 3, source: { start: 6, end: 9 } },
    ]);
    expect(source.slice(6, 9)).toBe('js\n');
  });

  it('pins an indented code block from the start of its slice', () => {
    // The fence-line skip is for FENCED blocks only: an indented block has no
    // fence line, and skipping its first line would lose the first line of
    // the code.
    const source = '    js\n    js\n';
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      literal: 'js\njs\n',
      fenced: false,
      closed: true,
      span: { start: 0, end: source.length },
    };
    const doc = makeDoc(source, [code]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe('js\njs\n');
    // The literal is nowhere verbatim (the source indents every line), so it
    // is covered by one linear piece per line, each pinned past its indent.
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 3, source: { start: 4, end: 7 } },
      { textStart: 3, textEnd: 6, source: { start: 11, end: 14 } },
    ]);
    expect(source.slice(4, 7)).toBe('js\n');
  });

  it('never claims a whole-span pin is linear when the indent moved', () => {
    // CommonMark example 1, and the shape that made this a correctness bug
    // rather than a granularity one. The slice keeps the indent and drops the
    // trailing newline (`widenCodeBlock`); md4c's literal drops the indent
    // and keeps the newline. ONE LEADING TAB FOR ONE TRAILING NEWLINE, so the
    // two are the same length — and a piece whose display length equals its
    // source length is exactly what `mapSelectionToSource` maps through one
    // for one. Pinned to the whole span, every offset in the block came back
    // one character to the left.
    const source = '\tfoo\tbaz\t\tbim\n';
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      literal: 'foo\tbaz\t\tbim\n',
      fenced: false,
      closed: true,
      // What the decoder produces: the indent in, the trailing newline out.
      span: { start: 0, end: source.length - 1 },
    };
    const doc = makeDoc(source, [code]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe('foo\tbaz\t\tbim\n');
    expectTiling(projected);
    // One piece, pinned PAST the tab, and indivisible (13 display characters
    // for 12 source ones) because the trailing newline is not in the slice.
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 13, source: { start: 1, end: 13 } },
    ]);

    // The selection that used to come back shifted.
    expect(mapSelectionToSource(projected, { start: 0, end: 3 })).toEqual({
      start: 1,
      end: 13,
    });
    expect(source.slice(1, 13)).toBe('foo\tbaz\t\tbim');
  });

  it('maps a synthesized indent to no source at all', () => {
    // CommonMark example 274: `1.      indented code` gives the code block a
    // slice starting at the content, and md4c SYNTHESIZES one leading space
    // for the indent columns left over after the item's own indent. That
    // space is on screen and in no slice — a glyph, like a bullet.
    //
    // Matching it against the space inside `indented code` is what a resync
    // that only ever moves the source cursor does, and it skipped eight real
    // characters to get there: the whole block then mapped three to the
    // right, silently, because the pieces still tiled and still looked
    // linear.
    const source = '1.      indented code\n';
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      literal: ' indented code\n',
      fenced: false,
      closed: true,
      span: { start: 8, end: 21 },
    };
    const doc = makeDoc(source, [code]);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(projected.text).toBe(' indented code\n');
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 1, source: null },
      { textStart: 1, textEnd: 15, source: { start: 8, end: 21 } },
    ]);
    expect(source.slice(8, 21)).toBe('indented code');

    // A selection inside the code maps into the code, not past it.
    const at = projected.text.indexOf('code');
    expect(
      mapSelectionToSource(projected, { start: at, end: at + 4 }),
    ).toEqual({ start: 8, end: 21 });
  });

  it('splits a text node around an escape, so the escape costs only itself', () => {
    // The native decoder merges an escape's text events into ONE text node
    // over the whole run, with the backslash gone from `value` — in plain
    // prose that node is the entire paragraph. Pinning it whole made every
    // selection in the paragraph copy the whole paragraph.
    const source = 'The pattern \\*.log matches every log file.';
    const display = 'The pattern *.log matches every log file.';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        { kind: 'text', value: display, span: { start: 0, end: source.length } },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe(display);
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 12, source: { start: 0, end: 12 } },
      {
        textStart: 12,
        textEnd: display.length,
        source: { start: 13, end: source.length },
      },
    ]);

    // A selection past the escape maps to itself, not to the paragraph.
    const at = display.indexOf('every');
    expect(
      mapSelectionToSource(projected, { start: at, end: at + 5 }),
    ).toEqual({ start: at + 1, end: at + 6 });
    expect(source.slice(at + 1, at + 6)).toBe('every');
  });

  it('splits a text node around an entity the source spells out', () => {
    // `&amp;` decodes to a character the slice already contains, so both
    // halves stay linear and only the entity itself is skipped.
    const source = 'Tom &amp; Jerry';
    const display = 'Tom & Jerry';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        { kind: 'text', value: display, span: { start: 0, end: source.length } },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe(display);
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 5, source: { start: 0, end: 5 } },
      { textStart: 5, textEnd: 11, source: { start: 9, end: 15 } },
    ]);

    // Selecting across the entity bridges it: the copied markdown is the
    // entity plus what follows, which re-parses to exactly what was selected.
    expect(mapSelectionToSource(projected, { start: 4, end: 7 })).toEqual({
      start: 4,
      end: 11,
    });
    expect(source.slice(4, 11)).toBe('&amp; J');
  });

  it('pins a respelled character to itself, not to its whole node', () => {
    // `&hellip;` spells a character that is nowhere in the slice, so no
    // linear run covers it — but the prose on either side is spelled
    // verbatim, so only the entity itself is indivisible. Before this the
    // whole node was one piece, and selecting the ellipsis copied the
    // paragraph.
    const source = 'a &hellip; b';
    const display = 'a … b';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        { kind: 'text', value: display, span: { start: 0, end: source.length } },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe(display);
    expectTiling(projected);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 2, source: { start: 0, end: 2 } },
      // The one indivisible piece: one display character for eight of source.
      { textStart: 2, textEnd: 3, source: { start: 2, end: 10 } },
      { textStart: 3, textEnd: 5, source: { start: 10, end: 12 } },
    ]);

    // Selecting the ellipsis copies the entity that spells it, and nothing
    // else; selecting past it maps offset for offset.
    expect(mapSelectionToSource(projected, { start: 2, end: 3 })).toEqual({
      start: 2,
      end: 10,
    });
    expect(source.slice(2, 10)).toBe('&hellip;');
    expect(mapSelectionToSource(projected, { start: 4, end: 5 })).toEqual({
      start: 11,
      end: 12,
    });
    expect(source.slice(11, 12)).toBe('b');
  });

  it('merges a one-for-one respelling into the linear prose around it', () => {
    // Smart punctuation replaces one source character with one display
    // character, so the resynced piece is linear and `emit` merges it
    // straight into its neighbours: a paragraph of curly quotes maps offset
    // for offset instead of being one indivisible block.
    const source = 'He said "hi" now.';
    const display = 'He said “hi” now.';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        { kind: 'text', value: display, span: { start: 0, end: source.length } },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe(display);
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 17, source: { start: 0, end: 17 } },
    ]);
    expect(mapSelectionToSource(projected, { start: 8, end: 12 })).toEqual({
      start: 8,
      end: 12,
    });
    expect(source.slice(8, 12)).toBe('"hi"');
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

  it('gives a whole item back its marker, which no piece carries', () => {
    // The bullet is a synthetic glyph, so the pieces under this selection
    // reach only 'one' — but the selection covers the item's WHOLE projected
    // range, so the item's own source span is unioned in and the copy is a
    // list item rather than a line of prose. Selecting the same three
    // characters WITHOUT the glyph still maps to the text alone (above).
    expect(mapSelectionToSource(projected, { start: 0, end: 5 })).toEqual({
      start: 0,
      end: 5,
    });
    expect(source.slice(0, 5)).toBe('- one');
  });

  it('leaves a partly-covered construct to its pieces', () => {
    // Half a list is not a list: this selection covers the whole of item one
    // and only part of item two, so item one's marker comes back and item
    // two's does not.
    expect(mapSelectionToSource(projected, { start: 0, end: 9 })).toEqual({
      start: 0,
      end: 9,
    });
    expect(source.slice(0, 9)).toBe('- one\n- t');
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
      start: 0,
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

/**
 * EXTENTS: the syntax a construct owns and its projection never shows.
 *
 * A heading's `# `, a quote's `> `, a list item's marker, a fence, a code
 * span's backticks — none of it projects any text, so none of it belongs to a
 * piece, and the hull of the pieces a selection touched could never contain
 * it. `projectRun` records each such construct's own source span, and
 * `mapSelectionToSource` unions one back in when the selection covers that
 * construct's whole projected range.
 */
describe('extents', () => {
  it('records a heading with its marker and unions it back on a full sweep', () => {
    const source = '## Title\n\nBody text here.';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 2,
      span: spanOf(source, '## Title'),
      children: [textNode(source, 'Title')],
    };
    const doc = makeDoc(source, [
      heading,
      plainParagraph(source, 'Body text here.'),
    ]);
    const projected = projectRun(onlyRun(doc), doc);

    // The paragraph records nothing: its pieces already reach both ends of
    // its span, so there is no syntax to put back.
    expect(projected.extents).toEqual([
      { start: 0, end: 5, source: { start: 0, end: 8 } },
    ]);
    // The whole heading — the marker comes back.
    expect(mapSelectionToSource(projected, { start: 0, end: 5 })).toEqual({
      start: 0,
      end: 8,
    });
    // Part of it — it does not.
    expect(mapSelectionToSource(projected, { start: 1, end: 5 })).toEqual({
      start: 4,
      end: 8,
    });
  });

  it('puts a code span\u2019s backticks back, and nothing else', () => {
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
    expect(projected.extents).toEqual([
      { start: 4, end: 9, source: spanOf(source, '`npm i`') },
    ]);
    expect(mapSelectionToSource(projected, { start: 4, end: 9 })).toEqual({
      start: 4,
      end: 11,
    });
    expect(source.slice(4, 11)).toBe('`npm i`');
    // One character short of the whole span: the backticks stay out.
    expect(mapSelectionToSource(projected, { start: 5, end: 9 })).toEqual({
      start: 6,
      end: 10,
    });
  });

  it('records an inline link but not a reference one', () => {
    // An inline link carries its destination, so copying `[text](url)` pastes
    // a link. A reference link's destination is a definition elsewhere in the
    // document, which no slice of this selection can carry — copying `[text]`
    // would paste literal brackets, so the words win.
    const source = 'See [docs](/a) and [ref] here.';
    const inline: LinkNode = {
      kind: 'link',
      href: '/a',
      span: spanOf(source, '[docs](/a)'),
      children: [textNode(source, 'docs')],
    };
    const reference: LinkNode = {
      kind: 'link',
      href: '/b',
      span: spanOf(source, '[ref]'),
      children: [textNode(source, 'ref')],
    };
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'See '),
        inline,
        textNode(source, ' and '),
        reference,
        textNode(source, ' here.'),
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('See docs and ref here.');
    expect(projected.extents).toEqual([
      { start: 4, end: 8, source: spanOf(source, '[docs](/a)') },
    ]);
    expect(mapSelectionToSource(projected, { start: 4, end: 8 })).toEqual(
      spanOf(source, '[docs](/a)'),
    );
    expect(mapSelectionToSource(projected, { start: 13, end: 16 })).toEqual(
      spanOf(source, 'ref', source.indexOf('[ref]')),
    );
  });

  it('records nothing for a construct the stream has not finished', () => {
    // An incomplete construct's span is still moving and its closing syntax
    // is not written yet — a repaired code span whose backtick the repair
    // supplied. Copying `` `npm i `` would copy a delimiter the author has
    // not typed, so the extent is refused and the content stands alone.
    const source = 'Use `npm i';
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        textNode(source, 'Use '),
        {
          kind: 'codeSpan',
          value: 'npm i',
          incomplete: true,
          span: { start: 4, end: source.length },
        },
      ],
    };
    const doc = makeDoc(source, [para]);
    const projected = projectRun(onlyRun(doc), doc);

    expect(projected.text).toBe('Use npm i');
    expect(projected.extents).toBeUndefined();
    expect(mapSelectionToSource(projected, { start: 4, end: 9 })).toEqual({
      start: 5,
      end: 10,
    });
  });
});

describe('embeds', () => {
  const claimCitations: EmbedLookup = (node) =>
    node.kind === 'link' && node.href.startsWith('cite://')
      ? { width: 200, height: 80, text: '[1]' }
      : undefined;

  const source = 'Before card.\n\n[1](cite://a)\n\nAfter card.';
  const before = plainParagraph(source, 'Before card.');
  const link: LinkNode = {
    kind: 'link',
    href: 'cite://a',
    blocked: true,
    span: spanOf(source, '[1](cite://a)'),
    children: [textNode(source, '1')],
  };
  const card: ParagraphNode = {
    kind: 'paragraph',
    span: link.span,
    children: [link],
  };
  const after = plainParagraph(source, 'After card.');
  const doc = makeDoc(source, [before, card, after]);

  function projectWithEmbeds() {
    const runs = segmentRuns(doc, { embed: claimCitations });
    expect(runs).toHaveLength(1);
    return projectRun(runs[0], doc, { embed: claimCitations });
  }

  it('projects an embedded node as exactly one U+FFFC placeholder', () => {
    const projected = projectWithEmbeds();

    expect(projected.text).toBe('Before card.\n\n￼\n\nAfter card.');
    expectTiling(projected);
  });

  it('gives the embed one indivisible piece over the node’s whole span', () => {
    const projected = projectWithEmbeds();
    const placeholderAt = projected.text.indexOf('￼');
    const piece = projected.pieces.find(
      (candidate) => candidate.textStart === placeholderAt,
    );

    expect(piece).toEqual({
      textStart: placeholderAt,
      textEnd: placeholderAt + 1,
      source: link.span,
    });
  });

  it('marks the placeholder with kind embed and its ordinal id', () => {
    const projected = projectWithEmbeds();
    const placeholderAt = projected.text.indexOf('￼');

    expect(
      projected.marks.filter((mark) => mark.kind === 'embed'),
    ).toEqual([
      { kind: 'embed', start: placeholderAt, end: placeholderAt + 1, embedId: 0 },
    ]);
  });

  it('records the node and content on projected.embeds', () => {
    const projected = projectWithEmbeds();
    const placeholderAt = projected.text.indexOf('￼');

    expect(projected.embeds).toEqual([
      {
        embedId: 0,
        start: placeholderAt,
        end: placeholderAt + 1,
        node: link,
        content: { width: 200, height: 80, text: '[1]' },
      },
    ]);
  });

  it('projects with the same topLevel context segmentation saw', () => {
    // Segmentation and projection share `embedContentFor`, and with the
    // claim gated on `context.topLevel` the two must still agree: a claim
    // that declines nested nodes projects the top-level block as a
    // placeholder and leaves the nested instance as text.
    const codeSource = '```\ntop\n```\n\n> quote\n>\n> ```\n> deep\n> ```';
    const topCode = {
      kind: 'codeBlock' as const,
      literal: 'top\n',
      fenced: true,
      closed: true,
      span: spanOf(codeSource, '```\ntop\n```'),
    };
    const deepCode = {
      kind: 'codeBlock' as const,
      literal: 'deep\n',
      fenced: true,
      closed: true,
      span: spanOf(codeSource, '```\n> deep\n> ```'),
    };
    const quote = {
      kind: 'blockquote' as const,
      span: spanOf(codeSource, '> quote\n>\n> ```\n> deep\n> ```'),
      children: [plainParagraph(codeSource, 'quote'), deepCode],
    };
    const codeDoc = makeDoc(codeSource, [topCode, quote]);
    const claimTopLevelCode: EmbedLookup = (node, context) =>
      node.kind === 'codeBlock' && context.topLevel
        ? { width: 320, height: 60 }
        : undefined;

    const runs = segmentRuns(codeDoc, { embed: claimTopLevelCode });
    expect(runs).toHaveLength(1);
    const projected = projectRun(runs[0], codeDoc, { embed: claimTopLevelCode });

    expect(projected.text).toBe('￼\n\nquote\n\ndeep\n');
    expect(projected.embeds).toHaveLength(1);
    expect(projected.embeds?.[0].node).toBe(topCode);
  });

  it('leaves projected.embeds absent when nothing is claimed', () => {
    const runs = segmentRuns(doc);
    const projected = projectRun(runs[0], doc);

    expect(projected.embeds).toBeUndefined();
    expect('embeds' in projected).toBe(false);
  });

  it('assigns ordinal embedIds across multiple embeds', () => {
    const twoSource = '[1](cite://a) and [2](cite://b)';
    const first: LinkNode = {
      kind: 'link',
      href: 'cite://a',
      span: spanOf(twoSource, '[1](cite://a)'),
      children: [textNode(twoSource, '1')],
    };
    const second: LinkNode = {
      kind: 'link',
      href: 'cite://b',
      span: spanOf(twoSource, '[2](cite://b)'),
      children: [textNode(twoSource, '2', twoSource.indexOf('[2]'))],
    };
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: twoSource.length },
      children: [first, textNode(twoSource, ' and '), second],
    };
    const twoDoc = makeDoc(twoSource, [para]);
    const runs = segmentRuns(twoDoc, { embed: claimCitations });
    const projected = projectRun(runs[0], twoDoc, { embed: claimCitations });

    expect(projected.text).toBe('￼ and ￼');
    expect(projected.embeds?.map((embed) => embed.embedId)).toEqual([0, 1]);
    expect(projected.embeds?.[1].start).toBe(projected.text.lastIndexOf('￼'));
    expectTiling(projected);
  });

  it('gives every embed a one-character placeholder, in ascending order', () => {
    // A LOAD-BEARING INVARIANT, not a description. Consumers sweep
    // `projected.embeds` in one pass and rely on `end` being non-decreasing as
    // well as `start` — `embedLineHeightFloors` (src/view/runAttributes.ts)
    // retires the covering attributes by `end` as it walks, and would
    // understate a later embed's line height if a wide placeholder ever sorted
    // first; `selectionDisplayText` substitutes right-to-left so earlier
    // offsets stay valid. `end === start + 1` for every entry is what makes
    // ascending `start` imply both.
    const twoSource = '[1](cite://a) and [2](cite://b)';
    const first: LinkNode = {
      kind: 'link',
      href: 'cite://a',
      span: spanOf(twoSource, '[1](cite://a)'),
      children: [textNode(twoSource, '1')],
    };
    const second: LinkNode = {
      kind: 'link',
      href: 'cite://b',
      span: spanOf(twoSource, '[2](cite://b)'),
      children: [textNode(twoSource, '2', twoSource.indexOf('[2]'))],
    };
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: twoSource.length },
      children: [first, textNode(twoSource, ' and '), second],
    };
    const twoDoc = makeDoc(twoSource, [para]);
    const runs = segmentRuns(twoDoc, { embed: claimCitations });
    const embeds = projectRun(runs[0], twoDoc, { embed: claimCitations }).embeds;

    expect(embeds).toHaveLength(2);
    let previousEnd = -1;
    for (const embed of embeds ?? []) {
      expect(embed.end).toBe(embed.start + 1);
      expect(embed.start).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = embed.end;
    }
  });

  it('keeps a one-code-unit node’s placeholder piece unmerged', () => {
    // The atomicity of an embed piece is contractual, not inferred from the
    // display/source length inequality — a node whose span is exactly one
    // code unit would otherwise read as linear and merge into its
    // neighbours.
    const tinySource = 'a&b';
    const amp = textNode(tinySource, '&');
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: tinySource.length },
      children: [textNode(tinySource, 'a'), amp, textNode(tinySource, 'b')],
    };
    const tinyDoc = makeDoc(tinySource, [para]);
    const claim: EmbedLookup = (node) =>
      node === amp ? { width: 10, height: 10 } : undefined;
    const runs = segmentRuns(tinyDoc, { embed: claim });
    const projected = projectRun(runs[0], tinyDoc, { embed: claim });

    expect(projected.text).toBe('a￼b');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 1, source: spanOf(tinySource, 'a') },
      { textStart: 1, textEnd: 2, source: amp.span },
      { textStart: 2, textEnd: 3, source: spanOf(tinySource, 'b') },
    ]);
  });

  it('projects an embed-only block to a non-empty run', () => {
    const soloSource = '[1](cite://a)';
    const soloLink: LinkNode = {
      kind: 'link',
      href: 'cite://a',
      span: spanOf(soloSource, soloSource),
      children: [textNode(soloSource, '1')],
    };
    const soloPara: ParagraphNode = {
      kind: 'paragraph',
      span: soloLink.span,
      children: [soloLink],
    };
    const soloDoc = makeDoc(soloSource, [soloPara]);
    const runs = segmentRuns(soloDoc, { embed: claimCitations });
    const projected = projectRun(runs[0], soloDoc, { embed: claimCitations });

    expect(projected.text).toBe('￼');
    expectTiling(projected);
  });

  it('falls through to normal projection for synthetic and incomplete nodes', () => {
    const incomplete: LinkNode = { ...link, incomplete: true };
    const withIncomplete: ParagraphNode = {
      kind: 'paragraph',
      span: incomplete.span,
      children: [incomplete],
    };
    const streamDoc = makeDoc(source, [withIncomplete]);
    const runs = segmentRuns(streamDoc, { embed: claimCitations });
    const projected = projectRun(runs[0], streamDoc, { embed: claimCitations });

    // An incomplete link projects its children bare — no placeholder.
    expect(projected.text).toBe('1');
    expect(projected.embeds).toBeUndefined();
  });

  it('maps a sweep across the card to a hull covering its whole source', () => {
    const projected = projectWithEmbeds();
    const span = mapSelectionToSource(projected, {
      start: 0,
      end: projected.text.length,
    });

    expect(span).toEqual({ start: 0, end: source.length });
  });

  it('maps a placeholder-only selection to the node’s whole span', () => {
    const projected = projectWithEmbeds();
    const placeholderAt = projected.text.indexOf('￼');

    expect(
      mapSelectionToSource(projected, {
        start: placeholderAt,
        end: placeholderAt + 1,
      }),
    ).toEqual(link.span);
  });
});

/**
 * NESTING DEPTH IS UNTRUSTED INPUT.
 *
 * Three kilobytes of `'> '` is 1500 levels of blockquote, and nothing caps
 * it: the native decoder builds its tree off an explicit stack, so it returns
 * a tree as deep as the source asks for. Every walk on the selection path
 * therefore has to survive one — a RangeError here would surface inside the
 * `useMemo` that projects a run during React render, which is a torn-down
 * tree rather than a dropped frame. The tree is hand-built so the test needs
 * no parser and costs no parse.
 */
describe('unbounded nesting depth', () => {
  const DEPTH = 20_000;
  const source = '> '.repeat(DEPTH) + 'echo';
  const textSpan = { start: DEPTH * 2, end: source.length };

  function deepDocument(): ParsedDocument {
    let block: Block = {
      kind: 'paragraph',
      span: textSpan,
      children: [{ kind: 'text', value: 'echo', span: textSpan }],
    };
    for (let level = DEPTH - 1; level >= 0; level -= 1) {
      block = {
        kind: 'blockquote',
        span: { start: level * 2, end: source.length },
        children: [block],
      };
    }
    return makeDoc(source, [block]);
  }

  it('segments, projects and maps a 20000-deep blockquote', () => {
    const doc = deepDocument();

    // segmentRuns walks the whole subtree looking for standalone constructs.
    const runs = segmentRuns(doc);
    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);

    const projected = projectRun(runs[0], doc);
    expect(projected.text).toBe('echo');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 4, source: textSpan },
    ]);
    // One 'blockquote' mark per level, all over the same four characters.
    expect(
      projected.marks.filter((mark) => mark.kind === 'blockquote'),
    ).toHaveLength(DEPTH);
    // One 'blockquote' EXTENT per level too, and selecting the four visible
    // characters covers every one of them — so the copied markdown is the
    // whole 20000-deep quote, not the bare word. The union walks 20000
    // extents without recursing, same as everything else here.
    expect(mapSelectionToSource(projected, { start: 0, end: 4 })).toEqual({
      start: 0,
      end: source.length,
    });
  });
});

/**
 * INCREMENTAL PROJECTION: `projectRun` handed the projection of a prefix of
 * the same run must produce exactly what it produces from scratch.
 *
 * This is the whole safety property of the `previous` option, and it is not
 * obvious: the projector merges a chunk into the preceding piece when the two
 * are linear in the source, records marks as their construct closes and sorts
 * them at the end, numbers embeds by their position in the run, and refuses to
 * grow an embed's piece. All four are state carried ACROSS a block boundary, so
 * a resumed projection that got any of them wrong would still tile, still map,
 * and still look right — it would just disagree with the from-scratch answer by
 * a piece boundary or a mark order. So the assertion is deep equality at EVERY
 * split point, not a spot check.
 *
 * The corpus-scale counterpart, over documents from a real parse, is
 * conformance/selection/incremental-projection.test.ts.
 */
describe('projectRun (incremental)', () => {
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
   * Projects `run` from scratch and again by growing it one block at a time,
   * asserting the two agree after every step — which also asserts that the
   * intermediate projections are the ones a shorter run would have produced.
   */
  function expectIncrementalMatchesFull(
    run: RunSegment,
    doc: ParsedDocument,
    options?: { embed?: EmbedLookup },
  ): void {
    expect(run.blocks.length).toBeGreaterThan(1);
    let previous = projectRun(prefixRun(run, 1), doc, options);
    expect(previous).toEqual(projectRun(prefixRun(run, 1), doc, options));

    for (let count = 2; count <= run.blocks.length; count += 1) {
      const grown = prefixRun(run, count);
      const full = projectRun(grown, doc, options);
      const incremental = projectRun(grown, doc, {
        ...options,
        previous: { blocks: run.blocks.slice(0, count - 1), projected: previous },
      });

      expect(incremental).toEqual(full);
      expectTiling(incremental);
      previous = incremental;
    }
  }

  const source = [
    '# Heading one',
    'Alpha *beta* and `code`.',
    '> quoted line',
    '- one\n- two',
    '```js\nconst x = 1;\n```',
    '| a | b |\n| - | - |\n| c | d |',
    '---',
    '<div>raw</div>',
    'Final [link](https://example.com) end.',
  ].join('\n\n');

  function mixedDocument(): ParsedDocument {
    const heading: HeadingNode = {
      kind: 'heading',
      level: 1,
      span: spanOf(source, '# Heading one'),
      children: [textNode(source, 'Heading one')],
    };
    const prose: ParagraphNode = {
      kind: 'paragraph',
      span: spanOf(source, 'Alpha *beta* and `code`.'),
      children: [
        textNode(source, 'Alpha '),
        {
          kind: 'emphasis',
          span: spanOf(source, '*beta*'),
          children: [textNode(source, 'beta')],
        },
        textNode(source, ' and '),
        { kind: 'codeSpan', value: 'code', span: spanOf(source, '`code`') },
        textNode(source, '.'),
      ],
    };
    const quote: BlockquoteNode = {
      kind: 'blockquote',
      span: spanOf(source, '> quoted line'),
      children: [plainParagraph(source, 'quoted line')],
    };
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: spanOf(source, '- one\n- two'),
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
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      language: 'js',
      literal: 'const x = 1;\n',
      fenced: true,
      closed: true,
      span: spanOf(source, '```js\nconst x = 1;\n```'),
    };
    const cell = (value: string): TableNode['header']['cells'][number] => ({
      kind: 'tableCell',
      span: spanOf(source, value),
      children: [textNode(source, value)],
    });
    const table: TableNode = {
      kind: 'table',
      align: [null, null],
      span: spanOf(source, '| a | b |\n| - | - |\n| c | d |'),
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
    const rule: Block = { kind: 'thematicBreak', span: spanOf(source, '---') };
    const html: Block = {
      kind: 'htmlBlock',
      literal: '<div>raw</div>',
      span: spanOf(source, '<div>raw</div>'),
    };
    const link: LinkNode = {
      kind: 'link',
      href: 'https://example.com',
      span: spanOf(source, '[link](https://example.com)'),
      children: [textNode(source, 'link')],
    };
    const closing: ParagraphNode = {
      kind: 'paragraph',
      span: spanOf(source, 'Final [link](https://example.com) end.'),
      children: [textNode(source, 'Final '), link, textNode(source, ' end.')],
    };
    return makeDoc(source, [
      heading,
      prose,
      quote,
      list,
      code,
      table,
      rule,
      html,
      closing,
    ]);
  }

  it('matches the full projection at every block boundary', () => {
    const doc = mixedDocument();
    expectIncrementalMatchesFull(onlyRun(doc), doc);
  });

  it('matches across embeds, whose ids and atomic pieces continue', () => {
    const doc = mixedDocument();
    // Claims the code block and the link — one top-level, one inline — so the
    // seam is crossed with an embed on both sides of it.
    const embed: EmbedLookup = (node) =>
      node.kind === 'codeBlock' || node.kind === 'link'
        ? { width: 120, height: 60, text: '[card]' }
        : undefined;
    const run = segmentRuns(doc, { embed })[0];

    expectIncrementalMatchesFull(run, doc, { embed });

    const projected = projectRun(run, doc, { embed });
    expect(projected.embeds?.map((entry) => entry.embedId)).toEqual([0, 1]);
  });

  it('matches when the seam falls after a synthetic glyph', () => {
    // The one place the resumed projector could diverge on its very first
    // emit: the block separator carries no source, and so does a bullet glyph,
    // so the two MERGE into one piece — which means the resumed projector has
    // to be holding the same last piece the from-scratch one would be.
    const emptySource = '-\n\nAfter the list.';
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: spanOf(emptySource, '-'),
      items: [{ kind: 'listItem', span: spanOf(emptySource, '-'), children: [] }],
    };
    const after = plainParagraph(emptySource, 'After the list.');
    const doc = makeDoc(emptySource, [list, after]);
    const run = onlyRun(doc);
    const full = projectRun(run, doc);

    expect(
      projectRun(run, doc, {
        previous: { blocks: [list], projected: projectRun(prefixRun(run, 1), doc) },
      }),
    ).toEqual(full);
    expectTiling(full);
  });

  it('returns the same object when nothing was appended', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const first = projectRun(run, doc);
    const again = projectRun(run, doc, {
      previous: { blocks: run.blocks, projected: first },
    });

    // Identity, not equality: every memo downstream keys on the projection
    // object, so a re-segmentation that changed nothing must cost nothing.
    expect(again).toBe(first);
  });

  it('leaves the previous projection untouched when it grows', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const short = projectRun(prefixRun(run, 2), doc);
    const snapshot = JSON.parse(JSON.stringify(short)) as unknown;

    projectRun(prefixRun(run, 4), doc, {
      previous: { blocks: run.blocks.slice(0, 2), projected: short },
    });

    // The projector grows the last piece in place when the next chunk
    // continues it, so a shared piece object would corrupt whoever still
    // holds the shorter projection.
    expect(JSON.parse(JSON.stringify(short))).toEqual(snapshot);
  });

  it('ignores a previous projection that is not a prefix by identity', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const full = projectRun(run, doc);

    // Structurally identical blocks from a second build of the same document
    // are NOT the same objects, and must not be spliced onto.
    const other = mixedDocument();
    const decoys = [
      { blocks: other.blocks.slice(0, 3), projected: projectRun(prefixRun(onlyRun(other), 3), other) },
      { blocks: [], projected: full },
      { blocks: [...run.blocks, run.blocks[0]], projected: full },
    ];
    for (const previous of decoys) {
      expect(projectRun(run, doc, { previous })).toEqual(full);
    }
  });

  it('refuses a prefix that reaches past the end of the source', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const short = projectRun(prefixRun(run, 2), doc);
    // The shape a diverging `replace` leaves behind: blocks held from a parse
    // of a longer source than the document now carries.
    const truncated = makeDoc(source.slice(0, 20), run.blocks);

    expect(
      projectRun(prefixRun(run, 3), truncated, {
        previous: { blocks: run.blocks.slice(0, 2), projected: short },
      }),
    ).toEqual(projectRun(prefixRun(run, 3), truncated));
  });
});
