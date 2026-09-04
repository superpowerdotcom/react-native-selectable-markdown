#!/usr/bin/env node
// Turns `tsc -p tsconfig.esm.json`'s output into something Node and the web
// bundlers can actually load: writes dist/esm/package.json and gives every
// relative import specifier the file extension ES modules require.
//
// WHY THE EMIT IS NOT ENOUGH ON ITS OWN
// ------------------------------------
// Two things are wrong with `module: es2020` output the moment it lands in a
// package whose root package.json has no `"type"`:
//
//   1. Node reads dist/esm/*.js as CommonJS, because the nearest package.json
//      says nothing and the default is CommonJS. Every `import` statement in
//      those files is then a SyntaxError. dist/esm/package.json declaring
//      `"type": "module"` is the whole fix, and it is scoped to that directory
//      — dist/ itself stays CommonJS, which is what `main` and the `require`
//      condition promise.
//   2. tsc does not rewrite import specifiers (it never has, in any module
//      mode): `import { x } from './options'` is emitted verbatim, and Node's
//      ESM resolver does no extension search, so that import fails with
//      ERR_MODULE_NOT_FOUND. The rewrite below resolves each specifier against
//      the emitted tree and appends `.js` (or `/index.js` for a directory),
//      which is also what TypeScript's own `node16` resolution expects to find
//      inside the .d.ts files.
//
// Both are checked rather than assumed: after the rewrite this script scans
// every emitted file for an import or export statement whose relative
// specifier still has no extension, and fails the build if it finds one. A
// half-rewritten ESM tree would otherwise ship and break only in the consumer
// who imported the one module that was missed.
//
// `sideEffects: false` is repeated in dist/esm/package.json on purpose.
// webpack and Rollup read that hint from the package.json NEAREST the module,
// not from the package root, so leaving it out of this file would throw away
// the tree-shaking the ESM build exists to enable.
//
// WHAT THIS OUTPUT IS AND IS NOT FOR. The `import` condition points at it, so
// it is what webpack, Rollup, Vite and Node's own ESM loader take. Metro is
// deliberately NOT one of them: `exports` sends the `react-native` condition to
// src/, and on the deep paths the `require` condition is listed ahead of
// `import`, so a bundler that asserts both (Metro does) stays on the CommonJS
// tree. That matters because two modules here reach the platform through a
// call-expression `require` — `require('react-native')` in
// src/engine/native/install.ts and `require('./SelectableRunHostNativeComponent')`
// in src/view/RunHost.tsx — and `require` does not exist in an ES module
// scope. Both calls sit inside a `try`/`catch` whose fallback is the same one
// a web bundle already takes (no native module, no native host), so the ESM
// copy degrades exactly as the CommonJS copy does on web; what it must not
// become is the copy a React Native app loads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a tsconfig that may carry line comments (this repo's do). */
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

/**
 * The specifier as ES modules need it spelled, or null when it names nothing
 * in the emitted tree.
 *
 * Resolution is done against the FILES ON DISK rather than by pattern, so a
 * specifier that already carries its extension is left alone and a directory
 * import becomes `/index.js` — the two shapes tsc's output actually contains.
 * A .d.ts gets the same `.js` spelling, which is what TypeScript's node16
 * resolution looks for (it maps `./x.js` to `./x.d.ts` itself).
 */
const resolved = (fromFile, specifier) => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (specifier.endsWith('.js') || specifier.endsWith('.json')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(`${base}.js`)) return `${specifier}.js`;
  if (fs.existsSync(path.join(base, 'index.js'))) return `${specifier}/index.js`;
  return null;
};

// `from './x'`, `import './x'` and `import('./x')` — the three forms tsc emits
// a module specifier in. Anchored on the keyword so an ordinary string in the
// code cannot be rewritten by accident, and every match is still checked
// against the filesystem before it is touched.
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

// The post-condition, checked rather than trusted: nothing may be left with a
// relative specifier an ESM resolver cannot follow. `import('…')` is excluded
// from this scan because a dynamic specifier can be built at runtime; the
// statement forms cannot.
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

// `"type": "module"` scopes this directory to ES modules; dist/ stays
// CommonJS. `sideEffects` is repeated because bundlers read it from the
// nearest package.json — see the header.
const marker = {
  type: 'module',
  sideEffects: false,
};
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(marker, null, 2)}\n`);

console.log(
  `[finish-esm-build] ${esmOutDir}: ${files.length} file(s), ${rewritten} specifier(s) given an ` +
    'extension, package.json written ("type": "module", sideEffects: false)',
);
