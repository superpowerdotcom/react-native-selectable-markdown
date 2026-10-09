# Streaming

How `StreamSession` renders a token stream without flashes of half-parsed
syntax. The session owns the text. Before each parse, the unsettled tail goes
through a pure repair function that virtually closes or hides constructs
still arriving, so the parser never sees an unfinished one in the block being
written. Where the repair only appends, the offsets of REAL characters are
untouched — a virtual closer lands past every one of them — but the repaired
node's own span is not: it absorbs the closer, and so do
`snapshot.document.source` and a copy of that span. Where the repair hides
characters instead, offsets, spans and copy all follow the repaired text,
which is shorter. Both cases are worked through in
[Tail repair](#tail-repair).

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
        │                         (an empty delta appends nothing, but the
        │                         pending-buffer drain still runs)
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

dispose()                         callable at any point: cancel both timers,
                                  DROP pending text, resolve drained(), drop
                                  subscribers. Inert afterwards; snapshot()
                                  still reports the last commit.
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

`snapshot()` returns the same object between commits, including before the
first one, so it can be a `useSyncExternalStore` getter directly:

```ts
const snap = useSyncExternalStore(
  (cb) => session.subscribe(cb),
  () => session.snapshot(),
);
```

Listeners run synchronously, in registration order. A listener may append or
finalize; the nested commit is delivered to everyone after the current pass
finishes, so no listener is handed an older revision after a newer one. Two
bounds hold on that loop. A listener that mutates the session on EVERY
callback is stopped after 10,000 notification rounds with an error naming the
cause (it used to overflow the stack, then hang). And a listener that throws
no longer costs the listeners after it their snapshot: delivery and any
pending pass complete, then the first error is rethrown to the caller, so no
subscriber is left a revision behind `session.snapshot()`.

Every parse goes through `parseDocument(source, options, engine)`, with the
`engine` and `options` from `new StreamSession({ engine, options })`
(re-exposed as `session.parseContext`). With no `engine` you get
`nativeEngine`; where the native module is not linked, the first append that
leaves non-empty repaired parse input throws and the session catches nothing
— an append whose whole tail is a suppressible marker (`#`, `-`, `>`, `**`,
`1.`) parses nothing and commits an empty snapshot instead. Every parsing
entry point is atomic up to its commit — `append`, `finalize`, and `replace`
and the `rewrite` fallback too: a parse that throws restores the source,
phase, anchor, frozen prefix, `lastBlocks` and the carried tail scan, plus
the settled-block identity cache on the divergent path (the only path that
clears it), so `session.length` and `snapshot()` never disagree and the
delta is not half-applied. On the `appendBuffered` path the throw
surfaces from the scheduler callback (the frame or idle timer), not from the
`appendBuffered` call site, so it cannot be caught there; the released text
goes back into the pending buffer and the idle drain is re-armed, so the
tail is not stranded and `drained()` still resolves if the engine recovers.
A drain the engine keeps refusing re-arms that idle drain with an
exponential backoff — the idle delay doubles per consecutive failure, up to
16× (4 s at the default), and the first success resets it — so a
persistently throwing engine, the unlinked native module being the obvious
one, retries from the timer instead of stranding the held tail after one
attempt with `drained()` parked forever. That ladder is bounded. After
`MAX_DRAIN_RETRIES` (8) retries of a refused drain — 250 ms doubling to 4 s,
about 20 s of retrying in all at the default — the session arms no further
timer and REJECTS every outstanding `drained()` with the engine's own error,
and rejects immediately for any `drained()` called while it stays given up.
Nothing is dropped: the text stays in the pending buffer, `pendingLength`
still counts it, an explicit drain (`append`, `flushBuffered`, `replace`,
`finalize`) retries the parse once — a success clears the given-up state, a
failure throws to the caller and leaves it set — and new `appendBuffered` or
`rewrite` input starts a fresh ladder, so a session whose engine comes back
keeps every character. A
caller awaiting `drained()` must therefore handle a rejection.
`bindRunTextEvents`' park-behind-drain does: it releases its hold (so
`holding` goes back to `false`), skips the finalize that would hand the same
text to the same engine, and reports the engine error once in DEV.

Any engine with correct UTF-16 spans splices correctly
([Writing an engine](ARCHITECTURE.md#writing-an-engine)), but the streaming
layer on top of it is CommonMark-specific: a substituted engine is handed
the virtual closers and suppressed lines this file describes, and its own
construct characters must be a subset of `CONSTRUCT_CHARS`
(`src/stream/StreamSession.ts`) or the fast path leaves stale structure on
screen until one of those characters arrives.

## Pacing

`append` parses on every call. `appendBuffered(delta)` pools deltas and one
scheduled flush appends them together; nothing parses or notifies until
then. `flushBuffered()` drains now. The scheduler
(`StreamSessionInit.bufferScheduler`) is one animation frame where
`requestAnimationFrame` exists, else `setTimeout(flush, 16)`.

Two options hold text back so tail ambiguity resolves before render:

- `holdBackChars` (default 0). Each flush withholds the trailing N pending
  characters, so `**bo` waits instead of rendering and being repaired a
  frame later. The cut never splits a visible glyph: it retreats to the
  nearest cluster boundary, so the whole cluster stays pending (the last
  bullet under [Protocol edge cases](#protocol-edge-cases) says which
  clusters are recognised). Every scheduled flush, metered or not, also holds
  back a trailing cluster that could still GROW: when the pending buffer's last code point
  is non-ASCII it waits for one more code point — or for the idle drain or
  `finalize` — which costs one code point of latency and is why a flag or an
  emoji arriving in two deltas never commits half a glyph.
- `holdIdleMs` (default 250). After this long with no new `appendBuffered`,
  the idle drain (`idleScheduler`, `setTimeout` by default) flushes the
  held-back characters anyway.

Every synchronous operation (`append`, `replace`, `finalize`,
`flushBuffered`) drains the pending buffer first, holdback included, so
mixing the two entry points never reorders the stream. Pending text appears
in no snapshot; `session.pendingLength` counts it, `session.length` does not.

`dispose()` ends a session that is being dropped before its stream ends (a
row unmounting mid-run, a screen popping). It cancels the scheduled flush
and the armed idle drain, drops the pending text unparsed and uncommitted,
resolves every outstanding `drained()`, and drops every subscriber;
afterwards `append`, `appendBuffered`, `flushBuffered`, `replace`,
`rewrite`, `finalize` and `notifyRunFinalized` do nothing, `subscribe`
returns a no-op unsubscribe without registering, and `snapshot()`, `length`
and `parseContext` keep reporting the last committed state. Idempotent.
Unsubscribing does not stop the work: a smoother re-schedules its flush
every frame while it withholds text, and holdback arms an idle drain. To
keep the tail instead of discarding it, call `flushBuffered()` (or
`finalize()`) first.

`suspend()` cancels scheduled flushes and idle drains while retaining input,
subscribers, and snapshots. `resume()` schedules remaining buffered input.
These methods are reversible; `dispose()` permanently ends the session.

### Smoothing

Coalescing bounds how often the document changes, not how much. A
`smoother` (`StreamSessionInit.smoother`) is consulted by each scheduled
flush with the releasable pending text (holdback excluded) and answers how
many UTF-16 units to release: `(releasable, context?) => number`. The
session clamps the answer, keeps the cut on a cluster boundary, treats a
non-finite answer as "release everything", and keeps a flush scheduled while
releasable text remains. After every metered flush it calls
`smoother.notifyReleased(released)` with the number of units that ACTUALLY
landed, which is rarely the answer: the cluster-safe retreat releases less
(possibly nothing, when the cut is parked inside a glyph) and the link snap
releases more, budget-free. A policy that charges a budget for its own answer
must implement that channel or a glyph it cannot yet afford charges it every
frame and the reveal stalls for good — `createSmoother` does, refunding the
unreleased part and letting the budget accrue past its one-credit-window cap
while a release is blocked. A stateless pacing function needs nothing.

`SmootherContext` is `{ now, pendingLength, sourceLength }`, its clock
injectable through `StreamSessionInit.now`. `sourceLength + pendingLength` is
the arrival signal, and it is NOT monotone: `rewrite()` swaps a shorter
unrevealed tail in (the citation rewrite `[ApoB](fhir://…)` → `ApoB [1](#…)`
shrinks it on every completion) and a divergent `replace()` can shorten the
document for good. An arrival tracker must therefore REBASE on a drop —
subtract it from the samples still in the window, as `createAdaptiveSmoother`
does. Sampling the dip raw reads as negative arrival for a whole rate window,
and clamping to a high-water mark depresses the estimate for longer still,
because arrival has to re-fill the deleted region before the series moves at
all. The shipped policies, `createAdaptiveSmoother()` and `createSmoother()`,
are in the README; both are stateful, one instance per session.

Smoothing is presentation only:

- Synchronous drains bypass it and release everything. To let a metered tail
  finish before settling, `await session.drained()` then `finalize()`. When
  the buffer empties outside a smoothed flush, the smoother gets one
  zero-offer call (empty text, `pendingLength` 0).
- It needs an asynchronous scheduler; under a synchronous `bufferScheduler`
  the session uses the idle drain instead.
- It sees only releasable text, never the holdback tail.
- A flush that releases nothing arms the idle drain as a backstop, once per
  stalled run — frames alone would spin forever on a cut parked inside a
  cluster the budget cannot afford. A flush that makes progress disarms it
  again, so a timer armed by an earlier stall cannot fire into a moving
  reveal and dump the buffer in one commit.

Link destinations cost no playout time: the href never paints mid-stream, so
a cut inside one whose closing `)` is buffered snaps past the `)` for free
(`snapPastLinkDestination`, exported from `stream/smoothing.ts`).

## The safe anchor

`settledUntil` is a line-start offset before which nothing can change, no
matter what arrives, for as long as the session is streaming (`finalize`
sets it to the full length as an end-of-stream marker, not a permanence
guarantee — see [Finalize semantics](#finalize-semantics)). After each parse
the session finds the last top-level block `X` satisfying all of these and
anchors at the first non-blank line after `X`'s trailing blank line(s):

1. `X` is `paragraph`, `heading`, `thematicBreak`, `table`, `blockquote`, an
   `htmlBlock` that is not an OPEN CommonMark type 1-4 block, or `codeBlock`
   with `fenced: true` and `closed: true`. Appending after a blank line can
   never merge back into these.
2. A blank line separates `X` from what follows, and non-blank content has
   already started after it. The last begun block never settles.
3. No unclosed fence reaches the anchor. The scan (`continueSeed` in
   `repair.ts`) carries an open fence forward from the previous anchor; `$$`
   math (`extensions.math` only) is tracked per block and cleared at every
   blank line, because md4c's `$$…$$` spans are inline and end with their
   block, so a paragraph left holding an unclosed `$$` — `costs $$5` —
   settles like any other prose instead of freezing the anchor for the rest
   of the stream.
4. `X` is not a product of repair. Blocks flagged `incomplete` or
   `synthetic` wait one update for their clean reparse.
5. No link reference definition (`[label]: dest`) has appeared anywhere in
   the source. Definitions act at a distance in both directions — one
   arriving late turns a `[foo]` in an already-frozen paragraph into a
   resolved link, and one written early would be invisible to a tail parse
   that starts after it — so from the first definition-shaped line the
   session unfreezes everything and reparses the whole source per append:
   `settledUntil` goes back to 0 and stays there. The identity cache
   survives, so blocks the definition did not actually change keep their
   objects through finalize. The detection strips container prefixes first —
   any nesting of `>` markers and list markers, so `- [foo]: /url` and
   `> [foo]: /url` both count — and then the CONTENT INDENT those containers
   establish, so a definition written at a list item's content column with no
   marker of its own is found too (`- item` + blank + `    [foo]: /url`, and
   `- outer` / `  - inner` / `    [foo]: /url`); the indent comes back down
   only on a shallower non-blank line that follows a blank one. It carries an
   unterminated `[label` across a line break (`[foo` / `bar]: /url`), with a
   blank line ending the label. It stays syntactic and pessimistic in the same
   direction: a definition-shaped line inside a fenced code block stands the
   anchor down too, and any line reached by RESUMING a label left open above
   is judged on `]:` alone — it no longer asks whether that line could open a
   definition. The answer does not depend on where the deltas fall: a
   one-code-point-per-append stream and a line-by-line stream stand the anchor
   down on exactly the same sources. Mid-stream the trailing container holding
   nothing but the definition is an empty placeholder block the streaming
   document trims, so a snapshot then equals a fresh parse minus that block,
   while `finalize` equals it exactly.

Excluded from rule 1: `list` (a blank line does not end a list), unfenced
`codeBlock` (indented code spans blank lines), and `htmlBlock` of CommonMark
types 1-4 (`<script>`/`<pre>`/`<style>`/`<textarea>`, `<!--`, `<?`, `<!`),
which do not end at a blank line but run to their own end condition; types 6
and 7 (`<div>`, unknown tags) do and still anchor. The start conditions are
md4c's, not CommonMark's prose, because md4c is the parser these blocks come
from: type 1 needs no delimiter after the tag name (`<pretty` opens one),
type 2 needs at least one character after `<!--`, and type 4 is `<!` followed
by ANY ASCII character — so `<!5`, `<!-`, `<! ` and a partial `<![CDATA` are
all blank-line-spanning blocks that end at the first `>`, and type 5
(`<![CDATA[` … `]]>`) is unreachable because type 4 claims it first. The
type 1-4 exclusion is keyed on the block's own literal, not on its opener,
and holds only while the block is still OPEN: one that already contains its
end condition (`</script>`, `</pre>`, `</style>`, `</textarea>`, `-->`,
`?>`, a declaration's `>`) cannot grow, so it anchors like anything
else — the same argument `closed: true` makes for a fenced code block. A
literal matching no start condition is one md4c did not start as type 1-4, so
a blank line really does end it and it anchors as types 6 and 7 do.
Keying on the opener alone cost every raw-HTML stream its anchor entirely: a
document of one-line `<!-- … -->` blocks reparsed from offset 0 on every
append. None of the `htmlBlock` cases is reachable under the default
`html: 'strip'`, which emits no `htmlBlock` node at all. Every excluded block
freezes once an anchor-safe block after it is followed by a blank line.

### Tail-only reparse

```
repaired = repairTail(source.slice(anchor), cleanSeed, options, repair, carry)
document = frozenPrefixBlocks ++ shiftSpans(parse(repaired.text).blocks, anchor)
```

`shiftSpans` (`src/stream/shiftSpans.ts`) deep-clones each tail block with
spans rebased by `anchor`; engine output is never mutated. The clone walks
an explicit job stack rather than recursing, as do
`trimTrailingPlaceholders` and finalize's structure check, so nesting depth
costs heap rather than stack: a 40 kB `> ` prefix streams, freezes and
finalizes instead of throwing `RangeError` out of an append. Frozen prefix
blocks are spliced back by reference, so settled identity holds by
construction. With no anchor yet (one giant list, a single huge paragraph, an
unclosed fence), the tail is the whole source, so the update is a correct
full reparse plus a full repair pass over the same text. The parse is
unavoidable; the repair's inline scan resumes from the previous append
(`carry`, below) instead of restarting, so only the new delta is scanned and
the pass measures about a third of the md4c parse beside it on a 32 kB
paragraph streamed in 18-character deltas.

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
- the last line does not end in a bare-autolink candidate — `http:`,
  `https:`, `ftp:` (md4c's permissive-autolink `scheme_map`, kept as
  `PERMISSIVE_AUTOLINK_SCHEMES` and pinned against the vendored C source by
  `src/stream/incremental.test.ts`), `www.`, or a last token containing `@`,
  the bare-email form — nor in an HTML-block opener stub (`<`, `</`, `<!`,
  `<?`), nor in a token of a `repair.hideBareUriSchemes` scheme.

### What the anchor buys

- **Identity.** Blocks at or before the anchor are `===` in every later
  snapshot. Settled runs never remount: a settled run is keyed
  `run:${span.start}` and its start never moves, while the LAST run of a
  stream-driven document is keyed by position (`run:tail`,
  `src/view/runIdentity.ts`) for as long as the document holds more than one
  run, so a settle hands the host new text instead of recycling the native
  view. Re-rendering splits the same way: an untouched settled run re-renders
  zero times, and the one run that absorbs a newly settled block —
  `segmentRuns` merges each one into the run before it — gets a new span and
  block list and re-renders once per settle. That re-render is bounded work,
  not O(document): `projectRun` extends the previous projection with the
  appended blocks only (`createRunProjectionCache`,
  `src/view/projectionCache.ts`). `DEFAULT_MAX_RUN_CHARS` (8000 source
  characters) bounds how much text accumulates under one native host, but
  only by breaking the merge BETWEEN blocks — a single block longer than the
  cap is still one oversized run, as the bundled giant-list transcript's
  21,880-character list is. `bench:projection` holds projected characters per
  document character flat at 5.2× across a doubling of the bundled
  sprint-review transcript, against 32.6× then 64.6× with the cache taken
  away, and it gates that: cached amplification growing more than 1.25× per
  doubling exits 1, and both `ci.yml` and `release.yml` run it.
- **O(tail) parse input.** `bench/streaming-replay.mjs` reports characters
  handed to the engine per append. Bookkeeping is not tail-sized: the
  snapshot's block array is rebuilt on every append, so per-append work is
  linear in the TOTAL block count even where the parse input is O(tail);
  anchor advances themselves register only the newly frozen blocks. That
  array rebuild is what remains — `document.blocks` is a freshly built plain
  array per snapshot whose settled elements are shared by reference, and
  making it a shared structure with a lazily appended tail would change the
  public document shape. The shape of that cost: a fast-path append on a
  constant-size tail measured ~3 µs at 100 blocks and ~7 µs at 3,000 in a
  Node probe on a laptop.
- **Wall time depends on anchoring and document size.** The reported ratio is the median streamed append total divided by the median naive full-reparse total, over repeated replays. At the small default fixture, scheduling and warmup can move it across 1.0; a larger transcript with anchor-safe blocks benefits more. A never-anchoring list can cost more than naive reparsing. [BENCHMARKS.md](BENCHMARKS.md) records dated samples rather than guaranteed bounds; compare the printed spread and repeat on the target runtime.
- **Selection stability.** Settled runs keep stable spans. Tail-run
  selectability is a per-platform view policy ([SELECTION.md](SELECTION.md)).

Gates: `conformance/streaming/prefix-oracle.test.ts` — every prefix's
snapshot deep-equals a fresh parse of the same repaired source, over every
fixture under `presets.llmChat`, `smartPunctuation: true` and `html: 'raw'`
(the options that decouple a text node's value from its source slice, which
is what the fast path's `text.value !== raw` guard exists for), plus a
spoilers-on sweep and a link-reference-definition case, and every fixture
replayed a second time through the buffered entry point (`appendBuffered`
with `holdBackChars: 4`, injected frame and idle schedulers and a fixed-rate
`createSmoother`), so coalescing, holdback and smoothing are gated against
md4c rather than only against the toy engine in
`src/stream/buffering.test.ts` — and `src/stream/incremental.test.ts` (parse
input stays tail-sized).

## Tail repair

`repairTail(tail, seed, options, repair?, carry?)` is pure: same arguments,
same result.

```ts
interface RepairResult {
  text: string;            // the tail as it should be fed to the parser
  appended: string;        // pure virtual suffix, past all real offsets
  touched: SourceSpan[];   // tail spans altered or suppressed for display
  scan?: RepairScan | null; // carry-forward state for the next call
}
```

`repair` is the display-repair options (`hideUriLikeLabels`,
`hideBareUriSchemes`, below). `carry` is the previous call's `result.scan`,
an opaque `RepairScan` that lets the inline pass resume where it left off
instead of re-deriving its state from the start of the tail. It changes
speed, never the answer (pinned by a differential fuzz in
`src/stream/repair.test.ts`), and is valid only when the previous tail is a
prefix of this one under the same options and anchor — which is why
`StreamSession` owns it and drops it on a divergent `replace` or `rewrite`,
on `finalize`, and on every anchor advance.

Virtual closers go after every real offset, so the offsets of real
characters are unaffected — but the repaired node's own span is not, and
neither is `snapshot.document.source`: both run past the accumulated text by
`repaired.appended.length`, so a copy of that span reproduces the virtual
closer. `append('**x')` gives `session.length` 3, `document.source` `"**x**"`
and a `strong` span `{0,5}`, which copies as `**x**`, not `**x`. A repair
that DELETES moves real offsets instead: the lone-`[` strip and the
cuts to end of tail for an incomplete image, a partial tag or a hidden URI
make `snapshot.document.source` and every tail span shorter than the session
text by exactly the deleted characters (`append('Click [here')` gives
`session.length` 11 and `document.source` `"Click here"`, with the text node
at `{0,10}`). Copy slices that repaired source (`src/selection/copy.ts`), so
a mid-stream tail copy omits the hidden characters rather than reproducing
the raw accumulated text. Nodes overlapping a repaired region get
`incomplete: true`; content with no source at all gets `synthetic: true` —
those flags and the touched spans are what consumers should test, not the
offsets.

### Handler table

Handlers run in priority order. Each fires only on evidence of an open
construct, never speculatively. Closers are only ever appended for openers
in the LAST leaf block of the tail: the inline region restarts at the last
line that opens one — a list-item marker, an ATX heading, a fence, a
thematic break, a blockquote the previous line was not part of, a
quote-internal blank line, the line after any self-contained line (heading,
thematic break, setext underline, table row), GFM table rows when tables are
on, and any line opening a CommonMark HTML block (start conditions 1-6:
`<script>`/`<pre>`/`<style>`/`<textarea>`, `<!--`, `<?`, `<!X`, `<![CDATA[`,
and the block-tag list; condition 7 is deliberately absent, because it cannot
interrupt a paragraph). Without that last boundary a closer for an opener in
the paragraph above a `<div>` was appended INSIDE the HTML block — invisible
under `html: 'strip'`, painted into the markup under `'raw'`. An opener
stranded in an earlier list item, heading or table row stays literal for a
snapshot instead of being closed into the block that follows it: appending
there would paint a delimiter the source does not contain and consume a real
one further down (`- a _b\n- c _d`). Cells of a REAL table row — one with a
delimiter row — are separate inline contexts as well, because GFM splits a
row into cells before any inline parsing runs: an opener behind the row's
last unescaped `|` gets no closer and stays literal. A pipe-covered line with
no delimiter row under it is still a paragraph, where emphasis binds straight
across the pipes.

| # | Handler | Trigger (guard) | Action |
| --- | --- | --- | --- |
| 0 | Split surrogate pair | The tail's final code unit is a lone high surrogate, because a delta cut a pair in half | Drop it from the parse input (touched span); the low half rejoins it on the next chunk. Runs before every other handler, so no handler ever sees invalid UTF-16 |
| 1 | Open fence | Inside an unclosed fence, from `seed.openFence` or a fence opened in the tail; a fence opened on a list-marker line — a `-` or `1.` marker followed by the fence run — counts, at the item's content column, and a closing run indented up to that column + 3 closes it | Virtually close the fence for the parse (the block is flagged `incomplete`), appending the closer at the opener's column so it lands inside the item; no inline repairs apply inside code. Blockquote prefixes are deliberately not stripped, so a fence inside a `>` quote is invisible to this scan on both its opener and its closer |
| 2 | Inline code | A backtick run is open at tail end | Append only the backticks the closing run is still missing, so a partial closer is completed rather than overshot. Appending a full run on top of one would fuse into a run CommonMark can never use as a closer, leaving the span literal with backticks that are nowhere in the source — the code-span analogue of the half-complete closers handler 3 heals |
| 3 | Emphasis / strong / strike | An open delimiter with content: `**x` becomes `**x**`, `*x` becomes `*x*`, likewise `__x` / `_x`, `~~x`; half-complete closers healed (`**x*` becomes `**x**`) | Append the matching closer. Never close a content-empty opener (`**` alone is left; paragraph-suppressed instead). Intraword `_` is never treated as open, so `snake_case` is untouched |
| 4 | Math (only when `extensions.math`) | Unclosed `$$`, seeded or opened in the tail | Append `$$`; the math node is flagged `incomplete`. A content-empty `$$` is suppressed instead. A single `$` is never touched and stays literal text (currency guard) |
| 4b | Spoilers (only when `extensions.spoilers`) | An odd number of `\|\|` marker runs in the inline region (a run is exactly two pipes; one or three-plus is prose), the last of them with content after it | Append `\|\|` — or just the one pipe a half-arrived closer is missing, so a partial closer does not fuse into a run of three. The spoiler node is flagged `incomplete`. A content-empty marker at end of tail is suppressed instead: closing it would make four pipes, which pair nothing. Pipes are left alone inside a REAL table — a delimiter row, a header row with a delimiter row under it, or a body row under one — because `\|` is cell syntax there, which is why `applySpoilers` excludes table cells. A header row STILL ARRIVING counts as table syntax too when it opens with a single pipe and holds another (`\| a \|\| c \|`): its delimiter row cannot have landed yet, and closing that empty cell hid content and painted a pipe. A line opening with a DOUBLED pipe (`\|\|secret`) is still a spoiler — standing down on any line that merely STARTS with a pipe is what leaked a spoiler opening its own line, a `- \|\|secret` list item and an indented `  \|\|secret` in the clear for the whole stream. The upward walk that looks for a body row's delimiter row is bounded at 1024 rows and answers "not a table" at the ceiling, where answering "table" leaked the body after that many pipe-bearing prose lines. The closer is also suppressed when an escaped pipe (`\\\|`) appears — tested over the text node holding the opener, through to the end of the region, which is the span `applySpoilers` itself judges: a region-wide test stood the repair down where the transform builds the spoiler happily (``a `x \\\| y` and \|\|secret``, whose escaped pipe is inside a code span) |
| 5 | Links / images | `[text](partial-url` or `[text](`: virtually close, then flag the link `incomplete: true` with an empty-safe href (no magic placeholder URLs). A `](` whose destination runs into a line break can never close (a CommonMark destination holds no line break), so it is left literal instead; a backslash immediately before the line ending does not escape it — CommonMark makes it a hard break, and a destination still cannot span the break — so `a [x](/u\` + newline + `more prose` is left literal like any other broken destination rather than gaining a `)` on the following line. The whitespace before the closing `)` may hold a break, so `[a](/u "t"` + newline still gets its virtual `)`. Lone `[text`: strip the `[` for display (touched span). A `]` as the tail's final character holds the construct back until the next chunk disambiguates `(` from literal text: `[text]` loses both brackets (`text`), a would-be image `![alt]` is dropped entirely. Unterminated image `![alt](…` | Incomplete links render as flagged links; incomplete images are dropped from display entirely |
| 6 | Partial HTML tag, autolink, comment, CDATA, PI or declaration | Tail ends in `<` starting a plausible tag (`<div cla`), a partial autolink (`<scheme:rest` with no closing `>`), or an unterminated `<!--`, `<![CDATA[`, `<?` or `<!` + letter — half-arrived openers `<!`, `<!-`, `<![CDA` included. `<! `, `<!5`, `<!-x` and `5 < 10` stay prose | Trim the construct from display, to end of tail (touched span). For a comment or CDATA section the withheld run is uncapped on purpose: under `html: 'strip'` the whole construct is deleted the moment it terminates, so nothing held back would ever have painted. An unterminated declaration (`<!` + letter) or processing instruction is withheld only to THE END OF THE LINE it opened on — `<!`/`<?` in front of prose is more often a stray character than markup, and withholding blanked the rest of a streaming paragraph (`use <!important rules` shows `use `, and the same text with a newline after it paints in full). A line is the smallest bound no single-line construct can cross: bounding by body shape instead (a character budget, or one whitespace-separated argument) re-opened the paint-then-vanish flash for `note <?php echo the thing?> end` and `note <!ENTITY nbsp "&#160;"> end`, whose bodies grew visibly and were then deleted. `<!-->` and `<!--->` are recognised as the complete empty comments md4c ends there, so the text after them no longer disappears |
| 7 | Structure-flip guards | Trailing unterminated line that is only `#`s, `>`s, a bullet or ordered-list marker (up to 3 digits), or a run of `-`, `=`, `+`, `*`, `_` or `~`, each with optional trailing spaces or tabs — md4c already reads `Title` + newline + `= ` as a setext heading, so the whitespace form has to be suppressed too — i.e. one that would flip the previous paragraph into a setext heading, open an empty block, or become a thematic break. With `extensions.tables`, also a line of nothing but table punctuation: `\|`, `\| -`, a whole `\| --- \| --- \|` delimiter row, a headerless `---\|` — but only with a non-blank line ABOVE it (a lone `\|` or `\| ` at document start, or after a blank line, is a paragraph md4c paints, and suppressing it emptied the whole parse input and blanked the document for that snapshot), and never a BODY row inside a table that already exists (`\| - \| - \|` and `\| :- \| -: \|` under a real delimiter row paint as the rows they are) | Suppress the line from parse input for this snapshot (paired with placeholder trimming below). One exception keeps the table half honest: this runs AFTER handler 4b's spoiler pairing, so a trailing line still holding a `\|\|` with `extensions.spoilers` on is NOT suppressed — deleting it would take a completed spoiler's closer with it and expose the body as prose for that snapshot (`hint: \|\|one` + newline + `\|\|`). The guard cannot tell that closer from table punctuation still arriving (`\| a \| b \|` + newline + `\|\| `), and deliberately errs towards keeping the line; the bare `\|` under a header row is suppressed as before |

Handler 4b exists because `applySpoilers` runs after the parse and returns
the paragraph untouched until it sees a closing run: without a virtual
closer the hidden body renders as ordinary prose for the whole stream and
then vanishes — the one extension where a flash leaks exactly what the
author asked to hide.

The table half of handler 7 only removes the bare `|` painting as a literal
pipe on its own line under a header row. The header row itself still paints
as a literal-pipe paragraph until its line ends, because a row is only a
table once a delimiter row follows it — that is CommonMark, no tail guard
can change it, and `holdBackChars` is the knob for it.

Two rules the inline scan applies to every handler above it. A `<…>` region
is opaque only when md4c would read it as raw HTML (a tag) or an autolink:
`a <x||y> then ||z` holds neither, so its pipes are ordinary text and the two
markers inside pair with each other — jumping from any `<` to the next `>`
hid them and appended a closer that painted pipes the source never had. And
an emphasis closer that would land after a line ending or an odd trailing
backslash is DROPPED rather than appended: it could not bind there, so
appending it painted a marker the source never had on top of the opener that
was going to paint anyway (`a *b` + newline showed two literal stars where
the source has one). Trailing spaces and tabs are trimmed instead — deleting
a line ending would join two lines the source keeps apart.

After parsing, `trimTrailingPlaceholders(blocks)` drops trailing empties (an
empty heading, list item, blockquote or fence, a partial table row) from the
tail's display; the session's text keeps every byte. If nothing needs
trimming the same array comes back.

### Corpus

The repair corpus has 251 table cases (322 tests in
`src/stream/repair.test.ts`, counting the purity, loop and carried-scan
checks), including the surrogate drop (handler 0), partial backtick closers
(handler 2), leaf-block boundaries for the inline region (handler 3),
spoiler pairs (handler 4b), the `]`-at-tail holdback and destinations
running into a line break (handler 5), partial autolinks and
comment/CDATA/PI/declaration tails (handler 6), GFM delimiter-row and
trailing-whitespace setext lines (handler 7), and bare-CR or split-CRLF line
endings, which count as line endings for handler 7 and the emphasis-closer
trim (`**x\r` becomes `**x**`).

Two non-repairs are pinned as intentional: single-dollar math stays literal
(md4c keeps it literal, so there is no flash to prevent), and `[text][r`
strips only the trailing `[`, yielding `[text]r`. The region boundary that
isolates earlier blocks from inline repair accepts LF, CRLF and bare CR.

### The `incomplete` and `synthetic` flags

| Flag | Meaning | Example |
| --- | --- | --- |
| `incomplete: true` | The node's tail construct was virtually repaired; its source is not finished yet | `**bold` mid-stream gives a `strong` node flagged incomplete |
| `synthetic: true` | Content that does not exist in the source at all | the empty padding `tableCell` synthesized for a ragged streamed table row |

A repaired closer is absorbed into the repaired node's own span — md4c folds
it in, and that node's start is real — so the node is flagged `incomplete`,
never `synthetic`; `synthetic` marks whole nodes that live entirely in the
virtual suffix. Selection and copy skip synthetic content. Renderers may
style incomplete nodes differently. Both flags exist only during streaming.

## Finalize semantics

`finalize(reason?)` is the contract that streaming artifacts are temporary.

- It reparses the full text without repairs and sets `phase: 'settled'`,
  `settledUntil` = full length: the one O(n) parse per stream. Frozen blocks
  are swapped back in by kind, span AND structure, so identity survives — a
  cached block whose content no longer matches the fresh parse is discarded
  rather than smuggled back in.
- All `incomplete` and `synthetic` flags vanish. The result equals a fresh
  `parseDocument(session text)`, unconditionally.
- `settledUntil` = full length is an end-of-stream marker, not a permanence
  guarantee. A later `append` resumes streaming and lowers it back to the
  incremental anchor, and the trailing block(s) below the previously
  reported value re-parse — content and identity both (`A\n\nsecond *part`
  finalizes at `settledUntil` 15; `append('*')` gives 3 and turns flat text
  into text + emphasis). Do not treat `settledUntil` as monotone across a
  finalize → append cycle.
- Unfinished input stays unfinished. An unclosed fence is still a
  `codeBlock` with `closed: false`.
- Idempotent, not terminal. A second `finalize` is a no-op. A later `append`
  or `replace` resumes streaming; call `finalize` again when it ends.
- `reason` (`'end' | 'aborted' | 'failed'`) does not change parsing.

Aborted streams never deliver an END event, so `useAgUiSession` finalizes on
message end and on run finalized or failed. A messageId switch settles too:
when the hook's `messageId` changes while the outgoing message is still
streaming, that session is finalized with `'aborted'` rather than left in
phase `'streaming'` showing its last tail repair. It stays in the hook's map,
so switching back shows the settled document. The settle is deferred one
macrotask and cancelled if the same session is bound again first, so
StrictMode's mount/unmount/remount and a switch away-and-back inside one tick
do not end a live message, and an `events` identity change alone only
rebinds. Driving a session by hand, wire abort and error paths to
`finalize('aborted' | 'failed')`, or the last repaired render stays up
forever.

`bindRunTextEvents` / `useAgUiRunSessions` own this for a whole run. At run
end, a session with nothing pending finalizes (one fed during this run is
re-checked a macrotask later first, since a render-loop-fed host may still
deliver its last append); a session still metering gets `notifyRunFinalized`
and is held (`policy.onHoldChanged`, or the hook's `holding`) until
`drained()` resolves. `runEndGraceMs` plus `expectsLateRow`
keep the hold up, bounded, for a one-burst answer whose run end arrives
before its text. `onAttached` flushes every buffered session in one commit.
`RunFailureInfo.disposition: 'benign'` leaves sessions streaming for a
resume; anything else flushes and finalizes. The three run-lifecycle
callbacks (`onRunStarted`, `onRunFinalized`, `onRunFailed`) take an optional
trailing `runId`, and a host that has one should pass it: `bindRunTextEvents`
remembers the ids of the runs it watched go SPENT — superseded by a later
observed run start, or ended by their own run finish — and ignores a
`RUN_FINISHED` / `RUN_ERROR` carrying one, so a superseded run's late event
cannot settle the live run's sessions. It drops only ids it knows are spent
RIGHT NOW: a run whose start this binding never saw (a resume, a reconnect, a
run created elsewhere) — or saw start again — still settles, because
stranding its sessions in `'streaming'` forever is worse than a premature
settle, which the next delta heals. Spent is not permanent: an id is revived
the moment its run STARTS AGAIN, because a fresh `onRunStarted` carrying it
(a retry reusing the id, a replayed start, interleaved runs coming back to
one) means the run is live, and filtering its end would strand its sessions
in `'streaming'` for the binding's life. `onAttached` clears the spent-run
memory outright, with the rest of the run observation: catch-up covers a gap
the binding cannot see into, so nothing it remembers as spent is trustworthy.
With no ids at all nothing is filtered, so such a host must not forward
events from a run it no longer observes. `bindMessageEvents` and
`useAgUiSession` never filter — they observe no run start. Both hooks
suspend session timers when their effects disconnect and resume them on
reconnection, preserving React Activity's retained state. Eviction disposes
a session permanently. Detaching a binding alone only unsubscribes; a new
binding preserves the session's buffered routing even when its buffer is
empty between arrivals. Hosts without `onRunStarted` may reuse a run ID;
spent-ID filtering requires a run-start subscription.

## Protocol edge cases

- `appendBuffered('')` is a no-op: nothing is pooled, no flush is scheduled.
  `append('')` appends nothing, but it drains the pending buffer first like
  every synchronous call, so with buffered text waiting it reparses, bumps
  the revision and notifies exactly as `flushBuffered()` would. It is a
  complete no-op only when nothing is pending.
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
  ZWJ sequence, a base from its variation selector, skin-tone modifier or
  combining mark (NFD accents, Indic matras and viramas, Thai vowel signs,
  the U+20E3 keycap), a regional-indicator flag pair, or a tag sequence. The
  flag parity counts the indicators already committed to the source, not only
  those in the pending buffer, so a pair the last flush split is still seen.
  It is an approximation of UAX #29, not an implementation of it: Hangul jamo
  composition and Indic conjuncts across a virama can still be cut, which
  costs one frame showing a different glyph, never invalid UTF-16. The one
  documented gap in the cross-delta rule is an ASCII base whose combining mark
  arrives in the next delta — decomposed `cafe` + U+0301 commits `cafe` for
  one frame — because holding every trailing ASCII character would cost a code
  point of latency on every delta of every ordinary stream; `holdBackChars: 1`
  is the knob for it. `src/stream/clusters.ts` is the single source of that
  arithmetic, and its tests check it against `Intl.Segmenter`.
