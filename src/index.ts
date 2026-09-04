/**
 * The public API barrel: EVERY name a consumer is meant to import from the
 * package root, written out one by one.
 *
 * WHY THE LIST IS EXPLICIT. This file used to be two dozen `export *` lines,
 * publishing whatever those modules happened to export — 167 symbols at the
 * commit the audit measured, among them `__linkNativeEngine` (a test harness
 * lever, `__`-prefixed precisely so nobody would call it), the wire codec for
 * the selection menu, the flat-buffer decoder's entry points, and a
 * `classifyBlock` FUNCTION whose name collided with the `classifyBlock` PROP
 * of `<SelectableMarkdown>`. An `export *` barrel makes the public surface a
 * side effect of internal module boundaries: moving a helper one file over
 * publishes it, and nothing in code review looks like an API change. Naming
 * each export makes adding one a visible edit.
 *
 * (Both figures are reproducible with the TypeScript checker's
 * `getExportsOfModule` on this file: 167 against a `git archive` of the
 * pre-fix commit, 190 against the list below. The nineteen internals the
 * changeover dropped are itemised in CHANGELOG.md; the rest of the difference
 * is public API added since.)
 *
 * WHAT IS NOT HERE IS STILL REACHABLE. Nothing was made private — the internals
 * simply stopped being part of the root's contract. A decoder test, a bench,
 * or a consumer who genuinely needs an internal imports it by path and takes
 * the usual deep-import risk: those paths carry no stability promise.
 *
 * The two subpath patterns in `package.json` do NOT behave alike, and the
 * difference is the extension. `"./dist/*"` maps to `"./dist/*.js"` (with the
 * matching `.d.ts` for types), so the extensionless
 * `react-native-selectable-markdown/dist/engine/native` resolves —
 * `.../dist/stream/repair` and `.../dist/view/selectionActions` too.
 * `"./src/*"` maps to `"./src/*"` verbatim, and an exports map performs no
 * extension search of its own, so the source path needs its suffix:
 * `.../src/engine/native.ts`, not `.../src/engine/native`.
 *
 * TYPE EXPORTS ARE `export type`. Metro transpiles this file per-module with no
 * type information, so a value-shaped re-export of an interface would survive
 * into the emitted JS as a runtime lookup for a name that does not exist.
 *
 * THE VIEW SECTION IMPORTS `react-native` AT MODULE SCOPE, which is what makes
 * this barrel unloadable in plain Node. The document, engine and stream layers
 * are not — they reach native only through the lazy require in
 * `engine/native/install.ts` — so a headless consumer imports those deep paths
 * (`dist/engine/Engine`, `dist/stream/StreamSession`) rather than the package
 * root, the way `conformance/run-commonmark.mjs` does.
 */

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export type { SourceSpan } from './document/span';
export {
  spanLength,
  spanContains,
  spanIntersects,
  sliceSpan,
} from './document/span';

export type {
  NodeBase,
  HeadingLevel,
  TableAlignment,
  ParagraphNode,
  HeadingNode,
  CodeBlockNode,
  BlockquoteNode,
  ListNode,
  ListItemNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  ThematicBreakNode,
  HtmlBlockNode,
  TextNode,
  EmphasisNode,
  StrongNode,
  StrikethroughNode,
  UnderlineNode,
  CodeSpanNode,
  LinkNode,
  ImageNode,
  AutolinkNode,
  HardBreakNode,
  SoftBreakNode,
  MathNode,
  SpoilerNode,
  HtmlSpanNode,
  Block,
  Inline,
  AnyNode,
  ParsedDocument,
} from './document/nodes';
export { isBlock, isInline } from './document/nodes';

export type { VisitSignal, Visitor } from './document/visit';
export { visit, findAt, childrenOf } from './document/visit';

// ---------------------------------------------------------------------------
// Engine: the pluggable seam, its options, and the md4c-backed default
// ---------------------------------------------------------------------------

export type {
  ExtensionFlags,
  BlockedLinkBehavior,
  EngineOptions,
  ResolvedEngineOptions,
} from './engine/options';
export {
  DEFAULT_LINK_PREFIXES,
  DEFAULT_IMAGE_PREFIXES,
  resolveOptions,
  withOptions,
  presets,
} from './engine/options';

export type { Engine } from './engine/Engine';
export { parseDocument } from './engine/Engine';

// `ParseToBuffer` is here because `createNativeEngine` takes one: an engine
// author wrapping their own md4c build has to be able to name the argument.
// The rest of `engine/native` — the flat-buffer decoder, the wire protocol
// version, the host-binding lookup, and `__linkNativeEngine` — is reachable at
// `dist/engine/native` and is not part of the root's contract.
export type { ParseToBuffer } from './engine/native';
export {
  createNativeEngine,
  nativeEngine,
  installNativeEngine,
  isNativeEngineAvailable,
  isNativeEngineInstalled,
  isNativeEnginePermanentlyRefused,
} from './engine/native';

export { applySpoilers } from './engine/extensions/spoilers';

// The URL allowlist itself. Exported because it is NOT an invariant of
// `parseDocument`: the md4c decoder applies it as it builds each node, and a
// substituted engine is told that honouring `options.urlPolicy` is optional,
// so an engine author needs the same two functions rather than a
// reimplementation of them. The view re-checks with these at press time
// (`openUrl`), which is what makes the policy hold for any engine.
export { sanitizeUrl, isUrlAllowed } from './engine/urlPolicy';

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type {
  SessionPhase,
  SessionSnapshot,
  BufferScheduler,
  IdleScheduler,
  StreamSessionInit,
} from './stream/StreamSession';
export { StreamSession } from './stream/StreamSession';

export type {
  Smoother,
  SmootherContext,
  SmootherOptions,
  AdaptiveSmoother,
  AdaptiveSmootherOptions,
  SnapPastLinkDestinationOptions,
} from './stream/smoothing';
export {
  createSmoother,
  createAdaptiveSmoother,
  LINK_SNAP_WINDOW,
  snapPastLinkDestination,
} from './stream/smoothing';

export type {
  RepairSeed,
  RepairResult,
  RepairScan,
  RepairOptions,
} from './stream/repair';
export { repairTail, seedFromSettled, continueSeed } from './stream/repair';

export { trimTrailingPlaceholders } from './stream/placeholders';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// `classifyTopLevelBlock` is the rule `segmentRuns` applies; `ClassifyBlock`
// is the type of the `classifyBlock` PROP that overrides it. The function was
// called `classifyBlock` too until 0.12, which put three spellings of one idea
// at the package root and made "call classifyBlock" ambiguous in every
// sentence that used it.
export type {
  RunSegment,
  BlockClass,
  ClassifyBlock,
  EmbedContent,
  EmbedClaimContext,
  EmbedLookup,
} from './selection/runs';
export {
  classifyTopLevelBlock,
  segmentRuns,
  DEFAULT_MAX_RUN_CHARS,
} from './selection/runs';

export type {
  ProjectedRun,
  ProjectedExtent,
  ProjectedRunEmbed,
  RunPiece,
  RunMark,
  MarkKind,
  ProjectionGlyphs,
  ProjectRunOptions,
  PreviousProjection,
} from './selection/mapSelection';
export {
  projectRun,
  mapSelectionToSource,
  EMBED_PLACEHOLDER,
} from './selection/mapSelection';

export type { CopyContext } from './selection/copy';
export { buildCopyPayload } from './selection/copy';

// ---------------------------------------------------------------------------
// ag-ui adapter
// ---------------------------------------------------------------------------

export type {
  RunFailureInfo,
  TextMessageEvents,
  SessionSink,
  BufferedSessionSink,
  MessageBindingOptions,
  UseAgUiSessionInit,
  UseAgUiSessionOptions,
} from './agui/useAgUiSession';
export { bindMessageEvents, useAgUiSession } from './agui/useAgUiSession';

export type {
  RunSessionSink,
  RunSessionStore,
  RunBindingPolicy,
  UseAgUiRunSessionsInit,
} from './agui/bindRunTextEvents';
export { bindRunTextEvents, useAgUiRunSessions } from './agui/bindRunTextEvents';

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export type {
  ThemeFontWeight,
  MarkdownTheme,
  PartialTheme,
} from './view/theme';
export {
  defaultTheme,
  defaultDarkTheme,
  mergeTheme,
  headingFontSize,
} from './view/theme';

export type {
  RenderContext,
  NodeKind,
  NodeRenderer,
  RendererMap,
  RendererOverrides,
} from './view/renderers';
export {
  defaultRenderers,
  resolveRenderers,
  renderNode,
  renderInlines,
  renderBlocks,
  openUrl,
  textContentOf,
  MAX_RENDER_DEPTH,
} from './view/renderers';

// `images` is a `SelectableMarkdown` prop, but `withImageEmbeds` is what
// implements it — a consumer driving `segmentRuns`/`RunHost` themselves needs
// the same built-in claim to get the same runs.
export type { ImageMode } from './view/imageEmbeds';
export { withImageEmbeds } from './view/imageEmbeds';

// `RunHostProps.attributes` is public API and its element type was previously
// unnameable from the package entry: a consumer could pass the array but not
// write down what was in it. That is untenable now that the same shape is also
// the native prop contract — `RunTextAttribute` is what `NativeRunTextAttribute`
// in the codegen spec mirrors, field for field.
export type {
  RunSemanticRole,
  RunTextAttribute,
  RunMarkStyle,
  MarkAttribute,
} from './view/runAttributes';
export { resolveRunAttributes } from './view/runAttributes';

// Same reasoning as runAttributes: `RunHostProps.pressables` is public API,
// so its element type must be nameable from the package entry.
export type { RunPressable } from './view/runPressables';
export { resolveRunPressables } from './view/runPressables';

// And again for `RunHostProps.decorations` — `RunDecoration` is what
// `NativeRunDecoration` in the codegen spec mirrors, field for field.
export type { RunDecoration } from './view/runDecorations';
export { resolveRunDecorations } from './view/runDecorations';

// And for `RunHostProps.embeds` — `RunEmbed` is what `NativeRunEmbed` in the
// codegen spec mirrors, minus the JS-only `node`/`text` fields that never
// cross the bridge. `isReservableEmbedSize` is the guard `RunHost` applies to
// that prop, exported so a consumer filtering its own embed list drops exactly
// the entries the host would have dropped.
export type { RunEmbed } from './view/runEmbeds';
export { resolveRunEmbeds, isReservableEmbedSize } from './view/runEmbeds';

// `createRunProjectionCache` is how a consumer driving `RunHost` itself gets
// the same incremental projection `SelectableMarkdown` uses — without it, a
// settled run that grows by one block reprojects from the start, which is
// O(document) per settle. React-native-free, like `runIdentity`.
export type { RunProjectionCache } from './view/projectionCache';
export { createRunProjectionCache } from './view/projectionCache';

// `mapSourceToRunRange` is the inverse of `mapSelectionToSource`, and the one
// piece of the imperative selection API a consumer driving `RunHost` itself
// has to do for themselves: `<SelectableMarkdown>` finds the run that shows a
// `SourceSpan` and maps it before dispatching, and a caller holding their own
// projections needs the same mapping to call `RunHostHandle.setSelection`.
// React-native-free, like `projectionCache`.
export type { RunTextRange } from './view/selectionRange';
export { mapSourceToRunRange } from './view/selectionRange';

export type {
  EmbedLayoutEvent,
  InlinePressEvent,
  SelectionActionEvent,
  SelectionChangeEvent,
  RunHostHandle,
  RunHostAccessibilityProps,
  RunHostProps,
} from './view/RunHost';
export { RunHost } from './view/RunHost';

// The selection menu as a consumer declares and answers it. The WIRE codec
// underneath (`encodeSelectionActions`, `decodeSelectionAction`,
// `SELECTION_ACTION_SEPARATOR` and the two accessors) is what `RunHost` uses
// to pack the prop into the one `string[]` both hosts read; it stays at
// `dist/view/selectionActions` because a consumer passes
// `SelectionActionInput[]` and never sees the packed form.
export type {
  SelectionAction,
  SelectionActionId,
  SelectionActionSpec,
  SelectionActionInput,
  SelectionCopyEvent,
  SelectionActionContext,
} from './view/selectionActions';
export {
  DEFAULT_SELECTION_ACTIONS,
  handleSelectionAction,
  selectionDisplayText,
} from './view/selectionActions';

export type {
  SelectableMarkdownProps,
  SelectableMarkdownAccessibilityProps,
  InlineLinkPress,
  EmbedSpec,
  EmbedRenderer,
  SelectableMarkdownSelection,
  SelectableMarkdownHandle,
} from './view/SelectableMarkdown';
export { SelectableMarkdown } from './view/SelectableMarkdown';
