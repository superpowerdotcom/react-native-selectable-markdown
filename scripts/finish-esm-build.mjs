#!/usr/bin/env node
// Turns `tsc -p tsconfig.esm.json`'s output into something Node and the web
// bundlers can actually load: writes dist/esm/package.json and gives every
// relative import specifier the file extension ES modules require.
//
// tsc rewrites no specifiers and Node's ESM resolver does no extension search, so
// an extensionless relative specifier left after the rewrite fails the build.
//
// Metro never takes this tree: `require` is listed ahead of `import`, so the
// `require` calls in install.ts and RunHost.tsx stay on the CommonJS build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readTsconfig = (file) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

const esmOutDir = readTsconfig('tsconfig.esm.json').compilerOptions?.outDir;
if (!esmOutDir) {
  console.error('[finish-esm-build] tsconfig.esm.json declares no compilerOptions.outDir.');
  process.exit(1);
}

const outDir = path.join(repoRoot, esmOutDir);
if (!fs.existsSync(outDir)) {
  console.error(
    `[finish-esm-build] ${esmOutDir} does not exist — run \`tsc -p tsconfig.esm.json\` first ` +
      '(`npm run build` does both, in that order).',
  );
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|d\.ts)$/.test(entry.name)) files.push(full);
  }
};
walk(outDir);

/** A .d.ts gets `.js` too: node16 resolution maps `./x.js` to `./x.d.ts` itself. */
const resolved = (fromFile, specifier) => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (specifier.endsWith('.js') || specifier.endsWith('.json')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(`${base}.js`)) return `${specifier}.js`;
  if (fs.existsSync(path.join(base, 'index.js'))) return `${specifier}/index.js`;
  return null;
};

// Anchored on the keyword so an ordinary string literal is never rewritten.
const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let rewritten = 0;
for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(SPECIFIER, (match, keyword, quote, specifier) => {
    const fixed = resolved(file, specifier);
    if (fixed === null) return match;
    rewritten += 1;
    return `${keyword}${quote}${fixed}${quote}`;
  });
  if (after !== before) fs.writeFileSync(file, after);
}

// `import('…')` is not scanned: a dynamic specifier can be built at runtime.
const STATEMENT =
  /^\s*(?:import|export)\b[^\n]*?(?:\bfrom\s+)?(['"])(\.[^'"]*)\1\s*;?\s*$/;
const offenders = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const match = STATEMENT.exec(line);
    if (!match) continue;
    const specifier = match[2];
    if (specifier.endsWith('.js') || specifier.endsWith('.json')) continue;
    offenders.push(`${path.relative(repoRoot, file)}:${index + 1}  ${specifier}`);
  }
}

if (offenders.length > 0) {
  console.error(
    '[finish-esm-build] these relative specifiers have no extension, so Node\'s ESM resolver\n' +
      '                  cannot follow them and the "import" condition would ship broken:',
  );
  for (const offender of offenders) console.error(`                    ${offender}`);
  process.exit(1);
}

// `sideEffects` is repeated because bundlers read it from the nearest package.json.
const marker = {
  type: 'module',
  sideEffects: false,
};
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(marker, null, 2)}\n`);

console.log(
  `[finish-esm-build] ${esmOutDir}: ${files.length} file(s), ${rewritten} specifier(s) given an ` +
    'extension, package.json written ("type": "module", sideEffects: false)',
);
