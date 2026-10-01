#!/usr/bin/env node
// Refuses to release a BREAKING change under a version that is already tagged.
//
// WHY THIS EXISTS. Release notes come from CHANGELOG.md's section for the tag
// (scripts/changelog-section.mjs), and the workflow already refuses to publish
// a tag with no section. Nothing looked at the OTHER half: an `## [Unreleased]`
// section that says BREAKING while `package.json` still carries the version the
// latest `v*` tag already names. That pair is one publish away from shipping a
// breaking change inside a release whose notes never mention it — the audit
// that prompted this guard left exactly that state behind (an `exports` map
// that dropped ten names from the package root, a renamed export and a
// deep path that stopped resolving, all under an unbumped 0.11.0).
//
// WHAT IT CHECKS, in one sentence: if CHANGELOG.md's Unreleased section
// mentions BREAKING and package.json's version equals the version of the latest
// `v*` tag, fail and say what to bump. Everything else passes.
//
// It is deliberately NOT a check that the bump is the right SIZE. Semver
// arithmetic over a changelog is guesswork; "this version was already
// released" is a fact, and it is the fact that decides whether the next publish
// can carry the break at all.
//
// Usage: node scripts/check-unreleased-breaking.mjs [--tag vX.Y.Z]...
//                [--changelog PATH] [--manifest PATH] [--no-git]
//
// The workflow passes `--tag "$GITHUB_REF_NAME"` so the tag being pushed counts
// even in a shallow checkout that fetched no others. `--changelog`, `--manifest`
// and `--no-git` exist so the guard can be exercised against fixtures;
// `npm run release` and release.yml pass none of the three.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flagValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
};
const lastValue = (name, fallback) => {
  const values = flagValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
};

const changelogPath = path.resolve(lastValue('changelog', path.join(repoRoot, 'CHANGELOG.md')));
const manifestPath = path.resolve(lastValue('manifest', path.join(repoRoot, 'package.json')));
const useGit = !argv.includes('--no-git');

const fail = (message) => {
  console.error(`[check-unreleased-breaking] ${message}`);
  process.exit(1);
};

/**
 * The `## [Unreleased]` section's body, or null when the file has none.
 *
 * Same section grammar as scripts/changelog-section.mjs — a `## ` heading whose
 * bracketed name is the one wanted, ending at the next `## ` — so the two agree
 * on where a section starts and stops. The name is matched case-insensitively
 * because the heading is prose, not an identifier.
 */
const unreleasedSection = (text) => {
  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) => /^##\s+\[?([^\]\s]+)\]?/.exec(line)?.[1].toLowerCase() === 'unreleased',
  );
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
};

/** `vX.Y.Z[-pre]` → comparable parts, or null for a tag that is not one. */
const parseVersion = (raw) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
};

/**
 * Newest of two parsed versions.
 *
 * Numeric fields first, then the one semver rule that matters here: a release
 * outranks a prerelease of the same numbers. Two prereleases are compared as
 * strings, which is not the full semver ordering — it is enough to pick a
 * latest tag, and no publish decision rests on the order of two prereleases.
 */
const newer = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? a : b;
  }
  if (a.prerelease === b.prerelease) return a;
  if (a.prerelease === null) return a;
  if (b.prerelease === null) return b;
  return a.prerelease > b.prerelease ? a : b;
};

const gitTags = () => {
  if (!useGit) return [];
  const result = spawnSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
};

if (!fs.existsSync(changelogPath)) {
  fail(`${changelogPath} does not exist, so nothing says whether a break is pending.`);
}
if (!fs.existsSync(manifestPath)) {
  fail(`${manifestPath} does not exist.`);
}

const section = unreleasedSection(fs.readFileSync(changelogPath, 'utf8'));
const breaking = (section ?? []).filter((line) => line.includes('BREAKING'));

if (breaking.length === 0) {
  console.log(
    section === null
      ? '[check-unreleased-breaking] CHANGELOG.md has no Unreleased section — nothing pending.'
      : '[check-unreleased-breaking] the Unreleased section names no BREAKING change.',
  );
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const declared = parseVersion(String(manifest.version ?? ''));
if (!declared) {
  fail(`package.json version ${JSON.stringify(manifest.version)} is not an x.y.z version.`);
}

// The tag being pushed counts alongside the ones already in the repository:
// release.yml passes it because `actions/checkout` may have fetched no other,
// and because a tag that names this very version is exactly the case the guard
// is about.
const candidates = [...flagValues('tag'), ...gitTags()]
  .map(parseVersion)
  .filter((parsed) => parsed !== null);

if (candidates.length === 0) {
  console.log(
    '[check-unreleased-breaking] a BREAKING change is pending, but no v* tag exists to ' +
      'compare against — nothing has been released yet, so nothing can ship under a used version.',
  );
  process.exit(0);
}

const latest = candidates.reduce(newer);

if (latest.version !== declared.version) {
  console.log(
    `[check-unreleased-breaking] a BREAKING change is pending and package.json is ` +
      `${declared.version}, past the latest tag v${latest.version} — ok.`,
  );
  process.exit(0);
}

const [major, minor] = declared.parts;
// Pre-1.0 this repository lands breaking changes in a MINOR (CHANGELOG.md's
// header says so); from 1.0 on they are a major. Printing the number saves the
// reader deciding which rule applies while they are mid-release.
const suggested = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;

fail(
  `CHANGELOG.md's Unreleased section names a BREAKING change, but package.json is still ` +
    `${declared.version} — the version v${latest.version} already tagged.\n` +
    `    ${breaking.length} line(s) say BREAKING, the first being:\n` +
    `      ${breaking[0].trim()}\n` +
    '    Release notes are read from the section for the TAG, so a break left under ' +
    '"Unreleased" ships\n' +
    '    inside an already-named version and appears in nobody\'s notes. Bump the version ' +
    `(${suggested})\n` +
    '    and move those entries under the new heading, then re-tag.',
);
