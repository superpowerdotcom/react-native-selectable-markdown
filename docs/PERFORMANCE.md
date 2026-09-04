# Performance

(measured) means a harness in this tree produced the number; (reasoned)
means inferred. External numbers are from other hardware; compare ratios
within a source only.

Harnesses and tables: [BENCHMARKS.md](BENCHMARKS.md). Incremental parsing:
[STREAMING.md](STREAMING.md). Native layers: [SELECTION.md](SELECTION.md),
[NATIVE.md](NATIVE.md).

## 1. Where the time goes

- **Parse.** `engine.parse` on a 64 B tail costs about 3.0 µs: 1.8 µs for
  md4c, wire encode and the `ArrayBuffer` crossing, 1.3 µs for the JS decode
  (measured, `bench:crossing`, 2026-09-02). That is the crossing, not an
  append — a whole `StreamSession.append` averages 14 µs over the ×8 replay of
  the bundled transcript and 19–21 µs over the ×1 one (measured,
  `bench:streaming`, 2026-09-03, three runs: divide the streamed total it
  prints — 14.98 ms over 1055 appends, 2.52–2.80 ms over 131 — by the chunk
  count; p50 per chunk is 0.01–0.02 ms); the difference is the tail repair
  below, plus the anchor scan, the span shift and the snapshot. Parse input
  per append is flat at mean 105, p95 254, max 277
  characters, the same at 1.2 kB and 9.3 kB of document — on a document that
  anchors. One that never does (a single long list, a giant paragraph, an
  unclosed fence, an unterminated HTML comment or `<script>` block) reparses
  its whole tail every append: mean 10,854 characters
  of 21,927 on the bundled giant-list transcript. Parsing is still not the
  problem.
- **Tail repair.** `repairTail` runs over the whole unsettled tail before
  every parse-path append, but its inline scan is carried between appends (it
  takes and returns an opaque `RepairScan`; `StreamSession` owns one per
  anchor and drops it on anything that is not a plain append), so an append
  re-scans its own delta rather than the tail behind it. On an unanchored
  paragraph streamed in 18-character deltas, at 6 / 20 / 32 kB of tail: plain
  prose costs 4.5 / 8.5 / 11.9 µs per append carried — about 0.8× the md4c
  parse of the same text — against 4.8 / 11.7 / 18.0 µs uncarried, which
  reaches 1.2× the parse. Prose
  carrying inline syntax is where the carry earns its keep: 4.7 / 9.0 /
  13.6 µs carried against 47 / 76 / 115 µs uncarried (measured, 2026-09-02).
  Still linear in the tail, at a much smaller constant.
- **Decode.** 38–51% of every parse by shape (measured, `bench:crossing`,
  2026-09-02). This half is TypeScript, and Hermes has no
  JIT, so the wire-buffer walk, span widening and the string table's UTF-8
  decode get slower on device (reasoned). Entity resolution is not on that
  list: md4c already ships the HTML5 name table, so a decoded entity arrives
  interned (`appendDecodedEntity`, `platform/cpp/OffsetParser.cpp`) and
  `entities.ts` is only the fallback for an entity event with no interned
  value. Nothing here is measured on device yet.
- **Run segmentation.** `segmentRuns` runs on every snapshot: the view memoizes
  it on the snapshot's document object, which is a new object per delta.
  Classification is memoized on block identity (`classCache`,
  `src/selection/runs.ts`), so only the blocks that changed are re-classified:
  8.4 classification visits per delta at 3.4 kB, 6.8 kB and 13.6 kB of the
  bundled transcript, against 134 / 260 / 512 for the same replay with the memo
  defeated. That count is flat; the PASS is not. `segmentRuns` still visits
  every top-level block on every snapshot, which is linear in blocks even with
  every classification cached: 0.76 / 3.03 / 13.2 µs at 33 / 132 / 528 blocks
  (3.4 / 13.6 / 54.6 kB), about 0.023 µs per block. Both figures are ad-hoc
  probes on this machine (2026-09-03); no `bench:*` script reproduces them,
  unlike the projection bullet below.
- **Run projection.** A settled prose run gains a block per settle, so
  `projectRun` used to re-walk the whole accumulated run each time; it now
  extends the previous projection instead (`src/view/projectionCache.ts`).
  Replaying the bundled transcript at 18-character deltas, the view projects
  5.2 source characters per document character, the same at 1.2 kB and 2.3 kB,
  with the largest single projection 274 characters. Reprojecting in full is
  32.6× and 64.6×, largest single projection 1,141 and 2,282 (measured,
  `bench:projection`, 2026-09-02; unchanged in a 2026-09-03 re-run). The bench
  gates as well as reports — cached amplification growing more than 1.25× per
  document doubling exits 1, and ci.yml and release.yml run it — with the
  finer-grained assertions in
  `conformance/selection/incremental-projection.test.ts`.
- **Attributes, decorations, pressables and embeds.** No incremental path,
  unlike the projection above. `resolveRunAttributes` and its three siblings
  are memoized on the PROJECTION's identity
  (`src/view/SelectableMarkdown.tsx`), and a settle produces a new projection,
  so every settle re-resolves all four over the whole settled run and
  `RunHost` re-maps every attribute for the wire (`toNativeAttribute`). That
  is O(run) per settle rather than O(append), and the run cap bounds it only
  as far as it bounds a run (§3). Unmeasured; it is the JS half of what
  roadmap item 1 exists to measure.
- **Layout and commit.** Unmeasured on device (BENCHMARKS.md metrics 5 and
  6, planned). External measurements put the cost here:
  - LibreChat: settled-block memoization cut code-block renders 88% and
    render time about 2.3× ([PR #13576](https://github.com/danny-avila/LibreChat/pull/13576)).
  - Chrome: the naive failure is re-parsing and re-rendering everything per
    chunk ([developer.chrome.com](https://developer.chrome.com/docs/ai/render-llm-responses)).
  - Rich/Textual: with incremental parsing, layout became the bottleneck
    ([willmcgugan.github.io](https://willmcgugan.github.io/streaming-markdown/)).
  - ChatGPT web: full reparse about once per frame, rAF-coalesced, no
    virtualization, smooth anyway ([performance.dev/chatgpt](https://performance.dev/chatgpt)).
  - Discord (React Native): one hoisted regex was about 30% of parse cost
    (500 ms to 30 ms); FastList recycling took about 2000 mounted views to
    400 ([discord.com](https://discord.com/blog/how-discord-achieves-native-ios-performance-with-react-native)).

## 2. What has been optimized

Six changes, landed between the 0.5 release and the unreleased audit pass.

### Delta coalescing and lookahead-by-lag holdback

`appendBuffered(delta)` pools deltas and flushes once per frame
(`requestAnimationFrame`, else `setTimeout(flush, 16)`; injectable as
`StreamSessionInit.bufferScheduler`). `holdBackChars` (default 0) withholds
the last N characters so `**bo` waits instead of rendering and being repaired;
`holdIdleMs` (default 250, injectable `idleScheduler`) drains the tail on a
stall. Never splits a surrogate pair; `append`, `flushBuffered`, `replace` and
`finalize` drain first, so ordering is unchanged. Tests:
`src/stream/buffering.test.ts`. The AI SDK's `smoothStream` and llm-ui's
`throttleBasic({targetBufferChars: 60})` pace the same way. Fewer parses and
commits per second (reasoned; no throughput number claimed).

### Tail repair hardening

The corpus is 251 table cases (319 tests in `src/stream/repair.test.ts`).
`RepairResult` gained one field, the carry-forward `scan` §1 describes; new
repairs are recorded in `touched` as before. New: a
lone high surrogate at the cut is dropped instead of becoming U+FFFD; a tail
ending in `]` waits for `(` or literal text (`[text]` renders as `text`,
`![alt]` is dropped); partial autolinks (`<scheme:rest`) are trimmed like
partial tags; bare-CR and split-CRLF endings feed the structure-flip guard.
Pinned non-repairs: `$x` and bare `$` stay literal (md4c agrees); `[text][r` strips only the lone `[`.

### ASCII fast path in the offset map, and decoder hot paths

Measured on Node/V8, `bench:crossing`.

- `buildUtf16OffsetMap` (`OffsetParser.cpp`) tests 8 bytes at a time and
  ramp-fills ASCII runs; non-ASCII falls to the byte-wise path (re-testing
  per multi-byte character was 2× slower on CJK). Wire format unchanged,
  `protocolVersion` still 1. Map build on the 96.4 kB ASCII corpus: 70 to
  about 27 µs (about 2.7×, 3.5 GB/s). The map was about 3% of the native
  parse-and-encode stage, so that stage improved 3–7% by shape (isolated
  measurements from 2026-08-25; no `bench:*` script reproduces them).
- `skipLinkTail`: 16% to 8% of decode via `charCodeAt` (2026-08-25).
- `utf8Decode` ASCII path: chunked `String.fromCharCode.apply` (4096 chars),
  still `TextDecoder`-free for Hermes. `trimSpanEnd`,
  `isAsciiPunctuationChar`, `widenDisplayMath`, `locateFirstNonBlankLine` no
  longer run a regex per character (the last keeps `trim()` for Unicode
  blankness).
- Decoder throughput over the wire buffer: 297–418 MB/s on prose,
  562–660 MB/s on node-dense shapes (2026-09-02). The `charCodeAt` wins should be larger
  on Hermes, which had no JIT hiding the old cost (reasoned).

### Android spannable handoff and measure cache

`RunLayoutCache` (`android/src/main/java/com/selectablemarkdown/RunLayoutCache.kt`)
caches built Spannables and measurements keyed on the full
`(width, widthMode, height, heightMode)` tuple, like React Native's
`TextMeasureCache`. Keys include text, attributes, decorations, embeds, a
display-metrics token from `DisplayMetricsHolder.getWindowDisplayMetrics()`
(what `PixelUtil` uses) and the locale tag `configurePaint` sets as the
paint's `textLocale`, so an embed resized under unchanged text, a font-scale
or density change, and a locale change that moves CJK line breaking all miss
by construction.

The memory bound is TWO-PART, and the entry caps are the weaker half: an
entry's weight is a whole run's text, which for a merged settled run is most
of a document, and streaming makes nearly every insertion a one-shot key. So
each map carries an entry cap (128 spannables, 256 measurements) AND a budget
of 1 Mi UTF-16 characters (`SPANNABLE_BUDGET_CHARS` / `MEASURE_BUDGET_CHARS`),
evicting eldest-first until both hold; a text longer than the whole budget is
refused outright rather than evicting everything and then itself. The budget,
not the entry cap, is the standing bound on a long transcript.
`RunLayoutCache.installTrimHook` (armed by `SelectableRunHostViewManager`)
clears both maps from `TRIM_MEMORY_RUNNING_LOW` up; every entry is pure, so
that is reclamation, not invalidation.

Measure (layout thread, JNI) and `commitProps` (UI thread) share
the instance, which is safe because `TextView.setText` copies a `Spanned`, so
selection spans and the `ChangeWatcher` land on the widget's copy. A
per-thread `TextPaint` in `RunTextMeasure` replaces per-measure allocation.
Recommits become one map get per run (reasoned). Not measured: no device in
the build environment. Metric 5 is for this. iOS has no equivalent cache — see
the subsection below.

### iOS spliced attributed text

`apply(attributedText:)` in `SelectableRunHostView.swift` asks
`RNSMTextSplice.plan` what actually changed: the longest common prefix AND the
longest common suffix of the old and new strings, each compared characters
first and then attribute runs, with both boundaries kept off surrogate pairs.
Only the differing middle is replaced, in one `replaceCharacters` inside
`beginEditing`/`endEditing`, so TextKit relayouts that middle and what follows
it. An append is the degenerate plan with an empty suffix and costs what it
always did; full swap now means the two strings share nothing at either end.

The case the prefix-only test missed was not exotic. A still-streaming fenced
code block projects its literal with a trailing newline, so every delta
inserts *before* the last character — every snapshot of a code block took the
full swap. Selection follows the plan: untouched inside the retained prefix,
shifted by the length delta inside the retained suffix, Select-All extends,
and only a selection overlapping the replaced middle is clamped. A
decoration-free run no longer asks for a display pass per snapshot, and embed
rects are reported from the layout pass rather than per text update. Not
measured on a device; reasoned from TextKit's documented per-range
invalidation.

That is the DRAWN relayout. The same commit still re-measures the whole run:
`RNSMRunTextMeasurer::measure` hands the string to
`RNSMTextKitStack.measureAttributedString`, which allocates a fresh
`NSTextStorage`/`NSLayoutManager`/`NSTextContainer`, sets the whole string and
calls `ensureLayoutForTextContainer:` over all of it, and
`RNSMRunHostShadowNode` drops `lastMeasurement_` on every content rebuild, so
the per-pass memo never survives a text change. There is no iOS counterpart to
the Android measure cache above. Roadmap item 6.

The splice reaches the tail only because of a second fix. The unsettled tail
run's React key used to be its start offset, which moves on every settle, so
the tail's host was unmounted and remounted once per settled block and every
path above was pre-empted by a fresh view. The tail is now keyed by its role
(`runKey`, `src/view/runIdentity.ts`), so a settle hands the same host new
text.

### Incremental run projection and a run-size budget

`segmentRuns` merges adjacent settled flowing blocks, so an ordinary answer is
one run that gains a block per settle. `projectRun` now takes a `previous`
projection and resumes the projector at a top-level block boundary, so an
append-only settled run costs its append — the JS analogue of the splice
above. `createRunProjectionCache` holds one projection per `RunView`, keyed on
the marker glyph values and the embed lookup, and hands back the same object
when nothing changed so every memo downstream keys on its identity. Beside it,
`segmentRuns` stops merging a flowing run at `DEFAULT_MAX_RUN_CHARS` (8000
source characters, a `maxRunChars` prop on `<SelectableMarkdown>`), packed
greedily from the start of the document and measured between settled offsets,
so a boundary does not move as the document grows. The cap breaks merging
between blocks and never splits one, so a single block past it is one
oversized run.

Measured over the bundled transcript at 18-character deltas: 32.6× → 5.2×
projected characters per document character at 1.2 kB and 64.6× → 5.2× at
2.3 kB, largest single projection 1,141 → 274 and 2,282 → 274 characters
(`bench:projection`, 2026-09-02). One limit is worth stating: the reuse depends
on blocks SETTLING. A stream that never anchors has nothing to reuse, and the
bundled giant-list transcript measures ~553× on both pipelines.

## 3. Attempted, and not done

- **Lazy per-block AST materialization.** Abandoned with a profile. Span
  widening is about 60% of decode and must run eagerly; lazy children re-pay
  it (about 1.6× total, and renderers read every block) or need a second
  decoder. Also breaks the spoilers transform and blinds the prefix oracle.
- **BoringLayout and PrecomputedText (Android).** Deferred. Measuring is up
  to 90% of setting text ([Android Developers Blog](https://android-developers.googleblog.com/2018/07/whats-new-for-text-in-android-p.html)),
  but both cross the measure/draw agreement: BoringLayout's vertical metrics
  differ for some scripts, PrecomputedText `Params` must byte-match the
  TextView's. Ship with a benchmark. Also deferred: a `desiredWidth` memo to
  skip `Layout.getDesiredWidth`.
- **simdutf.** About 4 GB/s ([arXiv](https://arxiv.org/pdf/2111.08692)), but
  after the ASCII fast path the map is a small share; md4c plus the encoder
  is the rest.
- **Nitro or worklets.** Call-overhead wins only (26.9 ms vs 181.1 ms per 1M
  calls, [margelo.com](https://margelo.com/blog/make-jsi-run-faster); Nitro's
  15×, [NitroBenchmarks](https://github.com/mrousavy/NitroBenchmarks)). This
  design crosses once per parse. Worklets suit a JavaScript parser, as in
  react-native-live-markdown; this one is C.
- **Parser swap.** md4c is within about 10% of the fastest engines
  ([ferromark](https://github.com/sebastian-software/ferromark)); engine
  choice is irrelevant at a 3 µs boundary. Its gap is no native source
  offsets ([mity/md4c#91](https://github.com/mity/md4c/issues/91));
  pulldown-cmark's `into_offset_iter` is the escape hatch if offset bugs ever
  dominate.
- **One giant text view.** TextKit 2 stutters around 1M characters
  ([Apple forums](https://developer.apple.com/forums/thread/729491)); Android's
  StaticLayout is monolithic. The per-run split stays, and it is now enforced
  WITHIN a flowing sequence too: `segmentRuns` stops MERGING at
  `DEFAULT_MAX_RUN_CHARS` (8000 source characters), so a long message is
  several hosts rather than one that keeps growing. It is a merge rule, not a
  ceiling: a single block longer than the cap is still one run of its own —
  the bundled giant-list transcript segments into a 44-character run and a
  21,880-character one. The trade is explicit — a run boundary is a selection
  boundary, because a sweep cannot cross hosts — which is why the cap sits far
  above ordinary message lengths. `<SelectableMarkdown>` takes `maxRunChars`
  as a prop (forwarded to `segmentRuns`, `Infinity` to opt out), so an app
  that wants smaller per-settle layouts can trade sweep distance for them
  without driving `segmentRuns` itself.
- **tree-sitter-style incremental parsing.** tree-sitter-markdown disclaims
  correctness, and block-level reparse is already about 3 µs (measured).

## 4. Roadmap, in recommended order

Three items are absent from this list because they shipped instead, and are in
§2: the projection of a growing settled run is incremental, `segmentRuns` caps
a run's length, and block classification is memoized on block identity — the
last is what makes segmentation cost the blocks that changed rather than the
whole document, since the pass itself still visits every top-level block.
Both `bench:projection` and
`conformance/selection/incremental-projection.test.ts` gate the amplification,
at different granularities: the bench fails a build when cached growth exceeds
1.25× across a doubling, the conformance test on flatness and on the worst
single projection.

1. **On-device benchmark harness** (BENCHMARKS.md metrics 5 and 6): JS frame
   time, dropped frames, time-to-first-block, memory peak, `<Profiler>`
   commit attribution. The acceptance criterion is not "settled-run re-renders
   are zero", which cannot hold: an unchanged settled run re-renders zero
   times, and the one settled run that absorbs a newly settled block
   re-renders once per settle. What that re-render costs is two different
   things: the number of source characters RE-PROJECTED is proportional to the
   appended blocks (§2), while the rest of the pass — the mark and extent
   re-sort, then a full re-resolve of attributes, decorations, pressables and
   embeds (§1) — is still O(run). The cap bounds it rather than removing it,
   and only between blocks: `DEFAULT_MAX_RUN_CHARS` stops merging, so a single
   block longer than it is one oversized run. The Android measure cache and the iOS
   splice shipped with no measurement at all, and nothing in §2 has been
   measured on a device.
2. **Defer decoration of the open block** until it settles, as streamdown
   does for code ([vercel/streamdown](https://github.com/vercel/streamdown)).
   The safe anchor already marks the boundary.
3. **Appended-run fade-in**, stripped at stream end (streamdown `animated`,
   FlowToken). Pairs with frame-aligned flushes (reasoned). It adds commit
   cost to the path item 1 exists to measure, so it wants item 1 first.
4. **FlashList and virtualization guidance** for long transcripts. Discord:
   about 2000 views to 400 (measured, theirs). FlashList v2 has typed
   recycling pools ([shopify.engineering](https://shopify.engineering/flashlist-v2)).
5. **Document-level cross-view selection.** Run merging exists only because
   selection ends at native view boundaries (SELECTION.md). iOS 17+:
   `UITextSelectionDisplayInteraction` over your own `UITextInput`, with
   `selectionRects(for:)` spanning subviews
   ([WWDC23 10058](https://developer.apple.com/videos/play/wwdc2023/10058/));
   iOS 13+: `UITextInteraction`, as PSPDFKit ships
   ([nutrient.io](https://www.nutrient.io/blog/adopting-uitextinteraction/)).
   Android reference: Compose `SelectionContainer` (`Selectable`s in a
   `SelectionRegistrar`, one `SelectionManager`; AOSP
   `MultiWidgetSelectionDelegate.kt`). Then each block is its own view and
   run merging goes away — the structural fix for the run growth that §2's
   projection cache and run cap only make cheap.
   `exclusiveSelection={false}` is NOT this item: it only stops hosts erasing
   one another's selections, which makes the manual workaround reachable
   (select in message A, select in message B, merge the two
   `onSelectionCopy` payloads). One gesture that genuinely sweeps across two
   hosts remains future work, and neither platform offers a primitive for it.
6. **Measure once, draw the same on iOS**, like `RCTParagraphComponentView`:
   measure in the shadow node, park the layout in Fabric State, draw from it.
   The attributed string already crosses that way (`RNSMRunHostState`); the
   layout does not. The same item covers the missing cache: a persistent
   per-`Content` `NSTextStorage`, spliced with the plan
   `SelectableRunHostView.apply` already computes via `RNSMTextSplice.plan`,
   so a streamed snapshot re-measures the changed middle instead of the whole
   run.
   Telegram iOS lays out CoreText off the main thread
   ([hubo.dev](https://hubo.dev/2020-06-14-source-code-walkthrough-of-telegram-ios-part-5/)).
   Both sides of measure/draw change together, under a benchmark.
7. **TextKit 2 discipline.** Lazy viewport layout is the right direction
   ([WWDC21 10061](https://developer.apple.com/videos/play/wwdc2021/10061/)),
   but large documents have stuttered until forced to TK1
   ([Apple forums](https://developer.apple.com/forums/thread/729491)), and
   touching `textView.layoutManager` flips a view to TK1 forever. The host
   already pins TextKit 1 by construction (`RNSMTextKitStack`); keep that
   and audit for accidental `layoutManager` access before any TextKit 2 move ([krzyzanowskim.com](https://blog.krzyzanowskim.com/2025/08/14/textkit-2-the-promised-land/)).
