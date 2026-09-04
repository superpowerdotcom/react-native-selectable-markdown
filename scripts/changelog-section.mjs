#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for `gh release create
// --notes-file`.
//
// WHY THE RELEASE DOES NOT USE `--generate-notes`. That flag writes notes from
// the commits and pull requests in the tag range. `main` here is two squashed
// commits ("Initial commit" at v0.10.0, one feature PR at v0.11.0), so the
// generated notes for a release say "Initial commit" while README.md and
// docs/FABRIC-PLAN.md discuss what 0.10.0 removed and 0.11.0 restored in
// detail. A changelog section is the only place that history is written down
// in the artifact a consumer sees.
//
// Exits non-zero when the section is missing, and the release workflow runs
// this BEFORE the long gates so that a forgotten entry costs seconds rather
// than a re-tag after a publish.
//
//   node scripts/changelog-section.mjs v0.11.0   # or: 0.11.0
//
// Also usable as a lint: `node scripts/changelog-section.mjs "$(node -p
// "require('./package.json').version")" > /dev/null`.

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
// Tags are `vX.Y.Z`; headings are `## [X.Y.Z] — date`. One `v` is the only
// difference, so strip it rather than asking callers to.
const version = raw.startsWith('v') ? raw.slice(1) : raw;

if (!fs.existsSync(changelogPath)) {
  console.error(`[changelog-section] ${path.relative(repoRoot, changelogPath)} does not exist.`);
  process.exit(1);
}

const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');
// A section starts at its own `## [version]` heading and ends at the next
// `## ` heading, or at the end of the file for the oldest entry.
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

// Drop the heading itself: `gh release create` already titles the release with
// the tag, and a repeated version line reads as a stutter in the release body.
//
// Trailing link-reference definitions go too. They sit at the bottom of the
// file, so for the OLDEST section they fall inside the slice — and in a
// release body they render as nothing at all, or as a stray `[0.10.0]:` line
// depending on the renderer.
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
