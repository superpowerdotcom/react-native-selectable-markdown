/**
 * `smartPunctuation` — the typographic pass, and everything it must not touch.
 *
 * The transform itself is four rules borrowed from `cmark --smart`: straight
 * quotes become directional ones, `--` and `---` become en and em dashes, and
 * `...` becomes an ellipsis. The interesting half is the exclusions. A code
 * span, a fenced block, a math run, an autolink URI, a link destination or
 * title, a backslash escape and an entity reference must all come out
 * BYTE-EXACT — an em dash inside a shell command or a curly quote inside a URL
 * is not a typographic improvement, it is corruption of content the author
 * marked as literal.
 *
 * The exclusions are not implemented as a list of exceptions, which is why
 * they are worth testing rather than reading: md4c reports every escape and
 * every entity as its own text event, and code, math and autolinks arrive as
 * their own node kinds, so the transform simply never sees them (see
 * `maybeSmartPunctuation` in decode.ts). That is a lovely property and a
 * fragile one — it holds only as long as those constructs keep arriving
 * separately, and nothing but this file would notice if one of them started
 * arriving as ordinary prose.
 *
 * THE SPAN INVARIANT. Smart punctuation is the second of only two places
 * where a text node's `value` may differ from its own source slice (entity
 * decoding is the other). The span keeps covering the RAW source either way,
 * so a selection over `--` copies back two hyphens, not an en dash. Every
 * end-to-end case below asserts both halves at once.
 *
 * Coverage previously carried by a second, pure-TypeScript parser's test
 * suite; the rules are md4c's and cmark's, so they are asserted here against
 * the engine that actually ships them, plus directly against the exported
 * transform for the flanking cases a document cannot isolate.
 */

import { parseDocument } from '../../Engine';
import type { EngineOptions } from '../../options';
import { presets } from '../../options';
import type { Inline, ParsedDocument } from '../../../document/nodes';
import { applySmartPunctuation } from '../decode';
import { describeNative, requireNativeEngine } from './support';

const SMART: EngineOptions = { ...presets.commonmark, smartPunctuation: true };
const SMART_RAW: EngineOptions = { ...SMART, html: 'raw' };
const SMART_MATH: EngineOptions = {
  ...SMART,
  extensions: { math: true, autolinks: true },
};

function parse(source: string, options: EngineOptions = SMART): ParsedDocument {
  return parseDocument(source, options, requireNativeEngine());
}

function inlines(doc: ParsedDocument): readonly Inline[] {
  return (doc.blocks[0] as { children: Inline[] }).children;
}

function sliceOf(doc: ParsedDocument, node: Inline): string {
  return doc.source.slice(node.span.start, node.span.end);
}

/** The value and the raw slice of the paragraph's only inline node. */
function valueAndSlice(source: string, options?: EngineOptions): [string, string] {
  const doc = parse(source, options);
  const [node] = inlines(doc);
  return [(node as { value: string }).value, sliceOf(doc, node)];
}

// ---------------------------------------------------------------------------
// The transform in isolation
// ---------------------------------------------------------------------------

/**
 * `before` is the character that preceded this slice in the same text run, or
 * `undefined` at the start of one. It is the entire flanking context the rule
 * needs: a quote opens at the start of a run, after whitespace, or after an
 * opening bracket, and closes everywhere else. That "everywhere else" is what
 * makes `don't` an apostrophe rather than an unbalanced opening quote, which
 * is the single most visible thing this rule gets right.
 */
describe('applySmartPunctuation', () => {
  test('a quote at the start of a run opens', () => {
    expect(applySmartPunctuation('"a"', undefined)).toBe('“a”');
    expect(applySmartPunctuation("'a'", undefined)).toBe('‘a’');
  });

  test('a quote after whitespace opens, after a letter closes', () => {
    expect(applySmartPunctuation('"a', ' ')).toBe('“a');
    expect(applySmartPunctuation('"a', 'x')).toBe('”a');
  });

  test('a quote after an opening bracket opens', () => {
    // `("a")` and `["a"]` are the cases: a bracket is punctuation, so a rule
    // written as "opens only after whitespace" would close here and produce
    // `(”a”)`.
    for (const bracket of ['(', '[', '{']) {
      expect(applySmartPunctuation('"a"', bracket)).toBe('“a”');
    }
  });

  test('an apostrophe mid-word closes', () => {
    expect(applySmartPunctuation("don't stop", undefined)).toBe('don’t stop');
  });

  test('dash runs follow cmark: 2 en, 3 em, and mixed beyond', () => {
    // cmark's rule is not "two dashes each": a run divisible by three is all
    // em dashes, one divisible by two is all en dashes, and anything else is
    // the closest mix. Four dashes are therefore TWO EN dashes, not an em and
    // an en — the case an intuitive implementation gets wrong.
    expect(applySmartPunctuation('a--b', undefined)).toBe('a–b');
    expect(applySmartPunctuation('a---b', undefined)).toBe('a—b');
    expect(applySmartPunctuation('a----b', undefined)).toBe('a––b');
    expect(applySmartPunctuation('a-b', undefined)).toBe('a-b');
  });

  test('three dots become one ellipsis', () => {
    expect(applySmartPunctuation('wait...', undefined)).toBe('wait…');
    expect(applySmartPunctuation('a..b', undefined)).toBe('a..b');
  });
});

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

describeNative('smart punctuation through the engine', () => {
  test('quotes, dashes and an ellipsis transform, and the span stays raw', () => {
    const source = '"a" and \'b\' -- c ... d\n';
    const [value, raw] = valueAndSlice(source);
    expect(value).toBe('“a” and ‘b’ – c … d');
    // Shorter value, unchanged span: the node still covers every character
    // the author typed, so copying the selection round-trips to the source.
    expect(raw).toBe('"a" and \'b\' -- c ... d');
    expect(value.length).toBeLessThan(raw.length);
  });

  test('a quote flanks on the SOURCE, so `*"a"*` opens', () => {
    // The emphasis delimiter is punctuation and `a` is alphanumeric, which
    // makes the quote left-flanking under cmark's reading. Judging by the
    // decoded text instead — where the `*` is gone and the quote is at the
    // start of a run — happens to reach the same answer here; judging by "the
    // preceding character is not whitespace" does not, and closes.
    const doc = parse('*"a"*\n');
    const [em] = inlines(doc);
    expect(em.kind).toBe('emphasis');
    expect((em as { children: Inline[] }).children[0]).toMatchObject({
      kind: 'text',
      value: '“a”',
    });
  });

  test('off by default: the same source keeps its straight quotes', () => {
    // The feature is opt-in, and this is the assertion that it stays that way.
    const doc = parseDocument('"a" -- b\n', presets.commonmark, requireNativeEngine());
    expect(inlines(doc)[0]).toMatchObject({ kind: 'text', value: '"a" -- b' });
  });
});

describeNative('what smart punctuation must never touch', () => {
  test('a code span', () => {
    const doc = parse('`"a" -- b`\n');
    const [code] = inlines(doc);
    expect(code.kind).toBe('codeSpan');
    expect((code as { value: string }).value).toBe('"a" -- b');
  });

  test('a fenced code block', () => {
    // Shell and source text is the whole reason the exclusion matters: `--` is
    // a flag prefix, and a smartened literal would be silently unrunnable.
    const doc = parse('```\ndiff --git a b\n"x"\n```\n');
    expect(doc.blocks[0]).toMatchObject({
      kind: 'codeBlock',
      literal: 'diff --git a b\n"x"\n',
    });
  });

  test('a math run', () => {
    const doc = parse('$"a" -- b$\n', SMART_MATH);
    expect(inlines(doc)[0]).toMatchObject({ kind: 'math', value: '"a" -- b' });
  });

  test('an autolink URI', () => {
    const doc = parse('<https://e.com/a--b>\n', SMART_MATH);
    expect(inlines(doc)[0]).toMatchObject({
      kind: 'autolink',
      href: 'https://e.com/a--b',
    });
  });

  test('a link destination and title, while the label still transforms', () => {
    // The one case where both behaviours appear in a single node: the label is
    // prose and gets curly quotes, the href and title are literal and do not.
    const doc = parse('["a"](https://e.com/x--y "t--t")\n');
    const [link] = inlines(doc);
    expect(link).toMatchObject({
      kind: 'link',
      href: 'https://e.com/x--y',
      title: 't--t',
    });
    expect((link as { children: Inline[] }).children[0]).toMatchObject({
      kind: 'text',
      value: '“a”',
    });
  });

  test('a backslash-escaped quote', () => {
    // `\"` is the author saying "a straight quote, literally". The escape is
    // its own text event, so the transform never sees it — and the span still
    // covers the backslash.
    const [value, raw] = valueAndSlice('\\"a\\"\n');
    expect(value).toBe('"a"');
    expect(raw).toBe('\\"a\\"');
  });

  test('an entity reference', () => {
    // `&quot;` decodes to a straight quote and stays one: an author who spells
    // the character out has already said which character they want.
    const [value, raw] = valueAndSlice('&quot;a&quot;\n');
    expect(value).toBe('"a"');
    expect(raw).toBe('&quot;a&quot;');
  });

  test('raw HTML, while the prose between tags transforms', () => {
    const doc = parse('<em>"a"</em>\n', SMART_RAW);
    expect(inlines(doc).map((n) => (n as { literal?: string; value?: string }).literal ?? (n as { value: string }).value)).toEqual([
      '<em>',
      '“a”',
      '</em>',
    ]);
  });
});
