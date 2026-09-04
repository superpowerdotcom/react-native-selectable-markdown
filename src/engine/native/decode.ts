/**
 * Flat-buffer → ParsedDocument decoder.
 *
 * This is the JS half of the native boundary: it reads the single
 * ArrayBuffer `platform/cpp/FlatBuffer.cpp` produced (format in
 * `protocol.ts` / `Protocol.h`) and materializes the span-carrying
 * `ParsedDocument` that every layer above the engine — streaming splice,
 * selection projection, copy — is written against. md4c decides the
 * *structure*; this file is where that structure becomes the document model,
 * and it is the last place either can still be got wrong.
 *
 * THREE THINGS THE DECODER OWNS, because the native side deliberately does
 * not — and because nothing above the engine is allowed to redo them:
 *
 * 1. **Span widening.** Events carry content ranges: md4c reports the `x` in
 *    `**x**`, not the asterisks. Construct spans are recovered here (see
 *    `widen.ts`), so by the time a node exists its span already covers the
 *    whole construct and `source.slice(span.start, span.end)` round-trips.
 * 2. **Text.** No source *slice* crosses the boundary: prose reaches this
 *    file as offsets, and a text node's value is cut from the JS source
 *    string the caller already holds. That is what makes escape handling and
 *    smart punctuation this side's work. Entity decoding is the deliberate
 *    exception — the decoded value of `&hellip;` arrives interned in the
 *    string table, because md4c already ships the whole HTML5 name table and
 *    a JS copy of it would outweigh this decoder (see
 *    `appendDecodedEntity` in platform/cpp/OffsetParser.cpp, and the
 *    ownership table in docs/NATIVE.md). Hrefs, titles and info strings
 *    cross as strings for the same reason: they are values, not ranges, and
 *    md4c resolved their escapes and entities while building the attribute.
 *    `entities.ts` is not on any of those paths — it is only the defensive
 *    fallback for an entity event that arrives with no interned value.
 * 3. **Policy.** The URL allowlist and the HTML strip/raw decision are
 *    applied at parse time, while the node is being built: a blocked link
 *    degrades to its text, a blocked image to its alt, stripped HTML
 *    disappears. That placement is the invariant — `parseDocument` never
 *    returns a node carrying a destination the policy rejected, so a
 *    consumer's own `link` renderer, or anything that reads `href` off a
 *    node, cannot bypass the check by not knowing about it.
 *
 * Structure: one linear pass over the event list with an explicit frame
 * stack. Nodes are built on Leave, when a frame's children are known and
 * their spans are already widened — which is what lets nested delimiters
 * (`***x***`) widen outward one level at a time.
 */

import type {
  AnyNode,
  Block,
  HeadingLevel,
  Inline,
  ListItemNode,
  ParsedDocument,
  TableAlignment,
  TableCellNode,
  TableRowNode,
} from '../../document/nodes';
// A VALUE import, deliberately: this module used to keep its own copy of the
// block-kind set, which meant two lists that had to be edited together with
// nothing checking that they were. `isBlock` is the one classifier.
import { isBlock } from '../../document/nodes';
import type { SourceSpan } from '../../document/span';
import type { ResolvedEngineOptions } from '../options';
import { decodeEntityAt } from '../entities';
import { isUrlAllowed, sanitizeUrl } from '../urlPolicy';
import * as P from './protocol';
import * as W from './widen';

export class NativeProtocolError extends Error {}

interface Frame {
  node: P.NodeType;
  /**
   * Content range as reported by the parser, as two numbers rather than a
   * SourceSpan: a frame exists for every node in the document and this is
   * the hot loop, so the object is materialized only when a node is built.
   * `contentStart` is -1 when the node anchors to nothing.
   */
  contentStart: number;
  contentEnd: number;
  detailFlags: number;
  detailA: number;
  stringA: number;
  stringB: number;
  children: AnyNode[];
  /** Verbatim text for code, HTML and math. */
  literal: string;
  literalSpan: SourceSpan;
  /** Table assembly: filled by the THEAD/TBODY children as they close. */
  headerRow: TableRowNode | null;
  bodyRows: TableRowNode[];
  aligns: TableAlignment[];
  /** Pending merged text run (see `flushText`). */
  runStart: number;
  runEnd: number;
  runValue: string;
  runActive: boolean;
}

function newFrame(
  node: P.NodeType,
  contentStart: number,
  contentEnd: number,
  detailFlags: number,
  detailA: number,
  stringA: number,
  stringB: number,
): Frame {
  return {
    node,
    contentStart,
    contentEnd,
    detailFlags,
    detailA,
    stringA,
    stringB,
    children: [],
    literal: '',
    literalSpan: W.NO_SPAN,
    headerRow: null,
    bodyRows: [],
    aligns: [],
    runStart: -1,
    runEnd: -1,
    runValue: '',
    runActive: false,
  };
}


/**
 * Decode a wire buffer against the source it was produced from.
 *
 * `source` must be the exact string that was parsed: the decoder slices it
 * for every text node, and the header's UTF-16 length is checked against it
 * so a mismatched pair fails loudly instead of producing shifted spans.
 *
 * EVERY WAY THE BUFFER CAN BE WRONG IS A THROW, never a shorter document.
 * `readHeader` rejects the header words (magic, version, the parse-failure
 * flag, the length that ties the buffer to this string); the loop below
 * rejects an unbalanced Leave and, at the end, frames still open when the
 * events run out. Each of those otherwise decodes as a plausible document
 * silently missing its tail — a truncated event list yields the heading and
 * nothing else — which is the failure mode `nativeEngine` in ./index refuses
 * on principle, because a blank or short screen sends the reader to their own
 * data layer instead of to the parser.
 */
export function decodeFlatBuffer(
  source: string,
  buffer: ArrayBuffer,
  options: ResolvedEngineOptions,
): ParsedDocument {
  const header = readHeader(buffer, source);
  const words = new Uint32Array(buffer, header.eventsOffset, header.eventCount * 6);
  const strings = new StringTable(buffer, header);
  const ctx: DecodeContext = { source, options, strings, cursor: 0 };

  const stack: Frame[] = [newFrame(P.NodeType.Document, -1, -1, 0, 0, -1, -1)];

  for (let i = 0; i < header.eventCount; i += 1) {
    const base = i * 6;
    const packed = words[base];
    const kind = packed & 0xff;
    const node = (packed >>> 8) & 0xff;
    const textKind = (packed >>> 16) & 0xff;
    const detailFlags = (packed >>> 24) & 0xff;
    const start = words[base + 1];
    const end = words[base + 2];
    const detailA = words[base + 3];
    const stringA = words[base + 4] | 0;
    const stringB = words[base + 5] | 0;
    const contentStart = start === P.NO_OFFSET ? -1 : start;
    const contentEnd =
      contentStart < 0 ? -1 : end === P.NO_OFFSET ? contentStart : end;

    switch (kind) {
      case P.EventKind.BlockEnter:
      case P.EventKind.SpanEnter: {
        if (node === P.NodeType.Document) break; // the root frame already exists
        // The parent's pending text run ends where its next child begins;
        // flushing here is what keeps inline order (`hello ` before `*world*`).
        flushText(stack[stack.length - 1], ctx);
        stack.push(
          newFrame(node, contentStart, contentEnd, detailFlags, detailA, stringA, stringB),
        );
        break;
      }
      case P.EventKind.BlockLeave:
      case P.EventKind.SpanLeave: {
        if (node === P.NodeType.Document) break;
        if (stack.length < 2) {
          throw new NativeProtocolError('unbalanced node events from the native parser');
        }
        const frame = stack.pop() as Frame;
        flushText(frame, ctx);
        closeFrame(frame, stack[stack.length - 1], ctx);
        break;
      }
      case P.EventKind.Text: {
        onText(stack[stack.length - 1], textKind, contentStart, contentEnd, stringA, ctx);
        break;
      }
      default:
        throw new NativeProtocolError(`unknown event kind ${kind}`);
    }
  }

  if (stack.length > 1) {
    // Enter events with no matching Leave. The frames left open hold every
    // node built inside them, so returning `stack[0].children` here would
    // hand back a document that stops at the last construct that happened to
    // close — in-bounds, well-formed, and missing its tail without saying so.
    throw new NativeProtocolError(
      `native parse buffer ended with ${stack.length - 1} node(s) still open: the ` +
        'event list is truncated',
    );
  }

  const root = stack[0];
  flushText(root, ctx);
  return { source, blocks: root.children as Block[] };
}

interface DecodeContext {
  source: string;
  options: ResolvedEngineOptions;
  strings: StringTable;
  /**
   * Highest source offset consumed so far. Events arrive in document order,
   * so this is a monotone cursor — and it is the only way to place the
   * constructs md4c reports with no offsets at all: line breaks (whose text
   * callback carries a static "\n", not a pointer into the source) and
   * empty blocks like `## ` or a thematic break.
   */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Buffer reading
// ---------------------------------------------------------------------------

interface Header {
  eventCount: number;
  eventsOffset: number;
  stringCount: number;
  stringIndexOffset: number;
  stringBytesOffset: number;
  stringBytesLength: number;
}

function readHeader(buffer: ArrayBuffer, source: string): Header {
  if (buffer.byteLength < P.HEADER_SIZE) {
    throw new NativeProtocolError('native parse buffer is shorter than its header');
  }
  const h = new Uint32Array(buffer, 0, P.HEADER_SIZE / 4);
  if (h[P.HEADER_MAGIC] !== P.MAGIC) {
    throw new NativeProtocolError(
      'native parse buffer has the wrong magic word — the linked module does not ' +
        'speak this protocol (or the platform is big-endian, which is unsupported)',
    );
  }
  if (h[P.HEADER_VERSION] !== P.PROTOCOL_VERSION) {
    throw new NativeProtocolError(
      `native module speaks protocol v${h[P.HEADER_VERSION]}, this package speaks ` +
        `v${P.PROTOCOL_VERSION}: rebuild the app against the matching native module`,
    );
  }
  /* Header word 3, bit 0 (`kFlagParseOk`). Checked BEFORE the length word,
   * because the encoder's failure buffer reports utf16Length 0 and would
   * otherwise be blamed on the caller as "a different string".
   *
   * A clear flag means md4c gave up mid-parse (allocation) or the encoder
   * could not lay the document out; either way `events` holds at most the
   * prefix emitted before that happened (OffsetParser.h, `ParseResult::ok`).
   * Decoding it anyway would produce a well-formed document silently missing
   * its tail — or an empty one — which is the signal `nativeEngine` in
   * ./index deliberately refuses to send, because a blank screen sends the
   * reader to their own data layer instead of to the parser. */
  if ((h[P.HEADER_FLAGS] & P.FLAG_PARSE_OK) === 0) {
    throw new NativeProtocolError(
      'the native parser reported failure (md4c could not allocate, or the document ' +
        'overflowed the wire format): its event list is a truncated prefix, so no ' +
        'document is decoded from it',
    );
  }
  if (h[P.HEADER_UTF16_LENGTH] !== source.length) {
    throw new NativeProtocolError(
      `native parse covered ${h[P.HEADER_UTF16_LENGTH]} UTF-16 units but the source ` +
        `holds ${source.length}: the buffer belongs to a different string`,
    );
  }
  return {
    eventCount: h[P.HEADER_EVENT_COUNT],
    eventsOffset: h[P.HEADER_EVENTS_OFFSET],
    stringCount: h[P.HEADER_STRING_COUNT],
    stringIndexOffset: h[P.HEADER_STRING_INDEX_OFFSET],
    stringBytesOffset: h[P.HEADER_STRING_BYTES_OFFSET],
    stringBytesLength: h[P.HEADER_STRING_BYTES_LENGTH],
  };
}

/**
 * Lazily decoded UTF-8 string table: the values that are NOT source slices —
 * link hrefs, titles, info strings, an entity's decoded value, and the text
 * md4c synthesizes rather than pointing at.
 *
 * That last class is not rare, whatever the name "synthesized" suggests:
 * md4c reports every soft break, hard break, code-block line and HTML-block
 * line as the same static "\n", the largest single class of value the table
 * is offered. Its share of the ENTRIES is much smaller: the native side
 * interns a run of identical values once (`SaxState::intern` in
 * platform/cpp/OffsetParser.cpp), which is what makes this cache able to hit
 * for them at all — it is keyed by index, so the same text at a thousand
 * distinct indices always missed — and `textOf` only asks for the ones a
 * branch actually reads.
 *
 * The decoder is deliberately written not to depend on TextDecoder, which
 * Hermes does not guarantee.
 */
class StringTable {
  private readonly index: Uint32Array;
  private readonly bytes: Uint8Array;
  private readonly cache: (string | undefined)[];

  constructor(buffer: ArrayBuffer, header: Header) {
    this.index =
      header.stringCount === 0
        ? new Uint32Array(0)
        : new Uint32Array(buffer, header.stringIndexOffset, header.stringCount + 1);
    this.bytes = new Uint8Array(buffer, header.stringBytesOffset, header.stringBytesLength);
    this.cache = new Array(header.stringCount);
  }

  get(index: number): string {
    if (index < 0 || index >= this.cache.length) return '';
    const hit = this.cache[index];
    if (hit !== undefined) return hit;
    const value = utf8Decode(this.bytes, this.index[index], this.index[index + 1]);
    this.cache[index] = value;
    return value;
  }
}

/** Minimal UTF-8 decoder with an ASCII fast path (hrefs are usually ASCII). */
function utf8Decode(bytes: Uint8Array, from: number, to: number): string {
  let ascii = true;
  for (let i = from; i < to; i += 1) {
    if (bytes[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // One fromCharCode per chunk, not per byte. `apply` with an array-like is
    // plain ES (no TextDecoder dependency), and the chunk bound keeps the
    // argument count far under any engine's stack limit.
    let out = '';
    for (let i = from; i < to; i += 4096) {
      const chunk = bytes.subarray(i, Math.min(i + 4096, to));
      out += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return out;
  }
  let out = '';
  let i = from;
  while (i < to) {
    const lead = bytes[i];
    let cp: number;
    let size: number;
    if (lead < 0x80) {
      cp = lead;
      size = 1;
    } else if ((lead & 0xe0) === 0xc0) {
      cp = lead & 0x1f;
      size = 2;
    } else if ((lead & 0xf0) === 0xe0) {
      cp = lead & 0x0f;
      size = 3;
    } else if ((lead & 0xf8) === 0xf0) {
      cp = lead & 0x07;
      size = 4;
    } else {
      out += '�';
      i += 1;
      continue;
    }
    if (i + size > to) {
      out += '�';
      break;
    }
    for (let j = 1; j < size; j += 1) cp = (cp << 6) | (bytes[i + j] & 0x3f);
    out += String.fromCodePoint(cp);
    i += size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text events
// ---------------------------------------------------------------------------

/** Frames whose text is verbatim content, not inline structure. */
function isLiteralFrame(node: P.NodeType): boolean {
  return (
    node === P.NodeType.CodeBlock ||
    node === P.NodeType.CodeSpan ||
    node === P.NodeType.HtmlBlock ||
    node === P.NodeType.MathInline ||
    node === P.NodeType.MathDisplay
  );
}

/**
 * The event's display text: a slice of the source string the caller already
 * holds when the event is anchored, and the parser's interned copy when it
 * is not (synthesized text, and the "\n" md4c reports for every break).
 *
 * Called from the branches that consume it, never computed up front. Breaks
 * are the most common text event in ordinary prose and they discard it
 * entirely — they carry an interned "\n" that no branch reads — so computing
 * it for every event paid a string-table decode per line of every document.
 * Doing that eagerly measured 1.6x the decode time of a break-heavy document.
 */
function textOf(
  anchored: boolean,
  start: number,
  end: number,
  stringA: number,
  ctx: DecodeContext,
): string {
  if (anchored) return ctx.source.slice(start, end);
  return stringA >= 0 ? ctx.strings.get(stringA) : '';
}

function onText(
  frame: Frame,
  textKind: P.TextKind,
  start: number,
  end: number,
  stringA: number,
  ctx: DecodeContext,
): void {
  const anchored = start >= 0;
  const span: SourceSpan = anchored ? { start, end } : W.NO_SPAN;

  if (anchored && end > ctx.cursor) ctx.cursor = end;

  if (isLiteralFrame(frame.node)) {
    // Inside code/HTML/math, every text kind is verbatim content: an entity
    // stays raw (md4c does not decode inside code) and structure is
    // flattened.
    //
    // A LINE BREAK IS A NEWLINE ONLY IN A VERBATIM *BLOCK* (md4c.c:5363). A
    // code or math *SPAN* is a different rule one level down: md4c collapses
    // its interior line endings to a literal space (md4c.c:5063-5083), so
    // `$a\nb$` decodes to the value `a b`, `` `a\nb` `` to `a b`, and only a
    // fenced or indented block keeps the `\n`. Nothing here has to do the
    // collapsing — md4c has already reported the space as text by the time
    // this runs — but a reader who takes 'a soft break is a newline' at face
    // value will look for the bug in the wrong layer.
    if (textKind === P.TextKind.NullChar) {
      const nul = synthesizeCharSpan(span, ctx, '\u0000');
      frame.literal += '\ufffd';
      frame.literalSpan = W.unionSpan(frame.literalSpan, nul);
      return;
    }
    frame.literal += textOf(anchored, start, end, stringA, ctx);
    frame.literalSpan = W.unionSpan(frame.literalSpan, span);
    return;
  }

  switch (textKind) {
    case P.TextKind.SoftBreak:
      flushText(frame, ctx);
      frame.children.push({ kind: 'softBreak', span: synthesizeBreakSpan(span, ctx) });
      break;
    case P.TextKind.HardBreak:
      flushText(frame, ctx);
      frame.children.push({
        kind: 'hardBreak',
        span: W.widenHardBreak(ctx.source, synthesizeBreakSpan(span, ctx)),
      });
      break;
    case P.TextKind.Html: {
      flushText(frame, ctx);
      const literal = textOf(anchored, start, end, stringA, ctx);
      if (ctx.options.html === 'raw') {
        // md4c synthesizes the text of an HTML span that crosses a line
        // break, so the event arrives with no offsets. The literal is still
        // verbatim source, so it can be found; when it cannot (normalized
        // whitespace), a zero-width span at the cursor keeps the node inside
        // its parent instead of escaping with -1.
        frame.children.push({
          kind: 'htmlSpan',
          span: W.isAnchored(span) ? span : locateLiteral(literal, ctx),
          literal,
        });
        break;
      }
      // Under `html: 'strip'` the node is dropped entirely, with ONE
      // exception below. md4c still *parsed* the HTML (see HTML_PARSED in
      // protocol.ts) — stripping means removing the construct, not
      // re-rendering its source as prose — so the block structure around it
      // is the same either way, and only the node disappears. The
      // surrounding text runs stay separate rather than merging across the
      // hole, so spans still cover exactly what they render and a selection
      // across the gap copies back the raw HTML.
      //
      // The exception is `<br>`: it is a line break rather than markup, and
      // dropping it is not "the construct disappears" but "two words are
      // silently joined" — `line one<br>line two` would render as
      // `line oneline two`. Models emit it constantly, and inside a GFM
      // table cell it is the only way to break a line at all. So under
      // 'strip' it becomes a `hardBreak` over the same span the tag
      // occupies: the break the author asked for, with no HTML on the node.
      // Only an anchored event qualifies — an unanchored one (md4c
      // synthesizes the text of a span that crosses a line break) has no
      // offsets to give the node, and `locateLiteral` may not find the
      // normalized literal, which would leave a zero-width break behind.
      if (W.isAnchored(span) && isHtmlLineBreak(literal)) {
        frame.children.push({ kind: 'hardBreak', span });
      }
      break;
    }
    case P.TextKind.NullChar:
      // CommonMark renders a NUL as U+FFFD; the span still covers the one
      // source character it replaces, so the text run around it stays whole.
      appendText(frame, synthesizeCharSpan(span, ctx, '\u0000'), '\ufffd', ctx);
      break;
    case P.TextKind.Entity:
      // The span keeps covering the raw `&amp;`; the value is md4c's
      // decoding of it, which knows the whole HTML5 table. The JS fallback
      // behind it is defensive only — the parser interns a decoded value for
      // every entity event it emits.
      appendText(
        frame,
        span,
        stringA >= 0
          ? ctx.strings.get(stringA)
          : decodeEntity(textOf(anchored, start, end, stringA, ctx)),
        ctx,
      );
      break;
    default: {
      const literal = textOf(anchored, start, end, stringA, ctx);
      appendText(frame, span, maybeSmartPunctuation(literal, span, frame, ctx), ctx);
      break;
    }
  }
}

/**
 * Some text events stand for exactly one source character but arrive with no
 * offset, because md4c hands the callback a static string rather than a
 * pointer into the buffer: line breaks (a literal "\n") and NUL characters.
 * Both are recovered the same way — events are in document order, so the
 * next occurrence of that character at or after the cursor is necessarily
 * this event's.
 *
 * Getting this wrong is not cosmetic: an unanchored break would leave a node
 * with no span, and an unanchored NUL would split the text run around it into
 * two nodes whose spans skip the character entirely.
 */
function synthesizeCharSpan(
  span: SourceSpan,
  ctx: DecodeContext,
  ch: string,
): SourceSpan {
  if (W.isAnchored(span)) return span;
  const at = ctx.source.indexOf(ch, ctx.cursor);
  if (at === -1) return span;
  ctx.cursor = at + 1;
  return { start: at, end: at + 1 };
}

/**
 * The same recovery for a line break, which cannot use `synthesizeCharSpan`
 * because a break is not one character.
 *
 * md4c hands the callback the static string "\n" whatever the file actually
 * uses, so the break's real source has to be found rather than trusted. All
 * three CommonMark line endings are searched for, and a `\r\n` is taken
 * whole: covering only the `\n` would leave the `\r` inside no node at all,
 * and covering only the `\r` would do the same to the `\n`. Either way a
 * selection that ends at the break copies back a mutilated line ending, and
 * `widenHardBreak` — which scans left from `start` for the trailing spaces —
 * would stop dead on the `\r` and lose them too.
 *
 * A bare `\r` used to find no `\n` at all and leave the node unanchored,
 * which is how a `{-1,-1}` span reached the streaming splice.
 */
function synthesizeBreakSpan(span: SourceSpan, ctx: DecodeContext): SourceSpan {
  if (W.isAnchored(span)) return span;
  const { source } = ctx;
  let at = ctx.cursor;
  while (at < source.length && source[at] !== '\n' && source[at] !== '\r') at += 1;
  if (at === source.length) return span;
  const end = at + (source[at] === '\r' && source[at + 1] === '\n' ? 2 : 1);
  ctx.cursor = end;
  return { start: at, end };
}

/** Find verbatim text at or after the cursor; zero-width when absent. */
function locateLiteral(literal: string, ctx: DecodeContext): SourceSpan {
  const at = literal.length > 0 ? ctx.source.indexOf(literal, ctx.cursor) : -1;
  if (at === -1) return { start: ctx.cursor, end: ctx.cursor };
  ctx.cursor = at + literal.length;
  return { start: at, end: at + literal.length };
}

/**
 * True for an inline `<br>` in any of its written forms — `<br>`, `<br/>`,
 * `<br />`, `<BR>`, `<br class="x">`.
 *
 * The lookahead is what keeps every other tag out, and it has to be a
 * lookahead for a character class rather than `\b`: a hyphen is a legal
 * CommonMark tag-name character (`[A-Za-z][A-Za-z0-9-]*`), and `\b` matches
 * between `r` and `-`, so `<br-thing>` and any other custom element named
 * `br-*` used to be read as a line break and silently inserted one. A real
 * `<br>` tag name can only end at whitespace, at `/`, or at `>`.
 *
 * `</br>` is deliberately not a break, matching every HTML parser, which
 * treats a void element's end tag as nothing at all. `[^>]*` cannot cross a
 * `>` inside a quoted attribute value either, so the (legal, vanishingly
 * rare) `<br title="x>y">` is not recognized and is stripped like any other
 * markup — the failure is a missing break, never a spurious one.
 */
const HTML_LINE_BREAK = /^<br(?=[\s/>])[^>]*>$/i;

function isHtmlLineBreak(literal: string): boolean {
  return HTML_LINE_BREAK.test(literal);
}

function decodeEntity(raw: string): string {
  const decoded = decodeEntityAt(raw, 0);
  return decoded && decoded.length === raw.length ? decoded.value : raw;
}

/**
 * Append one text event to the frame's pending run, merging with the
 * previous event when only backslash escapes separate them. md4c points
 * past the backslash of an escaped character, so without this a single
 * `\*escaped\*` would decode as three text nodes whose spans skip the
 * backslashes and break the source-slice invariant.
 */
function appendText(frame: Frame, span: SourceSpan, value: string, ctx: DecodeContext): void {
  if (!W.isAnchored(span)) {
    if (frame.runActive) frame.runValue += value;
    return;
  }
  if (frame.runActive && W.isEscapeGap(ctx.source, frame.runEnd, span.start)) {
    frame.runEnd = span.end;
    frame.runValue += value;
    return;
  }
  flushText(frame, ctx);
  frame.runActive = true;
  frame.runStart = W.widenEscapedTextStart(ctx.source, span.start);
  frame.runEnd = span.end;
  frame.runValue = value;
}

function flushText(frame: Frame, _ctx: DecodeContext): void {
  if (!frame.runActive) return;
  frame.children.push({
    kind: 'text',
    span: { start: frame.runStart, end: frame.runEnd },
    value: frame.runValue,
  });
  frame.runActive = false;
  frame.runValue = '';
}

/**
 * cmark `--smart` rules, applied per event slice.
 *
 * Per *slice* is what makes the exclusions fall out for free: md4c reports
 * every escape and every entity as its own text event, and code spans, math
 * and autolink URIs arrive as their own node types, so a slice that reaches
 * this function is already known to be plain prose. Nothing here has to
 * re-scan for `\'` or `&apos;` to avoid transforming it.
 */
function maybeSmartPunctuation(
  literal: string,
  span: SourceSpan,
  frame: Frame,
  ctx: DecodeContext,
): string {
  if (!ctx.options.smartPunctuation) return literal;
  if (isEscapedSlice(ctx.source, span)) return literal;
  const before = frame.runActive && frame.runValue.length > 0
    ? frame.runValue[frame.runValue.length - 1]
    : undefined;
  return applySmartPunctuation(literal, before);
}

function isEscapedSlice(source: string, span: SourceSpan): boolean {
  return span.end - span.start === 1 && span.start > 0 && source[span.start - 1] === '\\';
}

/**
 * Exported so the typographic rules can be pinned directly, one input string
 * at a time, without first finding a document whose emphasis and punctuation
 * happen to isolate the flanking case under test. See
 * __tests__/smart-punctuation.test.ts.
 */
export function applySmartPunctuation(text: string, before: string | undefined): string {
  let out = '';
  let prev = before;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const opener = prev === undefined || /[\s([{]/.test(prev);
      out += ch === '"' ? (opener ? '“' : '”') : opener ? '‘' : '’';
      prev = ch;
      i += 1;
      continue;
    }
    if (ch === '-') {
      let n = 1;
      while (text[i + n] === '-') n += 1;
      if (n === 1) {
        out += '-';
        prev = '-';
        i += 1;
        continue;
      }
      out += dashRun(n);
      prev = '-';
      i += n;
      continue;
    }
    if (ch === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
      out += '…';
      prev = '.';
      i += 3;
      continue;
    }
    out += ch;
    prev = ch;
    i += 1;
  }
  return out;
}

/** A run divisible by 3 is all em dashes, else by 2 all en, else mixed. */
function dashRun(n: number): string {
  let em = 0;
  let en = 0;
  if (n % 3 === 0) em = n / 3;
  else if (n % 2 === 0) en = n / 2;
  else if (n % 3 === 2) {
    en = 1;
    em = (n - 2) / 3;
  } else {
    en = 2;
    em = (n - 4) / 3;
  }
  return '—'.repeat(em) + '–'.repeat(en);
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

/** Union of the frame's reported content range and its built children. */
function contentSpan(frame: Frame): SourceSpan {
  let span: SourceSpan =
    frame.contentStart < 0 ? W.NO_SPAN : { start: frame.contentStart, end: frame.contentEnd };
  for (const child of frame.children) span = W.unionSpan(span, child.span);
  span = W.unionSpan(span, frame.literalSpan);
  return span;
}

/**
 * The frame's content range, with a fallback for constructs that carry no
 * offsets at all. An empty ATX heading (`## `), an empty list item or a
 * thematic break reaches the decoder unanchored; since events are ordered,
 * the construct's source is the first non-blank line at or after the
 * cursor. Leaving these unanchored is not an option — every node's span is
 * load-bearing for selection and for the streaming splice.
 */
function anchoredSpan(frame: Frame, ctx: DecodeContext): SourceSpan {
  const span = contentSpan(frame);
  if (W.isAnchored(span)) return span;
  if (frame.node === P.NodeType.ThematicBreak) return span; // located by its own rule
  if (frame.node === P.NodeType.TableCell || frame.node === P.NodeType.TableHeaderCell) {
    // Cells are placed from their row's pipes once the row closes; the
    // first-non-blank-line rule would walk out of the row onto the
    // delimiter line, or off the end of the source entirely.
    return span;
  }
  const located = W.locateFirstNonBlankLine(ctx.source, ctx.cursor, ctx.source.length);
  return located ?? span;
}

/**
 * Build the frame's node, then advance the cursor past what it really covers.
 *
 * THE CURSOR HAS TO BE ADVANCED FROM THE *FINAL* SPAN, not from the content
 * range the frame was reported with. Widening can move a span's end: a fenced
 * code block's content stops at the last code character, but `widenCodeBlock`
 * takes the closing fence line with it. Advancing from the content range left
 * the cursor pointing at the closing fence, so the next unanchored construct
 * — an empty heading, an empty list item, anything `anchoredSpan` places by
 * `locateFirstNonBlankLine` — resolved to the ``` line itself and landed
 * *inside* the code block. That is not a cosmetic offset: the empty item's
 * list then starts there too, so copying it reproduces the previous block's
 * fence instead of the list.
 *
 * The advance therefore happens after `buildFrame` has pushed, over the spans
 * of whatever it pushed. `buildFrame` keeps its own pre-advance from the
 * content range, because a frame can legitimately push nothing (a table head,
 * a stripped HTML block) and the source it consumed must still be behind the
 * cursor.
 */
function closeFrame(frame: Frame, parent: Frame, ctx: DecodeContext): void {
  const firstBuilt = parent.children.length;
  buildFrame(frame, parent, ctx);
  for (let i = firstBuilt; i < parent.children.length; i += 1) {
    const built = parent.children[i].span;
    if (W.isAnchored(built) && built.end > ctx.cursor) ctx.cursor = built.end;
  }
}

function buildFrame(frame: Frame, parent: Frame, ctx: DecodeContext): void {
  const { source } = ctx;
  const span = anchoredSpan(frame, ctx);
  // Whether `span` is the frame's own content range or a line `anchoredSpan`
  // LOCATED for a construct that reported none. Two wideners need to know: an
  // empty heading and an empty fence are both handed their own marker line,
  // which is not where a heading's content or a fence's first code line sits.
  const located = !W.isAnchored(contentSpan(frame));
  const children = frame.children;
  // A floor, not the final word: `closeFrame` re-advances from the built
  // node's span, which a widener may have pushed further right.
  if (W.isAnchored(span)) ctx.cursor = Math.max(ctx.cursor, span.end);

  switch (frame.node) {
    // -- blocks -------------------------------------------------------------
    case P.NodeType.Paragraph:
      push(parent, { kind: 'paragraph', span, children: children as Inline[] });
      return;

    case P.NodeType.Heading:
      push(parent, {
        kind: 'heading',
        span: W.widenHeading(source, span, !located),
        level: clampLevel(frame.detailA),
        children: children as Inline[],
      });
      return;

    case P.NodeType.CodeBlock: {
      const fenceChar = frame.detailA === 0 ? null : String.fromCharCode(frame.detailA);
      // An empty fence has no content offsets, so `span` above is the line
      // `anchoredSpan` LOCATED for it — the opening fence itself. The widener
      // has to be told, or it looks for the fence on the line above and finds
      // the previous block's closing one.
      const { span: widened, closed } = W.widenCodeBlock(source, span, fenceChar, !located);
      // Already decoded: md4c resolved the info string's escapes and
      // entities while building the attribute (see the Link case below).
      const language = frame.stringA >= 0 ? ctx.strings.get(frame.stringA).trim() : '';
      push(parent, {
        kind: 'codeBlock',
        span: widened,
        literal: frame.literal,
        fenced: fenceChar !== null,
        closed,
        ...(language ? { language } : {}),
      });
      return;
    }

    case P.NodeType.HtmlBlock:
      if (ctx.options.html === 'raw') {
        const trimmed = W.trimSpanEnd(source, span);
        push(parent, {
          kind: 'htmlBlock',
          span: trimmed,
          literal: source.slice(trimmed.start, trimmed.end),
        });
      }
      return;

    case P.NodeType.Blockquote:
      push(parent, {
        kind: 'blockquote',
        span: W.widenBlockquote(source, span),
        children: children as Block[],
      });
      return;

    case P.NodeType.UnorderedList:
    case P.NodeType.OrderedList: {
      const ordered = frame.node === P.NodeType.OrderedList;
      push(parent, {
        kind: 'list',
        span,
        ordered,
        tight: (frame.detailFlags & P.DETAIL_LIST_TIGHT) !== 0,
        items: children as ListItemNode[],
        ...(ordered ? { start: frame.detailA } : {}),
      });
      return;
    }

    case P.NodeType.ListItem: {
      const task = (frame.detailFlags & P.DETAIL_TASK_MASK) >>> P.DETAIL_TASK_SHIFT;
      const ordered = parent.node === P.NodeType.OrderedList;
      push(parent, {
        kind: 'listItem',
        span: W.widenListItem(source, span, ordered, task !== P.TaskState.NotTask),
        children: wrapLooseInlines(children),
        ...(task === P.TaskState.Checked
          ? { task: 'checked' as const }
          : task === P.TaskState.Unchecked
            ? { task: 'unchecked' as const }
            : {}),
      });
      return;
    }

    case P.NodeType.ThematicBreak: {
      // Nothing in a thematic break anchors to the source, so it is located
      // by looking at the first non-blank line after everything consumed.
      const from = Math.max(ctx.cursor, previousEnd(parent, source));
      const located = W.locateThematicBreak(source, from, source.length);
      const resolved = located ?? { start: from, end: from };
      ctx.cursor = resolved.end;
      push(parent, { kind: 'thematicBreak', span: resolved });
      return;
    }

    // -- tables -------------------------------------------------------------
    case P.NodeType.Table: {
      const rows = frame.bodyRows;
      const header =
        frame.headerRow ??
        ({ kind: 'tableRow', span, cells: [] } satisfies TableRowNode);
      // Rows reach the table through the THEAD/TBODY frames rather than
      // through `children`, so they are not in `contentSpan` yet.
      let full = W.unionSpan(span, header.span);
      for (const row of rows) full = W.unionSpan(full, row.span);
      push(parent, {
        kind: 'table',
        span: W.widenTable(source, full, header.span.end),
        align: frame.aligns,
        header,
        rows,
      });
      return;
    }

    case P.NodeType.TableHead: {
      const rows = children as TableRowNode[];
      parent.headerRow = rows[0] ?? null;
      parent.aligns = frame.aligns;
      return;
    }

    case P.NodeType.TableBody:
      parent.bodyRows = children as TableRowNode[];
      // Alignment is declared by the header cells; a body-only table keeps
      // whatever the head recorded.
      return;

    case P.NodeType.TableRow: {
      // Alignment is declared per column by the header cells; it travels
      // cell -> row -> head -> table, since that is the nesting md4c emits.
      if (frame.aligns.length > 0) parent.aligns = frame.aligns;
      const rowSpan = W.widenTableRow(source, span);
      push(parent, {
        kind: 'tableRow',
        span: rowSpan,
        // Empty cells are placed here rather than at their own close,
        // because a cell's position is defined by the pipes of its row and
        // the row's extent is not known until now.
        cells: anchorEmptyCells(children as TableCellNode[], rowSpan, source),
      });
      return;
    }

    case P.NodeType.TableHeaderCell:
      frameAlign(parent, frame);
      push(parent, { kind: 'tableCell', span, children: children as Inline[] });
      return;

    case P.NodeType.TableCell:
      push(parent, { kind: 'tableCell', span, children: children as Inline[] });
      return;

    // -- inlines ------------------------------------------------------------
    case P.NodeType.Emphasis:
      push(parent, {
        kind: 'emphasis',
        span: W.widenDelimiters(source, span, 1, isEmphasisDelim),
        children: children as Inline[],
      });
      return;

    case P.NodeType.Strong:
      push(parent, {
        kind: 'strong',
        span: W.widenDelimiters(source, span, 2, isEmphasisDelim),
        children: children as Inline[],
      });
      return;

    case P.NodeType.Underline:
      push(parent, {
        kind: 'underline',
        span: W.widenDelimiters(source, span, 1, isUnderscore),
        children: children as Inline[],
      });
      return;

    case P.NodeType.Strikethrough:
      push(parent, {
        kind: 'strikethrough',
        span: W.widenDelimiters(source, span, 2, isTilde),
        children: children as Inline[],
      });
      return;

    case P.NodeType.CodeSpan:
      push(parent, {
        kind: 'codeSpan',
        span: W.widenCodeSpan(source, frame.literalSpan.start >= 0 ? frame.literalSpan : span),
        value: frame.literal,
      });
      return;

    case P.NodeType.MathInline:
    case P.NodeType.MathDisplay: {
      const display = frame.node === P.NodeType.MathDisplay;
      push(parent, {
        kind: 'math',
        span: display
          ? W.widenDisplayMath(source, span)
          : W.widenDelimiters(source, span, 1, isDollar),
        value: frame.literal,
        display,
      });
      return;
    }

    case P.NodeType.Link: {
      const autolink = (frame.detailFlags & P.DETAIL_AUTOLINK) !== 0;
      // The destination arrives DECODED, and is decoded exactly once. md4c
      // resolves backslash escapes while building the attribute and hands
      // the entity substrings to `internAttribute`
      // (platform/cpp/OffsetParser.cpp), which resolves them against the
      // full HTML5 table; the autolink case is handled there too, by md4c's
      // MD_BUILD_ATTR_NO_ESCAPES — an autolink's URI is literal, so
      // `<...?find=\*>` keeps its backslash. Running a JS decoder over the
      // result as well would resolve a second layer that the author wrote
      // deliberately: a destination written `?x=1&amp;amp;y=2` must yield
      // `?x=1&amp;y=2`, and one written `/a\\*b` must yield `/a\*b`.
      const href = sanitizeUrl(ctx.strings.get(frame.stringA));
      const allowed = isUrlAllowed(href, ctx.options.urlPolicy.linkPrefixes);
      const widened = autolink
        ? W.widenAutolink(source, span)
        : W.widenLink(source, span, false);
      // Blocked links render as plain text — not stripped, not a dead
      // link — with the span still covering the whole construct so a copy
      // of the selection reproduces the original markdown. Under
      // `blockedLinks: 'node'` an inline link keeps its node instead, flagged
      // `blocked`; an autolink has no label to keep, so it always degrades.
      if (!allowed && (autolink || ctx.options.urlPolicy.blockedLinks !== 'node')) {
        push(parent, { kind: 'text', span: widened, value: plainText(children as Inline[]) });
        return;
      }
      if (autolink) {
        push(parent, { kind: 'autolink', span: widened, href });
        return;
      }
      const title = frame.stringB >= 0 ? ctx.strings.get(frame.stringB) : '';
      push(parent, {
        kind: 'link',
        span: widened,
        href,
        children: children as Inline[],
        ...(title ? { title } : {}),
        ...(allowed ? {} : { blocked: true as const }),
      });
      return;
    }

    case P.NodeType.Image: {
      // Decoded once, natively — same as a link's destination above.
      const src = sanitizeUrl(ctx.strings.get(frame.stringA));
      const widened = W.widenLink(source, span, true);
      // An image's alt text is a *string*, but md4c reports its inline
      // structure (`![foo *bar*]`), so it is flattened here rather than
      // accumulated raw — which is also what makes a nested image's alt
      // contribute its own alt.
      const alt = plainText(children as Inline[]);
      if (!isUrlAllowed(src, ctx.options.urlPolicy.imagePrefixes)) {
        push(parent, { kind: 'text', span: widened, value: alt });
        return;
      }
      const title = frame.stringB >= 0 ? ctx.strings.get(frame.stringB) : '';
      push(parent, {
        kind: 'image',
        span: widened,
        src,
        alt,
        ...(title ? { title } : {}),
      });
      return;
    }

    default:
      // Unknown node type (defensive: the enabled flags cannot produce one).
      // Hoisting its children keeps their content rather than dropping it.
      for (const child of children) push(parent, child);
      return;
  }
}

/**
 * md4c omits the paragraph wrapper inside a *tight* list item — the item's
 * children arrive as bare inlines. The document model always wraps block
 * content, so each run of inlines becomes a paragraph spanning that run.
 * (A tight item with a nested list arrives as inlines followed by a block,
 * which is why this groups runs instead of wrapping everything once.)
 */
function wrapLooseInlines(children: AnyNode[]): Block[] {
  if (children.length === 0) return [];
  const out: Block[] = [];
  let run: Inline[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    let span = run[0].span;
    for (const node of run) span = W.unionSpan(span, node.span);
    out.push({ kind: 'paragraph', span, children: run });
    run = [];
  };
  for (const child of children) {
    if (isBlock(child)) {
      flushRun();
      out.push(child as Block);
    } else {
      run.push(child as Inline);
    }
  }
  flushRun();
  return out;
}

/**
 * Give every unanchored cell in a finished row a real span.
 *
 * An empty cell (`| | 2 |`, or the padding cell of a row shorter than the
 * header) carries no text, so nothing anchored it during decoding. Leaving
 * it unanchored is not survivable: `shiftSpans` rebases spans arithmetically
 * during the streaming splice, turning -1 into `anchor - 1`, so a table being
 * typed one character at a time would report offsets that do not exist.
 */
function anchorEmptyCells(
  cells: TableCellNode[],
  row: SourceSpan,
  source: string,
): TableCellNode[] {
  let patched: TableCellNode[] | null = null;
  for (let i = 0; i < cells.length; i += 1) {
    if (W.isAnchored(cells[i].span)) continue;
    if (!patched) patched = cells.slice();
    patched[i] = { ...cells[i], span: W.locateEmptyTableCell(source, row, i) };
  }
  return patched ?? cells;
}

function push(parent: Frame, node: AnyNode): void {
  parent.children.push(node);
}

/** Frames are closed before their parent's next text event, so a pending
 * run can only exist here if the parent's text preceded this child. */

/** Where the previous sibling ended, for locating unanchored constructs. */
function previousEnd(parent: Frame, source: string): number {
  for (let i = parent.children.length - 1; i >= 0; i -= 1) {
    const span = parent.children[i].span;
    if (span.start >= 0) return Math.min(span.end, source.length);
  }
  return parent.contentStart >= 0 ? parent.contentStart : 0;
}

function frameAlign(parent: Frame, frame: Frame): void {
  const align = (frame.detailFlags & P.DETAIL_ALIGN_MASK) >>> P.DETAIL_ALIGN_SHIFT;
  parent.aligns.push(
    align === P.CellAlign.Left
      ? 'left'
      : align === P.CellAlign.Center
        ? 'center'
        : align === P.CellAlign.Right
          ? 'right'
          : null,
  );
}

function clampLevel(level: number): HeadingLevel {
  const l = level < 1 ? 1 : level > 6 ? 6 : level;
  return l as HeadingLevel;
}

/**
 * Flattened text of an inline subtree — the fallback for blocked links and
 * the string form of an image's alt.
 *
 * AN EXPLICIT STACK, NOT RECURSION, because inline nesting is unbounded and
 * comes straight from untrusted markdown: `[***…***](…)` opens one emphasis
 * node per delimiter pair, so a 21 kB label nests ~10,000 deep. This runs on
 * the parse path — `parseDocument` calls it for every blocked link and every
 * image — so recursing here blew the JS stack while building the tree, one
 * stage before any of the walks above the engine could bound anything.
 *
 * Each frame is one child list plus the index reached in it, so a node's
 * children are appended between the text before them and the text after,
 * exactly as the recursive form did.
 */
function plainText(nodes: readonly Inline[]): string {
  let out = '';
  const stack: { nodes: readonly Inline[]; index: number }[] = [{ nodes, index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const node = frame.nodes[frame.index];
    frame.index += 1;
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'codeSpan':
      case 'math':
        out += node.value;
        break;
      case 'softBreak':
        out += '\n';
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'image':
        out += node.alt;
        break;
      case 'autolink':
        out += node.href;
        break;
      default:
        if ('children' in node) stack.push({ nodes: node.children, index: 0 });
        break;
    }
  }
  return out;
}

const isEmphasisDelim = (ch: string): boolean => ch === '*' || ch === '_';
const isUnderscore = (ch: string): boolean => ch === '_';
const isTilde = (ch: string): boolean => ch === '~';
const isDollar = (ch: string): boolean => ch === '$';
