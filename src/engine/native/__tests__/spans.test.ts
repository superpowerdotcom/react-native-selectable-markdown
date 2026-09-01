/**
 * Properties of the native decoder alone.
 *
 * `documents.test.ts` pins named constructs against hand-written expected
 * offsets; these pin the decoder against the document model's own contract,
 * over a corpus far too large to write expectations for — all 652 CommonMark
 * 0.31.2 spec examples plus the streaming fixtures. The two are complementary:
 * one says what a particular document must be, this one says what EVERY
 * document must be. Spans are the part of the model no HTML comparison can
 * check: `serialize-html.ts` would produce identical output from a tree whose
 * offsets were all wrong, and every consumer above the engine (selection,
 * copy, the streaming splice) reads offsets.
 *
 * The four invariants asserted over the corpus:
 *
 *   1. every span is in bounds and `start <= end`;
 *   2. every child's span lies inside its parent's;
 *   3. consecutive siblings do not overlap;
 *   4. a node's slice is non-empty unless the construct is legitimately
 *      empty (only a thematic break and an empty list item can be).
 *
 * Plus an exact statement of how a text node's `value` may differ from its
 * source slice — the one place the model deliberately allows divergence.
 *
 * KNOWN FAILURES ARE LISTED, NOT SUPPRESSED. Two decoder bugs currently
 * violate these invariants; each appears as an explicit entry in the
 * expected-violation list below with its cause. Asserting the exact list
 * (rather than "at most N") means both a regression and a fix change the
 * result, so neither can pass unnoticed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AnyNode, ParsedDocument } from '../../../document/nodes';
import { childrenOf } from '../../../document/visit';
import { parseDocument } from '../../Engine';
import type { EngineOptions } from '../../options';
import { presets } from '../../options';
import { describeNative, requireNativeEngine } from './support';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'conformance', 'fixtures');
const SPEC_PATH = path.join(ROOT, 'conformance', 'vendor', 'spec.json');

interface SpecExample {
  readonly markdown: string;
  readonly example: number;
  readonly section: string;
}

const SPEC: readonly SpecExample[] = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

/**
 * Conformance options: the URL allowlist is opened because spec examples use
 * `ftp:`, `javascript:` and friends, and a blocked link becomes a text node —
 * which would exercise a different span path than the one being measured.
 */
const OPEN: EngineOptions['urlPolicy'] = { linkPrefixes: [''], imagePrefixes: [''] };
const SPEC_STRIP: EngineOptions = { ...presets.commonmark, html: 'strip', urlPolicy: OPEN };
const SPEC_RAW: EngineOptions = { ...presets.commonmark, html: 'raw', urlPolicy: OPEN };
const EVERYTHING: EngineOptions = {
  extensions: { ...presets.everything.extensions, spoilers: false },
  html: 'raw',
  smartPunctuation: true,
};

// ---------------------------------------------------------------------------
// The invariant checker
// ---------------------------------------------------------------------------

/**
 * Kinds whose source really can be zero characters wide. A thematic break
 * inside a container and a marker-only list item both reach the decoder with
 * no text to anchor to; everything else with an empty span is a bug.
 */
const MAY_BE_EMPTY: ReadonlySet<string> = new Set(['thematicBreak', 'listItem']);

/** One line per violation: `<where> <invariant> <detail>`. */
function check(source: string, doc: ParsedDocument, where: string, out: string[]): void {
  const walk = (node: AnyNode, parent: AnyNode | null): void => {
    const { start, end } = node.span;
    if (start < 0 || end < start || end > source.length) {
      out.push(`${where} bounds ${node.kind}`);
    } else {
      if (parent !== null && (start < parent.span.start || end > parent.span.end)) {
        out.push(`${where} containment ${node.kind} in ${parent.kind}`);
      }
      if (start === end && !MAY_BE_EMPTY.has(node.kind)) {
        out.push(`${where} empty ${node.kind}`);
      }
    }
    let previous: AnyNode | null = null;
    for (const child of childrenOf(node)) {
      if (
        previous !== null &&
        previous.span.start >= 0 &&
        child.span.start >= 0 &&
        previous.span.end > child.span.start
      ) {
        out.push(`${where} overlap ${previous.kind}+${child.kind} in ${node.kind}`);
      }
      previous = child;
    }
    for (const child of childrenOf(node)) walk(child, node);
  };

  let previous: AnyNode | null = null;
  for (const block of doc.blocks) {
    if (previous !== null && previous.span.end > block.span.start) {
      out.push(`${where} overlap ${previous.kind}+${block.kind} in document`);
    }
    previous = block;
    walk(block, null);
  }
}

function sweepSpec(options: EngineOptions): string[] {
  const engine = requireNativeEngine();
  const out: string[] = [];
  for (const example of SPEC) {
    const doc = parseDocument(example.markdown, options, engine);
    check(example.markdown, doc, `ex${example.example}`, out);
  }
  return out;
}

function sweepFixtures(
  options: EngineOptions,
  rewrite: (source: string) => string = (source) => source,
): string[] {
  const engine = requireNativeEngine();
  const out: string[] = [];
  for (const file of FIXTURES) {
    const source = rewrite(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
    check(source, parseDocument(source, options, engine), file, out);
  }
  return out;
}

describeNative('span invariants over the CommonMark spec corpus', () => {
  test('the corpus is the real one', () => {
    // A truncated or missing spec.json would make every sweep below vacuous.
    expect(SPEC.length).toBe(652);
    expect(FIXTURES.length).toBeGreaterThanOrEqual(6);
  });

  test('no example throws', () => {
    const engine = requireNativeEngine();
    for (const example of SPEC) {
      // Both HTML policies, because they take different decoder paths.
      expect(() => parseDocument(example.markdown, SPEC_STRIP, engine)).not.toThrow();
      expect(() => parseDocument(example.markdown, SPEC_RAW, engine)).not.toThrow();
    }
  });

  /**
   * Bounds, containment and sibling disjointness over all 652 examples, in
   * both HTML policies. The list is asserted empty rather than "small": the
   * two constructs that used to appear here were real defects, and an
   * expected-violations list is how a defect becomes permanent.
   *
   * ex568 (`[foo](not a link)` with a definition for `[foo]`) was the
   * sibling-overlap case: md4c resolves the shortcut reference and leaves
   * the parentheses as literal text, so the link's tail scan must not
   * consume them. Examples 491/615/616/625/642/643 were the unanchored
   * `htmlSpan` case, where md4c synthesizes the text of an HTML span that
   * crosses a line break and the node has to be located rather than pushed
   * with no offsets at all.
   */
  test('every span holds, under the default html policy', () => {
    expect(sweepSpec(SPEC_STRIP)).toEqual([]);
  });

  test('every span holds with raw HTML', () => {
    expect(sweepSpec(SPEC_RAW)).toEqual([]);
  });

  test('every span holds over the streaming fixtures', () => {
    expect(sweepFixtures(presets.llmChat)).toEqual([]);
    expect(sweepFixtures(EVERYTHING)).toEqual([]);
  });

  /**
   * The same corpus with the other two CommonMark line endings.
   *
   * A line ending is the one construct whose *width* varies (`\r\n` is two
   * characters, `\n` and `\r` are one), and the decoder recovers break
   * offsets by searching the source rather than being told them. Both facts
   * were wrong at once: a break span used to cover half of a CRLF pair, and
   * a bare `\r` matched nothing at all and left the node unanchored — a
   * `{-1,-1}` that the streaming splice then rebased into a plausible,
   * in-bounds, wrong offset. LF-only fixtures cannot see any of that.
   */
  test('every span holds with CRLF and with bare CR line endings', () => {
    expect(sweepFixtures(presets.llmChat, (s) => s.replace(/\n/g, '\r\n'))).toEqual([]);
    expect(sweepFixtures(EVERYTHING, (s) => s.replace(/\n/g, '\r\n'))).toEqual([]);
    expect(sweepFixtures(presets.llmChat, (s) => s.replace(/\n/g, '\r'))).toEqual([]);
    expect(sweepFixtures(EVERYTHING, (s) => s.replace(/\n/g, '\r'))).toEqual([]);
  });

  test('the CRLF sweep is not vacuous', () => {
    // Guards the guard: if the rewrite produced no break nodes the sweep
    // above would pass on a corpus that never exercises a line ending.
    const engine = requireNativeEngine();
    const source = fs
      .readFileSync(path.join(FIXTURE_DIR, FIXTURES[0]), 'utf8')
      .replace(/\n/g, '\r\n');
    let breaks = 0;
    const walk = (node: AnyNode): void => {
      if (node.kind === 'softBreak' || node.kind === 'hardBreak') breaks += 1;
      for (const child of childrenOf(node)) walk(child);
    };
    for (const block of parseDocument(source, EVERYTHING, engine).blocks) walk(block);
    expect(breaks).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Text nodes: exactly how far `value` may drift from the source
// ---------------------------------------------------------------------------

/**
 * With smart punctuation off, only three things can make a text node's value
 * differ from its raw slice: a backslash escape, an entity reference, and a
 * NUL byte (rendered U+FFFD). So a slice holding no `\` and no `&` must equal
 * its value verbatim — the corpus contains no raw NUL, which the spec writes
 * as `&#0;` and the fixtures do not use at all, so the third case is pinned
 * by its own test below rather than by this rule.
 */
const REWRITABLE_OFF = /[\\&]/;
/** With smart punctuation on, add the characters cmark --smart rewrites. */
const REWRITABLE_ON = /[\\&"'.\-]/;

function textNodes(doc: ParsedDocument): AnyNode[] {
  const out: AnyNode[] = [];
  const walk = (node: AnyNode): void => {
    if (node.kind === 'text') out.push(node);
    for (const child of childrenOf(node)) walk(child);
  };
  for (const block of doc.blocks) walk(block);
  return out;
}

describeNative('text nodes carry their source', () => {
  const corpus = (): Array<{ where: string; source: string; options: EngineOptions; smart: boolean }> => {
    const out: Array<{ where: string; source: string; options: EngineOptions; smart: boolean }> = [];
    for (const example of SPEC) {
      out.push({ where: `ex${example.example}`, source: example.markdown, options: SPEC_STRIP, smart: false });
      out.push({ where: `ex${example.example} raw`, source: example.markdown, options: SPEC_RAW, smart: false });
      out.push({
        where: `ex${example.example} smart`,
        source: example.markdown,
        options: { ...SPEC_RAW, smartPunctuation: true },
        smart: true,
      });
    }
    for (const file of FIXTURES) {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      out.push({ where: file, source, options: presets.llmChat, smart: false });
      out.push({ where: `${file} smart`, source, options: EVERYTHING, smart: true });
    }
    return out;
  };

  test('a value is never longer than the source it came from', () => {
    // Every rewrite the decoder performs shrinks or preserves length: an
    // entity is at least as long as what it decodes to, an escape drops its
    // backslash, `...` becomes one character, `--` becomes one. A value that
    // grew would mean text was invented, which selection cannot map back.
    const engine = requireNativeEngine();
    const failures: string[] = [];
    for (const item of corpus()) {
      const doc = parseDocument(item.source, item.options, engine);
      for (const node of textNodes(doc)) {
        const slice = item.source.slice(node.span.start, node.span.end);
        if ((node as { value: string }).value.length > slice.length) {
          failures.push(`${item.where}: ${JSON.stringify(slice)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('a value with nothing rewritable in its slice IS its slice', () => {
    const engine = requireNativeEngine();
    const failures: string[] = [];
    let compared = 0;
    for (const item of corpus()) {
      const rewritable = item.smart ? REWRITABLE_ON : REWRITABLE_OFF;
      const doc = parseDocument(item.source, item.options, engine);
      for (const node of textNodes(doc)) {
        const slice = item.source.slice(node.span.start, node.span.end);
        if (rewritable.test(slice)) continue;
        compared += 1;
        if ((node as { value: string }).value !== slice) {
          failures.push(
            `${item.where}: ${JSON.stringify((node as { value: string }).value)} != ${JSON.stringify(slice)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    // Non-vacuousness: the vast majority of text nodes take this path.
    expect(compared).toBeGreaterThan(1000);
  });

  test('entities and escapes keep the RAW source in the span', () => {
    const engine = requireNativeEngine();
    const doc = parseDocument('a &amp; b \\* c &#x41;\n', SPEC_STRIP, engine);
    const [text] = textNodes(doc);
    expect(text.span).toEqual({ start: 0, end: 21 });
    expect(doc.source.slice(text.span.start, text.span.end)).toBe('a &amp; b \\* c &#x41;');
    expect((text as { value: string }).value).toBe('a & b * c A');
  });

  test('the `&#0;` spelling of a NUL keeps its raw source in the span', () => {
    const engine = requireNativeEngine();
    const doc = parseDocument('a&#0;b\n', SPEC_STRIP, engine);
    const [entity] = textNodes(doc);
    expect(entity.span).toEqual({ start: 0, end: 6 });
    expect((entity as { value: string }).value).toBe('a�b');
  });

  /**
   * A NUL is the one rewrite whose source is a single character that is not
   * `\` or `&`, so the rule above cannot see it: the span must still cover
   * the NUL, and the run it belongs to must stay one text node.
   */
  test('a NUL byte becomes U+FFFD without moving the span', () => {
    const engine = requireNativeEngine();
    const source = 'a\u0000b\n';
    const doc = parseDocument(source, SPEC_STRIP, engine);
    const nodes = textNodes(doc);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].span).toEqual({ start: 0, end: 3 });
    expect((nodes[0] as { value: string }).value).toBe('a�b');
  });
});

// ---------------------------------------------------------------------------
// widen.ts, construct by construct
// ---------------------------------------------------------------------------

/** The span of the exact first occurrence of `fragment` in `source`. */
function spanOf(source: string, fragment: string, from = 0): { start: number; end: number } {
  const start = source.indexOf(fragment, from);
  if (start < 0) throw new Error(`fragment not in source: ${JSON.stringify(fragment)}`);
  return { start, end: start + fragment.length };
}

/** Every node in document order, so a test can name one by kind + index. */
function flatten(doc: ParsedDocument): AnyNode[] {
  const out: AnyNode[] = [];
  const walk = (node: AnyNode): void => {
    out.push(node);
    for (const child of childrenOf(node)) walk(child);
  };
  for (const block of doc.blocks) walk(block);
  return out;
}

function nodeOf(doc: ParsedDocument, kind: string, index = 0): AnyNode {
  const found = flatten(doc).filter((n) => n.kind === kind);
  if (found.length <= index) {
    throw new Error(
      `no ${kind}[${index}] in ${JSON.stringify(flatten(doc).map((n) => n.kind))}`,
    );
  }
  return found[index];
}

describeNative('widening recovers the exact construct source', () => {
  const parse = (source: string, options: EngineOptions = presets.llmChat): ParsedDocument =>
    parseDocument(source, options, requireNativeEngine());

  /** Asserts a node's span is exactly the given source fragment. */
  const expectSpan = (
    doc: ParsedDocument,
    kind: string,
    index: number,
    fragment: string,
    from = 0,
  ): void => {
    const node = nodeOf(doc, kind, index);
    expect({ kind, span: node.span }).toEqual({ kind, span: spanOf(doc.source, fragment, from) });
  };

  test('nested emphasis widens one delimiter at a time', () => {
    // The inner strong widens to `**x**` first; the outer emphasis then takes
    // one more `*` from each side of THAT result. Widening from the raw
    // content range would give both nodes the same span.
    const doc = parse('***x***\n');
    expectSpan(doc, 'emphasis', 0, '***x***');
    expectSpan(doc, 'strong', 0, '**x**');
    expectSpan(doc, 'text', 0, 'x');
  });

  test('mixed nesting keeps each level on its own delimiters', () => {
    const doc = parse('*a **b** c*\n');
    expectSpan(doc, 'emphasis', 0, '*a **b** c*');
    expectSpan(doc, 'strong', 0, '**b**');
  });

  test('underline nests two levels on `__x__`', () => {
    // MD_FLAG_UNDERLINE makes every matched underscore one underline level,
    // so this is two nested nodes, never a strong — and each widens by one.
    const doc = parse('__x__\n', { extensions: { underline: true } });
    expectSpan(doc, 'underline', 0, '__x__');
    expectSpan(doc, 'underline', 1, '_x_');
  });

  test('underline leaves an unmatched underscore literal', () => {
    const doc = parse('__x_\n', { extensions: { underline: true } });
    expectSpan(doc, 'underline', 0, '_x_');
    expectSpan(doc, 'text', 0, '_');
  });

  test('code spans widen over their backtick run', () => {
    expectSpan(parse('`x`\n'), 'codeSpan', 0, '`x`');
    expectSpan(parse('``a``\n'), 'codeSpan', 0, '``a``');
    // The classic run case: two backticks around a literal backtick, with the
    // stripped space on each side that CommonMark removes from the value.
    const run = parse('`` ` ``\n');
    expectSpan(run, 'codeSpan', 0, '`` ` ``');
    expect((nodeOf(run, 'codeSpan') as { value: string }).value).toBe('`');
  });

  test('code spans re-take the space the parser stripped', () => {
    const doc = parse('` x `\n');
    expectSpan(doc, 'codeSpan', 0, '` x `');
    expect((nodeOf(doc, 'codeSpan') as { value: string }).value).toBe('x');
  });

  test('a code span of only spaces keeps its source', () => {
    const doc = parse('`  `\n');
    expectSpan(doc, 'codeSpan', 0, '`  `');
  });

  test('links widen over balanced parens and titles', () => {
    expectSpan(parse('[a](https://e.com)\n'), 'link', 0, '[a](https://e.com)');
    expectSpan(parse('[a](https://e.com "t")\n'), 'link', 0, '[a](https://e.com "t")');
    expectSpan(parse('[a](https://e.com/(x)/y)\n'), 'link', 0, '[a](https://e.com/(x)/y)');
    expectSpan(parse('[a](https://e.com/\\(x\\))\n'), 'link', 0, '[a](https://e.com/\\(x\\))');
  });

  test('an unterminated destination consumes nothing', () => {
    // What streaming sees constantly: a half-typed link must not swallow the
    // rest of the paragraph. Nothing closes, so nothing is taken and md4c
    // leaves the whole line as text.
    const doc = parse('[a](https://exa\n');
    expect(doc.blocks[0].kind).toBe('paragraph');
    expectSpan(doc, 'text', 0, '[a](https://exa');
  });

  test('images widen over their `!`', () => {
    expectSpan(parse('![a](https://e.com/i.png)\n'), 'image', 0, '![a](https://e.com/i.png)');
    expectSpan(
      parse('![a](https://e.com/i.png "t")\n'),
      'image',
      0,
      '![a](https://e.com/i.png "t")',
    );
    // An image inside a link: the link's span must contain the image's.
    const nested = parse('[![a](https://e.com/i.png)](https://e.com)\n');
    expectSpan(nested, 'link', 0, '[![a](https://e.com/i.png)](https://e.com)');
    expectSpan(nested, 'image', 0, '![a](https://e.com/i.png)');
  });

  test('angle autolinks widen over their brackets, bare ones do not', () => {
    expectSpan(parse('see <https://e.com> ok\n'), 'autolink', 0, '<https://e.com>');
    // A permissive autolink has no delimiters at all; widening by anything
    // would eat the surrounding prose.
    expectSpan(parse('see www.e.com ok\n'), 'autolink', 0, 'www.e.com');
    expectSpan(parse('see https://e.com/a ok\n'), 'autolink', 0, 'https://e.com/a');
  });

  test('ATX headings widen over their marker and optional closing run', () => {
    expectSpan(parse('# Title\n'), 'heading', 0, '# Title');
    expectSpan(parse('## T ##\n'), 'heading', 0, '## T ##');
    expectSpan(parse('###### deep\n'), 'heading', 0, '###### deep');
  });

  test('setext headings widen down over their underline', () => {
    expectSpan(parse('Title\n=====\n'), 'heading', 0, 'Title\n=====');
    expectSpan(parse('Title\n-----\n'), 'heading', 0, 'Title\n-----');
    // Two content lines, then the underline.
    expectSpan(parse('one\ntwo\n===\n'), 'heading', 0, 'one\ntwo\n===');
  });

  test('a heading with no text still covers its marker', () => {
    const doc = parse('## \n');
    expectSpan(doc, 'heading', 0, '##');
  });

  test('fences widen to their opening and closing lines, and report closure', () => {
    const closed = parse('```js\nx\n```\n');
    expectSpan(closed, 'codeBlock', 0, '```js\nx\n```');
    expect(nodeOf(closed, 'codeBlock')).toMatchObject({ fenced: true, closed: true, language: 'js' });

    const open = parse('```js\nx\n');
    expectSpan(open, 'codeBlock', 0, '```js\nx');
    expect(nodeOf(open, 'codeBlock')).toMatchObject({ fenced: true, closed: false });

    const tilde = parse('~~~\na ``` b\n~~~\n');
    expectSpan(tilde, 'codeBlock', 0, '~~~\na ``` b\n~~~');
    expect(nodeOf(tilde, 'codeBlock')).toMatchObject({ closed: true });
  });

  test('indented code widens to the indentation that makes it code', () => {
    const doc = parse('    x\n');
    expectSpan(doc, 'codeBlock', 0, '    x');
    expect(nodeOf(doc, 'codeBlock')).toMatchObject({ fenced: false, closed: true });
  });

  test('a fence inside a blockquote leaves the `>` to the blockquote', () => {
    // The rule the whole module is built around: widen outward by THIS
    // construct's own syntax and stop, so the container prefix stays outside.
    const doc = parse('> ```\n> code\n> ```\n');
    expectSpan(doc, 'blockquote', 0, '> ```\n> code\n> ```');
    expectSpan(doc, 'codeBlock', 0, '```\n> code\n> ```');
  });

  test('a list inside a blockquote starts at its bullet', () => {
    const doc = parse('> - a\n> - b\n');
    expectSpan(doc, 'blockquote', 0, '> - a\n> - b');
    expectSpan(doc, 'listItem', 0, '- a');
    expectSpan(doc, 'listItem', 1, '- b', 6);
  });

  test('nested blockquotes each take one `>`', () => {
    const doc = parse('> > a\n');
    expectSpan(doc, 'blockquote', 0, '> > a');
    expectSpan(doc, 'blockquote', 1, '> a');
  });

  test('list items widen over their marker', () => {
    const bullets = parse('- a\n- b\n');
    expectSpan(bullets, 'listItem', 0, '- a');
    expectSpan(bullets, 'listItem', 1, '- b');
    const ordered = parse('5. a\n6. b\n');
    expectSpan(ordered, 'listItem', 0, '5. a');
    expect(nodeOf(ordered, 'list')).toMatchObject({ ordered: true, start: 5 });
    expectSpan(parse('1) a\n'), 'listItem', 0, '1) a');
  });

  test('task items widen over the checkbox md4c consumes', () => {
    const doc = parse('- [x] done\n- [ ] todo\n');
    expectSpan(doc, 'listItem', 0, '- [x] done');
    expectSpan(doc, 'listItem', 1, '- [ ] todo');
    expect(nodeOf(doc, 'listItem', 0)).toMatchObject({ task: 'checked' });
    expect(nodeOf(doc, 'listItem', 1)).toMatchObject({ task: 'unchecked' });
  });

  test('a task item inside a blockquote stops at its bullet', () => {
    const doc = parse('> - [x] a\n');
    expectSpan(doc, 'blockquote', 0, '> - [x] a');
    expectSpan(doc, 'listItem', 0, '- [x] a');
  });

  test('table rows are whole lines and the table covers its delimiter row', () => {
    const doc = parse('| a | b |\n| :- | -: |\n| 1 | 2 |\n');
    expectSpan(doc, 'table', 0, '| a | b |\n| :- | -: |\n| 1 | 2 |');
    expectSpan(doc, 'tableRow', 0, '| a | b |');
    expectSpan(doc, 'tableRow', 1, '| 1 | 2 |');
    expectSpan(doc, 'tableCell', 0, 'a');
    expect(nodeOf(doc, 'table')).toMatchObject({ align: ['left', 'right'] });
  });

  test('a header-only table still reaches its delimiter row', () => {
    // The delimiter row carries no text at all, so it exists only as the line
    // after the header — the case `widenTable`'s `headerEnd` argument is for.
    const doc = parse('| a | b |\n| --- | --- |\n');
    expectSpan(doc, 'table', 0, '| a | b |\n| --- | --- |');
    expect((nodeOf(doc, 'table') as { rows: unknown[] }).rows).toEqual([]);
  });

  test('a quoted table keeps the `>` outside its rows', () => {
    const doc = parse('> | a |\n> | - |\n> | 1 |\n');
    expectSpan(doc, 'tableRow', 0, '| a |');
    expectSpan(doc, 'tableRow', 1, '| 1 |', 16);
  });

  test('hard breaks widen left over the whitespace that made them', () => {
    const spaces = parse('a  \nb\n');
    expectSpan(spaces, 'hardBreak', 0, '  \n');
    const slash = parse('a\\\nb\n');
    expectSpan(slash, 'hardBreak', 0, '\\\n');
  });

  test('a soft break is exactly its newline', () => {
    expectSpan(parse('a\nb\n'), 'softBreak', 0, '\n');
  });

  test('a thematic break is located even though nothing anchors it', () => {
    expectSpan(parse('a\n\n---\n\nb\n'), 'thematicBreak', 0, '---');
    expectSpan(parse('***\n'), 'thematicBreak', 0, '***');
    expectSpan(parse('a\n\n* * *\n'), 'thematicBreak', 0, '* * *');
  });

  test('math widens by one `$` inline and two for display', () => {
    const inline = parse('$x$\n', { extensions: { math: true } });
    expectSpan(inline, 'math', 0, '$x$');
    expect(nodeOf(inline, 'math')).toMatchObject({ display: false, value: 'x' });
    const display = parse('$$x$$\n', { extensions: { math: true } });
    expectSpan(display, 'math', 0, '$$x$$');
    expect(nodeOf(display, 'math')).toMatchObject({ display: true });
  });

  test('strikethrough widens by two tildes', () => {
    expectSpan(parse('~~x~~\n'), 'strikethrough', 0, '~~x~~');
  });

  test('a blocked link keeps the whole construct in its span', () => {
    // The node becomes plain text, but the span must still cover the original
    // markdown so copying the selection reproduces it.
    const doc = parse('[a](javascript:alert(1))\n');
    expectSpan(doc, 'text', 0, '[a](javascript:alert(1))');
    expect((nodeOf(doc, 'text') as { value: string }).value).toBe('a');
  });

  test('a blocked image keeps its construct span and degrades to alt text', () => {
    const doc = parse('![a *b*](http://e.com/i.png)\n');
    expectSpan(doc, 'text', 0, '![a *b*](http://e.com/i.png)');
    expect((nodeOf(doc, 'text') as { value: string }).value).toBe('a b');
  });
});

// ---------------------------------------------------------------------------
// Known widening bugs, pinned
// ---------------------------------------------------------------------------

/**
 * Regression cases for four widening defects found by this suite and since
 * fixed. Each states the correct result and names what used to happen, so a
 * reintroduction is legible rather than just red.
 */
describeNative('widening defects that had to be fixed', () => {
  const parse = (source: string, options: EngineOptions = presets.llmChat): ParsedDocument =>
    parseDocument(source, options, requireNativeEngine());

  test('an empty task item covers its whole `- [ ]` marker', () => {
    // Was: span [0,4) = "- [ ". A task item's content range is the mark
    // character between the brackets, and `widenListItem` steps back over
    // `[` and the bullet but never forward over the closing `]`, so an item
    // with no text after the checkbox loses it.
    const doc = parse('- [ ]\n');
    const item = nodeOf(doc, 'listItem', 0);
    expect(doc.source.slice(item.span.start, item.span.end)).toBe('- [ ]');
  });

  test('display math delimited on its own lines keeps its `$$`', () => {
    // Was: math span [3,4) = "a". `widenDelimiters` looks for a `$`
    // immediately outside the content range and finds a newline, so it
    // widens by nothing and BOTH `$$` lines end up inside no node at all —
    // the paragraph's span collapses onto the content too.
    const source = '$$\na\n$$\n';
    const doc = parse(source, { extensions: { math: true } });
    const math = nodeOf(doc, 'math', 0);
    expect(doc.source.slice(math.span.start, math.span.end)).toBe('$$\na\n$$');
  });

  test('an empty table cell stays inside its own row line', () => {
    // A cell md4c reports with no text used to reach `anchoredSpan`'s
    // fallback, which locates it at "the first non-blank line at or after the
    // cursor" — a rule written for empty blocks, not for cells. It was:
    //   "| a | b |\n| --- | --- |\n| | 2 |\n" -> the empty leading cell spans
    //   the DELIMITER ROW [10,23), and its row's span [10,31) swallows that
    //   row too;
    //   "| a | b |\n| --- | --- |\n| 1 |\n"   -> the padding cell for the
    //   missing column spans [28,29), the row's closing "|".
    for (const source of [
      '| a | b |\n| --- | --- |\n| | 2 |\n',
      '| a | b |\n| --- | --- |\n| 1 |\n',
    ]) {
      const doc = parse(source);
      for (const row of (nodeOf(doc, 'table', 0) as { rows: AnyNode[] }).rows) {
        for (const cell of (row as { cells: AnyNode[] }).cells) {
          expect(doc.source.slice(cell.span.start, cell.span.end)).not.toMatch(/[|\n]/);
        }
        expect(doc.source.slice(row.span.start, row.span.end)).not.toContain('\n');
      }
    }
  });

  test('no node ever escapes with an unanchored span', () => {
    // The most consequential form of the empty-cell bug, and the one the
    // native streaming oracle tripped on for every table it streamed. When
    // the ragged row is the LAST thing in the source, `anchoredSpan`'s
    // fallback found no line after the cursor and returned null, so the
    // padding cell kept `W.NO_SPAN` — a {-1,-1} span in a finished document.
    // The streaming splice then rebases it: `shiftSpans` adds the session
    // anchor to -1, and the snapshot reports `anchor - 1` where a fresh parse
    // of the same text reports -1. Every prefix divergence in
    // conformance/streaming/prefix-oracle.test.ts has that shape.
    const source = '| a | b |\n| - | - |\n| S';
    const doc = parse(source);
    const negative = flatten(doc).filter((n) => n.span.start < 0 || n.span.end < 0);
    expect(negative).toEqual([]);
  });
});
