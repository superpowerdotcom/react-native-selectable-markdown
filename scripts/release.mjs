#!/usr/bin/env node
// Builds a verified release tarball, locally and without touching git.
//
// Usage:  npm run release <patch|minor|major|x.y.z> [-- --skip-tests]
//
// Steps, in order:
//
//   1. typecheck + tests    — run BEFORE the version bump, so a red suite
//                             leaves the tree exactly as it was.
//   2. version bump         — `npm version <arg> --no-git-tag-version`:
//                             package.json/package-lock.json only. No commit,
//                             no tag, no branch; releasing from a dirty tree
//                             is deliberate and supported.
//   3. verify:pack          — packs a throwaway tarball (running the build
//                             via prepack) and asserts it is consumable.
//   4. npm pack             — the real artifact, written to the repo root
//                             (*.tgz is gitignored).
//
// If anything after the bump fails, the bump is rolled back so a failed
// release does not leave a half-bumped working tree. Publishing stays a
// human decision: `npm publish <tarball>` when you mean it.
//
// `--skip-tests` skips step 1's `npm test` only — an escape hatch for
// releasing from a machine whose suite is red for reasons already understood.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERSION_TYPES = ['patch', 'minor', 'major', 'premajor', 'preminor', 'prepatch', 'prerelease'];

const args = process.argv.slice(2);
const skipTests = args.includes('--skip-tests');
const bumpArg = args.find((arg) => !arg.startsWith('--'));

if (!bumpArg || (!VERSION_TYPES.includes(bumpArg) && !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(bumpArg))) {
  console.error(`usage: npm run release <${VERSION_TYPES.slice(0, 3).join('|')}|x.y.z> [-- --skip-tests]`);
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
  console.log('[release] tests SKIPPED (--skip-tests)');
} else {
  run('npm', ['test'], 'tests');
}

const previous = readVersion();
run('npm', ['version', bumpArg, '--no-git-tag-version'], `version bump (${bumpArg})`);
const next = readVersion();

try {
  run('npm', ['run', 'verify:pack'], 'verify:pack (builds via prepack)');
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

console.log(`[release] ${previous} → ${next} — ok`);
console.log(`[release] tarball: react-native-selectable-markdown-${next}.tgz (nothing committed, tagged or published)`);
