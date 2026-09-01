// Shared plumbing for the bench scripts: dist/ loading (building it first
// when missing), resolving the engine, CLI flag parsing, corpus construction,
// and simple sample statistics.
//
// THERE IS ONE ENGINE. These benches used to take
// `--engine reference|native|both` and print a reference÷native ratio, back
// when the package shipped a pure-TypeScript parser alongside md4c. It does
// not any more: md4c is the only parser, so there is nothing to select and
// nothing to divide. Every bench measures the engine the app actually runs,
// reached from Node through native/node/index.mjs.
//
// The flag is REFUSED rather than quietly ignored — see refuseEngineFlag.
// Without a ratio to protect there is also nothing left to interleave, so
// `measure` simply times one subject; a drifting CPU clock is then handled by
// printing the best sample next to the mean rather than by cancelling it out.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '..');
export const fixtureDir = path.join(repoRoot, 'conformance', 'fixtures');
export const specJsonPath = path.join(repoRoot, 'conformance', 'vendor', 'spec.json');

const distDir = path.join(repoRoot, 'dist');
const require = createRequire(import.meta.url);

/** The only supported way into the native engine from Node — see loadNativeEngine. */
const nativeHarnessPath = path.join(repoRoot, 'native', 'node', 'index.mjs');

/** Builds dist/ when missing so a fresh clone can `npm run bench:*` directly. */
function ensureDist() {
  const probe = path.join(distDir, 'engine', 'Engine.js');
  if (!existsSync(probe)) {
    console.log('[bench] dist/ missing — running `npm run build` first…');
    const res = spawnSync('npm', ['run', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (res.status !== 0 || !existsSync(probe)) {
      throw new Error('`npm run build` did not produce dist/engine/Engine.js');
    }
  }
  return distDir;
}

/**
 * Loads the built library from dist/, building it first when missing.
 *
 * The dist barrel (dist/index.js) re-exports the React Native view layer and
 * react-native is not loadable in plain Node, so the Node-safe subtrees are
 * required directly and composed into one namespace.
 */
export function loadLibrary() {
  const dist = ensureDist();
  return {
    ...require(path.join(dist, 'engine', 'Engine.js')),
    ...require(path.join(dist, 'engine', 'options.js')),
    // The native *decoder* is dependency-free TypeScript; only the parse
    // function it wraps is platform-specific. Requiring it unconditionally
    // therefore cannot fail on a machine with no C++ toolchain — that
    // failure is deferred to loadNativeEngine(), which reports instead.
    ...require(path.join(dist, 'engine', 'native', 'index.js')),
    ...require(path.join(dist, 'stream', 'StreamSession.js')),
    ...require(path.join(dist, 'document', 'visit.js')),
  };
}

/** Wire-format constants (extensionBits/htmlPolicyBit) for benches that call parse() raw. */
export function loadNativeProtocol() {
  return require(path.join(ensureDist(), 'engine', 'native', 'protocol.js'));
}

/**
 * Resolves the md4c engine for Node.
 *
 * `native/node/index.mjs` is the whole contract: importing it makes sure
 * build/selectable-markdown.node exists (building it on first use) and throws
 * a message naming the missing toolchain when it cannot. A bench must degrade
 * to REPORTING that, never crash on it, so every failure comes back as
 * `{ engine: null, reason }` for the caller to print. `resolveEngine` is that
 * caller for the benches that time a whole parse; head-to-head.mjs calls this
 * directly, because an unbuildable addon there is one contender reported as
 * skipped in the leaderboard, not the end of the run. The reason is kept
 * multi-line and verbatim: those lines say which command to run, and
 * truncating them to a one-liner throws that away.
 *
 * The protocol version is checked here rather than at first parse, because a
 * stale addon decodes into a *plausible* document rather than an error, and
 * benching a silently-wrong decode is worse than benching nothing.
 */
export async function loadNativeEngine(lib) {
  try {
    // pathToFileURL, not the bare path: import() specifiers are URLs, and a
    // Windows absolute path is not one.
    const harness = await import(pathToFileURL(nativeHarnessPath).href);
    if (typeof harness.parse !== 'function') {
      return { engine: null, parse: null, addonPath: null, reason: `${nativeHarnessPath} does not export parse()` };
    }
    if (harness.protocolVersion !== lib.PROTOCOL_VERSION) {
      return {
        engine: null,
        parse: null,
        addonPath: harness.addonPath ?? null,
        reason:
          `protocol mismatch: the addon speaks v${harness.protocolVersion}, the decoder ` +
          `expects v${lib.PROTOCOL_VERSION}.\nRebuild it: node scripts/build-node-addon.mjs --force`,
      };
    }
    return {
      engine: lib.createNativeEngine(harness.parse),
      parse: harness.parse,
      addonPath: harness.addonPath ?? null,
      reason: null,
    };
  } catch (err) {
    return { engine: null, parse: null, addonPath: null, reason: String((err && err.message) || err) };
  }
}

/**
 * Rejects a leftover `--engine` on the command line.
 *
 * The flag used to choose between the pure-TypeScript parser and md4c. That
 * parser is gone, so no value of the flag means anything any more — and every
 * one of them (`reference`, `native`, `both`) is still sitting in shell
 * histories, in older revisions of docs/BENCHMARKS.md, and in whatever CI
 * config was copied from them. Silently ignoring it would let
 * `--engine reference` print md4c's numbers under a label a reader would take
 * at face value, which is worse than any error message. Refusing costs one
 * line and cannot be misread.
 *
 * Printed and exited rather than thrown, matching `refuseEngineArg` in
 * conformance/run-commonmark.mjs. A throw from a bench's top-level module body
 * reaches the console as an uncaught error: the one sentence that says what to
 * do sits under a stack of `at refuseEngineFlag (…)` / `at ModuleJob.run (…)`
 * frames and a `Node.js v…` footer, which reads as the harness having crashed,
 * so the reader goes hunting for a bug in the benchmark instead of deleting a
 * stale flag. The exit code is 1 either way — that is what docs/BENCHMARKS.md
 * documents and what a CI step would key on — but only one of the two forms
 * says so in a line a human reads first.
 */
export function refuseEngineFlag() {
  const given = process.argv.find((a) => a === '--engine' || a.startsWith('--engine='));
  if (given === undefined) return;
  console.error(
    `[bench] ${given} was passed, but --engine no longer exists: this package parses ` +
      'with md4c and ships no second parser, so there is nothing to select. Drop the flag.',
  );
  process.exit(1);
}

/**
 * The engine every bench measures: md4c, reached through the Node addon.
 *
 * Returns `{ name, engine, parse, addonPath }`, or null after printing why
 * not. Null is the ordinary outcome on a machine with no C++ toolchain, and
 * benches must exit 0 on it: "this runner cannot build the addon" is not a
 * regression, and a red CI job for it teaches people to ignore the job. The
 * reason is printed verbatim and indented rather than summarised — those
 * lines name the command to run.
 *
 * The trivial parse at the end is not ceremony. `loadNativeEngine` proves the
 * addon loads and speaks the right protocol version; this proves the decoder
 * on top of it produces a document at all, so a bench never reports a
 * measurement of a parse that was throwing on every iteration.
 * `label` prefixes the messages, e.g. `[bench:throughput]`.
 */
export async function resolveEngine(lib, label) {
  refuseEngineFlag();
  const native = await loadNativeEngine(lib);
  if (!native.engine) {
    console.log(
      `${label} native engine unavailable — nothing to measure:\n  ${native.reason.replace(/\n/g, '\n  ')}`,
    );
    return null;
  }
  try {
    lib.parseDocument('*probe* works', undefined, native.engine);
  } catch (err) {
    console.log(
      `${label} the native engine did not parse a trivial document (${
        (err && err.message) || err
      }) — nothing to measure.`,
    );
    return null;
  }
  return { name: 'native', engine: native.engine, parse: native.parse, addonPath: native.addonPath };
}

/**
 * Times `run()` `iterations` times after `warmup` untimed calls.
 *
 * Warmup exists so the measurement is of steady-state code rather than of V8
 * compiling it on the first pass. What it cannot do anything about is a
 * laptop's clock drifting under sustained load — the CPU boosts for the first
 * seconds and then throttles. When there were two engines that drift was
 * cancelled by interleaving them, so the printed ratio survived even when the
 * absolute numbers did not. With one engine there is no ratio left to
 * protect, so drift lands directly in the mean; that is why throughput.mjs
 * prints the best sample beside the mean, the one clock reading least
 * contaminated by whatever else the machine was doing.
 *
 * Returns `{ samples, last }`: the millisecond array and `run`'s last return
 * value, so a bench can report a detail (block counts, node counts) without a
 * second untimed pass over the corpus. Keep that value cheap — `run` returns
 * from INSIDE the timed region, so anything expensive computed there lands in
 * the samples.
 */
export function measure({ iterations, warmup, run }) {
  for (let w = 0; w < warmup; w += 1) run();
  const samples = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    last = run();
    samples.push(performance.now() - t0);
  }
  return { samples, last };
}

/**
 * The shared benchmark corpus: every CommonMark spec example's markdown plus
 * the conformance fixtures, replicated `replicas` times. Shared so that
 * throughput and crossing measure the *same* bytes and their numbers can be
 * put next to each other.
 */
export function buildCorpus(replicas = 1) {
  const spec = JSON.parse(readFileSync(specJsonPath, 'utf8'));
  const fixtures = readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => readFileSync(path.join(fixtureDir, f), 'utf8'));
  const unit = [...spec.map((e) => e.markdown), ...fixtures].join('\n\n');
  return Array.from({ length: replicas }, () => unit).join('\n\n');
}

/**
 * The two adversarial shapes, shared by `bench:pathological` and
 * `bench:crossing`.
 *
 * They live here rather than in either script because the two benches ask
 * different questions about the SAME input and the answers are only
 * comparable if the bytes are identical. `pathological.mjs` times them cold,
 * as a DoS gate; `crossing.mjs` times them warm and split into native and
 * decode, because these are the shapes where the split stops being a
 * formality — a thousand nested containers and sixteen thousand cells are
 * cheap to find and expensive to materialize. Two copies of these generators
 * would let one bench drift a row width or a nesting level and quietly make
 * the two sets of numbers describe different documents.
 */
export function deepBlockquoteSource(levels) {
  return '> '.repeat(levels) + 'echo\n';
}

export function manyCellTableSource(cols, rows) {
  const header = `|${' head |'.repeat(cols)}\n`;
  const divider = `|${' --- |'.repeat(cols)}\n`;
  const row = `|${' cell |'.repeat(cols)}\n`;
  return header + divider + row.repeat(rows);
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function flagValue(name, fallback) {
  const argv = process.argv;
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    return argv[i + 1];
  }
  const prefix = `--${name}=`;
  const kv = argv.find((a) => a.startsWith(prefix));
  return kv ? kv.slice(prefix.length) : fallback;
}

export function numberFlag(name, fallback) {
  const raw = flagValue(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} expects a number, got "${raw}"`);
  }
  return n;
}

export function percentile(samples, p) {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function stats(samples) {
  const sum = samples.reduce((a, b) => a + b, 0);
  // Looped rather than Math.min(...samples): the crossing bench takes
  // hundreds of thousands of samples per stage, and spreading an array that
  // long into an argument list overflows the stack.
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    n: samples.length,
    min,
    max,
    mean: sum / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(2)} ms`;
}

export function fmtBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}
