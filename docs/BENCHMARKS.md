# Benchmarks

Two families of measurement: speed (is it fast, does it stay fast) and
accuracy (is the output right, does streaming leave it unchanged). Accuracy
results gate `npm test`, which CI runs on every push and pull request. Most
speed results are tracked as trends; three benches are gates. The pathological
suite runs as `npm run bench:pathological -- --require-engine --budget-parse
750 --budget-repair 750 --budget-segment 200 --budget-project 750` in ci.yml's
test job and again in release.yml, and `npm run bench:projection --
--require-engine` and a budgeted `bench:streaming` over the never-anchoring
transcript run beside it. The budgets are cliff detectors rather than
performance targets — anything that goes quadratic on those inputs lands in
seconds, not in the noise band — and the pathological ones are per stage
because the stages differ by orders of magnitude, so one number loose enough
for the table's parse would let `segment` get a hundred times slower and still
pass. The numbers themselves come from the runs recorded below, not from a CI
runner.

There is one parser, md4c through the native module, and every number here is
that parser. A machine that cannot build the Node addon measures nothing
rather than measuring a stand-in. The cost model, what has been optimized and
the roadmap are in [PERFORMANCE.md](PERFORMANCE.md); this document is the
harnesses and their results.

## Running

The Node benchmarks import compiled output, so build first:

```sh
npm run build              # emits dist/ (tsconfig.build.json)
npm run bench:throughput   # bench/throughput.mjs
npm run bench:pathological # bench/pathological.mjs: report-only by default;
                           # pass a budget to make it a pass/fail gate, which
                           # is how CI runs it:
                           #   npm run bench:pathological -- --require-engine \
                           #     --budget-parse 750 --budget-repair 750 \
                           #     --budget-segment 200 --budget-project 750
npm run bench:streaming    # bench/streaming-replay.mjs: report-only by
                           # default; pass a budget to make it a gate, which
                           # is how CI runs it:
                           #   npm run bench:streaming -- --transcript \
                           #     conformance/fixtures/transcript-giant-list.json \
                           #     --require-engine --repeat 1 \
                           #     --budget-chunk 20 --budget-finalize 50
npm run bench:crossing     # bench/crossing.mjs: native parse vs JS decode
npm run bench:projection   # bench/projection.mjs: projected characters per
                           # document character, cached vs full
npm run bench:all          # the five above, in that order

# Against other parsers. They are deliberately NOT dependencies of this
# package, so point --libs at a directory where you installed them:
#   mkdir /tmp/mdbench && cd /tmp/mdbench && npm init -y
#   npm install markdown-it marked commonmark micromark
npm run bench:headtohead -- --libs /tmp/mdbench   # bench/head-to-head.mjs

npm run conformance        # → conformance/report-native.json
npm test                   # jest: unit suites, the streaming prefix oracle,
                           # the selection projection oracle, and the
                           # incremental-projection oracle
```

Flags: every timing bench takes `--quick` (one warmup, few iterations; good
for checking a bench still runs, useless as a published number).
`bench:throughput` and `bench:crossing` take `--iterations N` and
`--replicas R`. `bench:pathological` takes `--budget MS`, the per-stage
overrides `--budget-parse|-repair|-segment|-project MS` (the global is the
default for any stage without one), `--runs N` and `--require-engine`, which
turns an unresolvable addon from an exit-0 report into a failure.
`bench:streaming` takes `--transcript PATH`, `--repeat N`, `--max-chunks N`
and `--replicas N`; it replays both pinned transcripts by default, and the
transcript flag narrows it to one. It gates as well as reports. `--budget MS`
is the default for both gated numbers: `--budget-chunk MS` bounds the p99
append latency, `--budget-finalize MS` the single clean parse `finalize` does,
both per transcript. `--require-engine` turns an unresolvable addon, or a
`StreamSession` that cannot take one character, from an exit-0 report into a
failure. Without a budget nothing fails, because the absolute milliseconds
belong to the machine. A budgeted run that timed nothing (`--max-chunks 0`,
`--repeat 0`) exits 1 — a gate over nothing is a failure, the same rule
`bench:pathological` states. On the machine in Results below, the giant-list
transcript measures chunk p99 0.75–0.86 ms and finalize 0.59–0.85 ms (two runs,
2026-09-03), so the CI budgets sit ~25× and ~60× above them: cliff detectors,
not targets. `bench:projection` takes
`--transcript PATH`, `--chunk N` (delta size, default 18), `--require-engine`
and `--quick` (one document size instead of two — which measures no growth, so
it gates nothing). `bench:headtohead` takes `--libs DIR`, `--replicas R`,
`--iterations N` and `--only <contender-id>`. The benches and the conformance
runner refuse a stale `--engine` flag with a non-zero exit rather than
printing md4c's numbers under a heading you did not choose.

Node 18 or newer. Results are machine-relative; compare across runs on one
machine only. `conformance/report-native.json` is gitignored. On a machine
with no C++ toolchain the benches print a notice with the build command and
exit 0, and `npm test` skips every suite that parses markdown. CI builds the
addon as a hard gate so a job cannot go green having parsed nothing.

## Results (2026-09-02)

Apple M2 Max (12-core, 64 GB), macOS 26.5, arm64 Node v22.12.0 running
natively (not under Rosetta), this repo at v0.11.0 plus the unreleased audit
pass, addon rebuilt by `scripts/build-node-addon.mjs` from the vendored md4c.
One run of each command. In the August 2026 runs on this machine, medians moved
by up to ~20% between back-to-back runs of the same command, so treat
differences inside that band as noise.

Everything below is from a 2026-09-02 re-run except two things. The
cross-parser comparison in the next section is still the 2026-09-01 run: the
other parsers are deliberately not dependencies of this package, so re-running
it needs `--libs <dir>`. And the streaming-replay rows and the
incremental-vs-full ratio were re-measured on 2026-09-03, on the same machine
and the same arm64 Node, because the bench changed which statistic it reports;
those rows say so.

### Markdown to HTML throughput

Same corpus for every parser: all 652 CommonMark 0.31.2 spec examples plus
this repo's 8 fixtures, concatenated and replicated ×12 (289.3 kB). Markdown
string in, HTML string out, 3 warm-ups + 20 timed renders, one fresh Node
process per library, median reported. Ours parses to the span-carrying AST
and serializes it with `conformance/serialize-html.ts`, the writer the
conformance oracle is checked against. Every row is from the same run.

| Engine | MB/s (median) | MB/s (best) | CommonMark 0.31.2 | Output |
| --- | --: | --: | --: | --- |
| this package (md4c), `commonmark` preset | 15.77 | 16.92 | 651/652 · 99.85% | AST with exact source spans |
| commonmark.js 0.31.2 | 10.04 | 12.16 | 652/652 · 100% | AST (internal) |
| marked 18.0.11, `gfm:false` | 9.38 | 10.35 | 586/652 · 89.9% ‡ | tokens |
| markdown-it 15.0.1, `commonmark` preset | 6.22 | 6.80 | 652/652 · 100% | tokens |
| micromark 4.0.2 | 0.59 | 0.66 | 652/652 · 100% | events |

Each library is shown at its fastest configuration. Sanitizing was disabled
where it is on by default, and our own options were widened the same way
(`html: 'raw'`, open URL policy): this measures parsing, not escaping policy.
The harness runs micromark with `allowDangerousHtml` and
`allowDangerousProtocol`; read its figure with `bench/head-to-head.mjs` in
hand. The CommonMark scores for the other parsers are from the August 2026
run, on marked 18.0.10 and markdown-it 15.0.0.

‡ marked self-reports 98% on its own runner, which uses a curated spec JSON
and its own normalizer. Ours counts renderer-level choices such as entity
re-encoding as failures.

The August 2026 run measured this package at 11.37 MB/s on this corpus. This
machine's default `node` is an x86_64 build running under Rosetta, and an
x86_64 run on 2026-09-01 landed in that lower range (10.5 MB/s on
`bench:throughput`, 4.3 µs per append on `bench:crossing`), so compare like
with like — every figure in this document is from the arm64 build.

Full configuration matrix, same run:

| Engine / configuration | MB/s median | MB/s best |
| --- | --: | --: |
| this package (md4c), `commonmark` preset | 15.77 | 16.92 |
| this package (md4c), `llmChat` extensions (tables, strikethrough, tasklists, autolinks) | 15.17 | 17.51 |
| commonmark.js 0.31.2 | 10.04 | 12.16 |
| marked 18.0.11, `gfm:false` | 9.38 | 10.35 |
| marked 18.0.11, defaults (`gfm:true`) | 8.29 | 9.21 |
| markdown-it 15.0.1, `commonmark` preset | 6.22 | 6.80 |
| markdown-it 15.0.1, defaults (`html:true`) | 6.03 | 6.96 |
| micromark 4.0.2 | 0.59 | 0.66 |

The two presets are within run-to-run noise of each other. Both are listed
because the preset changes which constructs md4c looks for.

### Cost by document shape

The four `bench:pathological` rows are cold medians per pipeline stage — parse,
tail repair, run segmentation, run projection — not parse times.

| Benchmark | md4c, as shipped |
| --- | --- |
| Full-document parse, 96.4 kB corpus, AST only, warm (`bench:throughput`) | 4.35 ms/parse mean (min 3.41, p95 5.46) → 22.2 MB/s mean, 28.3 MB/s best-of-run, 2772 blocks |
| Nested brackets, 20 kB (`bench:pathological`) | parse 0.46 · repair 2.01 · segment 0.02 · project 0.02 ms |
| Alternating emphasis openers, 104 kB | parse 0.53 · repair 7.04 · segment 0.08 · project 0.07 ms |
| 32 × 500 table, 113 kB | parse 10.52 · repair 0.38 · segment 2.89 · project 7.61 ms |
| Deep blockquotes (1500 levels), 3 kB | parse 1.57 · repair 0.09 · segment 0.56 · project 2.53 ms cold; 0.22 ms warm parse (`bench:crossing`) |
| Streaming replay, 131 chunks / 1.2 kB (`bench:streaming`, re-run 2026-09-03) | 2.52–2.80 ms of append time per replay (median of 3, three runs), p50 0.02 ms/chunk, p99 0.06–0.16 ms |
| Streaming replay, 1055 chunks / 9.3 kB (`--replicas 8`, re-run 2026-09-03) | 14.98 ms of append time (34.83 ms replay total), p50 0.01 ms/chunk, p99 0.09 ms |
| Streaming replay, 2484 chunks / 21.9 kB, one 420-item bullet list (re-run 2026-09-03) | p50 0.28 ms/chunk, mean parse input 10,854 chars — never anchors; 731 and 769 ms of append time in two runs (per-replay spread 715–945 ms) |
| Projection over the replayed transcript (`bench:projection`) | 6,045 characters projected for 1,162 of document (5.2×), worst single projection 274 |

Five notes on the table:

- **The many-cell table** is the most expensive shape per byte and the
  noisiest: 10.5 ms to parse 113 kB, about twice what the same volume of prose
  costs, and 7.6 ms to project it. 113 kB of `| cell |` is 16,000 cells, each a
  cell node with a text child. Allocating them costs more than finding them.
- **Deep blockquotes** produce the fattest wire buffer: 3 kB of source, 72 kB
  of buffer (24×), because every nesting level is its own 24-byte enter/leave
  event pair. The decode share is 49%, in line with the other shapes, so
  crossing cost tracks node count rather than bytes. The pathological bench's
  1.57 ms parse for the same input is a cold run with no warmup, on purpose: a
  warmed-up JIT is not what a DoS attempt meets. It is also the one shape whose
  cost is in the projection rather than the parse.
- **The two stages that dominate** — the repair on alternating emphasis
  openers, the projection on the table — were invisible while this bench timed
  only the parse. md4c is linear on all four shapes, so a parse-only gate
  guarded the stage that was never going to fail.
- **The incremental-vs-full ratio** now compares matched statistics: both
  sides are the median, across repeats, of ONE replay's total — the streamed
  side summing its appends, the naive side summing the same number of full
  reparses of the final document — after a matching untimed warmup, and the
  bench prints both totals and their min–max spread. Re-measured 2026-09-03 on
  this machine, `--repeat 3`, three runs: 0.666 / 0.664 / 0.647 on the 1.2 kB
  transcript (streamed 2.78 / 2.80 / 2.52 ms against naive 4.17 / 4.22 /
  3.90 ms over 131 chunks) and 0.098 at ×8 (14.98 ms against 153 ms over 1055
  chunks of 9.3 kB), falling as the document grows. Still quote it as a band:
  those historical runs printed a ratio spread of 0.447–0.913. Other runs can cross 1.0 at 1.2 kB; the recorded range is not a bound on future runs. The larger fixture shows a clearer benefit. The
  structural numbers do not move: parse input per append is mean 105 / p95 254
  / max 277 characters at both sizes, and 11 of 130 appends (88 of 1047 at ×8)
  skipped the engine entirely.
- **The giant-list replay** is the same measurement on a shape that never
  anchors, and it inverts: mean parse input 10,854 characters of a 21,927-char
  document (max 21,881, so 99.8% of the whole thing), 2389 of 2389 appends
  reached the engine, and 790 nodes lost identity per chunk. Those counts are
  exact; the ratio is not, and it is above 1 in every run — 1.227 and 1.466 in
  two runs on 2026-09-03 (streamed 731 and 769 ms against naive 596 and
  525 ms), i.e. slower than reparsing the document from scratch on every
  token. A list offers no safe anchor, so nothing settles and nothing
  downstream can be reused.

### Where a native parse spends its time (`bench:crossing`)

(a) native parse + encode + the ArrayBuffer crossing, (b) JS decode of that
buffer into the AST, (c) the whole `engine.parse` call.

| Workload | (a) native parse + encode | (b) JS decode → AST | (c) total | (b) share | Wire buffer |
| --- | --: | --: | --: | --: | --- |
| Append tail, 64 B (the streaming parse input) | 1.79 µs | 1.31 µs | 3.03 µs | 43% | 387 B (6.05× source), 13 events |
| Chat reply, 828 B | 6.62 µs | 4.08 µs | 10.65 µs | 38% | 1.7 kB (2.06× source), 65 events |
| Spec corpus ×4, 96.4 kB | 1.85 ms | 1.53 ms | 3.41 ms | 45% | 532.7 kB (5.52× source), 21,378 events |
| Deep blockquotes, 1500 levels, 3 kB | 127 µs | 109 µs | 223 µs | 49% | 72.2 kB (24.0× source), 3,005 events |
| Many-cell table, 32 × 500, 113.4 kB | 2.08 ms | 2.10 ms | 4.14 ms | 51% | 1.18 MB (10.4× source), 49,106 events |

The last two rows are the pathological bench's shapes, built by the same
generators in `bench/support.mjs`, timed with pinned iteration counts. The
bench prints its timer floor, 76 ns per timed region on this machine, and
never subtracts it; on the 64 B row that is 4–6% of a stage.

Two takeaways:

- `engine.parse` on a 64 B tail costs ~3.0 µs, ~0.02% of a 16.7 ms frame. That
  is the crossing and nothing else: a whole `StreamSession.append` — anchor
  scan, tail repair, parse, span shift, snapshot — averages 14 µs over the
  1055-chunk ×8 replay and 19–21 µs over the 131-chunk one (the streamed total
  the streaming bench prints, divided by its chunk count, 2026-09-03), and the
  mean parse input there is 105 characters rather than 64 B. The remaining on-device cost
  is React and text layout, not parsing (speed metrics 5 and 6, both planned).
- The decode is 38–51% of a parse by shape, and it is the half written in
  JavaScript. The decoder reads the wire buffer at 297–418 MB/s on prose and
  562–660 MB/s on the node-dense shapes. Lazy per-block AST materialization
  was considered as the next win and rejected (2026-08-25): the span-widening
  pipeline that eager block spans need is ~60% of decode, and renderers read
  every block, so lazy children would re-pay it (about 1.6× total) or need a
  second decoder.

### Gates and benches in this tree

| Command | Result |
| --- | --- |
| `npx jest` / `npx tsc --noEmit` | 57 suites, 1790 tests, all green; typecheck clean. Nothing asserts those two counts, so read them as of 2026-10-09 |
| `npm run conformance` | 651/652 (99.85%) on CommonMark 0.31.2, 0 examples threw. Every section at 100% except HTML blocks (43/44); the single failure is example 174, `> <div>\n> foo\n\nbar`, where md4c ends the quoted HTML block differently from cmark. Per-section table: `conformance/report-native.json` |
| `npx jest src/engine/native` | 7 suites, 244 tests: ABI parity against the C++ headers, host-binding resolution, named-construct documents, span invariants over the whole spec corpus, `underline`, smart punctuation, and the widener regressions the 2026-10 audit pinned (fence closers, link tails, rules inside containers, the source cap) |
| `npm run bench:pathological -- --require-engine --budget-parse 750 --budget-repair 750 --budget-segment 200 --budget-project 750` | all four adversarial cases pass in all four stages, the slowest at 10.5 ms (the table's parse) against its 750 ms budget and `segment` at 2.9 ms against 200 ms; the repair-scaling section reports 0.43× cost-per-bracket growth from n=500 to n=8000, well under its 2.00× limit. This is the step CI runs, and `--require-engine` is what stops it passing having measured nothing |
| `npm run bench:streaming` | on the sprint-review transcript, parse input per append stays flat at mean 105 / p95 254 / max 277 chars regardless of stream length, and 11 of 130 appends (88 of 1047 at `--replicas 8`) skipped the engine entirely; on the giant-list transcript nothing anchors, mean parse input is 10,854 of 21,927 chars and 0 appends skip the engine |
| `npm run bench:streaming -- --transcript conformance/fixtures/transcript-giant-list.json --require-engine --repeat 1 --budget-chunk 20 --budget-finalize 50` | gates: p99 append latency and finalize time on the never-anchoring transcript, the shape where every append re-reads the accumulated text. Measured on 2026-09-03: p99 0.86 ms against the 20 ms budget and finalize 0.59 ms against 50 ms (0.75 and 0.85 ms in a second run). ci.yml's test job and release.yml both run this exact step; `--require-engine` stops it passing having measured nothing, and a budgeted run that timed no chunk exits 1 |
| `npm run bench:projection -- --require-engine` | gates: projected characters per document character stay flat as the document doubles — 0.99× growth cached against 1.98× uncached, 5.2× amplification at either size against 32.6× and 64.6×. Cached growth above 1.25× per doubling exits 1, and ci.yml and release.yml run it. On the giant-list transcript both pipelines measure ~553× (growth 1.00× against 2.09×), because a list never anchors and nothing settles to reuse |

## Offset map and decoder pass (2026-08-25)

Isolated micro-measurements from the 2026-08-25 pass. No `bench:*` script
reproduces them and they have not been re-run since; today's decode share and
decoder throughput are in the crossing table above.

- **Offset map** (`buildUtf16OffsetMap`, `OffsetParser.cpp`). The
  byte-to-UTF-16 map gained an ASCII fast path: an 8-bytes-at-a-time high-bit
  word test plus a vectorizable ramp fill, re-entering the word loop only on
  an ASCII byte (re-testing per multi-byte character measured 2× slower on
  pure CJK). Isolated, the map build on the 96.4 kB ASCII corpus went
  70 → ~27 µs (~2.7×, ~3.5 GB/s). The map was only ~3% of stage (a), so
  stage (a) improved ~3–7% by shape. Truncated and invalid-sequence semantics
  are preserved; the wire format is untouched (`protocolVersion` is still 1).
  simdutf is not worth vendoring for what remains.
- **Decoder.** `skipLinkTail` was 16% of decode, char-compare bound, and went
  to 8% via `charCodeAt`.
- **Hermes.** The `charCodeAt`-family wins should be larger on Hermes, which
  has no JIT, than in these V8 numbers. There is still no on-device
  measurement.

## Metrics

### Speed

| # | Metric | Status | Where | What it reports |
| --- | --- | --- | --- | --- |
| 1 | Full-document parse throughput (warm) | implemented | `bench/throughput.mjs` | MB/s mean and best-of-run over the spec corpus plus fixtures, replicated by `--replicas`, timed through `parseDocument` after 3 untimed warmups — warm, not cold; "cold" in this document means the no-warmup `bench:pathological`, and the deep-blockquote row shows the two differing ~7×. Block count printed as a sanity check (2772 for ×4). Planned: per-corpus breakdown. |
| 2 | Pathological-input budget | implemented; gates with `--budget`, and CI runs it | `bench/pathological.mjs` | Median cold time per adversarial case, per pipeline stage: parse (md4c + decode), repair (`repairTail` over the whole input, which is what a stream that never anchors hands it), segment (`segmentRuns`), project (`projectRun` over every run). Cases: 10k nested brackets, alternating emphasis openers, 1500 nested blockquotes, a 32 × 500 table. md4c is linear on all four, so a parse-only gate guarded the one stage that was never going to fail. `--budget MS` applies per stage, and `--budget-parse`, `--budget-repair`, `--budget-segment` and `--budget-project` override it for one stage (the global stays the default for the others) — which is how CI runs it, because a single budget loose enough for the table's parse leaves `segment`, four orders of magnitude cheaper, free to get a hundred times slower and still pass. Exceeding a budget, or throwing in any stage, exits 1 — a stack overflow on adversarial input is a denial of service whatever its runtime — and so does a gated run that produced no samples at all (`--runs 0`, or `--require-engine` meeting an unresolvable addon), because a gate over nothing is a failure, not a pass. No warmup, so numbers run higher than the same input warm. A second section, `repair scaling`, runs `repairTail` over `'x [ '.repeat(n)` for n in {500,1000,2000,4000,8000} against a same-length linear control and gates the growth in cost-per-bracket (flat ~1.00× is linear, ~16× would be quadratic, over 2.00× fails) — the four fixed-size cases cannot tell a slow linear pass from a fast quadratic one. 1500 is a budget case, not a limit: the JS pipeline is depth-safe at any depth (pinned at 20,000 levels across `src/stream/`, `src/selection/` and `src/view/`), and the only bound is `MAX_RENDER_DEPTH = 64` in `src/view/renderers.tsx`. |
| 3 | Streaming replay | implemented; gates with `--budget`, and CI runs it | `bench/streaming-replay.mjs` | ms/chunk at p50/p95/p99 and nodes (blocks and inlines) whose identity changed per chunk — the label the bench prints, and the count that predicts React re-render cost. On `transcript-sprint-review.json`: p50 7, p95 21, max 31, mean 8.3, identical at ×1 and ×8; churn is in the unsettled tail. On `transcript-giant-list.json`: mean 790. Both are replayed by default, in hand-built deltas of 1–18 UTF-16 units with surrogate-safe splits; `--transcript PATH` narrows to one, or replays any transcript of the same shape. What the budgets gate, per transcript, is the p99 append latency (`--budget-chunk`) and the single clean parse `finalize` does (`--budget-finalize`), with `--budget` as the default for both; ci.yml and release.yml run it over `transcript-giant-list.json`, the never-anchoring shape where every append re-reads the accumulated text (2484 chunks, 2389 of 2389 appends reaching the engine, mean parse input 10,854 chars). That is where a repair or splice pass that stops being linear shows up first, and it shows up in the number a user feels as jank. Without a budget nothing fails; a budgeted run that timed nothing exits 1. |
| 4 | Incremental-vs-full reparse ratio | implemented | reported by `bench/streaming-replay.mjs` | The median of one replay's streamed total against the median of one replay's naive total — the same number of full reparses of the final document, same engine, after a matching untimed warmup — plus both totals, their min–max spread, parse-input size per append and the count of construct-free fast-path appends. Lower is better; falls as documents grow. Both sides are now the same statistic (it used to divide a sum of chunk times by a median full parse × the chunk count), but the two distributions still overlap at 1.2 kB, so quote it as a band rather than a number and read the spread line with it. Do not quote `--quick`. A stream that never anchors reparses its whole tail every chunk: one huge list, one giant paragraph, an unclosed fence, or an unterminated HTML block of CommonMark type 1–5 (`<!--`, `<script>`, `<?`, `<!X`, `<![CDATA[`), which run past blank lines to their own end condition. `transcript-giant-list.json` pins that case at mean 10,854 / p95 20,796 / max 21,881 parse input of 21,927 final chars (max/full 0.998), 2389 of 2389 appends reaching the engine, and a ratio above 1 in every run (1.227 and 1.466 in two runs on 2026-09-03) — slower than a naive full reparse. Two shapes have left this list: a code fence opened on a list-marker line, and a stray `$$` in prose under `extensions.math`. Both used to stall the anchor at 0 for the rest of the stream. What the repair no longer redoes is the inline scan, which is carried across appends (PERFORMANCE.md §1); the parse still re-reads the whole tail. |
| 4b | JS-to-native crossing cost | implemented | `bench/crossing.mjs` | Stages (a)/(b)/(c) as above, round-robined per iteration so drift lands on all three equally, plus wire-buffer ratio, bytes per event, decoder throughput and the a+b vs c residual. Says whether further work belongs in C++ or the decoder. |
| 4c | Projection amplification | implemented; gates, and CI runs it | `bench/projection.mjs` | Source characters handed to `projectRun` over a whole streamed message, divided by the document's length, at two document sizes and on both pipelines (`cached` is what ships, `full` is what it replaced). What it watches is that cached growth stays near 1.00× per doubling — projection work must track the deltas, not the document they accumulate into. Cached growth above 1.25× across the doubling exits 1, and ci.yml's test job and release.yml both run `npm run bench:projection -- --require-engine`; `--quick` measures one size, so it gates nothing. The second, finer-grained gate is `conformance/selection/incremental-projection.test.ts` (amplification flat across a doubling, worst single projection under a quarter of the document). No other bench replays the view. |
| 5 | On-device React Native metrics | planned (needs the example app) | | JS-thread frame time, dropped frames, time-to-first-block, memory peak over a long transcript, on physical devices. |
| 6 | React commit costs | planned | | `<Profiler>` around the message list during replay: commits per chunk, mean/max duration, wasted renders of settled runs. Zero for every settled run the settle did not touch; the one run that absorbs a newly settled block re-renders once. What that re-render must keep proportional to the APPEND is the projection — `npm run bench:projection` gates exactly that — while the rest of it (mark and extent re-sort, then a full re-resolve of attributes, decorations, pressables and embeds) is still O(run), bounded by the run's length rather than eliminated. |

### Accuracy

| # | Metric | Status | Where | What it reports |
| --- | --- | --- | --- | --- |
| 1 | CommonMark 0.31.2 spec suite | implemented; reports, does not gate | `conformance/run-commonmark.mjs` | Pass rate by section, via AST → HTML (`conformance/serialize-html.ts`) with a whitespace-tolerant normalizer. Current: 651/652 (99.85%), 0 threw, every section 100% except HTML blocks 43/44. Written to `conformance/report-native.json`. Ungated so the score stays a published number rather than a managed one. |
| 2 | GFM extension suites | planned | | The GFM spec's table/strikethrough/tasklist/autolink examples with matching `ExtensionFlags`, same oracle. |
| 3 | Every-character-prefix streaming oracle | implemented; gates | `conformance/streaming/prefix-oracle.test.ts` | Streams each corpus document one character at a time and, for the bundled transcript, by its natural deltas too. Asserts: the finalized AST deep-equals a fresh parse; settled blocks keep identity in every later snapshot; every intermediate snapshot deep-equals a fresh parse of its own repaired source; and spoilers hold in both directions — no spoiler node appears in any snapshot while the extension is off, and with `extensions.spoilers: true` a spoiler streamed one code point at a time never puts a text node overlapping the hidden body outside a spoiler node. This caught a padding cell with no offsets that `shiftSpans` rebased into a real-looking offset: 120 divergent snapshots, invisible to the HTML sweep. |
| 4 | Decoder assertions over the corpus | implemented; gates (skips without a toolchain) | `src/engine/native/__tests__/` | 7 suites, 244 tests, zero tolerated violations. `documents.test.ts`: 49 cases pinning named constructs to node kinds and offsets — line endings, UTF-16 offsets over astral text, reference links, lazy container continuation, `html: 'strip'` line breaks, tabs in HTML blocks, permissive autolinks, decode-exactly-once for hrefs and info strings, task items, and one document with every extension on at once. `spans.test.ts`: four span invariants over all 652 examples in both HTML policies and every fixture in LF, CRLF and bare CR (in bounds, child inside parent, no sibling overlap, non-empty slice unless legitimately empty), with each fixed defect pinned as a regression case. `protocol.test.ts`: `Protocol.h` read as text and every constant checked against `protocol.ts`. `underline.test.ts` and `smart-punctuation.test.ts` for flag behaviour; `widen-regressions.test.ts` for the 2026-10 widener fixes. Planned: mutated-input generation. |
| 5 | Selection/copy round-trip | implemented; gates | jest, plus `conformance/selection/projection-oracle.test.ts` | Exhaustive start/end sweep over a text fixture, fixed cases across block kinds, and the projection oracle over all 652 examples plus every fixture, under `llmChat` and the maximal preset. What the oracle holds is a set of properties plus one census, and the reparse property copy once claimed is not among them — it is false for a PARTIAL selection (a block's own syntax projects no text, so `first\n2. second` is what a selection starting inside item 1 copies) and vacuous for the rest. The properties: pieces tile the projected text with no gap or overlap; every mapped selection is an in-bounds, ordered source span; `buildCopyPayload(...).markdown` is exactly `doc.source.slice(span)` and never throws (>100,000 selections); every LINEAR piece displays character-for-character the source it is pinned to, allowing only the six one-for-one substitutions in `PROJECTED_SUBSTITUTIONS` (soft break `\n` and `\r` → space, both smart-quote pairs, NUL → U+FFFD, an indented block's leftover `\t` → space) and holding indivisibly-pinned source under a 700-character ceiling; and a selection covering a whole heading, quote, list, fence or table maps to a span CONTAINING that block's own source span. Two more hold the same tiling and exact-slice properties over embed-bearing runs, one placeholder piece per embed. The census then measures what is still lost: 696 of 761 whole-block copies come back as themselves under `llmChat` (floor: >680), the rest being slices that mean something else alone, reference links, indented fences and trailing whitespace. Planned: randomized documents. |
| 6 | Security vectors | partially implemented | `src/engine/urlPolicy.test.ts` | 26 cases, several end-to-end through `parseDocument`, asserting the returned document contains no rejected href: `javascript:` with embedded NUL/control characters, payloads via link reference definitions, image-allowlist bypasses (case tricks, scheme-relative URLs, prefix confusables), and path traversal out of a path-scoped prefix (`myapp://checkout/../settings/wipe` with its `%2e%2e`, `..%2f`, backslash and mixed-case variants). A dedicated adversarial fixture corpus is planned. |
| 7 | Tail-repair corpus | implemented; gates | jest, `src/stream/` | 251 table cases (322 tests with loop/purity checks; the suite's own floor asserts at least 225 cases) against `repairTail` / `continueSeed` / `trimTrailingPlaceholders`: emphasis tails, structure flips, fences, math/currency, partial links, images and HTML tags, Unicode boundaries, protocol quirks. Each asserts the repaired parse, `touched` spans and purity. Pins two intended non-repairs: single-dollar math stays literal, `[text][r` reference tails stay literal (see [STREAMING.md](STREAMING.md)). |

## How to read these numbers

- Node is V8; React Native is Hermes. md4c is arm64 machine code and does not
  care which JS engine hosts it. The decoder is TypeScript, 38–51% of every
  parse here, and Hermes has no JIT, so that half is what gets slower on
  device. That is reasoning, not a measurement: no number in this document is
  an on-device number, and there is no JavaScript parser to fall back to.
- Perceived smoothness on device is dominated by metrics 3–6 (identity churn
  and commit cost), plus `bench:crossing`'s ~3 µs per 64 B parse against a
  16.7 ms frame — a whole append is 14–21 µs of that frame, still under 0.2%.
- Ranges beat single figures on a laptop. In the August 2026 runs, medians
  moved by up to ~20% between runs, and one run reordered our own two presets. Anything inside that band
  is a tie. The numbers that survive it: the decode's share of every parse,
  parse input per append flat at 277 characters on a transcript that anchors,
  the many-cell table costing several times the same volume of prose, and the
  counts `bench:projection` reports, which are exact rather than timed.
- The gates are the pathological budgets (speed 2, per stage, which CI runs),
  `bench:streaming`'s chunk and finalize budgets on the never-anchoring
  transcript (speed 3, also CI), `bench:projection`'s own growth gate
  (speed 4c, also CI) alongside the projection-amplification assertions in
  `conformance/selection/incremental-projection.test.ts`, the prefix oracle
  (accuracy 3), the decoder invariants (accuracy 4), copy round-trip and the
  projection oracle (accuracy 5), and the repair corpus (accuracy 7).
  Everything else is a tracked trend. Every self-measurement
  reproduces from the committed harness with one command (`npm test`,
  `npm run conformance`, `npm run bench:*`); the comparison against other
  parsers needs `--libs <dir>` because they are not dependencies.
