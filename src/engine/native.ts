/**
 * Public entry point for the md4c-backed engine.
 *
 * The implementation lives in `native/` (protocol, decoder, span widening);
 * this file is the stable import path — `src/index.ts` re-exports part of it,
 * and consumers who deep-import do so as `engine/native`. Keeping the facade a
 * re-export means the directory can be reorganized without moving anyone's
 * import.
 *
 * The list is written out rather than `export *` for the same reason
 * `src/index.ts`'s is: a facade whose contents are whatever `native/index.ts`
 * happens to export republishes every new helper by accident. What this facade
 * carries and the package root does not is the harness half — the decoder
 * entry points, the wire protocol version, the host-binding lookup and
 * `__linkNativeEngine` — which the conformance runner, the benches and an app
 * embedding its own md4c build need, and which the root deliberately does not
 * advertise.
 */

export {
  // The engine seam.
  createNativeEngine,
  nativeEngine,
  // Installation and its diagnostics.
  installNativeEngine,
  isNativeEngineAvailable,
  isNativeEngineInstalled,
  isNativeEnginePermanentlyRefused,
  findHostBinding,
  __linkNativeEngine,
  // The wire decoder, for a harness that holds a buffer rather than an engine.
  decodeFlatBuffer,
  NativeProtocolError,
  applySmartPunctuation,
  PROTOCOL_VERSION,
} from './native/index';
export type { NativeHostBinding, ParseToBuffer } from './native/index';
