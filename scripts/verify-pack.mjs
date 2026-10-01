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
// Run with `npm run verify:pack`. Packing triggers `prepare` — the one
// build lifecycle script this package declares, and the same one npm runs on
// `npm publish` and on a `github:` install — so this also proves the
// build-on-install hook works.

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
  // The headless `<name>/engine` entry first: a barrel of its own that must
  // load with no dependency at all (src/index.test.ts pins that it never
  // reaches the view layer; this keeps the same promise at runtime). Its
  // sibling `<name>/stream` is NOT here — see PEER_DEPENDENT_ENTRIES.
  ['dist/engine.js', 'parseDocument'],
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

// Entries that load only with the `react` PEER resolvable — which is every
// consumer's situation, and not this script's: the tarball is unpacked into a
// scratch directory with nothing above it. `<name>/stream` re-exports
// `bindRunTextEvents`, whose module imports `react` at load for its hooks, so
// importing the barrel in a bare directory fails with ERR_MODULE_NOT_FOUND for
// 'react' however correct the build is. These are loaded AFTER the Node-safe
// entries above and after `react` has been linked in (see linkPeers), so the
// zero-dependency property of NODE_SAFE_ENTRIES is still proven for those.
const PEER_DEPENDENT_ENTRIES = [['dist/stream.js', 'StreamSession']];

// Links the peer the entries above need into the unpacked package, from this
// repository's own devDependencies. Node resolves a symlinked package by its
// REAL path, so one link under <pkgDir>/node_modules serves both the direct
// `require` below and the ESM probe that reaches the package through a
// consumer symlink. A symlink is not a directory to fs.Dirent, so the
// build-artifact walk does not descend into it.
const linkPeers = (pkgDir) => {
  const modules = path.join(pkgDir, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const peer of ['react']) {
    const target = path.dirname(createRequire(import.meta.url).resolve(`${peer}/package.json`));
    const link = path.join(modules, peer);
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
  }
};

// src/ ships so the declaration maps and source maps in dist/ resolve back to
// readable sources in a consuming app.
//
// native/node and the addon build script ship because a consumer's test runner
// builds the Node engine from the installed package (`<name>/node` is the
// loader, scripts/build-node-addon.mjs the build); a `files` edit that drops
// either turns every consumer's jest run red with nothing here going red first.
const REQUIRED_FILES = [
  'react-native.config.js',
  'src/index.ts',
  'src/engine.ts',
  'src/stream.ts',
  'native/node/index.mjs',
  'scripts/build-node-addon.mjs',
];

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
//                          the class the generated
//                          RCTThirdPartyComponentsProvider names is never
//                          compiled, so at this package's peer floor
//                          (react-native >= 0.82) its NSClassFromString
//                          lookup finds nothing: a silent registration miss
//                          whose only symptom is `RunHost` throwing at mount.
//                          On the older React Natives that still call
//                          `SelectableRunHostCls` directly it is instead a
//                          link failure in the consuming app.
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
 * `exports.default = …`, which matches neither. Nothing in the build reports
 * it: the default export falls back to the runtime `codegenNativeComponent`,
 * which returns `requireNativeComponent`, which is dead under bridgeless — so
 * the run either renders with a null view config (an invariant violation) or,
 * where the module resolves to nothing at all, `RunHost` throws. The
 * `<Text selectable>` fallback that used to swallow both went with the old
 * architecture in 0.10.0.
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
 *     the silent degradation above;
 *   - the shim that replaces it there ships with a .d.ts beside it, because
 *     `exports` promises one for every `./dist/*` path.
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
  const shimFiles = [];
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
          shimFiles.push(full);
        }
      }
    }
  };
  walk(distDir);
  const shims = shimFiles.length;

  // A shim with no .d.ts beside it is a hole in `exports`, not just a missing
  // convenience. The `./dist/*` pattern declares its types as `./dist/*.d.ts`,
  // and a types condition that names a file which is not in the tarball is a
  // hard TS7016 for any consumer who deep-imports the path — an error the
  // package cannot be fixed from the consumer's side. tsc emits every other
  // dist declaration; this one comes from scripts/emit-dist-spec-shim.mjs,
  // which is exactly the kind of hand-written emit that goes missing. The
  // declaration re-exports the prop types from the untranspiled spec in src/,
  // whose presence in the tarball is asserted at the top of this function.
  for (const shim of shimFiles) {
    const declaration = shim.replace(/\.js$/, '.d.ts');
    if (!fs.existsSync(declaration)) {
      fail(
        `codegen spec: ${path.relative(pkgDir, shim)} ships with no ` +
          `${path.basename(declaration)} beside it, but "exports"'s "./dist/*" entry declares ` +
          'its types as "./dist/*.d.ts". A TypeScript consumer deep-importing that path gets ' +
          '"Could not find a declaration file", not an implicit any. ' +
          '`npm run build` emits both via scripts/emit-dist-spec-shim.mjs.',
      );
    }
  }

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

/**
 * ONCE `exports` EXISTS, IT — NOT THE FILE TREE — IS THE PACKAGE'S PUBLIC
 * SURFACE, and every check above this one resolves by filesystem path and so
 * cannot see it. `NODE_SAFE_ENTRIES` loads `<pkgDir>/dist/…` directly; a map
 * that forgot `./dist/*` would leave those files present, loadable and
 * unreachable, and the failure would surface as ERR_PACKAGE_PATH_NOT_EXPORTED
 * in a consumer's app rather than here.
 *
 * So the deep paths README documents for headless consumers are resolved the
 * way a consumer resolves them: through a `node_modules` link, by bare
 * specifier. Both spellings are asserted — with and without `.js` — because
 * the README writes them without an extension and `exports` does no extension
 * search of its own; only a subpath pattern for each form makes both work.
 *
 * `<name>/package.json` is checked because autolinking resolves the package
 * root through it (@react-native-community/cli), and an `exports` map that
 * omits it breaks `pod install` and the Gradle sweep in every consuming app
 * while every file in this tarball is still exactly where it belongs.
 *
 * AND BOTH CONDITIONS, BECAUSE THE PACKAGE NOW SHIPS TWO BUILDS. `require`
 * takes the CommonJS tree in dist/, `import` takes the ES modules in dist/esm
 * — and only one of the two can be checked with `createRequire`. So the ESM
 * half is exercised in a child Node process (checkEsmResolution below), which
 * both resolves and IMPORTS each Node-safe deep path: an ESM build is
 * unusually easy to ship broken (a missing `"type": "module"`, one relative
 * specifier left without its `.js`) and every one of those failures is invisible
 * to a resolver and loud on the first import.
 */
const checkExportsResolution = (pkgDir, manifest) => {
  const consumer = path.join(scratch, 'consumer');
  const linked = path.join(consumer, 'node_modules', manifest.name);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  if (!fs.existsSync(linked)) fs.symlinkSync(pkgDir, linked, 'dir');
  const consumerRequire = createRequire(path.join(consumer, 'index.js'));

  const resolves = (specifier) => {
    try {
      return consumerRequire.resolve(specifier);
    } catch (error) {
      fail(
        `exports: a consumer cannot resolve "${specifier}" (${error.code ?? error.message}). ` +
          'The file may well be in the tarball — "exports" is what decides whether a ' +
          'consumer is allowed to reach it.',
      );
      return null;
    }
  };

  const root = resolves(manifest.name);
  const expectedRoot = path.join(pkgDir, manifest.main ?? '');
  if (root && fs.realpathSync(root) !== fs.realpathSync(expectedRoot)) {
    fail(
      `exports: "${manifest.name}" resolves to ${path.relative(pkgDir, root)} under Node's ` +
        `own conditions, not to "main" (${manifest.main}).`,
    );
  }

  resolves(`${manifest.name}/package.json`);

  // The named subpaths, each pinned to the file it must land on under Node's
  // own (`require`) conditions. `engine` and `stream` are the headless
  // entries a consumer's jest imports; `node` is the addon loader its test
  // setup requires. Resolution alone is the check here — the two dist entries
  // are also LOADED, under both conditions, through NODE_SAFE_ENTRIES.
  const SUBPATH_TARGETS = {
    engine: 'dist/engine.js',
    stream: 'dist/stream.js',
    node: 'native/node/index.mjs',
  };
  for (const [subpath, target] of Object.entries(SUBPATH_TARGETS)) {
    const resolved = resolves(`${manifest.name}/${subpath}`);
    const expected = path.join(pkgDir, target);
    if (resolved && fs.realpathSync(resolved) !== fs.realpathSync(expected)) {
      fail(
        `exports: "${manifest.name}/${subpath}" resolves to ${path.relative(pkgDir, resolved)}, ` +
          `expected ${target}.`,
      );
    }
  }

  for (const [relative] of NODE_SAFE_ENTRIES) {
    resolves(`${manifest.name}/${relative}`);
    resolves(`${manifest.name}/${relative.replace(/\.js$/, '')}`);
  }

  // Metro reads `exports` from React Native 0.79 on, and prefers the
  // `react-native` condition over `main` when it is there. That condition is
  // therefore the same load-bearing thing the `react-native` field is (see
  // checkCodegenSpec): it is what gets the untranspiled codegen spec in front
  // of Metro. A map whose "." entry lost it sends Metro to dist/ instead, and
  // the component silently stops having a static view config.
  const rootEntry = manifest.exports?.['.'];
  if (manifest.exports && typeof rootEntry === 'object' && rootEntry !== null) {
    if (rootEntry['react-native'] !== `./${manifest['react-native']}`) {
      fail(
        `exports: the "." entry's "react-native" condition is ${JSON.stringify(rootEntry['react-native'])}, ` +
          `expected "./${manifest['react-native']}". Metro honours "exports" ahead of the ` +
          '"react-native" field, so this condition is what makes it read the untranspiled spec.',
      );
    }
    if (rootEntry.default !== `./${manifest.main}`) {
      fail(
        `exports: the "." entry's "default" condition is ${JSON.stringify(rootEntry.default)}, ` +
          `expected "./${manifest.main}" — every bundler that is not Metro lands here.`,
      );
    }
    // The two builds, each pinned to the field that names it. `require` must
    // stay on the CommonJS tree even though `import` exists, and `import` must
    // point at the ESM one: a map where both conditions resolved to dist/ would
    // pass every resolution check above and quietly undo the ESM build.
    if (rootEntry.require?.default !== `./${manifest.main}`) {
      fail(
        `exports: the "." entry's "require" condition is ${JSON.stringify(rootEntry.require)}, ` +
          `expected its "default" to be "./${manifest.main}".`,
      );
    }
    if (manifest.module && rootEntry.import?.default !== `./${manifest.module}`) {
      fail(
        `exports: the "." entry's "import" condition is ${JSON.stringify(rootEntry.import)}, ` +
          `expected its "default" to be "./${manifest.module}" — the ES module build is what ` +
          'webpack, Rollup and Vite tree-shake.',
      );
    }
  } else if (manifest.exports) {
    fail('exports: the "." entry is not a conditions object, so nothing pins Metro to src/.');
  }

  checkEsmResolution(consumer, pkgDir, manifest);
};

/**
 * The `import` condition, resolved AND loaded the way a bundler's Node does.
 *
 * It has to be a child process: `createRequire().resolve` above can only ever
 * take the `require` condition, and this package's ESM output is exactly the
 * kind that resolves and then fails to load — dist/esm/package.json's
 * `"type": "module"` is what stops Node parsing those files as CommonJS, and
 * every relative specifier in them needs the `.js` that tsc does not write
 * (scripts/finish-esm-build.mjs adds both). A missing one is an
 * ERR_MODULE_NOT_FOUND in a consumer's app and nothing at all here, unless
 * something actually imports the module.
 *
 * The root barrel is resolved but NOT imported, for the same reason it is
 * absent from NODE_SAFE_ENTRIES: it re-exports the React Native view layer.
 */
const checkEsmResolution = (consumer, pkgDir, manifest) => {
  if (!manifest.exports) return;

  // The `"type": "module"` marker is asserted on the FILE rather than inferred
  // from the probe below, because the probe cannot see it on a new enough
  // runtime: Node detects ES module syntax in an untyped .js from 22.7 on, so
  // this same import succeeds there and fails with `Cannot use import statement
  // outside a module` on Node 20 — the version both workflows pin and the floor
  // most consumers are on. A check that passes or fails with the checker's Node
  // is not a check.
  const esmDir = path.dirname(path.join(pkgDir, manifest.module ?? 'dist/esm/index.js'));
  const marker = path.join(esmDir, 'package.json');
  if (!fs.existsSync(marker)) {
    fail(
      `exports: ${path.relative(pkgDir, marker)} is not in the tarball, so Node reads the ` +
        'ES module build as CommonJS and every import statement in it is a SyntaxError. ' +
        '`npm run build` writes it via scripts/finish-esm-build.mjs.',
    );
  } else {
    const declared = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (declared.type !== 'module') {
      fail(
        `exports: ${path.relative(pkgDir, marker)} says "type": ${JSON.stringify(declared.type)}, ` +
          'not "module" — the ES module build would be parsed as CommonJS.',
      );
    }
    // Bundlers read `sideEffects` from the package.json nearest the module, so
    // the root's declaration does not reach dist/esm. Without it here, the ESM
    // build resolves and loads and still cannot be tree-shaken, which is the
    // only reason it exists.
    if (declared.sideEffects !== false) {
      fail(
        `exports: ${path.relative(pkgDir, marker)} does not declare "sideEffects": false. ` +
          'webpack and Rollup read that hint from the nearest package.json, so the ES module ' +
          'build cannot be tree-shaken without it.',
      );
    }
  }

  const probe = path.join(consumer, 'esm-probe.mjs');
  const specifiers = {
    // `<name>/node` is deliberately absent: everything resolved here must land
    // in the ES module BUILD, and the addon loader is a hand-written .mjs under
    // native/ that is the same file under every condition. Its subpath is
    // pinned to that file by SUBPATH_TARGETS in checkExportsResolution.
    resolveOnly: [manifest.name, `${manifest.name}/dist`],
    load: [
      // The bare subpaths under the `import` condition — the spelling a
      // bundler resolves to dist/esm/engine.js and dist/esm/stream.js.
      [`${manifest.name}/engine`, 'parseDocument'],
      [`${manifest.name}/stream`, 'StreamSession'],
      ...[...NODE_SAFE_ENTRIES, ...PEER_DEPENDENT_ENTRIES].flatMap(([relative, exported]) => [
        [`${manifest.name}/${relative}`, exported],
        [`${manifest.name}/${relative.replace(/\.js$/, '')}`, exported],
      ]),
    ],
  };
  fs.writeFileSync(
    probe,
    [
      'const plan = JSON.parse(process.argv[2]);',
      'const out = [];',
      'for (const specifier of plan.resolveOnly) {',
      '  out.push({ specifier, resolved: import.meta.resolve(specifier) });',
      '}',
      'for (const [specifier, exported] of plan.load) {',
      '  const namespace = await import(specifier);',
      '  out.push({',
      '    specifier,',
      '    resolved: import.meta.resolve(specifier),',
      '    exports: typeof namespace[exported],',
      '  });',
      '}',
      'process.stdout.write(JSON.stringify(out));',
      '',
    ].join('\n'),
  );

  let reported;
  try {
    reported = JSON.parse(
      execFileSync(process.execPath, [probe, JSON.stringify(specifiers)], {
        cwd: consumer,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    fail(
      'exports: the "import" condition is not usable — a consumer importing this package as ' +
        `ES modules got:\n    ${String(error.stderr || error.message).trim().split('\n').join('\n    ')}`,
    );
    return;
  }

  for (const entry of reported) {
    // Every one of these must land in the ES module tree; the point of the
    // condition is that it does not serve the CommonJS build twice.
    if (!entry.resolved.includes('/dist/esm/')) {
      fail(
        `exports: "${entry.specifier}" resolves to ${entry.resolved} under the "import" ` +
          'condition, which is not the ES module build. The `import` condition would then ' +
          'hand a bundler the CommonJS tree it cannot tree-shake.',
      );
    }
    if (entry.exports !== undefined && entry.exports !== 'function') {
      fail(
        `exports: "${entry.specifier}" imported as an ES module, but the export the ` +
          `require-condition check loads is ${entry.exports} there.`,
      );
    }
  }
};

/**
 * Compiled objects are not source, and `files` is not `.gitignore`.
 *
 * A root `.gitignore` does NOT filter what npm packs out of a directory named
 * in `files`: with `platform` allowlisted, an `md4c.o` left behind by the
 * vendor sync smoke test in platform/cpp/vendor/md4c/UPSTREAM.md ships to the
 * registry — an object built for one maintainer's machine, in a package whose
 * whole native contract is "the consumer compiles these sources". The
 * `files` negations exist to stop that; this is what proves they still work,
 * since the tarball is the only place the two rulesets meet.
 */
const BUILD_ARTIFACT_EXTENSIONS = new Set(['.o', '.a', '.so', '.dylib', '.obj', '.lib', '.node']);

const checkNoBuildArtifacts = (pkgDir) => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (BUILD_ARTIFACT_EXTENSIONS.has(path.extname(entry.name))) {
        fail(
          `build artifact: ${path.relative(pkgDir, full)} is a compiled object, not source, ` +
            'and it is in the tarball. The root .gitignore does not apply inside a directory ' +
            'listed in "files" — the "!**/*.o" / "!**/*.a" negations there are what excludes it.',
        );
      }
    }
  };
  walk(pkgDir);
};

try {
  console.log('[verify-pack] packing (runs prepare, i.e. the build)…');
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

  const loadEntries = (entries) => {
    for (const [relative, exported] of entries) {
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
  };
  // Order matters: the Node-safe entries load before any peer exists, which
  // is what proves they need none; only then is `react` linked in for the
  // entries that legitimately import it.
  loadEntries(NODE_SAFE_ENTRIES);
  linkPeers(pkgDir);
  loadEntries(PEER_DEPENDENT_ENTRIES);

  checkCodegenSpec(pkgDir, manifest);
  checkRequireGraph(pkgDir, manifest);
  checkExportsResolution(pkgDir, manifest);
  checkNoBuildArtifacts(pkgDir);

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
