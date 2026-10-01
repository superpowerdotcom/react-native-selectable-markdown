/**
 * The documents md4c produces, pinned construct by construct.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE. This was
 * `differential.test.ts`: a corpus of ~130 sources parsed twice — once by the
 * native engine, once by a bundled pure-TypeScript one — and asserted
 * `toEqual` on the whole `ParsedDocument`. That comparison bought a great deal
 * for one line of assertion, but it only ever meant anything because there
 * were two parsers. There is one now, so a corpus of "both agree" cases is a
 * corpus of nothing, and half of what the file said (which construct one
 * engine's documented subset could not reach) describes code that no longer
 * exists.
 *
 * What survives is the half that was always about md4c: the cases where the
 * result is genuinely surprising, or where a wrong answer would render
 * perfectly and break selection silently. Those are asserted here on their own
 * terms — the actual node kinds, the actual offsets — because there is nothing
 * left to compare against.
 *
 * WHY OFFSETS AND NOT RENDERED HTML. Everything above the engine reads spans,
 * not text: the streaming splice shifts them, selection maps device
 * coordinates through them, copy reconstructs markdown by slicing the source
 * with them. A decoder that produced the right text from the wrong offsets
 * would pass `conformance/run-commonmark.mjs` at 100% and still make a
 * long-press select the wrong characters. So every case below that can name an
 * offset does.
 *
 * WHAT IS DELIBERATELY NOT HERE. Breadth lives in two corpus sweeps that cost
 * nothing to keep honest: `run-commonmark.mjs` scores all 652 CommonMark
 * 0.31.2 examples as HTML, and `spans.test.ts` asserts the span invariants
 * (bounds, containment, sibling disjointness) over those same 652 examples
 * plus every streaming fixture. A case belongs in THIS file only when it
 * carries a fact neither of those can state.
 */

import { parseDocument } from '../../Engine';
import type { EngineOptions } from '../../options';
import { presets } from '../../options';
import type { Block, Inline, ParsedDocument } from '../../../document/nodes';
import { describeNative, requireNativeEngine } from './support';

const CM: EngineOptions = presets.commonmark;
const LLM: EngineOptions = presets.llmChat;
const RAW: EngineOptions = { ...CM, html: 'raw' };

function parse(source: string, options: EngineOptions = LLM): ParsedDocument {
  return parseDocument(source, options, requireNativeEngine());
}

/** Inline children of the document's first paragraph. */
function firstParagraph(doc: ParsedDocument): readonly Inline[] {
  const block = doc.blocks[0];
  expect(block.kind).toBe('paragraph');
  return (block as { children: Inline[] }).children;
}

/** The exact source text a node's span covers — the assertion that matters. */
function sliceOf(doc: ParsedDocument, node: { span: { start: number; end: number } }): string {
  return doc.source.slice(node.span.start, node.span.end);
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

/**
 * CommonMark 0.31.2 §2.1 admits three line endings — LF, CRLF and a bare CR —
 * and a break node's span has to cover the WHOLE ending or a copied selection
 * loses half of a CRLF. Both halves of this used to be wrong in different
 * ways: the decoder took only the LF of a CRLF, and a bare CR left it with no
 * anchor at all, which is how a `{-1, -1}` span reached the streaming splice
 * and came back out as `anchor - 1`.
 *
 * Nothing above the engine can notice: every one of these renders as a space.
 * The only observable is the offset, so the offset is what is asserted.
 */
describeNative('line endings', () => {
  test('a soft break over CRLF spans both code units', () => {
    const doc = parse('a\r\nb\r\n');
    const [, brk] = firstParagraph(doc);
    expect(brk.kind).toBe('softBreak');
    expect(brk.span).toEqual({ start: 1, end: 3 });
    expect(sliceOf(doc, brk)).toBe('\r\n');
  });

  test('a soft break over a bare CR spans the CR', () => {
    const doc = parse('a\rb\r');
    const [, brk] = firstParagraph(doc);
    expect(brk.kind).toBe('softBreak');
    expect(sliceOf(doc, brk)).toBe('\r');
  });

  test('a two-space hard break over CRLF spans the spaces and the ending', () => {
    // The spaces are part of the break, not of the text before it: a
    // selection that copied `a  ` and then the newline separately would
    // reconstruct markdown with a stray trailing space run.
    const doc = parse('a  \r\nb\r\n');
    const [, brk] = firstParagraph(doc);
    expect(brk.kind).toBe('hardBreak');
    expect(sliceOf(doc, brk)).toBe('  \r\n');
  });

  test('a backslash hard break over CRLF spans the backslash and the ending', () => {
    const doc = parse('a\\\r\nb\r\n');
    const [, brk] = firstParagraph(doc);
    expect(brk.kind).toBe('hardBreak');
    expect(sliceOf(doc, brk)).toBe('\\\r\n');
  });

  test('a document mixing all three endings places every break exactly', () => {
    const source = 'a\r\nb\rc\nd\n';
    const doc = parse(source);
    const breaks = firstParagraph(doc).filter((n) => n.kind === 'softBreak');
    expect(breaks.map((b) => sliceOf(doc, b))).toEqual(['\r\n', '\r', '\n']);
  });

  test('CRLF block spans stop before the ending, not inside it', () => {
    // A block's span must not swallow its terminator, or two adjacent blocks
    // overlap and the streaming splice cannot tell where one ends.
    const doc = parse('# Title\r\n\r\npara\r\n');
    expect(doc.blocks.map((b) => sliceOf(doc, b))).toEqual(['# Title', 'para']);
  });

  test('CRLF list item spans stop before the ending', () => {
    const doc = parse('- one\r\n- two\r\n');
    const items = (doc.blocks[0] as { items: Block[] }).items;
    expect(items.map((i) => sliceOf(doc, i))).toEqual(['- one', '- two']);
  });
});

// ---------------------------------------------------------------------------
// UTF-16 offsets
// ---------------------------------------------------------------------------

/**
 * Spans are UTF-16 offsets into the JS source string, and md4c counts bytes in
 * UTF-8. Everything between the two is arithmetic that a BMP-only corpus
 * cannot exercise: an emoji is two code units and four bytes, a ZWJ family is
 * eleven code units and twenty-five bytes, and an off-by-one in the conversion
 * lands a span in the middle of a surrogate pair — where `slice` produces a
 * lone surrogate and the native host renders a replacement glyph.
 */
describeNative('UTF-16 offsets over astral text', () => {
  test('a code span of astral characters slices back exactly', () => {
    const source = '`𝕏 𝕐`\n';
    const doc = parse(source);
    const [code] = firstParagraph(doc);
    expect(code.kind).toBe('codeSpan');
    expect(sliceOf(doc, code)).toBe('`𝕏 𝕐`');
    expect((code as { value: string }).value).toBe('𝕏 𝕐');
  });

  test('a ZWJ sequence stays one text node covering its own source', () => {
    const source = '👨‍👩‍👧‍👦 family\n';
    const doc = parse(source);
    const [text] = firstParagraph(doc);
    expect(sliceOf(doc, text)).toBe('👨‍👩‍👧‍👦 family');
    expect((text as { value: string }).value).toBe('👨‍👩‍👧‍👦 family');
  });

  test('emphasis around an emoji puts its delimiters where the source has them', () => {
    const source = '*👋 x*\n';
    const doc = parse(source);
    const [em] = firstParagraph(doc);
    expect(em.kind).toBe('emphasis');
    expect(sliceOf(doc, em)).toBe('*👋 x*');
    expect(sliceOf(doc, (em as { children: Inline[] }).children[0])).toBe('👋 x');
  });
});

// ---------------------------------------------------------------------------
// Constructs whose span is not the obvious one
// ---------------------------------------------------------------------------

describeNative('reference-style links', () => {
  /**
   * A link written as `[foo][bar]` has a destination that appears NOWHERE in
   * the construct's own source text. The node's span therefore has to cover
   * the reference — the brackets the author typed — while its `href` comes
   * from a definition line further down that is consumed rather than rendered.
   * Copying the selection reproduces `[foo][bar]`, which is what round-trips.
   */
  test.each([
    ['full', '[foo][bar]\n\n[bar]: https://e.com\n'],
    ['collapsed', '[foo][]\n\n[foo]: https://e.com\n'],
    ['shortcut', '[foo]\n\n[foo]: https://e.com\n'],
  ])('%s reference resolves, spanning the reference and not the definition', (_form, source) => {
    const doc = parse(source);
    const [link] = firstParagraph(doc);
    expect(link.kind).toBe('link');
    expect((link as { href: string }).href).toBe('https://e.com');
    expect(sliceOf(doc, link)).toBe(source.split('\n')[0]);
    // The definition line is consumed, not rendered as a second block.
    expect(doc.blocks).toHaveLength(1);
  });

  test('a title on the definition reaches the node', () => {
    const doc = parse('[foo][bar]\n\n[bar]: https://e.com "t"\n');
    expect(firstParagraph(doc)[0]).toMatchObject({ kind: 'link', title: 't' });
  });
});

describeNative('lazy container continuation', () => {
  /**
   * A line with no `>` still continues the paragraph inside a blockquote
   * (CommonMark §5.1, "laziness"), so the container's span reaches past the
   * last line that carries its own marker. A parser that ended the quote at
   * the unmarked line would produce two blocks where there is one — and the
   * streaming splice, which freezes settled blocks by span, would freeze a
   * block that a later append is about to grow.
   */
  test('an unmarked line continues the blockquote', () => {
    const doc = parse('> a\nb\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('blockquote');
    expect(doc.blocks[0].span).toEqual({ start: 0, end: 5 });
    const quoted = (doc.blocks[0] as { children: Block[] }).children;
    expect(quoted).toHaveLength(1);
    expect((quoted[0] as { children: Inline[] }).children.map((n) => n.kind)).toEqual([
      'text',
      'softBreak',
      'text',
    ]);
  });

  test('an unmarked line continues a list item', () => {
    const doc = parse('- a\nb\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('list');
    expect(doc.blocks[0].span).toEqual({ start: 0, end: 5 });
  });
});

describeNative("html: 'strip' keeps <br> as a line break", () => {
  /**
   * Stripping `<br>` would join two words, so it becomes a `hardBreak` spanning
   * exactly the tag.
   */
  test('an inline <br> becomes a hardBreak over the tag, not a hole', () => {
    const doc = parse('line one<br>line two\n', CM);
    const inlines = firstParagraph(doc);
    expect(inlines.map((n) => n.kind)).toEqual(['text', 'hardBreak', 'text']);
    expect(sliceOf(doc, inlines[1])).toBe('<br>');
    expect(inlines[0]).toMatchObject({ value: 'line one' });
    expect(inlines[2]).toMatchObject({ value: 'line two' });
  });

  test.each(['<br>', '<br/>', '<br />', '<BR>', '<br class="x">'])(
    '%s is a break in every written form',
    (tag) => {
      const doc = parse(`a${tag}b\n`, CM);
      const inlines = firstParagraph(doc);
      expect(inlines.map((n) => n.kind)).toEqual(['text', 'hardBreak', 'text']);
      expect(sliceOf(doc, inlines[1])).toBe(tag);
    },
  );

  test.each(['<brand>', '<br-thing>', '<br-separator/>', '<brx />'])(
    '%s merely starts with "br" and is still stripped',
    (tag) => {
      // `<br-thing>` is a custom element: the tag name must end at whitespace,
      // `/` or `>`.
      const doc = parse(`a${tag}b\n`, CM);
      expect(firstParagraph(doc).map((n) => n.kind)).toEqual(['text', 'text']);
    },
  );

  test('a closing </br> is nothing at all, not a break', () => {
    // Matching every HTML parser: a void element's end tag is ignored.
    const doc = parse('a</br>b\n', CM);
    expect(firstParagraph(doc).map((n) => n.kind)).toEqual(['text', 'text']);
  });

  test("under html: 'raw' it stays an htmlSpan, unchanged", () => {
    const doc = parse('a<br>b\n', RAW);
    const inlines = firstParagraph(doc);
    expect(inlines.map((n) => n.kind)).toEqual(['text', 'htmlSpan', 'text']);
    expect(inlines[1]).toMatchObject({ literal: '<br>' });
  });

  test('a <br> inside a GFM table cell breaks the cell line', () => {
    // GFM cells cannot contain a markdown hard break, so `<br>` is the only
    // one.
    const doc = parse('| h |\n| - |\n| x<br>y |\n', LLM);
    const table = doc.blocks[0] as { rows: { cells: { children: Inline[] }[] }[] };
    const cell = table.rows[0].cells[0];
    expect(cell.children.map((n) => n.kind)).toEqual(['text', 'hardBreak', 'text']);
    expect(sliceOf(doc, cell.children[1])).toBe('<br>');
  });

  test('an HTML block still takes its content with it', () => {
    // Stripping a block removes the construct; only `<br>` stands for something
    // the reader can see.
    const source = '<div>\nhello **world**\n</div>\n';
    expect(parse(source, CM).blocks).toEqual([]);
    expect(parse(source, RAW).blocks).toEqual([
      { kind: 'htmlBlock', span: { start: 0, end: 28 }, literal: '<div>\nhello **world**\n</div>' },
    ]);
  });
});

describeNative('HTML blocks and tabs', () => {
  test('a type-1 HTML block runs to its closing tag, across blank lines', () => {
    // `<pre>`/`<script>`/`<style>`/`<textarea>` blocks end at the closing tag
    // rather than at a blank line (CommonMark §4.6, condition 1), so the block
    // span covers the blank lines inside it and the literal keeps them.
    const source = '<pre>\n\nx\n\n</pre>\n';
    const doc = parseDocument(source, RAW, requireNativeEngine());
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('htmlBlock');
    expect(doc.blocks[0].span).toEqual({ start: 0, end: source.length - 1 });
    expect((doc.blocks[0] as { literal: string }).literal).toBe('<pre>\n\nx\n\n</pre>');
  });

  test('tab stops are real columns, not a fixed four spaces', () => {
    // The item's content column is 2, so a tab advances to column 4 and then
    // to column 8: four columns are consumed by the item indent and the code
    // block's own four, and exactly two spaces survive into the literal. A
    // parser that expanded every tab to four spaces would emit `bar` with no
    // leading space and lose the author's indentation.
    const doc = parse('- foo\n\n\t\tbar\n');
    const item = (doc.blocks[0] as { items: Block[] }).items[0];
    const code = (item as { children: Block[] }).children[1];
    expect(code.kind).toBe('codeBlock');
    expect((code as { literal: string }).literal).toBe('  bar\n');
  });
});

describeNative('permissive autolinks', () => {
  test('a bare URL containing parentheses is not autolinked', () => {
    // md4c's permissive-autolink character set excludes `(` and `)` outright,
    // where GitHub matches balanced pairs — so a URL with a paren in it stays
    // prose here and is tappable on github.com. Pinned rather than fixed: the
    // decoder takes md4c's answer verbatim, and this is where a reader finds
    // out why their `…/Foo_(bar)` wiki link is not a link.
    const source = 'see https://e.com/a(b) now\n';
    const doc = parse(source);
    expect(firstParagraph(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: source.length - 1 }, value: source.slice(0, -1) },
    ]);
  });

  test('the same URL without the parenthesis does autolink', () => {
    // Keeps the case above about the character set, and not about autolinks
    // being switched off.
    const doc = parse('see https://e.com/ab now\n');
    const [, link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'autolink', href: 'https://e.com/ab' });
    expect(sliceOf(doc, link)).toBe('https://e.com/ab');
  });

  test('autolinks stay literal text with the extension off', () => {
    const doc = parseDocument('see https://e.com now\n', CM, requireNativeEngine());
    expect(firstParagraph(doc).map((n) => n.kind)).toEqual(['text']);
  });

  test('a bare email address autolinks to a mailto: destination', () => {
    // The href gets md4c's `mailto:`; the span covers only what the author
    // typed, so a copy omits the invented scheme.
    const doc = parse('mail foo@e.com now\n');
    const [, link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'autolink', href: 'mailto:foo@e.com' });
    expect(sliceOf(doc, link)).toBe('foo@e.com');
  });

  test('an address with no host dot is not an autolink', () => {
    // md4c requires two dot-delimited host components, so `foo@localhost`
    // stays prose.
    const doc = parse('mail foo@localhost now\n');
    expect(firstParagraph(doc).map((n) => n.kind)).toEqual(['text']);
  });

  test('email autolinks follow the same extension switch as the others', () => {
    const doc = parseDocument('mail foo@e.com now\n', CM, requireNativeEngine());
    expect(firstParagraph(doc).map((n) => n.kind)).toEqual(['text']);
  });
});

describeNative('hrefs, titles and info strings are decoded exactly once', () => {
  /**
   * md4c already decodes destinations, titles and info strings; each case is
   * one where a second JS decoding pass would differ.
   */
  test('a doubly-encoded entity in a destination keeps its second layer', () => {
    const doc = parse('[a](https://e.com/?x=1&amp;amp;y=2)\n');
    const [link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'link', href: 'https://e.com/?x=1&amp;y=2' });
  });

  test('an escaped backslash in a destination stays a backslash', () => {
    const doc = parse('[a](https://e.com/a\\\\*b)\n');
    const [link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'link', href: 'https://e.com/a\\*b' });
  });

  test('a title decodes once', () => {
    const doc = parse('[a](https://e.com "t&amp;amp;u")\n');
    const [link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'link', title: 't&amp;u' });
  });

  test('an image src and title decode once', () => {
    const doc = parse('![alt](https://e.com/?x=1&amp;amp;y=2 "t&amp;amp;u")\n');
    const [img] = firstParagraph(doc);
    expect(img).toMatchObject({
      kind: 'image',
      src: 'https://e.com/?x=1&amp;y=2',
      title: 't&amp;u',
    });
  });

  test('a fence info string decodes once', () => {
    const doc = parse('```c&amp;lt;\nx\n```\n');
    expect(doc.blocks[0]).toMatchObject({ kind: 'codeBlock', language: 'c&lt;' });
  });

  test('an autolink URI keeps its backslash, and its entity is still decoded', () => {
    // md4c builds an autolink's destination with MD_BUILD_ATTR_NO_ESCAPES, so
    // `\*` survives while entities still resolve.
    const doc = parse('<https://e.com/?find=\\*&amp;lt;x>\n');
    const [link] = firstParagraph(doc);
    expect(link).toMatchObject({ kind: 'autolink', href: 'https://e.com/?find=\\*&lt;x' });
  });
});

describeNative('task list items', () => {
  test('the marker becomes state on the item and leaves the text alone', () => {
    const doc = parse('- [ ] a\n- [x] b\n');
    const items = (doc.blocks[0] as { items: Block[] }).items;
    expect(items.map((i) => (i as { task?: string }).task)).toEqual(['unchecked', 'checked']);
    // The checkbox is consumed by the item, so the paragraph inside starts
    // after it — a run that included `[ ] ` would put those characters on
    // screen twice, once as a checkbox and once as prose.
    const para = (items[0] as { children: Block[] }).children[0];
    expect(sliceOf(doc, para)).toBe('a');
  });

  test('an empty task item is still a task item', () => {
    // No content follows the marker, so there is nothing to attach the state
    // to except the item itself. It must not degrade to a plain item whose
    // text reads `[ ]`.
    const doc = parse('- [ ]\n');
    const item = (doc.blocks[0] as { items: Block[] }).items[0];
    expect(item).toMatchObject({ kind: 'listItem', task: 'unchecked', children: [] });
  });

  test('a task item inside a blockquote keeps its state', () => {
    const doc = parse('> - [x] a\n');
    const list = (doc.blocks[0] as { children: Block[] }).children[0];
    const item = (list as { items: Block[] }).items[0];
    expect(item).toMatchObject({ kind: 'listItem', task: 'checked' });
  });
});

// ---------------------------------------------------------------------------
// One document, every construct
// ---------------------------------------------------------------------------

describeNative('a document using every supported construct', () => {
  const source =
    '# Report\n\n' +
    'Intro with *em*, **strong**, `code`, ~~struck~~, _under_, $x$, ' +
    'an [link](https://e.com "t") and an ![img](https://e.com/i.png).\n\n' +
    '> - [x] quoted task\n> - [ ] another\n\n' +
    '| a | b |\n| :-- | --: |\n| 1 | 2 |\n\n' +
    '```py\nprint("hi")\n```\n\n' +
    '---\n\nLast &amp; final \\*literal\\* line.\n';
  const ALL: EngineOptions = {
    extensions: {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      math: true,
      spoilers: false,
      underline: true,
    },
    html: 'raw',
  };

  test('the blocks come out in source order, each spanning its own text', () => {
    // An integration case rather than a unit one: every extension is on at
    // once, which is the configuration where two features can fight over the
    // same delimiter (`_` between underline and emphasis, `|` between tables
    // and prose, `$` between math and currency).
    const doc = parseDocument(source, ALL, requireNativeEngine());
    expect(doc.blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'blockquote',
      'table',
      'codeBlock',
      'thematicBreak',
      'paragraph',
    ]);
    // Blocks tile the source in order and never overlap.
    let cursor = -1;
    for (const block of doc.blocks) {
      expect(block.span.start).toBeGreaterThan(cursor);
      expect(block.span.end).toBeLessThanOrEqual(source.length);
      cursor = block.span.end;
    }
  });

  test('the last paragraph decodes its entity and its escapes without moving', () => {
    // The one place `text.value` may differ from its own source slice. Both
    // halves are asserted together because a decoder that shortened the span
    // to match the shorter value would look right in every renderer and copy
    // back four characters too few.
    const doc = parseDocument(source, ALL, requireNativeEngine());
    const last = doc.blocks[doc.blocks.length - 1];
    const [text] = (last as { children: Inline[] }).children;
    expect((text as { value: string }).value).toBe('Last & final *literal* line.');
    expect(sliceOf(doc, text)).toBe('Last &amp; final \\*literal\\* line.');
  });
});

describeNative('HTML line-break whitespace', () => {
  test.each(['\n', '\r\n', '\r'])('consumes the source line ending after a stripped br: %j', (ending) => {
    const doc = parse(`foo<br>${ending}bar`);
    expect(firstParagraph(doc).map(node => node.kind)).toEqual(['text', 'hardBreak', 'text']);
    expect(firstParagraph(doc)[1].span).toEqual({ start: 3, end: 7 + ending.length });
  });

  test('keeps separately requested breaks', () => {
    expect(firstParagraph(parse('foo<br><br>bar')).map(node => node.kind))
      .toEqual(['text', 'hardBreak', 'hardBreak', 'text']);
  });
});

describeNative('empty container children', () => {
  test.each(['```\n\n```\n', '```\n  \n```\n', '> ```\n>\n> ```\n'])('a blank-only fence is closed: %j', source => {
    const doc = parse(source);
    const block = doc.blocks[0].kind === 'blockquote' ? doc.blocks[0].children[0] : doc.blocks[0];
    expect(block).toMatchObject({ kind: 'codeBlock', closed: true });
    expect(source.slice(block.span.start, block.span.start + 3)).toBe('```');
    expect(block.span.end).toBe(source.length - 1);
  });
  test('an empty heading excludes its quote marker', () => {
    const block = parse('> ##').blocks[0];
    expect(block.kind === 'blockquote' && block.children[0].span).toEqual({ start: 2, end: 4 });
  });
});
