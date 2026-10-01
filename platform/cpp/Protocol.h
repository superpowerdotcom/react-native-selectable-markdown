/*
 * Protocol.h — the flat binary wire format between the native parser and JS.
 *
 * WHY A FLAT BUFFER. Every alternative crossing costs per-node work on the
 * JS side: JSON is a serialize + parse of the whole tree, per-property
 * HostObject access is one JSI call per field, and an array of JS objects
 * allocates before anything is rendered. This protocol crosses the boundary
 * exactly once, as a single ArrayBuffer, and the JS decoder reads it with
 * typed-array views — no allocation until a block is materialized.
 *
 * INVARIANTS this format exists to enforce:
 *
 * 1. Offsets that cross the boundary are UTF-16 code units, never bytes.
 *    md4c speaks UTF-8 byte offsets; OffsetParser carries a byte->UTF-16
 *    map. That map is `byteLength + 1` u32 entries — four bytes per source
 *    byte — so it MUST NOT be shipped. The encoder applies it and emits
 *    UTF-16 offsets; nothing above the encoder does UTF-8 arithmetic.
 *
 * 2. Source text is never copied into the buffer. Text events carry
 *    offsets, and the JS decoder slices the JS source string it already
 *    holds. The string table exists only for values that are NOT source
 *    slices: link hrefs/titles, code-block info strings, decoded entities,
 *    and the text md4c synthesizes rather than points at (mostly "\n").
 *
 * 3. Content ranges, not construct ranges. An event's [start, end) covers
 *    the union of its descendants' text (see OffsetParser.h constraint 2).
 *    Widening to the full construct span (`**` delimiters, `#` markers,
 *    fences, `[](…)` punctuation) is the JS decoder's job, because that is
 *    where the source string and the span conventions of the document model
 *    live. Do not widen here.
 *
 * 4. Little-endian, 4-byte aligned. Both target ABIs (arm64, x86-64) and
 *    every JS engine's typed arrays are little-endian; the magic word is
 *    the runtime check.
 *
 * The TypeScript mirror of every constant below is src/engine/native/
 * protocol.ts. The two files are kept in sync by a test that asserts the
 * numeric values match.
 *
 * Bump kProtocolVersion only when an existing decoder would misread the
 * buffer: the decoder throws on a mismatch, breaking every old-native/new-JS
 * pair a JS-only update produces.
 */

#ifndef SELECTABLE_MARKDOWN_PROTOCOL_H
#define SELECTABLE_MARKDOWN_PROTOCOL_H

#include <cstdint>
#include <vector>

#include "OffsetParser.h"

namespace selectable_markdown {

/* "SMD1" read as a little-endian u32. */
inline constexpr uint32_t kMagic = 0x31444D53u;
inline constexpr uint32_t kProtocolVersion = 1u;
inline constexpr uint32_t kHeaderSize = 48u;
inline constexpr uint32_t kEventSize = 24u;

/* Sentinel for "no offset", in UTF-16 units. Same bit pattern as
 * kNoByteOffset, deliberately: an unconverted sentinel stays a sentinel. */
inline constexpr uint32_t kNoOffset = 0xFFFFFFFFu;

/* Header layout, in u32 words (all offsets are byte offsets from the start
 * of the buffer and are 4-byte aligned):
 *
 *   [0]  magic              kMagic
 *   [1]  version            kProtocolVersion
 *   [2]  headerSize         kHeaderSize
 *   [3]  flags              bit 0 = md4c returned success
 *   [4]  eventCount
 *   [5]  eventsOffset       eventCount * kEventSize bytes live here
 *   [6]  stringCount
 *   [7]  stringIndexOffset  (stringCount + 1) u32 offsets into the string
 *                           bytes region; string i is [idx[i], idx[i+1])
 *   [8]  stringBytesOffset  UTF-8 bytes, not NUL-terminated
 *   [9]  stringBytesLength
 *   [10] utf16Length        total UTF-16 length of the parsed source; the
 *                           decoder asserts it equals source.length, which
 *                           catches any encoding mismatch at the boundary
 *   [11] reserved           0
 */
inline constexpr uint32_t kHeaderWordMagic = 0;
inline constexpr uint32_t kHeaderWordVersion = 1;
inline constexpr uint32_t kHeaderWordHeaderSize = 2;
inline constexpr uint32_t kHeaderWordFlags = 3;
inline constexpr uint32_t kHeaderWordEventCount = 4;
inline constexpr uint32_t kHeaderWordEventsOffset = 5;
inline constexpr uint32_t kHeaderWordStringCount = 6;
inline constexpr uint32_t kHeaderWordStringIndexOffset = 7;
inline constexpr uint32_t kHeaderWordStringBytesOffset = 8;
inline constexpr uint32_t kHeaderWordStringBytesLength = 9;
inline constexpr uint32_t kHeaderWordUtf16Length = 10;
inline constexpr uint32_t kHeaderWordReserved = 11;

inline constexpr uint32_t kFlagParseOk = 1u << 0;

/* Event record layout, 24 bytes:
 *
 *   +0   u8  kind          EventKind
 *   +1   u8  node          NodeType
 *   +2   u8  text          TextKind
 *   +3   u8  detailFlags   see kDetail* below
 *   +4   u32 start         UTF-16, or kNoOffset
 *   +8   u32 end           UTF-16, end-exclusive, or kNoOffset
 *   +12  u32 detailA       one field, disjoint per node type; 0 for every
 *                         type not listed here:
 *                            Heading       -> level 1..6
 *                            OrderedList   -> start number
 *                            CodeBlock     -> fence char code ('`'/'~'), 0
 *                                             for indented code
 *   +16  i32 stringA       index into the string table, or -1
 *   +20  i32 stringB       index into the string table, or -1
 */
inline constexpr uint32_t kEventFieldKind = 0;
inline constexpr uint32_t kEventFieldNode = 1;
inline constexpr uint32_t kEventFieldText = 2;
inline constexpr uint32_t kEventFieldDetailFlags = 3;
inline constexpr uint32_t kEventFieldStart = 4;
inline constexpr uint32_t kEventFieldEnd = 8;
inline constexpr uint32_t kEventFieldDetailA = 12;
inline constexpr uint32_t kEventFieldStringA = 16;
inline constexpr uint32_t kEventFieldStringB = 20;

inline constexpr uint8_t kDetailListTight = 1u << 0;
inline constexpr uint8_t kDetailAutolink = 1u << 1;
inline constexpr uint8_t kDetailTaskShift = 2;  /* 2 bits: TaskState */
inline constexpr uint8_t kDetailTaskMask = 0x3u << kDetailTaskShift;
inline constexpr uint8_t kDetailAlignShift = 4;  /* 2 bits: CellAlign */
inline constexpr uint8_t kDetailAlignMask = 0x3u << kDetailAlignShift;

/* Extension bits accepted by configFromBits. Mirrors ExtensionFlags field
 * order; `spoilers` is deliberately absent (see OffsetParser.h constraint 1)
 * and no bit is reserved for it. */
inline constexpr uint32_t kExtTables = 1u << 0;
inline constexpr uint32_t kExtStrikethrough = 1u << 1;
inline constexpr uint32_t kExtTasklists = 1u << 2;
inline constexpr uint32_t kExtAutolinks = 1u << 3;
inline constexpr uint32_t kExtMath = 1u << 4;
inline constexpr uint32_t kExtUnderline = 1u << 5;

/* htmlPolicy argument values. Part of the wire format and parity-tested
 * against protocol.ts, but no longer selective: configFromBits ignores the
 * argument and md4c always parses HTML. kHtmlStrip is the value the JS layer
 * has never sent; see ParserConfig in OffsetParser.h. */
inline constexpr uint32_t kHtmlStrip = 0;
inline constexpr uint32_t kHtmlRaw = 1;

/* The enum values below are part of the wire format: the encoder writes
 * them raw. Static asserts pin them so reordering the C++ enums fails the
 * build instead of silently shifting the protocol. */
static_assert(static_cast<uint8_t>(EventKind::BlockEnter) == 0, "wire");
static_assert(static_cast<uint8_t>(EventKind::BlockLeave) == 1, "wire");
static_assert(static_cast<uint8_t>(EventKind::SpanEnter) == 2, "wire");
static_assert(static_cast<uint8_t>(EventKind::SpanLeave) == 3, "wire");
static_assert(static_cast<uint8_t>(EventKind::Text) == 4, "wire");
static_assert(static_cast<uint8_t>(NodeType::Document) == 0, "wire");
static_assert(static_cast<uint8_t>(NodeType::Unknown) == 25, "wire");
static_assert(static_cast<uint8_t>(TextKind::Normal) == 0, "wire");
static_assert(static_cast<uint8_t>(TextKind::Math) == 7, "wire");

/* Build a ParserConfig from the two integers the JS boundary passes. Bits
 * outside the kExt* set are ignored, so an older native module paired with a
 * newer JS layer degrades to "extension off" rather than misparsing. */
ParserConfig configFromBits(uint32_t extensionBits, uint32_t htmlPolicy);

/* Encode a ParseResult into the wire format described above. Byte offsets
 * are converted to UTF-16 through result.utf16OffsetByByte; the map itself
 * is not written. */
std::vector<uint8_t> encodeFlatBuffer(const ParseResult& result);

/* parseWithOffsets + encodeFlatBuffer. This is the single entry point every
 * host binding (JSI, JNI, the Node test addon) calls. */
std::vector<uint8_t> parseToFlatBuffer(const char* source,
                                       uint32_t byteLength,
                                       const ParserConfig& config);

}  // namespace selectable_markdown

#endif  // SELECTABLE_MARKDOWN_PROTOCOL_H
