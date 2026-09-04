#!/usr/bin/env node
// Emits the files `tsc` deliberately does not: a shim for the codegen spec and
// its .d.ts sibling, once per emitted tree —
// dist/view/SelectableRunHostNativeComponent.{js,d.ts} for the CommonJS build
// and dist/esm/view/SelectableRunHostNativeComponent.{js,d.ts} for the ES
// module one.
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
// CI**. Metro takes the `react-native` condition in `exports` (or, before
// Metro read `exports`, the `react-native` field) to `src/index.ts` and never
// sees `dist/`, but webpack, Rollup, Vite, Parcel and Next resolve the default
// condition to `main`, walk the CJS graph ahead of time, and stop with
//
//     Module not found: Can't resolve './SelectableRunHostNativeComponent'
//
// naming our file, in their build. react-native-web under any of those
// bundlers is exactly that case, and the error does not wait for anything to
// render: it stops the bundle of an app that only ever calls the headless half
// of this package. The `try/catch` around the require does not help either —
// resolution happens before any code runs.
//
// So the reference resolves, and resolves to nothing. `module.exports = {}`
// leaves `spec.default` undefined, which is precisely the condition
// `resolveNativeHost`'s last tier is written for: a bundle built from `main`
// never loaded the real spec, so `RunHost` throws a message naming the missing
// native registration instead of dangling on a module that is not there. The
// `requireNativeComponent` tier that used to catch this case, and the
// `<Text selectable>` fallback under it, both went with the old architecture
// in 0.10.0 — under the package's `react-native >= 0.82` floor bridgeless is
// the only mode, and neither tier can render there.
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
//
// AND WHY THERE IS A .d.ts NEXT TO IT
// -----------------------------------
// package.json's `./dist/*` subpath export declares its types as
// `./dist/*.d.ts`. Every other file under dist/ gets one from tsc; this one
// cannot, for the same reason its .js cannot. Without it a TypeScript consumer
// that deep-imports this path gets an unresolved-types error (not an implicit
// any — the types condition names a file that is not there), and `tsc` on the
// package's own `./dist/*` map has one hole in it.
//
// It declares the PROP CONTRACT by re-exporting it from the untranspiled spec
// in src/, which ships in the same tarball, so there is one declaration and no
// copy to drift. It declares NO runtime value, because the .js beside it
// exports none: typing a `default` here would tell a bundle that resolved
// `main` that the component exists, which is exactly the claim `RunHost`'s
// throw exists to deny.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read out of the tsconfigs rather than hardcoded, because the shim has to
// land at the exact path tsc's rootDir/outDir mapping would have put the
// transpiled spec at — in BOTH trees. A directory reorganisation that moved one
// and not the other would restore the dangling require while every check still
// passed.
//
// tsconfig files are JSON with comments, and tsconfig.build.json carries a long
// one in the middle of `exclude`. Strip line comments before parsing; there are
// no block comments and no string literals containing `//`.
const readTsconfig = (file) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

const config = readTsconfig('tsconfig.build.json');
const rootDir = config.compilerOptions?.rootDir;
const outDir = config.compilerOptions?.outDir;
const spec = (config.exclude ?? []).find((entry) => entry.endsWith('SelectableRunHostNativeComponent.ts'));
// The ES module build inherits rootDir and the exclusion from that config and
// overrides only outDir, so it needs a shim of its own at the mirrored path.
const esmOutDir = readTsconfig('tsconfig.esm.json').compilerOptions?.outDir;

if (!rootDir || !outDir || !spec || !esmOutDir) {
  console.error(
    '[emit-dist-spec-shim] the tsconfigs no longer declare rootDir, an outDir each and an\n' +
      '                     exclusion for the codegen spec. One of them moved, so this\n' +
      '                     script cannot know where the shim belongs — and dist/view/RunHost.js\n' +
      "                     would ship a require of a module that isn't there.",
  );
  process.exit(1);
}

/**
 * Where the shim and its declaration belong under one outDir, and how that
 * declaration has to spell the path back to the untranspiled spec: relative,
 * from the directory it lands in to src/. Derived rather than hardcoded for the
 * same reason the emit path is — rootDir/outDir move together or the reference
 * dangles.
 *
 * The ES module tree gets the `.js` extension on that reference and the
 * CommonJS tree does not, because TypeScript's `node16` resolution requires one
 * inside an ES module scope (dist/esm/package.json says `"type": "module"`) and
 * resolves `./x.js` to the `x.ts` that is really there.
 */
const targetsFor = (dir, { extensionOnTypeReference }) => {
  const emitted = path.join(repoRoot, dir, path.relative(rootDir, spec));
  const declaration = emitted.replace(/\.ts$/, '.d.ts');
  const specFrom = path
    .relative(path.dirname(declaration), path.join(repoRoot, spec))
    .replace(/\.ts$/, extensionOnTypeReference ? '.js' : '')
    .split(path.sep)
    .join('/');
  return { shim: emitted.replace(/\.ts$/, '.js'), declaration, specFrom };
};

const cjs = targetsFor(outDir, { extensionOnTypeReference: false });
const esm = targetsFor(esmOutDir, { extensionOnTypeReference: true });
const target = cjs.shim;
const declaration = cjs.declaration;
const specFromDist = cjs.specFrom;

const SHIM = `// Emitted by scripts/emit-dist-spec-shim.mjs. NOT a transpiled copy of
// src/view/SelectableRunHostNativeComponent.ts — that file is excluded from
// this build on purpose, because transpiling it disables React Native's
// codegen babel plugin with no build error, and a run that reaches the native
// host through the result renders with a null view config under bridgeless.
//
// This module exists so that the static require in dist/view/RunHost.js
// resolves. A bundler that follows package.json "main" (webpack, Rollup, Vite,
// Parcel, Next — i.e. react-native-web) resolves the whole CJS graph at build
// time and fails hard on a reference it cannot follow. Metro takes the
// "react-native" condition to src/ instead and loads the real spec.
//
// Exporting nothing is the contract: dist/view/RunHost.js sees no \`default\`
// and throws an error naming the missing native registration, which is the
// only honest answer in a bundle that never loaded the real spec. There is no
// JS fallback under it — the requireNativeComponent and <Text selectable>
// tiers were removed in 0.10.0. See resolveNativeHost in RunHost.
module.exports = {};
`;

const declarationText = (specFrom) => `// Emitted by scripts/emit-dist-spec-shim.mjs beside the .js shim, and NOT a
// declaration of a transpiled copy — see that script for why the spec is
// excluded from this build.
//
// package.json's \`./dist/*\` export declares its types as \`./dist/*.d.ts\`, so
// this path needs a declaration or a TypeScript consumer deep-importing it
// gets an unresolved-types error. The prop contract is re-exported from the
// untranspiled spec in src/ — which ships in the same tarball — so there is
// one declaration of it and nothing here to drift.
//
// No value is declared. The module beside this one exports nothing at runtime
// (\`module.exports = {}\`), which is the contract: a bundle that resolved
// "main" never loaded the real spec, and dist/view/RunHost.js turns that into
// an error naming the missing native registration. Declaring a \`default\` here
// would type a component that is not there.
export type { NativeProps } from '${specFrom}';
`;

const DECLARATION = declarationText(specFromDist);

// The ES module tree's shim. Same contract as the CommonJS one — it exports
// nothing, so `resolveNativeHost` takes the tier that names the missing native
// registration — spelled as an ES module because dist/esm is a `"type":
// "module"` scope. `require` does not exist in that scope at all, so the file
// matters only for a pipeline that transforms these modules back to CommonJS
// (babel, jest) and then resolves the require; where it stays ESM the call
// throws a ReferenceError into the same `try`/`catch`.
const ESM_SHIM = `// Emitted by scripts/emit-dist-spec-shim.mjs. NOT a transpiled copy of
// src/view/SelectableRunHostNativeComponent.ts — see the CommonJS shim beside
// dist/view/RunHost.js for why that copy must never exist.
//
// The ES module counterpart of that shim: dist/esm/view/RunHost.js carries the
// same static \`require('./SelectableRunHostNativeComponent')\`, and a bundler
// that transforms this tree back to CommonJS resolves it. Exporting nothing is
// the contract — no \`default\` means RunHost throws a message naming the
// missing native registration rather than rendering with a spec it never
// loaded.
export {};
`;

const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return path.relative(repoRoot, file);
};

const written = [
  write(target, SHIM),
  write(declaration, DECLARATION),
  write(esm.shim, ESM_SHIM),
  write(esm.declaration, declarationText(esm.specFrom)),
];
console.log(`[emit-dist-spec-shim] wrote ${written.join(', ')}`);
