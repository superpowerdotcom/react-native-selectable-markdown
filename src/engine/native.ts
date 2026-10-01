/**
 * Public entry point for the md4c-backed engine.
 *
 * The implementation lives in `native/` (protocol, decoder, span widening);
 * this file is the stable import path — `src/index.ts` re-exports part of it,
 * and consumers who deep-import do so as `engine/native`. Keeping the facade a
 * re-export means the directory can be reorganized without moving anyone's
 * import.
 *
 * Listed rather than `export *`, so a new helper in `native/index.ts` is not
 * published by accident.
 */

export {
  createNativeEngine,
  nativeEngine,
  installNativeEngine,
  isNativeEngineAvailable,
  isNativeEngineInstalled,
  isNativeEnginePermanentlyRefused,
  findHostBinding,
  __linkNativeEngine,
  decodeFlatBuffer,
  NativeProtocolError,
  applySmartPunctuation,
  PROTOCOL_VERSION,
} from './native/index';
export type { NativeHostBinding, ParseToBuffer } from './native/index';
