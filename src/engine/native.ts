/**
 * Public entry point for the md4c-backed engine.
 *
 * The implementation lives in `native/` (protocol, decoder, span widening);
 * this file is the stable import path — `src/index.ts` re-exports it, and
 * consumers who deep-import do so as `engine/native`. Keeping the facade a
 * one-line re-export means the directory can be reorganized without moving
 * anyone's import.
 */

export * from './native/index';
