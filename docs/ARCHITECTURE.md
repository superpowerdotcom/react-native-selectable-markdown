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
   entities.ts, urlPolicy.ts     fallback entity decode + URL policy
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
                   standalone blocks (unclaimed image, spoiler, a classifyBlock claim) -> block renderers,
                     nesting capped at MAX_RENDER_DEPTH (64); deeper subtrees render flat text
                   per-run memoization keyed on span + settled identity
   v
onSelectionCopy({ action, plain, markdown, span })   <- selection offsets (UTF-16) from the host
```

Pacing (`appendBuffered`, holdback, smoothers) sits in front of the stream layer and feeds the same `append` path, so nothing below it knows coalescing exists. The stream layer sits in front of the engine: tail repair is a text-to-text transform, and the constructs it completes are CommonMark's. Selection never touches the render tree; it maps display offsets to source spans through the piece map, and the React tree is only a projection.

## Three rules the design follows

### 1. Source spans are mandatory

Every node carries a `SourceSpan`: UTF-16 `start`/`end` offsets into the original source, end-exclusive, such that `source.slice(span.start, span.end)` is exactly the construct's source. Four things are built on it:

- Selection maps display offsets back to source offsets through spans.
- Copy is `source.slice(span)`. No serializer that could drift from the source.
- Memoization identity for rendered blocks is keyed on spans.
- Incremental streaming works because settled blocks' spans, and so their identities, are stable across snapshots.

An engine that cannot produce exact spans cannot back this library. Span correctness is asserted in tests.

### 2. Streaming is incremental, not a re-render loop

`StreamSession` owns the accumulated text. After each parse it finds a safe anchor: the end of the last block no future append can change. Each append reparses only `source.slice(anchor)`, rebases the spans (`shiftSpans`, a deep clone), and splices the frozen prefix back in by reference. Settled blocks keep referential identity, so an untouched settled run re-renders zero times and the one run that absorbs a newly settled block re-renders once per settle; parse cost tracks the tail rather than the document. A plain-prose delta skips the engine and extends the trailing paragraph. When nothing can anchor yet (one giant list, an unclosed fence), the update falls back to a correct full reparse.

Before each parse, `repairTail` virtually completes unfinished constructs (`**bold`, `[link](https://…`) and suppresses lines that would flip earlier structure (a lone `-` about to make a setext heading). On `finalize` the repairs vanish and the document is a plain parse of exactly what arrived. A prefix oracle asserts at every prefix of every fixture that the spliced snapshot equals a fresh parse. Details in [STREAMING.md](STREAMING.md).

### 3. Safe defaults for text you don't control

Every non-CommonMark extension is opt-in (`ExtensionFlags`, all false by default). A stray `|` in model output must not change how a paragraph renders, so `||…||` is off in every preset except `everything`, and even then only balanced pairs parse.

HTML is stripped by default (`html: 'strip'`), which drops the construct *and* the text inside it: an HTML block contributes nothing to the document. The one exception is an inline `<br>`, which decodes to a `hardBreak` over the tag rather than vanishing between two words. URL schemes are allowlisted (links: `https://`, `http://`, `mailto:`; images: `https://`). `nativeEngine`'s decoder applies the allowlist as it builds each node, so *that* engine can never return a rejected `href` and no renderer can forget; `parseDocument` runs no policy pass over a substituted engine's output, so the view checks again at the navigation boundary — `openUrl` sanitizes and re-tests every href against the document's resolved `urlPolicy.linkPrefixes` before `Linking.openURL`, on the renderer path and the native-run press path alike. Matching folds case over the scheme and authority only, and a consumer prefix that reaches into a path (`myapp://checkout/`) is treated as a scope: a destination that walks back out of it with `..` (raw or percent-encoded once) is refused. Blocked links degrade to plain text, blocked images to their alt text.

A blocked link leaves no node behind, so an app whose model emits in-app identifiers as links cannot render them. `urlPolicy.blockedLinks: 'node'` keeps the node, flagged `blocked: true`. Inside a flowing run that node projects as a `blockedLink` mark and your `link` renderer does not run — renderers draw standalone blocks only. The channels that reach it there are `attributeForMark`, `onLinkPress` and `embed`; `classifyBlock: 'standalone'` is what puts the block back on the renderer path. The href still never reaches `openURL` on any of them. Autolinks and images stay outside this — `blockedLinks` governs inline links only: an autolink's text is its destination, so there is no label to keep, and a blocked image degrades to its alt text under either setting.

## Module map

```
src/
  index.ts                 public API barrel: explicit named exports, internals stay on deep paths
  document/
    span.ts                SourceSpan + span algebra (length/contains/intersects/slice)
    nodes.ts               Block/Inline unions, ParsedDocument, type guards
    visit.ts               visit() pre-order traversal, findAt() offset -> node path
  engine/
    Engine.ts              Engine interface + parseDocument()
    options.ts             ExtensionFlags, EngineOptions, resolveOptions, presets
    entities.ts            fallback entity decoding for the decoder's Entity case (internal)
    urlPolicy.ts           sanitizeUrl + isUrlAllowed, applied at parse time, re-checked at press
    htmlSubset.ts          applyHtmlSubset(): the html: { allow } post-parse transform
    links.ts               extractLinks(): the links of a parse, policy applied
    namedEntities.ts       the HTML5 entity table behind entities.ts
    native.ts              re-export facade for the md4c engine
    native/                md4c binding: protocol.ts, decode.ts, widen.ts, install.ts, index.ts
    extensions/spoilers.ts applySpoilers(): opt-in post-parse ||…|| transform
  stream/
    StreamSession.ts       lifecycle, settled tracking, snapshots, subscribe
    repair.ts              repairTail()/seedFromSettled(): pure tail repair
    shiftSpans.ts          span rebasing for the incremental splice
    smoothing.ts           createSmoother()/createAdaptiveSmoother()
    placeholders.ts        trimTrailingPlaceholders()
    clusters.ts            grapheme-cluster boundaries, so a release cut never splits a glyph
  selection/
    runs.ts                segmentRuns(), classifyTopLevelBlock() -> RunSegment[]
                           (classification memoized on block identity; runs break at
                           DEFAULT_MAX_RUN_CHARS; `liveTail` keeps the streaming tail
                           in a run of its own)
    mapSelection.ts        projectRun() (incremental through `previous`), mapSelectionToSource()
    copy.ts                buildCopyPayload(): span -> { markdown, plain }
  view/
    SelectableMarkdown.tsx the component
    RunHost.tsx            native host wrapper; throws where the component is not linked
    SelectableRunHostNativeComponent.ts  codegen spec: the one JS/native prop and event contract
    runAttributes.ts       marks + theme -> RunTextAttribute[] for the host
    runDecorations.ts      marks + theme -> block chrome the host paints
    runPressables.ts       link marks -> tappable ranges the host hit-tests
    runEmbeds.ts           embed entries -> RunEmbed[] the host reserves space from
    imageEmbeds.ts         withImageEmbeds(): the built-in image embed claim behind `images`
    codeBlocks.tsx         withCodeBlockCards(): the codeBlocks="card" claim and its Copy button
    runPresentation.ts     presentPressables()/resolveChips()/resolveRunHighlights(): pressable
                           labels, chip boxes and highlight ranges for the host
    blockSpacing.ts        resolveRunSpacing(): theme.blocks margins as run decorations
    selectionTracking.ts   the live-selection reducer behind onSelectionChange/getSelection
    projectionCache.ts     createRunProjectionCache(): incremental projectRun per run
    processedColors.ts     memoizedProcessColor(): the bounded, evicting processColor memo
    runIdentity.ts         runKey()/embedRectKey(): identities that survive a settle
    selectionRange.ts      mapSourceToRunRange(): SourceSpan -> a run's display range;
                           selectSpanInRuns(): the document-level setSelection walk
    selectionActions.ts    handleSelectionAction(): menu event -> onSelectionCopy payload
    theme.ts               grouped tokens, mergeTheme, defaultTheme/defaultDarkTheme
    renderers.tsx          default per-kind renderers + override types + the MAX_RENDER_DEPTH cap
  agui/
    useAgUiSession.ts      adapter for one known message (no ag-ui dependency)
    bindRunTextEvents.ts   run-scoped binding over per-message sessions

platform/
  cpp/       OffsetParser (md4c SAX -> offset nodes), Protocol.h + FlatBuffer.cpp,
             SelectableMarkdownJsi (installs the parse global), vendor/md4c
  fabric/    shared Fabric C++: measuring shadow node, state, descriptor, measurer facade,
             android-include/ (the three codegen headers Android's CMake shadows)
  ios/       UITextView host, Fabric component view, iOS measurer, JSI installer
android/     TextView host + ViewManager, CMake/JNI glue, JSI installer. At the package root
             because RN's Gradle plugin looks for package.json one directory up.
native/node/ Node-API harness over the same C++ for tests and benches; ships behind the
             ./node entry and builds on first import, and nothing in src/ imports it
conformance/ CommonMark runner, streaming prefix oracle, projection oracle, fixtures
bench/       Node benchmarks
scripts/     build-node-addon (builds the Node harness), emit-dist-spec-shim (the codegen
             spec's dist stub), clean-dist / finish-esm-build (the two builds), check-codegen /
             check-fabric-cpp / check-swift, verify-pack, release, changelog-section,
             check-lock-sync / check-unreleased-breaking (release preflight), generate-entities
docs/        this file and its siblings
SelectableMarkdown.podspec, react-native.config.js   what autolinking reads; both ship
```

Dependencies point downward: `document` depends on nothing; `engine` on `document`; `stream` on both; `selection` on `document` and `engine` (plus one `import type` from `view/theme`); `view` on all of the above; `agui` on `stream` (plus the `EngineOptions` type from `engine`). Nothing in `src/` imports from `platform/`.

`index.ts` names every export one at a time instead of re-exporting modules wholesale, so the surface is a decision rather than a consequence of where a helper happens to live. It publishes the document model plus its span algebra (`visit`, `findAt`, `childrenOf`, `isBlock`/`isInline`, `spanLength` and friends); `parseDocument`, the `Engine` type, `resolveOptions`/`withOptions`/`presets`, `DEFAULT_LINK_PREFIXES`/`DEFAULT_IMAGE_PREFIXES`/`DEFAULT_MAX_SOURCE_LENGTH`, `sanitizeUrl`/`isUrlAllowed`, `applySpoilers`, and the native quartet `nativeEngine`/`createNativeEngine`/`installNativeEngine`/`isNativeEngineAvailable` (with `isNativeEngineInstalled` and `isNativeEnginePermanentlyRefused` for diagnostics); `StreamSession`, `createSmoother`/`createAdaptiveSmoother`/`snapPastLinkDestination`, `repairTail`/`seedFromSettled`/`continueSeed`, `trimTrailingPlaceholders`; `segmentRuns`/`classifyTopLevelBlock`/`DEFAULT_MAX_RUN_CHARS`, `projectRun`/`mapSelectionToSource`/`EMBED_PLACEHOLDER`, `buildCopyPayload`; the ag-ui adapters; and the view layer — `SelectableMarkdown`, `RunHost`, the theme, the renderers with `openUrl`/`textContentOf`/`MAX_RENDER_DEPTH`, the selection-action helpers, and the per-channel resolvers a consumer driving `RunHost` itself needs (`resolveRunAttributes`, `resolveRunPressables`, `resolveRunDecorations`, `resolveRunEmbeds`, `withImageEmbeds`, `createRunProjectionCache`, `mapSourceToRunRange`). What it deliberately does not publish stays reachable one directory in: the flat-buffer decoder and `__linkNativeEngine` at `dist/engine/native`, the selection-menu wire codec at `dist/view/selectionActions`.

One file is build input rather than runtime code. React Native's codegen and babel plugin read `SelectableRunHostNativeComponent.ts` and only match `codegenNativeComponent<…>` in the original source; a `tsc`-transpiled copy yields no view config, the component never registers, and `RunHost` throws for every run. So `package.json` points Metro at `src/index.ts`, `tsconfig.build.json` excludes the file from emit, `RunHost` reaches it through a call-expression `require` (an `import type` would defeat the exclusion), and `npm run check:codegen` asserts the generated C++ still matches.

## Engine interface

```ts
export interface Engine {
  readonly name: string;
  parse(source: string, options: ResolvedEngineOptions): ParsedDocument;
}
```

That is the whole contract. `parseDocument(source, options?, engine?)` resolves options, refuses a source longer than `maxSourceLength` with a `RangeError`, calls the engine (`nativeEngine` by default), applies the `html: { allow }` transform when one is set, and applies the spoiler transform if `extensions.spoilers` is true. Nothing else validates or normalizes the result: whatever the engine returns is the document, spans included. Both transforms run after the parse on purpose, so no engine carries always-on non-CommonMark syntax and the opt-ins behave the same under a substituted parser.

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

Four rules, each a way a real engine goes wrong:

1. **`source` is the string you were handed.** Copy, selection and streaming all slice that string by the spans below it. Returning a trimmed or normalized source breaks all three.
2. **Spans are absolute UTF-16 offsets into that string.** `match.index` is what makes the paragraph above selectable. Per-chunk offsets like `{ start: 0, end: match[0].length }` render fine and copy the wrong text from the second paragraph on. Nothing checks this for you.
3. **Node kinds are a fixed vocabulary.** `Block` and `Inline` are discriminated unions from `src/document/nodes.ts`: `paragraph`, `heading`, `codeBlock`, `blockquote`, `list`, `listItem`, `table`, `tableRow`, `tableCell`, `thematicBreak`, `htmlBlock`; `text`, `emphasis`, `strong`, `strikethrough`, `underline`, `codeSpan`, `link`, `image`, `autolink`, `hardBreak`, `softBreak`, `math`, `spoiler`, `htmlSpan`. The type checker rejects anything else, and `RendererMap` is a mapped type over `AnyNode['kind']`, so a missing renderer is a compile error.
4. **The stream layer speaks CommonMark, not your dialect.** `StreamSession` never hands you the tail as it arrived. `repairTail` (`src/stream/repair.ts`) appends virtual CommonMark closers (`**bold` parses as `**bold**`) and suppresses a bare trailing construct line that would flip the structure above it (a lone `-` about to make a setext heading), and there is no switch that turns it off. The parse-free fast path calls you at all only when a delta holds one of the characters in `CONSTRUCT_CHARS` (`src/stream/StreamSession.ts`) or ends in a space or tab, so an engine whose own construct characters are not a subset of that class — a `@mention` engine, say — shows stale structure until an unrelated construct character happens to arrive. An engine that is not parsing CommonMark is better driven by parsing the accumulated text yourself than through `StreamSession`.

The second parameter is `ResolvedEngineOptions`, with every default filled in. Honouring the flags is optional; the span invariant is not. `options.urlPolicy` in particular is yours to apply: nothing between `parseDocument` and the view re-filters a node's `href` (the one exception is the `<a href>` node the `html: { allow }` transform creates, which it runs through `linkPrefixes` itself), and the view's press-time re-check is a backstop for navigation only, not for the hrefs your own UI reads off a node.

### The engine that ships

`nativeEngine` (`src/engine/native/`) is md4c, vendored in `platform/cpp/`, driven by `OffsetParser` and encoded into one `ArrayBuffer` per parse. It scores 651/652 (99.85%) on CommonMark 0.31.2; the one failure is example 174, an HTML block left unclosed inside a blockquote. It runs in React Native with the module linked and in Node through the test addon. Where neither is present, the first non-empty `parseDocument` throws an error naming the missing build step.

The engine is two halves that meet at the buffer. Which half owns a decision is fixed:

| | C++ (`platform/cpp/`, before the crossing) | TypeScript (`src/engine/native/`, after it) |
| --- | --- | --- |
| Structure | md4c decides blocks, inlines and GFM extensions | Replays the events; never re-decides structure |
| Offsets | md4c's UTF-8 byte offsets to UTF-16 in `FlatBuffer.cpp`, the one conversion point (`OffsetParser.cpp` only builds the map) | Widens content ranges into construct spans (`widen.ts`) |
| Text | No source *slice* crosses: prose is offsets. Values that are not slices do, in the string table — hrefs, titles, info strings, decoded entities, the U+FFFD standing in for a NUL, and the text md4c synthesizes rather than points at: the `"\n"` it reports for every break and every code- or HTML-block line, which is the largest class, collapsed to one entry per consecutive run by `SaxState::intern` | Text nodes are sliced from the JS source except for those string-table values; escaped runs re-widened and smart punctuation applied here |
| Policy | None | URL allowlist and HTML strip/raw, applied while the node is built |
| Extensions | md4c flags for GFM, math and underline; never spoilers | Spoilers, opt-in, after the engine returns |

No source slice crosses, so cost tracks structure rather than length. What stays in JavaScript is escape re-widening, smart punctuation and policy: text values are slices of the JS string, and the allowlist has to run where the node is built so `nativeEngine` can never return a rejected `href` — the view checks a second time at the press, which is what extends the guarantee to a substituted engine. Entity decoding is not on this side: md4c ships the HTML5 table, so it decodes both prose entities and the ones inside an attribute, and `entities.ts` is left holding the decoder's defensive fallback. It and `urlPolicy.ts` sit at the engine root, not inside `native/`, because they describe the document model; `urlPolicy` is exported from the package entry so a substituted engine reuses the allowlist instead of reimplementing it. Wire format and decoder details are in [NATIVE.md](NATIVE.md).

### Headless use from Node

The package entry re-exports the view layer and so imports `react-native`, which plain Node cannot load. Import the deep paths instead: `dist/engine/Engine.js`, `dist/engine/options.js`, `dist/engine/native/index.js`, `dist/stream/StreamSession.js`, `dist/selection/*.js`, `dist/document/*.js`. Parsing still needs md4c, which under Node means the test addon in `native/node/`; see [NATIVE.md](NATIVE.md). Those are declared subpath exports, not a reach past the package's front door: `package.json`'s `exports` map publishes `./dist/*` both with and without the `.js`, plus an explicit `./dist` entry for the bare directory. Each of those entries carries both conditions — `require` → `./dist/*.js` with types `./dist/*.d.ts`, `import` → `./dist/esm/*.js` with types `./dist/esm/*.d.ts`. The ES modules are the same sources emitted by `tsconfig.esm.json` (`module: es2020`) and finished by `scripts/finish-esm-build.mjs`, which writes `dist/esm/package.json` (`"type": "module"`, `sideEffects: false`) and adds the `.js` extension Node's ESM resolver needs on every relative specifier. They carry no stability promise.

One caveat on the deep paths: two modules reach the platform through a call-expression `require` — `react-native` in `src/engine/native/install.ts`, the codegen spec in `src/view/RunHost.tsx` — and `require` does not exist in an ES module scope. That is why `require` is listed ahead of `import` there, so a resolver asserting both (Metro) stays on the CommonJS tree; both calls sit in a `try`/`catch` and degrade the way a web bundle already does.
