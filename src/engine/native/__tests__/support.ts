/**
 * Test-only loader for the compiled md4c module.
 *
 * WHY THESE TESTS MAY SKIP, NOW THAT MD4C IS THE ONLY PARSER. The package
 * ships no JavaScript parser: `parseDocument` with no engine argument goes to
 * `nativeEngine`, and if nothing has linked a host binding it throws rather
 * than degrading. So a machine with no C compiler (or no Node headers) cannot
 * parse markdown at all, and every suite below the engine would fail on it.
 *
 * That is still not a broken checkout — it is an unequipped machine, and it
 * is a configuration this repository supports for the work that needs no
 * parser (the wire-format parity checks, the pure span arithmetic, the
 * document model, the session mechanics over a hand-built engine). Turning
 * `npx jest` red on it would train everyone to ignore a red suite, and the
 * signal that actually matters — "md4c disagrees with what we asserted" —
 * would be buried under a hundred "no compiler here" failures. `describeNative`
 * therefore degrades to `describe.skip`, which REPORTS the block as skipped
 * rather than silently passing an empty suite, so the difference between
 * "green" and "green, and 400 cases never ran" is visible on the console.
 *
 * CI builds the addon, so the skip is a developer-machine affordance and not
 * a way for a real failure to hide.
 *
 * What is NOT tolerated: a module that exists but fails to load, or a build
 * that fails after starting. Those mean the native code is broken rather
 * than the machine being unequipped, and the loader lets that error escape.
 *
 * The build runs at most once per Jest worker process (module state is
 * per-process, and Jest gives each test file a fresh module registry only
 * within a worker), and only when the module is missing — exactly the
 * contract `native/node/index.mjs` offers the conformance runner and the
 * benchmarks. Those are ESM and cannot be imported from a CommonJS Jest
 * transform, which is why this file re-implements the three lines rather
 * than importing them.
 *
 * At most once per worker still means five at once on a cold checkout: five
 * suites load the addon, in five processes, and none of them can see the
 * others. What makes that safe is on the other side of the spawn —
 * scripts/build-node-addon.mjs serializes the build behind a directory lock
 * and publishes the finished module with a rename — so the `existsSync`
 * below is never true for a file a linker is still writing, and the workers
 * that lose the race wait rather than skipping their native suites. See "WHY
 * THERE IS A LOCK" in that script.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { Engine } from '../../Engine';
import { __linkNativeEngine, createNativeEngine } from '../index';
import type { ParseToBuffer } from '../protocol';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// Keyed by platform/arch, matching scripts/build-node-addon.mjs and
// native/node/index.mjs, so an arm64 Node and an x86_64 Node (Rosetta) on the
// same machine each build and load their own module rather than the first
// one's artifact blocking the other with a dlopen architecture error.
const ADDON_PATH = path.join(
  REPO_ROOT,
  'build',
  `selectable-markdown.${process.platform}-${process.arch}.node`,
);
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-node-addon.mjs');

/** The surface `native/node/addon.cpp` exports through N-API. */
export interface NativeAddon {
  parse: ParseToBuffer;
  protocolVersion: number;
}

let attempted = false;
let addon: NativeAddon | null = null;
let engine: Engine | null = null;

/**
 * `--if-available` makes the script exit 0 with an explanation when the
 * machine has no compiler or no Node headers, instead of printing an ERROR
 * banner a reader would reasonably mistake for a test failure. A real
 * compile or link error still exits non-zero — and then the module is still
 * missing, so this file reports "unavailable" and the tests skip. That is
 * the one place the distinction is lost, which is why the build script's own
 * output is inherited: whatever went wrong is on the console verbatim.
 */
function buildOnce(): void {
  if (!existsSync(BUILD_SCRIPT)) return;
  spawnSync(process.execPath, [BUILD_SCRIPT, '--if-available'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function load(): NativeAddon | null {
  if (attempted) return addon;
  attempted = true;
  if (!existsSync(ADDON_PATH)) buildOnce();
  if (!existsSync(ADDON_PATH)) return null;
  // Deliberately unguarded: a module that exists but will not dlopen is a
  // real failure (wrong architecture, wrong Node ABI, undefined symbol), and
  // swallowing it would turn a broken native build into a silent skip.
  // `require` rather than an import: the path is a runtime value and the
  // target is a .node binary, which no module resolver can type.
  addon = require(ADDON_PATH) as NativeAddon;
  return addon;
}

/** The compiled module, or null when this machine cannot build it. */
export function nativeAddonOrNull(): NativeAddon | null {
  return load();
}

/**
 * The md4c-backed `Engine`, or null when the module is unavailable. The
 * engine is built once and reused: `createNativeEngine` is pure, but a
 * shared instance keeps `toEqual` comparisons free of incidental identity
 * differences and matches how an app holds exactly one engine.
 */
export function nativeEngineOrNull(): Engine | null {
  if (engine) return engine;
  const host = load();
  if (!host) return null;
  engine = createNativeEngine(host.parse);
  return engine;
}

/**
 * `describe` when the native module is reachable, `describe.skip` otherwise.
 * Resolved at module load so the decision is made before Jest collects the
 * blocks, and so one build attempt covers every block in the file.
 */
export const nativeAvailable: boolean = nativeEngineOrNull() !== null;
export const describeNative: jest.Describe = nativeAvailable ? describe : describe.skip;

/**
 * Fails loudly instead of returning null. Only ever called from inside a
 * `describeNative` block, where availability is already established; the
 * throw exists so a `null` cannot quietly turn an assertion vacuous.
 */
export function requireNativeEngine(): Engine {
  const found = nativeEngineOrNull();
  if (!found) throw new Error('native engine unavailable inside a describeNative block');
  return found;
}

/**
 * Make `parseDocument(source, options)` — no engine argument — work for the
 * rest of this Jest worker, and report whether it will.
 *
 * Most suites in this repository are not testing the engine; they are testing
 * selection, streaming, projection or the view layer, and they reach for the
 * package's own default the way an app does. On device that default resolves
 * itself, because the platform binding installs a `__selectableMarkdown`
 * global at startup. In Node nothing installs one, so the default would throw
 * — which is exactly the behaviour `engine.test.ts` pins, and exactly what
 * these suites must not spend their assertions on. Linking the addon here
 * puts a Node worker in the state a launched app is already in.
 *
 * `__linkNativeEngine` rather than a global assignment because it is the
 * supported hook, it invalidates the memoized engine, and it bypasses the
 * platform probe entirely — so a suite that also mocks `react-native` (the
 * view tests do) cannot accidentally route this through a fake module.
 *
 * Returns the same answer as `nativeAvailable`, so a caller can write
 * `const describeParsing = linkNativeEngineAsDefault() ? describe : describe.skip`
 * — but prefer pairing it with `describeNative`, which reads the same state.
 */
export function linkNativeEngineAsDefault(): boolean {
  const host = load();
  if (!host) return false;
  __linkNativeEngine(host.parse);
  return true;
}
