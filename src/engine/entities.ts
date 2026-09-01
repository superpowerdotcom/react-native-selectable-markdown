/**
 * Entity decoding: numeric character references plus a small named subset.
 *
 * This lives at the engine root rather than beside a parser because entity
 * decoding is not a parser's job here — it is the *document model's*. No
 * source text crosses the native boundary; the decoder in `native/decode.ts`
 * slices text out of the JS source string the caller already holds, which
 * makes this module the single place a `&amp;` in the source becomes an `&`
 * in a text node's value. Keeping one implementation is what keeps the two
 * halves of an entity's contract consistent: the decoded value lands in
 * `text.value`, while the node's span always keeps covering the *raw* entity
 * source, so a selection over `&amp;` copies back the five characters the
 * author typed rather than the one character they see.
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

/**
 * Decode backslash escapes and entities in a raw string (used for link
 * destinations and titles, where no inline structure applies).
 */
export function decodeRawString(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && isAsciiPunctuation(raw[i + 1])) {
      out += raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === '&') {
      const ent = decodeEntityAt(raw, i);
      if (ent) {
        out += ent.value;
        i += ent.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * CommonMark's escapable set: only ASCII punctuation may follow a backslash.
 * Module-private on purpose — `widen.ts` needs the same class over a source
 * *offset* rather than a one-character string and keeps its own scanner-shaped
 * copy, so exporting this would invite the two to drift while looking shared.
 */
function isAsciiPunctuation(ch: string): boolean {
  return /^[!-/:-@[-`{-~]$/.test(ch);
}
