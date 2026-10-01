/**
 * The headless ENGINE entry: `react-native-selectable-markdown/engine`.
 *
 * The package root re-exports the view layer, which imports `react-native` at
 * load time, so plain Node — a consumer's jest, a script that splits or copies
 * markdown server-side — cannot load it. This file is the parser and the
 * document walk without any of that: what `src/index.ts` publishes from
 * `engine/` and `document/`, nothing from `view/`, and no star re-exports (the
 * same rule as the root, for the same reason — see src/index.test.ts).
 *
 * Reached through the `./engine` entry of package.json's `exports`, under the
 * same three conditions as the root: `react-native` → this file, `require` →
 * dist/engine.js, `import` → dist/esm/engine.js.
 */
export { visit } from './document/visit';
export type { Visitor, VisitSignal } from './document/visit';
export { parseDocument } from './engine/Engine';
export type { Engine } from './engine/Engine';
export { presets, resolveOptions, withOptions } from './engine/options';
export type { EngineOptions, ResolvedEngineOptions } from './engine/options';
