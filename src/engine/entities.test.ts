/**
 * Entity decoding, and the invariant that keeps it from breaking selection.
 *
 * `entities.ts` is the JS fallback behind the decoder's Entity case. It is
 * small, it is pure, and what it does is the kind of thing that is wrong
 * quietly: a mis-decoded entity renders as slightly odd prose, and a
 * mis-measured one moves every offset after it.
 *
 * THE TWO HALVES OF AN ENTITY'S CONTRACT. `value` is what the reader sees;
 * `length` is how much raw source it consumed. The document model then keeps
 * the node's span over the RAW source, so a selection across `&amp;` copies
 * back the five characters the author typed rather than the one they see.
 * `length` is what makes that possible, so it is asserted everywhere `value`
 * is — a decoder that returned the right character and the wrong length would
 * look perfect on screen and shift every subsequent span by four.
 *
 * WHY A SUBSET OF NAMED ENTITIES, AND WHAT THAT DOES NOT MEAN. CommonMark
 * admits the full HTML5 list — over two thousand names, a ~100 KB table.
 * This module ships the couple of dozen that appear in real prose, so
 * `&hearts;` and `&notanentity;` behave identically *at this seam*. They do
 * NOT behave identically in a parsed document: md4c decodes entity events
 * and attribute strings against its own complete table, so `&hearts;` renders
 * as ♥ and only genuinely unknown names stay literal. The end-to-end block at
 * the bottom of this file is what pins that, and the size trade here costs
 * nothing on the shipped path because nothing reaches this table on it.
 */

import { decodeEntityAt } from './entities';
import { parseDocument } from './Engine';
import { presets } from './options';
import { describeNative, requireNativeEngine } from './native/__tests__/support';
import type { Inline } from '../document/nodes';

/** Decode at position 0 — the only position these cases need. */
function at(text: string): { value: string; length: number } | null {
  return decodeEntityAt(text, 0);
}

describe('decodeEntityAt: named references', () => {
  test('the shipped subset decodes, consuming `&` through `;`', () => {
    expect(at('&amp;')).toEqual({ value: '&', length: 5 });
    expect(at('&lt;')).toEqual({ value: '<', length: 4 });
    expect(at('&gt;')).toEqual({ value: '>', length: 4 });
    expect(at('&quot;')).toEqual({ value: '"', length: 6 });
    expect(at('&apos;')).toEqual({ value: "'", length: 6 });
    expect(at('&nbsp;')).toEqual({ value: ' ', length: 6 });
    expect(at('&hellip;')).toEqual({ value: '…', length: 8 });
    expect(at('&mdash;')).toEqual({ value: '—', length: 7 });
  });

  test('a name outside the subset stays literal', () => {
    // Not an error and not a replacement character: the source text is left
    // exactly as written, which is what a reader who typed `&hearts;` sees.
    expect(at('&notanentity;')).toBeNull();
    expect(at('&hearts;')).toBeNull();
  });

  test('names are case-sensitive', () => {
    // HTML5 distinguishes `&amp;` from `&AMP;`; only the lowercase spellings
    // are in the table, and an unrecognized one must degrade to literal text
    // rather than guessing.
    expect(at('&AMP;')).toBeNull();
  });

  test('an unterminated entity is not an entity', () => {
    // The missing `;` is the case streaming hits constantly: `&amp` arrives
    // one character before `&amp;` does, and it has to render as those four
    // literal characters until the semicolon lands.
    expect(at('&amp')).toBeNull();
    expect(at('&')).toBeNull();
    expect(at('&;')).toBeNull();
  });

  test('a position that is not `&` decodes nothing', () => {
    expect(decodeEntityAt('a&amp;', 0)).toBeNull();
    expect(decodeEntityAt('a&amp;', 1)).toEqual({ value: '&', length: 5 });
  });
});

describe('decodeEntityAt: numeric references', () => {
  test('decimal and hexadecimal, in either case of the `x`', () => {
    expect(at('&#65;')).toEqual({ value: 'A', length: 5 });
    expect(at('&#x42;')).toEqual({ value: 'B', length: 6 });
    expect(at('&#X42;')).toEqual({ value: 'B', length: 6 });
  });

  test('an astral code point decodes to its surrogate pair', () => {
    // Two UTF-16 code units from nine source characters. Both numbers matter:
    // the value is what a `<Text>` measures, the length is what every later
    // span is offset by.
    const emoji = at('&#x1F600;');
    expect(emoji).toEqual({ value: '😀', length: 9 });
    expect(emoji?.value.length).toBe(2);
  });

  test('NUL, out-of-range and lone surrogates all fold to U+FFFD', () => {
    // CommonMark §2.3 mandates U+FFFD for these, and the reason is not
    // pedantry: a literal NUL terminates strings in the C++ half of this
    // package, and a lone surrogate is an unpaired code unit that makes the
    // JS string ill-formed — `JSON.stringify` on it throws, which would take
    // out the streaming oracle rather than one character.
    expect(at('&#0;')).toEqual({ value: '�', length: 4 });
    expect(at('&#x0;')).toEqual({ value: '�', length: 5 });
    expect(at('&#1114112;')).toEqual({ value: '�', length: 10 }); // 0x110000
    expect(at('&#xD800;')).toEqual({ value: '�', length: 8 });
    expect(at('&#xdfff;')).toEqual({ value: '�', length: 8 });
  });

  test('the highest valid code point still decodes', () => {
    // The boundary on the other side of the fold above.
    expect(at('&#x10FFFF;')).toEqual({ value: '\u{10FFFF}', length: 10 });
  });

  test('digit runs longer than the format allows are not entities', () => {
    // Six hex digits and seven decimal ones cover every code point, so a
    // longer run is malformed rather than large. Left literal.
    expect(at('&#x0000041;')).toBeNull();
    expect(at('&#00000065;')).toBeNull();
    expect(at('&#;')).toBeNull();
    expect(at('&#x;')).toBeNull();
  });

  test('the lookahead is capped, so a stray `&` costs O(1)', () => {
    // Prose is full of bare ampersands, and every one of them is a candidate.
    // The scan window is a fixed 31 characters past the `&`, so a document
    // with an `&` on one line and a `;` on the next does not turn inline
    // decoding quadratic — and no entity this package knows is anywhere near
    // that long.
    expect(at(`&${'a'.repeat(100_000)};`)).toBeNull();
    expect(at(`&#${'0'.repeat(100_000)}65;`)).toBeNull();
  });
});

describeNative('the span-versus-value invariant, end to end', () => {
  test('a text node decodes its entity while its span covers the raw source', () => {
    // The property the two halves of the contract exist to preserve. `value`
    // is what the native host draws; the span is what `copy` slices and what
    // the streaming splice shifts. They are deliberately different lengths
    // here.
    const source = 'a &amp; b\n';
    const doc = parseDocument(source, presets.commonmark, requireNativeEngine());
    const [text] = (doc.blocks[0] as { children: Inline[] }).children;
    expect(text).toMatchObject({ kind: 'text', value: 'a & b' });
    expect(doc.source.slice(text.span.start, text.span.end)).toBe('a &amp; b');
  });

  test('an entity in a link destination is decoded onto the href', () => {
    const source = '[a](https://e.com?x=1&amp;y=2)\n';
    const doc = parseDocument(source, presets.commonmark, requireNativeEngine());
    const [link] = (doc.blocks[0] as { children: Inline[] }).children;
    expect(link).toMatchObject({ kind: 'link', href: 'https://e.com?x=1&y=2' });
    // The node still spans the construct as written, entity and all.
    expect(doc.source.slice(link.span.start, link.span.end)).toBe(source.slice(0, -1));
  });

  test('a name this table does not carry still decodes, because md4c does', () => {
    // The counterpart to the size trade in the header: `hearts` is not in
    // NAMED_ENTITIES, and the rendered document has ♥ in it anyway. A test
    // that only asserted `at('&hearts;') === null` would leave a reader
    // believing this package renders `&hearts;` literally.
    const doc = parseDocument('x &hearts; y\n', presets.commonmark, requireNativeEngine());
    const [text] = (doc.blocks[0] as { children: Inline[] }).children;
    expect(text).toMatchObject({ kind: 'text', value: 'x ♥ y' });
  });

  test('a genuinely unknown name stays literal, span and value alike', () => {
    const doc = parseDocument('x &notanentity; y\n', presets.commonmark, requireNativeEngine());
    const [text] = (doc.blocks[0] as { children: Inline[] }).children;
    expect(text).toMatchObject({ kind: 'text', value: 'x &notanentity; y' });
  });
});
