/**
 * The `./engine` entry must load in plain Node: nothing from `view/`, and no
 * star re-exports (see src/index.test.ts).
 */
export { visit } from './document/visit';
export type { Visitor, VisitSignal } from './document/visit';
export { parseDocument } from './engine/Engine';
export type { Engine } from './engine/Engine';
export { presets, resolveOptions, withOptions } from './engine/options';
export type { EngineOptions, ResolvedEngineOptions } from './engine/options';
