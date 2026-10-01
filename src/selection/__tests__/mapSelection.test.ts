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
    // The body `js` also appears in the info string, where a search from 0 would pin it.
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
    // Nowhere verbatim (every line is indented): one linear piece per line, past its indent.
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 3, source: { start: 4, end: 7 } },
      { textStart: 3, textEnd: 6, source: { start: 11, end: 14 } },
    ]);
    expect(source.slice(4, 7)).toBe('js\n');
  });

  it('never claims a whole-span pin is linear when the indent moved', () => {
    // CommonMark example 1: one tab in the slice for one newline in the literal,
    // so a whole-span pin would read as linear and shift every offset by one.
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

    expect(mapSelectionToSource(projected, { start: 0, end: 3 })).toEqual({
      start: 1,
      end: 13,
    });
    expect(source.slice(1, 13)).toBe('foo\tbaz\t\tbim');
  });

  it('maps a synthesized indent to no source at all', () => {
    // CommonMark example 274: md4c synthesizes a leading space for the leftover
    // indent, which a source-only resync would match inside `indented code`.
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

    const at = projected.text.indexOf('code');
    expect(
      mapSelectionToSource(projected, { start: at, end: at + 4 }),
    ).toEqual({ start: 8, end: 21 });
  });

  it('splits a text node around an escape, so the escape costs only itself', () => {
    // The native decoder merges an escaped paragraph into one text node, as here.
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
    // Pinned to `\*`, not the bare `*`: copying a lone `*` would paste a delimiter.
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 12, source: { start: 0, end: 12 } },
      { textStart: 12, textEnd: 13, source: { start: 12, end: 14 } },
      {
        textStart: 13,
        textEnd: display.length,
        source: { start: 14, end: source.length },
      },
    ]);

    const at = display.indexOf('every');
    expect(
      mapSelectionToSource(projected, { start: at, end: at + 5 }),
    ).toEqual({ start: at + 1, end: at + 6 });
    expect(source.slice(at + 1, at + 6)).toBe('every');
  });

  it('splits a text node around an entity the source spells out', () => {
    // The slice spells the displayed `&` as the entity's own `&`, which must not count as a match.
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
      { textStart: 0, textEnd: 4, source: { start: 0, end: 4 } },
      { textStart: 4, textEnd: 5, source: { start: 4, end: 9 } },
      { textStart: 5, textEnd: 11, source: { start: 9, end: 15 } },
    ]);
    expect(mapSelectionToSource(projected, { start: 4, end: 5 })).toEqual({
      start: 4,
      end: 9,
    });

    expect(mapSelectionToSource(projected, { start: 4, end: 7 })).toEqual({
      start: 4,
      end: 11,
    });
    expect(source.slice(4, 11)).toBe('&amp; J');
  });

  describe('character references are atomic', () => {
    function project(source: string, display: string) {
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
      return projected;
    }

    it.each([
      ['&copy;cat', '©cat', 6],
      ['&copy;copy', '©copy', 6],
      ['&#169;c', '©c', 6],
      ['&#xA9;c', '©c', 6],
      ['&amp;amp', '&amp', 5],
    ])('pins the leading reference in %j to its whole spelling', (source, display, length) => {
      const projected = project(source, display);
      expect(projected.pieces).toEqual([
        { textStart: 0, textEnd: 1, source: { start: 0, end: length } },
        {
          textStart: 1,
          textEnd: display.length,
          source: { start: length, end: source.length },
        },
      ]);
      expect(mapSelectionToSource(projected, { start: 0, end: 1 })).toEqual({
        start: 0,
        end: length,
      });
      expect(mapSelectionToSource(projected, { start: 1, end: 2 })).toEqual({
        start: length,
        end: length + 1,
      });
    });

    it('pins an entity in the middle of a word and keeps the rest linear', () => {
      const source = 'ca&copy;t';
      const projected = project(source, 'ca©t');
      expect(projected.pieces).toEqual([
        { textStart: 0, textEnd: 2, source: { start: 0, end: 2 } },
        { textStart: 2, textEnd: 3, source: { start: 2, end: 8 } },
        { textStart: 3, textEnd: 4, source: { start: 8, end: 9 } },
      ]);
      expect(mapSelectionToSource(projected, { start: 1, end: 4 })).toEqual({
        start: 1,
        end: 9,
      });
    });

    it('maps a partial selection after the entity offset for offset', () => {
      const source = '&copy; 2024 Acme';
      const projected = project(source, '© 2024 Acme');
      expect(mapSelectionToSource(projected, { start: 2, end: 6 })).toEqual({
        start: 7,
        end: 11,
      });
      expect(source.slice(7, 11)).toBe('2024');
    });

    it('keeps the following word outside the named reference', () => {
      const source = '&alpha;alpha';
      const projected = project(source, 'αalpha');
      expect(projected.pieces).toEqual([
        { textStart: 0, textEnd: 1, source: { start: 0, end: 7 } },
        { textStart: 1, textEnd: 6, source: { start: 7, end: 12 } },
      ]);
    });

    it.each([
      ['a &fjlig; b', 'a fj b', 3, 2, 9],
      ['&NotEqualTilde;&copy;X', '≂̸©X', 1, 0, 15],
    ])('maps both characters of a named reference in %j', (source, display, offset, start, end) => {
      const projected = project(source, display);
      expect(mapSelectionToSource(projected, { start: offset, end: offset + 1 })).toEqual({ start, end });
    });

    // Each tail starts with a letter of the entity's own name, where a resync must not land.
    it.each([
      ['A &hellip;hello', 'A …hello', '&hellip;', 'hello'],
      ['x &copy;copy', 'x ©copy', '&copy;', 'copy'],
      ['x &mdash;m', 'x —m', '&mdash;', 'm'],
    ])('copies the whole entity in %j and maps the text after it outside', (source, display, entity, after) => {
      const projected = project(source, display);
      const at = source.indexOf(entity);
      expect(mapSelectionToSource(projected, { start: 2, end: 3 })).toEqual({
        start: at,
        end: at + entity.length,
      });
      const tail = mapSelectionToSource(projected, {
        start: 3,
        end: 3 + after.length,
      });
      expect(tail).not.toBeNull();
      expect(source.slice(tail!.start, tail!.end)).toBe(after);
      expect(tail!.start).toBe(at + entity.length);
    });

    it('terminates on a reference the display shows only the start of', () => {
      // `&fjlig;` displays `fj`; against `fx` only its first character ever matches.
      const projected = project('&fjlig;', 'fx');
      expect(projected.text).toBe('fx');
    });

    it('keeps an escaped ampersand an escape, not an entity', () => {
      const source = '\\&copy;';
      const projected = project(source, '&copy;');
      expect(projected.pieces).toEqual([
        { textStart: 0, textEnd: 1, source: { start: 0, end: 2 } },
        { textStart: 1, textEnd: 6, source: { start: 2, end: 7 } },
      ]);
    });
  });

  it('pins a respelled character to itself, not to its whole node', () => {
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
      { textStart: 2, textEnd: 3, source: { start: 2, end: 10 } },
      { textStart: 3, textEnd: 5, source: { start: 10, end: 12 } },
    ]);

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
    // One-for-one respellings are linear, so `emit` merges them into one piece.
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

describe('literal alignment scales linearly', () => {
  // Quadratic alignment took ~1.7s at 40k; linear takes tens of milliseconds,
  // and the bound sits between the two so CI noise cannot flip it.
  const N = 40_000;

  function projectText(source: string, display: string) {
    const para: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: source.length },
      children: [
        { kind: 'text', value: display, span: { start: 0, end: source.length } },
      ],
    };
    const doc = makeDoc(source, [para]);
    return projectRun(onlyRun(doc), doc);
  }

  function fastest(run: () => void): number {
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      run();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  it.each([
    ['&copy;', '©'],
    ['a &copy; ', 'a © '],
    ['&hellip;x', '…x'],
    ['&copy;"', '©“'],
    ['&bogus;q', 'Z'],
    ['"a', '“a'],
  ])('projects %j x 40k in linear time', (unit, shown) => {
    const source = unit.repeat(N);
    const display = shown.repeat(N);
    let projected: ReturnType<typeof projectText> | null = null;
    const ms = fastest(() => {
      projected = projectText(source, display);
    });
    expect(projected!.text).toBe(display);
    expectTiling(projected!);
    expect(ms).toBeLessThan(500);
  });

  it('pins every entity of a long run to its own spelling', () => {
    const projected = projectText('&copy;'.repeat(N), '©'.repeat(N));
    expect(projected.pieces).toHaveLength(N);
    expect(mapSelectionToSource(projected, { start: N - 1, end: N })).toEqual({
      start: (N - 1) * 6,
      end: N * 6,
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
    // The bullet is synthetic, but the selection covers the item whole, so the
    // item's span is unioned in and its `- ` comes back.
    expect(mapSelectionToSource(projected, { start: 0, end: 5 })).toEqual({
      start: 0,
      end: 5,
    });
    expect(source.slice(0, 5)).toBe('- one');
  });

  it('leaves a partly-covered construct to its pieces', () => {
    // Item one is covered whole and item two only in part, so only item one's
    // marker comes back.
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

    // The paragraph's pieces already reach both ends of its span, so it records nothing.
    expect(projected.extents).toEqual([
      { start: 0, end: 5, source: { start: 0, end: 8 } },
    ]);
    expect(mapSelectionToSource(projected, { start: 0, end: 5 })).toEqual({
      start: 0,
      end: 8,
    });
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
    expect(mapSelectionToSource(projected, { start: 5, end: 9 })).toEqual({
      start: 6,
      end: 10,
    });
  });

  it('records an inline link but not a reference one', () => {
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

    expect(projected.text).toBe('Before card.\n\n1\n\nAfter card.');
    expect(projected.embeds).toBeUndefined();
    expect('embeds' in projected).toBe(false);
    expect(projectWithEmbeds().embeds).toHaveLength(1);
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
    // Consumers sweep `embeds` in one pass, relying on `start` and `end` both ascending.
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

    const runs = segmentRuns(doc);
    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);

    const projected = projectRun(runs[0], doc);
    expect(projected.text).toBe('echo');
    expect(projected.pieces).toEqual([
      { textStart: 0, textEnd: 4, source: textSpan },
    ]);
    expect(
      projected.marks.filter((mark) => mark.kind === 'blockquote'),
    ).toHaveLength(DEPTH);
    // The four visible characters cover every level's extent, so the copy is the whole quote.
    expect(mapSelectionToSource(projected, { start: 0, end: 4 })).toEqual({
      start: 0,
      end: source.length,
    });
  });
});

/**
 * A resumed projection that carried any state wrong would still tile and map,
 * so these assert deep equality with a from-scratch projection at every split.
 */
describe('projectRun (incremental)', () => {
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

  const MIXED_TEXT =
    'Heading one\n\nAlpha beta and code.\n\nquoted line\n\n\u2022 one\n\u2022 two\n\nconst x = 1;\n\n\na\tb\nc\td\n\n\n\n<div>raw</div>\n\nFinal link end.';

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
    expect(projectRun(onlyRun(doc), doc).text).toBe(MIXED_TEXT);
    expectIncrementalMatchesFull(onlyRun(doc), doc);
  });

  it('matches across embeds, whose ids and atomic pieces continue', () => {
    const doc = mixedDocument();
    // One top-level and one inline claim, so the seam has an embed on both sides.
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
    // The block separator and the bullet glyph both have null source, so they
    // merge into one piece across the seam.
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

    expect(full.text).toBe('\u2022 \n\nAfter the list.');
    expect(full.pieces).toEqual([
      { textStart: 0, textEnd: 4, source: null },
      { textStart: 4, textEnd: 19, source: spanOf(emptySource, 'After the list.') },
    ]);
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

    expect(first.text).toBe(MIXED_TEXT);
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

    // `emit` grows the last piece in place, so a shared piece would corrupt `short`.
    expect(JSON.parse(JSON.stringify(short))).toEqual(snapshot);
  });

  it('ignores a previous projection that is not a prefix by identity', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const full = projectRun(run, doc);

    const other = mixedDocument();
    const decoys = [
      { blocks: other.blocks.slice(0, 3), projected: projectRun(prefixRun(onlyRun(other), 3), other) },
      { blocks: [], projected: full },
      { blocks: [...run.blocks, run.blocks[0]], projected: full },
    ];
    expect(full.text).toBe(MIXED_TEXT);
    for (const previous of decoys) {
      expect(projectRun(run, doc, { previous })).toEqual(full);
    }
  });

  it('refuses a prefix that reaches past the end of the source', () => {
    const doc = mixedDocument();
    const run = onlyRun(doc);
    const short = projectRun(prefixRun(run, 2), doc);
    // What a diverging `replace` leaves: blocks from a longer source than the document has.
    const truncated = makeDoc(source.slice(0, 20), run.blocks);

    const resumed = projectRun(prefixRun(run, 3), truncated, {
      previous: { blocks: run.blocks.slice(0, 2), projected: short },
    });

    expect(resumed).toEqual(projectRun(prefixRun(run, 3), truncated));
    // Pieces clamp to the 20 characters left; a spliced prefix would reach past them.
    expect(resumed.pieces).toEqual([
      { textStart: 0, textEnd: 11, source: { start: 2, end: 13 } },
      { textStart: 11, textEnd: 13, source: null },
      { textStart: 13, textEnd: 19, source: { start: 15, end: 20 } },
      { textStart: 19, textEnd: 46, source: null },
    ]);
  });
});

test.each([
  ['😀x', '😁x', [{ textStart: 0, textEnd: 3, source: { start: 0, end: 3 } }]],
  [
    '"😀" &amp; 😁',
    '“😀” & 😁',
    [
      { textStart: 0, textEnd: 5, source: { start: 0, end: 5 } },
      { textStart: 5, textEnd: 6, source: { start: 5, end: 10 } },
      { textStart: 6, textEnd: 9, source: { start: 10, end: 13 } },
    ],
  ],
  [
    '\\*😀\\*',
    '*😀*',
    [
      { textStart: 0, textEnd: 1, source: { start: 0, end: 2 } },
      { textStart: 1, textEnd: 3, source: { start: 2, end: 4 } },
      { textStart: 3, textEnd: 4, source: { start: 4, end: 6 } },
    ],
  ],
])('literal alignment preserves surrogate boundaries: %s', (source, value, pieces) => {
  const span = { start: 0, end: source.length };
  const doc = makeDoc(source, [{ kind: 'paragraph', span, children: [{ kind: 'text', span, value }] }]);
  const projected = projectRun(onlyRun(doc), doc);
  expect(projected.text).toBe(value);
  expect(projected.pieces).toEqual(pieces);
  const splitsPair = (text: string, offset: number) =>
    offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '');
  for (const piece of projected.pieces) {
    expect(splitsPair(projected.text, piece.textStart)).toBe(false);
    expect(splitsPair(projected.text, piece.textEnd)).toBe(false);
    if (piece.source !== null) {
      expect(splitsPair(source, piece.source.start)).toBe(false);
      expect(splitsPair(source, piece.source.end)).toBe(false);
    }
  }
});
