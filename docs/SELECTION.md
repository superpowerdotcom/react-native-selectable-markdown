# Selection: the JS/native host contract

Every character the user can select maps back to an exact UTF-16 range of the
markdown source. This document is the contract between the JS layer and the
native host views that makes that true. Usage of `selectionActions`,
`onSelectionCopy`, `onLinkPress` and `classifyBlock` is in the README;
session mechanics are in [STREAMING.md](STREAMING.md).

## Pipeline

```
ParsedDocument ──segmentRuns──▶ RunSegment[]        (src/selection/runs.ts)
RunSegment ──projectRun──▶ ProjectedRun {text,pieces}  (src/selection/mapSelection.ts)
ProjectedRun.text + selectionActions ──props──▶ native SelectableRunHost
user selects, taps "Copy Text" or "Copy Markdown"
host ──onSelectionAction {start,end,action,selectedText}──▶ JS
JS ──handleSelectionAction──▶ payload                  (src/view/selectionActions.ts)
      ├─ mapSelectionToSource ─▶ SourceSpan            (src/selection/mapSelection.ts)
      ├─ markdown = doc.source.slice(span)          (a pure slice; see below)
      └─ plain = the display slice the user selected
onSelectionCopy({action, plain, markdown, span})
```

Link taps use the same shape: `resolveRunPressables` derives tappable ranges
from the link marks, the host hit-tests taps, and
`onInlinePress {start, end, pressableId}` comes back to JS, which resolves the
id to the href. The URL never crosses the bridge.

The host never sees markdown. It receives projected text and reports offsets
into it; JS maps back to source through the run's piece table.

### Runs and standalone blocks

A run is a maximal sequence of adjacent flowing blocks merged into one
selectable unit. Every other block is `standalone: true` and gets its own
selection scope. A third mode sits between them: an **embedded** node (the
`embed` prop) flows through its run as one U+FFFC placeholder with a
consumer-rendered view overlaid on space the host reserves; see
"Event: `onEmbedLayout`" below. An embed claim is consulted before
everything that follows and always means *flowing*.

`classifyBlock` (`src/selection/runs.ts`) decides, in order:

1. A consumer claim from the `classifyBlock` prop wins. It is called for
   inline nodes too; claiming an inline makes its block standalone.
2. A kind outside `PROSE_KINDS` is standalone. The allowlist is `paragraph`,
   `heading`, `blockquote`, `list`, `codeBlock`, `table`, `thematicBreak`,
   `htmlBlock`. Code blocks, tables and rules flow because the projection
   carries their text and the host paints their chrome through
   `decorations`. An allowlist means an unclassified kind gets its own
   scope, which is the safe failure.
3. A prose block containing a `VIEW_KINDS` node is standalone. `VIEW_KINDS`
   is `image` (flowing one would delete the picture and leave the alt text)
   and `spoiler` (it owns a tap target, and inside a run there is nothing to
   reveal it).

A flowing sequence of nothing but thematic breaks demotes to standalone runs,
so every non-standalone run projects non-empty text.

### Projection

`projectRun` flattens a run to display text deterministically. Every piece
carries a `SourceSpan` or `source: null` for synthetic glyphs. The glyph
contract is normative and lives in `src/selection/mapSelection.ts`:

| Construct | Projected text |
| --- | --- |
| Between sibling blocks (including inside blockquotes) | `\n\n` |
| Between list items, between a list item's child blocks, and between table rows | `\n` |
| Between table cells | `\t` |
| Unordered list item marker | `• ` |
| Ordered list item marker | `<n>. ` (computed from `start`) |
| Task list item marker (replaces the bullet) | `☑ ` / `☐ ` |
| Hard break (`  \n`, `\\\n`) | `\n` |
| Soft break (a wrapped source line) | `' '` (one space) |
| Thematic break | empty (chrome only) |
| Blockquote | no quote glyph, children only |
| Embedded node (an `embed` claim) | `￼` (U+FFFC, one character, mapped to the node's whole span) |

Separators are fixed constants. Bullet and task glyphs are the defaults of
`theme.glyphs`; `projectRun` accepts `{ glyphs }` overrides and the view
re-projects when a glyph changes, so themed markers still map back exactly.

A soft break projects as a space, as CommonMark renders it. Two newlines are
content rather than breaks: an entity decoding to a newline, and a `$…$`
math node spanning a line break under `presets.everything`.

`conformance/selection/projection-oracle.test.ts` holds this table over the
CommonMark 0.31.2 suite and every fixture, plus piece tiling, span bounds and
`markdown === source.slice(span)`.

The host must render exactly the projected text, styled from
`ProjectedRun.marks` via `src/view/runAttributes.ts`. Styling never moves an
offset. Standalone blocks render through `src/view/renderers.tsx` as a nested
`<Text>` tree, which exposes no offsets, so its divergences cannot corrupt
mapping.

## Native component

- Name: `SelectableRunHost`, declared once in
  `src/view/SelectableRunHostNativeComponent.ts`
  (`codegenNativeComponent<NativeProps>('SelectableRunHost')`). Never add an
  `RCT` prefix; the C++ registry strips one and the two sides would look each
  other up under different keys.
- iOS: `platform/ios/SelectableRunHostView.swift`, a `UITextView` host,
  mounted by `RCTSelectableRunHostComponentView` as its `contentView`.
- Android: `SelectableRunHostView.kt`, a `FrameLayout` around a child
  `TextView`, registered by `SelectableRunHostViewManager` via
  `SelectableMarkdownPackage`.
- No fallback. Where the component is not linked, `RunHost.tsx` throws with
  the missing build step. `<Text selectable>` was not a substitute: on
  Fabric iOS it is a long-press whole-block Copy menu with no range and no
  offsets. Parsing throws the same way without the native module; see
  [NATIVE.md](NATIVE.md).

### How `RunHost` resolves the component

The probe is `UIManager.hasViewManagerConfig`, in a bare `catch` because its
bridgeless implementation throws a string before the registry global exists.
`getViewManagerConfig` would report a linked Fabric component as missing.
If the name is registered the codegen spec is used; otherwise `RunHost`
throws. There is no `requireNativeComponent` tier.

### Status

Both hosts are implemented, for Fabric only. Codegen output, the C++ and
Swift compiles and every JS behaviour here are gated by scripts
(`check:codegen`, `check:fabric-cpp`, `check:swift`, `jest`, `conformance`).
The Objective-C++ mounting layer, all Kotlin, `pod install`, the Android CMake
integration, view recycling and measure/draw agreement are reviewed, not
executed: this repository has no example app, simulator or Android SDK.
`FABRIC-PLAN.md` §8 and §9 list what is proven and the cut line.

Embeds inherit that split. The mapping side is executed: projection, piece
atomicity, copy payloads, and the corpus-scale embed sweep in the projection
oracle. Everything rendered is reviewed only: the reservation inside a
line-height-pinned line, selection over the placeholder, `onEmbedLayout`
delivery and its dedupe, recycling of embed state, overlay z-order against
the selection highlight (the highlight paints in the text view, the card
above it), gesture arbitration on the card, VoiceOver/TalkBack on U+FFFC, and
RTL x-coordinates. That is the first list to work through when an example
app exists.

Custom menu items need iOS 16 (`textView(_:editMenuForTextIn:suggestedActions:)`).
From the podspec floor (13.4) to 15.x, `selectionActions` is accepted, no
custom item renders, `onSelectionAction` never fires, and the system Copy
works.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `text` | `string` | `ProjectedRun.text`. Rendered verbatim. |
| `attributes` | `object[]` | Styled ranges `{ start, end }` plus any of `fontFamily`, `fontSize`, `lineHeight`, `fontWeight`, `fontStyle`, `textDecorationLine`, `color`, `backgroundColor`. Sparse, ordered outermost-first so the innermost wins. Colours are `processColor` integers. |
| `decorations` | `object[]` | Block chrome `{ start, end, kind }` plus styling, from `resolveRunDecorations`. Geometric kinds, never moves a character. Older binaries ignore it. |
| `pressables` | `object[]` | Tappable ranges `{ start, end, pressableId }`, non-overlapping. `[]` when no `onInlinePress` listener exists. Older binaries ignore it. |
| `embeds` | `object[]` | Embedded ranges `{ start, end, embedId, width, height }`, each the single U+FFFC placeholder an `embed` claim projected (`end === start + 1`). The host reserves `width` × `height` points there — an `NSTextAttachment` on iOS, a `ReplacementSpan` on Android, both applied inside the shared string builder so measurement and drawing agree — and reports the rect through `onEmbedLayout`. The height also rides `attributes` as a `lineHeight` over the placeholder, never smaller than the covering attributes already give the line. Host guards: positive size, 1-unit range, the character really is U+FFFC; a stale entry reserves nothing. Layout-affecting, so sent whenever embeds exist, not gated on a listener. Older binaries ignore it: the placeholder is an invisible one-character gap (transparent colour via `attributes`), no overlay mounts, mapping stays exact. |
| `selectable` | `boolean` | Whether platform selection UI is enabled. Driven by the tail policy. |
| `selectionActions` | `string[]` | Ordered identifiers (`'copy-text'`, `'copy-markdown'`) for custom menu items. Default both. `[]` when no `onSelectionAction` listener exists. Unknown identifiers are ignored. |
| `testID` | `string?` | Standard RN test handle. |

Decoration kinds:

- **`'box'`.** A rounded rect behind a range's lines, full width less an
  optional `inset`. Code block background, table border and header band,
  blockquote fill and bar.
- **`'rule'`.** A horizontal line at a zero-length anchor. Thematic breaks
  and table row separators.
- **`'columns'`.** Tab-stop alignment for tab-separated rows, plus
  `rowPaddingV`, interior padding at every row boundary.
- **`'indent'`.** List indentation: first lines start at `textInset` (one
  `listIndent` per level), wrapped lines `hang` deeper. Ranges are disjoint
  because Android margin spans sum where iOS paragraph styles assign.

Paint order is fills, blockquote bars, strokes, all behind the text and the
selection highlight. Layout-affecting parts (`textInset`, tab stops,
`'indent'`) are applied in the shared string builder, so measurement sees
what drawing does.

`RunHostProps.style` is a `ViewStyle`. Text properties there do nothing;
typography comes from `attributes`. `lineHeight` is on the wire because the
shadow node measures the string the view draws, and a line height the
measurer does not know about lays the run out at a height its text does not
fit. `resolveRunAttributes` sets it on the base run and on every heading,
always alongside the font size.

Without an `onSelectionCopy` handler no custom items are offered. The host
never writes the clipboard; the app does. The system Copy always works.

## Event: `onSelectionAction`

Fired when the user taps Copy Text or Copy Markdown in the platform
selection menu.

```ts
interface SelectionActionEvent {
  start: number;        // UTF-16 offset into the CURRENT `text`
  end: number;          // end-exclusive; start <= end
  action?: 'copy-text' | 'copy-markdown';
  selectedText: string; // text.slice(start, end), computed natively
}
```

Host guarantees, both platforms:

1. Offsets are UTF-16 code units into the current `text`, end-exclusive,
   the same unit as `SourceSpan`.
2. Offsets are clamped to `[0, text.length]` and ordered; reversed
   selections are normalized.
3. Empty selections are never emitted.
4. Offsets land on grapheme boundaries (the platform widgets only place
   endpoints there). JS still clamps defensively.
5. Offsets refer to the text as currently set, never a stale text after a
   prop swap.
6. `action` is the identifier from `selectionActions` verbatim. It is
   optional for version skew: `handleSelectionAction` normalizes a missing
   or unknown value to `'copy-markdown'`.

`selectedText` is informational; the mapping is JS-side.

## Event: `onInlinePress`

Fired when a single tap lands inside a `pressables` range. The run is one
platform text view, so this event is how links inside it are tappable.

```ts
interface InlinePressEvent {
  start: number;       // pressed range, UTF-16 into the CURRENT `text`,
  end: number;         // end-exclusive, clamped. Informational.
  pressableId: number; // JS's identifier for the range, echoed verbatim
}
```

A live link carries a `link` mark. A blocked link carries a `blockedLink`
mark with its href, no default styling, and a pressable flagged
`blocked: true`, so `onLinkPress` still hears it. A still-streaming
`incomplete` link carries no mark and no press.

Host guarantees, both platforms:

1. Only single taps inside a pressable range are intercepted. Long-press and
   handle drags are never contested. iOS refuses the touch in
   `gestureRecognizer(_:shouldReceive:)`; Android's detector only observes
   the stream the `TextView` processes anyway.
2. Taps past a line's end or below the last line are rejected, bounded by
   glyph and line geometry rather than nearest-character APIs.
3. Offsets are clamped against the current `text`; an empty clamped range is
   not emitted.
4. `pressableId` is echoed verbatim. JS bounds-checks unknown ids, which
   absorbs a tap racing a prop swap.

Version skew degrades both ways: an older binary never emits, an older JS
sends no `pressables`.

## Event: `onEmbedLayout`

Fired per embed after layout, with the reserved rect in the host view's
coordinate space, so JS can position the consumer's view over it. One event
per embed with a scalar payload: an array-of-objects payload is not
verifiably supported by codegen, and per-embed events avoid cross-id
coalescing (`canCoalesce()` is `false`, like the other events; the dedupe
lives in the host).

```ts
interface EmbedLayoutEvent {
  embedId: number; // JS's identifier for the embed, echoed verbatim
  x: number;       // reserved rect, host-view points
  y: number;
  width: number;
  height: number;
}
```

Host guarantees, both platforms:

1. Rects come from the layout the host draws with: iOS
   `glyphRange(forCharacterRange:)` + `boundingRect(forGlyphRange:in:)` on
   the shared TextKit stack; Android the `TextView`'s own `Layout`, anchored
   on the line top rather than the baseline.
2. A rect is re-emitted only when it moved (> 0.5pt in any component), per
   `embedId`. Streaming appends past a settled embed re-announce nothing.
3. The range is one unit and the character is U+FFFC, verified before
   reporting exactly as before reserving.
4. `embedId` is echoed verbatim. JS bounds-checks it against the list it
   sent and drops rects reported against a previous projection (ids are
   per-projection ordinals).

The host never learns what an embed is. JS keeps the node, the render
function and the copy text; the host gets ranges, sizes and ids and hands
back geometry — the `pressables` division of knowledge.

The overlay is a **sibling** of the host, absolutely positioned by
`SelectableMarkdown` inside a relatively positioned wrapper, never a child:
the native component is a leaf on both platforms. So a card appears one
frame after its run first lays out, into space that was reserved natively
from the first frame — no reflow. While the run is the unsettled streaming
tail no overlay mounts at all; the reservation still does, so the card
appears without a reflow when the run settles. A long-press on the card
starts no selection; the sweep starts on the prose around it.

## `handleSelectionAction`

`src/view/selectionActions.ts` exports the unit-tested core the view routes
every native event through:

```ts
handleSelectionAction(doc, run, {start, end, action}, ctx?)
  -> { action, plain, markdown, span } | null
```

- `plain` is exactly `ProjectedRun.text.slice(start, end)`, synthetic glyphs
  included: what the platform's own Copy would produce. Not a reparse.
- `markdown` is the exact source slice of the mapped span.
  `mapSelectionToSource` skips synthetic glyphs, bridges interior ones, and
  pins entity-decoded text to whole nodes. The slice is taken directly;
  `buildCopyPayload` (`src/selection/copy.ts`) is not called, because its
  `plain` reparses the slice and this path already has the projection. It
  stays public for callers that want both halves.
- Returns `null` for an empty, out-of-range or glyph-only selection. Never
  throws mid-gesture.
- `ctx` is `{ projected?, glyphs? }`: an optional precomputed projection and
  the theme's glyph overrides, so mapping uses the projection that is on
  screen. `<SelectableMarkdown>` passes both.

The system Copy item is never intercepted, reordered or removed.
`'copy-text'` exists so apps can observe plain copies or write richer
clipboard items through the same event path; `['copy-markdown']` alone is
a fine configuration.

## Selection preservation across text swaps

Streaming re-sets `text` on every snapshot. The two platforms differ.

### iOS: preserve and clamp

`UITextView` uses TextKit 1, built on the `RNSMTextKitStack` container the
shadow node also measures with, not `UITextView(usingTextLayoutManager:
false)`, whose `usesFontLeading` default would disagree with the measured
height. TextKit 2, the iOS 16+ default, drops the selection UI on
backing-store swaps.
`apply(attributedText:)` picks one of three paths, cheapest first:

- **Equal input.** New string equals the current storage: early return,
  nothing touched.
- **Append fast path.** New string is longer and its prefix equals the
  current storage (`attributedSubstring(from:).isEqual(to:)`, an O(prefix)
  compare with no shaping). Only the suffix is spliced in, so TextKit
  relayouts only the new tail, and a selection or caret in the prefix stays
  valid by construction.
- **Full swap.** Anything else (a shrink, or a prefix change). Save
  `selectedRange`, swap, restore clamped to the new length.

A selection covering the whole old text keeps meaning "all of it" on both
mutating paths: restored to the whole new text after a swap, extended over
the appended tail on the fast path.

### Android: no preservation, and a known gap

`TextView#setText` drops the selection and dismisses the action mode; there
is no reliable preservation path, so the host does no restore. The tail run
is `selectable={false}` until it settles, which covers the run whose text is
obviously moving.

It does not cover settled prose. `segmentRuns` merges each newly settled
block into the same run (keyed `run:${span.start}`), so the mounted view's
`text` grows while `selectable` is true. Text changes on Android-selectable
runs, streaming each fixture in 5-character chunks under `presets.llmChat`:

```
assistant-overview.md  5    code-walkthrough.md   6
comparison-table.md    4    currency-and-links.md 4
emoji-i18n.md          6    mixed-longform.md     9
pipes-in-prose.md      7    task-plan.md          5
```

So a selection in settled prose dies four to nine times per streamed
message (measured 2026-09-01 against the current code; the count rose when
code blocks and tables started flowing into prose runs).
Offsets are never wrong, but selecting while streaming fails on Android
whenever a block settles.

Two candidate fixes, neither executable in this repository:

1. Stop merging a newly settled block into an already-settled run. That
   changes run identity and every piece table, and needs its own pass over
   the streaming prefix oracle.
2. Restore the range with `Selection.setSelection` on the new `Spannable`.
   That restores the selection but not the dismissed `ActionMode`, so it is
   partial, and there is no Android SDK here to find out how partial.

## View recycling (Fabric)

Fabric pools component views and hands a used one to a different run. A host
that kept its selection and edit menu would let the user tap "Copy Markdown"
on stale handles: valid offsets, mapped through the new run's piece table, a
well-formed payload of markdown the user never selected.

So a host handed to a new run carries nothing of the old one. iOS
`prepareForRecycle` clears attributed text, zeroes `selectedRange`, resigns
first responder, dismisses any edit menu and calls `super`, which clears the
event emitter (the host must not cache it). Android does the same in
`ViewManager.prepareToRecycleView`, on top of the detach-time discipline
(action mode finished, custom callback uninstalled).

Embed state joins that guarantee: both hosts clear their per-embed
rect-dedupe ledgers on recycle (and whenever `embeds` changes), because a
host that considered the previous run's rects already reported would never
re-report for the new one. JS is defensive independently: rects belong to
the projection they were reported against, and an unknown `embedId` is
dropped.

Recycling is only reachable in a running app, so it is reviewed, not run.

## Tail policy (streaming)

Blocks past `settledUntil` form the tail run, the only run whose text still
changes. `segmentRuns` emits tail runs `selectable: false` by default; the
view applies its platform policy:

| Platform | Tail policy | Why |
| --- | --- | --- |
| iOS | Selectable | The host preserves selection across swaps; a selection in the repaired region clamps as text grows. |
| Android | `selectable={false}` until settled | `setText` drops selection and action mode; a selection that dies on every chunk is worse than a briefly non-selectable tail. |

The settled portion is always selectable mid-stream on both platforms.

Selections never span hosts. Both hosts keep a process-wide weak registry of
live instances and, on any non-empty selection change, clear every other
host's selection (Android also finishes its action mode). The clear arrives
as an empty-selection change, so it does not recurse.

Code blocks, tables and rules flow through prose runs, so one gesture selects
across them. A block is a separate scope only when a nested image or
spoiler, or a `classifyBlock` claim, makes it standalone. An `embed` claim
runs the other way: it keeps a custom-rendered view *inside* the run (one
placeholder character, reserved space, overlaid view), so a citation card no
longer costs the sweep. Selecting across an embed is atomic — the
placeholder is one character whose piece maps to the node's whole source
span, so any sweep that covers the card copies the card's exact markdown.

### What a standalone block does and does not get

Standalone runs do not go through `RunHost`. A code block renders as
`<Text selectable>` inside its chrome; a table as a flex layout of per-cell
`<Text selectable>`. A standalone prose block renders through `renderBlocks`,
whose renderers set `selectable` themselves. Inside a run that prop is inert:
a nested `<Text>` is `RCTVirtualText`, whose view config does not list
`selectable`, so it cannot override the Android tail policy.

| | Prose run | Embedded node | Standalone prose block | Code block (claimed) | Table (claimed) |
| --- | --- | --- | --- | --- | --- |
| Selectable | yes | yes, atomically in its run | yes | yes | yes, per cell |
| Own selection scope | yes | no, flows through its run | yes | yes | yes, per cell |
| System Copy | yes | yes (yields U+FFFC for the card) | yes | yes | yes |
| `selectionActions` / `onSelectionCopy` | yes | yes, via its run | no | no | no |

"Copy Markdown" is a prose-run feature, which covers code blocks, tables and
rules by default, and embedded views with them. Blocks that end up standalone
copy their displayed text through the platform Copy. Routing standalone
blocks through a host of their own is roadmap work. An `embed` claim is the
middle way: the card keeps its own touches inside its own bounds while the
run around and under it keeps selection.

## Sizing

`RNSMRunHostShadowNode::measureContent` computes the run's height on the
layout thread before the frame commits, so the first frame is the correct
frame. It measures through `RNSMRunTextMeasurer`
(`platform/fabric/RNSMRunTextMeasurer.h`), one implementation per platform:

- **iOS.** `platform/ios/fabric/RNSMRunTextMeasurer.mm` measures with
  TextKit 1 in process. `prepareContent` returns the exact
  `NSAttributedString` the view draws, carried to the mounting layer through
  Fabric state (`RNSMRunHostState`).
- **Android.** `android/src/main/jni/RNSMRunTextMeasurer.cpp` crosses JNI
  to `FabricUIManager.measure()`, which routes by component name to
  `SelectableRunHostViewManager.measure` and lands in `RunTextMeasure.kt`,
  the one place a run's paint is configured and its `StaticLayout` built.
  The `TextView` draws through the same file; `TEXT_SIZE_SP` is the base
  size when the run carries none.

The old-architecture host measured after layout, so every run rendered at
least one frame at the wrong height, continuously during streaming. That is
why the Fabric port exists (`FABRIC-PLAN.md` §1 and §4).

Two properties are contract:

- **Measure the exact string the view draws.** One string builder and one
  text-engine configuration per platform, shared by measurer and view. A
  mismatch shows as text clipped at the bottom of a run.
- **A clone with unchanged props and children keeps its clean layout.**
  Otherwise appending one token would re-measure every run in the document.

## Android layout cache and spannable handoff

`RunLayoutCache` (`android/src/main/java/com/selectablemarkdown/RunLayoutCache.kt`,
internal) memoizes the measure path and the UI-thread `commitProps` rebuild:

- Built styled `Spannable`s: key to `Spannable`, LRU 128.
- Measured Yoga outputs (the packed `Long` from `YogaMeasureOutput.make`):
  key plus `(width, widthMode, height, heightMode)` to `Long`, LRU 256. The
  full constraint tuple is the key, as in React Native's TextMeasureCache.

The key is run text, attributes, decorations, a display-metrics token
(density and scaledDensity from `DisplayMetricsHolder`) and the default
locale's language tag, so a font-scale, density or locale change misses by
construction. There is no explicit invalidation.

Sharing the cached `Spannable` between the layout thread and the `TextView`
is safe because `TextView.setText` copies a `Spanned` input, so selection
spans land on the widget's private copy. `RunTextMeasure` uses a per-thread
scratch `TextPaint`.

Deferred and unbenchmarked: `BoringLayout`, `PrecomputedText`, and a per-key
`desiredWidth` memo.

## Platform hardening

Android:

- `TextClassifier.NO_OP` (API 26+): avoids per-selection service binding and
  a known OEM NPE.
- Custom action-mode items are added in `onPrepareActionMode`, remove-first,
  so repeated prepare calls converge without duplicates. System ids are
  never touched.
- Item ids are `0x534D01`/`0x534D02`, which cannot collide with OEM or
  `ACTION_PROCESS_TEXT` ids.
- A `selectionActions` change while the menu is open calls
  `ActionMode#invalidate()`.
- `dispatchTouchEvent` catches the Samsung selection-handle
  `IndexOutOfBoundsException` family.
- On detach the action mode is finished and
  `customSelectionActionModeCallback` uninstalled.

iOS:

- TextKit 1 keeps selection geometry stable across swaps.
- Custom actions are appended via `textView(_:editMenuForTextIn:suggestedActions:)`
  (iOS 16+) in `selectionActions` order, with stable identifiers
  (`selectable-markdown.copy-text` / `.copy-markdown`). Pre-16 gets the stock
  menu only.
- Nothing is emitted for empty ranges; every range is clamped against the
  current text.

## Offsets end to end

1. **Source UTF-16.** `SourceSpan` on every AST node. md4c works in UTF-8
   bytes; `platform/cpp/OffsetParser` converts, so spans cross into JS
   already UTF-16.
2. **Projected-text UTF-16.** What the host sees and reports. `RunPiece`
   records the correspondence to source offsets.
3. **Clipboard.** `markdown` is byte-for-byte the source slice; `plain` is
   byte-for-byte the display slice.
