# The native md4c engine

md4c, vendored C behind one flat buffer per parse, is the package's only
parser. `parseDocument` uses `nativeEngine` when you pass no engine. Where the
compiled module is not linked, parsing throws instead of degrading; the way
out is your own `Engine` ([Writing an engine](ARCHITECTURE.md#writing-an-engine)).

Pipeline: [ARCHITECTURE.md](ARCHITECTURE.md). Streaming (tail repair runs in
front of the engine, which never sees a prefix): [STREAMING.md](STREAMING.md).
Numbers: [BENCHMARKS.md](BENCHMARKS.md).

## Why native

md4c scores 651/652 (99.85%) on CommonMark 0.31.2 (`npm run conformance`),
every section at 100% except HTML blocks at 43/44. Link reference definitions,
all seven HTML block forms, tabs and destination edge cases come with it.
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

Four properties the pipeline depends on:

1. **Offsets are UTF-16 code units.** `FlatBuffer.cpp` converts md4c's byte
   offsets through a byte→UTF-16 map and drops the map (four bytes per source
   byte). No UTF-8 arithmetic exists above the encoder. `buildUtf16OffsetMap`
   in `OffsetParser.cpp` tests 8 ASCII bytes at a time and goes byte-wise only
   for non-ASCII runs. `protocolVersion` is still 1.
2. **No source text is in the buffer.** Text events carry offsets. The string
   table holds only values that are not source slices: hrefs, titles, info
   strings, decoded entities, and the rare text md4c synthesizes.
3. **Event ranges are content ranges.** `**bold**` reports `bold`. Widening is
   the decoder's job.
4. **Little-endian, 4-byte aligned, one allocation.** Fields are written byte
   by byte, so the format is an ABI. The magic word is the runtime check.

## Who owns what

| Decision | Where | Why |
| --- | --- | --- |
| Block/inline structure, GFM extensions | C++ (md4c) | Re-deciding structure in JS is how dialects drift |
| Byte→UTF-16 conversion | C++ (`FlatBuffer.cpp`) | One conversion point |
| Entity decoding in text | C++ (`OffsetParser.cpp`) | md4c ships the ~2100-name table; a JS copy would outweigh the decoder |
| Escapes in hrefs, titles, info strings | TS (`src/engine/entities.ts`) | String values, not source ranges; `decodeRawString` resolves backslash escapes and entities |
| Span widening | TS (`widen.ts`) | Needs the source string |
| Text values, smart punctuation | TS (`decode.ts`) | Text is sliced from the JS source |
| URL allowlist, HTML strip/raw | TS (`decode.ts`, rules in `src/engine/urlPolicy.ts`) | Applied while the node is built, so no renderer can forget it. Pinned by `src/engine/urlPolicy.test.ts` |
| Spoilers (`\|\|…\|\|`) | TS, opt-in post-parse | The native wrapper has no spoiler flag; nothing native can enable non-CommonMark syntax |

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

Constructs with no text (a thematic break, an empty heading or list item)
arrive with no offsets. The decoder places them at the first non-blank line at
or after everything decoded so far.

Tests assert over the whole CommonMark corpus that no span escapes its parent
and none leaves the source bounds.

## Decoder hot paths

The decoder is 43 to 53% of a parse ([BENCHMARKS.md](BENCHMARKS.md)) and runs
on Hermes, with no JIT. Three loops are written for that:

- `utf8Decode`'s ASCII path builds strings in 4096-unit chunks through
  `String.fromCharCode.apply`, since Hermes does not guarantee `TextDecoder`.
- `skipLinkTail` scans with `charCodeAt`. It went from 16% of decode to 8%
  (2026-08-25 measurement).
- `trimSpanEnd`, `isAsciiPunctuationChar`, `widenDisplayMath` and
  `locateFirstNonBlankLine` no longer run a regex per character.
  `locateFirstNonBlankLine` keeps `trim()`, because Unicode whitespace is the
  contract there.

No on-device number yet.

## Behaviours that look like bugs and are not

- **`html: 'strip'` parses, then drops.** md4c always parses HTML; the decoder
  skips the nodes under `'strip'`. `MD_FLAG_NOHTML` would change block
  structure and move every span after it, so `html` stays a rendering choice.
- **A text node's `value` can differ from its source slice, in a closed list
  of ways.** A backslash escape drops its backslash, `&amp;` becomes `&`, NUL
  becomes U+FFFD, and `smartPunctuation` adds the four `cmark --smart`
  rewrites. The span covers the raw source, so selecting `&amp;` copies the
  five typed characters. A value is never longer than its slice.
  `src/engine/native/__tests__/spans.test.ts` asserts both over all 652
  examples plus the streaming fixtures.
- **`extensions.underline` repurposes `_`.** Underscore emphasis and strong
  become `underline`; `*` is untouched. `__x__` is two nested `underline`
  nodes. Pinned in `src/engine/native/__tests__/underline.test.ts`.
- **One CommonMark example fails.** Spec example 174, an HTML block left
  unclosed inside a blockquote. `npm run conformance` lists it in
  `conformance/report-native.json` under `failingExamples`.

## Building and testing in Node

The test path is a Node-API addon over the same C++ in `native/node/`
([native/node/README.md](../native/node/README.md)). Without it, every Jest
suite that parses markdown skips itself (19 of 31).

```sh
node scripts/build-node-addon.mjs   # → build/selectable-markdown.<platform>-<arch>.node (gitignored)
npm run conformance                 # 651/652; writes conformance/report-native.json
npx jest src/engine/native          # 6 suites: protocol parity, host binding, documents,
                                    # span properties, underline, smart punctuation
npm run bench:all                   # throughput, pathological, streaming replay, crossing
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

`isNativeEngineAvailable()` answers the same question and installs on demand;
it reads the global first, so it is cheap to call repeatedly. `false` from
either means this JS context cannot parse markdown at all, not that a slower
path is taken.

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
   `Engine`.
4. **In Node**, build the addon, then wrap its `parse` with
   `createNativeEngine` or hand it to `__linkNativeEngine` so the default
   engine resolves.

If none apply, pass your own parser: `parseDocument(source, options, myEngine)`.
The one hard requirement is spans: every node carries UTF-16 `[start, end)`
offsets into the exact source it was handed. See
[Writing an engine](ARCHITECTURE.md#writing-an-engine).
