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

import { presets, resolveOptions } from '../../options';
import { decodeFlatBuffer, NativeProtocolError } from '../decode';
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
  kDetailFenceClosed: P.DETAIL_FENCE_CLOSED,

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

/**
 * Asserted on real buffers: bytes no decoder reads are invisible in the
 * decoded document.
 */
describeNative('the string table holds one entry per value that needs one', () => {
  interface Table {
    stringCount: number;
    /** Table indices reachable from some event's stringA/stringB. */
    referenced: Set<number>;
    values: string[];
  }

  function tableOf(source: string, bits = 0): Table {
    const buffer = nativeAddonOrNull()!.parse(source, bits, P.HTML_PARSED);
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    const fields = new Int32Array(buffer, h[P.HEADER_EVENTS_OFFSET], h[P.HEADER_EVENT_COUNT] * 6);
    const referenced = new Set<number>();
    for (let i = 0; i < h[P.HEADER_EVENT_COUNT]; i += 1) {
      if (fields[i * 6 + 4] >= 0) referenced.add(fields[i * 6 + 4]);
      if (fields[i * 6 + 5] >= 0) referenced.add(fields[i * 6 + 5]);
    }
    const stringCount = h[P.HEADER_STRING_COUNT];
    const index =
      stringCount === 0
        ? new Uint32Array(0)
        : new Uint32Array(buffer, h[P.HEADER_STRING_INDEX_OFFSET], stringCount + 1);
    const bytes = new Uint8Array(
      buffer,
      h[P.HEADER_STRING_BYTES_OFFSET],
      h[P.HEADER_STRING_BYTES_LENGTH],
    );
    const values: string[] = [];
    for (let i = 0; i < stringCount; i += 1) {
      values.push(Buffer.from(bytes.subarray(index[i], index[i + 1])).toString('utf8'));
    }
    return { stringCount, referenced, values };
  }

  function expectNoOrphans(table: Table): void {
    expect(table.values.filter((_, i) => !table.referenced.has(i))).toEqual([]);
  }

  test('a NUL interns its replacement character and nothing else', () => {
    // The NUL arm overwrites stringA with U+FFFD, so interning the raw byte
    // first would strand an entry.
    const table = tableOf('x\u0000y\u0000z\n');
    expectNoOrphans(table);
    expect(table.values).toEqual(['�']);
  });

  test('an entity interns its decoded value and nothing else', () => {
    const table = tableOf('a &amp; b\n');
    expectNoOrphans(table);
    expect(table.values).toEqual(['&']);
  });

  test('a thousand line breaks share one entry', () => {
    // md4c reports every break as the same static "\n"; one interned entry
    // also lets the decoder's index-keyed cache hit.
    const table = tableOf(`${'a\n'.repeat(1000)}\n`);
    expectNoOrphans(table);
    expect(table.values).toEqual(['\n']);
  });

  test('a fenced block keeps its info string and one newline', () => {
    const table = tableOf(`\`\`\`js\n${'line\n'.repeat(200)}\`\`\`\n`);
    expectNoOrphans(table);
    expect(table.values).toEqual(['js', '\n']);
  });

  test('a document whose text is all source-anchored interns nothing', () => {
    expect(tableOf('a *b* `c`\n').stringCount).toBe(0);
    expect(tableOf('a *b* `c` &amp;\n').values).toEqual(['&']);
  });
});

describeNative('detailA carries only the three meanings a decoder reads', () => {
  function detailOf(source: string, bits: number, node: number): number[] {
    const buffer = nativeAddonOrNull()!.parse(source, bits, P.HTML_PARSED);
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    const words = new Uint32Array(buffer, h[P.HEADER_EVENTS_OFFSET], h[P.HEADER_EVENT_COUNT] * 6);
    const out: number[] = [];
    for (let i = 0; i < h[P.HEADER_EVENT_COUNT]; i += 1) {
      const packed = words[i * 6];
      if ((packed & 0xff) === P.EventKind.BlockEnter && ((packed >>> 8) & 0xff) === node) {
        out.push(words[i * 6 + 3]);
      }
    }
    return out;
  }

  test('a task item sends no task-mark offset', () => {
    // The mark's offset is already the item's own start; the state travels in
    // detailFlags.
    const source = '- [x] done\n';
    expect(source.indexOf('x')).toBe(3);
    expect(detailOf(source, P.EXT_TASKLISTS, P.NodeType.ListItem)).toEqual([0]);
  });

  test('a table sends no column count', () => {
    // Shape and alignment come from the cell events.
    const source = '| a | b |\n| :- | -: |\n| 1 | 2 |\n';
    expect(detailOf(source, P.EXT_TABLES, P.NodeType.Table)).toEqual([0]);
  });

  test('the three meanings that are read still arrive', () => {
    expect(detailOf('### h\n', 0, P.NodeType.Heading)).toEqual([3]);
    expect(detailOf('7. a\n', 0, P.NodeType.OrderedList)).toEqual([7]);
    expect(detailOf('~~~\nx\n~~~\n', 0, P.NodeType.CodeBlock)).toEqual(['~'.charCodeAt(0)]);
    expect(detailOf('    x\n', 0, P.NodeType.CodeBlock)).toEqual([0]);
  });
});

/**
 * A clear `kFlagParseOk` or a truncated event list leaves a well-formed prefix
 * of the document, which must throw rather than render short.
 */
describeNative('a buffer that reports failure is refused, not decoded', () => {
  const SOURCE = '# Title\n\nfirst paragraph\n\nsecond paragraph\n';
  const OPTIONS = resolveOptions(presets.commonmark);

  /** A real buffer for SOURCE, copied so each case can corrupt its own. */
  function freshBuffer(): ArrayBuffer {
    return nativeAddonOrNull()!.parse(SOURCE, 0, P.HTML_PARSED).slice(0);
  }

  test('the undamaged buffer decodes to the whole document', () => {
    // Without this baseline a "throws" case below could pass for the wrong
    // reason.
    const doc = decodeFlatBuffer(SOURCE, freshBuffer(), OPTIONS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'paragraph']);
  });

  test('a clear FLAG_PARSE_OK throws instead of decoding the prefix', () => {
    const buffer = freshBuffer();
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    h[P.HEADER_FLAGS] &= ~P.FLAG_PARSE_OK;
    // Shortened too: md4c emits only the events before it gave up.
    h[P.HEADER_EVENT_COUNT] -= 6;
    expect(() => decodeFlatBuffer(SOURCE, buffer, OPTIONS)).toThrow(NativeProtocolError);
    expect(() => decodeFlatBuffer(SOURCE, buffer, OPTIONS)).toThrow(/reported failure/);
  });

  test('the failure is reported even when the prefix is empty', () => {
    const buffer = freshBuffer();
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    h[P.HEADER_FLAGS] &= ~P.FLAG_PARSE_OK;
    h[P.HEADER_EVENT_COUNT] = 0;
    expect(() => decodeFlatBuffer(SOURCE, buffer, OPTIONS)).toThrow(/reported failure/);
  });

  test('a truncated event list throws rather than dropping the tail', () => {
    const buffer = freshBuffer();
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    // Cut inside the last paragraph, so its Leave never arrives; the flag stays
    // set, as in corruption the native side never saw.
    h[P.HEADER_EVENT_COUNT] -= 2;
    expect(() => decodeFlatBuffer(SOURCE, buffer, OPTIONS)).toThrow(NativeProtocolError);
    expect(() => decodeFlatBuffer(SOURCE, buffer, OPTIONS)).toThrow(/still open/);
  });
});

/** The shipped encoder cannot produce any of this; a decoder that trusted it would crash or return wrong spans. */
describeNative('damage inside the event list and string table', () => {
  const OPTIONS = resolveOptions(presets.commonmark);

  function bufferFor(source: string): ArrayBuffer {
    return nativeAddonOrNull()!.parse(source, 0, P.HTML_PARSED).slice(0);
  }

  function eventByteOffset(buffer: ArrayBuffer, i: number): number {
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    return h[P.HEADER_EVENTS_OFFSET] + i * P.EVENT_SIZE;
  }

  /** Without `node`, matches any node type. */
  function findEvent(buffer: ArrayBuffer, kind: number, node?: number, from = 0): number {
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    const bytes = new Uint8Array(buffer);
    for (let i = from; i < h[P.HEADER_EVENT_COUNT]; i += 1) {
      const at = eventByteOffset(buffer, i);
      if (bytes[at + P.EVENT_KIND] !== kind) continue;
      if (node === undefined || bytes[at + P.EVENT_NODE] === node) return i;
    }
    throw new Error(`no event kind=${kind} node=${node ?? 'any'}`);
  }

  /** The event record as u32 words; index fields with `P.EVENT_* / 4`. */
  function eventWords(buffer: ArrayBuffer, i: number): Uint32Array {
    return new Uint32Array(buffer, eventByteOffset(buffer, i), P.EVENT_SIZE / 4);
  }

  test('an event range past the end of the source throws a protocol error', () => {
    const source = 'hello world\n';
    const buffer = bufferFor(source);
    const words = eventWords(buffer, findEvent(buffer, P.EventKind.Text));
    words[P.EVENT_END / 4] = source.length + 1000;
    expect(() => decodeFlatBuffer(source, buffer, OPTIONS)).toThrow(NativeProtocolError);
    expect(() => decodeFlatBuffer(source, buffer, OPTIONS)).toThrow(/UTF-16 units/);
  });

  test('a reversed event range throws rather than decoding backwards', () => {
    const source = 'hello world\n';
    const buffer = bufferFor(source);
    const words = eventWords(buffer, findEvent(buffer, P.EventKind.Text));
    const start = P.EVENT_START / 4;
    const end = P.EVENT_END / 4;
    [words[start], words[end]] = [words[end], words[start]];
    expect(() => decodeFlatBuffer(source, buffer, OPTIONS)).toThrow(NativeProtocolError);
  });

  test('a string that is not UTF-8 decodes to U+FFFD instead of throwing', () => {
    // `é` is C3 A9 in the string table; F5 is a lead byte no code point uses.
    const source = '[a](https://e.com/é)\n';
    const buffer = bufferFor(source);
    const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
    const strings = new Uint8Array(buffer, h[P.HEADER_STRING_BYTES_OFFSET], h[P.HEADER_STRING_BYTES_LENGTH]);
    const at = strings.findIndex((byte, i) => byte === 0xc3 && strings[i + 1] === 0xa9);
    expect(at).toBeGreaterThan(-1);
    strings[at] = 0xf5;
    const doc = decodeFlatBuffer(source, buffer, resolveOptions(presets.llmChat));
    const [link] = (doc.blocks[0] as { children: { href: string }[] }).children;
    expect(link.href).toBe('https://e.com/��');
  });

  test('an unknown node type under the document wraps its inlines in a paragraph', () => {
    const source = '# Title\n\nfirst paragraph\n';
    const buffer = bufferFor(source);
    const bytes = new Uint8Array(buffer);
    const enter = findEvent(buffer, P.EventKind.BlockEnter, P.NodeType.Paragraph);
    const leave = findEvent(buffer, P.EventKind.BlockLeave, P.NodeType.Paragraph, enter);
    bytes[eventByteOffset(buffer, enter) + P.EVENT_NODE] = P.NodeType.Unknown;
    bytes[eventByteOffset(buffer, leave) + P.EVENT_NODE] = P.NodeType.Unknown;
    const doc = decodeFlatBuffer(source, buffer, OPTIONS);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph']);
    expect(doc.blocks[1]).toMatchObject({
      span: { start: 9, end: 24 },
      children: [{ kind: 'text', value: 'first paragraph' }],
    });
  });
});
