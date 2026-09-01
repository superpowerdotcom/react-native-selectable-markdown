#!/usr/bin/env node
// Emits the one file `tsc -p tsconfig.build.json` deliberately does not:
// dist/view/SelectableRunHostNativeComponent.js.
//
// WHY A FILE THAT EXPORTS NOTHING HAS TO EXIST
// -------------------------------------------
// `src/view/RunHost.tsx` reaches the codegen spec through a call-expression
// `require('./SelectableRunHostNativeComponent')`, and that form is load-bearing
// twice over. It is a `require` rather than an `import` because an `import` —
// `import type` included — pulls the spec into tsc's program and emits a
// transpiled copy into `dist/`, which silently disables React Native's codegen
// babel plugin (the long comment in tsconfig.build.json has the mechanism). And
// it is *static* rather than obscured because Metro has to see it: the spec
// module only reaches a consuming app's bundle if the bundler can resolve the
// require at build time.
//
// Those two requirements together produce a module that is referenced from
// `dist/` and absent from `dist/`, and a static reference to a module that does
// not exist is not a runtime fallback — it is a **build error in a stranger's
// CI**. Metro resolves `react-native` → `src/index.ts` and never sees `dist/`,
// but webpack, Rollup, Vite, Parcel and Next resolve `main`, walk the CJS graph
// ahead of time, and stop with
//
//     Module not found: Can't resolve './SelectableRunHostNativeComponent'
//
// naming our file, in their build. react-native-web under any of those bundlers
// is exactly that case, and `RunHost.tsx` names web as a supported tier-3
// target. The `try/catch` around the require does not help: resolution happens
// before any code runs.
//
// So the reference resolves, and resolves to nothing. `module.exports = {}`
// leaves `spec.default` undefined, which is precisely the condition
// `resolveNativeHost` tier 2 is written for — a bundler that resolved `main`
// gets `requireNativeComponent` on the old architecture and the
// `<Text selectable>` fallback under bridgeless, the same degradation this
// library shipped before Fabric existed.
//
// WHAT THIS FILE MUST NEVER BECOME
// --------------------------------
// A transpiled copy of the spec. That is the silent failure the exclusion in
// tsconfig.build.json exists to prevent, and it looks almost identical on disk:
// same path, same name. The difference is one string — a transpiled copy calls
// `codegenNativeComponent`, this shim does not mention it — so that is what
// `scripts/verify-pack.mjs` keys its assertion on rather than the filename.
// Keying on the filename is what made this fix impossible to land before: the
// check read "any file under dist/ whose name starts with the spec's" as proof
// of a leak, which is also a perfect description of the shim.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read out of tsconfig.build.json rather than hardcoded, because the shim has
// to land at the exact path tsc's rootDir/outDir mapping would have put the
// transpiled spec at. A directory reorganisation that moved one and not the
// other would restore the dangling require while every check still passed.
const buildConfig = fs.readFileSync(path.join(repoRoot, 'tsconfig.build.json'), 'utf8');
// tsconfig files are JSON with comments, and this one has a 20-line comment in
// the middle of `exclude`. Strip line comments before parsing; there are no
// block comments and no string literals containing `//`.
const config = JSON.parse(buildConfig.replace(/^\s*\/\/.*$/gm, ''));
const rootDir = config.compilerOptions?.rootDir;
const outDir = config.compilerOptions?.outDir;
const spec = (config.exclude ?? []).find((entry) => entry.endsWith('SelectableRunHostNativeComponent.ts'));

if (!rootDir || !outDir || !spec) {
  console.error(
    '[emit-dist-spec-shim] tsconfig.build.json no longer declares rootDir, outDir and an\n' +
      '                     exclusion for the codegen spec. One of the three moved, so this\n' +
      '                     script cannot know where the shim belongs — and dist/view/RunHost.js\n' +
      "                     would ship a require of a module that isn't there.",
  );
  process.exit(1);
}

const target = path.join(repoRoot, outDir, path.relative(rootDir, spec).replace(/\.ts$/, '.js'));

const SHIM = `// Emitted by scripts/emit-dist-spec-shim.mjs. NOT a transpiled copy of
// src/view/SelectableRunHostNativeComponent.ts — that file is excluded from
// this build on purpose, because transpiling it silently disables React
// Native's codegen babel plugin and every run drops to the <Text selectable>
// fallback with no error anywhere.
//
// This module exists so that the static require in dist/view/RunHost.js
// resolves. A bundler that follows package.json "main" (webpack, Rollup, Vite,
// Parcel, Next — i.e. react-native-web) resolves the whole CJS graph at build
// time and fails hard on a reference it cannot follow. Metro follows the
// "react-native" field to src/ instead and loads the real spec.
//
// Exporting nothing is the contract: dist/view/RunHost.js sees no \`default\`,
// falls through to requireNativeComponent on the old architecture, and to the
// <Text selectable> fallback under bridgeless. See resolveNativeHost tier 2.
module.exports = {};
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, SHIM);
console.log(`[emit-dist-spec-shim] wrote ${path.relative(repoRoot, target)}`);
