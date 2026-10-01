import { NAMED_ENTITIES } from './namedEntities';

/**
 * NAMED_ENTITIES is generated from md4c's entity data, so it agrees with the
 * native parser.
 */

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
  const rest = text.slice(pos + 1, pos + 34);

  const hex = /^#[xX]([0-9a-fA-F]{1,6});/.exec(rest);
  if (hex) return { value: codePointToString(parseInt(hex[1], 16)), length: hex[0].length + 1 };

  const dec = /^#([0-9]{1,7});/.exec(rest);
  if (dec) return { value: codePointToString(parseInt(dec[1], 10)), length: dec[0].length + 1 };

  const named = /^([a-zA-Z][a-zA-Z0-9]{0,31});/.exec(rest);
  if (named) {
    const value = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, named[1])
      ? NAMED_ENTITIES[named[1]] : undefined;
    if (value !== undefined) return { value, length: named[0].length + 1 };
  }
  return null;
}

function codePointToString(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}
