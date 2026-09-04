#!/usr/bin/env node
// Type-checks this package's Swift against React Native's real headers and the
// real iOS SDK.
//
// Why this exists
// ---------------
// Nothing else in this repository compiles a line of Swift, and the Swift is
// not decoration: platform/ios/SelectableRunHostView.swift is the selection
// host — the UITextView, the save/swap/restore-clamped selection preservation,
// the edit menu, the clamped event emission — and it is architecture-neutral,
// so it is unconditionally in the podspec's `source_files` and every consumer
// compiles it on both architectures.
//
// The port shipped it with four compile errors. All four were in the class no
// human review catches, because they are not about logic at all — they are
// about how Swift *imports* Objective-C:
//
//   * `didSetProps` is declared by React Native as a category on UIView
//     (React/Views/UIView+React.h:78) and reaches Swift through React-Core's
//     umbrella header, so redeclaring it without `override` is an error.
//   * `+makeTextContainerWithSize:` imports as `makeTextContainer(with:)`,
//     because omit-needless-words drops `Size` when the parameter is a CGSize.
//   * `-setIntrinsicContentSize:forView:` imports as
//     `setIntrinsicContentSize(_:for:)` for the same reason.
//   * `NSArray` does not implicitly convert to `[Any]`.
//
// Every one of those is a hard failure in a consumer's `xcodebuild`, in a file
// they did not write, on the very first `pod install && build` — and this
// package has no example app, so the first person to find out was going to be
// a stranger. Type-checking is cheap, the SDK is on any machine with Xcode,
// and it turns "reviewed" into "compiled" for the largest reviewed-only surface
// in the package.
//
// Those four are HISTORY, not the current self-test. The Swift has been
// rewritten since and none of those four call sites survives, so `--selftest`
// reverts three mutations of the same class against today's source rather than
// the original four — see section 6, which says which and why.
//
// What it is not
// --------------
// This is `-typecheck`, not a build, and it is not `pod install`. It proves the
// Swift resolves against React Native's Objective-C exactly as the pod will
// compile it; it proves nothing about linking, about the module map CocoaPods
// generates, or about anything that runs.
//
// How the React module is faked, and why it is not a stub
// ------------------------------------------------------
// `import React` needs a Clang module named `React`. CocoaPods builds one from
// React-Core's podspec (`header_dir = "React"`, no `module_name`, so the module
// is `React` and every public header is reachable as `<React/Foo.h>`). This
// script reproduces that shape from node_modules: it symlinks React Native's
// **real** headers flat into `<scratch>/include/React/` — the same flattening
// CocoaPods does — and points a hand-written module map at a shim header that
// imports the four the Swift here actually needs.
//
// The headers are genuine. A hand-written stub of `UIView (React)` would have
// been quicker and would have been worthless: it would encode our belief about
// `didSetProps`'s signature rather than React Native's, which is precisely the
// belief that was wrong.
//
// The bridging header is derived, not typed
// -----------------------------------------
// A pod with `DEFINES_MODULE = YES` exposes its **public** Objective-C headers
// to its own Swift through the generated umbrella header — private ones are
// invisible. So the bridging header here is built from the podspec: every
// `platform/ios/*.h` that `private_header_files` does not claim. That way Swift
// calling into something the podspec keeps private fails here rather than in
// someone's app, and the public/private split is checked rather than assumed.
//
// Usage
//   node scripts/check-swift.mjs             # type-check every .swift under platform/
//   node scripts/check-swift.mjs --selftest  # prove the checker still rejects broken code
//   node scripts/check-swift.mjs --verbose

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rnRoot = path.join(repoRoot, 'node_modules', 'react-native');
const iosDir = path.join(repoRoot, 'platform', 'ios');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const VERBOSE = argv.includes('--verbose');

const die = (message) => {
  console.error(`\n[check-swift] ${message}`);
  process.exit(1);
};
const log = (message) => console.error(`[check-swift] ${message}`);

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...options });

// ---------------------------------------------------------------------------
// 1. The toolchain. Absent is a skip, not a failure.
// ---------------------------------------------------------------------------

// Xcode is macOS-only, so on Linux CI this cannot run at all. Dying there would
// push people towards dropping the step from CI entirely, which is worse than
// a loud skip — but the skip has to be loud, because a silent one is how the
// Objective-C++ half of this port went unchecked while a green run implied
// otherwise. Set RNSM_REQUIRE_SWIFT=1 on a macOS runner to turn the skip into
// a failure, so a broken Xcode install cannot quietly disable the gate.
const REQUIRED = process.env.RNSM_REQUIRE_SWIFT === '1';

const skip = (reason) => {
  if (REQUIRED) die(`${reason} (RNSM_REQUIRE_SWIFT=1 makes this fatal)`);
  log(`skipped — ${reason}`);
  log('no Swift was type-checked by this run.');
  process.exit(0);
};

if (run('xcrun', ['--version']).status !== 0) {
  skip('xcrun not found: this needs Xcode, which is macOS only');
}
const sdkProbe = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
if (sdkProbe.status !== 0) {
  skip('no iphonesimulator SDK: install Xcode and accept its licence');
}
const sdkPath = sdkProbe.stdout.trim();

// ---------------------------------------------------------------------------
// 2. Reproduce the `React` Clang module from node_modules.
// ---------------------------------------------------------------------------

// The React headers the Swift in this package is compiled against, and what
// each one is for.
// Kept to what is used rather than an umbrella over all 240: an umbrella would
// drag in headers that need C++ or pods that are not here, and the failure
// would be this script's rather than ours.
//
//   RCTComponent.h    RCTDirectEventBlock and the RN view protocols the host
//                     is compiled against
//   UIView+React.h    the UIView (React) category, which is what makes
//                     `override` mandatory on anything it already declares
//   RCTViewManager.h  still shimmed: `import React` surfaces it, and a header
//                     that stops resolving is this script's failure to catch
//   RCTUIManager.h    same — kept so the shim matches what `import React`
//                     brings in rather than the narrower set today's Swift
//                     happens to name
const REACT_SHIM_HEADERS = [
  'React/RCTComponent.h',
  'React/UIView+React.h',
  'React/RCTViewManager.h',
  'React/RCTUIManager.h',
];

function prepareReactModule(scratch) {
  const include = path.join(scratch, 'include');
  const reactDir = path.join(include, 'React');
  fs.mkdirSync(reactDir, { recursive: true });

  // Flat, exactly as CocoaPods lays out a pod whose `header_dir` is "React".
  // React Native has no duplicate header basenames in that tree, so the
  // flattening is lossless; if it ever acquires one, this reports it rather
  // than silently linking whichever came last.
  const seen = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.h')) {
        const previous = seen.get(entry.name);
        if (previous) {
          die(
            `React Native ships two headers named ${entry.name} ` +
              `(${path.relative(rnRoot, previous)}, ${path.relative(rnRoot, full)}). ` +
              'CocoaPods flattens them into one directory, so this script can no longer ' +
              'reproduce that layout without choosing between them.',
          );
        }
        seen.set(entry.name, full);
        fs.symlinkSync(full, path.join(reactDir, entry.name));
      }
    }
  };
  walk(path.join(rnRoot, 'React'));

  // RCTBridgeModule.h imports <RCTDeprecation/RCTDeprecation.h>, which is its
  // own pod living outside the React/ tree.
  const deprecation = path.join(
    rnRoot,
    'ReactApple/Libraries/RCTFoundation/RCTDeprecation/Exported/RCTDeprecation.h',
  );
  if (!fs.existsSync(deprecation)) {
    die(`cannot find ${path.relative(rnRoot, deprecation)} — React Native moved RCTDeprecation`);
  }
  fs.mkdirSync(path.join(include, 'RCTDeprecation'), { recursive: true });
  fs.symlinkSync(deprecation, path.join(include, 'RCTDeprecation', 'RCTDeprecation.h'));

  // UIView+React.h imports <yoga/YGEnums.h>.
  const yoga = path.join(rnRoot, 'ReactCommon', 'yoga', 'yoga');
  if (!fs.existsSync(yoga)) die(`cannot find ${path.relative(rnRoot, yoga)} — Yoga moved`);
  fs.symlinkSync(yoga, path.join(include, 'yoga'));

  const moduleDir = path.join(scratch, 'module');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, 'ReactShim.h'),
    REACT_SHIM_HEADERS.map((header) => `#import <${header}>\n`).join(''),
  );
  fs.writeFileSync(
    path.join(moduleDir, 'module.modulemap'),
    'module React {\n  header "ReactShim.h"\n  export *\n}\n',
  );

  return { include, moduleDir };
}

// ---------------------------------------------------------------------------
// 3. Reproduce the pod's public Objective-C surface as a bridging header.
// ---------------------------------------------------------------------------

/**
 * The podspec's `private_header_files` globs, read out of the podspec rather
 * than restated here — a second copy of that list would drift, and the drift
 * would show up as Swift that compiles in this check and not in the pod.
 */
function privateHeaderGlobs() {
  const podspec = fs.readFileSync(path.join(repoRoot, 'SelectableMarkdown.podspec'), 'utf8');
  const globs = [];
  // Both the base assignment and the `+=` under the new-architecture branch.
  for (const match of podspec.matchAll(/private_header_files\s*(?:=|\+=)\s*\[([^\]]*)\]/g)) {
    for (const literal of match[1].matchAll(/"([^"]+)"/g)) globs.push(literal[1]);
  }
  if (globs.length === 0) {
    die('SelectableMarkdown.podspec declares no private_header_files — the public/private ' +
      'split this check models no longer exists in the podspec');
  }
  return globs;
}

/** Minimal glob match for the two shapes the podspec uses: `**` and `*`. */
const globMatches = (glob, relative) => {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '(?:.*/)?');
  return new RegExp(`^${pattern}$`).test(relative);
};

function publicObjCHeaders() {
  const globs = privateHeaderGlobs();
  const headers = fs
    .readdirSync(iosDir)
    .filter((name) => name.endsWith('.h'))
    .map((name) => path.posix.join('platform/ios', name))
    .filter((relative) => !globs.some((glob) => globMatches(glob, relative)));
  if (headers.length === 0) {
    die('no public Objective-C headers under platform/ios — every one matched a ' +
      'private_header_files glob, which would make the Swift host view unable to reach ' +
      'RNSMAttributedText or RNSMTextKitStack in the real pod either');
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 4. The sources.
// ---------------------------------------------------------------------------

function discoverSwiftSources() {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.swift')) found.push(full);
    }
  };
  walk(path.join(repoRoot, 'platform'));
  return found;
}

// ---------------------------------------------------------------------------
// 5. Type-check.
// ---------------------------------------------------------------------------

// From the podspec: `s.platforms = { :ios => "13.4" }` and
// `s.swift_version = "5.0"`. Read rather than typed, because checking against a
// newer deployment target than the pod declares would let an availability
// mistake through.
function podTargets() {
  const podspec = fs.readFileSync(path.join(repoRoot, 'SelectableMarkdown.podspec'), 'utf8');
  const ios = /:ios\s*=>\s*"([^"]+)"/.exec(podspec);
  const swift = /s\.swift_version\s*=\s*"([^"]+)"/.exec(podspec);
  if (!ios || !swift) {
    die('cannot read s.platforms[:ios] and s.swift_version out of SelectableMarkdown.podspec');
  }
  return { deploymentTarget: ios[1], swiftVersion: swift[1] };
}

function typecheck(sources, scratch, reactModule, bridgingHeader, targets) {
  const args = [
    '--sdk',
    'iphonesimulator',
    'swiftc',
    '-typecheck',
    '-target',
    `arm64-apple-ios${targets.deploymentTarget}-simulator`,
    '-swift-version',
    targets.swiftVersion.split('.')[0],
    '-sdk',
    sdkPath,
    '-Xcc',
    `-I${reactModule.include}`,
    '-Xcc',
    `-I${reactModule.moduleDir}`,
    '-Xcc',
    `-fmodule-map-file=${reactModule.moduleDir}/module.modulemap`,
    // Bare-name includes between our own Objective-C headers, mirroring the
    // podspec's HEADER_SEARCH_PATHS entry for platform/ios.
    '-Xcc',
    `-I${iosDir}`,
    '-import-objc-header',
    bridgingHeader,
    ...sources,
  ];
  if (VERBOSE) console.log(`xcrun ${args.join(' ')}`);
  const r = run('xcrun', args, { cwd: scratch });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

// ---------------------------------------------------------------------------
// 6. Self-test: three selector-import mutations the checker must reject.
// ---------------------------------------------------------------------------

// A checker that cannot fail is not a checker. These three mutations are the
// negative controls, and they are all the SAME CLASS of defect as the four in
// the header: an Objective-C selector imported into Swift under the wrong
// name. That class is what this gate exists to catch, because it is invisible
// to human review — nothing about the logic is wrong, only the spelling
// omit-needless-words chose.
//
// They are NOT the historical four. Those sites are gone: `didSetProps`,
// `makeTextContainer(with:)` and `setIntrinsicContentSize(_:for:)` no longer
// appear anywhere in platform/ios, so a mutation that reverted them would have
// nothing to edit and would pass by mutating nothing — the worst failure mode
// a self-test has. Each mutation below edits a line that exists in today's
// SelectableRunHostView.swift, which is why `apply` is a literal string
// replacement and why selftest() fails a mutation that changed nothing
// ("did not change") before it ever type-checks: a mutation whose target has
// moved would otherwise report a green self-test over an unmutated file.
const MUTATIONS = [
  {
    name: 'Objective-C selector piece kept where Swift omits it (makeTextStack)',
    file: 'SelectableRunHostView.swift',
    apply: (s) => s.replace('with: CGSize(width: 0', 'withSize: CGSize(width: 0'),
    expect: /incorrect argument label in call/,
  },
  {
    // The `ofStack:` piece is the FIRST label of a class method whose Swift
    // name keeps it, sitting next to `makeTextStack` above whose first label
    // Swift drops. Getting the rule backwards on either one is the mistake
    // this pair pins from both sides.
    name: 'Objective-C selector piece dropped where Swift keeps it (textContainer)',
    file: 'SelectableRunHostView.swift',
    apply: (s) =>
      s.replace('RNSMTextKitStack.textContainer(ofStack: stack)', 'RNSMTextKitStack.textContainer(stack)'),
    expect: /missing argument label 'ofStack:' in call/,
  },
  {
    // NSLayoutManager's `glyphRange(forCharacterRange:actualCharacterRange:)`
    // has a second argument Swift does NOT make optional-defaulted, and the
    // decoration geometry is built on it. Dropping it compiles in
    // Objective-C-shaped memory and not in Swift.
    name: 'trailing selector piece dropped from an AppKit/UIKit import (glyphRange)',
    file: 'SelectableRunHostView.swift',
    apply: (s) =>
      s.replace(
        'layoutManager.glyphRange(\n      forCharacterRange: characterRange, actualCharacterRange: nil)',
        'layoutManager.glyphRange(forCharacterRange: characterRange)',
      ),
    expect: /(missing argument for parameter 'actualCharacterRange'|extra argument|cannot find)/,
  },
];

function selftest(sources, scratch, reactModule, bridgingHeader, targets) {
  let failures = 0;
  const mutantDir = path.join(scratch, 'mutants');

  for (const mutation of MUTATIONS) {
    fs.rmSync(mutantDir, { recursive: true, force: true });
    fs.mkdirSync(mutantDir, { recursive: true });
    const mutated = [];
    let changed = false;
    for (const source of sources) {
      const original = fs.readFileSync(source, 'utf8');
      const text = path.basename(source) === mutation.file ? mutation.apply(original) : original;
      if (text !== original) changed = true;
      const copy = path.join(mutantDir, path.basename(source));
      fs.writeFileSync(copy, text);
      mutated.push(copy);
    }
    if (!changed) {
      console.error(`  FAIL  mutation "${mutation.name}" did not change ${mutation.file}`);
      failures++;
      continue;
    }
    const r = typecheck(mutated, scratch, reactModule, bridgingHeader, targets);
    if (r.ok) {
      console.error(`  FAIL  broken Swift TYPE-CHECKED: ${mutation.name}`);
      failures++;
    } else if (!mutation.expect.test(r.output)) {
      // Rejected, but not for the reason claimed — which usually means the
      // Swift importer or a React Native signature moved, and the mutation is
      // no longer testing what its name says.
      console.error(`  FAIL  rejected for the wrong reason: ${mutation.name}`);
      console.error(`        expected ${mutation.expect}`);
      console.error(r.output.split('\n').slice(0, 6).join('\n'));
      failures++;
    } else {
      console.log(`  ok    rejected: ${mutation.name}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// 7. Main.
// ---------------------------------------------------------------------------

const sources = discoverSwiftSources();
if (sources.length === 0) {
  die('no .swift found under platform/ — the Swift host view has moved or been lost, and ' +
    'this run would otherwise report green having checked nothing');
}

const targets = podTargets();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-check-swift-'));
let failures = 0;

try {
  const reactModule = prepareReactModule(scratch);
  const headers = publicObjCHeaders();
  const bridgingHeader = path.join(scratch, 'Bridging.h');
  fs.writeFileSync(
    bridgingHeader,
    headers.map((relative) => `#import "${path.basename(relative)}"\n`).join(''),
  );

  log(
    `react-native ${JSON.parse(fs.readFileSync(path.join(rnRoot, 'package.json'), 'utf8')).version} | ` +
      `ios ${targets.deploymentTarget} | swift ${targets.swiftVersion} | ${path.basename(sdkPath)}`,
  );
  log(`public Objective-C surface: ${headers.map((h) => path.basename(h)).join(', ')}`);

  if (SELFTEST) {
    console.log(
      `\nself-test — the checker must reject all ${MUTATIONS.length} selector-import mutations:`,
    );
    failures += selftest(sources, scratch, reactModule, bridgingHeader, targets);
  } else {
    console.log('');
    const r = typecheck(sources, scratch, reactModule, bridgingHeader, targets);
    for (const source of sources) {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${path.relative(repoRoot, source)}`);
    }
    if (!r.ok) {
      console.error(r.output);
      failures++;
    } else if (r.output && VERBOSE) {
      console.log(r.output);
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures) die(`${failures} failure(s)`);
log('all checks passed');
