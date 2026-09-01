/**
 * The md4c-backed engine: wire buffer in, `ParsedDocument` out.
 *
 * The split here is deliberate. `createNativeEngine` takes the *only* thing
 * that is platform-specific — a function that turns a source string into a
 * wire buffer — and everything else (decoding, span widening, policy) is
 * plain TypeScript that runs anywhere. That is what lets the same decoder
 * be exercised by the Node test addon in CI and by JSI on device, and it is
 * why a decoder bug cannot hide behind "works on my simulator".
 *
 * `nativeEngine` is the app-facing value, and it is what `parseDocument`
 * uses when no engine is passed. It resolves its parse function *lazily*: a
 * module-evaluation-time lookup would mean that merely importing the package
 * — in a Jest transform, in a bundler's static analysis, in the conformance
 * runner under plain Node — demanded a linked native module. Instead the
 * lookup happens on the first parse of a non-empty document, by which time
 * an app's `installNativeEngine()` (or a test harness's `__linkNativeEngine`)
 * has run. If nothing has, the failure surfaces there as the error below,
 * which names the build step that is missing.
 */

import type { Engine } from '../Engine';
import { decodeFlatBuffer } from './decode';
import { installNativeEngine } from './install';
import type { ParseToBuffer } from './protocol';
import { PROTOCOL_VERSION, extensionBits, htmlPolicyBit } from './protocol';

export { decodeFlatBuffer, NativeProtocolError, applySmartPunctuation } from './decode';
export type { ParseToBuffer } from './protocol';
export { PROTOCOL_VERSION } from './protocol';
// The JS half of the platform binding. Kept in its own module so that
// `require('react-native')` stays inside a function body — this file is
// loaded in plain Node by the conformance runner and the benches.
export { installNativeEngine, isNativeEngineInstalled } from './install';

/** Wrap a host parse function as an `Engine`. */
export function createNativeEngine(
  parseToBuffer: ParseToBuffer,
  name = 'native-md4c',
): Engine {
  return {
    name,
    parse(source, options) {
      // Empty input never reaches the parser: md4c would handle it fine, but
      // the crossing is pure overhead and streaming hits this case on every
      // session's first delta.
      if (source.length === 0) return { source, blocks: [] };
      const buffer = parseToBuffer(source, extensionBits(options), htmlPolicyBit());
      return decodeFlatBuffer(source, buffer, options);
    },
  };
}

/**
 * The global a host binding installs (JSI on device, the Node addon in
 * tests and benchmarks). Declared structurally so this file carries no
 * React Native or Node types.
 */
export interface NativeHostBinding {
  protocolVersion: number;
  parse: ParseToBuffer;
}

/**
 * Read the host binding, if one has installed itself into the global AND it
 * speaks this bundle's wire protocol.
 *
 * The version check belongs here rather than only in `installNativeEngine`
 * because this is the function every downstream answer is built on. A stale
 * native binary paired with a fresh JS bundle — the ordinary "I reloaded JS
 * but did not rebuild the app" state — is a binding that exists and parses;
 * without this check it would be reported as available, called, and then
 * throw a `NativeProtocolError` out of `decodeFlatBuffer` on the header word
 * of every single parse — one opaque exception per document, from deep inside
 * the decoder, saying nothing about the rebuild that would fix it. Rejecting
 * the binding here instead means the caller gets `nativeEngine`'s error, which
 * names the version skew and the rebuild, and `installNativeEngine` gets to
 * log the mismatch once. SelectableMarkdownJsi.h promises exactly this: a
 * version mismatch is reported, not decoded.
 */
export function findHostBinding(): NativeHostBinding | null {
  const host = (globalThis as { __selectableMarkdown?: NativeHostBinding })
    .__selectableMarkdown;
  if (!host || typeof host.parse !== 'function') return null;
  return host.protocolVersion === PROTOCOL_VERSION ? host : null;
}

// ---------------------------------------------------------------------------
// The app-facing engine
// ---------------------------------------------------------------------------

let linkedParse: ParseToBuffer | null = null;
let resolved: Engine | null = null;

/**
 * Install a host parse function explicitly. Called by the platform binding
 * (or by a test harness); apps normally never call it, because the JSI
 * module installs a global that `nativeEngine` finds on its own.
 */
export function __linkNativeEngine(parseToBuffer: ParseToBuffer): void {
  linkedParse = parseToBuffer;
  resolved = null;
}

/**
 * True when a native md4c module is reachable from this JS context.
 *
 * ASKS THE PLATFORM FIRST. Nothing puts `__selectableMarkdown` on the global
 * by itself — the native module exposes an `install()` that has to be called
 * from JS (see ./install and platform/ios/SelectableMarkdownModule.h for why
 * it cannot install itself). This function used to only *read* the global, so
 * it answered "no" on a device where the native module was linked and working
 * perfectly, purely because nobody had asked it to install yet. Installing
 * from here is what makes the answer true when it should be.
 *
 * Use it to *ask*, never to route around a "no". Since the native engine is
 * the only parser in the package, a `false` here is not a slower path — it
 * means markdown cannot be parsed in this JS context at all, and the useful
 * response is to surface that (or to fix the link/rebuild), not to render
 * something else. It is a diagnostic, not a feature flag.
 *
 * Cheap to call repeatedly, including from a render path: `installNativeEngine`
 * reads the global before it asks the platform for anything, and memoizes a
 * success. It never throws.
 */
export function isNativeEngineAvailable(): boolean {
  if (linkedParse !== null) return true;
  installNativeEngine();
  return findHostBinding() !== null;
}

function resolveEngine(): Engine | null {
  if (resolved) return resolved;
  if (linkedParse === null) installNativeEngine();
  const parse = linkedParse ?? findHostBinding()?.parse ?? null;
  if (!parse) return null;
  resolved = createNativeEngine(parse);
  return resolved;
}

/**
 * The md4c-backed engine, and `parseDocument`'s default.
 *
 * Full CommonMark 0.31 plus the GFM flags, decoded into the span-carrying
 * document model in `document/nodes.ts`. It is the package's only parser: if
 * the native module is not reachable from this JS context there is nothing to
 * fall back to, so the first parse of a non-empty document throws the error
 * below.
 *
 * Throwing is the deliberate choice over the two quieter alternatives.
 * Returning an empty document renders a blank screen that looks like an
 * empty-string bug in the *caller's* data layer, and returning the raw source
 * as one paragraph renders visibly-broken markdown that looks like a parser
 * bug. Both send the reader looking anywhere except at the missing build
 * step, which is why the message below names it.
 */
export const nativeEngine: Engine = {
  name: 'native-md4c',
  parse(source, options) {
    // The same short-circuit `createNativeEngine` does, repeated here so that
    // it happens BEFORE resolution rather than after it. That ordering is the
    // whole point: this is `parseDocument`'s default, so an empty document
    // must not be the thing that demands a linked native module. A screen that
    // renders `''` while its data is still in flight is the ordinary case —
    // `<SelectableMarkdown />` with no `source` parses `''` on its very first
    // render, and every empty-selection copy in `buildCopyPayload` reparses
    // `''` too — and there is nothing in an empty string for md4c to do. Left
    // below `resolveEngine()`, this would turn "the pod is missing" into a
    // render-time crash on mount in Expo Go and on web, before the app had
    // shown a single character of markdown, which is precisely the failure
    // the deliberate throw further down is meant to be *informative* about.
    if (source.length === 0) return { source, blocks: [] };
    const engine = resolveEngine();
    if (engine) return engine.parse(source, options);
    throw new Error(
      'react-native-selectable-markdown: native engine not usable. No md4c module ' +
        'installed a `__selectableMarkdown` global speaking wire protocol ' +
        `v${PROTOCOL_VERSION} in this JS context — on device that means the native ` +
        'module did not load, or loaded at a different protocol version (rebuild the ' +
        'app after adding or updating the package; a JS-only reload does not link ' +
        'native code), and in Node it means the test addon was not built ' +
        '(`node scripts/build-node-addon.mjs`). ' +
        'Markdown cannot be parsed until that is fixed: this package parses ' +
        'with md4c and ships no JavaScript parser to fall back to. If you are ' +
        'substituting your own parser, pass it as parseDocument(source, options, ' +
        'engine) — the default is only used when no engine argument is given.',
    );
  },
};
