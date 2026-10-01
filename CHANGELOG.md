# Changelog

Versions follow [semver](https://semver.org/); pre-1.0, breaking changes land in a minor bump.

## [Unreleased]

## [0.12.0] — 2026-10-01

- BREAKING: the package entry exports an explicit list of 191 names. Ten internals left the root and are imported by path instead: `decodeFlatBuffer`, `NativeProtocolError`, `applySmartPunctuation`, `PROTOCOL_VERSION`, `findHostBinding`, `NativeHostBinding` and `__linkNativeEngine` from `dist/engine/native`; `getOrCreateSession` from `dist/agui/useAgUiSession`; `embedContentFor` from `dist/selection/runs`; `isUriLikeLabel` from `dist/stream/repair`.
- Deprecated: the exported `classifyBlock` function is now `classifyTopLevelBlock`. The old name stays as a deprecated alias until a later minor. The `classifyBlock` prop and the `ClassifyBlock` type are unchanged.
- Selection: imperative API on `<SelectableMarkdown>`. A `ref` (`SelectableMarkdownHandle`) exposes `getSelection()`, `clearSelection()` and `setSelection(span)`; `onSelectionChange` reports the live selection as `{ span, plain }` or `null`.
- Selection: `RunHostHandle` (`clearSelection`, `setSelection`) and the exported `mapSourceToRunRange` for consumers driving `RunHost` directly.
- Selection: `exclusiveSelection` prop (default `true`) on `<SelectableMarkdown>` and `RunHost`; `false` opts out of the one-active-selection coordination.
- Selection: prose merging stops at `DEFAULT_MAX_RUN_CHARS` (8000). `maxRunChars` is a `<SelectableMarkdown>` prop and a `segmentRuns` option; `Infinity` restores the old behaviour.
- Selection: `classifyBlock` results are memoized on block identity, so the callback must be pure and referentially stable.
- Selection: `ProjectedRun.extents` (`ProjectedExtent`) and `CopyContext.classifyBlock`.
- Selection: copy-markdown keeps the syntax of a wholly selected heading, list, list item, blockquote, code block, table, emphasis, strong span or link.
- Selection: an escape, entity, smart quote or ellipsis no longer pins its whole text node; indented code blocks no longer map one indent-width to the left.
- Streaming: `repairTail` takes a carry-forward `RepairScan` (`RepairResult.scan`) so successive calls resume the inline scan.
- Streaming: a release never cuts inside a grapheme cluster (flags, ZWJ sequences, combining marks).
- BREAKING: images default to `images="embed"`. They reserve a 280-point `spacing.imageWidth` box, appear once their run settles, and retain the run's `onSelectionCopy` behavior. Use `images="standalone"` to restore the previous rendering and selection scope. The built-in claim accepts only a sole image in a top-level paragraph; inline images and images in lists, headings, quotes, and tables retain standalone layout. `withImageEmbeds` and `ImageMode` are exported.
- View: incremental run projection for consumers: `createRunProjectionCache`, `RunProjectionCache`, `ProjectRunOptions.previous`.
- View: `selectionActions` entries may be `{ id, title }`; `SelectionCopyEvent.action` and `SelectionActionEvent.action` widen to `SelectionActionId` and every non-empty id is reported verbatim; `handleSelectionAction` gains `ctx.actions`.
- View: `RenderContext.selectable` (absent means selectable) and `RenderContext.linkPrefixes`; `openUrl(href, allowedPrefixes?)` sanitizes and re-checks the href against `urlPolicy.linkPrefixes`.
- View: `MarkAttribute` returns the narrower `RunMarkStyle`; `colors.quoteBar` is gone from the default themes (still honoured as a deprecated input, read `theme.quote.barColor` instead).
- View: DEV warnings for an untitled unknown `selectionActions` id, an action id that was never offered, and `blockedLinks: 'node'` paired with only a `link` renderer override.
- View: an embed claim with an infinite `width` or `height` is rejected.
- Engine: `sanitizeUrl`, `isUrlAllowed` and `isNativeEnginePermanentlyRefused` are exported; `NativeModules.SelectableMarkdown.install()` returns `'installed' | 'unavailable' | 'refused'` and `isNativeEngineAvailable()` no longer re-crosses the bridge after a permanent refusal.
- Engine: semantic fields on the run wire (`role`, `roleLevel`, `roleRow`, `roleRowCount`, `roleColumn`, `roleColumnCount`), separate from styling.
- iOS and Android: headings, list items and table cells inside a merged run are announced to VoiceOver and TalkBack.
- iOS: the blockquote bar sits on the leading edge for right-to-left paragraphs.
- Android: selection menu strings ship in `res/values/strings.xml` (`selectable_markdown_copy_text`, `selectable_markdown_copy_markdown`) and can be overridden or translated.
- Packaging: `exports` map (root, `./dist`, `./dist/*`, `./src/*`, `./package.json`, `./react-native.config.js`), `sideEffects: false`, an ES module build in `dist/esm` with `import`/`require` conditions, and `dist/view/SelectableRunHostNativeComponent.d.ts` beside the shim.
- Packaging: `./engine` and `./stream` subpath entries for headless consumers (plain Node, a consumer's jest) that cannot load the root because it imports `react-native`; `./node` resolves the Node addon loader, and `native/node` plus `scripts/build-node-addon.mjs` ship in the tarball so a consumer can build the engine for its tests.
- Release: notes come from this file (`scripts/changelog-section.mjs`); `scripts/check-unreleased-breaking.mjs` refuses a pending breaking change under an already-tagged version; `scripts/check-lock-sync.mjs` checks the lockfile mirrors the manifest.
- Benches and CI: `bench:pathological` takes per-stage budgets and `--require-engine`; `bench:projection` and `bench:streaming` are CI gates. Streaming budgets cover per-chunk and finalization time on the giant-list transcript. Correctness tests use an isolated packaging build; builds clear stale `dist` output, and tarballs exclude Android build caches and native binaries.

- BREAKING: URL prefixes now match paths case-sensitively, reject traversal above a path prefix, and require an authority boundary after a host-only prefix. For example, `/photos/` no longer matches `/Photos/`, and `https://good.com` no longer admits `https://good.com.evil.com` or userinfo on another host.
- BREAKING: React Native's Jest resolver follows the new `react-native` export condition into TypeScript source. Add this package to the Jest transform allowlist shown in README, including when using the headless `engine` and `stream` entries under that preset.
- Streaming: `dispose()` cancels pending work, drops buffered text and subscribers, and resolves waiting drains. `drained()` rejects after exhausted engine retries; new buffered or rewritten input starts a fresh attempt. Subscriber exceptions no longer strand an emptied drain.
- Streaming: URI-like label hiding now requires the documented URI shape; spoiler and HTML repair recognize more constructs. Link-reference definitions outside code fences pin `settledUntil` at zero. Word-boundary smoothing falls back to character progress after 32 units of overdraw.
- Streaming: fence indentation and backslashes inside code spans no longer append visible repair characters; long regional-indicator runs preserve flag boundaries. Less-than prose without a closer scans linearly.
- Selection: source/display restoration retains complete list markers; growing unsettled blocks and standalone tails preserve host identity. Independent classifiers keep separate caches, and short selection mappings skip unrelated pieces and extents.
- View: renderer functions mount as components so they may use hooks. Keep renderer identities stable; an inline function remounts its component. Nesting beyond 64 renderer levels falls back to flat text. Embedded-image alt text remains on the overlay, whose assistive reading order can differ from surrounding host text; use standalone images when that order is required.
- AG-UI: session hooks suspend timers on effect cleanup and resume retained sessions on reconnection and finalize outgoing message sessions as aborted. Run bindings support per-row storage, authoritative content, paced rewrites, late-row grace, run identities and failure dispositions; rebinding preserves an outstanding run-end drain.
- Engine: email autolinks are decoded, hrefs are decoded once, and malformed native event streams throw instead of returning partial documents. Spoilers remain active when smart punctuation changes surrounding text. Empty container children exclude their parent marker, and blank-only fences report their closing fence.
- iOS: native runs follow Dynamic Type; code/table padding at a run edge contributes to host height. Accessibility follows document order, fully covered runs expose a labeled selection control, recycled hosts refresh inset layout, and mixed-direction quotes resolve direction per paragraph.
- Android: semantic-only updates preserve selection. Layout caches track resolved typefaces, accessibility work waits until enabled, and SDK defaults are 36/24/36 for compile/minimum/target. Development checks use React Native 0.82.1 and React 19.1.1.

- Selection: the first embed preserves its host; host removal clears selection. With `exclusiveSelection={false}`, clearing the latest selection reports the most recently selected run that is still live. Blocked-link labels with entities or markup no longer restore the blocked destination when copied.
- Streaming: repeated run IDs work without `onRunStarted`; rebinding retains buffered routing even between arrivals. Evicted sessions cancel their timers. Run-end notifications release final Unicode clusters without the idle delay; snapshot block arrays no longer expose internal storage. `suspend()` and `resume()` stop and restart buffered work without losing input.
- Engine: `<br>` remains a hard break under `html: 'strip'`. Escaped backslashes before spoiler delimiters are counted by parity. Empty projected block groups render standalone so their decoration remains visible.
- View: standalone renderers use automatic text alignment and leading-edge spacing for RTL content. Images with alt text expose an image accessibility role.
- Packaging: type declarations take precedence over the React Native source condition. Built deep imports share source modules with the root under React Native; explicit `dist/esm` and extensionless source paths resolve correctly.
- Public exports added since 0.11.0: `VisitSignal`, `withOptions`, `isNativeEnginePermanentlyRefused`, `sanitizeUrl`, `isUrlAllowed`, `RepairScan`, `classifyTopLevelBlock`, `DEFAULT_MAX_RUN_CHARS`, `ProjectedExtent`, `PreviousProjection`, `BufferedSessionSink`, `MessageBindingOptions`, `UseAgUiSessionInit`, `UseAgUiSessionOptions`, `MAX_RENDER_DEPTH`, `ImageMode`, `withImageEmbeds`, `RunSemanticRole`, `RunMarkStyle`, `isReservableEmbedSize`, `RunProjectionCache`, `createRunProjectionCache`, `RunTextRange`, `mapSourceToRunRange`, `SelectionChangeEvent`, `RunHostHandle`, `RunHostAccessibilityProps`, `SelectionActionId`, `SelectionActionSpec`, `SelectionActionInput`, `selectionDisplayText`, `SelectableMarkdownAccessibilityProps`, `SelectableMarkdownSelection`, and `SelectableMarkdownHandle`.
- iOS: splices compare immutable input snapshots and ignore run-edge inset metadata; collapsed selections report one empty range. Code boxes resolve writing direction per paragraph, and measured heights round after edge padding.
- Android: inline embed height affects only its own line; keyboard focus visits links while screen-reader navigation retains semantic nodes. Links use React Native's localized role description, and measured and displayed text share elegant font metrics.
- Release: npm publishes the exact tarball attached to GitHub, before release creation. The local release guard checks the proposed tag like CI does.

## [0.11.0] — 2026-09-01

- Embeds restored, Fabric-only: the `embed` prop takes an `EmbedRenderer`, a claimed node flows through its run as one placeholder, the host reserves the declared size and `onEmbedLayout` reports the rect.
- `RunEmbed` and the embed projection helpers are public again; `RunHost` gains the `embeds` prop and `onEmbedLayout` event.
- The codegen spec carries `embeds` and `onEmbedLayout`; `npm run check:codegen` asserts both on iOS and Android.
- Native embed support on both platforms: placeholder-aware attributed text and rect reporting on iOS; `RunEmbeds`, `EmbedLayoutEvent` and an embed-keyed layout cache on Android.
- Selection tests cover embedded runs (projection oracle, run segmentation, copy fidelity).

## [0.10.0] — 2026-09-01

- BREAKING: peer floor raised to `react-native >= 0.82`; the package targets bridgeless Fabric only.
- BREAKING: the old-architecture (Paper) selection host is removed.
- BREAKING: the `<Text selectable>` fallback is removed; `RunHost` throws where the native component is not registered.
- BREAKING: embeds removed (restored in 0.11.0).
- BREAKING: `StreamSessionInit.onUpdate` removed; use `session.subscribe(listener)`.
- `<SelectableMarkdown session={…}>` renders the session's snapshot; the session owns its parse context.
- Tests are excluded from the published tarball.

[Unreleased]: https://github.com/superpowerdotcom/react-native-selectable-markdown/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/superpowerdotcom/react-native-selectable-markdown/releases/tag/v0.11.0
[0.10.0]: https://github.com/superpowerdotcom/react-native-selectable-markdown/releases/tag/v0.10.0
