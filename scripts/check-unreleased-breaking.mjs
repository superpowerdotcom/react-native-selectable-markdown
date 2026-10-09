#!/usr/bin/env node
// Refuses to release a BREAKING change under a version that is already tagged,
// or under a version whose number does not announce it.
//
// Fails when CHANGELOG.md's Unreleased section mentions BREAKING and package.json's
// version equals the latest `v*` tag, and when the section for a `--tag` mentions
// BREAKING but that tag is not a minor bump (pre-1.0) or a major bump (1.0+),
// the rule CHANGELOG.md's header states.
//
// Usage: node scripts/check-unreleased-breaking.mjs [--tag vX.Y.Z]...
//                [--changelog PATH] [--manifest PATH] [--no-git]

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

/** Same section grammar as scripts/changelog-section.mjs; keep the two in step. */
const sectionNamed = (text, name) => {
  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) => /^##\s+\[?([^\]\s]+)\]?/.exec(line)?.[1].toLowerCase() === name.toLowerCase(),
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
const unreleasedSection = (text) => sectionNamed(text, 'unreleased');
const isBreakingLine = (line) => /^\s*[-*]\s+(?:\*\*)?BREAKING\b/i.test(line);

const parseVersion = (raw) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
};

/** Prereleases compare as strings, not full semver: enough to pick a latest tag. */
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

const changelogText = fs.readFileSync(changelogPath, 'utf8');

for (const tag of flagValues('tag')) {
  const parsed = parseVersion(tag);
  if (!parsed) continue;
  const lines = sectionNamed(changelogText, parsed.version);
  if (!lines) continue; // changelog-section.mjs is the gate for a missing section
  const breakingHere = lines.filter(isBreakingLine);
  if (breakingHere.length === 0) continue;
  const [major, minor, patch] = parsed.parts;
  const announces = major === 0 ? patch === 0 : minor === 0 && patch === 0;
  if (announces) continue;
  const bump = major === 0 ? 'minor' : 'major';
  const suggested = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  fail(
    `CHANGELOG.md's ${parsed.version} section names a BREAKING change, but ` +
      `v${parsed.version} is not a ${bump} bump.\n` +
      `    ${breakingHere.length} line(s) say BREAKING, the first being:\n` +
      `      ${breakingHere[0].trim()}\n` +
      `    CHANGELOG.md's header promises a ${bump} bump for a break; release it as ` +
      `${suggested}, or drop the BREAKING label if nothing breaks.`,
  );
}

const section = unreleasedSection(changelogText);
const breaking = (section ?? []).filter(isBreakingLine);

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
// Pre-1.0 a break bumps the minor, per CHANGELOG.md's header.
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
