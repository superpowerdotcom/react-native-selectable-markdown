#!/usr/bin/env node
// Bumps the version and builds a verified tarball, locally and without
// touching git.
//
// Usage:  npm run release <patch|minor|major|x.y.z> [-- --skip-tests]
//         npm run release -- --help
//
// Steps, in order:
//
//   1. typecheck + native addon + tests
//                           — run BEFORE the version bump, so a red suite
//                             leaves the tree exactly as it was. The addon
//                             build is part of this step and is a HARD GATE:
//                             `describeNative` in
//                             src/engine/native/__tests__/support.ts is
//                             `describe.skip` when build/selectable-markdown
//                             .node is missing, so `npm test` on a machine
//                             with no C++ toolchain runs *zero*
//                             markdown-parsing checks and still exits 0.
//                             support.ts does spawn the build itself, but
//                             with `--if-available`, which exits 0 when no
//                             compiler is present — which is exactly how a
//                             tarball could be called "verified" here having
//                             parsed nothing. Both CI workflows build it
//                             without that flag before `npm test`; so does
//                             this script.
//   2. version bump         — `npm version <arg> --no-git-tag-version`:
//                             package.json/package-lock.json only. No commit,
//                             no tag, no branch; releasing from a dirty tree
//                             is deliberate and supported.
//   3. release guard        — `scripts/check-unreleased-breaking.mjs`: refuses
//                             to go on when CHANGELOG.md's Unreleased section
//                             names a BREAKING change and the bump did not move
//                             past the latest `v*` tag. Run after the bump, so
//                             it judges the bump; release.yml runs it again in
//                             its preflight job, where the tag is the one being
//                             pushed.
//   4. verify:pack          — packs a throwaway tarball (running the build
//                             via prepare) and asserts it is consumable.
//   5. npm pack             — the real artifact, written to the repo root
//                             (*.tgz is gitignored).
//
// If anything after the bump fails, the bump is rolled back so a failed
// release does not leave a half-bumped working tree.
//
// WHAT THIS TARBALL IS FOR, AND WHAT PUBLISHES THE REAL ONE
// ---------------------------------------------------------
// The tarball written here is a local dry run: proof that this tree packs into
// something installable, and something to `npm install` into a scratch app.
// It is NOT what reaches consumers. Publishing is done by
// .github/workflows/release.yml, which triggers on a `v*` tag, re-runs every
// gate, packs its own tarball, attaches it to the GitHub release and runs
// `npm publish --provenance`. Provenance can only be minted by that workflow —
// a hand `npm publish <tarball>` from a laptop ships without it, and without
// the macOS gates.
//
// So the sequence, end to end, is:
//
//   npm run release <bump>
//   # write the CHANGELOG.md section — release.yml quotes it as the release
//   # notes and refuses to publish a version that has none
//   git add package.json package-lock.json CHANGELOG.md && git commit
//   git tag v<version> && git push origin main v<version>
//
// The final log lines below print exactly that, with the version filled in and
// the changelog step marked done when it already is. README.md's "Releasing"
// section is the same sequence in prose.
//
// `--skip-tests` skips step 1's addon build and `npm test` together — an
// escape hatch for releasing from a machine whose suite is red for reasons
// already understood, or that has no C++ toolchain at all. They go together
// because building the addon is only worth the seconds if something is going
// to load it, and because a flag that says "I know this machine cannot verify
// the parse" should say it once. There is no third mode: nothing here runs the
// suite WITHOUT the addon, because that combination is the silent green the
// hard gate exists to prevent — it is what `npm test` did on its own before
// this script built the addon. A tarball packed with the flag is not verified,
// which is why release.yml re-runs everything from scratch on the tag. All of
// this is in `npm run release -- --help` too, where someone reaching for the
// flag will actually read it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERSION_TYPES = ['patch', 'minor', 'major', 'premajor', 'preminor', 'prepatch', 'prerelease'];

const args = process.argv.slice(2);
const skipTests = args.includes('--skip-tests');
const bumpArg = args.find((arg) => !arg.startsWith('--'));

/**
 * The help text, which is where `--skip-tests` has to say what it actually
 * does. It reads like a way to skip the SUITE, and it is not: it skips the
 * native addon build too, and that build is the only reason the suite parses
 * any markdown at all. Someone reaching for it because the tests are slow
 * needs to know they are also giving up every parsing check, and that there is
 * no third mode between the two.
 */
const usage = () => {
  console.error(`usage: npm run release <${VERSION_TYPES.slice(0, 3).join('|')}|x.y.z> [-- --skip-tests]`);
  console.error('');
  console.error('  --skip-tests  skips BOTH the native addon build and `npm test`, together.');
  console.error('                They are one switch because the addon is what makes the suite');
  console.error('                test a parse: `describeNative` (src/engine/native/__tests__/');
  console.error('                support.ts) is `describe.skip` without build/selectable-markdown');
  console.error('                .<platform>-<arch>.node, so `npm test` on a machine with no C++');
  console.error('                toolchain exits 0 having run zero markdown-parsing checks. There');
  console.error('                is deliberately NO "tests without the addon" mode: that mode is');
  console.error('                the silent one this flag exists to stop anybody entering by');
  console.error('                accident. The tarball it packs is NOT verified — verify:pack');
  console.error('                still proves it is consumable, nothing proves it parses — and');
  console.error('                the run says so. release.yml re-runs everything on the tag.');
};

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (!bumpArg || (!VERSION_TYPES.includes(bumpArg) && !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(bumpArg))) {
  usage();
  process.exit(1);
}

const run = (command, commandArgs, label) => {
  console.log(`[release] ${label}`);
  execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
};

const readVersion = () =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

run('npm', ['run', 'typecheck'], 'typecheck');
if (skipTests) {
  console.log('[release] native addon build + tests SKIPPED (--skip-tests) — this tarball is NOT verified');
} else {
  // No `--if-available`: see the header. This is the step that turns "the
  // suite passed" into "the suite ran".
  run('node', ['scripts/build-node-addon.mjs'], 'native addon (hard gate, before the tests)');
  run('npm', ['test'], 'tests');
}

const previous = readVersion();
run('npm', ['version', bumpArg, '--no-git-tag-version'], `version bump (${bumpArg})`);
const next = readVersion();

try {
  // First inside the try, so a tree that cannot legally publish this version
  // rolls the bump back in a second rather than after a full pack. The guard
  // reads CHANGELOG.md's Unreleased section against the latest `v*` tag: a
  // pending BREAKING change under a version that is already tagged cannot ship,
  // and running it AFTER the bump is what makes it a check on the bump rather
  // than on the state the bump exists to leave behind. release.yml runs the
  // same script in its preflight job.
  run('node', ['scripts/check-unreleased-breaking.mjs'], 'release guard (pending BREAKING vs. the latest tag)');
  run('npm', ['run', 'verify:pack'], 'verify:pack (builds via prepare)');
  run('npm', ['pack'], `pack → react-native-selectable-markdown-${next}.tgz`);
} catch (error) {
  // Only the version fields changed, so restoring the previous version puts
  // package.json and package-lock.json back exactly as they were.
  run(
    'npm',
    ['version', previous, '--no-git-tag-version', '--allow-same-version'],
    `FAILED — rolling version back to ${previous}`,
  );
  throw error;
}

// Checked here rather than left to the tag: release.yml refuses to publish a
// version with no CHANGELOG section, and finding that out from a failed
// workflow costs a re-tag. Non-fatal, because the section is normally written
// after the bump — this only decides whether step 1 below is still owed.
let changelogSection = false;
try {
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'changelog-section.mjs'), next], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  changelogSection = true;
} catch {
  changelogSection = false;
}

console.log(`[release] ${previous} → ${next} — ok`);
console.log(
  `[release] local dry-run tarball: react-native-selectable-markdown-${next}.tgz ` +
    '(nothing committed, tagged or published)',
);
// The commands that actually ship it. Printed rather than run: the version
// bump is in the working tree and a human should read the diff, write the
// CHANGELOG section the release workflow will quote, and decide when the tag
// goes out. `npm publish` is deliberately NOT among them — release.yml does
// that, with provenance, which a local publish cannot mint.
console.log('[release] this tarball is a local dry run. To publish:');
console.log(
  changelogSection
    ? `[release]   1. CHANGELOG.md already has a ${next} section — release.yml will quote it`
    : `[release]   1. add a "## [${next}] — <date>" section to CHANGELOG.md (release.yml reads its notes from there and refuses to publish without one)`,
);
console.log(`[release]   2. git add package.json package-lock.json CHANGELOG.md && git commit -m "release ${next}"`);
console.log(`[release]   3. git push origin main && git tag v${next} && git push origin v${next}`);
console.log('[release] the tag is what runs .github/workflows/release.yml: the macOS gates, then every');
console.log('[release] gate CI runs, then the GitHub release and `npm publish --provenance`. It re-runs');
console.log('[release] them from scratch, so the tagged commit does not have to be one CI already saw.');
