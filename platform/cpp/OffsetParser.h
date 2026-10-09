/*
 * OffsetParser — C++17 adapter over the vendored md4c SAX parser.
 *
 * Produces a flat, ordered list of node events with byte offsets into the
 * UTF-8 source, plus a byte→UTF-16 offset map so the JS side (whose
 * SourceSpan contract is UTF-16 code units) can translate every offset
 * without re-scanning the source.
 *
 * CONSTRAINTS this header exists to enforce:
 *
 * 1. No non-CommonMark syntax is enabled unless the caller passes its flag.
 *    ExtensionFlags below is the ONLY way to turn a dialect extension on,
 *    and every field defaults to false. In particular, md4c master ships
 *    MD_FLAG_SPOILERS — this wrapper intentionally exposes NO spoiler flag.
 *    Spoilers are an opt-in JS-side post-parse transform
 *    (src/engine/extensions/spoilers.ts), so a stray '|' in prose can never
 *    change native parsing, under any configuration.
 *
 * 2. md4c's enter/leave callbacks carry no source offsets; only text
 *    callbacks point into the caller's buffer. Byte offsets are therefore
 *    recovered by pointer arithmetic on text callbacks, and each block/span
 *    event's range is the union of its descendants' text ranges. These are
 *    CONTENT ranges: syntax punctuation ('**', '#', fence lines, '[', '](')
 *    is not included, and nodes with no source-anchored text (thematic
 *    break, empty constructs) report kNoByteOffset. The JS binding widens
 *    content ranges to full construct spans using its own line map — do not
 *    "fix" that here by guessing at punctuation widths.
 *
 * 3. Offsets in NodeEvent are BYTE offsets (end-exclusive) into the exact
 *    buffer passed to parseWithOffsets. Convert to UTF-16 only at the JS
 *    boundary, via the map in ParseResult.
 */

#ifndef SELECTABLE_MARKDOWN_OFFSET_PARSER_H
#define SELECTABLE_MARKDOWN_OFFSET_PARSER_H

#include <cstdint>
#include <string>
#include <vector>

namespace selectable_markdown {

/* Sentinel for "no source-anchored offset available". */
inline constexpr uint32_t kNoByteOffset = 0xFFFFFFFFu;

enum class EventKind : uint8_t {
  BlockEnter,
  BlockLeave,
  SpanEnter,
  SpanLeave,
  Text,
};

/* Node vocabulary is restricted to what the enabled flags can produce.
 * Unknown covers any md4c type outside that vocabulary (defensive: with the
 * flags this wrapper can emit, md4c should never send one). */
enum class NodeType : uint8_t {
  Document,
  Paragraph,
  Heading,
  CodeBlock,
  HtmlBlock,
  Blockquote,
  UnorderedList,
  OrderedList,
  ListItem,
  ThematicBreak,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  Emphasis,
  Strong,
  Link,
  Image,
  CodeSpan,
  Strikethrough,
  MathInline,
  MathDisplay,
  Underline,
  Unknown,
};

enum class TextKind : uint8_t {
  Normal,
  /* A source NUL, rendered U+FFFD. md4c reports it via a static string, so the
   * event has no byte range (kNoByteOffset); stringA holds "�". */
  NullChar,
  HardBreak,
  SoftBreak,
  /* An entity reference (e.g. "&amp;"). The event's byte range covers the
   * RAW entity so the source-slice invariant holds; its decoded value is in
   * stringA, resolved against md4c's full HTML5 table (which is why this is
   * decoded here and not JS-side — the table is ~2100 names). */
  Entity,
  Code,
  Html,
  Math,
};

enum class TaskState : uint8_t { NotTask, Unchecked, Checked };

enum class CellAlign : uint8_t { Default, Left, Center, Right };

/* One SAX event, flattened. Fields beyond (kind, node/text, byte range) are
 * populated only for the node types annotated below and hold their listed
 * defaults otherwise. */
struct NodeEvent {
  EventKind kind = EventKind::Text;
  NodeType node = NodeType::Unknown;  /* BlockEnter/-Leave, SpanEnter/-Leave */
  TextKind text = TextKind::Normal;   /* Text events */

  /* Byte range in the source, end-exclusive. Exact for Text events;
   * content-union for Block/Span events (see header comment, constraint 2).
   * Both fields are kNoByteOffset when nothing in the node anchors to the
   * source. Enter and Leave events of the same node carry the same range
   * (ranges are back-patched when the node closes). */
  uint32_t byteStart = kNoByteOffset;
  uint32_t byteEnd = kNoByteOffset;

  uint8_t headingLevel = 0;               /* Heading: 1..6 */
  bool listTight = false;                 /* UnorderedList / OrderedList */
  uint32_t orderedStart = 1;              /* OrderedList */
  char fenceChar = '\0';                  /* CodeBlock: '`'/'~'; 0 = indented */
  bool fenceClosed = false;               /* CodeBlock: a closing fence ended it, not its container */
  TaskState task = TaskState::NotTask;    /* ListItem */
  uint32_t taskMarkByte = kNoByteOffset;  /* ListItem: byte of the char between '[' and ']' */
  CellAlign align = CellAlign::Default;   /* TableHeaderCell / TableCell */
  bool autolink = false;                  /* Link: recognized without [](), e.g. <https://…> */

  /* Indices into ParseResult::strings; -1 = none.
   * stringA: Link href / Image src / CodeBlock info-string language (all
   *          entity-decoded) / decoded value of an Entity text event /
   *          Text literal when the text is not source-anchored (incl. the
   *          U+FFFD replacement for NullChar).
   * stringB: Link / Image title. */
  int32_t stringA = -1;
  int32_t stringB = -1;
};

/* Mirror of the JS ExtensionFlags (src/engine/options.ts), minus `spoilers`
 * — deliberately absent, see constraint 1 in the header comment. */
struct ExtensionFlags {
  bool tables = false;         /* MD_FLAG_TABLES */
  bool strikethrough = false;  /* MD_FLAG_STRIKETHROUGH */
  bool tasklists = false;      /* MD_FLAG_TASKLISTS */
  bool autolinks = false;      /* MD_FLAG_PERMISSIVE{URL,WWW,EMAIL}AUTOLINKS */
  bool math = false;           /* MD_FLAG_LATEXMATHSPANS */
  bool underline = false;      /* MD_FLAG_UNDERLINE */
};

/* NO HTML MODE LIVES HERE, AND THAT IS A DELIBERATE CONSTRAINT.
 *
 * md4c is ALWAYS asked to parse HTML. This used to be a `HtmlPolicy` field
 * defaulting to `Strip`, which mapped to MD_FLAG_NOHTML — and nothing could
 * reach it, because the JS boundary has only ever sent `kHtmlRaw`
 * (`htmlPolicyBit` in src/engine/native/protocol.ts returns the one value).
 * A dead branch would be harmless; a dead branch that is also the struct
 * default is a trap, because a C++ caller building a ParserConfig directly
 * got the mode the wire format forbids.
 *
 * The reason the wire forbids it is span stability. MD_FLAG_NOHTML does not
 * hide HTML, it changes the BLOCK STRUCTURE: `<div>` … blank line … `</div>`
 * parses as an HTML block with the flag off and as ordinary prose with it on,
 * which moves every span after it. Spans are what selection, copy and the
 * streaming splice are built on. `html: 'strip'` is honoured in the decoder,
 * on the way out, by declining to emit the HTML nodes — the spans of
 * everything around them are identical either way. See docs/NATIVE.md. */
struct ParserConfig {
  ExtensionFlags extensions{};
};

/* The complete ExtensionFlags → MD_FLAG_* mapping lives in exactly one
 * place: this function's implementation. */
unsigned toMd4cFlags(const ParserConfig& config);

struct ParseResult {
  /* False only on md4c runtime failure (allocation); events then hold the
   * prefix emitted before the failure. */
  bool ok = false;
  std::vector<NodeEvent> events;
  std::vector<std::string> strings;
  /* utf16OffsetByByte[i] = UTF-16 offset of the code point starting at (or
   * containing) byte i; size = byteLength + 1, last entry = total UTF-16
   * length. Bytes inside a multi-byte sequence map to the sequence start,
   * so any byte offset snaps to a code-point boundary. */
  std::vector<uint32_t> utf16OffsetByByte;
};

/* Parse UTF-8 `source[0..byteLength)`. The buffer is borrowed for the call
 * only; all event payloads are either offsets or copies. */
ParseResult parseWithOffsets(const char* source,
                             uint32_t byteLength,
                             const ParserConfig& config);

/* Standalone map builder (also used internally by parseWithOffsets).
 * Well-formed UTF-8 expected (md4c's own precondition); each ill-formed
 * byte counts as one U+FFFD, i.e. one UTF-16 unit, keeping the map total
 * and monotone. */
std::vector<uint32_t> buildUtf16OffsetMap(const char* source,
                                          uint32_t byteLength);

/* Clamping lookup into a buildUtf16OffsetMap result. */
uint32_t byteToUtf16(const std::vector<uint32_t>& map, uint32_t byteOffset);

}  // namespace selectable_markdown

#endif  // SELECTABLE_MARKDOWN_OFFSET_PARSER_H
