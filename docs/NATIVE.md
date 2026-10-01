# The native md4c engine

md4c, vendored C behind one flat buffer per parse, is the package's only
parser. `parseDocument` uses `nativeEngine` when you pass no engine. Where the
compiled module is not linked, parsing throws instead of degrading; the way
out is your own `Engine` ([Writing an engine](ARCHITECTURE.md#writing-an-engine)).
The ag-ui hooks take one too — `useAgUiSession(events, id, { engine })` and
`useAgUiRunSessions(events, { engine })` forward it to every session they
create.

Pipeline: [ARCHITECTURE.md](ARCHITECTURE.md). Streaming (tail repair runs in
front of the engine, which never sees a prefix): [STREAMING.md](STREAMING.md).
Numbers: [BENCHMARKS.md](BENCHMARKS.md).

## Why native

md4c scores 651/652 (99.85%) on CommonMark 0.31.2 (`npm run conformance`),
every section at 100% except HTML blocks at 43/44. Link reference definitions,
all seven HTML block forms, tabs and destination edge cases come with it. The
score measures the parser, so the runner widens the library's two security
defaults first — `html: 'raw'` and an open URL allowlist — because the spec's
examples are full of raw HTML and `ftp:`/`javascript:` destinations.
`presets.commonmark` on its own turns extensions off and nothing else: it
still strips HTML and still allowlists destinations.
React Native runs Hermes, which has no JIT, so a JavaScript parser's laptop
throughput is not what would ship. Parsing a chat message takes microseconds
and the streaming layer reparses only a few hundred characters of tail, so the
cost that matters is the crossing. The binding crosses once per parse, with
one `ArrayBuffer` and no source text in it.

## Shape

JS calls `__selectableMarkdown.parse(source, extensionBits, htmlPolicy)`. From
there:

| Stage | File | Does |
| --- | --- | --- |
| Install glue | `platform/cpp/SelectableMarkdownJsi.cpp`, `platform/ios/…`, `android/…`, `native/node/addon.cpp` | Exposes the same call over JSI (device) and N-API (Node) |
| Parse | `platform/cpp/OffsetParser.cpp` | md4c SAX callbacks → flat node events. Recovers byte offsets from text callbacks, builds the byte→UTF-16 map, decodes entities with md4c's HTML5 table |
| Encode | `platform/cpp/FlatBuffer.cpp` | Events → wire buffer, one allocation. The only byte→UTF-16 conversion point; the map never ships |
| Decode | `src/engine/native/decode.ts`, `widen.ts` | Buffer → `ParsedDocument`. Text is sliced from the JS source, never copied. URL allowlist and HTML strip/raw applied here |

## The wire format

`platform/cpp/Protocol.h` is the contract. `src/engine/native/protocol.ts`
mirrors it, and `src/engine/native/__tests__/protocol.test.ts` fails the build
if they drift.

| Region | Layout |
| --- | --- |
| Header | 48 bytes, 12 × u32: magic `SMD1`, version, header size, flags, event count, events offset, string count, string index offset, string bytes offset, string bytes length, total UTF-16 length, reserved |
| Events | 24 bytes each: `kind`, `node`, `text`, `detailFlags` (u8 ×4), `start`, `end`, `detailA` (u32 ×3), `stringA`, `stringB` (i32 ×2) |
| String index | `stringCount + 1` u32 offsets into the string bytes |
| String bytes | UTF-8, not NUL-terminated |

Five properties the pipeline depends on:

1. **Offsets are UTF-16 code units.** `FlatBuffer.cpp` converts md4c's byte
   offsets through a byte→UTF-16 map and drops the map (four bytes per source
   byte). No UTF-8 arithmetic exists above the encoder. `buildUtf16OffsetMap`
   in `OffsetParser.cpp` tests 8 ASCII bytes at a time and goes byte-wise only
   for non-ASCII runs. `protocolVersion` is still 1.
2. **No source text is in the buffer.** Text events carry offsets. The string
   table holds only values that are not source slices: hrefs, titles, info
   strings, decoded entities, and the text md4c synthesizes rather than
   points at — mostly the `"\n"` it reports for every break and every code-
   or HTML-block line, which is the largest class, not a rare one. Identical
   values interned in a row share one entry (`SaxState::intern`), so a
   thousand-line document adds one entry rather than a thousand, and the
   decoder materializes an entry's string only in the branches that read it.
3. **Event ranges are content ranges.** `**bold**` reports `bold`. Widening is
   the decoder's job.
4. **Little-endian, 4-byte aligned, one allocation.** Fields are written byte
   by byte, so the format is an ABI. The magic word is the runtime check.
5. **The flags word is enforced, not merely carried.** Bit 0 is
   `kFlagParseOk`, set when md4c returned success. `readHeader` in
   `src/engine/native/decode.ts` throws a `NativeProtocolError` when it is
   clear: the events in such a buffer are only the prefix emitted before
   md4c gave up, and decoding that prefix would produce a well-formed
   document silently missing its tail. `decodeFlatBuffer` throws for the same
   reason when the event list ends with frames still open.

## Who owns what

| Decision | Where | Why |
| --- | --- | --- |
| Block/inline structure, GFM extensions | C++ (md4c) | Re-deciding structure in JS is how dialects drift |
| Byte→UTF-16 conversion | C++ (`FlatBuffer.cpp`) | One conversion point |
| Entity decoding in text | C++ (`OffsetParser.cpp`) | md4c ships the ~2100-name table; a JS copy would outweigh the decoder |
| Escapes and entities in hrefs, titles, info strings | C++ (`md_build_attribute` + `internAttribute` in `OffsetParser.cpp`) | String values, not source ranges. md4c drops backslash escapes while building the attribute and tags the entity substrings; `internAttribute` resolves those against the full table. Decoded exactly ONCE — a second JS pass turned `&amp;amp;` into `&` and a doubled backslash into a bare `*` |
| Span widening | TS (`widen.ts`) | Needs the source string |
| Text values, smart punctuation | TS (`decode.ts`) | Text is sliced from the JS source |
| URL allowlist, HTML strip/raw | TS (`decode.ts`, rules in `src/engine/urlPolicy.ts`) | Applied while the node is built, so no renderer can forget it. Pinned by `src/engine/urlPolicy.test.ts` |
| Spoilers (`\|\|…\|\|`) | TS, opt-in post-parse | The native wrapper has no spoiler flag; nothing native can enable non-CommonMark syntax |

Both entity rows land in C++, so `src/engine/entities.ts` is left holding one
job: the defensive fallback behind the decoder's `Entity` case, for an entity
event that somehow arrives with no interned value. The shipped parser never
emits one.

## Span widening

md4c's enter/leave callbacks carry no offsets; only text callbacks point into
the source. A node's reported range is the union of its descendants' text, so
`**bold**` comes back as `bold` and `## Title` as `Title`. The document model
requires `source.slice(span.start, span.end)` to be the exact construct, so
`widen.ts` recovers the punctuation.

Every widening function is line-local. None expands to the start of the line,
because a container prefix (`> `, list indentation) sits there and swallowing
it would break copy fidelity and nesting. Each scans outward from the content
edge and stops when the characters stop being this construct's own syntax:

```
> - nested        list item widens left to the '-', not to the '>'
> ```js           the fence is found by searching the line, not anchoring at its start
***deep***        strong widens first (**deep**), emphasis then widens that result
- [ ] todo        the item widens over the checkbox md4c consumed as syntax
```

That is a property of the WIDENERS, not of spans. A construct with no offsets
is placed instead by `locateFirstNonBlankLine`, which returns the whole line
minus leading spaces and tabs, so a located construct inside a container does
include the marker: the source `"> -"` gives `list[0,3]`, ``"> ```"`` gives
`codeBlock[0,5]`, and `"> ##"` gives `heading[0,4]` — each span covering the
container marker as well as the construct. Pre-existing, and unchanged by the
located-line work below.

Constructs with no text (a thematic break, an empty heading or list item)
arrive with no offsets. The decoder places them at the first non-blank line at
or after everything decoded so far — and "so far" is measured from each node's
*widened* span, not from the content range it was reported with. A fenced code
block's content stops at the last code character while its span runs to the
closing fence, so a cursor advanced from the content range put the next
unanchored construct on the closing-fence line, inside the block above it.

The located line is then passed to the widener with a flag saying so, because
two wideners assume the span they get is CONTENT. `widenHeading` probes for a
setext underline when it finds no `#` run before the span — true of an empty
`##`, which is not a setext heading, so `> ##` swallowed the `-` on the next
line and dragged the blockquote over a list outside it. `widenCodeBlock` looks
for the opening fence on the line ABOVE the span, which is right when md4c
reported the code (one line below the fence) and wrong for an empty fence,
whose located line IS the fence: a closed `` ```js `` block followed by a bare
`` ``` `` gave the second block the FIRST one's closing fence. Both wideners
skip that step when the span was located.

Tests assert over the whole CommonMark corpus that no span escapes its parent
and none leaves the source bounds. Two span-invariant defects sit outside what
those sweeps reach, both pre-existing. A pipe-less continuation row in a GFM
table gets a zero-width padding cell for its missing column —
`"| a | b |\n| - | - |\n| 1 | 2 |\nx\n"` gives `tableRow[30,31]` holding
`tableCell[30,31]` = `"x"` and `tableCell[31,31]` = `""`, and `MAY_BE_EMPTY`
in `spans.test.ts` does not list `tableCell`, so it counts as a violation
under the repo's own checker. And a located thematic break inside a blockquote
leaves the quote zero-width: `> ***` gives `blockquote[0,0]` wrapping
`thematicBreak[0,0]`.

## Decoder hot paths

The decoder is 38 to 51% of a parse ([BENCHMARKS.md](BENCHMARKS.md), measured
by `npm run bench:crossing` on a laptop) and runs on Hermes, with no JIT. Four
paths are written for that:

- `utf8Decode`'s ASCII path builds strings in 4096-unit chunks through
  `String.fromCharCode.apply`, since Hermes does not guarantee `TextDecoder`.
- `skipLinkTail` scans with `charCodeAt`. It went from 16% of decode to 8%
  (2026-08-25 measurement).
- `trimSpanEnd`, `isAsciiPunctuationChar`, `widenDisplayMath` and
  `locateFirstNonBlankLine` no longer run a regex per character.
  `locateFirstNonBlankLine` keeps `trim()`, because Unicode whitespace is the
  contract there.
- `onText` materializes an event's text only in the branches that consume it
  (`textOf`). Line breaks are the most common text event in prose and discard
  it, so building a string for every event spent most of that work on strings
  nothing read.

No on-device number yet.

## Behaviours that look like bugs and are not

- **`html: 'strip'` parses, then drops.** md4c always parses HTML; the decoder
  skips the nodes under `'strip'`. `MD_FLAG_NOHTML` would change block
  structure and move every span after it, so `html` stays a rendering choice.
  Skipping a node takes its content with it: an HTML *block* — a `<div>`, a
  `<details>`, a raw `<table>` — contributes nothing at all, and its text
  never reaches the reader. The one exception is an inline `<br>`, in any of
  its forms (`<br/>`, `<br />`, `<BR>`, `<br class="x">`): under `'strip'` it
  decodes to a `hardBreak` spanning exactly the tag, because dropping it
  joined the surrounding words with no separator and a GFM table cell has no
  other way to break a line. `<brand>` and every other tag still vanish;
  `html: 'raw'` is unchanged. The branch is `P.TextKind.Html` in
  `src/engine/native/decode.ts`, with `isHtmlLineBreak` next to
  `locateLiteral`.
- **A text node's `value` can differ from its source slice, in a closed list
  of ways.** A backslash escape drops its backslash, `&amp;` becomes `&`, NUL
  becomes U+FFFD, and `smartPunctuation` adds the four `cmark --smart`
  rewrites. The fifth is by far the largest: a link or image whose destination
  the URL policy rejects degrades to a text node carrying the flattened label
  or alt, while its span still covers the whole construct — under
  `presets.llmChat`, `[ab](ftp://e.com)` is `value: "ab"` over a
  17-character slice, with no backslash and no `&` anywhere in it. An angle
  autolink degrades the same way (`<ftp://e.com/path>` → `"ftp://e.com/path"`);
  under `urlPolicy.blockedLinks: 'node'` an inline link keeps its node
  instead, so autolinks and images always degrade — `blockedLinks` governs
  inline links only, and a blocked image degrades to its alt text under
  either setting. The span covers the raw source in every case, so selecting
  `&amp;` copies the five typed characters and
  copying a blocked link reproduces the markdown that was written. A value is
  never longer than its slice.
  `src/engine/native/__tests__/spans.test.ts` asserts both over all 652
  examples plus the streaming fixtures, with a blocked-destination corpus
  entry whose exemption is itself asserted to be non-vacuous.
- **`extensions.underline` repurposes `_`.** Underscore emphasis and strong
  become `underline`; `*` is untouched. `__x__` is two nested `underline`
  nodes. Pinned in `src/engine/native/__tests__/underline.test.ts`.
- **One CommonMark example fails.** Spec example 174, an HTML block left
  unclosed inside a blockquote. `npm run conformance` lists it in
  `conformance/report-native.json` under `failingExamples`.

## Building and testing in Node

The test path is a Node-API addon over the same C++ in `native/node/`
([native/node/README.md](../native/node/README.md)). Without it, every block
that needs a parser reports itself skipped rather than passing empty
(`describeNative`); 23 of the 46 suites hold at least one.

```sh
node scripts/build-node-addon.mjs   # → build/selectable-markdown.<platform>-<arch>.node (gitignored)
npm run conformance                 # 651/652; writes conformance/report-native.json
npx jest src/engine/native          # 6 suites: protocol parity, host binding, documents,
                                    # span properties, underline, smart punctuation
npm run bench:all                   # throughput, pathological, streaming replay, crossing,
                                    # projection
```

None take an `--engine` flag; it is refused with an explanation.

## Using it in an app

Autolinking picks up the podspec and the Android source directory. The module
does not install itself. It exposes one blocking synchronous method that must
run on the JS thread (invariants in `platform/cpp/SelectableMarkdownJsi.h`), and
`installNativeEngine()` is the caller. Call it once at startup so the crossing
happens off the render path and a missing module is a boolean rather than an
exception out of a screen. Otherwise `nativeEngine` installs on the first parse.

```ts
import { parseDocument, installNativeEngine } from 'react-native-selectable-markdown';

// Once, at startup. Idempotent, never throws, returns a boolean.
if (!installNativeEngine()) {
  // md4c is not reachable from this JS context. Nothing will parse markdown here.
}

const doc = parseDocument(source, options); // uses nativeEngine
```

`isNativeEngineAvailable()` answers the same question and installs on demand.
It reads the global first and memoizes a success, and it memoizes a refusal
the platform reports as permanent too — JavaScriptCore, whose runtime cannot
back an `ArrayBuffer` with a `jsi::MutableBuffer`, or a native module that
will not load — so neither re-crosses the bridge and the native warning prints
once instead of once per call. What is still retried is what should be: a
platform that is not ready yet (the bridge still starting, a reload in flight)
and a host with no native module at all, where the per-call cost is a cached
`require` and nothing logs. Polling from a render path is safe. A
protocol-version mismatch is a third final state: the binding is on the
global, so nothing re-crosses, and the warning prints once per JS context.

Two contract details sit behind that. The native `install()` returns
`'installed' | 'unavailable' | 'refused'` rather than a boolean; an older
binary's `true`/`false` is still accepted, and its `false` reads as the
transient `'unavailable'`. And `isNativeEnginePermanentlyRefused()` answers
"has the platform said not-ever", for an app that would rather show "rebuild
required" than a spinner — it is false in the ordinary no-native-module case,
which is a module that never answers rather than one that refuses.

`false` from either availability call means this JS context cannot parse
markdown at all, not that a slower path is taken.

## When nothing renders

At startup, the failure is a log line and `false` from `installNativeEngine()`
(`RCTLogWarn` on iOS, `Log.w` on Android; a protocol mismatch is a
`console.warn` from JS). Nothing throws there, because no error boundary exists
yet. At the first non-empty parse, `nativeEngine` throws and names the fix. An
empty source never touches the binding, so a screen that only renders `''`
looks fine until real content arrives.

Fastest fix first:

1. **Rebuild the app, not just the bundle.** `npx pod-install`, then a fresh
   `run-ios` or `run-android`. Metro cannot link native code.
2. **Read the warning for a protocol version.** A binding whose
   `protocolVersion` differs from the bundle's is refused; the warning names
   both numbers. Stale binary, fresh bundle: rebuild.
3. **Confirm the runtime can host the binding.** JavaScriptCore cannot back an
   `ArrayBuffer` with a `jsi::MutableBuffer`, so the installer refuses it. Expo
   Go and web have no module to install. Enable Hermes, or supply your own
   `Engine`. The refusal is a *probe* — the installer attempts a
   MutableBuffer-backed `ArrayBuffer` — and not a version test, so a runtime
   that grows a working `createArrayBuffer` simply passes and gets the
   binding. The JSCRuntime source behind the claim was read on 0.73 through
   0.81 and has not been re-read at the `>= 0.82` peer floor, where Hermes is
   the default and JSC is opt-in; the same wording is in
   `platform/cpp/SelectableMarkdownJsi.h` and
   `platform/ios/SelectableMarkdownModule.mm`, so keep the three in step.
   Read this step as a diagnosis for an app that deliberately turned Hermes
   off.
4. **In Node**, build the addon, then either wrap its `parse` with
   `createNativeEngine` and pass the result as `parseDocument`'s third
   argument, or hand that same `parse` to `__linkNativeEngine` so the default
   engine resolves on its own. `__linkNativeEngine` is a harness lever and is
   no longer exported from the package root: reach it at
   `react-native-selectable-markdown/dist/engine/native`, a deep path with no
   stability promise.

If none apply, pass your own parser: `parseDocument(source, options, myEngine)`.
The one hard requirement is spans: every node carries UTF-16 `[start, end)`
offsets into the exact source it was handed. See
[Writing an engine](ARCHITECTURE.md#writing-an-engine).
