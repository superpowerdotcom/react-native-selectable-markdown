# Performance

(measured) means a harness in this tree produced the number; (reasoned)
means inferred. External numbers are from other hardware; compare ratios
within a source only.

Harnesses and tables: [BENCHMARKS.md](BENCHMARKS.md). Incremental parsing:
[STREAMING.md](STREAMING.md). Native layers: [SELECTION.md](SELECTION.md),
[NATIVE.md](NATIVE.md).

## 1. Where the time goes

- **Parse.** A streaming append costs about 2.7 µs end to end on a 64 B tail:
  1.6 µs for md4c, wire encode and the `ArrayBuffer` crossing, 1.15 µs for
  the JS decode (measured, `bench:crossing`, 2026-09-01). About 0.02% of a 16.7 ms
  frame. Parse input per append is flat at mean 107, p95 254, max 277
  characters, the same at 1.2 kB and 9.3 kB of document (measured,
  `bench:streaming`). Parsing is not the problem.
- **Decode.** 43–53% of every parse by shape (measured, `bench:crossing`,
  2026-09-01). This half is TypeScript, and Hermes has no
  JIT, so the wire-buffer walk, span widening and entity decoding get slower
  on device (reasoned). Nothing here is measured on device yet.
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

Five changes, landed in the 0.5 to 0.10 releases.

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

The corpus is 147 table cases (169 tests in `src/stream/repair.test.ts`). `RepairResult` is unchanged;
new repairs are recorded in `touched`. New: a
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
- Decoder throughput over the wire buffer: 324–337 MB/s on prose,
  514–649 MB/s on node-dense shapes (2026-09-01). The `charCodeAt` wins should be larger
  on Hermes, which had no JIT hiding the old cost (reasoned).

### Android spannable handoff and measure cache

`RunLayoutCache` (`android/src/main/java/com/selectablemarkdown/RunLayoutCache.kt`)
caches built Spannables (LRU 128) and measurements keyed on the full
`(width, widthMode, height, heightMode)` tuple (LRU 256), like React Native's
`TextMeasureCache`. Keys include text, attributes, decorations and a
display-metrics token from `DisplayMetricsHolder.getWindowDisplayMetrics()`
(what `PixelUtil` uses), so font-scale and density changes miss by
construction. Measure (layout thread, JNI) and `commitProps` (UI thread) share
the instance, which is safe because `TextView.setText` copies a `Spanned`, so
selection spans and the `ChangeWatcher` land on the widget's copy. A
per-thread `TextPaint` in `RunTextMeasure` replaces per-measure allocation.
Recommits become one map get per run (reasoned). Not measured: no device in
the build environment. Metric 5 is for this.

### iOS append-only attributed text

`apply(attributedText:)` in `SelectableRunHostView.swift` takes a fast path
when the new string is longer and its prefix equals the `NSTextStorage`
content (`attributedSubstring(from:).isEqual(to:)`, O(prefix), no shaping).
Only the suffix is spliced (`beginEditing`, `replaceCharacters`,
`endEditing`), so TextKit relayouts the tail only. A selection in the prefix
stays valid with no save/clamp/restore; Select-All extends over the tail. Shrinks
and prefix differences take the unchanged full-swap path. Not measured;
reasoned from TextKit's documented behavior.

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
  StaticLayout is monolithic. The per-run split stays.
- **tree-sitter-style incremental parsing.** tree-sitter-markdown disclaims
  correctness, and block-level reparse is already about 3 µs (measured).

## 4. Roadmap, in recommended order

1. **On-device benchmark harness** (BENCHMARKS.md metrics 5 and 6): JS frame
   time, dropped frames, time-to-first-block, memory peak, `<Profiler>`
   commit attribution (settled-run re-renders should be zero). Two of the
   five changes above shipped unmeasured.
2. **Defer decoration of the open block** until it settles, as streamdown
   does for code ([vercel/streamdown](https://github.com/vercel/streamdown)).
   The safe anchor already marks the boundary.
3. **Appended-run fade-in**, stripped at stream end (streamdown `animated`,
   FlowToken). Pairs with frame-aligned flushes (reasoned).
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
   run merging goes away.
6. **Measure once, draw the same on iOS**, like `RCTParagraphComponentView`:
   measure in the shadow node, park the layout in Fabric State, draw from it.
   The attributed string already crosses that way (`RNSMRunHostState`); the
   layout does not.
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
