# Streaming

How `StreamSession` renders a token stream without flashes of half-parsed
syntax. The session owns the text. Before each parse, the unsettled tail goes
through a pure repair function that virtually closes or hides constructs
still arriving, so the parser never sees an unfinished one. Offsets, spans
and copy payloads always refer to the real accumulated text.

## Session lifecycle

```
new StreamSession(init?)          phase: 'streaming', revision 0, empty source
        │
        ▼
append(delta) ──────────────┐     accumulate text, advance the safe anchor,
        ▲                   │     then EITHER extend the trailing paragraph
        │                   │     without parsing (construct-free fast path)
        │                   │     OR repair + reparse only the unsettled
        └───────────────────┘     tail and splice it after the frozen
        │                         prefix; bump revision, notify subscribers
        │                         (empty delta = no-op, no notify)
        │
replace(full)                     prefix-diff: if `full` startsWith the current
        │                         text, equivalent to append(remainder);
        │                         otherwise the prefix is unstable, so full reset
        ▼                         (settled state discarded, reparse from zero)
finalize(reason?)                 reparse WITHOUT repairs, phase: 'settled'.
        │                         reason: 'end' | 'aborted' | 'failed'.
        ▼                         Idempotent: repeated calls are no-ops.
   ('settled')                    a later append/replace RESUMES streaming
                                  on the accumulated text (phase flips back
                                  to 'streaming'), e.g. an agent run that
                                  continues after a tool call.
```

Read state through `snapshot()` or `subscribe(fn)`; `<SelectableMarkdown
session={…}>` subscribes for you.

```ts
interface SessionSnapshot {
  document: ParsedDocument; // frozen prefix blocks ++ reparsed repaired tail
  settledUntil: number;       // the safe anchor, see below
  phase: 'streaming' | 'settled';
  revision: number;           // bumps on every effective update
}
```

Every parse goes through `parseDocument(source, options, engine)`, with the
`engine` and `options` from `new StreamSession({ engine, options })`
(re-exposed as `session.parseContext`). With no `engine` you get
`nativeEngine`; where the native module is not linked, the first non-empty
`append` throws and the session catches nothing. Any engine with correct
UTF-16 spans works ([Writing an engine](ARCHITECTURE.md#writing-an-engine)).

## Pacing

`append` parses on every call. `appendBuffered(delta)` pools deltas and one
scheduled flush appends them together; nothing parses or notifies until
then. `flushBuffered()` drains now. The scheduler
(`StreamSessionInit.bufferScheduler`) is one animation frame where
`requestAnimationFrame` exists, else `setTimeout(flush, 16)`.

Two options hold text back so tail ambiguity resolves before render:

- `holdBackChars` (default 0). Each flush withholds the trailing N pending
  characters, so `**bo` waits instead of rendering and being repaired a
  frame later. The cut never splits a surrogate pair; it moves one unit down.
- `holdIdleMs` (default 250). After this long with no new `appendBuffered`,
  the idle drain (`idleScheduler`, `setTimeout` by default) flushes the
  held-back characters anyway.

Every synchronous operation (`append`, `replace`, `finalize`,
`flushBuffered`) drains the pending buffer first, holdback included, so
mixing the two entry points never reorders the stream. Pending text appears
in no snapshot; `session.pendingLength` counts it, `session.length` does not.

### Smoothing

Coalescing bounds how often the document changes, not how much. A
`smoother` (`StreamSessionInit.smoother`) is consulted by each scheduled
flush with the releasable pending text (holdback excluded) and answers how
many UTF-16 units to release: `(releasable, context?) => number`. The
session clamps the answer, keeps the cut surrogate-safe, treats a non-finite
answer as "release everything", and keeps a flush scheduled while releasable
text remains. `SmootherContext` is `{ now, pendingLength, sourceLength }`,
its clock injectable through `StreamSessionInit.now`. The shipped policies,
`createAdaptiveSmoother()` and `createSmoother()`, are in the README; both
are stateful, one instance per session.

Smoothing is presentation only:

- Synchronous drains bypass it and release everything. To let a metered tail
  finish before settling, `await session.drained()` then `finalize()`. When
  the buffer empties outside a smoothed flush, the smoother gets one
  zero-offer call (empty text, `pendingLength` 0).
- It needs an asynchronous scheduler; under a synchronous `bufferScheduler`
  the session uses the idle drain instead.
- It sees only releasable text, never the holdback tail.

Link destinations cost no playout time: the href never paints mid-stream, so
a cut inside one whose closing `)` is buffered snaps past the `)` for free
(`snapPastLinkDestination`, exported from `stream/smoothing.ts`).

## The safe anchor

`settledUntil` is a line-start offset before which nothing can change, no
matter what arrives. After each parse the session finds the last top-level
block `X` satisfying all of these and anchors at the first non-blank line
after `X`'s trailing blank line(s):

1. `X` is `paragraph`, `heading`, `thematicBreak`, `table`, `blockquote`,
   `htmlBlock`, or `codeBlock` with `fenced: true` and `closed: true`.
   Appending after a blank line can never merge back into these.
2. A blank line separates `X` from what follows, and non-blank content has
   already started after it. The last begun block never settles.
3. No unclosed fence or unclosed `$$` math reaches the anchor (`$$` counts
   only when `extensions.math` is on). The scan (`continueSeed` in
   `repair.ts`) carries forward from the previous anchor.
4. `X` is not a product of repair. Blocks flagged `incomplete` or
   `synthetic` wait one update for their clean reparse.

Excluded from rule 1: `list` (a blank line does not end a list) and unfenced
`codeBlock` (indented code spans blank lines). They freeze once an
anchor-safe block after them is followed by a blank line.

### Tail-only reparse

```
tailInput = repairTail(source.slice(anchor), cleanSeed, options).text
document  = frozenPrefixBlocks ++ shiftSpans(parse(tailInput).blocks, anchor)
```

`shiftSpans` (`src/stream/shiftSpans.ts`) deep-clones each tail block with
spans rebased by `anchor`; engine output is never mutated. Frozen prefix
blocks are spliced back by reference, so settled identity holds by
construction. With no anchor yet (one giant list, a single huge paragraph, an
unclosed fence), the tail is the whole source and the update is a correct
full reparse.

### The construct-free fast path

A delta of characters outside the meta set
`` \n \r \ ` * _ ~ $ [ ] ( ) < > # | ! & - = + . : ' " ; `` can only extend
prose (`;` can complete an entity). The session then skips the engine and
clones just the last paragraph and text node with `span.end += delta.length`
and `value += delta`, when:

- the last block is a paragraph ending in a plain text node that maps 1:1
  onto the raw source and reaches the end of the text;
- the previous repair made zero changes;
- the delta does not end in a space, a tab, or a lone high surrogate;
- the last line does not end in a bare-autolink candidate (`https:`, `www.`),
  an HTML-block opener stub (`<`, `</`, `<!`, `<?`), or a token of a
  `repair.hideBareUriSchemes` scheme.

### What the anchor buys

- **Identity.** Blocks at or before the anchor are `===` in every later
  snapshot, so settled runs never re-render or remount.
- **O(tail) parse input.** `bench/streaming-replay.mjs` reports characters
  handed to the engine per append. The win is asymptotic (on the small
  bundled transcript, bookkeeping costs more than a full md4c reparse) and
  needs the stream to keep producing anchor-safe blocks.
- **Selection stability.** Settled runs keep stable spans. Tail-run
  selectability is a per-platform view policy ([SELECTION.md](SELECTION.md)).

Gates: `conformance/streaming/prefix-oracle.test.ts` (every prefix's
snapshot deep-equals a fresh parse of the same repaired source) and
`src/stream/incremental.test.ts` (parse input stays tail-sized).

## Tail repair

`repairTail(tail, seed, options)` is pure: same input, same output.

```ts
interface RepairResult {
  text: string;         // the tail as it should be fed to the parser
  appended: string;     // pure virtual suffix, past all real offsets
  touched: SourceSpan[]; // tail spans altered or suppressed for display
}
```

Virtual closers go after every real offset, so source offsets are unaffected.
Nodes overlapping a repaired region get `incomplete: true`; content with no
source at all gets `synthetic: true`.

### Handler table

Handlers run in priority order. Each fires only on evidence of an open
construct, never speculatively.

| # | Handler | Trigger (guard) | Action |
| --- | --- | --- | --- |
| 0 | Split surrogate pair | The tail's final code unit is a lone high surrogate, because a delta cut a pair in half | Drop it from the parse input (touched span); the low half rejoins it on the next chunk. Runs before every other handler, so no handler ever sees invalid UTF-16 |
| 1 | Open fence | Inside an unclosed fence, from `seed.openFence` or a fence opened in the tail | Virtually close the fence for the parse (the block is flagged `incomplete`); no inline repairs apply inside code |
| 2 | Inline code | An odd backtick run is open at tail end | Append a matching backtick run |
| 3 | Emphasis / strong / strike | An open delimiter with content: `**x` becomes `**x**`, `*x` becomes `*x*`, likewise `__x` / `_x`, `~~x`; half-complete closers healed (`**x*` becomes `**x**`) | Append the matching closer. Never close a content-empty opener (`**` alone is left; paragraph-suppressed instead). Intraword `_` is never treated as open, so `snake_case` is untouched |
| 4 | Math (only when `extensions.math`) | Unclosed `$$`, seeded or opened in the tail | Append `$$`; the math node is flagged `incomplete`. A content-empty `$$` is suppressed instead. A single `$` is never touched and stays literal text (currency guard) |
| 5 | Links / images | `[text](partial-url` or `[text](`: virtually close, then flag the link `incomplete: true` with an empty-safe href (no magic placeholder URLs). Lone `[text`: strip the `[` for display (touched span). A `]` as the tail's final character holds the construct back until the next chunk disambiguates `(` from literal text: `[text]` loses both brackets (`text`), a would-be image `![alt]` is dropped entirely. Unterminated image `![alt](…` | Incomplete links render as flagged links; incomplete images are dropped from display entirely |
| 6 | Partial HTML tag or autolink | Tail ends in `<` starting a plausible tag (`<div cla`) or a partial autolink (`<scheme:rest` with no closing `>`); `5 < 10` untouched | Trim the partial tag or autolink from display, to end of tail (touched span) |
| 7 | Structure-flip guards | Trailing unterminated line that is only `#`s, `>`s, a bullet or ordered-list marker (up to 3 digits), or a run of `-`, `=`, `+`, `*`, `_` or `~`, i.e. one that would flip the previous paragraph into a setext heading, open an empty block, or become a thematic break | Suppress the line from parse input for this snapshot (paired with placeholder trimming below) |

After parsing, `trimTrailingPlaceholders(blocks)` drops trailing empties (an
empty heading, list item, blockquote or fence, a partial table row) from the
tail's display; the session's text keeps every byte. If nothing needs
trimming the same array comes back.

### Corpus

The repair corpus has 147 table cases, including the surrogate drop
(handler 0), the `]`-at-tail holdback (handler 5), partial autolinks
(handler 6), and bare-CR or split-CRLF line endings, which count as line
endings for handler 7 and the emphasis-closer trim (`**x\r` becomes `**x**`).

Two non-repairs are pinned as intentional: single-dollar math stays literal
(md4c keeps it literal, so there is no flash to prevent), and `[text][r`
strips only the trailing `[`, yielding `[text]r`. The blank-line split that
isolates earlier paragraphs from inline repair accepts LF, CRLF and bare CR.

### The `incomplete` and `synthetic` flags

| Flag | Meaning | Example |
| --- | --- | --- |
| `incomplete: true` | The node's tail construct was virtually repaired; its source is not finished yet | `**bold` mid-stream gives a `strong` node flagged incomplete |
| `synthetic: true` | Content that does not exist in the source at all | the repaired `**` closer |

Selection and copy skip synthetic content. Renderers may style incomplete
nodes differently. Both flags exist only during streaming.

## Finalize semantics

`finalize(reason?)` is the contract that streaming artifacts are temporary.

- It reparses the full text without repairs and sets `phase: 'settled'`,
  `settledUntil` = full length: the one O(n) parse per stream. Frozen blocks
  are swapped back in by kind and span, so identity survives.
- All `incomplete` and `synthetic` flags vanish. The result equals a fresh
  `parseDocument(session text)`.
- Unfinished input stays unfinished. An unclosed fence is still a
  `codeBlock` with `closed: false`.
- Idempotent, not terminal. A second `finalize` is a no-op. A later `append`
  or `replace` resumes streaming; call `finalize` again when it ends.
- `reason` (`'end' | 'aborted' | 'failed'`) does not change parsing.

Aborted streams never deliver an END event, so `useAgUiSession` finalizes on
message end and on run finalized or failed. Driving a session by hand, wire
abort and error paths to `finalize('aborted' | 'failed')`, or the last
repaired render stays up forever.

`bindRunTextEvents` / `useAgUiRunSessions` own this for a whole run. At run
end, a session with nothing pending finalizes (one fed during this run is
re-checked a macrotask later first, since a render-loop-fed host may still
deliver its last append); a session still metering gets `notifyRunFinalized`
and is held (`policy.onHoldChanged`, or the hook's `holding`) until
`drained()` resolves. `runEndGraceMs` plus `expectsLateRow`
keep the hold up, bounded, for a one-burst answer whose run end arrives
before its text. `onAttached` flushes every buffered session in one commit.
`RunFailureInfo.disposition: 'benign'` leaves sessions streaming for a
resume; anything else flushes and finalizes.

## Protocol edge cases

- `append('')` and `appendBuffered('')` are no-ops: no reparse, no revision
  bump, no notification.
- `appendBuffered` deltas appear in no snapshot until their flush. Every
  synchronous call drains them first, in arrival order.
- `replace(full)` with a stable prefix appends only the remainder and keeps
  settled identity. With an unstable prefix it is a full reset.
- `rewrite(full)` is the metered companion to `replace`. When `full` starts
  with the committed source, the pending buffer is swapped for the new tail
  with no drain, so a smoother keeps metering through it. When `full` equals
  committed plus pending, it is a no-op. Anything else falls back to
  `replace(full)`.
- Deltas may split anywhere, including mid-emoji. A delta ending in a lone
  high surrogate is dropped from the parse input until its low half arrives
  (handler 0). The holdback and smoother cut never splits a surrogate pair, a
  ZWJ sequence, or a base from its variation selector or skin-tone modifier.
