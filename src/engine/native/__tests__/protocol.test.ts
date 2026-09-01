/**
 * ABI drift guard for the native wire format.
 *
 * `protocol.ts` is a hand-written mirror of `platform/cpp/Protocol.h`, and
 * the two files are compiled by different toolchains from different source
 * trees — nothing but this test connects them. It re-reads the C++ headers
 * AS TEXT and asserts every number matches, so a rename, a reorder, or a
 * new constant on either side fails here instead of shipping a buffer the
 * decoder silently misreads (a shifted event field does not throw: it
 * produces plausible, wrong spans).
 *
 * Reading the header as text rather than testing behavior is the point. A
 * behavioral test would pass just as happily if BOTH sides moved a field,
 * which is exactly the mistake a mirrored constant table invites.
 *
 * The header-parity blocks need no compiler; only the last block, which
 * checks the numbers actually compiled into the module, requires the addon.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as P from '../protocol';
import { describeNative, nativeAddonOrNull } from './support';

const CPP_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'platform', 'cpp');
const PROTOCOL_H = fs.readFileSync(path.join(CPP_DIR, 'Protocol.h'), 'utf8');
const OFFSET_PARSER_H = fs.readFileSync(path.join(CPP_DIR, 'OffsetParser.h'), 'utf8');

// ---------------------------------------------------------------------------
// A very small C++ reader
// ---------------------------------------------------------------------------

/** Comments carry commas and braces; every scan below runs on stripped text. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Evaluates the constant expressions this header actually uses: an integer
 * literal (decimal or hex, with the optional `u` suffix) or a single `<<`
 * of two such operands, where an operand may name a constant declared
 * earlier in the file. Deliberately not a general expression parser and
 * deliberately not `eval` — a two-token grammar cannot be fooled into
 * accepting something the C++ compiler would read differently, and anything
 * outside it throws rather than guessing.
 */
function evaluate(expression: string, known: ReadonlyMap<string, number>): number {
  const operand = (token: string): number => {
    const t = token.trim().replace(/[uU]$/, '');
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) return Number.parseInt(t, 16);
    if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
    const named = known.get(t);
    if (named !== undefined) return named;
    throw new Error(`unsupported operand in Protocol.h: ${JSON.stringify(token)}`);
  };
  const parts = expression.split('<<');
  if (parts.length === 1) return operand(parts[0]);
  if (parts.length === 2) return (operand(parts[0]) << operand(parts[1])) >>> 0;
  throw new Error(`unsupported expression in Protocol.h: ${JSON.stringify(expression)}`);
}

/** Every `inline constexpr <int type> kName = <expr>;` in declaration order. */
function readConstants(header: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /inline constexpr\s+(?:uint8_t|uint32_t)\s+(k\w+)\s*=\s*([^;]+);/g;
  for (let m = re.exec(header); m !== null; m = re.exec(header)) {
    out.set(m[1], evaluate(m[2], out));
  }
  return out;
}

/** Member names of `enum class Name : uint8_t { ... };`, in source order. */
function readEnum(header: string, name: string): string[] {
  const re = new RegExp(`enum class ${name}\\s*:\\s*\\w+\\s*\\{([^}]*)\\}`);
  const m = re.exec(header);
  if (!m) throw new Error(`enum class ${name} not found`);
  const members = m[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const member of members) {
    // None of these enums assigns explicit values; an assignment would make
    // "index == value" a lie, so it is rejected rather than parsed.
    if (!/^\w+$/.test(member)) {
      throw new Error(`enum class ${name} member is not a bare name: ${member}`);
    }
  }
  return members;
}

const CPP = readConstants(stripComments(PROTOCOL_H));
const CPP_ENUMS = {
  EventKind: readEnum(stripComments(OFFSET_PARSER_H), 'EventKind'),
  NodeType: readEnum(stripComments(OFFSET_PARSER_H), 'NodeType'),
  TextKind: readEnum(stripComments(OFFSET_PARSER_H), 'TextKind'),
  TaskState: readEnum(stripComments(OFFSET_PARSER_H), 'TaskState'),
  CellAlign: readEnum(stripComments(OFFSET_PARSER_H), 'CellAlign'),
};

// ---------------------------------------------------------------------------
// The mirror table
// ---------------------------------------------------------------------------

/**
 * C++ constant name -> the TypeScript value that mirrors it. This table IS
 * the ABI: a rename on either side breaks it (the C++ lookup misses, or the
 * TS symbol stops compiling), and the coverage test below makes adding a
 * constant to Protocol.h without a mirror a failure too.
 */
const MIRRORED: Readonly<Record<string, number>> = {
  kMagic: P.MAGIC,
  kProtocolVersion: P.PROTOCOL_VERSION,
  kHeaderSize: P.HEADER_SIZE,
  kEventSize: P.EVENT_SIZE,
  kNoOffset: P.NO_OFFSET,

  kHeaderWordMagic: P.HEADER_MAGIC,
  kHeaderWordVersion: P.HEADER_VERSION,
  kHeaderWordHeaderSize: P.HEADER_HEADER_SIZE,
  kHeaderWordFlags: P.HEADER_FLAGS,
  kHeaderWordEventCount: P.HEADER_EVENT_COUNT,
  kHeaderWordEventsOffset: P.HEADER_EVENTS_OFFSET,
  kHeaderWordStringCount: P.HEADER_STRING_COUNT,
  kHeaderWordStringIndexOffset: P.HEADER_STRING_INDEX_OFFSET,
  kHeaderWordStringBytesOffset: P.HEADER_STRING_BYTES_OFFSET,
  kHeaderWordStringBytesLength: P.HEADER_STRING_BYTES_LENGTH,
  kHeaderWordUtf16Length: P.HEADER_UTF16_LENGTH,

  kFlagParseOk: P.FLAG_PARSE_OK,

  kEventFieldKind: P.EVENT_KIND,
  kEventFieldNode: P.EVENT_NODE,
  kEventFieldText: P.EVENT_TEXT,
  kEventFieldDetailFlags: P.EVENT_DETAIL_FLAGS,
  kEventFieldStart: P.EVENT_START,
  kEventFieldEnd: P.EVENT_END,
  kEventFieldDetailA: P.EVENT_DETAIL_A,
  kEventFieldStringA: P.EVENT_STRING_A,
  kEventFieldStringB: P.EVENT_STRING_B,

  kDetailListTight: P.DETAIL_LIST_TIGHT,
  kDetailAutolink: P.DETAIL_AUTOLINK,
  kDetailTaskShift: P.DETAIL_TASK_SHIFT,
  kDetailTaskMask: P.DETAIL_TASK_MASK,
  kDetailAlignShift: P.DETAIL_ALIGN_SHIFT,
  kDetailAlignMask: P.DETAIL_ALIGN_MASK,

  kExtTables: P.EXT_TABLES,
  kExtStrikethrough: P.EXT_STRIKETHROUGH,
  kExtTasklists: P.EXT_TASKLISTS,
  kExtAutolinks: P.EXT_AUTOLINKS,
  kExtMath: P.EXT_MATH,
  kExtUnderline: P.EXT_UNDERLINE,

  // The names differ on purpose. The C++ argument says which md4c HTML mode
  // to configure; the TS names say what that mode MEANS to the decoder, and
  // both `html: 'strip'` and `html: 'raw'` send HTML_PARSED because
  // stripping removes the construct rather than making md4c blind to it.
  // The numbers must still match, which is what this pair pins.
  kHtmlStrip: P.HTML_INERT,
  kHtmlRaw: P.HTML_PARSED,
};

/**
 * C++ constants with no TypeScript mirror, and why. Anything not listed here
 * and not in MIRRORED fails the coverage test.
 */
const UNMIRRORED: Readonly<Record<string, string>> = {
  // Word 11 is padding to the 48-byte header. The decoder never reads it,
  // so mirroring its index would be a constant nothing could drift against.
  kHeaderWordReserved: 'reserved padding word; the decoder never reads it',
};

describe('Protocol.h <-> protocol.ts constant parity', () => {
  test('the C++ header was parsed, not silently skipped', () => {
    // Guards the guard: a regex that stopped matching would make every
    // assertion below vacuous.
    expect(CPP.size).toBeGreaterThanOrEqual(Object.keys(MIRRORED).length);
    expect(CPP.get('kMagic')).toBe(0x31444d53);
    expect(CPP.get('kHeaderSize')).toBe(48);
  });

  test.each(Object.keys(MIRRORED))('%s matches its TypeScript mirror', (name) => {
    expect(CPP.has(name)).toBe(true);
    expect(CPP.get(name)).toBe(MIRRORED[name]);
  });

  test('every constant in Protocol.h is mirrored or explicitly exempt', () => {
    const unaccounted = [...CPP.keys()].filter(
      (name) => !(name in MIRRORED) && !(name in UNMIRRORED),
    );
    expect(unaccounted).toEqual([]);
  });

  test('the shift/mask pairs are consistent on both sides', () => {
    // A mask that stopped covering its shifted field would decode task state
    // and cell alignment as garbage without any constant looking wrong.
    expect(P.DETAIL_TASK_MASK).toBe(0x3 << P.DETAIL_TASK_SHIFT);
    expect(P.DETAIL_ALIGN_MASK).toBe(0x3 << P.DETAIL_ALIGN_SHIFT);
    expect(P.DETAIL_TASK_MASK & P.DETAIL_ALIGN_MASK).toBe(0);
    expect(P.DETAIL_LIST_TIGHT & P.DETAIL_TASK_MASK).toBe(0);
    expect(P.DETAIL_AUTOLINK & P.DETAIL_TASK_MASK).toBe(0);
  });

  test('the event record fields fit inside EVENT_SIZE with no overlap', () => {
    // Widths implied by Protocol.h's layout comment: four u8 tags, then five
    // 4-byte fields.
    const layout: ReadonlyArray<readonly [number, number]> = [
      [P.EVENT_KIND, 1],
      [P.EVENT_NODE, 1],
      [P.EVENT_TEXT, 1],
      [P.EVENT_DETAIL_FLAGS, 1],
      [P.EVENT_START, 4],
      [P.EVENT_END, 4],
      [P.EVENT_DETAIL_A, 4],
      [P.EVENT_STRING_A, 4],
      [P.EVENT_STRING_B, 4],
    ];
    let cursor = 0;
    for (const [offset, width] of layout) {
      expect(offset).toBe(cursor);
      cursor += width;
    }
    expect(cursor).toBe(P.EVENT_SIZE);
  });

  test('the header words fit inside HEADER_SIZE', () => {
    const words = [
      P.HEADER_MAGIC,
      P.HEADER_VERSION,
      P.HEADER_HEADER_SIZE,
      P.HEADER_FLAGS,
      P.HEADER_EVENT_COUNT,
      P.HEADER_EVENTS_OFFSET,
      P.HEADER_STRING_COUNT,
      P.HEADER_STRING_INDEX_OFFSET,
      P.HEADER_STRING_BYTES_OFFSET,
      P.HEADER_STRING_BYTES_LENGTH,
      P.HEADER_UTF16_LENGTH,
    ];
    expect(words).toEqual([...words].sort((a, b) => a - b));
    expect(new Set(words).size).toBe(words.length);
    expect(Math.max(...words) * 4).toBeLessThan(P.HEADER_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Enum parity
// ---------------------------------------------------------------------------

/**
 * The TypeScript enums are `const enum`s: their members are inlined at
 * compile time and cannot be enumerated at runtime, so each one is listed
 * here explicitly. That is not busywork — the list is compared against the
 * C++ member order name-for-name, so a rename, a reorder, an insertion or a
 * deletion on the C++ side fails, and the values are compared to the member
 * indices, so a stale TS number fails too.
 */
const TS_EVENT_KIND: Readonly<Record<string, number>> = {
  BlockEnter: P.EventKind.BlockEnter,
  BlockLeave: P.EventKind.BlockLeave,
  SpanEnter: P.EventKind.SpanEnter,
  SpanLeave: P.EventKind.SpanLeave,
  Text: P.EventKind.Text,
};

const TS_NODE_TYPE: Readonly<Record<string, number>> = {
  Document: P.NodeType.Document,
  Paragraph: P.NodeType.Paragraph,
  Heading: P.NodeType.Heading,
  CodeBlock: P.NodeType.CodeBlock,
  HtmlBlock: P.NodeType.HtmlBlock,
  Blockquote: P.NodeType.Blockquote,
  UnorderedList: P.NodeType.UnorderedList,
  OrderedList: P.NodeType.OrderedList,
  ListItem: P.NodeType.ListItem,
  ThematicBreak: P.NodeType.ThematicBreak,
  Table: P.NodeType.Table,
  TableHead: P.NodeType.TableHead,
  TableBody: P.NodeType.TableBody,
  TableRow: P.NodeType.TableRow,
  TableHeaderCell: P.NodeType.TableHeaderCell,
  TableCell: P.NodeType.TableCell,
  Emphasis: P.NodeType.Emphasis,
  Strong: P.NodeType.Strong,
  Link: P.NodeType.Link,
  Image: P.NodeType.Image,
  CodeSpan: P.NodeType.CodeSpan,
  Strikethrough: P.NodeType.Strikethrough,
  MathInline: P.NodeType.MathInline,
  MathDisplay: P.NodeType.MathDisplay,
  Underline: P.NodeType.Underline,
  Unknown: P.NodeType.Unknown,
};

const TS_TEXT_KIND: Readonly<Record<string, number>> = {
  Normal: P.TextKind.Normal,
  NullChar: P.TextKind.NullChar,
  HardBreak: P.TextKind.HardBreak,
  SoftBreak: P.TextKind.SoftBreak,
  Entity: P.TextKind.Entity,
  Code: P.TextKind.Code,
  Html: P.TextKind.Html,
  Math: P.TextKind.Math,
};

const TS_TASK_STATE: Readonly<Record<string, number>> = {
  NotTask: P.TaskState.NotTask,
  Unchecked: P.TaskState.Unchecked,
  Checked: P.TaskState.Checked,
};

const TS_CELL_ALIGN: Readonly<Record<string, number>> = {
  Default: P.CellAlign.Default,
  Left: P.CellAlign.Left,
  Center: P.CellAlign.Center,
  Right: P.CellAlign.Right,
};

const ENUM_PAIRS: ReadonlyArray<readonly [string, readonly string[], Readonly<Record<string, number>>]> = [
  ['EventKind', CPP_ENUMS.EventKind, TS_EVENT_KIND],
  ['NodeType', CPP_ENUMS.NodeType, TS_NODE_TYPE],
  ['TextKind', CPP_ENUMS.TextKind, TS_TEXT_KIND],
  ['TaskState', CPP_ENUMS.TaskState, TS_TASK_STATE],
  ['CellAlign', CPP_ENUMS.CellAlign, TS_CELL_ALIGN],
];

describe('OffsetParser.h <-> protocol.ts enum parity', () => {
  test.each(ENUM_PAIRS)('%s has the same members in the same order', (_name, cpp, ts) => {
    expect(Object.keys(ts)).toEqual([...cpp]);
  });

  test.each(ENUM_PAIRS)('%s member values are their C++ ordinals', (_name, cpp, ts) => {
    for (let i = 0; i < cpp.length; i += 1) {
      expect(ts[cpp[i]]).toBe(i);
    }
  });

  test("the header's own static_asserts agree with the parsed ordinals", () => {
    // Protocol.h pins four ordinals with static_assert so a reorder fails the
    // C++ build. Re-checking them here validates the enum parser above: if
    // readEnum drifted, these four would stop lining up.
    const pinned = /static_assert\(static_cast<uint8_t>\((\w+)::(\w+)\) == (\d+)/g;
    const seen: string[] = [];
    for (let m = pinned.exec(PROTOCOL_H); m !== null; m = pinned.exec(PROTOCOL_H)) {
      const members = CPP_ENUMS[m[1] as keyof typeof CPP_ENUMS];
      expect(members).toBeDefined();
      expect(members.indexOf(m[2])).toBe(Number.parseInt(m[3], 10));
      seen.push(`${m[1]}::${m[2]}`);
    }
    expect(seen).toEqual([
      'EventKind::BlockEnter',
      'EventKind::BlockLeave',
      'EventKind::SpanEnter',
      'EventKind::SpanLeave',
      'EventKind::Text',
      'NodeType::Document',
      'NodeType::Unknown',
      'TextKind::Normal',
      'TextKind::Math',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The numbers actually compiled into the module
// ---------------------------------------------------------------------------

describeNative('the compiled module speaks this protocol', () => {
  test('its protocolVersion is the one this package decodes', () => {
    // The header-parity tests above compare two files in one checkout; this
    // compares the checkout to a binary, which is the pair that actually
    // ships together (and the pair a stale build/ directory breaks).
    expect(nativeAddonOrNull()?.protocolVersion).toBe(P.PROTOCOL_VERSION);
  });

  test('a real buffer carries the header this file describes', () => {
    const source = '# Title\n\nbody `code` and *em*.\n';
    const buffer = nativeAddonOrNull()!.parse(source, 0, P.HTML_PARSED);
    expect(buffer.byteLength).toBeGreaterThanOrEqual(P.HEADER_SIZE);
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    expect(h[P.HEADER_MAGIC]).toBe(P.MAGIC);
    expect(h[P.HEADER_VERSION]).toBe(P.PROTOCOL_VERSION);
    expect(h[P.HEADER_HEADER_SIZE]).toBe(P.HEADER_SIZE);
    expect(h[P.HEADER_FLAGS] & P.FLAG_PARSE_OK).toBe(P.FLAG_PARSE_OK);
    // The check that catches a UTF-8/UTF-16 mix-up at the boundary.
    expect(h[P.HEADER_UTF16_LENGTH]).toBe(source.length);
    // Regions must be 4-byte aligned and inside the buffer, or the decoder's
    // typed-array views would throw on construction.
    expect(h[P.HEADER_EVENTS_OFFSET] % 4).toBe(0);
    expect(h[P.HEADER_STRING_INDEX_OFFSET] % 4).toBe(0);
    expect(h[P.HEADER_EVENT_COUNT]).toBeGreaterThan(0);
    expect(
      h[P.HEADER_EVENTS_OFFSET] + h[P.HEADER_EVENT_COUNT] * P.EVENT_SIZE,
    ).toBeLessThanOrEqual(buffer.byteLength);
    expect(
      h[P.HEADER_STRING_BYTES_OFFSET] + h[P.HEADER_STRING_BYTES_LENGTH],
    ).toBeLessThanOrEqual(buffer.byteLength);
  });

  test('event records are laid out at the field offsets this file declares', () => {
    const source = '# Title\n';
    const buffer = nativeAddonOrNull()!.parse(source, 0, P.HTML_PARSED);
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    const view = new DataView(buffer, h[P.HEADER_EVENTS_OFFSET]);

    // Read the first record through the byte offsets rather than the packed
    // u32 the decoder uses: two independent readings of the same bytes is
    // what makes this a layout check and not a restatement of decode.ts.
    expect(view.getUint8(P.EVENT_KIND)).toBe(P.EventKind.BlockEnter);
    expect(view.getUint8(P.EVENT_NODE)).toBe(P.NodeType.Document);

    const second = P.EVENT_SIZE;
    expect(view.getUint8(second + P.EVENT_KIND)).toBe(P.EventKind.BlockEnter);
    expect(view.getUint8(second + P.EVENT_NODE)).toBe(P.NodeType.Heading);
    // detailA is the heading level for a Heading enter.
    expect(view.getUint32(second + P.EVENT_DETAIL_A, true)).toBe(1);
    // Content range: "Title", not the "# " marker (widening is JS-side).
    expect(view.getUint32(second + P.EVENT_START, true)).toBe(source.indexOf('Title'));
    expect(view.getUint32(second + P.EVENT_END, true)).toBe(source.indexOf('Title') + 5);
    // No string-table entries for a plain heading.
    expect(view.getInt32(second + P.EVENT_STRING_A, true)).toBe(-1);
    expect(view.getInt32(second + P.EVENT_STRING_B, true)).toBe(-1);
  });

  test('extension bits reach md4c: the same source parses differently per bit', () => {
    // Proves the kExt* numbers are not merely equal on both sides but wired
    // to the flags they name — a mask that matched the header yet selected
    // the wrong md4c flag would pass every test above.
    const eventKinds = (source: string, bits: number): number[] => {
      const buffer = nativeAddonOrNull()!.parse(source, bits, P.HTML_PARSED);
      const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
      const words = new Uint32Array(buffer, h[P.HEADER_EVENTS_OFFSET], h[P.HEADER_EVENT_COUNT] * 6);
      const nodes: number[] = [];
      for (let i = 0; i < h[P.HEADER_EVENT_COUNT]; i += 1) {
        const packed = words[i * 6];
        if ((packed & 0xff) === P.EventKind.SpanEnter) nodes.push((packed >>> 8) & 0xff);
      }
      return nodes;
    };
    expect(eventKinds('~~x~~\n', 0)).not.toContain(P.NodeType.Strikethrough);
    expect(eventKinds('~~x~~\n', P.EXT_STRIKETHROUGH)).toContain(P.NodeType.Strikethrough);
    expect(eventKinds('$x$\n', 0)).not.toContain(P.NodeType.MathInline);
    expect(eventKinds('$x$\n', P.EXT_MATH)).toContain(P.NodeType.MathInline);
    expect(eventKinds('_x_\n', 0)).toContain(P.NodeType.Emphasis);
    expect(eventKinds('_x_\n', P.EXT_UNDERLINE)).toContain(P.NodeType.Underline);
  });
});
