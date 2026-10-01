# Selection: the JS/native host contract

Every character the user can select maps back to an exact UTF-16 range of the
markdown source. This document is the contract between the JS layer and the
native host views that makes that true. Usage of `selectionActions`,
`onSelectionCopy`, `onSelectionChange`, `onLinkPress` and `classifyBlock` is
in the README; session mechanics are in [STREAMING.md](STREAMING.md).

## Pipeline

```
ParsedDocument ──segmentRuns──▶ RunSegment[]        (src/selection/runs.ts)
RunSegment ──projectRun──▶ ProjectedRun {text,pieces,marks,extents}
                                                   (src/selection/mapSelection.ts)
ProjectedRun.text + selectionActions (id, optional title)
                            ──props──▶ native SelectableRunHost
user selects, taps a selectionActions item
host ──onSelectionAction {start,end,action,selectedText}──▶ JS
JS ──handleSelectionAction──▶ payload                  (src/view/selectionActions.ts)
      ├─ mapSelectionToSource ─▶ SourceSpan            (src/selection/mapSelection.ts)
      ├─ markdown = doc.source.slice(span)          (a pure slice; see below)
      └─ plain = the display slice the user selected, embeds substituted
onSelectionCopy({action, plain, markdown, span})
```

Both stages take an incremental seam, because a settled run grows by one block
per settle and redoing either from scratch is quadratic over a stream.
`segmentRuns(doc, { maxRunChars })` caps a flowing run's source extent
(`DEFAULT_MAX_RUN_CHARS`, 8000; `Infinity` opts out; `<SelectableMarkdown>`
takes a `maxRunChars` prop that forwards to it), so a very long document
becomes several hosts instead of one growing one. The cap only ever breaks
merging BETWEEN top-level blocks, so a single block longer than it — a long
list, a long fenced block — is still one oversized run.
`projectRun(run, doc, { previous })` extends the projection of a prefix of
the same run instead of redoing it: `previous.blocks` must be an identity
prefix of `run.blocks`, and the caller owns the rest of the key — the glyphs
and the embed lookup, which `createRunProjectionCache`
(`src/view/projectionCache.ts`) holds together.

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

`classifyTopLevelBlock` (`src/selection/runs.ts`) decides, in order:

1. A consumer claim from the `classifyBlock` prop wins. It is called for
   inline nodes too; claiming an inline makes its block standalone.
2. A kind outside `PROSE_KINDS` is standalone. The allowlist is `paragraph`,
   `heading`, `blockquote`, `list`, `codeBlock`, `table`, `thematicBreak`,
   `htmlBlock`. Code blocks, tables and rules flow because the projection
   carries their text and the host paints their chrome through
   `decorations`. An allowlist means an unclassified kind gets its own
   scope, which is the safe failure.
3. A prose block containing a `VIEW_KINDS` node is standalone. `VIEW_KINDS`
   is `image` and `spoiler`. The image half is now the FALLBACK, not the
   usual path: the view claims image nodes as embeds by default
   (`images: 'embed'`, `src/view/imageEmbeds.ts`), so a sole image in a top-level paragraph
   flows — one placeholder, a `spacing.imageWidth` × `spacing.imageHeight`
   reservation, the `image` renderer overlaid on it. What still reaches rule
   3 is what no claim covered: `images: 'standalone'`, a theme box that is
   not a positive finite size, a synthetic or still-streaming image
   (`embedContentFor` refuses both), and a caller driving `segmentRuns` with
   no embed lookup — for those, flowing the image would delete the picture
   and leave the alt text. `spoiler` stays standalone for the gesture reason
   (it owns a tap target, and inside a run there is nothing to reveal it)
   and because an embed reserves one fixed box at a single placeholder,
   which cannot wrap, so a multi-line spoiler cannot be expressed as one.

Built-in image embeds draw at the theme's box. Only sole images in top-level
paragraphs are claimed; inline images and images inside containers retain
standalone layout. Custom claims may opt into other placements.

A flowing sequence whose blocks ALL project no text demotes to standalone
runs, so every non-standalone run projects non-empty text. It is not only the
pathological `---`-only document: a lone rule, an empty or still-unterminated
` ``` ` fence, a bare `> `, an empty heading and a link with empty text all
project the empty string, and the first three are ordinary streaming
prefixes. The test is a walk (`projectsText` in `src/selection/runs.ts`), so
the emptiness may be nested — `> ***` demotes too. An embedded block is
exempt: it projects a placeholder, so its run is not empty. The corpus gate
is the "every flowing run projects non-empty text" case in
`conformance/selection/projection-oracle.test.ts`.

Merging is also what flattens the document's structure for a screen reader.
A run is one platform text view, so the roles `renderers.tsx` sets
(`accessibilityRole="header"`, `accessibilityRole="link"`) run for standalone
blocks only. Four constructs are put back on the wire and consumed by both
hosts: every link range crosses as `pressables`, and heading, list-item and
table-cell ranges cross as `role` on their attribute entries — a heading with
`roleLevel`, a list item with its nesting depth in `roleLevel` and its
position in its own list in `roleRow`/`roleRowCount`, a table cell with
`roleRow`/`roleRowCount`/`roleColumn`/`roleColumnCount`. All one-based; row 1
of a table is its header row. A list item's range is its OWN text: it stops
where a nested sublist or table begins, separator trimmed, so both hosts vend
exactly one element per item and nothing is announced twice. Before that
narrowing, iOS's attribute-run walk returned the parent's value over its
children's ranges — the sublist's focus stops were lost — while Android
vended the parent AND its children, so the sublist was read twice. See
"Native component" for what each host does with them.

Still flattened: code-block structure and blockquote nesting. Neither
platform has a primitive for those, so announcing them would mean shipping
English role words this library cannot translate. `RunSemanticRole` in
`src/view/runAttributes.ts` is where a future role goes. The content itself
is never lost — both hosts read the run's whole text; on Android a vended
range is read twice (the `TextView` announces the whole run and each virtual
view then repeats its own range), which is the trade for keeping the
widget's granular navigation, and which iOS avoids by eliding the covered
ranges.

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
| Task list item marker (replaces the item's whole marker, in ordered lists too) | `☑ ` / `☐ ` |
| Hard break (`  \n`, `\\\n`) | `\n` |
| Soft break (a wrapped source line) | `' '` (one space) |
| Thematic break | empty (chrome only) |
| Blockquote | no quote glyph, children only |
| Embedded node (an `embed` claim) | `￼` (U+FFFC, one character, mapped to the node's whole span) |

Separators are fixed constants. Bullet and task glyphs are the defaults of
`theme.glyphs`; `projectRun` accepts `{ glyphs }` overrides and the view
re-projects when a glyph changes, so themed markers still map back exactly.
A task item in an ordered list loses its ordinal: `1. [x] done` projects
`☑ done`, not `1. ☑ done`. The number is still in the source, so copying the
item yields it.

A soft break projects as a space, as CommonMark renders it. Two newlines are
content rather than breaks: an entity decoding to a newline (`a&#10;b`
projects `a\nb`), and the line breaks inside a fenced code block's literal. A
line break inside a `$…$` math span or a `` `…` `` code span is NOT one of
them: md4c reports it as a space, so `x $a\nb$ y` projects `x a b y`.

Alongside `text`, `pieces` and `marks`, a projection carries
`extents?: ProjectedExtent[]` — `{start, end, source}` for each construct
whose SOURCE holds characters its projection does not show, outermost first,
absent when the run has none. It is what `mapSelectionToSource` unions back
in for a whole-construct selection (see `handleSelectionAction`), and it is
recorded only where it changes an answer: a construct whose pieces already
reach both ends of its span — plain prose, an HTML block whose literal is its
source — records nothing.

`conformance/selection/projection-oracle.test.ts` holds this table over the
CommonMark 0.31.2 suite and every fixture, under both `presets.llmChat` and
`presets.everything`, along with:

- piece tiling and span bounds;
- copy returns exactly the mapped source slice, and loses nothing swept: the
  letters and digits a run SHOWED for real source (synthetic marker glyphs
  excluded) have to appear in `payload.plain` in order, over 89,259
  selections under `llmChat` and 84,887 under `everything`. Three
  exclusions, each of them "the slice means something else standing alone":
  a selection touching a code span, a code block or raw HTML, and a slice
  that opens an HTML block, a code fence or a link reference definition. It
  is falsifiable: shifting every mapped span by one character turns 0
  violations into 63,388;
- every LINEAR piece displays the source it is pinned to character for
  character, with only the six one-for-one substitutions the test's
  `PROJECTED_SUBSTITUTIONS` permits (a soft break's `\n` and `\r` → space,
  both smart-quote pairs, NUL → U+FFFD, and `\t` → space for an indented
  code block's leftover indent) and a ceiling on indivisibly pinned source
  characters;
- a whole-block selection maps to a span COVERING that block's own source
  span;
- a whole-block copy round-trip census, which measures the remaining loss
  rather than asserting it away.

The reparse property — "the markdown re-parses to the same visible text as
the selection" — is false for a PARTIAL selection, and the oracle does not
imply it. A construct a sweep covers whole does copy back:
`mapSelectionToSource` unions the covering extents in, so selecting all of
`1. first\n2. second` copies `1. first\n2. second`, while a sweep that starts
inside the first item copies `first\n2. second`. Today the census stands at
696 of 761 corpus blocks copying back as themselves under `llmChat` (up from
493 before construct extents), and 603 source characters are pinned
indivisibly across 90 non-linear pieces (628 over 99 under `everything`).
Both were reproduced against the current working tree on 2026-09-03. Only
the CHARACTER total is gated, at a ceiling of 700: a piece count gates the
wrong direction, since splitting one large indivisible piece into several
small ones is the improvement wanted, and the old `nonLinear < 110` ceiling
stood eleven above the 99 the corpus produces. The piece counts are still
reported in the failure message, not asserted.

The host must render exactly the projected text, styled from
`ProjectedRun.marks` via `src/view/runAttributes.ts`. Styling never moves an
offset. Standalone blocks render through `src/view/renderers.tsx` as a nested
`<Text>` tree, which exposes no offsets, so its divergences cannot corrupt
mapping.

Each renderer FUNCTION is its own React component type, and so is each
`EmbedSpec.render`. That is what makes `renderers={editing ? draft : read}`
and a claim that switches `render` safe: the swap remounts instead of handing
the new function the previous one's hook list. The cost is the ordinary React
one — a renderer or a `render` written as an arrow literal inside JSX is a
new function every render, so it remounts its subtree every render. Give both
a stable identity: module scope, or `useMemo`/`useCallback`.

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
- Accessibility. Because there is no fallback, every link, heading, list item
  and table cell in flowing prose reaches a screen reader through the host.
  Both hosts read the run's text (a `UITextView`/`TextView` announces what it
  holds), and both put back the roles that cross the wire.

  iOS vends one `UIAccessibilityElement` per `pressables` range with the
  `.link` trait — focusable, and activating it emits the same `onInlinePress`
  a tap does — and one per semantic range: `.header` for a heading, plain
  `.staticText` for a list item and a table cell, because iOS has no trait
  for either and the alternative is shipping the English words. What those
  two buy there is granularity — one focus stop per item or cell instead of
  one for the whole run — and their positions are dropped, since nothing
  could say them. The elements are vended in DOCUMENT ORDER (sorted by
  character offset, ties to the longer range), behind the text view, which
  stays an element because the text-selection rotor lives on it. It no longer
  repeats what they say: `textView.accessibilityValue` is set to the prose
  BETWEEN the vended ranges, so each character is announced exactly once.
  That is safe because VoiceOver's text navigation and selection go through
  `UITextInput` against the real text, not the announced value.

  Android's `RunAccessibility.kt` installs an `ExploreByTouchHelper` on the
  child `TextView` exposing one virtual view per link range (announced as a
  button, `ACTION_CLICK` emitting the same `onInlinePress`), one per heading
  range (`setHeading(true)`, which TalkBack's heading navigation finds), and
  one per list item and table cell carrying `CollectionItemInfoCompat`
  (zero-based there, header-row cells flagged). The host `TextView` also gets
  a `CollectionInfoCompat` — what makes TalkBack say "item 2 of 5" and "row
  2, column 3" in the reader's own language — for the LARGEST grid in the
  run: `RunAccessibility.collectionOf` counts cells, breaks a tie on
  first-seen, and takes a shape only if its cells are all distinct and in
  bounds. Only that grid's nodes carry `CollectionItemInfoCompat`. A smaller
  collection beside it — a sublist next to a table — keeps its label and its
  focus stop but no position, rather than a position phrased against another
  collection's total. Declaring nothing whenever a run held two grids lost
  the total for exactly the merged-run shape this feature exists for. Android keeps the double read described above,
  because its node IS the widget whose real text carries granular navigation
  and selection.

  `roleLevel` crosses for both and is used by neither today — a heading's
  level and a list item's nesting depth alike — because no public primitive
  on either platform carries a rank: `UIAccessibilityTraits.header` is a bit,
  `AccessibilityNodeInfo.setHeading(true)` is a boolean, and
  `CollectionItemInfo`, where an item's depth would have to go, has no depth
  field. The only vehicle left is the announced label, and putting "heading
  level 2" there means shipping an English string this library cannot
  translate. It crosses anyway so that the day a primitive exists, consuming
  it is one change here and not a second wire change. A run with none
  of these ranges vends nothing and behaves exactly like the stock widget:
  iOS answers nil for `accessibilityElements`, and Android's delegate offers
  no node provider.
  Neither platform installs a movement method or a `ClickableSpan` — that
  would take over the widget's touch handling, which is the selection
  breakage this design exists to avoid — so the accessibility path is a
  separate channel rather than a side effect of the tap path.

  ALL OF IT IS MASKED by `accessible` or `accessibilityRole` on
  `<SelectableMarkdown>`'s container or on a `RunHost`: both are the
  platform's "this subtree is ONE element" switch, so the subtree collapses
  to a single label and the per-heading, per-item, per-cell and per-link
  elements underneath stop being reachable. Labelling the container is fine;
  making it accessible as a leaf is not, unless flattening is the point.

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
integration, view recycling, measure/draw agreement and the accessibility
elements and virtual views are reviewed, not executed: this repository has no
example app, simulator or Android SDK, and no screen reader has run against
either host here. `FABRIC-PLAN.md` §8 and §9 list what is proven and the cut
line.

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
| `attributes` | `object[]` | Styled ranges `{ start, end }` plus any of `fontFamily`, `fontSize`, `lineHeight`, `fontWeight`, `fontStyle`, `textDecorationLine`, `color`, `backgroundColor`, and the six semantic fields: `role` (`'heading' \| 'listItem' \| 'tableCell'`), `roleLevel`, `roleRow`, `roleRowCount`, `roleColumn`, `roleColumnCount` — every count and index an int, one-based, 0 the absent sentinel. A `listItem` entry covers the item's OWN text and stops where a nested sublist or table begins, so each item is exactly one element on both hosts. Sparse, ordered outermost-first so the innermost wins. Colours are `processColor` integers. `role` is not reachable from `attributeForMark`: a styling hook may restyle a heading and may not stop it being one. The semantics cost one extra entry per list item and per table cell on every streamed snapshot, each carrying a role and two or four small integers and no styling — which is why the role set stays this small. |
| `decorations` | `object[]` | Block chrome `{ start, end, kind }` plus styling, from `resolveRunDecorations`. Geometric kinds, never moves a character. Older binaries ignore it. |
| `pressables` | `object[]` | Tappable ranges `{ start, end, pressableId }`, non-overlapping. The non-overlap is ENFORCED, not assumed: overlapping link marks do occur — md4c parses `[<https://a.com>](https://b.com)` as a link whose text is an autolink, and the projection emits a mark for each — and `resolveRunPressables` drops a range starting inside one already kept, so the first in mark order survives, which is also what both hosts' "first containing range" hit test would have chosen. `[]` when no `onInlinePress` listener exists. Older binaries ignore it. |
| `embeds` | `object[]` | Embedded ranges `{ start, end, embedId, width, height }`, each the single U+FFFC placeholder an `embed` claim projected (`end === start + 1`). The host reserves `width` × `height` points there — an `NSTextAttachment` on iOS, a `ReplacementSpan` on Android, both applied inside the shared string builder so measurement and drawing agree — and reports the rect through `onEmbedLayout`. The height also rides `attributes` as a `lineHeight` over the placeholder, never smaller than the covering attributes already give the line; the Android host re-decodes that height in DIP (the box's unit) rather than SP and applies `max(height, tallest covering line height)` in pixels, so the reserved band and the reported rect keep their size under a system font scale other than 1.0. iOS is points on both halves. Host guards: positive AND FINITE size, 1-unit range, the character really is U+FFFC; a stale entry reserves nothing. JS drops a claim whose declared size is not positive and finite before sending, and a dropped claim does not renumber the others — `embedId` is the entry's index into `ProjectedRun.embeds`, not its index in the array on the wire. Layout-affecting, so sent whenever embeds exist, not gated on a listener. Older binaries ignore it: the placeholder is an invisible one-character gap (transparent colour via `attributes`), no overlay mounts, mapping stays exact. |
| `selectable` | `boolean` | Whether platform selection UI is enabled. Driven by the tail policy. |
| `exclusiveSelection` | `boolean` | Whether this host takes part in the process-wide one-active-selection coordination. Defaults to true on the wire (`WithDefault<boolean, true>`), which is the behaviour that predates the prop. See "Tail policy". |
| `selectionActions` | `string[]` | The custom menu items, in menu order — the order IS the menu order. On the wire each entry is `id` or `id + U+001F + title`; at the `SelectableMarkdown`/`RunHost` level the prop takes `(string \| { id, title? })[]`. Default: both built-ins. `[]` when no `onSelectionAction` listener exists. A bare id takes the host's own localised title, which exists for `'copy-text'` and `'copy-markdown'` only; an id the host cannot title — unrecognised, and no title sent — is dropped rather than rendered blank, which is also the forward-compatibility rule for a newer JS bundle on an older binary. The encoder drops an entry whose id is empty or contains U+001F. |
| `testID` | `string?` | Standard RN test handle. |

`RunHost` also takes `unsettledTail` (`boolean?`), which is JS-only and never
sent: it is true while the run still contains unsettled streaming content,
and it OVERRIDES `selectable` per platform — `const effectiveSelectable =
unsettledTail ? Platform.OS === 'ios' : selectable`.
`<SelectableMarkdown>` passes `streaming && run.span.end > settledUntil`; a
host rendering runs directly and leaving it unset gets `selectable` verbatim
and owns the tail policy itself. Its ref is a `RunHostHandle`, not the native
view; see "Commands".

Decoration kinds:

- **`'box'`.** A rounded rect behind a range's lines, full width less an
  optional `inset`. Code block background, table border and header band,
  blockquote fill and bar.
- **`'rule'`.** A horizontal line at a zero-length anchor. Thematic breaks
  and table row separators.
- **`'columns'`.** Tab-stop alignment for tab-separated rows, plus
  `rowPaddingV`, interior padding at every row boundary.
- **`'indent'`.** Paragraph insets for lists and blockquote bodies:
  `textInset` is `quoteDepth × (quote.barWidth + quote.indent) +
  (level − 1) × listIndent`, so a top-level list item contributes nothing
  from the list term, and `hang` is one `listIndent` inside a list and 0
  outside it. Emitted for a blockquote body at `level === 0` too, so the body
  clears the bar. Ranges are disjoint because Android margin spans sum where
  iOS paragraph styles assign.

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

Without an `onSelectionCopy` handler no custom items are offered — the whole
custom menu, not one item of it — and `<SelectableMarkdown>` warns once in
DEV when it is given `selectionActions` without a handler, because nothing
else says so. The host never writes the clipboard; the app does. The system
Copy always works.

## Menu titles and localisation

Titles resolve in three layers, in order:

1. **A `title` on the `selectionActions` entry wins**, and is used verbatim
   on both platforms. It is the only channel that localises both from one
   place, and the only way a consumer-defined action can render at all.
2. **With no title, a built-in id takes the host's own string.** iOS:
   `NSLocalizedString("Copy Text" / "Copy Markdown")` resolved against
   `Bundle.main` — the pod ships no `.strings` table of its own, so a
   consuming app translates or rewords by adding those keys to its own
   `Localizable.strings`. Android: `R.string.selectable_markdown_copy_text` /
   `selectable_markdown_copy_markdown` from
   `android/src/main/res/values/strings.xml`, which a host app overrides by
   declaring the same names in its own `res/values/strings.xml` (an
   application resource wins over a library's) and translates with
   `res/values-<locale>/`. The two hosts resolve at different moments: iOS
   looks the string up each time it builds the menu, so an app that switches
   language in place gets the new words on its next menu rather than the ones
   current when it built its first; Android resolves with `context.getString`
   when the prop arrives, and Fabric re-delivers the whole prop map per
   commit, so a re-render is what refreshes it there.
3. **Anything else is dropped from the menu.**

```tsx
selectionActions={[
  { id: 'copy-text', title: t('copyText') },
  { id: 'copy-markdown', title: t('copyMarkdown') },
]}
```

### Consumer actions

Any id beyond the two built-ins is a consumer action. It MUST carry a title
or it never renders, and it arrives at `onSelectionCopy` as `payload.action`
with the same `plain` / `markdown` / `span` a built-in item would have
produced — the library does the mapping and hands it over; it never copies
for a custom action.

```tsx
selectionActions={['copy-text', { id: 'share-quote', title: t('share') }]}
```

The id rule that goes with it: `handleSelectionAction` reports every
NON-EMPTY id verbatim, built-in or consumer-defined, whether or not the caller
threaded `ctx.actions`. Only an event carrying no action at all resolves to
`'copy-markdown'`, that being the whole of the version skew — a binary older
than the `action` field, whose one custom item was Copy Markdown.
`SelectionActionContext.actions` is a DEV cross-check rather than a filter: it
warns once per id when an id arrives that the menu it was given did not offer.
Renaming a present id could only hand a consumer their own action to their
copy-markdown branch, silently. A separate DEV warning fires once for a custom
id with no title.

## Event: `onSelectionAction`

Fired when the user taps one of the `selectionActions` items in the platform
selection menu.

```ts
interface SelectionActionEvent {
  start: number;        // UTF-16 offset into the CURRENT `text`
  end: number;          // end-exclusive; start <= end
  action?: string;      // the id half of the selectionActions entry the
                        // item was built from, so a consumer action
                        // reports its own id
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
6. `action` is the identifier from `selectionActions` verbatim, and
   `handleSelectionAction` reports it unchanged. It is optional for version
   skew: a MISSING value — and only a missing value — resolves to
   `'copy-markdown'`.

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
5. A screen reader activating the range's accessibility element emits this
   same event, with the same offsets and the same `pressableId`, so a
   handler cannot tell the two apart.

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
   on the line top rather than the baseline. On iOS they are emitted from
   `layoutSubviews` and nowhere else — never from the text update — so a
   report always comes from a pass in which the host has been framed for the
   run it is showing. (Fabric calls `updateState` before
   `updateLayoutMetrics`, so a fresh view is still `CGRectZero` there and a
   recycled one still holds the previous run's width; reporting from the
   text update emitted one wrong rect per mount before the correct one.)
   Nothing is reported while `bounds.width` is 0.
2. A rect is re-emitted only when it moved (> 0.5pt in any component), per
   `embedId` — true from the first event, since guarantee 1 means the first
   one is already framed. Streaming appends past a settled embed re-announce
   nothing.
3. The range is one unit and the character is U+FFFC, verified before
   reporting exactly as before reserving.
4. `embedId` is echoed verbatim. JS bounds-checks it against the list the
   current projection sent and then files the rect under that embed's SOURCE
   SPAN (`embedRectKey`, `src/view/runIdentity.ts`), so it survives the
   reprojection every settle causes. Ids stay per-projection ordinals and are
   never used as a rect's identity.

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

## Event: `onSelectionChange`

Fired whenever a run's selection moves — a gesture, a `setSelection` or
`clearSelection` command, another host taking the one-active-selection slot,
or a streamed text swap that shifted it.

```ts
interface SelectionChangeEvent {
  start: number; // UTF-16 offset into the CURRENT `text`
  end: number;   // end-exclusive; clamped and ordered
}
```

Offsets carry `onSelectionAction`'s guarantees 1, 2, 4 and 5 verbatim, with
ONE difference, which is the whole reason the event exists: guarantee 3 is
inverted. An EMPTY range IS emitted, and it means "nothing is selected in
this run" — which is how a consumer's own floating toolbar learns to dismiss
itself. There is no `selectedText`: this fires on every frame of a handle
drag, and building and transcoding a substring per frame would be paid for a
string JS can slice out of the text it sent.

Host guarantees, both platforms:

1. Both hosts DEDUPE before dispatching. An unchanged range is never
   re-announced, so a streamed snapshot that re-applies identical text emits
   nothing, and a host that has never held a selection emits nothing at all
   — an empty report is meaningful only as the END of a selection that host
   previously announced.
2. iOS additionally re-announces an UNCHANGED range when the characters
   under it were rewritten (a repaired tail), because the span and text JS
   derives from those offsets would otherwise be stale. Android needs no
   such rule: `setText` there drops the selection outright.
3. Each host reports ITSELF FIRST and coordinates second, so a hand-off
   arrives as "run B holds [4,9)" followed by "run A holds nothing", and JS
   drops the second as stale. The opposite order would deliver a null and
   then the real selection — one visible toolbar flicker per hand-off.

The native dispatch is NOT gated on a JS listener: Fabric gives a host no way
to know whether one exists, and RN's own `TextInput` behaves the same. What
`<SelectableMarkdown onSelectionChange>` (or a ref) gates is the JS-side
mapping and slicing work per frame, not the bridge traffic.

## Commands

The spec declares two codegen commands, the third direction of the contract:
props are JS → native, events native → JS, commands are JS telling one
mounted host to act now.

- **`clearSelection()`.** Drop the host's selection and dismiss the menu over
  it; a no-op when nothing is selected. On iOS it also resigns first
  responder, which the coordination clear deliberately does not — that one
  runs while a gesture is in flight in a different host, whereas this is an
  app saying "no selection", and on iOS 16+ resigning is the only supported
  way to dismiss the edit menu, since `UITextView` owns its
  `UIEditMenuInteraction` privately.
- **`setSelection(start, end)`.** Select `[start, end)` of the host's CURRENT
  `text`, in the same UTF-16 offsets every event reports. The host clamps and
  orders; a range that clamps to empty is a NO-OP that leaves any existing
  selection alone and emits no `onSelectionChange` — an empty clamp means the
  offsets raced a text swap, not that the app asked for nothing, and clearing
  is `clearSelection`'s job; a run that is not `selectable` takes nothing; no
  menu is presented — the platform menu belongs to the user's gesture. It DOES take focus (iOS first responder,
  Android view focus), because neither platform draws a selection in a text
  view that lacks it, so a scrolling ancestor may respond by scrolling the
  run into view.

A command can race a text swap by a frame exactly like an event can, which is
why both are clamped rather than validated. iOS conforms to codegen's
`RCTSelectableRunHostViewProtocol` and routes `handleCommand:args:` through
`RCTSelectableRunHostHandleCommand`; Android reaches the two Kotlin methods
through the codegen'd `SelectableRunHostManagerDelegate.receiveCommand`,
which `ViewManager.receiveCommand` forwards to with no override in the
ViewManager.

SCROLL-TO-SPAN IS NOT PROVIDED, deliberately: `<SelectableMarkdown>` owns no
scroll view — a consumer wraps it in their own — and the honest primitive
would be a per-span measurement channel that does not exist on the wire.
`setSelection` moves the selection without scrolling to it; the focus change
is the platform's doing, not a scroll-to-span.

## `handleSelectionAction`

`src/view/selectionActions.ts` exports the unit-tested core the view routes
every native event through:

```ts
handleSelectionAction(doc, run, {start, end, action}, ctx?)
  -> { action, plain, markdown, span } | null
```

- `plain` is exactly `ProjectedRun.text.slice(start, end)`, synthetic glyphs
  included: what the platform's own Copy would produce. Not a reparse. With
  one exception: each U+FFFC embed placeholder inside the slice is replaced
  by that embed's declared `EmbedContent.text`, or removed when the claim
  declared none. The platform's own Copy still yields the raw placeholder.
- `markdown` is the exact source slice of the mapped span, and the span is
  CONSTRUCT-AWARE. `mapSelectionToSource` skips synthetic glyphs, bridges
  interior ones, and then unions in the source span of every construct the
  selection covers WHOLE. A construct's own syntax projects no text — a
  heading's `# `, a quote's `> `, a list item's marker, a fence, a table's
  pipes, a strong span's `**`, an inline link's `](url)` — so it belongs to
  no piece; without that union, selecting a whole list copied `one\n- two`,
  which re-parses as a paragraph followed by a one-item list. A PARTLY
  covered construct still maps to its pieces alone: half a list is not a
  list. Two constructs are deliberately never unioned — one the stream has
  not finished (`incomplete`: its span is still moving and its closing
  syntax is unwritten), and a REFERENCE link or image, whose destination is
  a definition elsewhere in the document that no slice can carry, so copying
  `[foo]` would paste literal brackets where copying `foo` pastes the word.
  The slice is taken directly; `buildCopyPayload` (`src/selection/copy.ts`)
  is not called, because its `plain` reparses the slice and this path already
  has the projection. It stays public for callers that want both halves.
- Where a node's display differs from its source, the projection covers it
  PIECEWISE, so mapping is not all-or-nothing over a paragraph. Prose the
  source spells verbatim stays linear and maps offset for offset; only the
  respelled stretch itself is indivisible. `\*` → `*` costs the backslash
  alone, `&hellip;` → `…` pins the ellipsis to `&hellip;` and nothing more,
  and a one-for-one respelling (`"` → `“`) stays linear, so a
  smart-punctuation paragraph maps offset for offset end to end.
- Returns `null` for an empty, out-of-range or glyph-only selection. Never
  throws mid-gesture.
- `ctx` is `{ projected?, glyphs?, embed?, actions? }`: an optional
  precomputed projection, the theme's glyph overrides, the embed lookup the
  run was segmented with, and the `selectionActions` list the menu was built
  from — the last a DEV cross-check on the id the host reports, never a
  filter. `<SelectableMarkdown>` passes all four. A hand-rolled `RunHost`
  integration that passes an `embed` prop MUST thread the same lookup here:
  without it the fallback reprojection (`projectRun(run, doc, { glyphs,
  embed })`) builds a different piece table from the one on screen and the
  mapped span is silently wrong — a whole-run `copy-markdown` over
  `p1\n\n![alt](https://x/y.png)\n\np2` returns
  `p1\n\n![alt](https://x/y.png)` (span `{0, 27}`) rather than the whole
  source (span `{0, 31}`): the projection the host reported against is one
  character per embed, the fallback's is the alt text, and the trailing
  `\n\np2` is what the shorter selection silently loses. Nothing throws.

The system Copy item is never intercepted, reordered or removed.
`'copy-text'` exists so apps can observe plain copies or write richer
clipboard items through the same event path; `['copy-markdown']` alone is
a fine configuration.

## The imperative selection API

`<SelectableMarkdown>` forwards a ref of type `SelectableMarkdownHandle`:

```ts
interface SelectableMarkdownSelection {
  span: SourceSpan; // the same source range copying this selection produces
  plain: string;    // the visible text, embed placeholders substituted
}

interface SelectableMarkdownHandle {
  getSelection(): SelectableMarkdownSelection | null;
  clearSelection(): void;
  setSelection(span: SourceSpan): boolean;
}
```

`span` is the authoritative half and is construct-aware exactly as
`onSelectionCopy`'s is, so sweeping a whole heading reports the span with its
`# `; the markdown for it is `source.slice(span.start, span.end)`,
deliberately not carried because re-slicing the document on every drag frame
is not free for the consumers who never read it. `plain` is byte for byte the
`plain` of the copy payload the same selection would produce.
`<SelectableMarkdown onSelectionChange={sel => …}>` is the push half and
takes `SelectableMarkdownSelection | null`.

Three behaviours to design around:

1. `getSelection()` is a SNAPSHOT of the last reported change, not a
   subscription, and it is null before any selection has been made.
2. `setSelection` returns FALSE as a real outcome, for either of two
   reasons. No run SHOWS the span: past the end, inside a block that rendered
   standalone, covering only markup that projects no characters (a fence, a
   `# `), or in a run that has not mounted. Or a run shows it and cannot TAKE
   it: the unsettled streaming tail on Android, a run rendered
   `selectable={false}`, or a bundle running against a native spec older than
   the selection commands. Every candidate run is asked in document order
   (`selectSpanInRuns`, `src/view/selectionRange.ts`) and the answer is
   whether any of them took it — so mid-stream on Android a `setSelection`
   over the live tail returns false rather than reporting a selection nobody
   made. Nothing is cleared on false; the previous selection stands. And
   TRUE is not a promise about the resulting range: it says a run accepted
   the command, not what the run then selected. The commands return nothing,
   so the answer is JS's model of the host — each host clamps and orders
   against the text IT holds, and a range that clamps to empty is a no-op
   that leaves the existing selection alone, so true can also mean nothing
   moved. Read `getSelection()` afterwards if the exact range matters. The
   model mirrors both hosts' `isSelectable`/`isTextSelectable` refusal, which
   subsumes Android's second guard (`textView.text as? Spannable`):
   `setTextIsSelectable` is the only writer of that buffer type, so a run
   that would refuse on it has already refused on selectability. The one
   refusal it cannot see is a `selectable` change committed in JS but not yet
   pushed to the host — a call made in that frame is accepted here and
   dropped there.
3. The resulting selection can be WIDER than the span asked for, in exactly
   the places copying is lossy: a piece whose display text is not a
   character-for-character copy of its source — a decoded entity, an image's
   alt text, an embed's placeholder — is indivisible, so a span landing
   inside one selects all of it. Round-tripping through `getSelection()`
   widens once and then settles.

A span crossing multiple runs selects only the first mounted, selectable run that accepts an intersecting range. `true` means that partial selection was accepted; it does not select across native hosts. The default 8000-character run budget makes this possible even within prose. Read `getSelection()` for the accepted source range.

Built-in image overlays do not intercept pointer events, so linked images and selection starts reach the native host. Their alt text remains an overlay accessibility label and can be read after the host's text. `images="standalone"` restores the prior image layout and accessibility grouping. Inline and container images use standalone layout unless a consumer provides its own embed claim.

On iOS, prose gaps and semantic elements follow document order. A fully covered run retains a final, labeled "Select text" control for the native selection rotor. Android keeps blockquote bars on the physical left; iOS follows each paragraph's leading edge.

Attaching a ref switches the selection subscription on, because
`getSelection()` has nothing to report otherwise; with neither a ref nor an
`onSelectionChange` handler, no run does the per-frame mapping work.

A consumer driving `RunHost` itself gets the same two commands through
`RunHostHandle` — `clearSelection()` and `setSelection(start, end)` in the
RUN's display offsets, not source ones — and maps a `SourceSpan` into those
offsets with the exported `mapSourceToRunRange(projected, span)`, the inverse
of `mapSelectionToSource`. `RunHostHandle.setSelection` returns a `boolean`
too: true means the command was DISPATCHED to the host, false that nothing
was asked of the platform (the host is not mounted, the run is not selectable
here, the offsets are not finite, or the commands are missing from the
binary). True is not a promise about the resulting range — the host still
clamps and orders against the text it currently holds.

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
- **Splice.** `RNSMTextSplice.plan` finds the longest shared prefix and the
  longest shared suffix — characters first, then attributes — and only the
  middle is replaced, so TextKit relayouts only what changed. A plain append
  is this plan with an empty suffix. The suffix half is what a streaming
  code block needs: its unclosed literal keeps a trailing newline, so every
  delta inserts BEFORE the last character and a prefix-only test would miss
  on every snapshot for the whole duration of the block. Neither splice
  boundary falls between a surrogate pair.
- **Full swap.** The new string shares nothing at either end (a reset or a
  replace). Save `selectedRange`, swap, restore clamped to the new length.

A selection covering the whole old text keeps meaning "all of it" on both
mutating paths: extended over the new text either way. Otherwise a selection
wholly inside the retained prefix keeps its offsets; one wholly inside the
retained suffix is shifted by the length delta, so it still covers the same
characters; and only a selection overlapping the replaced middle is clamped.

### Android: no preservation, and a known gap

`TextView#setText` drops the selection and dismisses the action mode; there
is no reliable preservation path, so the host does no restore. The tail run
is `selectable={false}` until it settles, which covers the run whose text is
obviously moving.

It does not cover settled prose. `segmentRuns` merges each newly settled
block into the same run (a settled run is keyed `run:${span.start}`; the
unsettled tail is keyed `run:tail` — see "Tail policy"), so the mounted
view's `text` grows while `selectable` is true. Text changes on
Android-selectable runs, streaming each fixture in 5-character chunks under
`presets.llmChat` and the default `images: 'embed'`:

```
assistant-overview.md  5    code-walkthrough.md   6
comparison-table.md    4    currency-and-links.md 4
emoji-i18n.md          6    mixed-longform.md    10
pipes-in-prose.md      7    task-plan.md          5
```

So a selection in settled prose dies four to ten times per streamed message
(reproduced 2026-09-02 against the current working tree; `mixed-longform`
counts 9 under `images: 'standalone'`, where its illustrated block leaves the
run). Offsets are never wrong, but selecting while streaming fails on
Android whenever a block settles.

The per-settle COST is now bounded even though the gap is not: the run still
grows and `setText` still drops the selection, but the work behind that
`setText` is incremental (`projectRun`'s `previous` option, and
`RunLayoutCache` on the Android side), and merging stops at
`DEFAULT_MAX_RUN_CHARS` of source. The cap breaks between blocks only, so a
single block longer than it — a long list, a long fenced block — is still
one host's text whatever the cap says.

Three candidate fixes, none executable in this repository:

1. Stop merging a newly settled block into an already-settled run. A partial
   form of this now exists — `segmentRuns` takes `maxRunChars` and defaults
   to 8000 source characters, so merging does stop at that boundary — but
   the boundary sits far above ordinary message lengths precisely because it
   costs a selection sweep, so it does not close this gap for a normal
   answer. An app that would rather lose the sweep than the selection can
   pass a much smaller `maxRunChars`: it is a prop on `<SelectableMarkdown>`
   (default `DEFAULT_MAX_RUN_CHARS`, `Infinity` to opt out) that forwards to
   `segmentRuns`, not a knob only a direct caller of `segmentRuns` can reach.
   It moves the boundary between blocks; it cannot split one.
2. Restore the range with `Selection.setSelection` on the new `Spannable`.
   That restores the selection but not the dismissed `ActionMode`, so it is
   partial, and there is no Android SDK here to find out how partial.
3. Mutate an `Editable` in place — the Android analogue of the iOS splice —
   splicing only the changed middle and its spans, so `TextView#setText`
   (which is what replaces the `Spannable` holding the selection spans) never
   runs. It needs both halves of the iOS plan — shared prefix AND shared
   suffix — not just a prefix comparison against `textView.text`: a streaming
   code block's unclosed literal keeps a trailing newline, so every delta
   inserts before the last character and a prefix-only test misses on every
   snapshot for the whole duration of the block (see "iOS: preserve and
   clamp"). Its `ActionMode`
   behaviour is unmeasured here, and it has one known obstacle:
   `setTextIsSelectable` re-runs `setText` with a SPANNABLE buffer whenever
   the flag actually changes (it early-returns when it does not), so a
   prototype must keep the widget on `BufferType.EDITABLE` across that
   transition. It also forfeits `RunLayoutCache`'s shared-instance property
   for selectable runs.

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
re-report for the new one. JS is defensive independently, and files each
reported rect under the embed's SOURCE SPAN (`embedRectKey`,
`src/view/runIdentity.ts`) rather than under its `embedId`, so a rect
survives the reprojection every settle causes — necessary, because the hosts
re-emit a rect only when it MOVED and a settled embed's rect never moves. An
out-of-range or non-integer `embedId` is dropped, rects for embeds the
current projection no longer has are pruned on the next report, and the map
is per-run React state, so a recycled host can never inherit another run's
rects.

Recycling is only reachable in a running app, so it is reviewed, not run.

## Tail policy (streaming)

Blocks past `settledUntil` form the tail run, the only run whose text still
changes. `segmentRuns` emits tail runs `selectable: false` by default; the
view applies its platform policy:

| Platform | Tail policy | Why |
| --- | --- | --- |
| iOS | Selectable | The tail run is keyed by its ROLE (`'run:tail'`, `runKey` in `src/view/runIdentity.ts`) rather than by `run:${span.start}`, so a settled block no longer remounts the tail's host: it is handed new text, and iOS clamps the selection into it (an append splices and leaves it alone). |
| Android | `selectable={false}` until settled | `setText` drops selection and action mode; a selection that dies on every chunk is worse than a briefly non-selectable tail. |

A selection made in the live tail therefore survives a settle on iOS, as a
clamped range. Before the role key it was destroyed instead, because a
changed key recycles the view (`prepareForRecycle` → `reset()`). Exactly one
host mounts fresh at the first split of a stream, and it is the tail's: a
document that has settled nothing is a single run keyed on its span, so the
host already on screen is matched to the settled prefix and survives.

The tail run also survives a MOMENTARY full settle. A chunk that ends on a
completed blank line leaves `settledUntil` at the source length until the
next chunk arrives, and the settled/tail break then has nothing to break at:
the document collapses to one run for a frame or two, several times per
message, taking the tail's host — and any selection in it — with it. So
`segmentRuns` takes a `liveTail` option and `<SelectableMarkdown>` passes it
while the session phase is `'streaming'`: the last block stays in a run of
its own even when `settledUntil` covers everything. Both halves of that split
are `selectable: true`, because they really are settled — this is a run
BOUNDARY, not a claim about repair — so Android does not lose the last
paragraph's selectability to the split.

The `'run:tail'` key is POSITIONAL and stream-scoped, and not a statement
that the run is unsettled: it goes to the LAST run whenever a `StreamSession`
is driving the document and there is more than one run, including after the
stream has finished. So the tail is not re-keyed (and its host not remounted)
at the moment the stream stops, a document rendered from a plain `source`
string is keyed on spans throughout, and a document that merges back into one
run at the end falls back to `run:${span.start}` — the settled run's own key,
so the long-lived host holding most of the document wins the merge rather
than the tail's short-lived one.

The policy covers STANDALONE runs too. The view resolves it once per run and
passes it to the block renderers as `RenderContext.selectable`
(`src/view/renderers.tsx`), which every built-in `<Text selectable>` reads —
so an unsettled standalone block (a paragraph whose image has arrived while
its text keeps growing) is not selectable on Android until it settles. A
consumer's own renderer should pass `ctx.selectable` through to any
selectable text it draws. The settled portion is always selectable
mid-stream on both platforms.

Selections never span hosts by default. Each platform keeps a SINGLE
process-wide weak reference to the host that currently holds a selection
(`SelectableRunHostView.activeSelectionHost` on iOS, `activeHost` on
Android), and a new non-empty selection clears at most that one host and
takes the slot — O(1), with no per-callback array allocation on a handler
that fires continuously while a handle is dragged, and the same invariant,
because this handler is itself what maintains "at most one host holds a
selection". Both hosts give the slot up when recycled. Clearing the previous
host fires its own selection callback with an empty range, which returns at
that host's guard, so it does not recurse; the clear also reaches JS as an
`onSelectionChange` with an empty range, which `<SelectableMarkdown>` drops
as stale because it is not from the recorded owner.

`exclusiveSelection?: boolean` (default `true`, on `<SelectableMarkdown>`, on
`RunHost`, and on the native spec as `WithDefault<boolean, true>`) is the way
out. `false` opts a host out in BOTH directions — it clears nobody, and
because it never takes the slot, nobody clears it. The symmetry is required
rather than tidy: an opt-out that only stopped the clearing would still lose
the first selection to the next host that selected, so cross-message copy
(select in A, select in B, merge two `onSelectionCopy` payloads) would stay
unreachable. What `false` buys is the RANGE, not the highlight. Neither
platform draws a selection in a view that does not hold focus — a
non-editable `UITextView` paints no selection, handles or menu unless it is
first responder, and a `TextView` draws one only while `isFocused() ||
isPressed()` — so once a second host takes focus the earlier selection
survives everywhere it matters (its `onSelectionChange` fired, its own
document's `getSelection()` answers with it, its copy payload is exact) while
the highlight under it disappears. The merge-two-payloads workflow is
therefore reachable in code, and an app that wants the user to see the
earlier selection has to draw that feedback itself. The cost the default
exists to prevent is exactly that: a live selection nobody can see, dismiss
or drag that JS nonetheless believes in, and `clearSelection()` having to
clear every mounted run instead of the one that holds it. The coordination is
per PROCESS, so by default two unrelated `<SelectableMarkdown>` trees in a
split view clear each other, and this prop is what stops them. One gesture
that genuinely spans two documents is still future work.

Code blocks, tables and rules flow through prose runs, so one gesture selects
across them. A block is a separate scope only when a spoiler, an image
nothing claimed, or a `classifyBlock` claim makes it standalone — and under
the default `images: 'embed'` the built-in image claim is what keeps an
illustrated paragraph, list or table in the run, with its `selectionActions`
and `onSelectionCopy` intact (see the table below). An embed claim is
consulted before `classifyBlock`, so a `classifyBlock` claim on an IMAGE NODE
no longer forces its block standalone; `images: 'standalone'`, or claiming
the containing block, is how to do that now.

An `embed` claim runs the other way from a standalone claim: it keeps a
custom-rendered view *inside* the run (one placeholder character, reserved
space, overlaid view), so a citation card no longer costs the sweep.
Selecting across an embed is atomic — the placeholder is one character whose
piece maps to the node's whole source span, so any sweep that covers the card
copies the card's exact markdown. That is the special case of a general
guarantee: any construct a sweep covers whole copies its exact markdown, the
embed being the one whose whole projection is a single character.

### What a standalone block does and does not get

Standalone runs do not go through `RunHost`. A code block renders as
`<Text selectable>` inside its chrome; a table as a flex layout of per-cell
`<Text selectable>`. A standalone prose block renders through `renderBlocks`,
whose renderers set `selectable` from `ctx.selectable`. Inside a run none of
those renderers runs at all — `RunHost` mounts one childless native host
built from `text` plus `attributes`, and `renderBlocks` is reached only
through the `run.standalone` branch — so a renderer's `selectable` can never
argue with the tail policy.

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

Three properties are contract:

- **Measure the exact string the view draws.** One string builder and one
  text-engine configuration per platform, shared by measurer and view. A
  mismatch shows as text clipped at the bottom of a run.
- **A run's measured height is its text's height plus the room a box
  decoration at the very EDGE of the run needs.** Box padding is normally
  painted into the blank line the `'\n\n'` block separator leaves and costs
  no height, but a box with `start === 0` or `end === text.length` has no
  such line: a trailing table's bottom border used to land on the baseline of
  its last row, and a leading code block lost its top border. Each platform
  derives that room once, from the artefact its measure and draw paths
  already share — `RNSMAttributedText.runEdgeInsets(of:)`, carried on the
  measured string, on iOS; `RunDecorations.edgePaddingPx` on Android, which
  converts the `edgePaddingDp` derivation to whole pixels once, rounded up —
  and each host offsets its text into it (the text view's frame origin on
  iOS, the child `TextView`'s vertical padding on Android). Both Android
  sides take those same integers: `RunTextMeasure.measure` adds them to the
  height and `SelectableRunHostView.commitProps` passes them to `setPadding`,
  so the room reserved and the room spent are identical. The measure side
  used to add the un-truncated float while the view truncated it, leaving the
  drawn band up to a pixel short of its reservation. Largest wins where
  several boxes share an edge, not the sum.
- **A clone with unchanged props and children keeps its clean layout.**
  Otherwise appending one token would re-measure every run in the document.

## Android layout cache and spannable handoff

`RunLayoutCache` (`android/src/main/java/com/selectablemarkdown/RunLayoutCache.kt`,
internal) memoizes the measure path and the UI-thread `commitProps` rebuild:

- Built styled `Spannable`s: key to `Spannable`, at most 128 entries.
- Measured Yoga outputs (the packed `Long` from `YogaMeasureOutput.make`):
  key plus `(width, widthMode, height, heightMode)` to `Long`, at most 256
  entries. The full constraint tuple is the key, as in React Native's
  TextMeasureCache.

The entry caps are NOT the memory bound, because an entry's weight is a
document-scale text and streaming makes almost every insertion a one-shot
key. Each map also carries a 1 Mi-char budget
(`SPANNABLE_BUDGET_CHARS` / `MEASURE_BUDGET_CHARS`, ≈2 MB of text per map)
with eldest-first multi-eviction, and a text longer than the whole budget is
refused outright and built uncached. The budget, not the entry cap, is the
standing bound.

The key is `Key(text, attributes, decorations, embeds, density,
scaledDensity, localeTag)` — the display-metrics values come from
`DisplayMetricsHolder` and the tag from the default locale, so a font-scale,
density or locale change misses by construction, and `embeds` is in the key
because `build` bakes each reservation into spans (an embed whose declared
size changed under unchanged text would otherwise be served the previous
size's spannable). There is no explicit invalidation. `installTrimHook`,
armed from `SelectableRunHostViewManager.createViewInstance`, clears both
maps from `onTrimMemory >= TRIM_MEMORY_RUNNING_LOW` and from `onLowMemory` —
reclamation, not invalidation, since every entry is pure derived data.

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
- Custom action-mode items are added in `onPrepareActionMode`, remove-first
  — exactly the ids added last time, not a fixed pair — so repeated prepare
  calls converge without duplicates and a shrinking or reordered list leaves
  nothing behind. System ids are never touched.
- Item ids are allocated sequentially as `0x534D01 + n` for the nth rendered
  custom item, so the default two-item menu keeps the ids it always had, and
  the band cannot collide with OEM or `ACTION_PROCESS_TEXT` ids.
- Titles for the two built-in ids come from
  `R.string.selectable_markdown_copy_text` /
  `selectable_markdown_copy_markdown`
  (`android/src/main/res/values/strings.xml`), overridable and translatable
  by the host app; a `title` sent from JS wins over them; an id with neither
  is dropped. Titles are resolved when the prop arrives, not per
  `onPrepareActionMode` call — OEM skins invoke that repeatedly during a
  live selection.
- A `selectionActions` change while the menu is open calls
  `ActionMode#invalidate()`.
- `dispatchTouchEvent` catches the Samsung selection-handle
  `IndexOutOfBoundsException` family.
- On detach the action mode is finished and
  `customSelectionActionModeCallback` uninstalled.

iOS:

- TextKit 1 keeps selection geometry stable across swaps.
- Custom actions are appended via `textView(_:editMenuForTextIn:suggestedActions:)`
  (iOS 16+) in `selectionActions` order, with a stable identifier of
  `selectable-markdown.` + the entry's id, so a consumer action gets one too.
  Pre-16 gets the stock menu only.
- Titles for the two built-in ids come from `NSLocalizedString` resolved
  against `Bundle.main` — the pod ships no `.strings` of its own, so an app
  translates them by adding "Copy Text"/"Copy Markdown" keys to its own
  `Localizable.strings` — and a `title` sent from JS wins over that. An id
  with neither is dropped from the menu.
- The emitted range is the selection as it stands WHEN THE ITEM IS TAPPED,
  read from `textView.selectedRange` in the `UIAction` handler, not the range
  the menu was built with; the build-time range is the fallback for a
  selection cleared out from under a presented menu. That is what keeps the
  payload matching the highlight when a streamed snapshot moves the selection
  under an open menu, and it is what Android already did by reading
  `selectionStart`/`selectionEnd` at invocation time.
- Nothing is emitted for empty ranges; every range is clamped against the
  current text.

## Offsets end to end

1. **Source UTF-16.** `SourceSpan` on every AST node. md4c works in UTF-8
   bytes; `platform/cpp/OffsetParser` builds the byte→UTF-16 map and
   `platform/cpp/FlatBuffer.cpp` applies it — "the ONLY place where a byte
   offset becomes a UTF-16 offset" — so spans cross into JS already UTF-16.
2. **Projected-text UTF-16.** What the host sees and reports. `RunPiece`
   records the correspondence to source offsets. Under Fabric the run text
   itself crosses as a UTF-8 `std::string` and is transcoded back on both
   hosts (`RCTNSStringFromString(props.text)` in
   `platform/ios/RNSMAttributedText.mm`, `props.getString("text")` in
   `SelectableRunHostViewManager.kt`). That is offset-preserving and does not
   breach step 1: no offset arithmetic happens on either side of it, and a
   code point occupies the same number of UTF-16 code units whichever
   encoding carried it.
3. **Clipboard.** `markdown` is byte-for-byte the source slice; `plain` is
   byte-for-byte the display slice, except that embed placeholders are
   substituted for their declared text.

With `exclusiveSelection={false}`, `getSelection()` and `onSelectionChange`
represent the most recently selected run that still has a selection. Clearing
that run falls back to another live selection; `clearSelection()` clears all runs.
