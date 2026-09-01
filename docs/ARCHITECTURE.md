# Architecture

How the pieces fit: the pipeline, the three rules every module follows, the module map, and the `Engine` interface. Streaming internals are in [STREAMING.md](STREAMING.md), the native host contract in [SELECTION.md](SELECTION.md), the md4c binding in [NATIVE.md](NATIVE.md), numbers in [BENCHMARKS.md](BENCHMARKS.md) and [PERFORMANCE.md](PERFORMANCE.md).

## Pipeline

```
markdown source (static string, or accumulated stream text)
   |
   |  streaming only
   +--> stream/StreamSession
   |      settled-prefix tracking; repairTail(tail, seed, options)
   |      parse input = settled prefix + repaired tail
   v
engine/            Engine interface: the pluggable parser
   native/         md4c behind one ArrayBuffer per parse (default, and the only parser)
   entities.ts, urlPolicy.ts     shared decode + URL policy
   extensions/spoilers.ts        opt-in post-parse transform
   v
document/          ParsedDocument; every node: { kind, span: SourceSpan }
                   invariant: source.slice(span.start, span.end) is the construct's exact source
   v
selection/         segmentRuns: adjacent flowing blocks -> selectable runs
                   projectRun: run -> display text + piece map
                   mapSelectionToSource: display offsets -> SourceSpan
                   buildCopyPayload: span -> { markdown, plain }
   v
view/              SelectableMarkdown
                   runs -> RunHost (native SelectableRunHost; required, throws where not linked)
                   standalone blocks (classifyBlock) -> block renderers
                   per-run memoization keyed on span + settled identity
   v
onSelectionCopy({ action, plain, markdown, span })   <- selection offsets (UTF-16) from the host
```

Pacing (`appendBuffered`, holdback, smoothers) sits in front of the stream layer and feeds the same `append` path, so nothing below it knows coalescing exists. The stream layer sits in front of the engine: tail repair is a text-to-text transform, so any engine gets artifact-free streaming for free. Selection never touches the render tree; it maps display offsets to source spans through the piece map, and the React tree is only a projection.

## Three rules the design follows

### 1. Source spans are mandatory

Every node carries a `SourceSpan`: UTF-16 `start`/`end` offsets into the original source, end-exclusive, such that `source.slice(span.start, span.end)` is exactly the construct's source. Four things are built on it:

- Selection maps display offsets back to source offsets through spans.
- Copy is `source.slice(span)`. No serializer that could drift from the source.
- Memoization identity for rendered blocks is keyed on spans.
- Incremental streaming works because settled blocks' spans, and so their identities, are stable across snapshots.

An engine that cannot produce exact spans cannot back this library. Span correctness is asserted in tests.

### 2. Streaming is incremental, not a re-render loop

`StreamSession` owns the accumulated text. After each parse it finds a safe anchor: the end of the last block no future append can change. Each append reparses only `source.slice(anchor)`, rebases the spans (`shiftSpans`, a deep clone), and splices the frozen prefix back in by reference. Settled blocks keep referential identity, so settled runs never re-render, and parse cost tracks the tail rather than the document. A plain-prose delta skips the engine and extends the trailing paragraph. When nothing can anchor yet (one giant list, an unclosed fence), the update falls back to a correct full reparse.

Before each parse, `repairTail` virtually completes unfinished constructs (`**bold`, `[link](https://…`) and suppresses lines that would flip earlier structure (a lone `-` about to make a setext heading). On `finalize` the repairs vanish and the document is a plain parse of exactly what arrived. A prefix oracle asserts at every prefix of every fixture that the spliced snapshot equals a fresh parse. Details in [STREAMING.md](STREAMING.md).

### 3. Safe defaults for text you don't control

Every non-CommonMark extension is opt-in (`ExtensionFlags`, all false by default). A stray `|` in model output must not change how a paragraph renders, so `||…||` is off in every preset except `everything`, and even then only balanced pairs parse.

HTML is stripped by default (`html: 'strip'`). URL schemes are allowlisted (links: `https://`, `http://`, `mailto:`; images: `https://`) at parse time, so no renderer can forget. Blocked links degrade to plain text, blocked images to their alt text.

A blocked link leaves no node behind, so an app whose model emits in-app identifiers as links cannot render them. `urlPolicy.blockedLinks: 'node'` keeps the node, flagged `blocked: true`, for your `link` renderer. The href still never reaches `openURL`. Autolinks stay outside this: their text is their destination, so there is no label to keep.

## Module map

```
src/
  index.ts                 public API barrel
  document/
    span.ts                SourceSpan + span algebra (length/contains/intersects/slice)
    nodes.ts               Block/Inline unions, ParsedDocument, type guards
    visit.ts               visit() pre-order traversal, findAt() offset -> node path
  engine/
    Engine.ts              Engine interface + parseDocument()
    options.ts             ExtensionFlags, EngineOptions, resolveOptions, presets
    entities.ts            entity/escape decoding for hrefs, titles, info strings (internal)
    urlPolicy.ts           sanitizeUrl + isUrlAllowed, applied at parse time (internal)
    native.ts              re-export facade for the md4c engine
    native/                md4c binding: protocol.ts, decode.ts, widen.ts, install.ts, index.ts
    extensions/spoilers.ts applySpoilers(): opt-in post-parse ||…|| transform
  stream/
    StreamSession.ts       lifecycle, settled tracking, snapshots, subscribe
    repair.ts              repairTail()/seedFromSettled(): pure tail repair
    shiftSpans.ts          span rebasing for the incremental splice
    smoothing.ts           createSmoother()/createAdaptiveSmoother()
    placeholders.ts        trimTrailingPlaceholders()
  selection/
    runs.ts                segmentRuns(), classifyBlock() -> RunSegment[]
    mapSelection.ts        projectRun(), mapSelectionToSource()
    copy.ts                buildCopyPayload(): span -> { markdown, plain }
  view/
    SelectableMarkdown.tsx the component
    RunHost.tsx            native host wrapper; throws where the component is not linked
    SelectableRunHostNativeComponent.ts  codegen spec: the one JS/native prop and event contract
    runAttributes.ts       marks + theme -> RunTextAttribute[] for the host
    runDecorations.ts      marks + theme -> block chrome the host paints
    runPressables.ts       link marks -> tappable ranges the host hit-tests
    selectionActions.ts    handleSelectionAction(): menu event -> onSelectionCopy payload
    theme.ts               grouped tokens, mergeTheme, defaultTheme/defaultDarkTheme
    renderers.tsx          default per-kind renderers + override types
  agui/
    useAgUiSession.ts      adapter for one known message (no ag-ui dependency)
    bindRunTextEvents.ts   run-scoped binding over per-message sessions

platform/
  cpp/       OffsetParser (md4c SAX -> offset nodes), Protocol.h + FlatBuffer.cpp,
             SelectableMarkdownJsi (installs the parse global), vendor/md4c
  fabric/    shared Fabric C++: measuring shadow node, state, descriptor, measurer facade
  ios/       UITextView host, Fabric component view, iOS measurer, JSI installer
android/     TextView host + ViewManager, CMake/JNI glue, JSI installer. At the package root
             because RN's Gradle plugin looks for package.json one directory up.
native/node/ Node-API harness over the same C++ for tests and benches (never shipped)
conformance/ CommonMark runner, streaming prefix oracle, projection oracle, fixtures
bench/       Node benchmarks
```

Dependencies point downward: `document` depends on nothing; `engine` on `document`; `stream` on both; `selection` on `document` and `engine`; `view` on all of the above; `agui` on `stream` (plus the `EngineOptions` type from `engine`). Nothing in `src/` imports from `platform/`.

One file is build input rather than runtime code. React Native's codegen and babel plugin read `SelectableRunHostNativeComponent.ts` and only match `codegenNativeComponent<…>` in the original source; a `tsc`-transpiled copy yields no view config, the component never registers, and `RunHost` throws for every run. So `package.json` points Metro at `src/index.ts`, `tsconfig.build.json` excludes the file from emit, `RunHost` reaches it through a call-expression `require` (an `import type` would defeat the exclusion), and `npm run check:codegen` asserts the generated C++ still matches.

## Engine interface

```ts
export interface Engine {
  readonly name: string;
  parse(source: string, options: ResolvedEngineOptions): ParsedDocument;
}
```

That is the whole contract. `parseDocument(source, options?, engine?)` resolves options, calls the engine (`nativeEngine` by default), and applies the spoiler transform if `extensions.spoilers` is true. Nothing validates or normalizes the result: whatever the engine returns is the document, spans included. Spoilers run after the parse on purpose, so no engine carries always-on non-CommonMark syntax and the opt-in behaves the same under a substituted parser.

The third argument is the supported way to bring your own parser.

### Writing an engine

A parser that treats each blank-line-separated chunk as one paragraph of literal text:

```ts
import { parseDocument } from 'react-native-selectable-markdown';
import type { Engine, ParsedDocument } from 'react-native-selectable-markdown';

export const plainTextEngine: Engine = {
  name: 'plain-text',
  parse(source): ParsedDocument {
    const blocks = [];
    // Emit one paragraph per chunk, carrying the offsets the chunk was
    // found at, not offsets into the chunk.
    for (const match of source.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
      const span = { start: match.index, end: match.index + match[0].length };
      blocks.push({
        kind: 'paragraph' as const,
        span,
        children: [{ kind: 'text' as const, value: match[0], span }],
      });
    }
    return { source, blocks };
  },
};

parseDocument(md, undefined, plainTextEngine);
// or: <SelectableMarkdown source={md} engine={plainTextEngine} />
```

Three rules, each a way a real engine goes wrong:

1. **`source` is the string you were handed.** Copy, selection and streaming all slice that string by the spans below it. Returning a trimmed or normalized source breaks all three.
2. **Spans are absolute UTF-16 offsets into that string.** `match.index` is what makes the paragraph above selectable. Per-chunk offsets like `{ start: 0, end: match[0].length }` render fine and copy the wrong text from the second paragraph on. Nothing checks this for you.
3. **Node kinds are a fixed vocabulary.** `Block` and `Inline` are discriminated unions from `src/document/nodes.ts`: `paragraph`, `heading`, `codeBlock`, `blockquote`, `list`, `listItem`, `table`, `tableRow`, `tableCell`, `thematicBreak`, `htmlBlock`; `text`, `emphasis`, `strong`, `strikethrough`, `underline`, `codeSpan`, `link`, `image`, `autolink`, `hardBreak`, `softBreak`, `math`, `spoiler`, `htmlSpan`. The type checker rejects anything else, and `RendererMap` is a mapped type over `AnyNode['kind']`, so a missing renderer is a compile error.

The second parameter is `ResolvedEngineOptions`, with every default filled in. Honouring the flags is optional; the span invariant is not.

### The engine that ships

`nativeEngine` (`src/engine/native/`) is md4c, vendored in `platform/cpp/`, driven by `OffsetParser` and encoded into one `ArrayBuffer` per parse. It scores 651/652 (99.85%) on CommonMark 0.31.2; the one failure is example 174, an HTML block left unclosed inside a blockquote. It runs in React Native with the module linked and in Node through the test addon. Where neither is present, the first non-empty `parseDocument` throws an error naming the missing build step.

The engine is two halves that meet at the buffer. Which half owns a decision is fixed:

| | C++ (`platform/cpp/`, before the crossing) | TypeScript (`src/engine/native/`, after it) |
| --- | --- | --- |
| Structure | md4c decides blocks, inlines and GFM extensions | Replays the events; never re-decides structure |
| Offsets | md4c's UTF-8 byte offsets to UTF-16, the one conversion point | Widens content ranges into construct spans (`widen.ts`) |
| Text | None crosses. Events carry offsets, not characters | Text nodes are slices of the source string JS already holds |
| Policy | None | URL allowlist and HTML strip/raw, applied while the node is built |
| Extensions | md4c flags for GFM, math and underline; never spoilers | Spoilers, opt-in, after the engine returns |

No source text crosses, so cost tracks structure rather than length. Decoding and policy stay in JavaScript because text values are slices of the JS string, and the allowlist has to run where the node is built so `parseDocument` can never return a rejected `href`. `entities.ts` and `urlPolicy.ts` sit at the engine root, not inside `native/`, because they describe the document model; a substituted engine can deep-import them instead of reimplementing the allowlist. Wire format and decoder details are in [NATIVE.md](NATIVE.md).

### Headless use from Node

The package entry re-exports the view layer and so imports `react-native`, which plain Node cannot load. Import the deep paths instead: `dist/engine/Engine.js`, `dist/engine/options.js`, `dist/engine/native/index.js`, `dist/stream/StreamSession.js`, `dist/selection/*.js`, `dist/document/*.js`. Parsing still needs md4c, which under Node means the test addon in `native/node/`; see [NATIVE.md](NATIVE.md). A dedicated Node subpath export is a roadmap item.
