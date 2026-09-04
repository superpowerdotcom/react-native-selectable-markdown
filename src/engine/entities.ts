/**
 * Entity decoding for the one path that still needs it in JavaScript.
 *
 * Entities are resolved NATIVELY, not here. md4c reports every entity
 * reference as its own text event and `OffsetParser.cpp` decodes it against
 * md4c's full HTML5 table (~2100 names); the same happens inside an
 * attribute — a link destination, a title, a fence info string — while md4c
 * builds it, which is also where backslash escapes are resolved. The decoder
 * in `native/decode.ts` takes those values as they arrive. Decoding them a
 * second time in JS is not a safety net but a bug: it resolves a layer the
 * author wrote deliberately, turning `&amp;amp;` into `&` and `\\*` into `*`.
 *
 * What is left for this module is the fallback behind `decode.ts`'s Entity
 * case: an entity event that arrives with no decoded value attached. The
 * shipped parser never produces one, so the table below only has to be
 * defensible rather than complete, and it carries the couple of dozen names
 * that appear in real prose instead of a ~100 KB dump of all of them.
 *
 * THE TWO HALVES OF AN ENTITY'S CONTRACT hold whichever side decodes: the
 * decoded value lands in `text.value` while the node's span keeps covering
 * the *raw* entity source, so a selection over `&amp;` copies back the five
 * characters the author typed rather than the one character they see. On
 * this path, `length` is what makes that possible.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  deg: '°',
  sect: '§',
  para: '¶',
  middot: '·',
  laquo: '«',
  raquo: '»',
};

export interface DecodedEntity {
  /** The decoded character(s). */
  value: string;
  /** Length of the raw entity in the input, including `&` and `;`. */
  length: number;
}

/**
 * Try to decode an entity starting at `pos` (which must point at `&`).
 * Returns null when the text at `pos` is not a recognized entity.
 */
export function decodeEntityAt(text: string, pos: number): DecodedEntity | null {
  if (text.charCodeAt(pos) !== 0x26 /* & */) return null;
  const rest = text.slice(pos + 1, pos + 32);

  const hex = /^#[xX]([0-9a-fA-F]{1,6});/.exec(rest);
  if (hex) return { value: codePointToString(parseInt(hex[1], 16)), length: hex[0].length + 1 };

  const dec = /^#([0-9]{1,7});/.exec(rest);
  if (dec) return { value: codePointToString(parseInt(dec[1], 10)), length: dec[0].length + 1 };

  const named = /^([a-zA-Z][a-zA-Z0-9]{0,31});/.exec(rest);
  if (named) {
    const value = NAMED_ENTITIES[named[1]];
    if (value !== undefined) return { value, length: named[0].length + 1 };
  }
  return null;
}

function codePointToString(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}
