/**
 * Loader for the Node test/bench addon.
 *
 * Importing this module is the whole contract: it makes sure the compiled
 * addon for THIS interpreter exists (building it on first use) and hands
 * back the same three things every caller needs. Tests and benches import
 * this, never the .node file directly, so that a fresh clone runs
 * `node --test` without a separate build step in the README.
 *
 * The build is spawned only when the module is MISSING, not when it is
 * stale — probing five source mtimes on every import would tax the common
 * case to catch the rare one, and the build script is already incremental.
 * After editing C++, run `node scripts/build-node-addon.mjs` (add `--force`
 * to distrust the object cache).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** Absolute path of the compiled module. Exported so failures can name it.
 * Keyed by platform/arch, matching scripts/build-node-addon.mjs, so an arm64
 * Node and an x86_64 Node (Rosetta) each build and load their own module
 * instead of tripping over one shared file. */
export const addonPath = path.join(
  repoRoot,
  'build',
  `selectable-markdown.${process.platform}-${process.arch}.node`,
);

const buildScript = path.join(repoRoot, 'scripts', 'build-node-addon.mjs');

/**
 * Everything that can go wrong here is a toolchain problem on the developer's
 * machine, so every message says what to install or run rather than dumping
 * a spawn errno.
 */
function buildOnce() {
  if (!existsSync(buildScript)) {
    throw new Error(
      `selectable-markdown: build script missing at ${buildScript}. ` +
        'The native harness cannot be built from this checkout.',
    );
  }
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(
      `selectable-markdown: could not run the native build (${result.error.message}). ` +
        `Run it yourself to see why:\n  node ${path.relative(repoRoot, buildScript)}`,
    );
  }
  if (result.status !== 0 || !existsSync(addonPath)) {
    throw new Error(
      'selectable-markdown: the native addon failed to build ' +
        `(exit ${result.status}).\n` +
        'This harness needs a working C/C++ toolchain and the Node C headers:\n' +
        '  - macOS: xcode-select --install\n' +
        '  - Linux: a clang or gcc on PATH, plus your distro\'s nodejs-dev headers\n' +
        `Then re-run:\n  node ${path.relative(repoRoot, buildScript)}`,
    );
  }
}

if (!existsSync(addonPath)) {
  buildOnce();
}

const require = createRequire(import.meta.url);

let addon;
try {
  addon = require(addonPath);
} catch (error) {
  /* A load failure after a successful build is almost always an
   * architecture or Node-version mismatch — the object cache in build/obj
   * was produced for a different interpreter than the one running now. Say
   * so, because the raw dlopen message ("mach-o file, but is an incompatible
   * architecture") does not point at the fix. */
  throw new Error(
    `selectable-markdown: could not load ${addonPath} — ${error.message}\n` +
      `Built for a different Node or CPU? Rebuild from scratch:\n` +
      `  node ${path.relative(repoRoot, buildScript)} --clean && ` +
      `node ${path.relative(repoRoot, buildScript)}`,
  );
}

/**
 * parse(source, extensionBits, htmlPolicy) -> ArrayBuffer
 *
 * The bytes are the Protocol.h flat buffer, exactly as the iOS/Android
 * bindings receive them. `extensionBits` is an OR of the kExt* values and
 * `htmlPolicy` is 0 (strip) or 1 (raw); both mirror src/engine/native/
 * protocol.ts. Bad arguments throw a TypeError.
 */
export const parse = addon.parse;

/** kProtocolVersion as compiled in, for asserting against PROTOCOL_VERSION. */
export const protocolVersion = addon.protocolVersion;
