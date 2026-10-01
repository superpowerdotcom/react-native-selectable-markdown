/**
 * The headless STREAMING entry: `react-native-selectable-markdown/stream`.
 *
 * Same purpose as src/engine.ts: the streaming session, tail repair, the
 * smoothers and the ag-ui run binding, reachable without the view layer and
 * therefore without `react-native` — a consumer's stream bus and its tests
 * run in plain Node. Nothing from `view/`, no star re-exports.
 *
 * Reached through the `./stream` entry of package.json's `exports`:
 * `react-native` → this file, `require` → dist/stream.js, `import` →
 * dist/esm/stream.js.
 */
export { StreamSession } from './stream/StreamSession';
export type {
  BufferScheduler,
  IdleScheduler,
  SessionSnapshot,
  StreamSessionInit,
} from './stream/StreamSession';
export { createAdaptiveSmoother, createSmoother } from './stream/smoothing';
export type { AdaptiveSmootherOptions, Smoother, SmootherOptions } from './stream/smoothing';
export { repairTail } from './stream/repair';
export type { RepairOptions } from './stream/repair';
export { bindRunTextEvents } from './agui/bindRunTextEvents';
export type { RunSessionStore, RunBindingPolicy } from './agui/bindRunTextEvents';
export type { RunFailureInfo, TextMessageEvents } from './agui/useAgUiSession';
