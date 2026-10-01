#!/usr/bin/env node
// Asserts that package-lock.json's root entry still mirrors the fields
// package.json shares with it — its identity, every dependency block, and the
// engines/bin pair (see FIELDS).
//
// `npm ci` never compares the manifest against the lock's root entry. Key order
// is normalised because npm sorts the lock's blocks while humans append.
//
// Usage: node scripts/check-lock-sync.mjs [package.json] [package-lock.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [manifestArg, lockArg] = process.argv.slice(2);
const manifestPath = path.resolve(manifestArg ?? path.join(repoRoot, 'package.json'));
const lockPath = path.resolve(lockArg ?? path.join(repoRoot, 'package-lock.json'));

/** Everything npm copies into the lock's root entry, so an added block is caught too. */
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

/** `{}` equals absent: npm omits an empty block that a human edit leaves behind. */
const normalize = (value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.keys(value).length === 0 ? null : value;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

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
