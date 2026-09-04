# Changelog

Versions follow [semver](https://semver.org/); pre-1.0, breaking changes land in a minor bump.

## [Unreleased]

- BREAKING: the package entry exports an explicit list of 190 names. Nineteen internals left the root and are imported by path instead (`dist/engine/native`, `dist/view/selectionActions`, `dist/agui/useAgUiSession`, `dist/selection/runs`, `dist/stream/repair`).
- BREAKING: the exported `classifyBlock` function is now `classifyTopLevelBlock`. The `classifyBlock` prop and the `ClassifyBlock` type are unchanged.
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
- View: `images` prop (`'embed' | 'standalone'`, default `'embed'`), `withImageEmbeds`, `ImageMode`, and the `spacing.imageWidth` theme token (280). An image flows inside its run instead of making the block standalone.
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
- Release: notes come from this file (`scripts/changelog-section.mjs`); `scripts/check-unreleased-breaking.mjs` refuses a pending breaking change under an already-tagged version; `scripts/check-lock-sync.mjs` checks the lockfile mirrors the manifest.
- Benches and CI: `bench:pathological` takes per-stage budgets and `--require-engine`; `bench:projection` is a CI gate.

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
