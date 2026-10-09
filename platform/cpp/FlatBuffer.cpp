/*
 * FlatBuffer.cpp — the ParseResult → wire-format encoder declared in
 * Protocol.h, plus the two entry points every host binding calls.
 *
 * This file is the ONLY place where a byte offset becomes a UTF-16 offset.
 * Everything below it (OffsetParser, md4c) speaks UTF-8 bytes; everything
 * above it (the JSI/JNI/Node bindings, the JS decoder, the document model)
 * speaks UTF-16 code units. Protocol.h invariant 1 holds because this
 * translation happens here, exactly once per offset, and the byte→UTF-16 map
 * that makes it possible is deliberately left out of the buffer: it is
 * `byteLength + 1` u32 entries, four bytes of map per source byte, and
 * shipping it would cost more than the events themselves.
 *
 * CONSTRAINTS this implementation exists to enforce:
 *
 * 1. The kNoByteOffset sentinel is never fed to the map. It shares its bit
 *    pattern with a legal byte offset (0xFFFFFFFF), and byteToUtf16 clamps
 *    out-of-range lookups to the last entry — so a sentinel run through the
 *    map silently becomes "end of document" instead of "no anchor". Every
 *    conversion goes through toUtf16() below, which short-circuits it.
 *
 * 2. The format is an ABI, not a struct layout. Nothing here memcpy's a
 *    struct into the buffer: every multi-byte field is written byte-by-byte,
 *    little-endian. Both current targets (arm64, x86-64) are little-endian
 *    with the padding we would want, which is precisely why a struct memcpy
 *    would compile, pass every test, and break silently on the first host
 *    that differs. The magic word is the decoder's runtime check that this
 *    assumption still holds.
 *
 * 3. One allocation per encode. This runs per parse and, under streaming,
 *    per appended chunk (docs/STREAMING.md), so the layout is computed up
 *    front and the buffer is reserved once. All writes are appends into that
 *    reservation.
 *
 * 4. No exception crosses a host boundary. parseToFlatBuffer is the single
 *    entry point for the JSI, JNI and Node bindings; a std::bad_alloc
 *    escaping into a JS engine's C stack is undefined behaviour on at least
 *    one of them. Allocation failure degrades to a well-formed, empty,
 *    parse-failed buffer instead.
 */

#include "Protocol.h"

#include <cstddef>
#include <string>
#include <vector>

namespace selectable_markdown {
namespace {

/* Pin the layout constants this file writes positionally. The put* calls
 * below emit fields in source order; these asserts are what makes that
 * order equivalent to the documented offsets, so reordering Protocol.h
 * fails the build instead of shifting the protocol under the decoder. */
static_assert(kHeaderSize == 12u * 4u, "header is 12 u32 words");
static_assert(kHeaderWordMagic == 0 && kHeaderWordVersion == 1 &&
                  kHeaderWordHeaderSize == 2 && kHeaderWordFlags == 3 &&
                  kHeaderWordEventCount == 4 && kHeaderWordEventsOffset == 5 &&
                  kHeaderWordStringCount == 6 &&
                  kHeaderWordStringIndexOffset == 7 &&
                  kHeaderWordStringBytesOffset == 8 &&
                  kHeaderWordStringBytesLength == 9 &&
                  kHeaderWordUtf16Length == 10 && kHeaderWordReserved == 11,
              "header word order");
static_assert(kEventSize == 24u, "event record size");
static_assert(kEventFieldKind == 0 && kEventFieldNode == 1 &&
                  kEventFieldText == 2 && kEventFieldDetailFlags == 3 &&
                  kEventFieldStart == 4 && kEventFieldEnd == 8 &&
                  kEventFieldDetailA == 12 && kEventFieldStringA == 16 &&
                  kEventFieldStringB == 20,
              "event field order");
/* Protocol.h: "an unconverted sentinel stays a sentinel". That is only true
 * while the two sentinels share a bit pattern. */
static_assert(kNoOffset == kNoByteOffset, "sentinel bit patterns must match");
/* Every region offset below is header/event/index-table arithmetic; these
 * keep it 4-byte aligned without a runtime round-up. */
static_assert(kHeaderSize % 4u == 0 && kEventSize % 4u == 0, "4-byte regions");

/* Little-endian byte writers. See constraint 2. */
inline void putU8(std::vector<uint8_t>& out, uint8_t value) {
  out.push_back(value);
}

inline void putU32(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xFFu));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFFu));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xFFu));
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xFFu));
}

/* Signed indices go out as two's complement, which is what a JS Int32Array
 * view reads back. -1 ("no string") is therefore 0xFFFFFFFF on the wire. */
inline void putI32(std::vector<uint8_t>& out, int32_t value) {
  putU32(out, static_cast<uint32_t>(value));
}

/* The one offset conversion in the codebase. See constraint 1: the sentinel
 * is returned untouched rather than looked up. */
inline uint32_t toUtf16(const std::vector<uint32_t>& map, uint32_t byteOffset) {
  if (byteOffset == kNoByteOffset) return kNoOffset;
  return byteToUtf16(map, byteOffset);
}

/* Unconditional: every packed field defaults to zero in NodeEvent, so a node
 * type that does not use one adds no bits. */
inline uint8_t packDetailFlags(const NodeEvent& event) {
  uint8_t flags = 0;
  if (event.listTight) flags |= kDetailListTight;
  if (event.autolink) flags |= kDetailAutolink;
  if (event.fenceClosed) flags |= kDetailFenceClosed;
  flags |= static_cast<uint8_t>(
      (static_cast<uint8_t>(event.task) << kDetailTaskShift) & kDetailTaskMask);
  flags |= static_cast<uint8_t>(
      (static_cast<uint8_t>(event.align) << kDetailAlignShift) &
      kDetailAlignMask);
  return flags;
}

/* A Leave encodes its node type's NodeEvent default rather than branching on
 * the kind; decoders read detail only on Enter. */
inline uint32_t packDetailA(const NodeEvent& event) {
  switch (event.node) {
    case NodeType::Heading:
      return event.headingLevel;
    case NodeType::OrderedList:
      return event.orderedStart;
    case NodeType::CodeBlock:
      /* '`' / '~' / 0 for indented code. Through unsigned char because
       * plain `char` is signed on both targets. */
      return static_cast<unsigned char>(event.fenceChar);
    default:
      return 0;
  }
}

/* Defensive: an out-of-range index would make the decoder read past the
 * index table. The parser cannot produce one, so this costs a predictable
 * branch and buys the decoder the right to trust the table's bounds. */
inline int32_t clampStringIndex(int32_t index, uint32_t stringCount) {
  if (index < 0) return -1;
  return static_cast<uint32_t>(index) < stringCount ? index : -1;
}

/* Region offsets, all 4-byte aligned by construction (header and event
 * records are multiples of 4, the index table is u32 entries). Computed in
 * size_t so the overflow check below is meaningful on 64-bit hosts. */
struct Layout {
  uint32_t eventCount = 0;
  uint32_t stringCount = 0;
  uint32_t eventsOffset = kHeaderSize;
  uint32_t stringIndexOffset = kHeaderSize;
  uint32_t stringBytesOffset = kHeaderSize;
  uint32_t stringBytesLength = 0;
  uint32_t totalSize = kHeaderSize;
  bool fits = true;
};

Layout computeLayout(const ParseResult& result) {
  Layout layout;
  const size_t eventCount = result.events.size();
  const size_t stringCount = result.strings.size();

  size_t stringBytes = 0;
  for (const std::string& value : result.strings) {
    stringBytes += value.size();
  }

  const size_t eventsOffset = kHeaderSize;
  const size_t stringIndexOffset = eventsOffset + eventCount * kEventSize;
  const size_t stringBytesOffset =
      stringIndexOffset + (stringCount + 1u) * sizeof(uint32_t);
  /* Nothing is padded after the string bytes: it is the last region, so
   * there is no following region whose alignment could require it. Region
   * *starts* are the only alignment this format promises. */
  const size_t totalSize = stringBytesOffset + stringBytes;

  constexpr size_t kMax = 0xFFFFFFFFu;
  if (eventCount > kMax || stringCount >= kMax || totalSize > kMax ||
      totalSize < stringBytesOffset) {
    /* A document big enough to overflow a u32 offset cannot be described by
     * this protocol at all; the caller gets the empty failure buffer rather
     * than a silently truncated one. */
    layout.fits = false;
    return layout;
  }

  layout.eventCount = static_cast<uint32_t>(eventCount);
  layout.stringCount = static_cast<uint32_t>(stringCount);
  layout.eventsOffset = static_cast<uint32_t>(eventsOffset);
  layout.stringIndexOffset = static_cast<uint32_t>(stringIndexOffset);
  layout.stringBytesOffset = static_cast<uint32_t>(stringBytesOffset);
  layout.stringBytesLength = static_cast<uint32_t>(stringBytes);
  layout.totalSize = static_cast<uint32_t>(totalSize);
  return layout;
}

void writeHeader(std::vector<uint8_t>& out, const Layout& layout, bool ok,
                 uint32_t utf16Length) {
  putU32(out, kMagic);
  putU32(out, kProtocolVersion);
  putU32(out, kHeaderSize);
  putU32(out, ok ? kFlagParseOk : 0u);
  putU32(out, layout.eventCount);
  putU32(out, layout.eventsOffset);
  putU32(out, layout.stringCount);
  putU32(out, layout.stringIndexOffset);
  putU32(out, layout.stringBytesOffset);
  putU32(out, layout.stringBytesLength);
  putU32(out, utf16Length);
  putU32(out, 0u); /* reserved */
}

/* A header-only buffer with kFlagParseOk clear: still decodable (magic,
 * version, zero events, an index table of one zero entry), so a host binding
 * that hands it to JS produces an empty document rather than a crash. Used
 * when the encoder cannot allocate or the document overflows the format. */
std::vector<uint8_t> failureBuffer() {
  std::vector<uint8_t> out;
  try {
    Layout layout;
    layout.stringIndexOffset = kHeaderSize;
    layout.stringBytesOffset = kHeaderSize + sizeof(uint32_t);
    layout.totalSize = layout.stringBytesOffset;
    out.reserve(layout.totalSize);
    writeHeader(out, layout, /*ok=*/false, /*utf16Length=*/0);
    putU32(out, 0u); /* the lone string-index entry: idx[0] = 0 */
  } catch (...) {
    /* Out of memory for 52 bytes. A zero-length buffer is the only remaining
     * signal; every host binding treats "shorter than the header" as a hard
     * failure. */
    out.clear();
  }
  return out;
}

/* May throw std::bad_alloc; encodeFlatBuffer is the noexcept wrapper. */
std::vector<uint8_t> encodeUnchecked(const ParseResult& result) {
  const Layout layout = computeLayout(result);
  if (!layout.fits) return failureBuffer();

  const std::vector<uint32_t>& map = result.utf16OffsetByByte;
  /* The map's last entry is the document's total UTF-16 length; the decoder
   * asserts it against source.length, which is what catches an encoding
   * mismatch at the boundary. An empty map means an empty document. */
  const uint32_t utf16Length = map.empty() ? 0u : map.back();

  std::vector<uint8_t> out;
  out.reserve(layout.totalSize); /* constraint 3: the only allocation */

  writeHeader(out, layout, result.ok, utf16Length);

  for (const NodeEvent& event : result.events) {
    putU8(out, static_cast<uint8_t>(event.kind));
    putU8(out, static_cast<uint8_t>(event.node));
    putU8(out, static_cast<uint8_t>(event.text));
    putU8(out, packDetailFlags(event));
    putU32(out, toUtf16(map, event.byteStart));
    putU32(out, toUtf16(map, event.byteEnd));
    putU32(out, packDetailA(event));
    putI32(out, clampStringIndex(event.stringA, layout.stringCount));
    putI32(out, clampStringIndex(event.stringB, layout.stringCount));
  }

  /* Index table: stringCount + 1 entries, relative to stringBytesOffset, so
   * string i is [idx[i], idx[i + 1]). The trailing entry is what lets the
   * decoder slice the last string without a separate length field, and it
   * equals stringBytesLength. */
  uint32_t cursor = 0;
  putU32(out, cursor);
  for (const std::string& value : result.strings) {
    cursor += static_cast<uint32_t>(value.size());
    putU32(out, cursor);
  }

  /* UTF-8 bytes, concatenated, not NUL-terminated. Source text never appears
   * here (Protocol.h invariant 2). */
  for (const std::string& value : result.strings) {
    out.insert(out.end(), value.begin(), value.end());
  }

  return out;
}

}  // namespace

ParserConfig configFromBits(uint32_t extensionBits, uint32_t htmlPolicy) {
  ParserConfig config;
  ExtensionFlags& ext = config.extensions;
  ext.tables = (extensionBits & kExtTables) != 0;
  ext.strikethrough = (extensionBits & kExtStrikethrough) != 0;
  ext.tasklists = (extensionBits & kExtTasklists) != 0;
  ext.autolinks = (extensionBits & kExtAutolinks) != 0;
  ext.math = (extensionBits & kExtMath) != 0;
  ext.underline = (extensionBits & kExtUnderline) != 0;
  /* Unrecognized bits are dropped by construction: an older native module
   * paired with a newer JS layer degrades to "extension off" rather than
   * misparsing. No bit is read for spoilers — OffsetParser.h constraint 1. */

  /* htmlPolicy is READ AND IGNORED, which is the whole contract. md4c is
   * always asked to parse HTML; see ParserConfig in OffsetParser.h for why
   * the alternative is unrepresentable rather than merely unused. The
   * argument stays in the signature because it is part of the wire format
   * (kHtmlStrip/kHtmlRaw in Protocol.h, mirrored and parity-tested against
   * protocol.ts), and dropping it would be a protocol change. */
  (void)htmlPolicy;
  return config;
}

std::vector<uint8_t> encodeFlatBuffer(const ParseResult& result) {
  try {
    return encodeUnchecked(result);
  } catch (...) {
    /* Constraint 4: this is a boundary function even when called directly by
     * a binding that did its own parse. */
    return failureBuffer();
  }
}

std::vector<uint8_t> parseToFlatBuffer(const char* source, uint32_t byteLength,
                                       const ParserConfig& config) {
  try {
    /* md4c dereferences the buffer even for a zero-length parse on some
     * paths; a null source is normalized to a valid empty one so "no text
     * yet" (the first streaming chunk, an empty input) still yields a
     * decodable buffer rather than a crash. */
    static const char kEmpty[] = "";
    const char* text = source != nullptr ? source : kEmpty;
    const uint32_t size = source != nullptr ? byteLength : 0u;
    return encodeUnchecked(parseWithOffsets(text, size, config));
  } catch (...) {
    return failureBuffer();
  }
}

}  // namespace selectable_markdown
