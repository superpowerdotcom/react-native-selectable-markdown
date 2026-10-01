#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for `gh release create
// --notes-file`.
//
// Not `--generate-notes`: main is squashed, so commit-derived notes say nothing.
// Exits non-zero when the section is missing or empty.
//
//   node scripts/changelog-section.mjs v0.11.0   # or: 0.11.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const raw = process.argv[2];
if (!raw) {
  console.error('usage: node scripts/changelog-section.mjs <version|vX.Y.Z>');
  process.exit(2);
}
const version = raw.startsWith('v') ? raw.slice(1) : raw;

if (!fs.existsSync(changelogPath)) {
  console.error(`[changelog-section] ${path.relative(repoRoot, changelogPath)} does not exist.`);
  process.exit(1);
}

const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');
const isVersionHeading = (line) => /^##\s+\[?([^\]\s]+)\]?/.exec(line)?.[1] === version;
const start = lines.findIndex(isVersionHeading);

if (start === -1) {
  console.error(
    `[changelog-section] CHANGELOG.md has no section for ${version}.\n` +
      `                   Add a "## [${version}] — <date>" heading with what changed, then\n` +
      '                   re-push the tag. Release notes come from this file, not from the\n' +
      '                   squashed commit log.',
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

// Drops the heading (gh titles the release with the tag) and trailing link
// references, which fall inside the oldest section's slice.
const section = lines.slice(start + 1, end);
while (section.length > 0) {
  const last = section[section.length - 1];
  if (last.trim() === '' || /^\[[^\]]+\]:\s/.test(last)) {
    section.pop();
  } else {
    break;
  }
}
const body = section.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');

if (body.trim() === '') {
  console.error(`[changelog-section] the ${version} section is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
