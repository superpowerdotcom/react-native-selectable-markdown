/**
 * `extensions.underline` — md4c's `MD_FLAG_UNDERLINE`.
 *
 * The flag repurposes `_` rather than adding a delimiter: with it on, every
 * run of underscores that would have produced emphasis or strong produces
 * `underline` instead, and `*` is untouched. That is the whole feature, and
 * it is the kind of thing that reads as obviously correct and is easy to get
 * subtly wrong — `__x__` is the case, because the natural implementation
 * ("map strong to underline when the delimiter was `_`") gets ONE underline
 * node where md4c produces two nested ones.
 *
 * This coverage previously lived beside a second, pure-TypeScript parser and
 * asserted that both engines read the flag the same way. That parser is gone;
 * what is left is the only thing that was ever shipped — md4c's reading —
 * asserted directly. The `underline` node kind exists in the document model
 * for exactly this flag, so nothing else in the repository produces one and
 * nothing else would notice if it stopped appearing.
 */

import { parseDocument } from '../../Engine';
import type { EngineOptions } from '../../options';
import { presets } from '../../options';
import type { Inline, ParsedDocument } from '../../../document/nodes';
import { describeNative, requireNativeEngine } from './support';

const ON: EngineOptions = { extensions: { underline: true } };
const OFF: EngineOptions = presets.commonmark;

function parse(source: string, options: EngineOptions): ParsedDocument {
  return parseDocument(source, options, requireNativeEngine());
}

function inlines(doc: ParsedDocument): readonly Inline[] {
  return (doc.blocks[0] as { children: Inline[] }).children;
}

function childrenOf(node: Inline): readonly Inline[] {
  return (node as { children: Inline[] }).children;
}

describeNative('extensions.underline', () => {
  test('`_x_` is one underline node spanning its delimiters', () => {
    const doc = parse('_x_\n', ON);
    const [node] = inlines(doc);
    expect(node.kind).toBe('underline');
    expect(node.span).toEqual({ start: 0, end: 3 });
    expect(childrenOf(node)[0]).toMatchObject({ kind: 'text', value: 'x' });
  });

  test('`__x__` is TWO NESTED underlines, never a strong node', () => {
    // The case worth a test of its own. md4c treats the flag as "`_` means
    // underline", not "`_`-flavoured strong means underline", so a double
    // delimiter nests the same way `***x***` nests emphasis inside strong.
    // A renderer that expected one node here draws a single underline where
    // the author asked for a doubled one, and — worse — a `strong` node would
    // reach `runAttributes` and come out bold.
    const doc = parse('__x__\n', ON);
    const [outer] = inlines(doc);
    expect(outer.kind).toBe('underline');
    expect(outer.span).toEqual({ start: 0, end: 5 });

    const [inner] = childrenOf(outer);
    expect(inner.kind).toBe('underline');
    expect(inner.span).toEqual({ start: 1, end: 4 });
    expect(childrenOf(inner)[0]).toMatchObject({ kind: 'text', value: 'x' });
  });

  test('`__x_` leaves the unmatched underscore as literal text', () => {
    // Three delimiters, one closer: the innermost pair matches and the odd
    // leading `_` is prose. The span split is the assertion — the text node
    // must cover exactly the one character it renders, or a selection that
    // starts on the underscore lands inside the underline.
    const doc = parse('__x_\n', ON);
    const [literal, underline] = inlines(doc);
    expect(literal).toMatchObject({ kind: 'text', value: '_', span: { start: 0, end: 1 } });
    expect(underline.kind).toBe('underline');
    expect(underline.span).toEqual({ start: 1, end: 4 });
  });

  test('`*` emphasis is unaffected by the flag', () => {
    // The flag is about `_` alone. If it leaked into the `*` path an app that
    // turned underline on would lose italics entirely.
    const doc = parse('*a* __b__\n', ON);
    const [em, , und] = inlines(doc);
    expect(em.kind).toBe('emphasis');
    expect(em.span).toEqual({ start: 0, end: 3 });
    expect(und.kind).toBe('underline');
  });

  test('`_` is still never intraword', () => {
    // CommonMark's flanking rules apply before the flag does, so the reason
    // `snake_case_name` is safe has nothing to do with underline being off —
    // and turning underline on must not be a way to make identifiers in prose
    // start sprouting formatting.
    const doc = parse('snake_case_name\n', ON);
    expect(inlines(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: 15 }, value: 'snake_case_name' },
    ]);
  });

  test('with the flag off, `_x_` and `__x__` are ordinary emphasis and strong', () => {
    // The other half of the contract: the extension is opt-in, and a consumer
    // who never sets it must see plain CommonMark. `underline` must not appear
    // in a document at all.
    const single = parse('_x_\n', OFF);
    expect(inlines(single)[0].kind).toBe('emphasis');

    const double = parse('__x__\n', OFF);
    const [strong] = inlines(double);
    expect(strong.kind).toBe('strong');
    expect(strong.span).toEqual({ start: 0, end: 5 });
    expect(childrenOf(strong)[0]).toMatchObject({ kind: 'text', value: 'x' });
  });
});
