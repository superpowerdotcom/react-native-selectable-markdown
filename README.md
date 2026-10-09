# react-native-selectable-markdown

Markdown rendering for React Native, built for streamed LLM output, with selection that works like a document. Adjacent paragraphs, headings, lists, code blocks and tables merge into one selectable run, and every selected character maps back to an exact UTF-16 range of the source. Copy gives you the markdown itself: the exact source slice, syntax included for any construct the selection covers in full.

Parsing is done by [md4c](https://github.com/mity/md4c), compiled into your app. There is no JavaScript parser, so nothing renders until the app is rebuilt with the native module linked (see [Native setup](#native-setup)). You can swap in your own parser through the `Engine` interface. MIT licensed.

## Why

- A React Native selection lives inside one native text view. Render a document as one `<Text>` per block and selection stops at every block, and copy returns display text with no way back to the markdown.
- Reparsing a whole message per token renders half-finished syntax: `**bold` flashes as asterisks, and a `---` line briefly turns the paragraph above it into a heading.
- Model output is untrusted. `$5` should not become math, and a stray `|` should not become a table or a spoiler.

The fix for all three is a `SourceSpan` on every parsed node. Selection, copy, memoization and incremental streaming all work from that span.

## Features

- Selection across adjacent blocks. Code blocks, tables and rules flow through runs too, with their boxes and rules painted as decorations under the text. Images flow as embeds: the host reserves space on the line and the image renderer draws over it. A run ends at a whole block — the list or the table, not just the construct — that holds a spoiler, an image nothing claimed, or a node you mark standalone. Merging also stops at `maxRunChars` (a prop; 8000 source characters by default, `Infinity` opts out), which only ever breaks between top-level blocks.
- Copy Text and Copy Markdown in the selection menu. The second is an exact source slice. Both are retitleable from JS, and your own menu items report back the same way.
- An imperative selection API. `onSelectionChange` reports the live selection as an exact source span, including when it goes away, and a ref gives you `getSelection()`, `clearSelection()` and `setSelection(span)`.
- Streaming without artifacts. The unsettled tail is repaired before parsing, settled blocks keep referential identity, and plain-prose deltas skip the parser. Per-frame coalescing and a typewriter smoother are opt-in.
- Safe defaults for model output. Every non-CommonMark extension is opt-in, HTML is stripped, URL schemes are allowlisted.
- 651/652 on the CommonMark 0.31.2 spec suite, run in CI, plus a streaming oracle that checks every prefix of every fixture against a fresh parse.
- A replaceable parser. `parseDocument(source, options, engine)` and the `engine` prop take any `{ name, parse }` ([Writing an engine](docs/ARCHITECTURE.md#writing-an-engine)).

## Install

```bash
npm install react-native-selectable-markdown
```

Other ways in: a pinned commit (`npm install github:superpowerdotcom/react-native-selectable-markdown#<sha>`, rebuilds on every install), a tarball from the [releases page](https://github.com/superpowerdotcom/react-native-selectable-markdown/releases) (prebuilt), or a local checkout (`npm install file:../react-native-selectable-markdown`; `file:` deps are symlinked, so run `npm run build:watch` in the checkout yourself — Metro takes the `react-native` condition straight to `src/`, so the watch build only matters for bundlers that resolve `main`). `dist/` is never committed; `prepare` builds it for the npm and git paths. What changed per version is in [CHANGELOG.md](CHANGELOG.md).

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

Without the module, `parseDocument` throws on the first non-empty document, and so does `<SelectableMarkdown>` during render; wrap it in an error boundary if that is a state your app can be in. `RunHost`, the selection host, throws where its Fabric component is not registered (Expo Go, web, test renderers). It ships as a Fabric component only, matching the `react-native >= 0.82` peer floor. Registration comes from this package's `codegenConfig.ios.componentProvider`: it puts a `SelectableRunHost` entry in the app's generated `RCTThirdPartyComponentsProvider.mm`, and the component is looked up by name from there — which is what the throw message tells you to check.

Where native code cannot run at all, everything above the parser is plain TypeScript and still works. Pass your own `Engine`; its one hard requirement is a `SourceSpan` on every node, with UTF-16 offsets into exactly the source it was handed. Streaming is the one layer that assumes CommonMark on top of that: tail repair appends virtual closers and suppresses ambiguous tail lines before the engine sees them, and the parse-free fast path keys on CommonMark's construct characters, so a delta that only opens syntax of your own renders as stale text until the next construct character arrives.

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
        // The items only report. Write the clipboard here, e.g.
        // Clipboard.setString(action === 'copy-markdown' ? markdown : plain).
      }}
    />
  );
}
```

`selectionActions` needs `onSelectionCopy`: with no handler the custom menu is empty rather than one item short, because an item that reports nowhere is not offered (DEV warns). Neither built-in item writes the clipboard itself: the handler does, with whichever clipboard module the app already uses. The reverse is not true — a handler on its own is the common case and gets both default items. An entry may also be `{ id, title }`, which is the one way to localise both platforms from JS; any id beyond the two built-ins is your own action and must carry a title, and it arrives at `onSelectionCopy` with the same `plain`, `markdown` and `span`. A `session` supersedes `source`, which is then never parsed (DEV warns).

For a toolbar of your own, `onSelectionChange` reports `{ span, plain }` as the user drags and `null` when the selection goes away — the half `onSelectionCopy` cannot give you, since it fires only after a menu item is tapped. A `ref` typed `SelectableMarkdownHandle` adds `getSelection()`, `clearSelection()` and `setSelection(span)`. `setSelection` returns `false` for two kinds of refusal: no run shows the span (past the end of the document, a standalone block, a span of pure markup like a fence or a `# `, a run not mounted yet), or the run that shows it cannot take a selection right now (Android's unsettled streaming tail, a run rendered `selectable={false}`, a binary built against a native spec older than the selection commands). It can select wider than asked when the span lands inside an entity, an image's alt text or an embed placeholder, and it presents no menu and issues no scroll — there is no scroll-to-span, though it does take focus, which a scrolling ancestor is entitled to react to. Full contract in [docs/SELECTION.md](docs/SELECTION.md).

### Streaming

```tsx
import { StreamSession, SelectableMarkdown, presets } from 'react-native-selectable-markdown';

const session = new StreamSession({ options: presets.llmChat });
session.append('The answer is **42');   // renders as bold, no literal ** flash
session.append('**, because');
session.finalize('end');                 // or 'aborted' | 'failed'; idempotent

<SelectableMarkdown session={session} />;
```

`append` parses synchronously. For tokens that arrive faster than frames, `appendBuffered(delta)` coalesces them into one flush per frame. `flushBuffered()` drains now, and any synchronous call (`append`, `replace`, `finalize`) drains first. `dispose()` cancels the scheduled flush and the idle drain, drops the un-appended tail and clears subscribers — call it for a session dropped before its stream ends, after `flushBuffered()` if the tail should be kept.

```ts
new StreamSession({
  holdBackChars?: number;   // default 0: keep the last N chars pending so `**bo` never renders half-typed
  holdIdleMs?: number;      // default 250: flush held-back chars after this much silence
  smoother?: Smoother;      // meter the release ("typewriter"), see below
  repair?: RepairOptions;   // hideUriLikeLabels, hideBareUriSchemes: hide URI-shaped tails while they grow
  bufferScheduler?: BufferScheduler; idleScheduler?: IdleScheduler; now?: () => number; // injectable for tests
});
```

A `Smoother` decides how many UTF-16 units each flush releases, and the session keeps flushing until the buffer drains. Only scheduled `appendBuffered` flushes are smoothed: `append`, `flushBuffered`, `replace` and `finalize` drain synchronously and release everything, so a session driven by `append` alone never consults the smoother and `drained()` resolves immediately. `createSmoother({ charsPerSecond, boundary, maxLagChars })` is a fixed rate; `boundary: 'word'` needs whitespace to cut at, so text written without spaces (Chinese, Japanese, Thai) wants `boundary: 'char'`. `createAdaptiveSmoother()` is what we use for live LLM streams: it tracks the arrival rate, trails the head by a target lag, and drains against a bounded deadline at run end (call `session.notifyRunFinalized()`, a no-op with nothing pending; `bindRunTextEvents` and `useAgUiRunSessions` do it for you). Await `session.drained()` before `finalize` so the tail finishes typing, and handle its rejection: a buffered drain the engine keeps refusing runs out its retry ladder (eight retries, about 20 s at the default `holdIdleMs`) and rejects every waiter with the engine's own error. Nothing is dropped — the text stays buffered, `pendingLength` still counts it, and an explicit `flushBuffered`, `append`, `replace` or `finalize` retries it. `session.rewrite(full)` edits text the reader has not seen yet without interrupting the reveal. Details in [docs/STREAMING.md](docs/STREAMING.md).

```ts
import { StreamSession, createSmoother } from 'react-native-selectable-markdown';

const session = new StreamSession({
  smoother: createSmoother({ charsPerSecond: 300, boundary: 'word', maxLagChars: 400 }),
});
for (const token of tokens) session.appendBuffered(token); // buffered, not append
await session.drained().catch(() => {}); // rejects if the engine gave up on the buffered tail
session.finalize();                      // an explicit drain retries the held text
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

The session finalizes on message end and on run finished or failed, since an aborted stream never sends END; a `messageId` switch settles the outgoing session as `'aborted'` rather than stranding it mid-stream, and it stays in the hook's map, so switching back shows the settled document. The third argument is either bare parse options, as above, or a full session init — `{ engine, options, coalesce, smoother, holdBackChars, holdIdleMs, repair, bufferScheduler, idleScheduler, now }`, where `smoother` is a factory because there is one session per messageId. Each delta commits on its own unless the init carries a buffering field (`smoother`, `holdBackChars`, `holdIdleMs`, either scheduler) or an explicit `coalesce: true`; `repair` and `now` deliberately do not switch coalescing on. Every field is latched when a messageId's session is created, so changing the init later reaches the next new message, not the one already streaming. What the per-message adapter does not do is hold at run end: neither `useAgUiSession` nor `bindMessageEvents` calls `notifyRunFinalized`, so run end finalizes straight through a metered tail — a smoothed reveal commits the rest in one revision instead of playing it out.

For a transport that owns a whole run, `bindRunTextEvents(events, store, policy?)` and its hook `useAgUiRunSessions(events, init?)` (the same session fields except `coalesce`, which its buffering fields imply, plus `policy`) manage per-message sessions: they seed pre-existing messages without re-typing, route new ones through `appendBuffered`, and report `holding: true` until every smoother has drained at run end. Policy fields are documented on `RunBindingPolicy`. The three run-lifecycle callbacks take an optional trailing `runId`; pass it when the transport has one, and `bindRunTextEvents` ignores a late run finished or failed from a run it already watched go spent. An id stops being spent the moment that run starts again — announce a retry that reuses it with `onRunStarted` and it keeps its right to finalize — and `onAttached` catch-up clears the spent-run memory outright, since nothing learned before a gap the binding cannot see into is trustworthy. `bindMessageEvents` observes no run start and filters nothing.

### Headless

```ts
import { parseDocument, presets, visit } from 'react-native-selectable-markdown';

const doc = parseDocument('# Hello *world*', presets.llmChat);
visit(doc, (node) => { /* node.span = { start, end } into doc.source */ });
```

In plain Node, import the `engine` and `stream` subpaths (`react-native-selectable-markdown/engine`, `react-native-selectable-markdown/stream`) or deep paths (`dist/engine/Engine`, `dist/stream/StreamSession`, ...), since the package root re-exports the React Native view layer, which imports `react-native` at load time. Those paths are declared in the `exports` map, which serves two builds: `require` takes the CommonJS tree in `dist/`, `import` takes an ES module build in `dist/esm`, and Metro's `react-native` condition still wins and still points at `src/index.ts`. The ESM build is what lets webpack, Rollup and Vite tree-shake per export rather than only drop a module nothing imports (`sideEffects: false` is declared in both package.json files, because bundlers read it from the nearest one). Types resolve under both conditions — `dist/*.d.ts` for `require`, `dist/esm/*.d.ts` for `import` — `react-native-selectable-markdown/dist`, the bare directory, resolves under both, and `npm run verify:pack` resolves *and* imports each documented deep path through both conditions out of the packed tarball. Parsing there still needs an engine; md4c is native. See [docs/NATIVE.md](docs/NATIVE.md).

## Theming

```tsx
import type { PartialTheme } from 'react-native-selectable-markdown';

const theme: PartialTheme = {
  colors: { text: '#101418', link: '#0B6E6A', codeBackground: '#F1F3F6' },
  fonts:  { baseSize: 16, lineHeight: 1.5, body: 'Inter' },
  spacing: { blockGap: 14, listIndent: 20 },
};

<SelectableMarkdown source={md} theme={theme} colorScheme="auto" />
```

Overrides merge one level deep over a base theme. The groups are `colors`, `fonts`, `spacing`, `code`, `quote`, `table`, `headings`, `rule`, `glyphs`, `blocks`, `list`, `link` and `html`. `colorScheme` is `'light'`, `'dark'` or `'auto'` (the default; follows the system). `mergeTheme(overrides, base)` computes a theme ahead of render. `glyphs` (bullet and task markers) are part of the projected text, so changing them shifts selection offsets; the library handles that. The font keys are `body`, `mono`, `baseSize`, `lineHeight`, `strongWeight` and the optional `strongFamily`; an unknown token is ignored, with a DEV warning. Four tokens also cross groups, each only when the token it feeds is not itself overridden: `code.borderRadius` feeds `table.borderRadius` (squaring your code blocks squares your tables), and the deprecated `spacing.quoteIndent`, `spacing.tableCellPadding` and `colors.quoteBar` feed `quote.indent`, `table.cellPaddingH`/`cellPaddingV` and `quote.barColor`.

To style one mark rather than a construct (a heading ramp, a bold face instead of a weight bump), pass `attributeForMark`. Give it a stable identity; it takes part in the per-run memo.

```tsx
import type { MarkAttribute } from 'react-native-selectable-markdown';

const attributeForMark: MarkAttribute = (mark) =>
  mark.kind === 'heading' && mark.level === 1
    ? { fontFamily: 'Tiempos-Bold', fontSize: 28, lineHeight: 34 }
    : undefined; // fall through to the theme
```

### Designed documents

Every token below reaches both render paths, native runs and standalone blocks:

```tsx
const theme: PartialTheme = {
  // Web-style margins, collapsed between neighbours and measured from box
  // edges. Unset, a run keeps its one blank line between blocks.
  blocks: {
    paragraph: { before: 10, after: 10 },
    heading: { before: 24, after: 8 },
    list: { before: 8, after: 8 },
    rule: { before: 16, after: 16 },
    // true, false, or the kinds that keep their margin as the first block.
    firstBlockLead: ['heading'],
  },
  headings: {
    levels: [
      { fontSize: 24, lineHeight: 32, fontFamily: 'Display-Medium', letterSpacing: -0.6, before: 0 },
      { fontSize: 20, lineHeight: 28, letterSpacing: -0.48 },
    ],
  },
  list: { marker: { kind: 'dot', size: 5, gap: 10 }, itemGap: 8 },
  link: { underline: 'dashed', underlineColor: '#D4D4D8' },
  table: {
    frame: false,
    ruleColor: '#F4F4F5',
    header: { fontSize: 14, lineHeight: 21, color: '#71717A' },
    body: { fontSize: 14, lineHeight: 21 },
    hideEmptyHeader: true,
  },
};
```

Component props for the rest:

- `allowFontScaling` / `maxFontSizeMultiplier` apply to native runs and the standalone `<Text>` alike.
- `highlights` paints `{ query, matchTokens? }` matches or source spans with `colors.highlight` inside the native run, without reprojecting or leaving it.
- `softBreak="newline"` renders a soft break as a line break.
- `images` takes `'none'`, or `{ width: 'container', height: 'intrinsic', maxHeight }` to size embedded images to the column at their own aspect ratio. Container width is measured before image-bearing runs mount; use numeric container padding, since percentage padding falls back to the theme's padding.
- `accessibilityForPressable`, `pressedStyle`, `pressableHitSlop` and `chipForMark` turn an inline range such as a citation marker into a labelled, pressable pill:

```tsx
<SelectableMarkdown
  chipForMark={(mark) =>
    mark.kind === 'blockedLink' && isCitation(mark.href)
      ? { backgroundColor: '#FFF1EB', borderRadius: 6, paddingHorizontal: 4, minWidth: 18, fontSize: 12 }
      : undefined
  }
  accessibilityForPressable={({ href, text }) =>
    // 'text': tappable but read as prose; 'none': not tappable at all.
    isCitation(href) ? { label: `Open citation ${text}`, role: 'button' } : undefined
  }
  pressedStyle={{ backgroundColor: '#FFD9C9' }}
  pressableHitSlop={8}
  …
/>
```

  `chipForMark`, `attributeForMark` and `accessibilityForPressable` also apply to standalone blocks, where a chip is an inline box around the mark's text.
- `transformInline` can put a coloured glyph before a node, such as a status dot before a citation. The glyph is display-only and is left out of copy-as-markdown:

```tsx
transformInline={(node) =>
  node.kind === 'link' && isBiomarker(node.href)
    ? { prefix: { text: '\u25CF\u2009', style: { color: statusColor(node.href), fontSize: 10 } } }
    : undefined
}
```

- `codeBlocks="card"` draws top-level code blocks as cards with a language label, a Copy button and sideways scrolling, while keeping them inside the run's selection. Copy goes to `onCodeCopy` if you pass one, and to the system clipboard otherwise. Add `streamingEmbeds` to show the cards while a message streams.
- `embed` claims may set `width: 'container'` to fill the column.

## Defaults for model output

No options (or `presets.commonmark`) turns every extension off — not a spec-conformance mode: `html` still defaults to `'strip'` and destinations are still allowlisted, both of which the table below covers. Use `presets.llmChat` for model output. `presets.everything` turns on every extension, spoilers included; don't feed it untrusted text.

`extensions` replaces rather than extends, so an options literal naming one flag turns the rest off and a shallow spread of a preset does not help. `withOptions(preset, overrides)` layers on a preset instead, merging `extensions` and `urlPolicy` field by field; the two prefix arrays still replace deliberately.

| Option | Default | `llmChat` | Notes |
| --- | --- | --- | --- |
| `tables`, `strikethrough`, `tasklists`, `autolinks` | off | on | The GFM extensions. |
| `math` | off | off | `$5 and $10` must never become math. |
| `spoilers` | off | off | On only in `everything`. Parses only a balanced `\|\|x\|\|` inside one paragraph or heading; a stray `\|` stays text. |
| `underline` | off | off | `_` stops meaning emphasis. On only in `everything`. |
| `smartPunctuation` | off | off | Smart quotes and dashes in prose only; code and URLs stay byte-exact. Quotes pair the way `cmark --smart` pairs them, so an unpaired `"` renders as the closing form. On in `everything`. |
| `maxSourceLength` | 1,048,576 | same | The longest source `parseDocument` accepts, in UTF-16 units; longer input throws a `RangeError` before anything is parsed, from a session's `append` too. `Infinity` opts out. The native parse keeps one event per construct in memory, and node-dense text (`*a*a*a…`) amplifies its size by two orders of magnitude. |
| `html` | `'strip'` | `'strip'` | `'strip'` drops an HTML block with the lines it covers — a `<div>`, a `<details>` or a raw `<table>` contributes nothing to the document — and drops inline tags while keeping the text between them. `<br>` is the exception: it becomes a hard break spanning the tag. A block opening with `<!--`, `<script>`, `<pre>`, `<style>`, `<textarea>`, `<?` or `<!` runs to its own end marker rather than to a blank line, as CommonMark says, so a model that opens a comment on its own line and never closes it erases the rest of its message. `'raw'` keeps both as `htmlBlock` / `htmlSpan` nodes. `{ allow: ['a', 'br', 'strong', 'em', 'code', …], other? }` turns the listed tags into real nodes (an `<a href>` goes through the URL policy) and treats every other tag as `other`, `'strip'` by default. |
| Link prefixes | `https://`, `http://`, `mailto:` | same | A case-insensitive prefix test, not scheme parsing: `https:example.com` matches nothing and renders as plain text, not a dead link. Your list replaces this one; spread `DEFAULT_LINK_PREFIXES` to keep it. A prefix reaching into a path (`myapp://checkout/`) is a scope: a destination whose path climbs back out of it with `..` (raw or percent-encoded once) is refused, one that descends and returns (`a/../b`) is not, and a `..` inside a query string or fragment is left alone, so a router that reads its own path out of the fragment or query must check that part itself. |
| Image prefixes | `https://` | same | Blocked images render their alt text. |
| `urlPolicy.blockedLinks` | `'text'` | `'text'` | `'node'` keeps a blocked link as a `blocked: true` node for your `onLinkPress`, `embed` or `classifyBlock` handler — the `link` renderer runs only for standalone blocks. Never navigable. |

### Custom link schemes

The allowlist runs at parse time, so `[1](#citation-1)` or `[record](fhir://...)` collapse into plain text by default. Two ways to keep them:

- If the destination should open, add its prefix: `withOptions(presets.llmChat, { urlPolicy: { linkPrefixes: [...DEFAULT_LINK_PREFIXES, 'tel:'] } })`.
- If it is an in-app identifier, set `blockedLinks: 'node'` and handle it yourself. Nothing you don't claim can navigate.

The `renderers` prop overrides how a node kind draws, and those overrides run for standalone blocks only. Paragraphs, headings, lists, quotes and — since they became prose kinds — code blocks, tables, rules and HTML blocks flow into a native run drawn from projected text and attributes, so a `link`, `codeBlock` or `table` override is dead there until `classifyBlock` claims the block back (DEV warns when `blockedLinks: 'node'` meets a `link` override and no other channel). What does reach a flowing run: the theme and `attributeForMark` for styling, `onLinkPress` for taps, `embed` for a real element. Links inside a run are native tappable ranges, and taps arrive at `onLinkPress({ href, blocked, start, end })`; without a handler, live links open through `Linking.openURL` and blocked ones do nothing.

Each renderer function is its own React component type, which is what makes `renderers={editing ? draft : read}` safe: swapping a renderer unmounts the old one and mounts the new one, so two renderers never share a hook list. The cost is the ordinary React one — a renderer written as an arrow literal inside JSX is a new function every render and remounts its subtree every render — so give the map and the functions in it a stable identity (module scope, or `useMemo`/`useCallback`).

```tsx
import { openUrl, presets, withOptions } from 'react-native-selectable-markdown';

const options = withOptions(presets.llmChat, { urlPolicy: { blockedLinks: 'node' } });

<SelectableMarkdown
  source={md}
  options={options}
  onLinkPress={({ href, blocked }) => {
    const citation = blocked ? /^#citation-(\d+)$/.exec(href) : null;
    if (citation) showCitation(Number(citation[1]));
    else if (!blocked) openUrl(href);
  }}
/>
```

`openUrl` re-checks its argument against `DEFAULT_LINK_PREFIXES`, so pass your own list as its second argument (`openUrl(href, linkPrefixes)`) when `urlPolicy.linkPrefixes` is not the default — the built-in press handler does.

A renderer override changes what a node draws, not which selection run it lives in. To keep a real card *inside* the sweep, claim it through `embed`: the node projects as one placeholder character, the host reserves your declared size there and reports where it landed, and your element is overlaid on that space. Selecting across the card copies its exact markdown; `copy-text` substitutes the `text` you declare. Both this example and the `classifyBlock` one below assume the `options` above — under the default policy a `cards:` or `widget:` link has already collapsed to text before any claim or classifier sees it.

```tsx
import type { EmbedRenderer } from 'react-native-selectable-markdown';

// Module scope or useCallback: a changed claim resegments and reprojects.
const embed: EmbedRenderer = (node) =>
  node.kind === 'link' && /^cards:/.test(node.href)
    ? {
        width: 160, // declared, not measured: sizing is layout-affecting
        height: 88,
        text: '[cards]', // what copy-text shows for the card
        render: () => <CitationCards href={node.href} />, // closes over the narrowed node
      }
    : undefined;

<SelectableMarkdown source={md} options={options} embed={embed} />
```

A block-level embed may be any height; an inline one shares a line with prose, so keep it chip-sized (on iOS a line cannot outgrow its paragraph's leading). `topLevel` is true only for a block that is a direct child of the document — the one position where a full-column-width reservation is safe; the size is whatever the claim declares either way. Everything else is offered `topLevel: false`: a code block inside a list item, a table inside a blockquote, and every inline, a link in a top-level paragraph included. The card owns taps inside its bounds, so a long-press on it starts no selection. No overlay mounts while its run is the unsettled streaming tail — repair rewrites that text every tick — and the reservation is native either way, so nothing reflows when the run settles and the card appears.

`EmbedSpec.render` carries the same identity rule as a renderer: it is the overlay's component type, so switching `render` for a span remounts the card — the point — while an arrow rebuilt on every claim remounts it on every reprojection. Give it a stable identity, reading what it needs off the `node` it is handed, when the card holds state.

`images` decides how pictures ride along. The default `'embed'` claims a sole image in a top-level paragraph, reserves `spacing.imageWidth` × `spacing.imageHeight` (280 × 200 points) and overlays `renderers.image` on it, so an isolated picture keeps the sweep. Inline and container images keep normal layout; `'standalone'` sends the containing block to the renderer path instead, which is what you want for full-bleed or intrinsically sized pictures, or when a streamed image must draw before its run settles.

`classifyBlock` marks a block `'standalone'` so it gets its own selection scope and renderer. Use it for blocks that own a competing gesture and should end the sweep rather than flow through it. A block holding a spoiler, or an image no claim covered, is standalone already. Give it a stable identity; the document is resegmented when it changes.

A standalone list is one `<Text>` with its markers inside it, so a selection runs across items and copies the markers, and a standalone blockquote is one `<Text>` over its paragraphs. Nested text cannot hang-indent, so a wrapped list line returns to the list's leading edge.

```tsx
import type { ClassifyBlock } from 'react-native-selectable-markdown';

const classifyBlock: ClassifyBlock = (node) =>
  node.kind === 'link' && /^widget:/.test(node.href) ? 'standalone' : undefined;
```

## Architecture

```
markdown source
      │
      ▼
stream layer (streaming only): settled prefix + repaired tail ──► parse input
      │
      ▼
engine (md4c, or your own) ──► ParsedDocument: a SourceSpan on every node
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

## Status

| Area | Where it stands |
| --- | --- |
| Parser | md4c, 651/652 on CommonMark 0.31.2 (the one failure is example 174, an unclosed HTML block inside a blockquote). The only parser; throws where not linked. |
| Streaming | Incremental tail-only parsing, checked by a prefix oracle. Coalescing, holdback, smoothers. A 251-case tail-repair corpus. |
| Selection and copy | Exact source ranges, property-tested. Code blocks, tables and rules flow through runs; a block holding a spoiler, or an image no claim covered, is standalone — the whole block, not just the construct. Selections never span hosts: a document's runs clear another's unless `exclusiveSelection={false}` opts them out in both directions — which keeps every range reported and exact for copy, but only the run holding focus draws a highlight. |
| Copy menu | Copy Text and Copy Markdown, retitleable from JS and extensible with your own ids. With no title from JS the labels come from platform resources (`NSLocalizedString`, `res/values/strings.xml`), which the host app can override. Custom items need iOS 16+; iOS 15.1, React Native 0.82's floor, gets the system menu only. Both items report through `onSelectionCopy`; the app writes the clipboard. |
| Imperative selection | `onSelectionChange`, and a ref with `getSelection()`, `clearSelection()` and `setSelection(span)`. Codegen commands on both hosts; reviewed rather than exercised on device, like the host itself. No scroll-to-span. |
| Selection host | Fabric only (`react-native >= 0.82`). CI compiles C++ and runs codegen against React Native 0.82.1, the supported minimum release line, and checks Swift against the iOS SDK. There is no example app yet, so on-device behaviour is reviewed rather than exercised. |
| Accessibility | Links, headings, list items and table cells survive run merging: each is a VoiceOver/TalkBack focus stop, a link activates through the same press path a tap takes, a heading carries the platform heading trait, and on Android an item or cell carries its position (`CollectionItemInfoCompat`), which iOS has no trait for. Code-block and blockquote structure is still flattened by merging — neither platform has a primitive for it. `accessible` or `accessibilityRole` on the container collapses the document to one element, so label it but do not make it a leaf. Standalone blocks keep the roles `renderers.tsx` sets. Reviewed, not exercised: no screen reader has run against it here. |
| Embeds | The `embed` prop: a claimed node flows through its run as one placeholder, the host reserves its declared size and reports the rect (`onEmbedLayout`), JS overlays the element. Images are claimed this way by default. Removed in 0.10.0, restored in 0.11.0 ([CHANGELOG.md](CHANGELOG.md) is the record; the 0.10.0 release notes are one squashed commit). Reviewed on-device like the host itself. |
| Package surface | The entry names every export instead of re-exporting modules wholesale, so internals (the flat-buffer decoder, the host-binding lookup, the agui session map) moved to deep paths under `dist/`, which the `exports` map declares and `verify:pack` resolves; the `classifyBlock` function is `classifyTopLevelBlock`, with the old name kept as a deprecated alias. `withOptions(preset, overrides)` composes options without flattening a preset. |
| Android selection preservation | Not implemented, and the largest known gap. Each streamed text swap drops the selection. iOS preserves it. |
| Benchmarks | Node harnesses in `bench/`. On-device numbers are planned. |
| Example app | Planned. |

## Benchmarks

Measured on an Apple M2 Max with an arm64 Node 22, from the harnesses in `bench/`: the cross-parser comparison is the 2026-09-01 run, everything else a 2026-09-02 re-run. Markdown-to-HTML over a 289 kB spec-derived corpus, one fresh process per library, all in the same run: this package 15.8 MB/s, commonmark.js 10.0, marked 9.4, markdown-it 6.2. The number for this package includes building the span-carrying AST and serializing it to HTML. `engine.parse` on a 64 B tail cost 3.0 µs in the re-run — a parse alone, without the tail repair, span splice and snapshot an append also pays. What an append actually parses depends on whether the stream anchors. On the bundled sprint-review transcript it does: a blank line closes a paragraph and everything above it freezes, so appends parse a mean of 105 and at most 277 of the 1,162 final characters. A stream that never anchors gets none of that. `StreamSession.isAnchorSafe` is false for a list and for unclosed or indented code, and a blank line does not end a list, so `conformance/fixtures/transcript-giant-list.json` — 21.9 kB in 2,484 deltas, the commonest long LLM answer shape — parses a mean of 10,854 and a max of 21,881 of 21,927 characters, every append reaching the engine, and its incremental-vs-full ratio comes out above 1: tail-only parsing costs more there than reparsing the whole document per token. `npm run bench:streaming` replays both. These are V8 numbers; on Hermes the JS decode (38 to 51% of a parse) will be slower. Methodology and full tables in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

### Jest in React Native applications

The React Native Jest preset resolves this package to TypeScript source. Include it in your existing transform allowlist so Babel transforms files in `node_modules`:

```js
transformIgnorePatterns: [
  'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-selectable-markdown)/)',
],
```

Add the package name to your existing expression, preserving other allowed packages; do not append a second ignore pattern. Headless `engine` and `stream` imports also use source under the React Native condition; plain Node resolves their compiled entries. Native parser tests additionally need the Node addon described in `native/node/README.md`.

Create `withOptions(...)` results outside render or memoize them. It deliberately returns a fresh, independently mutable object, and passing a new options object reparses a static document.

## Contributing

```bash
npm test                 # needs a C++ toolchain: Jest reaches md4c through a Node addon
npm run typecheck
npm run conformance      # CommonMark score, written to conformance/report-native.json
npm run bench:all
npm run verify:pack      # the packed tarball loads
npm run check:codegen && npm run check:fabric-cpp && npm run check:swift
npm run check:app:android  # builds a fresh RN app with the packed tarball (JDK 17 + Android SDK)
npm run check:app:ios      # the same through CocoaPods and xcodebuild (macOS)
```

Without a compiler the native suites report as skipped, not passed. CI, the release workflow and `npm run release` all build the addon as a hard gate before the suite runs; `npm run release -- --skip-tests` opts out of the build and the suite together, and says so. See [native/node/README.md](native/node/README.md).

## Releasing

Publishing is tag-triggered. The tarball `npm run release` writes locally is a dry run, never the published artifact.

1. Move the Unreleased entries into the target version's section in [CHANGELOG.md](CHANGELOG.md), `## [X.Y.Z] — <date>`.
2. Run `npm run release <patch|minor|major|x.y.z>`. It checks types and tests, bumps the manifest and lockfile, verifies the proposed tag against the changelog, verifies the package, and packs a local dry run. Unreleased BREAKING entries fail both this guard and CI, and so does a BREAKING entry under a version that is not a minor bump (a major, past 1.0); a failure rolls the version bump back. Nothing is committed, tagged or published.
3. `git add package.json package-lock.json CHANGELOG.md && git commit -m "release X.Y.Z"`.
4. `git push origin main && git tag vX.Y.Z && git push origin vX.Y.Z`.

The tag runs `release.yml`: the macOS gates (Swift, the iOS header set), then everything CI runs, then its own `npm pack`, `npm publish <that-tarball> --provenance --access public`, and the GitHub release with that same tarball attached. A hand `npm publish <tarball>` from a laptop is not the supported path — it ships without provenance, which only that workflow can mint, and without the release gates. `scripts/release.mjs` prints steps 2 to 4 with the version filled in.

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
