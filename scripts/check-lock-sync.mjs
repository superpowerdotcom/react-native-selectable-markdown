#!/usr/bin/env node
// Asserts that package-lock.json's root entry still mirrors the fields
// package.json shares with it — its identity, every dependency block, and the
// engines/bin pair (see FIELDS).
//
// WHY THIS EXISTS. `npm ci` installs from the lockfile and never compares the
// manifest's dependency blocks against it, so the lock's root entry kept
// claiming `react-native: >=0.73` through both 0.10.0 and 0.11.0 — a floor the
// package stopped supporting in 0.10.0 — with nothing anywhere going red. npm
// never publishes the lockfile, so the drift never reaches a consumer; it just
// makes the repository's own metadata lie about what it supports.
//
// WHY IT IS NOT `JSON.stringify(a) !== JSON.stringify(b)`. That comparison is
// key-ORDER sensitive, and the two files are written by different hands: npm
// rewrites the lock's blocks alphabetically, while a human editing
// package.json appends. So a hand-added dependency (or a devDependency moved a
// line up) failed this check with a message showing two objects that differ
// only in the order their keys were printed — a red that looks like a bug in
// the check. The comparison below normalises key order and then names the
// keys that actually differ, so the message says what to fix.
//
// Usage: node scripts/check-lock-sync.mjs [package.json] [package-lock.json]
//
// The two paths are arguments only so the check can be exercised against
// fixtures; the workflow passes none and gets this repository's own pair.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [manifestArg, lockArg] = process.argv.slice(2);
const manifestPath = path.resolve(manifestArg ?? path.join(repoRoot, 'package.json'));
const lockPath = path.resolve(lockArg ?? path.join(repoRoot, 'package-lock.json'));

/**
 * The fields npm copies from the manifest into the lock's root ("") entry.
 *
 * Read off a lockfile npm wrote rather than guessed at: `npm install` mirrors
 * the manifest's identity (name, version, license), every dependency block
 * (dependencies, devDependencies, peerDependencies, optionalDependencies,
 * peerDependenciesMeta) and the two fields that describe what the package
 * installs as (engines, bin). This repository's lock root carries name,
 * version, license, devDependencies and peerDependencies today; the rest are
 * listed so that ADDING one to package.json without regenerating the lock is
 * caught the same way a changed range is. Anything npm does not copy — the
 * scripts block, `files`, `exports` — is deliberately absent: comparing it
 * would fail on files that are not supposed to agree.
 */
const FIELDS = [
  'name',
  'version',
  'license',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'peerDependenciesMeta',
  'engines',
  'bin',
];

/**
 * An empty block and a missing one are the same statement.
 *
 * npm omits a block it has nothing to write, while a human editing
 * package.json leaves `"dependencies": {}` behind after removing the last
 * entry. Both mean "no dependencies", so normalising `{}` to absent is what
 * stops that pair failing the release with `package.json {}, lock null` — a
 * red that describes no actual drift. An empty ARRAY is left alone: no field
 * here holds one, and `[]` is not a shape npm elides.
 */
const normalize = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.keys(value).length === 0 ? null : value;
};

/**
 * A stable rendering of a JSON value: objects get their keys sorted, arrays
 * keep their order (order is meaning in an array, and none of these fields
 * holds one anyway). Comparing two of these compares content and nothing else.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The individual keys that differ between two dependency blocks, so the
 * failure names the range that moved rather than printing two long objects and
 * leaving the reader to diff them by eye.
 */
function differingKeys(left, right) {
  if (left === null || typeof left !== 'object' || right === null || typeof right !== 'object') {
    return [];
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => !same(left[key], right[key]))
    .map((key) => `${key}: package.json ${JSON.stringify(left[key] ?? null)}, lock ${JSON.stringify(right[key] ?? null)}`);
}

const read = (file, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[check-lock-sync] cannot read ${label} at ${file}: ${error.message}`);
    process.exit(1);
  }
};

const manifest = read(manifestPath, 'package.json');
const lock = read(lockPath, 'package-lock.json');
const root = lock.packages?.[''];

if (!root) {
  console.error(
    `[check-lock-sync] ${lockPath} has no packages[""] entry — it is not a lockfileVersion 2/3 ` +
      'lockfile, so there is nothing to compare against the manifest.',
  );
  process.exit(1);
}

const problems = [];
for (const field of FIELDS) {
  const left = normalize(manifest[field]);
  const right = normalize(root[field]);
  if (same(left, right)) continue;
  const details = differingKeys(left, right);
  problems.push(
    `package-lock.json root ${field} does not match package.json.\n` +
      (details.length > 0
        ? details.map((line) => `    ${line}`).join('\n')
        : `    package.json ${JSON.stringify(left)}, lock ${JSON.stringify(right)}`),
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[check-lock-sync] ${problem}`);
  console.error('[check-lock-sync] Run `npm install --package-lock-only` and commit the result.');
  process.exit(1);
}

console.log('[check-lock-sync] package-lock.json root entry matches package.json.');
