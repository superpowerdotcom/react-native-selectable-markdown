#!/usr/bin/env node
// Verifies that the published artifact is actually consumable.
//
// `dist/` is build output and is gitignored, so nothing in the repo proves
// that a tarball — from `npm publish`, or from a `github:` install, which
// packs a fresh clone after running `prepare` — carries a built entrypoint.
// This script packs the package exactly the way npm does, unpacks the
// tarball into a scratch dir, and asserts that everything a consuming app
// resolves is present and loadable.
//
// Run with `npm run verify:pack`. Packing triggers `prepare`/`prepack`, so
// this also proves the build-on-install hook works.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The deep paths README documents for headless consumers (scripts, servers,
// the conformance runner and benches in this repo). Unlike the dist/index.js
// barrel they do not reach into the React Native view layer, so each one can
// be required here to prove the emitted JavaScript is real, loads, and still
// exports what callers import from it.
//
// `main` deliberately is NOT in this list and is only checked for presence:
// it re-exports the view layer, so requiring it from plain Node fails with a
// SyntaxError out of react-native's own ESM entry point. Loading one deep
// path and calling that "the entrypoint works" was the gap this list closes:
// the claim now matches what is actually exercised, and it covers every path
// a headless consumer is told to use rather than just the first one.
const NODE_SAFE_ENTRIES = [
  ['dist/engine/Engine.js', 'parseDocument'],
  ['dist/engine/options.js', 'resolveOptions'],
  ['dist/engine/native/index.js', 'createNativeEngine'],
  ['dist/document/visit.js', 'visit'],
  ['dist/document/span.js', 'sliceSpan'],
  ['dist/stream/StreamSession.js', 'StreamSession'],
  ['dist/selection/mapSelection.js', 'projectRun'],
  ['dist/selection/runs.js', 'segmentRuns'],
  ['dist/selection/copy.js', 'buildCopyPayload'],
];

// src/ ships so the declaration maps and source maps in dist/ resolve back to
// readable sources in a consuming app.
const REQUIRED_FILES = ['react-native.config.js', 'src/index.ts'];

// The native sources a consuming app compiles, named individually rather than
// left to the podspec/config sweep below.
//
// The sweep is derived — it checks whatever paths those files happen to name —
// so it can only catch a directory that something still refers to. This list is
// the backstop for the other failure: a `files` allowlist that drops a
// directory *and* a podspec that stops mentioning it, which no derived check
// can see. Each entry is one file rather than its directory, because `files`
// is a directory allowlist and a directory that ships empty (or half) passes a
// presence test while still failing to build.
//
//   platform/fabric        the shared C++ shadow node, state and descriptor.
//                          Missing, the iOS pod compiles a component view with
//                          no shadow node and the Android CMake seam has
//                          nothing to add to React Native's target.
//   .../android-include    the three alias headers the Android seam shadows
//                          codegen's generated ones with. Missing, the app
//                          registers codegen's non-measuring descriptor and
//                          every run lays out at zero height — no build error.
//   platform/ios/fabric    the measurer and the mounting-layer view. Missing,
//                          every new-architecture iOS app fails to link on
//                          `SelectableRunHostCls`, a symbol codegen generated
//                          a reference to on the app's behalf.
//   android/src/main/jni   the CMake seam itself and the JNI measurer.
const REQUIRED_NATIVE_FILES = [
  'platform/fabric/RNSMRunHostShadowNode.cpp',
  'platform/fabric/RNSMRunHostComponentDescriptor.h',
  'platform/fabric/android-include/react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h',
  'platform/ios/fabric/RCTSelectableRunHostComponentView.mm',
  'platform/ios/fabric/RNSMRunTextMeasurer.mm',
  'android/src/main/jni/RNSMRunTextMeasurer.cpp',
];

const SPEC_RELATIVE = 'src/view/SelectableRunHostNativeComponent.ts';
const SPEC_BASENAME = path.basename(SPEC_RELATIVE, '.ts');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-verify-pack-'));
const failures = [];
const fail = (message) => failures.push(message);

/** True when `relative` exists in the tarball and, for a directory, is not empty. */
const present = (pkgDir, relative) => {
  const absolute = path.join(pkgDir, relative);
  if (!fs.existsSync(absolute)) return false;
  if (!fs.statSync(absolute).isDirectory()) return true;
  return fs.readdirSync(absolute).length > 0;
};

const check = (pkgDir, relative, label) => {
  if (relative && present(pkgDir, relative)) return true;
  fail(`${label}: ${relative ?? '<not declared>'} is missing from the tarball`);
  return false;
};

/**
 * Autolinking reads react-native.config.js and follows it to the podspec and
 * the Android source dir, so the config is the honest source of truth for
 * which native paths have to survive packing.
 *
 * EVERY PATH HERE IS RESOLVED AGAINST `pkgDir`, AND GETTING THAT WRONG MAKES
 * THIS CHECK PASS ON A TARBALL WITH NO NATIVE CODE IN IT. The values in the
 * config are package-root-relative strings, because that is the only form the
 * CLI accepts (it does `path.join(root, sourceDir)`, which concatenates rather
 * than resetting on an absolute second argument). A relative string handed to
 * `path.relative(pkgDir, …)` or to `fs.existsSync` is resolved against
 * `process.cwd()` — this repository — so the check reads the working tree it
 * was run from instead of the artifact it was handed, and every assertion
 * below becomes a tautology. That is not hypothetical: with `files` missing
 * `android`, `npm pack` produced a tarball containing no build.gradle, no
 * CMakeLists and not one line of Kotlin, and this script reported `ok`.
 *
 * `cmakeListsPath` is checked for the same reason it exists: the app's
 * generated `Android-autolinking.cmake` turns it into an `add_subdirectory`
 * of the directory containing it, so a path that did not ship is a CMake
 * configure error in the *consumer's* build log, naming a directory of ours.
 */
const checkAutolinkTargets = (pkgDir, require) => {
  const platforms = require(path.join(pkgDir, 'react-native.config.js'))?.dependency?.platforms;
  for (const [platform, key] of [
    ['ios', 'podspecPath'],
    ['android', 'sourceDir'],
  ]) {
    const declared = platforms?.[platform]?.[key];
    if (!declared) {
      fail(`autolinking: react-native.config.js declares no ${platform}.${key}`);
      continue;
    }
    if (!present(pkgDir, declared)) {
      fail(`autolinking: ${platform}.${key} points at ${declared}, which the tarball does not contain`);
    }
  }

  // Joined onto sourceDir, not onto the package root — that is how
  // cli-platform-android's dependencyConfig resolves it.
  const sourceDir = platforms?.android?.sourceDir;
  const cmakeListsPath = platforms?.android?.cmakeListsPath;
  if (sourceDir && cmakeListsPath && !present(pkgDir, path.join(sourceDir, cmakeListsPath))) {
    fail(
      `autolinking: android.cmakeListsPath points at ${path.join(sourceDir, cmakeListsPath)}, ` +
        'which the tarball does not contain — the app would fail at CMake configure time',
    );
  }

  const podspecPath = platforms?.ios?.podspecPath;
  return podspecPath ? path.join(pkgDir, podspecPath) : undefined;
};

/**
 * Every package-relative path the podspec names has to be in the tarball.
 *
 * CocoaPods copies whatever `s.source_files` globs match, adds
 * `HEADER_SEARCH_PATHS` entries verbatim, and marks `s.private_header_files`
 * out of the umbrella header. A glob that matches nothing, or a search path
 * that points at a directory that did not ship, is not an error at `pod
 * install` time: the pod builds with sources silently absent, or with a C++
 * header suddenly public because the private_header_files entry matched
 * nothing. Both surface as a compile error deep in someone else's app.
 *
 * THIS SWEEPS THE WHOLE PODSPEC RATHER THAN PARSING ONE ASSIGNMENT. The
 * previous version matched the text after `s.source_files =` up to the first
 * blank line. That worked only while the value was a literal list on the spot;
 * the moment the podspec built the list in a variable — which it now does, so
 * the Fabric sources can be added only under `RCT_NEW_ARCH_ENABLED` — the
 * regex captured a bare identifier, found no quoted strings in it, and checked
 * nothing at all while still reporting `ok`. A check that silently stops
 * checking is worse than no check, so this looks at every string literal in
 * the file and decides what it is by where it points.
 *
 * WHICH LITERALS COUNT: those whose first path segment is a directory the
 * package claims to ship, i.e. one named in `files`. That is what separates
 * "platform/fabric/*.{h,cpp}" from "https://superpower.com", from
 * "ReactCommon/turbomodule/core" (a pod name, not a path of ours), and from
 * "$(inherited)". `$(PODS_TARGET_SRCROOT)/` is stripped first, because a
 * header search path into our own tree is exactly as load-bearing as a source
 * glob — and just as silent when the directory is missing.
 *
 * The rule is derived from `files`, so it cannot check a directory that `files`
 * omits — that hole is what REQUIRED_NATIVE_FILES covers, and it is also why
 * this reports when it matched nothing at all rather than passing quietly.
 */
const checkPodspecPaths = (pkgDir, podspecPath, manifest) => {
  const podspec = fs.readFileSync(podspecPath, 'utf8');
  const shipped = new Set((manifest.files ?? []).map((entry) => entry.replace(/\/$/, '').split('/')[0]));
  let checked = 0;

  // Deduplicated, because the same directory is legitimately named twice — once
  // as a source glob and once as a header search path — and one missing
  // directory should read as one failure.
  const literals = new Set([...podspec.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]));

  for (const literal of literals) {
    const candidate = literal.replace(/^\$\(PODS_TARGET_SRCROOT\)\//, '');
    if (!shipped.has(candidate.split('/')[0]) || candidate.includes('$(')) continue;
    checked++;
    // Everything up to the first wildcard is a plain path that has to exist —
    // a directory for a glob, the file itself for a literal path such as the
    // single private header naming RNSMAttributedText+Props.h.
    const target = candidate.split('*')[0].replace(/\/$/, '');
    if (target && !present(pkgDir, target)) {
      fail(
        `podspec: "${literal}" resolves to nothing in the tarball — ` +
          `is "${target.split('/')[0]}" in package.json "files", and did the directory ship non-empty?`,
      );
    }
  }

  if (checked === 0) {
    fail(
      'podspec: not one path in the podspec pointed into a directory package.json "files" ' +
        'ships, so nothing was checked. Either "files" no longer lists the native directories ' +
        'or the podspec stopped naming them — both of which make this pod build with no sources.',
    );
  }
};

/**
 * The codegen spec has to reach a consuming app's Metro **untranspiled**, and
 * every way that can fail is silent.
 *
 * `@react-native/babel-plugin-codegen` rewrites the default export into a
 * static view config only when it sees an `ExportDefaultDeclaration` whose
 * callee is `codegenNativeComponent`, and build-time codegen only parses a
 * file whose source text matches `/export\s+default\s+\(?codegenNativeComponent</`.
 * `tsc` erases the type argument and turns the export into
 * `exports.default = …`, which matches neither. Nothing throws: the default
 * export falls back to the runtime `codegenNativeComponent`, which returns
 * `requireNativeComponent`, which is dead under bridgeless — so every run
 * drops to the `<Text selectable>` fallback and both custom menu items vanish
 * with no error anywhere.
 *
 * `check:codegen` proves the *build* does not emit a transpiled copy. This is
 * the only check that sees the artifact a consumer actually installs, so it
 * covers the whole chain that gets the untranspiled file in front of Metro:
 *
 *   - the spec ships, with `codegenNativeComponent<` intact;
 *   - the `react-native` field ships and points at something real — it is the
 *     only reason Metro resolves `src/` instead of `main`'s `dist/`;
 *   - `codegenConfig.jsSrcsDir` ships, because that directory is what the
 *     app's build-time codegen scans; an app whose scan finds nothing
 *     generates no component at all and still builds cleanly;
 *   - no transpiled copy ships under `main`'s output tree, where a bundler
 *     that ignores the `react-native` field would resolve it and get exactly
 *     the silent degradation above.
 *
 * THAT LAST ONE IS KEYED ON CONTENT, NOT ON THE FILENAME, and the difference
 * matters. `dist/view/SelectableRunHostNativeComponent.js` legitimately exists:
 * it is the shim `scripts/emit-dist-spec-shim.mjs` writes so that the static
 * `require` in `dist/view/RunHost.js` resolves for a bundler that follows
 * `main`. A transpiled copy would sit at the same path under the same name; the
 * only thing that distinguishes them is that the transpiled copy calls
 * `codegenNativeComponent` and the shim never mentions it. Keying on the
 * filename would make the shim indistinguishable from the leak it is checked
 * against, which is how a dangling require survived in `dist/` — the fix and
 * the assertion could not both be true.
 */
const checkCodegenSpec = (pkgDir, manifest) => {
  if (check(pkgDir, SPEC_RELATIVE, 'codegen spec')) {
    const source = fs.readFileSync(path.join(pkgDir, SPEC_RELATIVE), 'utf8');
    if (!/export\s+default\s+\(?codegenNativeComponent</.test(source)) {
      fail(
        `codegen spec: ${SPEC_RELATIVE} ships without an untranspiled ` +
          '`export default codegenNativeComponent<…>`. That exact source text is ' +
          'what the babel plugin and build-time codegen both match on, and ' +
          'neither reports anything when it is missing.',
      );
    }
  }

  const metroEntry = manifest['react-native'];
  if (!metroEntry) {
    fail(
      'codegen spec: package.json has no "react-native" field, so Metro falls ' +
        'through to "main" (dist/) and never sees the untranspiled spec',
    );
  } else {
    check(pkgDir, metroEntry, 'codegen spec "react-native" entry');
  }

  const jsSrcsDir = manifest.codegenConfig?.jsSrcsDir;
  if (!jsSrcsDir) {
    fail('codegen spec: package.json declares no codegenConfig.jsSrcsDir to scan');
  } else {
    check(pkgDir, jsSrcsDir, 'codegen spec jsSrcsDir');
  }

  // Walked rather than looked up at `<dist>/view/`, because the emit path
  // follows tsc's rootDir: a directory move would turn a fixed lookup into a
  // silent pass, which is the failure mode this exists to catch.
  const distDir = path.join(pkgDir, path.dirname(manifest.main ?? 'dist/index.js'));
  if (!fs.existsSync(distDir)) return;
  let shims = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.startsWith(SPEC_BASENAME)) {
        if (fs.readFileSync(full, 'utf8').includes('codegenNativeComponent')) {
          fail(
            `codegen spec: ${path.relative(pkgDir, full)} is a transpiled copy of ` +
              'the spec. Something in the built graph imports the spec module — an ' +
              '`import type` is enough — so the tsconfig.build.json exclusion no ' +
              'longer holds. Reach it through a call-expression `require`.',
          );
        } else if (entry.name.endsWith('.js')) {
          shims++;
        }
      }
    }
  };
  walk(distDir);

  // The shim's absence is as consumer-visible as a leak, just louder: the
  // static require in dist/view/RunHost.js stops resolving and every bundler
  // that follows `main` fails to build. The graph walk below reports that from
  // the other direction; this says which file is missing and why it existed.
  if (shims === 0) {
    fail(
      `codegen spec: nothing named ${SPEC_BASENAME}.js ships under ${path.relative(pkgDir, distDir)}. ` +
        'dist/view/RunHost.js requires that module statically, so a bundler resolving "main" ' +
        'cannot build. `npm run build` emits it via scripts/emit-dist-spec-shim.mjs.',
    );
  }
};

/**
 * EVERY RELATIVE `require` REACHABLE FROM `main` HAS TO RESOLVE, and nothing
 * else in this repository asks that question.
 *
 * `NODE_SAFE_ENTRIES` above loads modules, which is a stronger check — but it
 * can only cover the modules plain Node can load, and the whole view layer is
 * excluded by construction (`dist/view/RunHost.js` imports `react-native`,
 * whose ESM entry point is a SyntaxError under `require`). So the file with the
 * most build-time-visible references in the package is the one file no gate
 * ever looked at.
 *
 * A bundler does not need to *load* a module to fail on it. Webpack, Rollup,
 * Vite, Parcel and Next resolve the CommonJS graph statically, and an
 * unresolvable relative require is a hard build error that names our file in
 * their log. That is exactly what shipped: `dist/view/RunHost.js` required
 * `./SelectableRunHostNativeComponent`, which `tsconfig.build.json` excludes
 * from emit on purpose, so every react-native-web consumer's build stopped.
 * `try/catch` around the require is irrelevant — resolution happens before any
 * code runs.
 *
 * Only *relative* specifiers are followed. A bare specifier is a dependency or
 * a peer dependency and is the consuming app's install to satisfy, not
 * something this tarball can be judged on.
 */
const checkRequireGraph = (pkgDir, manifest) => {
  const entry = path.join(pkgDir, manifest.main ?? 'dist/index.js');
  if (!fs.existsSync(entry)) return;

  // Node's own resolution order for a relative specifier with no extension.
  const resolve = (from, specifier) => {
    const base = path.resolve(path.dirname(from), specifier);
    for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  const seen = new Set();
  const queue = [entry];
  let modules = 0;
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    modules++;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
      const resolved = resolve(file, match[1]);
      if (resolved) {
        queue.push(resolved);
      } else {
        fail(
          `require graph: ${path.relative(pkgDir, file)} requires "${match[1]}", which the ` +
            'tarball does not contain. Metro would swallow it as a runtime MODULE_NOT_FOUND, ' +
            'but every bundler that resolves "main" statically (webpack, Rollup, Vite, Parcel, ' +
            'Next — i.e. react-native-web) fails the build naming this file.',
        );
      }
    }
  }

  // A walk that reached one module found nothing because there was nothing to
  // find. Say so rather than reporting a clean graph.
  if (modules < 2) {
    fail(
      `require graph: walking from ${manifest.main} reached ${modules} module(s), so no ` +
        'relative require was checked. The build output is not what this expects.',
    );
  }
};

try {
  console.log('[verify-pack] packing (runs prepare/prepack, i.e. the build)…');
  execFileSync('npm', ['pack', '--pack-destination', scratch], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const tarballs = fs.readdirSync(scratch).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one tarball, got ${JSON.stringify(tarballs)}`);
  }
  execFileSync('tar', ['-xzf', path.join(scratch, tarballs[0]), '-C', scratch]);

  // npm tarballs always unpack under a single `package/` directory.
  const pkgDir = path.join(scratch, 'package');
  const require = createRequire(path.join(pkgDir, 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

  check(pkgDir, manifest.main, 'main');
  check(pkgDir, manifest.types, 'types');
  for (const relative of REQUIRED_FILES) check(pkgDir, relative, 'file');
  for (const relative of REQUIRED_NATIVE_FILES) check(pkgDir, relative, 'native source');

  for (const [relative, exported] of NODE_SAFE_ENTRIES) {
    if (!check(pkgDir, relative, 'entry')) continue;
    let loaded;
    try {
      loaded = require(path.join(pkgDir, relative));
    } catch (error) {
      // A deep path that throws on require is the failure this exists to
      // catch: it means the build emitted something Node cannot load, or
      // that the module grew a React Native import it must not have.
      fail(`entry: ${relative} threw on require (${error.message})`);
      continue;
    }
    if (typeof loaded[exported] !== 'function') {
      fail(`entry: ${relative} does not export ${exported}`);
    }
  }

  checkCodegenSpec(pkgDir, manifest);
  checkRequireGraph(pkgDir, manifest);

  const podspecPath = checkAutolinkTargets(pkgDir, require);
  if (podspecPath && fs.existsSync(podspecPath)) checkPodspecPaths(pkgDir, podspecPath, manifest);

  console.log(`[verify-pack] ${tarballs[0]} — ${failures.length === 0 ? 'ok' : 'FAILED'}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[verify-pack] ${failure}`);
  console.error(
    '[verify-pack] the packed package is not consumable — check "files", "main",\n' +
      '              "types", and that `npm run build` emits dist/.',
  );
  process.exit(1);
}
