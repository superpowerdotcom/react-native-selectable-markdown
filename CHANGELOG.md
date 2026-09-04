# Changelog

Notable changes per released version. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the pre-1.0 rule that breaking changes
land in a **minor** bump.

`main` was squashed to a single commit at the 0.10.0 tag, and GitHub release
notes are generated from the commits in a tag range — which for 0.10.0 is one
commit called "Initial commit". That is why this file exists: it, not the
release notes, is the record of what changed. `.github/workflows/release.yml`
reads the section for the tag being released and refuses to publish without
one.

Entries before 0.10.0 are not reconstructed here; the per-release detail for
those exists only in the pre-squash branches on the remote.

## [Unreleased]

An audit pass across the whole library. Two entries under Changed are
breaking; under the pre-1.0 rule they land in the next **minor** (0.12.0).
Nothing here is published yet: `package.json` is still at 0.11.0, so the next
publish has to bump the version and move this section under that heading — the
release workflow reads the section for the tag it is given and refuses to
publish without one.

### Added

- **Streaming: `repairTail` resumes its inline scan.** It takes an optional
  carry-forward `RepairScan` — returned as `RepairResult.scan` and exported
  from the package entry — so successive calls on a growing tail pick up where
  the last one stopped instead of re-deriving the inline region from the start
  of the tail. Passing nothing behaves exactly as before, and the function is
  still pure. `RepairResult.scan` is optional, so code that builds a
  `RepairResult` literal still compiles; omitting it only costs the resume.
- **Selection: an imperative API.** `<SelectableMarkdown>` forwards a ref
  (`SelectableMarkdownHandle`) with `getSelection()`, `clearSelection()` and
  `setSelection(span)`, and takes an `onSelectionChange` prop that reports the
  live selection as `{ span, plain }`, or `null` when it goes away. Passing a
  `ref` used to be a type error, so an app could not build its own floating
  toolbar, clear a stale selection on navigation, or highlight a span it had
  computed. `setSelection` returns `boolean`: false when no mounted run both
  shows the span and will take a selection right now. Scrolling a span into
  view is not part of it: the document owns no scroll view, and the wire has
  no measurement channel yet.
- **View: `RunHostHandle`.** `RunHost` forwards a ref with `clearSelection()`
  and `setSelection(start, end)` in the run's own display offsets, and
  `mapSourceToRunRange` (with the `RunTextRange` type) is exported so a
  consumer driving runs themselves can do the mapping `<SelectableMarkdown>`
  does internally. Both hosts implement the matching `onSelectionChange` event
  and `clearSelection`/`setSelection` codegen commands.
  `RunHostHandle.setSelection` returns `boolean` — true when the command was
  dispatched, false when nothing was asked of the platform — which anyone
  implementing the interface has to return.
- **View: `<SelectableMarkdown maxRunChars>`.** The run cap is a prop now, not
  only an option on direct `segmentRuns` calls: it forwards straight through,
  defaults to `DEFAULT_MAX_RUN_CHARS` (8000), and takes `Infinity` to opt out.
- **View: `RenderContext.selectable`.** Optional, and ABSENT MEANS
  SELECTABLE: every built-in renderer, including the unknown-kind and
  depth-cap fallbacks, reads it as `ctx.selectable ?? true`, so a hand-built
  context still compiles and still renders selectable text. The view sets it
  from the platform tail policy.
- **Selection: `CopyContext.classifyBlock`,** so a copy re-segments the
  reparsed slice the way the document was segmented.
- **Selection: `exclusiveSelection`** (default `true`) on
  `<SelectableMarkdown>` and `RunHost`. `false` opts a document's runs out of
  the process-wide one-active-selection coordination in both directions, so
  two selections can be held at once and a cross-message copy is reachable by
  hand.
- **Selection: `ProjectedRun.extents`** and the `ProjectedExtent` type, which
  carry each construct's projected range alongside its own source span.
- **Selection: `segmentRuns` takes `maxRunChars`**, with the exported constant
  `DEFAULT_MAX_RUN_CHARS` (8000).
- **View: incremental run projection for consumers.**
  `createRunProjectionCache` and the `RunProjectionCache` type, plus
  `ProjectRunOptions.previous` and the `PreviousProjection` type on
  `projectRun`, so a consumer driving `RunHost` gets the same reprojection
  `<SelectableMarkdown>` uses instead of reprojecting a settled run from the
  start on every delta.
- **View: an `images` prop** (`'embed' | 'standalone'`, default `'embed'`),
  the `withImageEmbeds` helper and the `ImageMode` type, and a new theme token
  `spacing.imageWidth` (default 280).
- **View: selection-menu titles.** A `selectionActions` entry may now be
  `{ id, title }`, so labels come from the app's own i18n on both platforms,
  and consumer-defined ids work end to end: rendered when they carry a title,
  routed back through `onSelectionCopy` with that id and the usual payload.
  `handleSelectionAction` gained `ctx.actions`, which is a DEV cross-check
  only: it warns once per id when an action arrives that the offered menu did
  not contain, and never renames it.
- **View: three DEV warnings.** One for a `selectionActions` id that is neither
  built-in nor titled, which both hosts drop rather than render blank — latched
  per id rather than once per JS runtime, so a second document in a transcript
  offering a different untitled id warns again. One for an action id reported
  back that `ctx.actions` never offered. One for
  `urlPolicy.blockedLinks: 'node'` paired with a `link` renderer override and
  none of `onLinkPress`, `embed` or `classifyBlock` — the one shape where the
  override never runs, because flowing prose has no renderers in it.
- **Engine: `sanitizeUrl` and `isUrlAllowed`** are exported from the package
  entry, so an engine author applies the same allowlist the view re-checks
  with rather than reimplementing it. `isNativeEnginePermanentlyRefused()` is
  exported next to `isNativeEngineAvailable()`.
- **Engine: semantics on the run wire.** `RunTextAttribute` and
  `NativeRunTextAttribute` gained six fields — `role`
  (`'heading' | 'listItem' | 'tableCell'`), `roleLevel`, `roleRow`,
  `roleRowCount`, `roleColumn`, `roleColumnCount` — a channel separate from
  styling. None of them is reachable from `attributeForMark`, which returns
  `RunMarkStyle`.
- **iOS and Android: headings, list items and table cells inside a merged run
  are announced.** VoiceOver and TalkBack reach headings as headings and
  navigate heading to heading, instead of hearing prose in a larger font, and
  each list item and table cell is its own focus stop — on Android a virtual
  view carrying `CollectionItemInfoCompat`, so TalkBack says "row 2, column 3"
  in the reader's own language. The roles come from the semantic fields on the
  wire, so a restyled heading is still a heading; Android's font-shape
  inference is gone. Code-block and blockquote structure still does not cross:
  neither platform has a primitive for it.
- **Android: `res/values/strings.xml`** ships
  `selectable_markdown_copy_text` and `selectable_markdown_copy_markdown`, so
  a host app rewords or translates the default menu items through ordinary
  Android resources.
- **Packaging: an `exports` map.** The root, `./dist`, `./dist/*`, `./src/*`,
  `./package.json` and `./react-native.config.js` are what a consumer can
  import, and every `dist` entry carries `require` and `import` conditions
  with their own `types`; the package is marked `sideEffects: false`, object
  files are excluded from the tarball, and `CHANGELOG.md` ships in it.
- **Packaging: an ES module build.** `npm run build` also emits `dist/esm`
  (`tsconfig.esm.json`, `module: es2020`), finished by
  `scripts/finish-esm-build.mjs` — which writes `dist/esm/package.json`
  (`"type": "module"`, `sideEffects: false`) and adds the `.js` extension
  Node's ESM resolver needs on every relative specifier. `package.json` gains
  a `module` field and the `import`/`require` conditions, with `react-native`
  still first and still `src/index.ts`; `npm run verify:pack` resolves and
  imports the documented deep paths under both conditions out of the tarball.
  Bundler-visible, not breaking — the `require` path is byte-identical to what
  shipped, and the ESM build is what lets webpack, Rollup and Vite tree-shake
  per export.
- **Packaging: `npm run build` emits `dist/view/SelectableRunHostNativeComponent.d.ts`**
  beside the shim it already emitted, so the `./dist/*` types condition
  (`./dist/*.d.ts`) has no hole; `npm run verify:pack` fails the tarball when
  the declaration is missing.
- **Benches and CI: gates that cannot pass vacuously.** `bench:pathological`
  takes per-stage budgets (`--budget-parse|-repair|-segment|-project MS`) and
  `--require-engine`, which turns an unresolvable addon from an exit-0 report
  into a failure; `bench:projection` is a gate CI runs, failing when cached
  projection amplification grows more than 1.25× across a document doubling;
  and `scripts/check-lock-sync.mjs` runs in release.yml's preflight, comparing
  the ten fields npm actually copies into the lock's root entry — name,
  version, license, the five dependency blocks, `engines` and `bin` —
  key-order-insensitively, and treating an empty block and a missing one as
  the same statement, so `"dependencies": {}` against a lock that omits the
  block is no longer a red describing no drift.
- **Docs: release notes come from this file.** `scripts/changelog-section.mjs`
  prints one version's section for `gh release create --notes-file`, and the
  release workflow fails in its first job when the section for the tag is
  missing, instead of generating notes from a squashed commit log.
- **Release guard: a pending breaking change cannot ship under a version that
  is already tagged.** `scripts/check-unreleased-breaking.mjs` fails when this
  file's Unreleased section marks a change breaking while `package.json`'s
  version equals the version of the latest `v*` tag. It runs in release.yml's
  preflight job (passed the tag being pushed, so a shallow checkout still has
  something to compare against) and in `npm run release` right after the
  version bump, where a failure rolls the bump back. Against this tree as it
  stands the guard exits 1, which is the intended state: everything under
  Unreleased ships in the tarball a tag produces, so the two breaking entries
  below have to move under the new version's heading and the version has to be
  bumped past v0.11.0 — 0.12.0 under the pre-1.0 rule — or the tag fails
  preflight in seconds. No version was bumped by this change. (This entry
  spells the marker in lower case on purpose: the guard matches the literal
  upper-case word, line by line.)

### Changed

- **BREAKING — the package entry publishes an explicit list** of 190 names
  instead of two dozen `export *` lines. Nineteen internals are no longer at
  the root and are imported by path instead: `__linkNativeEngine`,
  `decodeFlatBuffer`, `NativeProtocolError`, `applySmartPunctuation`,
  `PROTOCOL_VERSION`, `findHostBinding` and `NativeHostBinding` from
  `dist/engine/native`; `encodeSelectionActions`, `decodeSelectionAction`,
  `SELECTION_ACTION_SEPARATOR`, `isBuiltInSelectionAction`,
  `selectionActionId` and `selectionActionTitle` from
  `dist/view/selectionActions`; `getOrCreateSession`, `resolveSessionInit`,
  `settleUnboundSession` and `useDeferredUnmount` from
  `dist/agui/useAgUiSession`; `embedContentFor` from `dist/selection/runs`;
  `isUriLikeLabel` from `dist/stream/repair`. Nothing was made private, but a
  deep path carries no stability promise.
- **BREAKING — `classifyBlock`, the exported function, is now
  `classifyTopLevelBlock`.** The `classifyBlock` prop of
  `<SelectableMarkdown>` and the `ClassifyBlock` type are unchanged; the
  rename exists because all three sat at the package root under two spellings
  of one word.
- **Streaming: a release never cuts inside a grapheme cluster.** The
  smoother's budgeted cut moves up to the next cluster boundary and
  `holdBackChars` moves down to the previous one, so a flag, an emoji ZWJ
  sequence or a combining mark is never painted as half a glyph.
  `Intl.Segmenter` is not used; Hermes ships a limited Intl subset.
- **Selection: prose merging stops at `DEFAULT_MAX_RUN_CHARS`** source
  characters, so a document longer than that renders as several native hosts
  rather than one and a sweep cannot cross the boundary. It breaks merging
  between blocks and never splits one, so a single block past the cap is still
  one run. Pass `maxRunChars: Infinity` — as the `segmentRuns` option or the
  `<SelectableMarkdown>` prop — for the previous behaviour. `classifyBlock` results
  are memoized on block identity, which makes the callback's documented purity
  and referential stability load-bearing.
- **View: an image no longer makes its containing block standalone.** It is
  claimed as an embed and flows inside its run, so a sweep across an
  illustrated answer stays whole and the block keeps `onSelectionCopy`. A
  `classifyBlock` claim on an image node no longer forces standalone either;
  `images: 'standalone'` is what does that now.
- **View: `openUrl(href, allowedPrefixes?)` sanitizes and re-checks** the href
  against `urlPolicy.linkPrefixes` before `Linking.openURL`, and opens the
  sanitized string, so a href from a substituted engine cannot bypass the
  allowlist. A caller passing no prefixes gets `DEFAULT_LINK_PREFIXES`;
  `RenderContext` gained `linkPrefixes`.
- **View: `SelectionCopyEvent.action` and `SelectionActionEvent.action`**
  widen from the closed `'copy-text' | 'copy-markdown'` union to
  `SelectionActionId`, and every non-empty id is now reported VERBATIM,
  built-in or consumer-defined, whether or not the caller threaded
  `ctx.actions`. Only an event carrying no action at all resolves to
  `'copy-markdown'` — that is the whole of the version skew, a binary older
  than the `action` field. Renaming an id the offered list did not contain
  could only hand a consumer their own action in their copy-markdown branch.
  Not breaking otherwise: a bare string id behaves exactly as before, and the
  default menu's wire bytes are unchanged.
- **View: the `selectionActions` memo compares every field.** The entry-by-entry
  comparison behind the inline form is now a generic shallow compare of every
  own field on each entry, in both directions, rather than `id` and `title` by
  name, so a field added to `SelectionActionSpec` later is not silently
  invisible to the memo. A bare string id still compares equal to a spec that
  adds nothing beyond that id, because both encode to the same wire entry.
- **View: `MarkAttribute` returns the narrower `RunMarkStyle`** —
  `RunTextAttribute` without `start`, `end` and the six semantic fields. Any
  existing `attributeForMark` still compiles.
- **View: `colors.quoteBar` ships no value.** It is gone from `defaultTheme`
  and `defaultDarkTheme` (it was `'#c9ced6'` / `'#3d444d'`) because nothing
  read it: `quote.barColor` is what renders, so overriding that alone left
  `colors.quoteBar` reporting the old colour. It still works as a deprecated
  input — setting it alone recolours the bar — but code that reads the theme
  for its own drawing must read `theme.quote.barColor`.
- **Engine: `NativeModules.SelectableMarkdown.install()` returns
  `'installed' | 'unavailable' | 'refused'`** instead of a boolean. Both
  directions stay compatible: an older JS bundle ignores the return value and
  reads the global, and a newer bundle meeting an older binary reads `false`
  as the transient `unavailable`. The point is that `isNativeEngineAvailable()`
  no longer re-crosses the bridge on a permanent refusal, so it is safe to
  poll from a render path.

### Fixed

- **Selection: copy-markdown no longer drops a block's own syntax.** A
  selection covering a whole heading, list, list item, blockquote, fenced or
  indented code block, table, emphasis or strong span, or inline link now
  carries that construct's source, so a copied list pastes as a list instead
  of re-parsing as a paragraph. A partly covered construct is unchanged.
- **Selection: an escape, entity, smart quote or ellipsis no longer pins its
  whole text node.** In plain prose the decoder emits one text node per
  paragraph, so a single `\*` or `&hellip;` used to make a twelve-character
  selection copy the entire paragraph. Such a node is now covered piecewise
  and only the respelled stretch is indivisible.
- **Selection: an indented code block mapped one indent-width to the left.**
  The block's literal is de-indented and newline-terminated while its source
  slice is neither, and at some widths the two come out the same length, which
  the piece table read as a character-for-character mapping. Copying from an
  indented code block now returns the source it displays.
- **View: an embed claim with an infinite `width` or `height` is rejected.**
  `Infinity > 0` passed the old `!(x > 0)` gate and reached the hosts as an
  infinite `CGRect` and an `Int.MAX_VALUE` span.
- **iOS: a blockquote bar no longer lands on top of right-to-left text.** Head
  and tail indents are LEADING-edge relative, and TextKit resolved that edge
  per paragraph from its own first strong character, so a single Arabic or
  Hebrew quote inside an English transcript indented from the right while the
  bar was painted at the physical left. The attributed-string builder now pins
  `baseWritingDirection` on every range it indents — to the direction TextKit
  would have resolved anyway, so nothing that renders today moves — and
  `draw(_:)` reads that decision back off the string to put the bar on the
  leading edge. Measurement and painting can no longer disagree, because only
  one of them chooses.
- **Android: the selection menu was hardcoded English** with no override path.

## [0.11.0] — 2026-09-01

### Added

- **Embeds, restored and Fabric-only** (removed in 0.10.0). `<SelectableMarkdown embed={…}>`
  takes an `EmbedRenderer`: a claimed node keeps flowing through its selection
  run as a single placeholder character mapped to the node's whole source
  span, the native host reserves the declared `width` × `height` there, and
  `onEmbedLayout` reports where the reservation landed so the element can be
  overlaid on it. One sweep still selects across an answer containing a card,
  and copying it yields the node's exact markdown (`copy-markdown`) or the
  declared `text` (`copy-text`).
- `RunEmbed` and the embed projection helpers are public again from the
  package entry, alongside the `embeds` prop and `onEmbedLayout` event on
  `RunHost`.
- The codegen spec carries `embeds` and `onEmbedLayout`, and
  `npm run check:codegen` asserts both survive codegen on iOS and Android.
- Native support on both platforms: placeholder-aware attributed text and
  rect reporting in the iOS host, `RunEmbeds` / `EmbedLayoutEvent` and a
  layout cache that keys on embeds in the Android host.
- Selection tests grew with it: the projection oracle, run segmentation and
  copy-fidelity suites all cover embedded runs.

## [0.10.0] — 2026-09-01

The release that dropped the old architecture. Every removal below is
breaking.

### Changed

- **Peer floor raised to `react-native >= 0.82`** (from `>= 0.73`). From 0.82
  React Native refuses an old-architecture `pod install` outright, so the
  package targets bridgeless Fabric only.
- `<SelectableMarkdown session={…}>` renders the session's snapshot and no
  longer re-parses with the component's `options`/`engine`: the session owns
  its parse context.
- The published tarball no longer contains tests — `files` excludes
  `src/**/*.test.ts(x)` and `src/**/__tests__`.

### Removed

- **The old-architecture (Paper) selection host.** The Kotlin measuring shadow
  node, the Swift and Objective-C view managers, and the podspec's
  architecture gate are gone; the podspec now adds the Fabric sources and
  calls `install_modules_dependencies` unconditionally.
- **The `<Text selectable>` fallback.** `RunHost` throws where the native
  component is not registered (Expo Go, web, a test renderer, a binary built
  without the pod) instead of rendering a document that merely looks
  selectable — on iOS Fabric that tier was a long-press whole-block Copy menu
  with no handles, no range and no `onSelectionAction`, and two defects hid
  behind the appearance for a release each. The error names the missing
  `RCTThirdPartyComponentsProvider` entry and the rebuild it needs.
- **Embeds.** The `embed` prop, `RunEmbed` and the native reservation path
  were removed as unused; restored in 0.11.0.
- `StreamSessionInit.onUpdate`. Use `session.subscribe(listener)`, which
  returns an unsubscribe function.

[Unreleased]: https://github.com/superpowerdotcom/react-native-selectable-markdown/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/superpowerdotcom/react-native-selectable-markdown/releases/tag/v0.11.0
[0.10.0]: https://github.com/superpowerdotcom/react-native-selectable-markdown/releases/tag/v0.10.0
