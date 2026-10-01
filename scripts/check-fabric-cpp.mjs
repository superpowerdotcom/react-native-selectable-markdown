#!/usr/bin/env node
// Compiles Fabric C++ (shadow node / component descriptor) code against the
// real React Native headers in node_modules, on a plain dev machine.
//
// Why this exists
// ---------------
// Fabric shadow node code is the one part of this package that no jest test
// and no `tsc --noEmit` can reach. Until now it could only be *reviewed*, not
// verified: the moment a translation unit includes
// `react/renderer/core/ShadowNode.h` the compile dies on `folly/dynamic.h`,
// because folly, glog, fmt and double-conversion reach an app through
// CocoaPods, and this repo has no example app and no `Pods/` directory.
//
// So this script builds the missing half of the include path itself. It reads
// the versions React Native actually pins (see `readPins()` — they come out of
// `scripts/cocoapods/helpers.rb`, `third-party-podspecs/*.podspec` and Gradle's
// version catalogue, not out of a hardcoded table), downloads exactly those
// sources into a cache outside the repo, prepares them the same way the
// podspecs do, and then compiles.
//
// The other missing half is codegen's output. `Props.h` and `EventEmitters.h`
// for this component do not exist in this repository and never will — React
// Native generates them into the *consuming app's* build directory from
// src/view/SelectableRunHostNativeComponent.ts. `generateCodegen()` runs the
// same two CLIs the CocoaPods script phase and the Gradle task run, on every
// invocation, and puts the result on the include path. Without it the only
// thing this script could compile was its own built-in probe TU.
//
// Both platforms run by default, on a host that can check them. The shared C++
// in platform/fabric is compiled by two toolchains against two different React
// Native header sets, with real `#ifdef ANDROID` branches in RNSMRunHostState.h
// and BaseTraits(), and the Android pass additionally compiles the
// include-order substitution the CMake seam depends on
// (platform/fabric/android-include) — the highest-risk mechanism in the port,
// and the one whose failure mode is a document laid out at zero height with no
// build error anywhere. Each pass has one host requirement this script cannot
// download: the iOS pass needs an Apple SDK (RN's iOS renderer headers include
// <CoreGraphics/CoreGraphics.h>), the Android pass a JDK (they reach <jni.h>
// through fbjni). A platform this machine cannot check is skipped out loud in
// the default sweep, and is a hard failure when named with --platform.
//
// What "verified" means here
// --------------------------
// This is a real compile, not a syntax rinse:
//   * `-c` by default, so templates are instantiated and code is generated.
//     `ConcreteComponentDescriptor<YourShadowNode>` is a template — a descriptor
//     that cannot be instantiated is a link-time-shaped bug that only codegen
//     surfaces, so the default mode pays the cost to surface it.
//   * The headers are the installed React Native ones from node_modules, and the
//     third-party headers are the genuine upstream releases. Nothing is stubbed.
//     Stub headers would be worse than no check at all: they would let broken
//     code pass while reporting green.
//
// Because "it compiled" is only worth something if the checker can also fail,
// `--selftest` feeds the harness five deliberately broken translation units
// (unknown method, bad `override` signature, wrong arity, wrong return type,
// and a shadow node that drops its inherited constructors) and asserts each one
// is rejected. Run it whenever you touch this script or bump React Native. A
// checker that cannot fail is not a checker.
//
// Usage
//   node scripts/check-fabric-cpp.mjs                 # both platforms: repo sources + probe TUs
//   node scripts/check-fabric-cpp.mjs --selftest      # prove the checker rejects bad code
//   node scripts/check-fabric-cpp.mjs --platform android
//   node scripts/check-fabric-cpp.mjs --syntax-only   # faster, no codegen
//   node scripts/check-fabric-cpp.mjs --print-flags   # emit include flags for editors/CI
//   node scripts/check-fabric-cpp.mjs path/to/File.cpp [...]
//
// Environment
//   RNSM_FABRIC_CPP_CACHE  where third-party sources are unpacked
//                          (default: ~/.cache/react-native-selectable-markdown/...)
//   BOOST_INCLUDE_DIR      boost include root, if not in a standard location
//   RNSM_OFFLINE=1         fail instead of downloading anything

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rnRoot = path.join(repoRoot, 'node_modules', 'react-native');
const reactCommon = path.join(rnRoot, 'ReactCommon');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const positionals = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  return argv[i - 1] !== '--platform';
});

const SYNTAX_ONLY = hasFlag('--syntax-only');
const SELFTEST = hasFlag('--selftest');
const PRINT_FLAGS = hasFlag('--print-flags');
const VERBOSE = hasFlag('--verbose');
const PLATFORM = flagValue('--platform', 'ios');
const OFFLINE = process.env.RNSM_OFFLINE === '1';

const die = (message) => {
  console.error(`\n[check-fabric-cpp] ${message}`);
  process.exit(1);
};
// stderr, so `--print-flags` can be piped straight into a build system.
const log = (message) => console.error(`[check-fabric-cpp] ${message}`);

// ---------------------------------------------------------------------------
// 1. Read the versions React Native pins, from React Native itself.
// ---------------------------------------------------------------------------

// Hardcoding "folly 2024.01.01.00" would silently rot the day someone bumps
// react-native, and the compile would then be checking against the wrong ABI
// while still reporting green. Parsing the pins keeps the check honest: if RN
// moves, this moves with it, and if a pin can't be found we stop rather than
// guess.
function readPins() {
  const helpers = path.join(rnRoot, 'scripts', 'cocoapods', 'helpers.rb');
  if (!fs.existsSync(helpers)) {
    die(`cannot find ${helpers} — is react-native installed?`);
  }
  const rb = fs.readFileSync(helpers, 'utf8');

  const grab = (re, what, source) => {
    const m = re.exec(source);
    if (!m) die(`could not read ${what} out of React Native's build files`);
    return m[1];
  };

  const podspec = (name) =>
    fs.readFileSync(path.join(rnRoot, 'third-party-podspecs', `${name}.podspec`), 'utf8');
  const follyConfig = grab(/@@folly_config\s*=\s*\{([\s\S]*?)\n\s*\}/, 'the folly configuration', rb);
  const follyConfigFile = grab(/:config_file\s*=>\s*\[([\s\S]*?)\]/, 'the folly config header', follyConfig)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => grab(/^\s*['"](.*)['"],?\s*$/, 'a folly config header line', line))
    .join('\n');

  return {
    rnVersion: JSON.parse(fs.readFileSync(path.join(rnRoot, 'package.json'), 'utf8')).version,
    folly: grab(/:version\s*=>\s*'([^']+)'/, 'the folly version', follyConfig),
    follyConfigFile,
    // RN compiles folly with these and only these. Folly's headers are heavily
    // #if'd on them; compiling without them does not describe the real build.
    follyFlags: grab(/:compiler_flags\s*=>\s*'([^']+)'/, 'the folly compiler flags', follyConfig)
      .split(/\s+/)
      .filter(Boolean),
    cxxStandard: grab(/def self\.cxx_language_standard\s*\n\s*return "([^"]+)"/, 'the C++ standard', rb),
    fmt: grab(/spec\.version\s*=\s*"([^"]+)"/, 'the fmt version', podspec('fmt')),
    glog: grab(/spec\.version\s*=\s*'([^']+)'/, 'the glog version', podspec('glog')),
    doubleConversion: grab(
      /spec\.version\s*=\s*'([^']+)'/,
      'the DoubleConversion version',
      podspec('DoubleConversion'),
    ),
    boost: grab(/spec\.version\s*=\s*'([^']+)'/, 'the boost version', podspec('boost')),
    // fbjni is not a CocoaPods dependency, so it is not in helpers.rb — it is a
    // Maven artifact, pinned in Gradle's version catalogue. Read from there for
    // the same reason every pin above is read rather than typed: the Android
    // pass below compiles against fbjni's headers, and checking against the
    // wrong ones is exactly the kind of green run this script exists to avoid.
    fbjni: grab(
      /^fbjni\s*=\s*"([^"]+)"/m,
      'the fbjni version',
      fs.readFileSync(path.join(rnRoot, 'gradle', 'libs.versions.toml'), 'utf8'),
    ),
  };
}

const pins = readPins();

// ---------------------------------------------------------------------------
// 2. Fetch and prepare the third-party sources.
// ---------------------------------------------------------------------------

const cacheRoot =
  process.env.RNSM_FABRIC_CPP_CACHE ||
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'react-native-selectable-markdown',
    'fabric-cpp',
    `rn-${pins.rnVersion}`,
  );

// Deliberately outside the repo and outside node_modules: these are build
// inputs for a local check, not sources, and they must never end up in a
// commit or in a published tarball.
const depsDir = path.join(cacheRoot, 'deps');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
};

// codeload.github.com hands out transient 5xx often enough that a first-run
// setup fails on it maybe one time in five, which would look like "this check
// is broken" rather than "GitHub hiccuped". Retry, then fail loudly — never
// carry on with a half-downloaded dependency.
function download(url, dest) {
  if (fs.existsSync(dest)) return;
  if (OFFLINE) die(`RNSM_OFFLINE=1 but ${path.basename(dest)} is not cached yet`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // github.com/<o>/<r>/archive/... is a redirect to codeload; hitting codeload
  // directly is a different edge path and sometimes succeeds when the redirect
  // form is serving a cached 504, so alternate between them across attempts.
  const mirrors = [url];
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/(.+)$/.exec(url);
  if (m) mirrors.push(`https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${m[3].replace(/\.tar\.gz$/, '')}`);

  const attempts = 6;
  for (let i = 1; i <= attempts; i++) {
    const target = mirrors[(i - 1) % mirrors.length];
    log(`downloading ${target}${i > 1 ? ` (attempt ${i}/${attempts})` : ''}`);
    const r = run('curl', [
      '-sSL',
      '--fail',
      '--retry', '3',
      '--retry-connrefused',
      '--connect-timeout', '20',
      '-o', `${dest}.part`,
      target,
    ], { stdio: 'inherit' });
    if (r.status === 0) {
      fs.renameSync(`${dest}.part`, dest);
      return;
    }
    fs.rmSync(`${dest}.part`, { force: true });
    if (i < attempts) run('sleep', [String(i * 3)]);
  }
  die(`download failed after ${attempts} attempts: ${url}`);
}

function fetchAndExtract(name, url, expectedDir) {
  const target = path.join(depsDir, expectedDir);
  if (fs.existsSync(path.join(target, '.rnsm-ready'))) return target;
  const tarball = path.join(depsDir, 'tarballs', `${name}.tar.gz`);
  download(url, tarball);
  fs.mkdirSync(depsDir, { recursive: true });
  log(`extracting ${name}`);
  const r = run('tar', ['xzf', tarball, '-C', depsDir]);
  if (r.status !== 0) die(`extract failed for ${name}: ${r.stderr}`);
  if (!fs.existsSync(target)) die(`expected ${target} after extracting ${name}`);
  return target;
}

// glog 0.3.5 ships `src/glog/logging.h.in`, not `logging.h`. The real header is
// produced by glog's own ./configure. RN drives exactly this in
// scripts/ios-configure-glog.sh, including the arm64 config.sub patch and the
// gflags opt-out, so we replicate that rather than hand-writing a header —
// a hand-written glog/logging.h would be a stub, and stubs make this check lie.
function prepareGlog(dir) {
  const marker = path.join(dir, '.rnsm-ready');
  if (fs.existsSync(marker)) return;

  const configSub = path.join(dir, 'config.sub');
  let sub = fs.readFileSync(configSub, 'utf8');
  if (!sub.includes('arm64-*)')) {
    sub = sub.replace(
      '\tnone)\n\t\tbasic_machine=none-none\n',
      "\tarm64-*)\n\t\tbasic_machine=$(echo $basic_machine | sed 's/arm64/aarch64/')\n\t\t;;\n\tnone)\n\t\tbasic_machine=none-none\n",
    );
    fs.writeFileSync(configSub, sub);
  }

  const loggingIn = path.join(dir, 'src', 'glog', 'logging.h.in');
  fs.writeFileSync(
    loggingIn,
    fs.readFileSync(loggingIn, 'utf8').replaceAll('@ac_cv_have_libgflags@', '0'),
  );
  const configIn = path.join(dir, 'src', 'config.h.in');
  fs.writeFileSync(
    configIn,
    fs.readFileSync(configIn, 'utf8').replaceAll('HAVE_LIB_GFLAGS', 'HAVE_LIB_GFLAGS_DISABLED'),
  );

  log('configuring glog (generates src/glog/logging.h)');
  let r = run('./configure', ['--host', 'arm-apple-darwin'], { cwd: dir });
  if (r.status !== 0) r = run('./configure', [], { cwd: dir });
  if (r.status !== 0) {
    die(`glog ./configure failed; cannot produce a real glog/logging.h\n${r.stderr?.slice(-2000)}`);
  }
  if (!fs.existsSync(path.join(dir, 'src', 'glog', 'logging.h'))) {
    die('glog configure ran but did not produce src/glog/logging.h');
  }
  fs.writeFileSync(marker, '');
}

// DoubleConversion is included as <double-conversion/foo.h>, but the tarball
// puts the headers in src/. The podspec's prepare_command is `mv src
// double-conversion`; same move here.
function prepareDoubleConversion(dir) {
  const marker = path.join(dir, '.rnsm-ready');
  if (fs.existsSync(marker)) return;
  const src = path.join(dir, 'src');
  const dst = path.join(dir, 'double-conversion');
  if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
  fs.writeFileSync(marker, '');
}

function findBoost() {
  const candidates = [
    process.env.BOOST_INCLUDE_DIR,
    '/opt/homebrew/include',
    '/usr/local/include',
    '/usr/include',
  ].filter(Boolean);
  for (const dir of candidates) {
    const version = path.join(dir, 'boost', 'version.hpp');
    if (!fs.existsSync(version)) continue;
    const m = /#define BOOST_LIB_VERSION "([^"]+)"/.exec(fs.readFileSync(version, 'utf8'));
    return { dir, version: m ? m[1].replace(/_/g, '.') : 'unknown' };
  }
  die(
    'no boost headers found. Install with `brew install boost`, or set BOOST_INCLUDE_DIR.\n' +
      `React Native pins boost ${pins.boost}.`,
  );
}

// The two inputs the Android pass needs and the iOS pass does not, fetched
// lazily so an iOS-only run downloads nothing extra.
//
// WHY AN ANDROID PASS NEEDS JNI HEADERS WHEN NOTHING SHARED CONTAINS JNI:
// react/renderer/graphics/platform/android/react/renderer/graphics/
// PlatformColorParser.h includes <fbjni/fbjni.h>, graphicsConversions.h
// includes PlatformColorParser.h, and propsConversions.h includes that — so
// every translation unit that sees the generated Props.h sees fbjni, which
// sees jni.h. That is a property of React Native's Android header set rather
// than of anything this package wrote, and it is precisely why the Android
// pass is worth running: it is the only thing here that compiles the shared
// shadow node the way an app's NDK build will, including the `#ifdef ANDROID`
// branches in RNSMRunHostState.h and RNSMRunHostShadowNode::BaseTraits.
function ensureFbjni() {
  const dir = fetchAndExtract(
    'fbjni',
    `https://github.com/facebookincubator/fbjni/archive/refs/tags/v${pins.fbjni}.tar.gz`,
    `fbjni-${pins.fbjni}`,
  );
  const marker = path.join(dir, '.rnsm-ready');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
  return path.join(dir, 'cxx');
}

// jni.h ships with whatever JDK is installed, not with anything this script can
// download, so this returns null rather than dying when there is none — the
// Android pass is then skipped out loud. Killing an otherwise-green run on a
// machine with no JDK would push people towards not running the check at all.
//
// Probed once and cached: both the skip decision (platformSkipReason) and the
// include path (platformIncludeDirs) ask, the answer cannot change mid-run,
// and the probe spawns /usr/libexec/java_home on macOS.
let jniHeadersProbe;
function findJniHeaders() {
  if (jniHeadersProbe === undefined) jniHeadersProbe = probeJniHeaders();
  return jniHeadersProbe;
}

function probeJniHeaders() {
  const homes = [process.env.JAVA_HOME].filter(Boolean);
  // macOS only; on Linux JAVA_HOME or a distro path is the route in.
  const javaHomeTool = '/usr/libexec/java_home';
  if (fs.existsSync(javaHomeTool)) {
    const r = run(javaHomeTool, []);
    if (r.status === 0) homes.push(r.stdout.trim());
  }
  homes.push('/usr/lib/jvm/default-java', '/usr/lib/jvm/java-17-openjdk-amd64');

  for (const home of homes) {
    const include = path.join(home, 'include');
    if (!fs.existsSync(path.join(include, 'jni.h'))) continue;
    // jni.h does `#include "jni_md.h"`, and jni_md.h lives in a per-OS
    // subdirectory that is not on the path by default.
    const md = ['darwin', 'linux'].map((name) => path.join(include, name))
      .find((dir) => fs.existsSync(path.join(dir, 'jni_md.h')));
    return md ? [include, md] : [include];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2b. Generate the codegen headers the repo's Fabric sources compile against.
// ---------------------------------------------------------------------------

// react/renderer/components/SelectableMarkdownSpec/{Props,EventEmitters}.h do
// not exist in this repository and never will: React Native generates them into
// the *consuming app's* build directory, from src/view/SelectableRunHostNativeComponent.ts,
// during `pod install` and during the Gradle codegen task. Without them the
// only Fabric C++ this script could compile is the built-in probe TU — which is
// how the shared shadow node, the component descriptor and the Android alias
// headers went unchecked while this script reported "all checks passed".
//
// So run the same two CLIs the real builds run, into the cache, on every run.
// Regenerating rather than caching is deliberate: the generated headers are a
// pure function of the spec file, and a stale copy would let a spec change that
// breaks the C++ pass while reporting green — the one failure this whole script
// exists to make loud. `scripts/check-codegen.mjs` is what asserts the *content*
// of that output; this only needs it to exist and be current.
function generateCodegen(platform) {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).codegenConfig;
  if (!config?.name || !config?.jsSrcsDir) {
    die('package.json has no codegenConfig.name / jsSrcsDir to generate from');
  }

  const combineCli = path.join(
    repoRoot,
    'node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js',
  );
  const generateCli = path.join(repoRoot, 'node_modules/react-native/scripts/generate-specs-cli.js');
  for (const cli of [combineCli, generateCli]) {
    if (!fs.existsSync(cli)) {
      die(
        `cannot find ${path.relative(repoRoot, cli)} — React Native moved a codegen entry ` +
          'point. scripts/check-codegen.mjs invokes the same two by path and will need the ' +
          'same fix.',
      );
    }
  }

  const outRoot = path.join(cacheRoot, 'codegen');
  const schemaPath = path.join(outRoot, 'schema.json');
  const outDir = path.join(outRoot, platform);
  fs.mkdirSync(outRoot, { recursive: true });
  fs.rmSync(outDir, { recursive: true, force: true });

  const node = (args, what) => {
    const r = run(process.execPath, args, { cwd: repoRoot });
    if (r.status !== 0) die(`${what} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  };

  node([combineCli, schemaPath, path.join(repoRoot, config.jsSrcsDir)], 'combine-js-to-schema-cli.js');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (Object.keys(schema.modules ?? {}).length === 0) {
    die(
      'codegen produced an empty schema, so there are no generated headers to compile ' +
        'against. combine-js-to-schema exits 0 when it finds no spec; check:codegen explains ' +
        'the two conditions a spec file has to meet.',
    );
  }

  node(
    [
      generateCli,
      '--platform', platform,
      '--schemaPath', schemaPath,
      '--outputDir', outDir,
      '--libraryName', config.name,
      ...(platform === 'ios' ? ['--libraryType', config.type] : []),
      ...(platform === 'android' ? ['--javaPackageName', config.android.javaPackageName] : []),
    ],
    `generate-specs-cli.js --platform ${platform}`,
  );

  // The two platforms put the C++ under different roots — iOS at the output
  // directory itself, Android one level down under jni/ — which is exactly what
  // the CocoaPods script phase and the Gradle task then put on the include path.
  const includeDir = platform === 'android' ? path.join(outDir, 'jni') : outDir;
  const props = path.join(includeDir, 'react/renderer/components', config.name, 'Props.h');
  if (!fs.existsSync(props)) die(`codegen ran but did not produce ${props}`);
  return includeDir;
}

function ensureDeps() {
  fs.mkdirSync(depsDir, { recursive: true });

  const folly = fetchAndExtract(
    'folly',
    `https://github.com/facebook/folly/archive/refs/tags/v${pins.folly}.tar.gz`,
    `folly-${pins.folly}`,
  );
  const fmt = fetchAndExtract(
    'fmt',
    `https://github.com/fmtlib/fmt/archive/refs/tags/${pins.fmt}.tar.gz`,
    `fmt-${pins.fmt}`,
  );
  fs.writeFileSync(path.join(folly, 'folly', 'folly-config.h'), `${pins.follyConfigFile}\n`);
  const glog = fetchAndExtract(
    'glog',
    `https://github.com/google/glog/archive/refs/tags/v${pins.glog}.tar.gz`,
    `glog-${pins.glog}`,
  );
  const dc = fetchAndExtract(
    'double-conversion',
    `https://github.com/google/double-conversion/archive/refs/tags/v${pins.doubleConversion}.tar.gz`,
    `double-conversion-${pins.doubleConversion}`,
  );

  prepareGlog(glog);
  prepareDoubleConversion(dc);
  for (const d of [folly, fmt]) {
    const marker = path.join(d, '.rnsm-ready');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
  }

  return { folly, fmt, glog, dc, boost: findBoost() };
}

// ---------------------------------------------------------------------------
// 3. Build the include path.
// ---------------------------------------------------------------------------

// React Native's renderer has per-platform header roots that shadow each other
// (three different HostPlatformColor.h, three different TextLayoutManager.h).
// Which set iOS uses is not a guess — it is spelled out in
// ReactCommon/React-FabricComponents.podspec (HEADER_SEARCH_PATHS around line
// 41 and the framework paths around line 87). Note that `view` uses the `cxx`
// variant on iOS: there is no components/view/platform/ios directory at all.
const PLATFORM_ROOTS = {
  ios: [
    'react/renderer/graphics/platform/ios',
    'react/renderer/textlayoutmanager/platform/ios',
    'react/renderer/components/textinput/platform/ios',
    'react/renderer/components/view/platform/cxx',
    'react/renderer/components/text/platform/cxx',
    'react/renderer/imagemanager/platform/ios',
  ],
  android: [
    'react/renderer/graphics/platform/android',
    'react/renderer/textlayoutmanager/platform/android',
    'react/renderer/components/textinput/platform/android',
    'react/renderer/components/view/platform/android',
    'react/renderer/components/text/platform/android',
    'react/renderer/imagemanager/platform/cxx',
  ],
};

// `extraDirs` go FIRST, and on Android that ordering is the thing being
// checked rather than a convenience. platform/fabric/android-include holds
// alias headers sitting at codegen's own generated paths, and the app's build
// puts them ahead of the generated ones (`target_include_directories(...
// BEFORE ...)` in android/src/main/jni/CMakeLists.txt) so that the descriptor
// the app registers is the measuring one. Compiling with any other order here
// would prove the seam works in a configuration no app ever uses.
function includeFlags(deps, platform, extraDirs = []) {
  const roots = PLATFORM_ROOTS[platform];
  if (!roots) die(`unknown --platform ${platform} (expected ios or android)`);
  const dirs = [
    ...extraDirs,
    reactCommon,
    path.join(reactCommon, 'jsi'),
    path.join(reactCommon, 'yoga'),
    ...roots.map((r) => path.join(reactCommon, r)),
    deps.folly,
    deps.dc,
    path.join(deps.fmt, 'include'),
    path.join(deps.glog, 'src'),
    deps.boost.dir,
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) die(`include root does not exist: ${d}`);
  }
  return dirs.flatMap((d) => ['-I', d]);
}

function compileArgs(deps, platform, extraDirs = []) {
  return [
    // c++20 is not a preference at RN 0.75.4, it is required: react/utils/
    // hash_combine.h:16 declares a `concept`. RN itself pins this via
    // Helpers::Constants.cxx_language_standard.
    `-std=${pins.cxxStandard}`,
    '-fexceptions',
    '-frtti',
    ...pins.follyFlags,
    ...(platform === 'android' ? ['-DANDROID', '-DRN_SERIALIZABLE_STATE'] : []),
    '-DLOG_TAG="Fabric"',
    // Newer Apple clang than RN's CI warns on folly/fmt's `operator"" _sp`
    // spelling. That is upstream noise, not a signal about our code.
    '-Wno-deprecated-literal-operator',
    '-Wno-documentation',
    // react/renderer/core/graphicsConversions.h calls std::format without
    // including <format>. libc++ (the NDK, Apple) pulls it in transitively;
    // Linux libstdc++ does not, so every TU reaching propsConversions.h fails
    // there. Force-including it reproduces what the real toolchains see.
    ...(process.platform === 'linux' ? ['-include', 'format'] : []),
    ...includeFlags(deps, platform, extraDirs),
  ];
}

// ---------------------------------------------------------------------------
// 4. Translation units to compile.
// ---------------------------------------------------------------------------

// A Fabric shadow node shaped like the one this package needs, compiled even
// when the repo has no Fabric sources yet — so a green run always means "the
// RN Fabric headers really do compile here" rather than "there was nothing to
// check". It covers the four headers the Fabric work depends on and mirrors the
// real structure: a ConcreteViewShadowNode subclass that also inherits
// BaseTextShadowNode, measures through TextLayoutManager, and is wrapped in a
// ConcreteComponentDescriptor. It doubles as the self-test baseline below.
//
// The last line is the load-bearing one. `static_assert(sizeof(Descriptor) > 0)`
// looks like it exercises the descriptor, and does not: requiring a complete
// type instantiates only the class layout, never the member function bodies.
// Measured on this TU, the sizeof form emits 0 descriptor symbols and a 95KB
// object; the explicit instantiation emits 56 and 390KB. Concretely, a shadow
// node that forgets `using ConcreteViewShadowNode::ConcreteViewShadowNode;` —
// so the descriptor's createShadowNode() cannot construct it — compiles clean
// under the sizeof form and is rejected under this one. `--selftest` keeps that
// honest: mutation 5 is exactly that bug.
const FABRIC_TU = `
#include <react/renderer/attributedstring/AttributedString.h>
#include <react/renderer/attributedstring/AttributedStringBox.h>
#include <react/renderer/components/text/BaseTextShadowNode.h>
#include <react/renderer/components/text/ParagraphShadowNode.h>
#include <react/renderer/components/text/ParagraphState.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/components/view/ViewEventEmitter.h>
#include <react/renderer/components/view/ViewProps.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>

namespace facebook::react {

static_assert(sizeof(AttributedString) > 0);
static_assert(sizeof(ParagraphShadowNode) > 0);
static_assert(sizeof(TextLayoutManager) > 0);

extern const char FabricProbeComponentName[];
const char FabricProbeComponentName[] = "FabricProbe";

class FabricProbeShadowNode final
    : public ConcreteViewShadowNode<
          FabricProbeComponentName,
          ViewProps,
          ViewEventEmitter,
          ParagraphState>,
      public BaseTextShadowNode {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void setTextLayoutManager(
      std::shared_ptr<const TextLayoutManager> textLayoutManager) {
    textLayoutManager_ = std::move(textLayoutManager);
  }

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

 private:
  std::shared_ptr<const TextLayoutManager> textLayoutManager_;
};

Size FabricProbeShadowNode::measureContent(
    const LayoutContext& layoutContext,
    const LayoutConstraints& layoutConstraints) const {
  AttributedString attributedString;
  Attachments attachments;
  BaseTextShadowNode::buildAttributedString(
      TextAttributes{}, *this, attributedString, attachments);
  TextLayoutContext textLayoutContext{};
  textLayoutContext.pointScaleFactor = layoutContext.pointScaleFactor;
  return textLayoutManager_
      ->measure(
          AttributedStringBox{attributedString},
          ParagraphAttributes{},
          textLayoutContext,
          layoutConstraints)
      .size;
}

// Forces every member body of the descriptor template to be compiled.
template class ConcreteComponentDescriptor<FabricProbeShadowNode>;

} // namespace facebook::react
`;

// The real component descriptor, instantiated for real. Compiled on both
// platforms.
//
// RNSMRunHostShadowNode.cpp never names RNSMRunHostComponentDescriptor, so
// without this translation unit the descriptor header is not compiled at all —
// and the descriptor is the piece whose defects are template-shaped.
// `ConcreteComponentDescriptor::createShadowNode()` calls
// `std::make_shared<RNSMRunHostShadowNode>(...)` from a member body that is
// only compiled when something instantiates it, so a shadow node that dropped
// its inherited constructors, or a descriptor whose `adopt()` no longer matches
// the base signature, passes every other check here and fails in an app's
// build. Building a provider rather than only writing an explicit
// instantiation is deliberate: `concreteComponentDescriptorProvider<T>()` is
// exactly what both platforms' registration writes, and it forces the *derived*
// constructor and vtable — hence `adopt()` and the measurer wiring — to be
// emitted, which a `template class` on the base alone does not.
const DESCRIPTOR_TU = `
#include "RNSMRunHostComponentDescriptor.h"

#include <react/renderer/componentregistry/ComponentDescriptorProvider.h>

namespace facebook::react {

template class ConcreteComponentDescriptor<RNSMRunHostShadowNode>;

ComponentDescriptorProvider rnsmProbeComponentDescriptorProvider() {
  return concreteComponentDescriptorProvider<RNSMRunHostComponentDescriptor>();
}

} // namespace facebook::react
`;

// The Android seam, compiled the way an app compiles it. Android only.
//
// This is the highest-risk mechanism in the whole port (docs/FABRIC-PLAN.md §9,
// risk 2) and until now nothing executed it. The app's generated
// autolinking.cpp writes these two lines verbatim, and whether they register a
// measuring descriptor or codegen's zero-height one depends entirely on
// platform/fabric/android-include being ahead of the generated headers on the
// include path — which is what this TU is compiled with.
//
// The static_asserts are the part that could not be checked any other way. The
// registration line compiles fine against codegen's own headers; it just
// registers the wrong type, and the symptom is a document laid out at zero
// height with no build error anywhere. Asserting the identity turns "the
// substitution silently stopped happening" into a compile failure here.
const ANDROID_ALIAS_TU = `
#include <type_traits>

#include <react/renderer/components/SelectableMarkdownSpec/ComponentDescriptors.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

#include "RNSMRunHostComponentDescriptor.h"
#include "RNSMRunHostShadowNode.h"

namespace facebook::react {

static_assert(
    std::is_same_v<SelectableRunHostShadowNode, RNSMRunHostShadowNode>,
    "platform/fabric/android-include is not winning the include race: codegen's "
    "non-measurable ShadowNodes.h resolved first, so every run would lay out at "
    "zero height. See android/src/main/jni/CMakeLists.txt.");
static_assert(
    std::is_same_v<SelectableRunHostComponentDescriptor, RNSMRunHostComponentDescriptor>,
    "the descriptor alias no longer binds to ours, so the app would register "
    "codegen's descriptor and no run would ever be measured.");

void rnsmProbeRegisterComponents(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry) {
  registry->add(concreteComponentDescriptorProvider<SelectableRunHostComponentDescriptor>());
}

} // namespace facebook::react
`;

// EVERY NATIVE SOURCE FILE THIS PACKAGE SHIPS, CLASSIFIED — one entry per file,
// no file left out. This function replaced two independent walkers (one that
// collected the .cpp to compile, one that collected the .mm to name as skipped)
// and it exists because that pair had a hole between them that nothing could
// see: both walkers started at `platform/`, so when the Android Fabric
// measurer landed at android/src/main/jni/RNSMRunTextMeasurer.cpp — outside
// that tree — it was compiled by neither and reported by neither. It is the
// only C++ in this package that binds an fbjni method id by hand
// (`getMethod<jlong(jint, jstring, ReadableMap::javaobject × 3, jfloat × 4)>`),
// i.e. the file where a stale React Native signature is *least* visible to a
// human reader, and the gate said "18 TUs across 2 platforms" while never
// opening it. A file that is neither compiled nor reported as skipped is the
// one state this script must never produce, so the two lists are now derived
// from one traversal and main() asserts their union is the whole set.
//
// Directory rules, in order:
//
//   * platform/fabric IS THE FABRIC TREE AND IS TAKEN WHOLE, not filtered.
//     The text-match rule below reads each file's own source for
//     "react/renderer/", and that is not the same question:
//     RNSMRunHostShadowNode.cpp includes only "RNSMRunHostShadowNode.h" and
//     <react/debug/react_native_assert.h>, so it never mentions the string —
//     and the single most important file in the port was therefore silently
//     never compiled while this script printed "no repo .cpp includes
//     react/renderer/ yet" and passed. A directory whose entire purpose is
//     Fabric C++ does not need to prove it file by file.
//
//   * android/src/main/jni is Fabric C++ too, but it is ANDROID-ONLY: it
//     includes <fbjni/fbjni.h> and <react/jni/ReadableNativeMap.h>, which
//     exist only in React Native's Android header set. Compiling it on the iOS
//     pass would report a missing-header failure that says nothing about the
//     code.
//
//   * platform/cpp also holds the md4c markdown engine and its JSI binding,
//     which are the parser, not the view layer, and must not be dragged into
//     the Fabric pass. So files outside those two directories are selected by
//     what they include, not by directory — and the ones that opt out are
//     still *named*, with the command that does check them.
//
//   * `.mm`/`.m` are skipped on purpose, and this is the honest boundary of
//     what this script can verify. The Fabric mounting layer (an
//     RCTViewComponentView subclass) imports UIKit and
//     `React/RCTViewComponentView.h`, which come from the iOS SDK and from
//     CocoaPods respectively — neither is reachable from a macOS host compile.
//     The cross-platform C++ half (shadow node, props, state, component
//     descriptor) is what this check covers; the Objective-C half still needs
//     Xcode with Pods installed. Silently failing on a `.mm` would read as
//     "your code is broken" when the truth is "this harness cannot see that
//     file". They are listed unconditionally rather than by a text match,
//     because the previous text-match rule made RNSMTextKitStack.mm invisible
//     — the file holding `+measureAttributedString:width:pointScaleFactor:`,
//     the single function iOS measure/draw agreement rests on, which a reader
//     of a green run would otherwise assume had been checked.
const fabricDir = path.join(repoRoot, 'platform', 'fabric');
const androidJniDir = path.join(repoRoot, 'android', 'src', 'main', 'jni');
const engineDir = path.join(repoRoot, 'platform', 'cpp');

// The roots that hold native source shipped to a consumer's compiler. Adding a
// third native tree without adding it here is the mistake this list is meant to
// make impossible: main() dies when the classification is empty for a root that
// exists, so a new tree shows up as a failure rather than as silence.
const nativeRoots = [path.join(repoRoot, 'platform'), path.join(repoRoot, 'android')];

/**
 * @returns {{file: string, platforms: string[], skip: string|null}[]}
 *   `platforms` is the set of passes that compile the file; `skip` is the
 *   reason it is not compiled at all. Exactly one of the two is meaningful:
 *   `platforms` is empty iff `skip` is set.
 */
function classifyNativeSources() {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `build/` is Gradle output, not source: on a machine that has run a
        // Gradle build it holds thousands of generated .cpp, and compiling
        // them here would be checking React Native's codegen against itself.
        if (entry.name === 'build' || entry.name === 'node_modules') continue;
        walk(p);
        continue;
      }
      if (/\.(mm|m)$/.test(entry.name)) {
        found.push({ file: p, platforms: [], skip: 'Objective-C/C++ needs Xcode + Pods' });
      } else if (/\.(cpp|cc)$/.test(entry.name)) {
        if (dir === androidJniDir) {
          found.push({ file: p, platforms: ['android'], skip: null });
        } else if (dir === fabricDir || fs.readFileSync(p, 'utf8').includes('react/renderer/')) {
          found.push({ file: p, platforms: ['ios', 'android'], skip: null });
        } else if (p.startsWith(engineDir + path.sep)) {
          found.push({
            file: p,
            platforms: [],
            skip:
              "the markdown engine, not the view layer — compiled at the podspec's C++ " +
              'standard by the gate ci.yml and release.yml run: ' +
              '`npm run check:fabric-cpp -- --syntax-only --platform <ios|android> ' +
              "$(find platform/cpp -path platform/cpp/vendor -prune -o -name '*.cpp' -print)`. " +
              '--platform is required because an explicit file list narrows this script to one ' +
              'pass; `find` rather than platform/cpp/*.cpp because that glob does not descend',
          });
        } else {
          found.push({
            file: p,
            platforms: [],
            skip:
              'reaches no react/renderer header — it goes into this package\'s own ' +
              'libselectable-markdown.so via android/CMakeLists.txt, not into the app\'s ' +
              'Fabric target, and needs the NDK rather than this harness',
          });
        }
      }
    }
  };
  for (const root of nativeRoots) walk(root);
  return found;
}

function discoverRepoSources(platform) {
  return classifyNativeSources()
    .filter((e) => e.platforms.includes(platform))
    .map((e) => e.file);
}

function compile(file, args, outDir) {
  const out = path.join(outDir, `${path.basename(file)}.o`);
  const mode = SYNTAX_ONLY ? ['-fsyntax-only'] : ['-c', '-o', out];
  const full = [...args, ...mode, file];
  if (VERBOSE) console.log(`clang++ ${full.join(' ')}`);
  const r = run('clang++', full);
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim(), out };
}

// ---------------------------------------------------------------------------
// 5. Self-test: prove the harness rejects broken code.
// ---------------------------------------------------------------------------

// A compile check that always says "ok" is indistinguishable from a compile
// check that works, right up until it matters. These mutations are the mistakes
// this harness exists to catch. Each must be rejected, and rejected for the
// stated reason — a mutation that fails for some unrelated cause is no longer
// testing what its name claims, which usually means an RN API moved.
//
// The baseline is FABRIC_TU itself, so the self-test proves the exact artifact
// the default run compiles.
const MUTATIONS = [
  {
    name: 'calls a method TextLayoutManager does not have',
    apply: (s) => s.replace('->measure(', '->measureTextYolo('),
    expect: /no member named 'measureTextYolo'/,
  },
  {
    name: 'override signature does not match the base class',
    apply: (s) =>
      s.replace(
        'const LayoutConstraints& layoutConstraints) const override;',
        'const LayoutConstraints& layoutConstraints) override;',
      ),
    expect: /marked 'override' hides virtual member function/,
  },
  {
    name: 'wrong arity on buildAttributedString',
    apply: (s) =>
      s.replace(
        'TextAttributes{}, *this, attributedString, attachments);',
        'TextAttributes{}, *this, attributedString);',
      ),
    expect: /too few arguments to function call, expected 4/,
  },
  {
    name: 'wrong return type out of measureContent',
    apply: (s) => s.replace('      .size;', '      .size.width;'),
    expect: /no viable conversion from returned value of type 'Float'/,
  },
  {
    // The reason FABRIC_TU ends in an explicit template instantiation rather
    // than a sizeof static_assert. Without the inherited constructors the
    // descriptor's createShadowNode() cannot build the node — a real Fabric
    // bug that a sizeof-based check compiles clean.
    name: 'shadow node drops inherited constructors (descriptor cannot build it)',
    apply: (s) => s.replace('  using ConcreteViewShadowNode::ConcreteViewShadowNode;\n', ''),
    expect: /no matching function for call to '__construct_at'|no matching constructor/,
  },
];

// FABRIC_TU knows nothing of the clone guard, so these mutate copies of platform/fabric.
// Only the tripwire is checkable: dropping our use of the guard still compiles clean.
const GUARD_SOURCE = 'RNSMRunHostShadowNode.cpp';

const SOURCE_MUTATIONS = [
  {
      // Renames what the probe looks for, since React Native's headers are not ours to edit.
    name: 'both clone-guard mechanisms gone from the base (tripwire must fire)',
    edits: [
      {
        file: 'RNSMRunHostShadowNode.h',
        find: 'requires(Node& node) { node.cleanLayout(); };',
        replace: 'requires(Node& node) { node.cleanLayoutRenamedUpstream(); };',
      },
      {
        file: 'RNSMRunHostShadowNode.h',
        find: 'node.Base::shouldNewRevisionDirtyMeasurement(sourceNode, cloneFragment);',
        replace:
          'node.Base::shouldNewRevisionDirtyMeasurementRenamedUpstream(sourceNode, cloneFragment);',
      },
    ],
    expect: /Neither cleanLayout\(\) nor shouldNewRevisionDirtyMeasurement\(\) is/,
  },
  {
    name: 'clone measurement override has an incompatible signature',
    edits: [
      {
        file: 'RNSMRunHostShadowNode.h',
        find: 'const ShadowNodeFragment& fragment) const override;',
        replace: 'const ShadowNodeFragment& fragment, bool extra) const override;',
      },
    ],
    expect: /marked 'override'/,
  },
];

/** Returns the first edit that matched nothing as `stale`, so no mutation tests an unmutated file. */
function mutateGuardSources(scratch, label, edits) {
  const dir = path.join(scratch, `selftest_src_${label}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(fabricDir)) {
    if (!/\.(h|cpp)$/.test(name)) continue;
    fs.copyFileSync(path.join(fabricDir, name), path.join(dir, name));
  }
  for (const edit of edits) {
    const file = path.join(dir, edit.file);
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(edit.find, edit.replace);
    if (after === before) return { dir, stale: edit };
    fs.writeFileSync(file, after);
  }
  return { dir, stale: null };
}

function selftestGuard(args, scratch) {
  let failures = 0;

  // A broken copy step would otherwise read as every mutation being caught.
  const baseline = mutateGuardSources(scratch, 'baseline', []);
  const base = compile(path.join(baseline.dir, GUARD_SOURCE), ['-I', baseline.dir, ...args], scratch);
  if (!base.ok) {
    console.error('  FAIL  baseline copy of platform/fabric did not compile');
    console.error(base.output);
    return 1;
  }
  console.log('  ok    baseline: unmutated copy of platform/fabric compiles');

  for (const m of SOURCE_MUTATIONS) {
    const { dir, stale } = mutateGuardSources(scratch, String(SOURCE_MUTATIONS.indexOf(m)), m.edits);
    if (stale) {
      console.error(`  FAIL  mutation "${m.name}" changed nothing`);
      console.error(`        ${stale.file} no longer contains: ${stale.find}`);
      failures++;
      continue;
    }
    const r = compile(path.join(dir, GUARD_SOURCE), ['-I', dir, ...args], scratch);
    if (r.ok) {
      console.error(`  FAIL  broken code COMPILED: ${m.name}`);
      failures++;
    } else if (!m.expect.test(r.output)) {
      console.error(`  FAIL  rejected for the wrong reason: ${m.name}`);
      console.error(`        expected ${m.expect}`);
      console.error(r.output.split('\n').slice(0, 4).join('\n'));
      failures++;
    } else {
      console.log(`  ok    rejected: ${m.name}`);
    }
  }
  return failures;
}

function selftest(args, scratch) {
  let failures = 0;

  const baseline = path.join(scratch, 'selftest_baseline.cpp');
  fs.writeFileSync(baseline, FABRIC_TU);
  const base = compile(baseline, args, scratch);
  if (!base.ok) {
    console.error('  FAIL  baseline realistic shadow node did not compile');
    console.error(base.output);
    return 1;
  }
  console.log('  ok    baseline: realistic shadow node + component descriptor compiles');

  for (const m of MUTATIONS) {
    const mutated = m.apply(FABRIC_TU);
    if (mutated === FABRIC_TU) {
      console.error(`  FAIL  mutation "${m.name}" did not change the source`);
      failures++;
      continue;
    }
    const file = path.join(scratch, `selftest_${MUTATIONS.indexOf(m)}.cpp`);
    fs.writeFileSync(file, mutated);
    const r = compile(file, args, scratch);
    if (r.ok) {
      console.error(`  FAIL  broken code COMPILED: ${m.name}`);
      failures++;
    } else if (!m.expect.test(r.output)) {
      // Rejected, but not for the reason we claimed. That means the mutation is
      // no longer testing what it says it tests — usually an RN API change.
      console.error(`  FAIL  rejected for the wrong reason: ${m.name}`);
      console.error(`        expected ${m.expect}`);
      console.error(r.output.split('\n').slice(0, 4).join('\n'));
      failures++;
    } else {
      console.log(`  ok    rejected: ${m.name}`);
    }
  }
  return failures + selftestGuard(args, scratch);
}

// ---------------------------------------------------------------------------
// 6. Main.
// ---------------------------------------------------------------------------

if (!fs.existsSync(reactCommon)) {
  die(`${reactCommon} not found — run npm install first`);
}
if (run('clang++', ['--version']).status !== 0) {
  die('clang++ not found on PATH');
}

const deps = ensureDeps();

/**
 * Why `platform` cannot be checked on this machine, or null when it can be.
 * One function, so the skip decision and the skip message can never disagree.
 * Skipping rather than dying is the default-sweep behaviour for the same
 * reason findJniHeaders() returns null instead of dying: neither missing
 * ingredient is downloadable, and killing an otherwise-green run on a machine
 * that cannot have it pushes people towards not running the check at all. A
 * platform named with --platform is a different contract — main() dies there,
 * because skipping the only requested platform would print "all checks passed"
 * over a run that compiled nothing.
 */
function platformSkipReason(platform) {
  if (platform === 'ios' && process.platform !== 'darwin') {
    return (
      "React Native's iOS renderer headers need an Apple SDK — react/renderer/graphics/" +
      'platform/ios/.../Float.h includes <CoreGraphics/CoreGraphics.h>, which only ' +
      'Xcode or the macOS Command Line Tools provide. Run the iOS pass on macOS'
    );
  }
  if (platform === 'android' && !findJniHeaders()) {
    return (
      "no JDK found, and React Native's Android renderer headers reach <jni.h> through " +
      'fbjni. Set JAVA_HOME to check it'
    );
  }
  return null;
}

/**
 * The include roots a platform needs on top of the React Native ones, in the
 * order they have to be searched. Returns null when platformSkipReason() says
 * this machine cannot check the platform.
 */
function platformIncludeDirs(platform) {
  if (platformSkipReason(platform)) return null;
  const dirs = [];
  if (platform === 'android') {
    dirs.push(ensureFbjni(), ...findJniHeaders());
    // react/jni/ReadableNativeMap.h, for android/src/main/jni/RNSMRunTextMeasurer.cpp.
    // In a consumer's build this arrives as the `reactnativejni` prefab, which
    // publishes exactly this directory as its include root
    // (ReactAndroid/build.gradle.kts:278-283 maps src/main/jni/react/jni ->
    // react/jni/), so compiling against the source tree here is the same
    // header set the NDK build sees. It holds no react/renderer subtree, so it
    // cannot shadow the ReactCommon roots added below.
    dirs.push(path.join(rnRoot, 'ReactAndroid', 'src', 'main', 'jni'));
    // Ahead of the generated headers, because that is where the app's build
    // puts it and the substitution is the thing under test.
    dirs.push(path.join(fabricDir, 'android-include'));
  }
  // This package's own include roots, mirroring the two HEADER_SEARCH_PATHS
  // entries SelectableMarkdown.podspec declares for its own tree. They are here
  // so that the engine can be checked at the podspec's C++ standard with
  // `--syntax-only --platform <ios|android> <sources>`, which is what docs/FABRIC-PLAN.md §8
  // names as the proof that the c++17 -> c++20 bump is safe: without
  // platform/cpp/vendor/md4c on the path OffsetParser.cpp dies on <entity.h>,
  // and the documented command reported a failure that was the harness's, not
  // the engine's.
  //
  // generateCodegen() stays LAST because the caller reads the codegen root back
  // off the end of this list to find the generated sources to compile.
  dirs.push(
    path.join(repoRoot, 'platform', 'cpp'),
    path.join(repoRoot, 'platform', 'cpp', 'vendor', 'md4c'),
    fabricDir,
    generateCodegen(platform),
  );
  return dirs;
}

if (PRINT_FLAGS) {
  const extras = platformIncludeDirs(PLATFORM);
  if (!extras) die(`--platform ${PLATFORM}: ${platformSkipReason(PLATFORM)}`);
  console.log(compileArgs(deps, PLATFORM, extras).join(' '));
  process.exit(0);
}

// Both platforms by default, because the shared C++ is compiled by two
// toolchains with different header sets and different `#ifdef ANDROID`
// branches, and only checking one of them is how the other rots. An explicit
// `--platform`, or a list of files to compile, narrows it back to one.
//
// The self-test runs against a single platform's headers: it mutates the
// built-in probe TU, which is about React Native's own API surface rather than
// about anything platform-specific, and running it twice would only double the
// runtime. It prefers iOS and falls back to whatever this host can check, so a
// Linux CI runner still proves the checker can fail — against the Android
// header set, the same one its main run gates.
const EXPLICIT = hasFlag('--platform') || positionals.length > 0;
const PLATFORMS = SELFTEST
  ? [hasFlag('--platform')
      ? PLATFORM
      : (['ios', 'android'].find((p) => !platformSkipReason(p)) ?? 'ios')]
  : EXPLICIT
    ? [PLATFORM]
    : ['ios', 'android'];

log(`react-native ${pins.rnVersion} | platform ${PLATFORMS.join(', ')} | ${pins.cxxStandard}`);
log(
  `folly ${pins.folly}, fmt ${pins.fmt}, glog ${pins.glog}, ` +
    `double-conversion ${pins.doubleConversion}, boost ${deps.boost.version} (pinned ${pins.boost})`,
);
if (deps.boost.version !== pins.boost && deps.boost.version !== 'unknown') {
  // Worth saying out loud rather than hiding: a local boost that is newer than
  // RN's pin can compile code that CocoaPods would reject, or vice versa.
  log(`note: local boost ${deps.boost.version} differs from RN's pin ${pins.boost}`);
}
log(`mode: ${SYNTAX_ONLY ? '-fsyntax-only' : '-c (full codegen)'}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-fabric-cpp-'));
let failures = 0;

/** Writes one of the built-in translation units to the scratch dir. */
const writeTU = (name, source) => {
  const file = path.join(scratch, `${name}.cpp`);
  fs.writeFileSync(file, source);
  return file;
};

// Codegen's own generated sources, compiled unchanged — which is exactly what
// react_codegen_SelectableMarkdownSpec does with them. On Android they are
// compiled against our alias headers, so ShadowNodes.cpp's definition of
// `SelectableRunHostComponentName` has to stay compatible with the declaration
// in RNSMRunHostShadowNode.h, and ComponentDescriptors.cpp's registration line
// has to still name a type that exists. Both are link-time or runtime failures
// in a consuming app otherwise.
const GENERATED_SOURCES = [
  'ShadowNodes.cpp',
  'ComponentDescriptors.cpp',
  'States.cpp',
  'Props.cpp',
  'EventEmitters.cpp',
];

try {
  if (SELFTEST) {
    const extras = platformIncludeDirs(PLATFORMS[0]);
    if (!extras) die(`--selftest: ${platformSkipReason(PLATFORMS[0])}`);
    console.log(`\nself-test (${PLATFORMS[0]} headers) — the checker must reject broken code:`);
    failures += selftest(compileArgs(deps, PLATFORMS[0], extras), scratch);
  } else {
    let checkedPlatforms = 0;
    for (const platform of PLATFORMS) {
      const extras = platformIncludeDirs(platform);
      if (!extras) {
        if (EXPLICIT) die(`--platform ${platform}: ${platformSkipReason(platform)}`);
        log(`skipped platform ${platform} — ${platformSkipReason(platform)}`);
        continue;
      }
      checkedPlatforms += 1;
      const args = compileArgs(deps, platform, extras);
      const codegenDir = extras[extras.length - 1];

      const files = [];
      if (positionals.length) {
        files.push(...positionals.map((p) => path.resolve(p)));
      } else {
        files.push(writeTU('probe', FABRIC_TU));
        files.push(...discoverRepoSources(platform));
        files.push(writeTU('descriptor_probe', DESCRIPTOR_TU));
        if (platform === 'android') {
          files.push(writeTU('android_alias_probe', ANDROID_ALIAS_TU));
        }
        files.push(
          ...GENERATED_SOURCES.map((name) =>
            path.join(codegenDir, 'react/renderer/components/SelectableMarkdownSpec', name),
          ),
        );
      }

      console.log(`\n${platform}:`);
      for (const file of files) {
        const label = file.startsWith(scratch)
          ? `<${path.basename(file, '.cpp')} TU>`
          : file.startsWith(cacheRoot)
            ? `<codegen> ${path.basename(file)}`
            : path.relative(repoRoot, file);
        const r = compile(file, args, scratch);
        if (r.ok) {
          console.log(`  ok    ${label}`);
          if (r.output && VERBOSE) console.log(r.output);
        } else {
          console.error(`  FAIL  ${label}`);
          console.error(r.output);
          failures++;
        }
      }

      if (!positionals.length) {
        // Both directories are taken whole, so an empty list can only mean one
        // of them is gone — which would make every "ok" above a statement about
        // the built-in probes and nothing else. Asserted per platform because
        // android/src/main/jni is compiled on exactly one of the two passes and
        // losing it would otherwise read as a normal iOS run.
        const compiledDirs = new Set(discoverRepoSources(platform).map((f) => path.dirname(f)));
        const required = platform === 'android' ? [fabricDir, androidJniDir] : [fabricDir];
        for (const dir of required) {
          if (!compiledDirs.has(dir)) {
            die(
              `${path.relative(repoRoot, dir)} contributed no .cpp to the ${platform} pass — ` +
                'those sources have moved or been lost, and this run proved nothing about them',
            );
          }
        }
      }
    }

    // Skips above are per-platform and tolerable; all of them skipping is not.
    // Without this, a Linux machine with no JDK would print "all checks
    // passed" having compiled zero translation units.
    if (!checkedPlatforms) {
      die('every platform was skipped — this run compiled nothing (the reasons are above)');
    }

    if (!positionals.length) {
      // Say what was not checked, from the same classification that decided
      // what *was* — so the two can never disagree. A green run that quietly
      // skipped the mounting layer would overstate its own coverage, and the
      // way that happened before was a second, independently-written walker
      // whose filter did not match this one's.
      for (const entry of classifyNativeSources()) {
        if (entry.skip) log(`skipped ${path.relative(repoRoot, entry.file)} — ${entry.skip}`);
      }
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures) {
  die(`${failures} failure(s)`);
}
log('all checks passed');
