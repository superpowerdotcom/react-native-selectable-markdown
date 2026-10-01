/**
 * TypeScript mirror of `platform/cpp/Protocol.h` — the flat binary wire
 * format the native parser returns as a single ArrayBuffer.
 *
 * Every constant here is part of the ABI between the compiled module and
 * this package. `protocol.test.ts` re-parses the C++ header and asserts the
 * numbers match, so the two files cannot drift silently.
 *
 * Bump `PROTOCOL_VERSION` on both sides only when a decoder would read the
 * buffer wrong: a mismatch hard-breaks every old-native/new-JS pair. See
 * `Protocol.h`.
 *
 * Design notes that matter to a reader of the decoder:
 *
 * - Offsets in the buffer are **UTF-16 code units**, already converted
 *   native-side. No UTF-8 arithmetic exists above the encoder.
 * - Text is **not** in the buffer. Text events carry offsets and the
 *   decoder slices the source string it already holds. The string table
 *   only carries values that are not source slices (hrefs, titles, info
 *   strings, synthesized text).
 * - Event ranges are **content** ranges (the union of a node's descendants'
 *   text). Widening them to full construct spans is `widen.ts`'s job.
 */

/** "SMD1" as a little-endian u32. */
export const MAGIC = 0x31444d53;
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 48;
export const EVENT_SIZE = 24;

/** "no offset", in UTF-16 units (same bit pattern as the native sentinel). */
export const NO_OFFSET = 0xffffffff;

// Header word indices (u32 words from the start of the buffer).
export const HEADER_MAGIC = 0;
export const HEADER_VERSION = 1;
export const HEADER_HEADER_SIZE = 2;
export const HEADER_FLAGS = 3;
export const HEADER_EVENT_COUNT = 4;
export const HEADER_EVENTS_OFFSET = 5;
export const HEADER_STRING_COUNT = 6;
export const HEADER_STRING_INDEX_OFFSET = 7;
export const HEADER_STRING_BYTES_OFFSET = 8;
export const HEADER_STRING_BYTES_LENGTH = 9;
export const HEADER_UTF16_LENGTH = 10;

export const FLAG_PARSE_OK = 1 << 0;

// Event record field offsets (bytes from the start of the record).
export const EVENT_KIND = 0;
export const EVENT_NODE = 1;
export const EVENT_TEXT = 2;
export const EVENT_DETAIL_FLAGS = 3;
export const EVENT_START = 4;
export const EVENT_END = 8;
export const EVENT_DETAIL_A = 12;
export const EVENT_STRING_A = 16;
export const EVENT_STRING_B = 20;

export const DETAIL_LIST_TIGHT = 1 << 0;
export const DETAIL_AUTOLINK = 1 << 1;
export const DETAIL_TASK_SHIFT = 2;
export const DETAIL_TASK_MASK = 0x3 << DETAIL_TASK_SHIFT;
export const DETAIL_ALIGN_SHIFT = 4;
export const DETAIL_ALIGN_MASK = 0x3 << DETAIL_ALIGN_SHIFT;

export const enum EventKind {
  BlockEnter = 0,
  BlockLeave = 1,
  SpanEnter = 2,
  SpanLeave = 3,
  Text = 4,
}

export const enum NodeType {
  Document = 0,
  Paragraph = 1,
  Heading = 2,
  CodeBlock = 3,
  HtmlBlock = 4,
  Blockquote = 5,
  UnorderedList = 6,
  OrderedList = 7,
  ListItem = 8,
  ThematicBreak = 9,
  Table = 10,
  TableHead = 11,
  TableBody = 12,
  TableRow = 13,
  TableHeaderCell = 14,
  TableCell = 15,
  Emphasis = 16,
  Strong = 17,
  Link = 18,
  Image = 19,
  CodeSpan = 20,
  Strikethrough = 21,
  MathInline = 22,
  MathDisplay = 23,
  Underline = 24,
  Unknown = 25,
}

export const enum TextKind {
  Normal = 0,
  NullChar = 1,
  HardBreak = 2,
  SoftBreak = 3,
  Entity = 4,
  Code = 5,
  Html = 6,
  Math = 7,
}

export const enum TaskState {
  NotTask = 0,
  Unchecked = 1,
  Checked = 2,
}

export const enum CellAlign {
  Default = 0,
  Left = 1,
  Center = 2,
  Right = 3,
}

// Extension bits passed to the native parse call. No bit is reserved for
// spoilers: they are a JS-side post-parse transform and no native
// configuration can enable them.
export const EXT_TABLES = 1 << 0;
export const EXT_STRIKETHROUGH = 1 << 1;
export const EXT_TASKLISTS = 1 << 2;
export const EXT_AUTOLINKS = 1 << 3;
export const EXT_MATH = 1 << 4;
export const EXT_UNDERLINE = 1 << 5;

/**
 * A reserved wire slot the native side ignores. md4c always parses HTML, since
 * MD_FLAG_NOHTML changes block structure and moves spans; `html` is applied in
 * the decoder.
 */
export const HTML_INERT = 0;
export const HTML_PARSED = 1;

import type { ResolvedEngineOptions } from '../options';

/** Pack resolved options into the two integers the native call takes. */
export function extensionBits(options: ResolvedEngineOptions): number {
  const e = options.extensions;
  return (
    (e.tables ? EXT_TABLES : 0) |
    (e.strikethrough ? EXT_STRIKETHROUGH : 0) |
    (e.tasklists ? EXT_TASKLISTS : 0) |
    (e.autolinks ? EXT_AUTOLINKS : 0) |
    (e.math ? EXT_MATH : 0) |
    (e.underline ? EXT_UNDERLINE : 0)
  );
}

/**
 * The html-policy word for the native call. Takes no options ON PURPOSE:
 * the native side ignores the word, and `html` is applied in the decoder.
 */
export function htmlPolicyBit(): number {
  return HTML_PARSED;
}

/**
 * The shape a host binding installs: UTF-16 source in, wire buffer out.
 * Implemented by the JSI global on device and by the Node test addon.
 */
export type ParseToBuffer = (
  source: string,
  extensionBits: number,
  htmlPolicy: number,
) => ArrayBuffer;
