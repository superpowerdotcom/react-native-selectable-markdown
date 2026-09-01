# react-native-selectable-markdown

Markdown rendering for React Native, built for streamed LLM output, with selection that works like a document. Adjacent paragraphs, headings, lists, code blocks and tables merge into one selectable run, and every selected character maps back to an exact UTF-16 range of the source. Copy gives you the markdown itself.

Parsing is done by [md4c](https://github.com/mity/md4c), compiled into your app. There is no JavaScript parser, so nothing renders until the app is rebuilt with the native module linked (see [Native setup](#native-setup)). You can swap in your own parser through the `Engine` interface. MIT licensed.

## Why

- A React Native selection lives inside one native text view. Render a document as one `<Text>` per block and selection stops at every block, and copy returns display text with no way back to the markdown.
- Reparsing a whole message per token renders half-finished syntax: `**bold` flashes as asterisks, and a `---` line briefly turns the paragraph above it into a heading.
- Model output is untrusted. `$5` should not become math, and a stray `|` should not become a table or a spoiler.

The fix for all three is a `SourceSpan` on every parsed node. Selection, copy, memoization and incremental streaming all work from that span.

## Features

- Selection across adjacent blocks. Code blocks, tables and rules flow through runs too, with their boxes and rules painted as decorations under the text. A run ends at an image, a spoiler, or a block you mark standalone.
- Copy Text and Copy Markdown in the selection menu. The second is an exact source slice.
- Streaming without artifacts. The unsettled tail is repaired before parsing, settled blocks keep referential identity, and plain-prose deltas skip the parser. Per-frame coalescing and a typewriter smoother are opt-in.
- Safe defaults for model output. Every non-CommonMark extension is opt-in, HTML is stripped, URL schemes are allowlisted.
- 651/652 on the CommonMark 0.31.2 spec suite, run in CI, plus a streaming oracle that checks every prefix of every fixture against a fresh parse.
- A replaceable parser. `parseDocument(source, options, engine)` and the `engine` prop take any `{ name, parse }` ([Writing an engine](docs/ARCHITECTURE.md#writing-an-engine)).

## Install

```bash
npm install react-native-selectable-markdown
```

Other ways in: a pinned commit (`npm install github:superpowerdotcom/react-native-selectable-markdown#<sha>`, rebuilds on every install), a tarball from the [releases page](https://github.com/superpowerdotcom/react-native-selectable-markdown/releases) (prebuilt), or a local checkout (`npm install file:../react-native-selectable-markdown`; `file:` deps are symlinked, so run `npm run build -- --watch` in the checkout yourself). `dist/` is never committed; `prepare` builds it for the npm and git paths.

### Native setup

The parser and the selection host are both native. Nothing renders until the app is rebuilt with them linked.

1. **Link.** Autolinking picks up the podspec and the Android module through `react-native.config.js`. Run `cd ios && pod install`; Android needs a Gradle sync. The Android build needs the `com.facebook.react` Gradle plugin, which template apps already apply.
2. **Rebuild.** A JS reload does not link native code. Expo Go cannot load it; use a development build (`npx expo prebuild && npx expo run:ios`) or EAS Build.
3. **Call `installNativeEngine()` at startup.** It returns `false` instead of throwing when the module is missing, and it refuses to install on JavaScriptCore (its JSI cannot create an `ArrayBuffer`; Hermes is fine). `false` means this JS context cannot parse markdown until the module is linked or you pass your own engine.

```ts
import { installNativeEngine } from 'react-native-selectable-markdown';

if (!installNativeEngine()) {
  console.warn('markdown parser unavailable: rebuild the app with the native module linked');
}
```

Without the module, `parseDocument` throws on the first non-empty document, and so does `<SelectableMarkdown>` during render; wrap it in an error boundary if that is a state your app can be in. `RunHost`, the selection host, throws where its Fabric component is not registered (Expo Go, web, test renderers). It ships as a Fabric component only, matching the `react-native >= 0.82` peer floor. `use_frameworks! :linkage => :dynamic` disables registration of all third-party Fabric components with no error, this one included.

Where native code cannot run at all, everything above the parser is plain TypeScript and still works. Pass your own `Engine`; its one hard requirement is a `SourceSpan` on every node, with UTF-16 offsets into exactly the source it was handed.

## Quick start

### Static

```tsx
import { SelectableMarkdown, presets } from 'react-native-selectable-markdown';

export function Message({ markdown }: { markdown: string }) {
  return (
    <SelectableMarkdown
      source={markdown}
      options={presets.llmChat}
      selectionActions={['copy-text', 'copy-markdown']} // the default; system Copy always stays
      onSelectionCopy={({ action, plain, markdown, span }) => {
        // action: which item was tapped. plain: the selected display text.
        // markdown: exact source slice. span: UTF-16 range into the source.
      }}
    />
  );
}
```

`selectionActions` and `onSelectionCopy` work as a pair. Setting one without the other yields an empty custom menu.

### Streaming

```tsx
import { StreamSession, SelectableMarkdown, presets } from 'react-native-selectable-markdown';

const session = new StreamSession({ options: presets.llmChat });
session.append('The answer is **42');   // renders as bold, no literal ** flash
session.append('**, because');
session.finalize('end');                 // or 'aborted' | 'failed'; idempotent

<SelectableMarkdown session={session} />;
```

`append` parses synchronously. For tokens that arrive faster than frames, `appendBuffered(delta)` coalesces them into one flush per frame. `flushBuffered()` drains now, and any synchronous call (`append`, `replace`, `finalize`) drains first.

```ts
new StreamSession({
  holdBackChars?: number;   // default 0: keep the last N chars pending so `**bo` never renders half-typed
  holdIdleMs?: number;      // default 250: flush held-back chars after this much silence
  smoother?: Smoother;      // meter the release ("typewriter"), see below
  repair?: RepairOptions;   // hideUriLikeLabels, hideBareUriSchemes: hide URI-shaped tails while they grow
  bufferScheduler?: BufferScheduler; idleScheduler?: IdleScheduler; now?: () => number; // injectable for tests
});
```

A `Smoother` decides how many UTF-16 units each flush releases, and the session keeps flushing until the buffer drains. `createSmoother({ charsPerSecond, boundary, maxLagChars })` is a fixed rate. `createAdaptiveSmoother()` is what we use for live LLM streams: it tracks the arrival rate, trails the head by a target lag, and drains against a bounded deadline at run end (call `session.notifyRunFinalized()`; the ag-ui binding does this for you). Await `session.drained()` before `finalize` so the tail finishes typing. `session.rewrite(full)` edits text the reader has not seen yet without interrupting the reveal. Details in [docs/STREAMING.md](docs/STREAMING.md).

```ts
import { StreamSession, createSmoother } from 'react-native-selectable-markdown';

const session = new StreamSession({
  smoother: createSmoother({ charsPerSecond: 300, boundary: 'word', maxLagChars: 400 }),
});
// ...append tokens...
await session.drained();
session.finalize();
```

### ag-ui

The adapter takes a structural event type. There is no dependency on ag-ui packages.

```tsx
import { useAgUiSession, SelectableMarkdown, presets } from 'react-native-selectable-markdown';
import type { TextMessageEvents } from 'react-native-selectable-markdown';

function AssistantMessage(props: { events: TextMessageEvents; messageId: string }) {
  const session = useAgUiSession(props.events, props.messageId, presets.llmChat);
  return <SelectableMarkdown session={session} />;
}
```

The session finalizes on message end and on run finished or failed, since an aborted stream never sends END. For a transport that owns a whole run, `bindRunTextEvents(events, store, policy?)` and its hook `useAgUiRunSessions(events, init?)` manage per-message sessions: they seed pre-existing messages without re-typing, route new ones through `appendBuffered`, and report `holding: true` until every smoother has drained at run end. Policy fields are documented on `RunBindingPolicy`.

### Headless

```ts
import { parseDocument, presets, visit } from 'react-native-selectable-markdown';

const doc = parseDocument('# Hello *world*', presets.llmChat);
visit(doc, (node) => { /* node.span = { start, end } into doc.source */ });
```

In plain Node, import deep paths (`dist/engine/Engine`, `dist/stream/StreamSession`, ...), since the package root re-exports `react-native`. Parsing there still needs an engine; md4c is native. See [docs/NATIVE.md](docs/NATIVE.md).

## Theming

```tsx
import type { PartialTheme } from 'react-native-selectable-markdown';

const theme: PartialTheme = {
  colors: { text: '#101418', link: '#0B6E6A', codeBackground: '#F1F3F6' },
  fonts:  { baseSize: 16, lineHeight: 1.5, family: 'Inter' },
  spacing: { blockGap: 14, listIndent: 20 },
};

<SelectableMarkdown source={md} theme={theme} colorScheme="auto" />
```

Overrides merge one level deep over a base theme. The groups are `colors`, `fonts`, `spacing`, `code`, `quote`, `table`, `headings`, `rule` and `glyphs`. `colorScheme` is `'light'`, `'dark'` or `'auto'` (the default; follows the system). `mergeTheme(overrides, base)` computes a theme ahead of render. `glyphs` (bullet and task markers) are part of the projected text, so changing them shifts selection offsets; the library handles that.

To style one mark rather than a construct (a heading ramp, a bold face instead of a weight bump), pass `attributeForMark`. Give it a stable identity; it takes part in the per-run memo.

```tsx
import type { MarkAttribute } from 'react-native-selectable-markdown';

const attributeForMark: MarkAttribute = (mark) =>
  mark.kind === 'heading' && mark.level === 1
    ? { fontFamily: 'Tiempos-Bold', fontSize: 28, lineHeight: 34 }
    : undefined; // fall through to the theme
```

Known divergence: standalone blocks approximate list indentation with spaces inside `<Text>` and ignore `spacing.listIndent`. Native runs get a real hanging indent.

## Defaults for model output

No options (or `presets.commonmark`) is pure CommonMark. Use `presets.llmChat` for model output. `presets.everything` turns on every extension, spoilers included; don't feed it untrusted text.

| Option | Default | `llmChat` | Notes |
| --- | --- | --- | --- |
| `tables`, `strikethrough`, `tasklists`, `autolinks` | off | on | The GFM extensions. |
| `math` | off | off | `$5 and $10` must never become math. |
| `spoilers` | off | off | On only in `everything`. Parses only a balanced `\|\|x\|\|` inside one paragraph or heading; a stray `\|` stays text. |
| `underline` | off | off | `_` stops meaning emphasis. On only in `everything`. |
| `smartPunctuation` | off | off | Smart quotes and dashes in prose only; code and URLs stay byte-exact. On in `everything`. |
| `html` | `'strip'` | `'strip'` | `'raw'` keeps it. |
| Link schemes | `https:`, `http:`, `mailto:` | same | Anything else renders as plain text, not a dead link. Your list replaces this one; spread `DEFAULT_LINK_PREFIXES` to keep it. |
| Image schemes | `https:` | same | Blocked images render their alt text. |
| `urlPolicy.blockedLinks` | `'text'` | `'text'` | `'node'` keeps a blocked link as a `blocked: true` node for your renderer. Never navigable. |

### Custom link schemes

The allowlist runs at parse time, so `[1](#citation-1)` or `[record](fhir://...)` collapse into plain text by default. Two ways to keep them:

- If the destination should open, add its prefix: `urlPolicy: { linkPrefixes: [...DEFAULT_LINK_PREFIXES, 'tel:'] }`.
- If it is an in-app identifier, set `blockedLinks: 'node'` and render it yourself. Nothing you don't claim can navigate.

```tsx
import { defaultRenderers } from 'react-native-selectable-markdown';
import type { EngineOptions, RendererOverrides } from 'react-native-selectable-markdown';

// Keep the annotation, or TS widens 'node' to string.
const options: EngineOptions = { urlPolicy: { blockedLinks: 'node' } };

const renderers: RendererOverrides = {
  link: (node, ctx) => {
    const m = node.blocked ? /-citation-(\d+)$/.exec(node.href) : null;
    return m ? <CitationPill number={Number(m[1])} /> : defaultRenderers.link(node, ctx);
  },
};
```

Inside a selection run, links are native tappable ranges and the `link` renderer does not run. Taps arrive at `onLinkPress({ href, blocked, start, end })`. Without a handler, live links open through `Linking.openURL` and blocked ones do nothing.

`classifyBlock` marks a block `'standalone'` so it gets its own selection scope and renderer. Use it for blocks that own a competing gesture. Images and spoilers are standalone already. Give it a stable identity; the document is resegmented when it changes.

```tsx
import type { ClassifyBlock } from 'react-native-selectable-markdown';

const classifyBlock: ClassifyBlock = (node) =>
  node.kind === 'link' && /^cards:/.test(node.href) ? 'standalone' : undefined;
```

## Architecture

```
markdown source
      │
      ▼
engine (md4c, or your own) ──► ParsedDocument: a SourceSpan on every node
      │
      ▼
stream layer: settled-prefix tracking + tail repair
      │
      ▼
selection runs: adjacent flowing blocks merged, projected to display text + decorations
      │
      ▼
native host (UITextView / TextView), required
      │
      ▼
selection offsets ──► mapSelectionToSource ──► exact source span ──► copy payload
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): pipeline, module map, the `Engine` interface, writing an engine.
- [docs/STREAMING.md](docs/STREAMING.md): session lifecycle, incremental parsing, tail repair, pacing.
- [docs/SELECTION.md](docs/SELECTION.md): the JS/native host contract.
- [docs/NATIVE.md](docs/NATIVE.md): the md4c binding, wire format, troubleshooting.
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) and [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measurements, cost model, roadmap.
- [docs/FABRIC-PLAN.md](docs/FABRIC-PLAN.md): design retrospective of the new-architecture port.

## Status (0.10.x)

| Area | Where it stands |
| --- | --- |
| Parser | md4c, 651/652 on CommonMark 0.31.2 (the one failure is example 174, an unclosed HTML block inside a blockquote). The only parser; throws where not linked. |
| Streaming | Incremental tail-only parsing, checked by a prefix oracle. Coalescing, holdback, smoothers. A 147-case tail-repair corpus. |
| Selection and copy | Exact source ranges, property-tested. Code blocks, tables and rules flow through runs; images and spoilers are standalone. |
| Copy menu | Copy Text and Copy Markdown. Custom items need iOS 16+; iOS 13.4 to 15 gets the system menu only. |
| Selection host | Fabric only (`react-native >= 0.82`). CI compiles the C++ against real renderer headers and the Swift against the iOS SDK, but there is no example app yet, so on-device behaviour is reviewed rather than exercised. |
| Android selection preservation | Not implemented, and the largest known gap. Each streamed text swap drops the selection. iOS preserves it. |
| Benchmarks | Node harnesses in `bench/`. On-device numbers are planned. |
| Example app | Planned. |

## Benchmarks

Measured 2026-09-01 on an Apple M2 Max with an arm64 Node 22, from the harnesses in `bench/`. Markdown-to-HTML over a 289 kB spec-derived corpus, one fresh process per library, all in the same run: this package 15.8 MB/s, commonmark.js 10.0, marked 9.4, markdown-it 6.2. The number for this package includes building the span-carrying AST and serializing it to HTML. Streaming appends parse at most 277 characters regardless of stream length and cost about 2.7 µs each end to end. These are V8 numbers; on Hermes the JS decode (43 to 53% of a parse) will be slower. Methodology and full tables in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Contributing

```bash
npm test                 # needs a C++ toolchain: Jest reaches md4c through a Node addon
npm run typecheck
npm run conformance      # CommonMark score, written to conformance/report-native.json
npm run bench:all
npm run verify:pack      # the packed tarball loads
npm run check:codegen && npm run check:fabric-cpp && npm run check:swift
```

Without a compiler the native suites report as skipped, not passed. CI builds the addon as a hard gate. See [native/node/README.md](native/node/README.md).

## Prior art

One idea learned from each:

- [vercel/streamdown](https://github.com/vercel/streamdown): repair the unsettled tail before parsing.
- [tanstack/markdown](https://github.com/tanstack/markdown): every streamed prefix must equal a fresh parse.
- [software-mansion/enriched-markdown](https://github.com/software-mansion/enriched-markdown): a block's chrome inside one native text view.
- [bluesky-social/react-native-uitextview](https://github.com/bluesky-social/react-native-uitextview): a UITextView host that preserves selection across updates.
- [Expensify/react-native-live-markdown](https://github.com/Expensify/react-native-live-markdown): decorate a native text component rather than replace it.
- [react-native-markdown-display](https://github.com/iamacup/react-native-markdown-display): per-node overrides and style-token theming.
- [gmsgowtham/react-native-marked](https://github.com/gmsgowtham/react-native-marked): a flat sequence of native blocks.
- [mientjan/react-native-markdown-renderer](https://github.com/mientjan/react-native-markdown-renderer): the original override model.
- [mity/md4c](https://github.com/mity/md4c): the parser.
- [ag-ui](https://github.com/ag-ui-protocol/ag-ui): the streaming event shapes the adapter follows.

## License

MIT © 2026 Superpower. See [LICENSE](LICENSE).
