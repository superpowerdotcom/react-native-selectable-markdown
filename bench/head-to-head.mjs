#!/usr/bin/env node
// Head-to-head throughput against other markdown parsers.
//
// This is the harness behind the leaderboard in docs/BENCHMARKS.md. It lives
// in the repo (rather than being a one-off script) for one reason: a number
// nobody else can reproduce is a marketing claim, not a measurement.
//
//   node bench/head-to-head.mjs --libs /path/to/dir/with/node_modules
//
// The comparison libraries are NOT dependencies of this package — installing
// markdown-it, marked, commonmark and micromark to publish a README table
// would put four parsers into every consumer's lockfile. Install them
// wherever you like and point --libs at that directory:
//
//   mkdir /tmp/mdbench && cd /tmp/mdbench && npm init -y
//   npm install markdown-it marked commonmark micromark
//   node bench/head-to-head.mjs --libs /tmp/mdbench
//
// FAIRNESS RULES, all of which the numbers depend on:
//
//  1. One unit of work for everyone: markdown string in → HTML string out.
//     Ours parses to the span-carrying AST and then serializes with
//     conformance/serialize-html.ts (the same writer the conformance oracle
//     uses, so it is verified against the spec suite, not hand-waved).
//     That AST is a product the HTML-only libraries do not build at all —
//     noted here rather than adjusted for.
//  2. One corpus for everyone: every CommonMark 0.31.2 spec example plus this
//     repo's fixtures, replicated (default ×12 ≈ 290 kB).
//  3. A fresh process per library, so no library warms or poisons another's
//     JIT state and each gets a clean heap. This script re-executes itself
//     with --only <id> to do that.
//  4. Sanitizers off where a library has them on by default: the measurement
//     is of parsing, not of escaping policy. Same reasoning as the
//     conformance runner's widened options.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import {
  buildCorpus,
  flagValue,
  fmtBytes,
  hasFlag,
  loadLibrary,
  loadNativeEngine,
  numberFlag,
  refuseEngineFlag,
  repoRoot,
  stats,
} from './support.mjs';

// Before anything else, and before the `--only` child dispatch below, because
// this bench is the one whose output is a LEADERBOARD: printing md4c's row
// under a heading a stale `--engine reference` made the reader expect is the
// exact misreading refuseEngineFlag exists to prevent. The other four benches
// get this through resolveEngine; head-to-head resolves the engine itself
// (loadNativeEngine directly, so an unbuildable addon is one skipped row
// rather than the end of the run), which is how it went unrefused. Children
// are spawned with an explicitly built argv rather than an inherited one, so
// refusing here refuses for the whole run.
refuseEngineFlag();

const replicas = numberFlag('replicas', 12);
const iterations = numberFlag('iterations', hasFlag('quick') ? 3 : 20);
const warmup = hasFlag('quick') ? 1 : 3;
const libsDir = flagValue('libs', null);
const only = flagValue('only', null);

// id → how to build a `render(markdown) => html` for it. `external: true`
// means it comes from --libs; ours are resolved out of dist/ and run on the
// md4c engine, the only parser this package has. The two entries differ only
// in preset: `llmChat` is what an app renders a chat stream with, `commonmark`
// is the strict-spec configuration, and both are listed because the preset
// changes which constructs md4c is asked to look for — a fair comparison has
// to say which one produced the number.
const CONTENDERS = [
  { id: 'ours', label: 'ours — md4c (llmChat)', external: false },
  { id: 'ours-cm', label: 'ours — md4c (commonmark)', external: false },
  { id: 'markdown-it', label: 'markdown-it (default, html:true)', external: true, pkg: 'markdown-it' },
  { id: 'markdown-it-cm', label: 'markdown-it (commonmark preset)', external: true, pkg: 'markdown-it' },
  { id: 'marked', label: 'marked (defaults, gfm:true)', external: true, pkg: 'marked' },
  { id: 'marked-nogfm', label: 'marked (gfm:false)', external: true, pkg: 'marked' },
  { id: 'commonmark', label: 'commonmark.js (JS reference impl)', external: true, pkg: 'commonmark' },
  { id: 'micromark', label: 'micromark (dangerous html/protocol)', external: true, pkg: 'micromark' },
];

if (only) {
  await runOne(only);
} else {
  await runAll();
}

// ---------------------------------------------------------------------------
// Child mode: measure exactly one contender and print a JSON line
// ---------------------------------------------------------------------------

async function runOne(id) {
  const contender = CONTENDERS.find((c) => c.id === id);
  if (!contender) throw new Error(`unknown contender "${id}"`);
  const corpus = buildCorpus(replicas);
  const bytes = Buffer.byteLength(corpus, 'utf8');

  let render;
  try {
    render = contender.external
      ? await makeExternalRenderer(contender)
      : await makeOursRenderer(contender);
  } catch (err) {
    console.log(JSON.stringify({ id, skipped: String((err && err.message) || err) }));
    return;
  }

  // A cheap output-shape check: a library that silently rendered nothing
  // would otherwise post an unbeatable throughput.
  const probe = render('# probe\n\nwith *emphasis*\n');
  if (!/<h1/i.test(probe) || !/<em/i.test(probe)) {
    console.log(JSON.stringify({ id, skipped: `renderer produced unexpected HTML: ${probe.slice(0, 80)}` }));
    return;
  }

  for (let i = 0; i < warmup; i += 1) render(corpus);
  const samples = [];
  let outLength = 0;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    const html = render(corpus);
    samples.push(performance.now() - t0);
    outLength = html.length;
  }
  const s = stats(samples);
  console.log(
    JSON.stringify({
      id,
      bytes,
      outLength,
      medianMs: s.p50,
      bestMs: s.min,
      medianMbPerSec: bytes / 1e6 / (s.p50 / 1000),
      bestMbPerSec: bytes / 1e6 / (s.min / 1000),
    }),
  );
}

async function makeOursRenderer(contender) {
  const lib = loadLibrary();
  const { serializeDocumentToHtml } = await loadSerializer();
  // Conformance-shaped options: HTML raw and an open URL policy, so the
  // measurement is of parsing rather than of this library's safety defaults
  // (which the other libraries have had disabled too).
  const commonmark = contender.id.endsWith('-cm');
  const options = {
    ...(commonmark ? lib.presets.commonmark : lib.presets.llmChat),
    html: 'raw',
    urlPolicy: { linkPrefixes: [''], imagePrefixes: [''] },
  };
  // Passed explicitly rather than relying on parseDocument's default: this
  // process may have no `__selectableMarkdown` global at all, and the addon
  // reached through native/node/index.mjs is what makes the engine usable
  // here. A missing toolchain throws with the harness's own message, which
  // runOne turns into a `skipped:` row instead of an empty leaderboard.
  const native = await loadNativeEngine(lib);
  if (!native.engine) throw new Error(native.reason);
  return (markdown) => serializeDocumentToHtml(lib.parseDocument(markdown, options, native.engine));
}

async function makeExternalRenderer(contender) {
  if (!libsDir) throw new Error('--libs not given');
  const requireLib = createRequire(path.join(path.resolve(libsDir), 'noop.js'));
  switch (contender.id) {
    case 'markdown-it': {
      const MarkdownIt = requireLib('markdown-it');
      const md = new MarkdownIt({ html: true });
      return (src) => md.render(src);
    }
    case 'markdown-it-cm': {
      const MarkdownIt = requireLib('markdown-it');
      const md = new MarkdownIt('commonmark');
      return (src) => md.render(src);
    }
    case 'marked': {
      const { marked } = requireLib('marked');
      return (src) => marked.parse(src, { async: false, gfm: true });
    }
    case 'marked-nogfm': {
      const { marked } = requireLib('marked');
      return (src) => marked.parse(src, { async: false, gfm: false });
    }
    case 'commonmark': {
      const commonmark = requireLib('commonmark');
      const parser = new commonmark.Parser();
      const writer = new commonmark.HtmlRenderer();
      return (src) => writer.render(parser.parse(src));
    }
    case 'micromark': {
      const { micromark } = requireLib('micromark');
      return (src) => micromark(src, { allowDangerousHtml: true, allowDangerousProtocol: true });
    }
    default:
      throw new Error(`no external renderer for ${contender.id}`);
  }
}

/** conformance/serialize-html.ts, transpiled on the fly (see the runner). */
async function loadSerializer() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(path.join(repoRoot, 'conformance', 'serialize-html.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    fileName: 'serialize-html.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
}

// ---------------------------------------------------------------------------
// Parent mode: one child per contender, then the leaderboard
// ---------------------------------------------------------------------------

async function runAll() {
  const results = [];
  for (const contender of CONTENDERS) {
    const args = [
      path.join(repoRoot, 'bench', 'head-to-head.mjs'),
      '--only', contender.id,
      '--replicas', String(replicas),
      '--iterations', String(iterations),
    ];
    if (libsDir) args.push('--libs', libsDir);
    if (hasFlag('quick')) args.push('--quick');
    const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
    if (!line) {
      results.push({ ...contender, skipped: (res.stderr || 'no output').trim().split('\n').pop() });
      continue;
    }
    try {
      results.push({ ...contender, ...JSON.parse(line) });
    } catch {
      results.push({ ...contender, skipped: `unparseable child output: ${line.slice(0, 120)}` });
    }
  }

  const measured = results.filter((r) => !r.skipped).sort((a, b) => b.medianMbPerSec - a.medianMbPerSec);
  const skipped = results.filter((r) => r.skipped);
  const bytes = measured[0]?.bytes ?? 0;
  const fastest = measured[0]?.medianMbPerSec ?? 0;

  console.log('markdown → HTML throughput, one fresh process per library');
  console.log(`  corpus:     ${fmtBytes(bytes)} (spec examples + fixtures ×${replicas})`);
  console.log(`  iterations: ${iterations} (+${warmup} warmup), median reported`);
  console.log('');
  // Widened over EVERY result, not just the measured ones: the skipped rows
  // print the same label column, and with the two shortest-named contenders
  // now being ours, sizing on the leaderboard alone left every `skipped:`
  // line ragged.
  const width = Math.max(...results.map((r) => r.label.length), 10);
  console.log(
    `  ${'#'.padStart(2)}  ${'engine'.padEnd(width)}  ${'MB/s'.padStart(8)} ${'best'.padStart(8)}  ${'vs #1'.padStart(7)}`,
  );
  measured.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${r.label.padEnd(width)}  ` +
        `${r.medianMbPerSec.toFixed(2).padStart(8)} ${r.bestMbPerSec.toFixed(2).padStart(8)}  ` +
        `${(r.medianMbPerSec / fastest).toFixed(2).padStart(6)}×`,
    );
  });
  for (const r of skipped) console.log(`  --  ${r.label.padEnd(width)}  skipped: ${r.skipped}`);
  if (!libsDir && skipped.length > 0) {
    console.log('\n  (pass --libs <dir> with the comparison libraries installed to fill these in)');
  }
}
