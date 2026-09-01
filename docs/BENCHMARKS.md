# Benchmarks

Two families of measurement: speed (is it fast, does it stay fast) and
accuracy (is the output right, does streaming leave it unchanged). Accuracy
results gate `npm test`, which CI runs on every push and pull request. Speed
results are tracked as trends; the pathological suite becomes a gate when run
with a budget.

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
                           # pass a budget to make it a pass/fail gate:
                           #   npm run bench:pathological -- --budget 2000
npm run bench:streaming    # bench/streaming-replay.mjs
npm run bench:crossing     # bench/crossing.mjs: native parse vs JS decode
npm run bench:all          # the four above, in that order

# Against other parsers. They are deliberately NOT dependencies of this
# package, so point --libs at a directory where you installed them:
#   mkdir /tmp/mdbench && cd /tmp/mdbench && npm init -y
#   npm install markdown-it marked commonmark micromark
npm run bench:headtohead -- --libs /tmp/mdbench   # bench/head-to-head.mjs

npm run conformance        # → conformance/report-native.json
npm test                   # jest: unit suites, the streaming prefix oracle,
                           # and the selection projection oracle
```

Flags: every timing bench takes `--quick` (one warmup, few iterations; good
for checking a bench still runs, useless as a published number).
`bench:throughput` and `bench:crossing` take `--iterations N` and
`--replicas R`. `bench:pathological` takes `--budget MS` and `--runs N`.
`bench:streaming` takes `--transcript PATH`, `--repeat N`, `--max-chunks N`
and `--replicas N`. `bench:headtohead` takes `--libs DIR`, `--replicas R`,
`--iterations N` and `--only <contender-id>`. The benches and the conformance
runner refuse a stale `--engine` flag with a non-zero exit rather than
printing md4c's numbers under a heading you did not choose.

Node 18 or newer. Results are machine-relative; compare across runs on one
machine only. `conformance/report-native.json` is gitignored. On a machine
with no C++ toolchain the benches print a notice with the build command and
exit 0, and `npm test` skips every suite that parses markdown. CI builds the
addon as a hard gate so a job cannot go green having parsed nothing.

## Results (2026-09-01)

Apple M2 Max (12-core, 64 GB), macOS 26.5, arm64 Node v22.12.0 running
natively (not under Rosetta), this repo at v0.10.0, addon built by
`scripts/build-node-addon.mjs` from the vendored md4c. One run of each command.
In the August 2026 runs on this machine, medians moved by up to ~20% between
back-to-back runs of the same command, so treat differences inside that band
as noise.

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
x86_64 run today lands in that lower range (10.5 MB/s on `bench:throughput`,
4.3 µs per append on `bench:crossing`), so compare like with like.

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

| Benchmark | md4c, as shipped |
| --- | --- |
| Cold parse, 96.4 kB corpus, AST only (`bench:throughput`) | 4.58 ms/parse mean (min 3.56, p95 6.35) → 21.1 MB/s mean, 27.1 MB/s best-of-run, 2772 blocks |
| Nested brackets, 20 kB (`bench:pathological`) | 0.47 ms |
| Alternating emphasis openers, 104 kB | 0.40 ms |
| 32 × 500 table, 113 kB | 10.3 ms (min 7.4, max 14.3 over 3 runs) |
| Deep blockquotes (1500 levels), 3 kB | 1.85 ms cold; 0.25 ms warm (`bench:crossing`) |
| Streaming replay, 131 chunks / 1.2 kB (`bench:streaming`) | 3.1 ms of append time (3.3 ms replay total), p50 0.02 ms/chunk, p99 0.18 ms |
| Streaming replay, 1055 chunks / 9.3 kB (`--replicas 8`) | 13.1 ms of append time (30.7 ms replay total), p50 0.01 ms/chunk, p99 0.05 ms |

Three rows need a note:

- **The many-cell table** is the most expensive shape per byte and the
  noisiest: 10.3 ms for 113 kB, about twice what the same volume of prose
  costs, with a 7.4 to 14.3 ms spread across three runs. 113 kB of `| cell |`
  is 16,000 cells, each a cell node with a text child. Allocating them costs
  more than finding them.
- **Deep blockquotes** produce the fattest wire buffer: 3 kB of source, 72 kB
  of buffer (24×), because every nesting level is its own 24-byte enter/leave
  event pair. The decode share is 44%, in line with the other shapes, so
  crossing cost tracks node count rather than bytes. The pathological bench's
  1.85 ms for the same input is a cold run with no warmup, on purpose: a
  warmed-up JIT is not what a DoS attempt meets.
- **The incremental-vs-full ratio** is 0.435 on the 1.2 kB transcript
  (3.08 ms streamed vs 131 full reparses at 0.05 ms each) and 0.065 at ×8
  (13.05 ms vs 1055 × 0.19 ms), falling as the document grows. The structural
  number does not move: parse input per append is mean 107 / p95 254 / max
  277 characters at both sizes, and 11 of 130 appends (88 of 1047 at ×8)
  skipped the engine entirely.

### Where a native parse spends its time (`bench:crossing`)

(a) native parse + encode + the ArrayBuffer crossing, (b) JS decode of that
buffer into the AST, (c) the whole `engine.parse` call.

| Workload | (a) native parse + encode | (b) JS decode → AST | (c) total | (b) share | Wire buffer |
| --- | --: | --: | --: | --: | --- |
| Append tail, 64 B (the streaming case) | 1.59 µs | 1.15 µs | 2.68 µs | 43% | 387 B (6.05× source), 13 events |
| Chat reply, 828 B | 7.05 µs | 5.19 µs | 11.92 µs | 43% | 1.7 kB (2.07× source), 65 events |
| Spec corpus ×4, 96.4 kB | 2.01 ms | 1.69 ms | 3.69 ms | 46% | 547.7 kB (5.68× source), 21,370 events |
| Deep blockquotes, 1500 levels, 3 kB | 141 µs | 111 µs | 251 µs | 44% | 72.2 kB (24.0× source), 3,005 events |
| Many-cell table, 32 × 500, 113.4 kB | 2.12 ms | 2.29 ms | 4.35 ms | 53% | 1.18 MB (10.4× source), 49,106 events |

The last two rows are the pathological bench's shapes, built by the same
generators in `bench/support.mjs`, timed with pinned iteration counts. The
bench prints its timer floor, 66 ns per timed region on this machine, and
never subtracts it; on the 64 B row that is ~4% of a stage.

Two takeaways:

- A streaming append costs ~2.7 µs end to end, ~0.02% of a 16.7 ms frame. The
  remaining on-device cost is React and text layout, not parsing (speed
  metrics 5 and 6, both planned).
- The decode is 43–53% of a parse by shape, and it is the half written in
  JavaScript. The decoder reads the wire buffer at 324–337 MB/s on prose and
  514–649 MB/s on the node-dense shapes. Lazy per-block AST materialization
  was considered as the next win and rejected (2026-08-25): the span-widening
  pipeline that eager block spans need is ~60% of decode, and renderers read
  every block, so lazy children would re-pay it (about 1.6× total) or need a
  second decoder.

### Gates and benches in this tree

| Command | Result |
| --- | --- |
| `npx jest` / `npx tsc --noEmit` | 31 suites, 792 tests, all green; typecheck clean |
| `npm run conformance` | 651/652 (99.85%) on CommonMark 0.31.2, 0 examples threw. Every section at 100% except HTML blocks (43/44); the single failure is example 174, `> <div>\n> foo\n\nbar`, where md4c ends the quoted HTML block differently from cmark. Per-section table: `conformance/report-native.json` |
| `npx jest src/engine/native` | 6 suites, 164 tests: ABI parity against the C++ headers, host-binding resolution, named-construct documents, span invariants over the whole spec corpus, `underline`, smart punctuation |
| `npm run bench:pathological -- --budget 2000` | all four adversarial cases pass, the slowest at ~10 ms against a 2000 ms budget |
| `npm run bench:streaming` | parse input per append stays flat at mean 107 / p95 254 / max 277 chars regardless of stream length; 11 of 130 appends (88 of 1047 at `--replicas 8`) skipped the engine entirely |

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
| 1 | Cold-parse throughput | implemented | `bench/throughput.mjs` | MB/s mean and best-of-run over the spec corpus plus fixtures, replicated by `--replicas`, timed through `parseDocument`. Block count printed as a sanity check (2772 for ×4). Planned: per-corpus breakdown. |
| 2 | Pathological-input budget | implemented; gates with `--budget` | `bench/pathological.mjs` | Median cold time per adversarial case: 10k nested brackets, nested emphasis runs, 1500 nested blockquotes, a 32 × 500 table. With `--budget MS`, exceeding it or crashing exits 1. No warmup, so numbers run higher than the same input warm. |
| 3 | Streaming replay | implemented | `bench/streaming-replay.mjs` | ms/chunk at p50/p95/p99 and blocks whose identity changed per chunk (p50 7, p95 21, max 31, mean 8.5, identical at ×1 and ×8; churn is in the unsettled tail). Fixture: `conformance/fixtures/transcript-sprint-review.json`, hand-built deltas of 1–18 UTF-16 units with surrogate-safe splits. `--transcript PATH` replays any transcript of the same shape. |
| 4 | Incremental-vs-full reparse ratio | implemented | reported by `bench/streaming-replay.mjs` | Total streamed append time over `chunks × full reparse of the final document`, same engine both sides, plus parse-input size per append and the count of construct-free fast-path appends. Lower is better; falls as documents grow. Do not quote `--quick`. A stream that never anchors (one huge list, one giant paragraph, an unclosed fence) reparses its whole tail every chunk. |
| 4b | JS-to-native crossing cost | implemented | `bench/crossing.mjs` | Stages (a)/(b)/(c) as above, round-robined per iteration so drift lands on all three equally, plus wire-buffer ratio, bytes per event, decoder throughput and the a+b vs c residual. Says whether further work belongs in C++ or the decoder. |
| 5 | On-device React Native metrics | planned (needs the example app) | | JS-thread frame time, dropped frames, time-to-first-block, memory peak over a long transcript, on physical devices. |
| 6 | React commit costs | planned | | `<Profiler>` around the message list during replay: commits per chunk, mean/max duration, wasted renders of settled runs (should be zero). |

### Accuracy

| # | Metric | Status | Where | What it reports |
| --- | --- | --- | --- | --- |
| 1 | CommonMark 0.31.2 spec suite | implemented; reports, does not gate | `conformance/run-commonmark.mjs` | Pass rate by section, via AST → HTML (`conformance/serialize-html.ts`) with a whitespace-tolerant normalizer. Current: 651/652 (99.85%), 0 threw, every section 100% except HTML blocks 43/44. Written to `conformance/report-native.json`. Ungated so the score stays a published number rather than a managed one. |
| 2 | GFM extension suites | planned | | The GFM spec's table/strikethrough/tasklist/autolink examples with matching `ExtensionFlags`, same oracle. |
| 3 | Every-character-prefix streaming oracle | implemented; gates | `conformance/streaming/prefix-oracle.test.ts` | Streams each corpus document one character at a time and, for the bundled transcript, by its natural deltas too. Asserts: the finalized AST deep-equals a fresh parse; settled blocks keep identity in every later snapshot; every intermediate snapshot deep-equals a fresh parse of its own repaired source; no spoiler placeholder leaks. This caught a padding cell with no offsets that `shiftSpans` rebased into a real-looking offset: 120 divergent snapshots, invisible to the HTML sweep. |
| 4 | Decoder assertions over the corpus | implemented; gates (skips without a toolchain) | `src/engine/native/__tests__/` | 6 suites, 164 tests, zero tolerated violations. `documents.test.ts`: 26 named constructs pinned to node kinds and offsets. `spans.test.ts`: four span invariants over all 652 examples in both HTML policies and every fixture in LF, CRLF and bare CR (in bounds, child inside parent, no sibling overlap, non-empty slice unless legitimately empty), with each fixed defect pinned as a regression case. `protocol.test.ts`: `Protocol.h` read as text and every constant checked against `protocol.ts`. `underline.test.ts` and `smart-punctuation.test.ts` for flag behaviour. Planned: mutated-input generation. |
| 5 | Selection/copy round-trip | implemented; gates | jest, plus `conformance/selection/projection-oracle.test.ts` | Property: for any selection inside real pieces of any projected run, `buildCopyPayload(...).markdown` re-parses to the same visible text. Exhaustive start/end sweep over a text fixture, fixed cases across block kinds, and the projection oracle over all 652 examples plus every fixture under `llmChat` and the maximal preset. Planned: randomized documents. |
| 6 | Security vectors | partially implemented | `src/engine/urlPolicy.test.ts` | 18 cases, several end-to-end through `parseDocument`, asserting the returned document contains no rejected href: `javascript:` with embedded NUL/control characters, payloads via link reference definitions, image-allowlist bypasses (case tricks, scheme-relative URLs, prefix confusables). A dedicated adversarial fixture corpus is planned. |
| 7 | Tail-repair corpus | implemented; gates | jest, `src/stream/` | 147 table cases (169 tests with loop/purity checks) against `repairTail` / `trimTrailingPlaceholders`: emphasis tails, structure flips, fences, math/currency, partial links, images and HTML tags, Unicode boundaries, protocol quirks. Each asserts the repaired parse, `touched` spans and purity. Pins two intended non-repairs: single-dollar math stays literal, `[text][r` reference tails stay literal (see [STREAMING.md](STREAMING.md)). |

## How to read these numbers

- Node is V8; React Native is Hermes. md4c is arm64 machine code and does not
  care which JS engine hosts it. The decoder is TypeScript, 43–53% of every
  parse here, and Hermes has no JIT, so that half is what gets slower on
  device. That is reasoning, not a measurement: no number in this document is
  an on-device number, and there is no JavaScript parser to fall back to.
- Perceived smoothness on device is dominated by metrics 3–6 (identity churn
  and commit cost), plus `bench:crossing`'s ~2.7 µs per append against a
  16.7 ms frame.
- Ranges beat single figures on a laptop. In the August 2026 runs, medians
  moved by up to ~20% between runs, and one run reordered our own two presets. Anything inside that band
  is a tie. The numbers that survive it: the decode's share of every parse,
  parse input per append flat at 277 characters, the many-cell table costing
  several times the same volume of prose.
- The gates are the pathological budgets (speed 2 with `--budget`), the
  prefix oracle (accuracy 3), the decoder invariants (accuracy 4), copy
  round-trip and the projection oracle (accuracy 5), and the repair corpus
  (accuracy 7). Everything else is a tracked trend. Every self-measurement
  reproduces from the committed harness with one command (`npm test`,
  `npm run conformance`, `npm run bench:*`); the comparison against other
  parsers needs `--libs <dir>` because they are not dependencies.
