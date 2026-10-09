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
//                             leaves the tree as it was. The addon build is a
//                             hard gate: without it `npm test` skips every
//                             parsing suite and still exits 0.
//   2. version bump         — `npm version <arg> --no-git-tag-version`:
//                             package.json/package-lock.json only. No commit,
//                             no tag, no branch; releasing from a dirty tree
//                             is deliberate and supported.
//   3. release guard        — `scripts/check-unreleased-breaking.mjs`, after
//                             the bump so it judges the bump.
//   4. verify:pack          — packs a throwaway tarball (running the build
//                             via prepare) and asserts it is consumable.
//   5. npm pack             — the real artifact, written to the repo root
//                             (*.tgz is gitignored).
//
// If anything after the bump fails, the bump is rolled back so a failed
// release does not leave a half-bumped working tree.
//
// The tarball is a local dry run. release.yml publishes on a `v*` tag, because
// only that workflow mints provenance and runs the macOS gates.
//
// `--skip-tests` skips the addon build and `npm test` together; there is
// deliberately no mode that runs the suite without the addon.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERSION_TYPES = ['patch', 'minor', 'major', 'premajor', 'preminor', 'prepatch', 'prerelease'];

const args = process.argv.slice(2);
const skipTests = args.includes('--skip-tests');
const bumpArg = args.find((arg) => !arg.startsWith('--'));

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
  // No `--if-available`: a missing toolchain must fail here, not skip the parsing suites.
  run('node', ['scripts/build-node-addon.mjs'], 'native addon (hard gate, before the tests)');
  run('npm', ['test'], 'tests');
}

const previous = readVersion();
run('npm', ['version', bumpArg, '--no-git-tag-version'], `version bump (${bumpArg})`);
const next = readVersion();

try {
  run('node', ['scripts/check-unreleased-breaking.mjs', '--tag', `v${next}`], 'release guard (no unreleased breaking entries)');
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

// Non-fatal: the section is usually written after the bump; this only picks step 1's wording.
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
// Printed, not run: a human reviews the diff and tags; release.yml publishes with provenance.
console.log('[release] this tarball is a local dry run. To publish:');
console.log(
  changelogSection
    ? `[release]   1. CHANGELOG.md already has a ${next} section — release.yml will quote it`
    : `[release]   1. move the Unreleased entries into a "## [${next}] — <date>" section to CHANGELOG.md (release.yml reads its notes from there and refuses to publish without one)`,
);
console.log(`[release]   2. git add package.json package-lock.json CHANGELOG.md && git commit -m "release ${next}"`);
console.log(`[release]   3. git push origin main && git tag v${next} && git push origin v${next}`);
console.log('[release] the tag is what runs .github/workflows/release.yml: the macOS gates and the Android and');
console.log('[release] iOS app builds, then every gate CI runs, then npm publication of the packed tarball and the');
console.log('[release] GitHub release. It re-runs them from scratch, so the tagged commit does not have to be one CI');
console.log('[release] already saw. The app builds run nowhere else; to try them before tagging:');
console.log('[release]   gh workflow run native-build.yml --ref <branch>');
