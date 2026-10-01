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
  test('common names decode, consuming `&` through `;`', () => {
    expect(at('&amp;')).toEqual({ value: '&', length: 5 });
    expect(at('&lt;')).toEqual({ value: '<', length: 4 });
    expect(at('&gt;')).toEqual({ value: '>', length: 4 });
    expect(at('&quot;')).toEqual({ value: '"', length: 6 });
    expect(at('&apos;')).toEqual({ value: "'", length: 6 });
    expect(at('&nbsp;')).toEqual({ value: ' ', length: 6 });
    expect(at('&hellip;')).toEqual({ value: '…', length: 8 });
    expect(at('&mdash;')).toEqual({ value: '—', length: 7 });
  });

  test('recognizes the full native table and preserves unknown names', () => {
    expect(at('&notanentity;')).toBeNull();
    expect(at('&constructor;')).toBeNull();
    expect(at('&toString;')).toBeNull();
    expect(at('&hearts;')).toEqual({ value: '♥', length: 8 });
    expect(at('&AMP;')).toEqual({ value: '&', length: 5 });
    expect(at('&Amp;')).toBeNull();
    expect(at('&fjlig;')).toEqual({ value: 'fj', length: 7 });
    expect(at('&NotEqualTilde;')).toEqual({ value: '≂̸', length: 15 });
    expect(at('&CounterClockwiseContourIntegral;')).toEqual({ value: '∳', length: 33 });
  });

  test('an unterminated entity is not an entity', () => {
    // The missing `;` is the case streaming hits constantly: `&amp` arrives
    // one character before `&amp;` does, and it has to render as those four
    // literal characters until the semicolon lands.
    expect(at('&amp')).toBeNull();
    expect(at('&amp;')).toEqual({ value: '&', length: 5 });
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
    // One digit fewer is the longest run each format accepts.
    expect(at('&#x000041;')).toEqual({ value: 'A', length: 10 });
    expect(at('&#0000065;')).toEqual({ value: 'A', length: 10 });
    expect(at('&#;')).toBeNull();
    expect(at('&#x;')).toBeNull();
  });

  test('the lookahead is capped, so a stray `&` costs O(1)', () => {
    // Prose is full of bare ampersands, and every one of them is a candidate.
    // The scan window is a fixed 33 characters past the `&`, so a document
    // with an `&` on one line and a `;` on the next does not turn inline
    // decoding quadratic; the longest HTML5 name still fits.
    expect(at(`&${'a'.repeat(100_000)};`)).toBeNull();
    expect(at(`&#${'0'.repeat(100_000)}65;`)).toBeNull();
    // The cap bounds the scan, not the text after a complete entity.
    expect(at(`&amp;${'a'.repeat(100_000)};`)).toEqual({ value: '&', length: 5 });
  });
});

describeNative('the span-versus-value invariant, end to end', () => {
  test('a text node decodes its entity while its span covers the raw source', () => {
    // `value` is what the host draws; the span is what copy slices and the
    // splice shifts.
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

  test('native entity values agree with the JavaScript table', () => {
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
