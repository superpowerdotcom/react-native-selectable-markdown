#include "OffsetParser.h"

#include <md4c.h>

/* md4c's entity.h is an internal header with no `extern "C"` guard of its
 * own, and the vendored sources are never edited in place (see
 * vendor/md4c/UPSTREAM.md), so the guard goes at the include site. Without
 * it the C++ call site emits a mangled symbol that a shared-library link
 * with lazy binding will happily accept and then jump into at runtime. */
extern "C" {
#include <entity.h>
}

#include <cstring>

namespace selectable_markdown {

unsigned toMd4cFlags(const ParserConfig& config) {
  unsigned flags = 0;
  const ExtensionFlags& ext = config.extensions;
  if (ext.tables) flags |= MD_FLAG_TABLES;
  if (ext.strikethrough) flags |= MD_FLAG_STRIKETHROUGH;
  if (ext.tasklists) flags |= MD_FLAG_TASKLISTS;
  if (ext.autolinks) {
    /* Not MD_FLAG_PERMISSIVEAUTOLINKS: a flag md4c later folds into that
     * alias must not enable itself here on a vendor bump. */
    flags |= MD_FLAG_PERMISSIVEURLAUTOLINKS | MD_FLAG_PERMISSIVEWWWAUTOLINKS |
             MD_FLAG_PERMISSIVEEMAILAUTOLINKS;
  }
  if (ext.math) flags |= MD_FLAG_LATEXMATHSPANS;
  if (ext.underline) flags |= MD_FLAG_UNDERLINE;
  /* Never set here, by design: MD_FLAG_NOHTML (it changes block structure
   * and therefore every span after an HTML block — see ParserConfig in
   * OffsetParser.h), MD_FLAG_SPOILERS (JS-side opt-in transform only), and
   * any flag without a corresponding ExtensionFlags field. */
  return flags;
}

std::vector<uint32_t> buildUtf16OffsetMap(const char* source,
                                          uint32_t byteLength) {
  std::vector<uint32_t> map(static_cast<size_t>(byteLength) + 1u);
  uint32_t* const out = map.data();
  uint32_t utf16 = 0;
  uint32_t i = 0;
  while (i < byteLength) {
    /* ASCII fast path. Markdown is overwhelmingly ASCII, and an ASCII byte
     * is exactly one UTF-16 unit, so a run of them is a linear ramp in the
     * map. The run is found eight bytes at a time — one load and one mask
     * against the high bit of every lane — and filled with a tight
     * increment loop the compiler can vectorize. The byte-wise tail below
     * finishes a partial word (end of buffer, or the ASCII prefix of the
     * word that tripped the mask), so the slow path only ever sees a byte
     * with the high bit set. memcpy, not a cast: the source has no
     * alignment guarantee and an aligned-load UB here would "work" on both
     * current targets right up until it did not. */
    uint32_t run = i;
    /* Subtraction form, not `run + 8u <= byteLength`: the sum wraps at
     * uint32 max, and a wrapped guard passes vacuously — a 7-byte over-read
     * plus a map-corrupting restart from offset 0. Unreachable today (the
     * map allocation refuses such inputs first), but a bound should hold on
     * its own. `run <= byteLength` always holds here, so the difference
     * cannot underflow. */
    while (byteLength - run >= 8u) {
      uint64_t word;
      std::memcpy(&word, source + run, sizeof word);
      if ((word & 0x8080808080808080ull) != 0u) break;
      run += 8u;
    }
    while (run < byteLength &&
           static_cast<unsigned char>(source[run]) < 0x80u) {
      ++run;
    }
    for (uint32_t j = i; j < run; ++j) out[j] = utf16 + (j - i);
    utf16 += run - i;
    i = run;

    /* Non-ASCII phase: decode sequences byte-wise until the next lead is
     * ASCII again. One byte compare per sequence decides when to re-enter
     * the fast path — re-running the word test per character instead was
     * measured 2x SLOWER than the original loop on pure-CJK text, which is
     * a real workload for a chat renderer, not a corner case. */
    while (i < byteLength) {
      const unsigned char lead = static_cast<unsigned char>(source[i]);
      if (lead < 0x80u) break;
      uint32_t seqLen;
      uint32_t units;
      if ((lead & 0xE0u) == 0xC0u) {
        seqLen = 2;
        units = 1;
      } else if ((lead & 0xF0u) == 0xE0u) {
        seqLen = 3;
        units = 1; /* BMP: one UTF-16 unit */
      } else if ((lead & 0xF8u) == 0xF0u) {
        seqLen = 4;
        units = 2; /* supplementary plane: surrogate pair */
      } else {
        /* Stray continuation or invalid lead byte -> one U+FFFD. */
        seqLen = 1;
        units = 1;
      }
      /* Count the continuation bytes actually present; a truncated sequence
       * degrades to one U+FFFD per byte (keeps the map total and monotone). */
      uint32_t have = 1;
      while (have < seqLen && i + have < byteLength &&
             (static_cast<unsigned char>(source[i + have]) & 0xC0u) == 0x80u) {
        ++have;
      }
      if (have < seqLen) {
        seqLen = have;
        units = have;
      }
      for (uint32_t j = 0; j < seqLen; ++j) {
        out[i + j] = utf16;
      }
      utf16 += units;
      i += seqLen;
    }
  }
  map[byteLength] = utf16;
  return map;
}

uint32_t byteToUtf16(const std::vector<uint32_t>& map, uint32_t byteOffset) {
  if (map.empty()) return 0;
  const size_t last = map.size() - 1;
  const size_t index =
      byteOffset < last ? static_cast<size_t>(byteOffset) : last;
  return map[index];
}

namespace {

/* Append one Unicode code point as UTF-8. */
void appendUtf8(std::string* out, unsigned codepoint) {
  if (codepoint < 0x80u) {
    out->push_back(static_cast<char>(codepoint));
  } else if (codepoint < 0x800u) {
    out->push_back(static_cast<char>(0xC0u | (codepoint >> 6)));
    out->push_back(static_cast<char>(0x80u | (codepoint & 0x3Fu)));
  } else if (codepoint < 0x10000u) {
    out->push_back(static_cast<char>(0xE0u | (codepoint >> 12)));
    out->push_back(static_cast<char>(0x80u | ((codepoint >> 6) & 0x3Fu)));
    out->push_back(static_cast<char>(0x80u | (codepoint & 0x3Fu)));
  } else {
    out->push_back(static_cast<char>(0xF0u | (codepoint >> 18)));
    out->push_back(static_cast<char>(0x80u | ((codepoint >> 12) & 0x3Fu)));
    out->push_back(static_cast<char>(0x80u | ((codepoint >> 6) & 0x3Fu)));
    out->push_back(static_cast<char>(0x80u | (codepoint & 0x3Fu)));
  }
}

/* Decode one entity reference ("&amp;", "&#65;", "&#x1F600;") onto `out`.
 *
 * This is done here, not JS-side, for one reason: md4c ships the complete
 * HTML5 named-entity table (entity.c, ~2100 names) and the JS layer does
 * not — shipping a second copy in JavaScript would cost more bundle than
 * the whole decoder. The node's byte range still covers the RAW entity, so
 * the source-slice invariant is untouched; only the display value is
 * decoded, exactly as it is for a backslash escape.
 *
 * Anything that is not a valid reference is copied verbatim, which is what
 * CommonMark requires ("&unknown;" stays literal). */
void appendDecodedEntity(const char* text, size_t size, std::string* out) {
  if (size < 3 || text[0] != '&' || text[size - 1] != ';') {
    out->append(text, size);
    return;
  }
  if (text[1] == '#') {
    unsigned codepoint = 0;
    bool ok = false;
    if (size > 4 && (text[2] == 'x' || text[2] == 'X')) {
      ok = true;
      for (size_t i = 3; i + 1 < size; ++i) {
        const char c = text[i];
        unsigned digit;
        if (c >= '0' && c <= '9') digit = static_cast<unsigned>(c - '0');
        else if (c >= 'a' && c <= 'f') digit = static_cast<unsigned>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') digit = static_cast<unsigned>(c - 'A' + 10);
        else { ok = false; break; }
        codepoint = codepoint * 16u + digit;
      }
    } else if (size > 3) {
      ok = true;
      for (size_t i = 2; i + 1 < size; ++i) {
        const char c = text[i];
        if (c < '0' || c > '9') { ok = false; break; }
        codepoint = codepoint * 10u + static_cast<unsigned>(c - '0');
      }
    }
    /* CommonMark: NUL, out-of-range and surrogate code points render as
     * U+FFFD. */
    if (!ok) {
      out->append(text, size);
      return;
    }
    if (codepoint == 0 || codepoint > 0x10FFFFu ||
        (codepoint >= 0xD800u && codepoint <= 0xDFFFu)) {
      codepoint = 0xFFFDu;
    }
    appendUtf8(out, codepoint);
    return;
  }

  const ENTITY* found = entity_lookup(text, size);
  if (found == nullptr) {
    out->append(text, size);
    return;
  }
  appendUtf8(out, found->codepoints[0]);
  if (found->codepoints[1] != 0) appendUtf8(out, found->codepoints[1]);
}

/* Tracking data for a node whose Leave has not fired yet. */
struct OpenNode {
  size_t enterIndex;
  uint32_t minByte = kNoByteOffset;
  uint32_t maxByte = 0;
};

struct SaxState {
  const char* source = nullptr;
  uint32_t size = 0;
  ParseResult* out = nullptr;
  std::vector<OpenNode> stack;

  bool anchor(const MD_CHAR* text, MD_SIZE textSize, uint32_t* start) const {
    if (text == nullptr) return false;
    if (text < source) return false;
    const size_t offset = static_cast<size_t>(text - source);
    if (offset > size || textSize > size - offset) return false;
    *start = static_cast<uint32_t>(offset);
    return true;
  }

  void fold(uint32_t start, uint32_t end) {
    if (stack.empty()) return;
    OpenNode& open = stack.back();
    if (open.minByte == kNoByteOffset || start < open.minByte) {
      open.minByte = start;
    }
    if (open.minByte != kNoByteOffset && end > open.maxByte) {
      open.maxByte = end;
    }
  }

  /* Dedupes against the previous entry only: md4c's repeated values (the
   * static "\n" for every break and code or HTML-block line) arrive
   * consecutively. */
  int32_t intern(const char* text, size_t length) {
    if (!out->strings.empty()) {
      const std::string& last = out->strings.back();
      if (last.size() == length &&
          (length == 0 || std::memcmp(last.data(), text, length) == 0)) {
        return static_cast<int32_t>(out->strings.size() - 1);
      }
    }
    out->strings.emplace_back(text, length);
    return static_cast<int32_t>(out->strings.size() - 1);
  }

  /* Attribute text (link href, title, code-block info string) is a string
   * *value*, not a source range: nothing selects or copies it, so unlike
   * node text it is decoded here. md4c splits an attribute into typed
   * substrings precisely so entities can be resolved without re-lexing. */
  int32_t internAttribute(const MD_ATTRIBUTE& attr) {
    if (attr.text == nullptr || attr.size == 0) return -1;
    if (attr.substr_types == nullptr || attr.substr_offsets == nullptr) {
      return intern(attr.text, attr.size);
    }
    std::string decoded;
    decoded.reserve(attr.size);
    for (unsigned i = 0; attr.substr_offsets[i] < attr.size; ++i) {
      const MD_OFFSET from = attr.substr_offsets[i];
      const MD_OFFSET to = attr.substr_offsets[i + 1];
      if (to <= from) continue;
      const char* part = attr.text + from;
      const size_t partSize = static_cast<size_t>(to - from);
      switch (attr.substr_types[i]) {
        case MD_TEXT_ENTITY:
          appendDecodedEntity(part, partSize, &decoded);
          break;
        case MD_TEXT_NULLCHAR:
          decoded.append("\xEF\xBF\xBD");
          break;
        default:
          decoded.append(part, partSize);
          break;
      }
    }
    return intern(decoded.data(), decoded.size());
  }
};

NodeType mapBlockType(MD_BLOCKTYPE type) {
  switch (type) {
    case MD_BLOCK_DOC: return NodeType::Document;
    case MD_BLOCK_QUOTE: return NodeType::Blockquote;
    case MD_BLOCK_UL: return NodeType::UnorderedList;
    case MD_BLOCK_OL: return NodeType::OrderedList;
    case MD_BLOCK_LI: return NodeType::ListItem;
    case MD_BLOCK_HR: return NodeType::ThematicBreak;
    case MD_BLOCK_H: return NodeType::Heading;
    case MD_BLOCK_CODE: return NodeType::CodeBlock;
    case MD_BLOCK_HTML: return NodeType::HtmlBlock;
    case MD_BLOCK_P: return NodeType::Paragraph;
    case MD_BLOCK_TABLE: return NodeType::Table;
    case MD_BLOCK_THEAD: return NodeType::TableHead;
    case MD_BLOCK_TBODY: return NodeType::TableBody;
    case MD_BLOCK_TR: return NodeType::TableRow;
    case MD_BLOCK_TH: return NodeType::TableHeaderCell;
    case MD_BLOCK_TD: return NodeType::TableCell;
    default: return NodeType::Unknown;
  }
}

NodeType mapSpanType(MD_SPANTYPE type) {
  switch (type) {
    case MD_SPAN_EM: return NodeType::Emphasis;
    case MD_SPAN_STRONG: return NodeType::Strong;
    case MD_SPAN_A: return NodeType::Link;
    case MD_SPAN_IMG: return NodeType::Image;
    case MD_SPAN_CODE: return NodeType::CodeSpan;
    case MD_SPAN_DEL: return NodeType::Strikethrough;
    case MD_SPAN_LATEXMATH: return NodeType::MathInline;
    case MD_SPAN_LATEXMATH_DISPLAY: return NodeType::MathDisplay;
    case MD_SPAN_U: return NodeType::Underline;
    default: return NodeType::Unknown;
  }
}

CellAlign mapAlign(MD_ALIGN align) {
  switch (align) {
    case MD_ALIGN_LEFT: return CellAlign::Left;
    case MD_ALIGN_CENTER: return CellAlign::Center;
    case MD_ALIGN_RIGHT: return CellAlign::Right;
    default: return CellAlign::Default;
  }
}

TextKind mapTextType(MD_TEXTTYPE type) {
  switch (type) {
    case MD_TEXT_NULLCHAR: return TextKind::NullChar;
    case MD_TEXT_BR: return TextKind::HardBreak;
    case MD_TEXT_SOFTBR: return TextKind::SoftBreak;
    case MD_TEXT_ENTITY: return TextKind::Entity;
    case MD_TEXT_CODE: return TextKind::Code;
    case MD_TEXT_HTML: return TextKind::Html;
    case MD_TEXT_LATEXMATH: return TextKind::Math;
    default: return TextKind::Normal;
  }
}

void fillBlockDetail(NodeEvent& event, MD_BLOCKTYPE type, void* detail,
                     SaxState& state) {
  if (detail == nullptr) return;
  switch (type) {
    case MD_BLOCK_UL: {
      const auto* d = static_cast<const MD_BLOCK_UL_DETAIL*>(detail);
      event.listTight = d->is_tight != 0;
      break;
    }
    case MD_BLOCK_OL: {
      const auto* d = static_cast<const MD_BLOCK_OL_DETAIL*>(detail);
      event.listTight = d->is_tight != 0;
      event.orderedStart = d->start;
      break;
    }
    case MD_BLOCK_LI: {
      const auto* d = static_cast<const MD_BLOCK_LI_DETAIL*>(detail);
      if (d->is_task != 0) {
        event.task = (d->task_mark == 'x' || d->task_mark == 'X')
                         ? TaskState::Checked
                         : TaskState::Unchecked;
        event.taskMarkByte = d->task_mark_offset;
      }
      break;
    }
    case MD_BLOCK_H: {
      const auto* d = static_cast<const MD_BLOCK_H_DETAIL*>(detail);
      event.headingLevel = static_cast<uint8_t>(d->level);
      break;
    }
    case MD_BLOCK_CODE: {
      const auto* d = static_cast<const MD_BLOCK_CODE_DETAIL*>(detail);
      event.fenceChar = d->fence_char;
      event.stringA = state.internAttribute(d->lang);
      break;
    }
    /* No MD_BLOCK_TABLE arm: the decoder derives columns from cell events. */
    case MD_BLOCK_TH:
    case MD_BLOCK_TD: {
      const auto* d = static_cast<const MD_BLOCK_TD_DETAIL*>(detail);
      event.align = mapAlign(d->align);
      break;
    }
    default:
      break;
  }
}

void fillSpanDetail(NodeEvent& event, MD_SPANTYPE type, void* detail,
                    SaxState& state) {
  if (detail == nullptr) return;
  switch (type) {
    case MD_SPAN_A: {
      const auto* d = static_cast<const MD_SPAN_A_DETAIL*>(detail);
      event.stringA = state.internAttribute(d->href);
      event.stringB = state.internAttribute(d->title);
      event.autolink = d->is_autolink != 0;
      break;
    }
    case MD_SPAN_IMG: {
      const auto* d = static_cast<const MD_SPAN_IMG_DETAIL*>(detail);
      event.stringA = state.internAttribute(d->src);
      event.stringB = state.internAttribute(d->title);
      break;
    }
    default:
      break;
  }
}

int onLeave(SaxState& state, EventKind kind, NodeType node) {
  NodeEvent event;
  event.kind = kind;
  event.node = node;
  if (!state.stack.empty()) {
    const OpenNode open = state.stack.back();
    state.stack.pop_back();
    if (open.minByte != kNoByteOffset) {
      event.byteStart = open.minByte;
      event.byteEnd = open.maxByte;
      /* Back-patch the matching Enter so both carry the resolved range. */
      NodeEvent& enter = state.out->events[open.enterIndex];
      enter.byteStart = open.minByte;
      enter.byteEnd = open.maxByte;
      /* A child's range is part of the parent's content. */
      state.fold(open.minByte, open.maxByte);
    }
  }
  state.out->events.push_back(event);
  return 0;
}

int enterBlockCallback(MD_BLOCKTYPE type, void* detail, void* userdata) {
  SaxState& state = *static_cast<SaxState*>(userdata);
  NodeEvent event;
  event.kind = EventKind::BlockEnter;
  event.node = mapBlockType(type);
  fillBlockDetail(event, type, detail, state);
  state.out->events.push_back(event);
  state.stack.push_back(OpenNode{state.out->events.size() - 1});
  if (event.taskMarkByte != kNoByteOffset) {
    /* The task mark is a real source anchor; folding it in gives even an
     * otherwise-empty task item a usable range. */
    state.fold(event.taskMarkByte, event.taskMarkByte + 1);
  }
  return 0;
}

int leaveBlockCallback(MD_BLOCKTYPE type, void* /*detail*/, void* userdata) {
  SaxState& state = *static_cast<SaxState*>(userdata);
  return onLeave(state, EventKind::BlockLeave, mapBlockType(type));
}

int enterSpanCallback(MD_SPANTYPE type, void* detail, void* userdata) {
  SaxState& state = *static_cast<SaxState*>(userdata);
  NodeEvent event;
  event.kind = EventKind::SpanEnter;
  event.node = mapSpanType(type);
  fillSpanDetail(event, type, detail, state);
  state.out->events.push_back(event);
  state.stack.push_back(OpenNode{state.out->events.size() - 1});
  return 0;
}

int leaveSpanCallback(MD_SPANTYPE type, void* /*detail*/, void* userdata) {
  SaxState& state = *static_cast<SaxState*>(userdata);
  return onLeave(state, EventKind::SpanLeave, mapSpanType(type));
}

int textCallback(MD_TEXTTYPE type, const MD_CHAR* text, MD_SIZE size,
                 void* userdata) {
  SaxState& state = *static_cast<SaxState*>(userdata);
  NodeEvent event;
  event.kind = EventKind::Text;
  event.text = mapTextType(type);

  uint32_t start = 0;
  const bool anchored = state.anchor(text, size, &start);
  if (anchored) {
    event.byteStart = start;
    event.byteEnd = start + static_cast<uint32_t>(size);
    state.fold(event.byteStart, event.byteEnd);
  }

  if (type == MD_TEXT_NULLCHAR) {
    /* Range covers the NUL byte; display text is the replacement char. */
    event.stringA = state.intern("\xEF\xBF\xBD", 3);
  } else if (type == MD_TEXT_ENTITY && text != nullptr && size > 0) {
    /* Range keeps covering the raw "&amp;"; stringA carries its decoded
     * value, resolved against md4c's full HTML5 table. */
    std::string decoded;
    decoded.reserve(size);
    appendDecodedEntity(text, size, &decoded);
    event.stringA = state.intern(decoded.data(), decoded.size());
  } else if (!anchored && text != nullptr && size > 0) {
    /* Text md4c does not point into the source, mostly the static "\n" it
     * reports for breaks and code-block lines. */
    event.stringA = state.intern(text, size);
  }

  state.out->events.push_back(event);
  return 0;
}

}  // namespace

ParseResult parseWithOffsets(const char* source, uint32_t byteLength,
                             const ParserConfig& config) {
  ParseResult result;
  result.utf16OffsetByByte = buildUtf16OffsetMap(source, byteLength);

  SaxState state;
  state.source = source;
  state.size = byteLength;
  state.out = &result;

  MD_PARSER parser;
  std::memset(&parser, 0, sizeof(parser));
  parser.abi_version = 0;
  parser.flags = toMd4cFlags(config);
  parser.enter_block = enterBlockCallback;
  parser.leave_block = leaveBlockCallback;
  parser.enter_span = enterSpanCallback;
  parser.leave_span = leaveSpanCallback;
  parser.text = textCallback;
  parser.debug_log = nullptr;
  parser.syntax = nullptr;

  const int rc = md_parse(source, byteLength, &parser, &state);
  result.ok = rc == 0;
  return result;
}

}  // namespace selectable_markdown
