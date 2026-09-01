#!/usr/bin/env node
// CommonMark 0.31.2 conformance runner.
//
// Oracle fixture: conformance/vendor/spec.json — the official test dump
// published at https://spec.commonmark.org/0.31.2/spec.json (see
// conformance/vendor/README.md for exact provenance).
//
// Parses every spec example with the library's engine (via dist/), serializes
// the AST back to HTML with conformance/serialize-html.ts, and compares
// against the expected HTML with a whitespace-tolerant normalizer. Writes
// conformance/report-native.json with per-section pass counts and prints a
// summary.
//
//   node conformance/run-commonmark.mjs
//
// The run needs the test addon (native/node/), which the loader builds on
// demand. There is no engine to choose any more: the package parses with md4c
// and ships no JavaScript parser, so the `--engine` flag this script used to
// take is gone. It is still recognized, and refused with an explanation,
// because it appears in shell history, in scripts and in older docs — silently
// ignoring it would let someone believe they had measured something they had
// not.
//
// WHY THE REPORT IS STILL CALLED report-native.json. The name distinguished
// two engines' results, and now distinguishes nothing — but it is the file
// docs/BENCHMARKS.md cites, the one .gitignore lists, and renaming it would
// invalidate published numbers for no gain. `conformance/report.json` (the
// other engine's report) is no longer written at all.
//
// This runner REPORTS conformance; it does not gate. Every measured outcome —
// including a run where most of the spec fails — exits 0, so a score can never
// turn a build red. The one non-zero exit is the refused `--engine` flag,
// which is a usage error rather than a measurement: nothing ran, so there is
// no score to report, and staying silent-and-green there is exactly the
// confusion the refusal exists to prevent.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const SPEC_PATH = path.join(here, 'vendor', 'spec.json');
const SPEC_URL = 'https://spec.commonmark.org/0.31.2/spec.json';

const REPORT_PATH = path.join(here, 'report-native.json');

/**
 * The `--engine` flag selected between the md4c engine and a bundled
 * pure-TypeScript one. That second engine no longer exists, so there is
 * nothing to select — but a flag that quietly does nothing is worse than one
 * that is gone, because the run still prints a plausible number under a
 * heading the caller thinks they chose. Refusing loudly is the point.
 */
function refuseEngineArg() {
  const passed =
    process.argv.includes('--engine') ||
    process.argv.some((a) => a.startsWith('--engine='));
  if (!passed) return false;
  console.error(
    '[conformance] --engine is no longer accepted: this package parses with ' +
      'md4c and ships no other engine, so there is nothing to select. Run ' +
      '`node conformance/run-commonmark.mjs` with no flags. To score a parser ' +
      'of your own, call parseDocument(source, options, engine) directly — ' +
      'the seam is still public.',
  );
  return true;
}

/* Refused BEFORE main, deliberately, and not as a thrown error inside it.
 * Two things follow from that placement. The exit code is 1, because nothing
 * was measured and a flag that a caller believed selected an engine must not
 * come back looking like a successful run. And REPORT_PATH is left untouched:
 * routing this through main's catch would stamp an "error" record over the
 * last real report — the same file docs/BENCHMARKS.md cites for the published
 * pass rate — so a stale habit in someone's shell history would silently
 * destroy the number rather than merely fail to add to it. */
if (refuseEngineArg()) {
  process.exit(1);
}

main()
  .catch((err) => {
    console.error('[conformance] runner failed:', err && err.stack ? err.stack : err);
    writeReport({
      spec: 'CommonMark 0.31.2',
      specUrl: SPEC_URL,
      error: String((err && err.message) || err),
      generatedAt: new Date().toISOString(),
    });
  })
  .finally(() => {
    process.exitCode = 0;
  });

async function main() {
  const distDir = ensureBuilt();
  // The dist barrel (dist/index.js) re-exports the React Native view layer,
  // and react-native itself is not loadable in plain Node — so require the
  // Node-safe engine subtree directly.
  const { parseDocument } = require(path.join(distDir, 'engine', 'Engine.js'));
  const { presets } = require(path.join(distDir, 'engine', 'options.js'));
  if (typeof parseDocument !== 'function') {
    throw new Error('dist/engine/Engine.js does not export parseDocument');
  }
  const engine = await resolveEngine(distDir);

  const { serializeDocumentToHtml } = await loadSerializer();
  const examples = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

  // The oracle measures parser conformance, so the library's security
  // defaults are deliberately widened here: HTML passes through raw and the
  // URL allowlist admits every scheme (spec examples use ftp:, javascript:,
  // MAILTO:, ...). The safe defaults get their own tests elsewhere.
  const options = {
    ...(presets ? presets.commonmark : {}),
    html: 'raw',
    urlPolicy: { linkPrefixes: [''], imagePrefixes: [''] },
  };

  const sections = new Map();
  const failing = [];
  let passed = 0;
  let errored = 0;

  for (const example of examples) {
    let ok = false;
    try {
      const doc = parseDocument(example.markdown, options, engine);
      const actual = serializeDocumentToHtml(doc);
      ok = normalizeHtml(actual) === normalizeHtml(example.html);
    } catch {
      errored += 1;
    }
    const tally = sections.get(example.section) ?? { passed: 0, total: 0 };
    tally.total += 1;
    if (ok) {
      tally.passed += 1;
      passed += 1;
    } else {
      failing.push(example.example);
    }
    sections.set(example.section, tally);
  }

  const total = examples.length;
  const percent = total === 0 ? 0 : Math.round((passed / total) * 10000) / 100;

  const report = {
    spec: 'CommonMark 0.31.2',
    specUrl: SPEC_URL,
    engine: engine.name,
    generatedAt: new Date().toISOString(),
    overall: { passed, failed: total - passed, errored, total, percent },
    sections: [...sections.entries()].map(([section, tally]) => ({
      section,
      passed: tally.passed,
      total: tally.total,
    })),
    failingExamples: failing,
  };
  writeReport(report);

  const width = Math.max(...[...sections.keys()].map((s) => s.length));
  console.log('CommonMark 0.31.2 conformance (engine: %s)', report.engine);
  console.log('-'.repeat(width + 12));
  for (const { section, passed: p, total: t } of report.sections) {
    console.log(`${section.padEnd(width)}  ${String(p).padStart(3)}/${String(t).padEnd(3)}`);
  }
  console.log('-'.repeat(width + 12));
  console.log(`overall: ${passed}/${total} (${percent}%), ${errored} example(s) threw`);
  console.log(`report: ${path.relative(repoRoot, REPORT_PATH)}`);
}

/**
 * The engine needs a host binding, which in Node is the test addon over the
 * same C++ the React Native bindings call — `native/node/index.mjs` builds it
 * on demand. It is passed to `parseDocument` explicitly rather than letting
 * the default resolve itself: nothing installs a `__selectableMarkdown` global
 * in plain Node, so the default would throw, and being explicit also means the
 * report names the engine that actually ran.
 */
async function resolveEngine(distDir) {
  const { createNativeEngine } = require(path.join(distDir, 'engine', 'native', 'index.js'));
  const { parse } = await import(path.join(repoRoot, 'native', 'node', 'index.mjs'));
  return createNativeEngine(parse);
}

function ensureBuilt() {
  const distDir = path.join(repoRoot, 'dist');
  const probe = path.join(distDir, 'engine', 'Engine.js');
  if (!existsSync(probe)) {
    console.log('[conformance] dist/ missing — running `npm run build` first…');
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

// serialize-html.ts is TypeScript so it can typecheck against the document
// model; transpile it on the fly with the repo's own compiler and import the
// result through a data: URL (the module is dependency-free by design).
async function loadSerializer() {
  const ts = require('typescript');
  const src = readFileSync(path.join(here, 'serialize-html.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    fileName: 'serialize-html.ts',
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
}

// Whitespace-tolerant comparison: <pre>…</pre> content is preserved verbatim
// (whitespace is meaningful there); everywhere else, whitespace runs collapse
// to one space, inter-tag whitespace is dropped, and void elements are
// canonicalized to the CommonMark reference renderer's "<br />" form. Preserved segments hide
// behind NUL-framed placeholders — NUL cannot occur in spec HTML (the spec
// mandates NUL -> U+FFFD), so the sentinel is collision-free.
function normalizeHtml(html) {
  const preserved = [];
  let s = html.replace(
    /<pre[^>]*>[\s\S]*?<\/pre>/gi,
    (m) => `\u0000${preserved.push(m) - 1}\u0000`,
  );
  s = s
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/ ?\u0000 ?/g, '\u0000')
    .replace(/<(br|hr)\s*\/?>/gi, '<$1 />')
    .replace(/<img([^>]*?)\s*\/?>/gi, '<img$1 />')
    .trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => preserved[Number(i)]);
}

function writeReport(report) {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}
