/**
 * Type re-exports stay `export type`: Metro transpiles per module with no type information.
 * The view section imports `react-native` at module scope; headless consumers use `/engine` and `/stream`.
 */

// Document model

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

// Engine: the pluggable seam, its options, and the md4c-backed default

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

// `ParseToBuffer` is public because `createNativeEngine` takes one; the rest of `engine/native` is not.
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

// Public because a substituted engine may ignore `options.urlPolicy`; `openUrl` re-checks with these.
export { sanitizeUrl, isUrlAllowed } from './engine/urlPolicy';

// Streaming

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

// Selection

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
  /**
   * @deprecated Renamed to `classifyTopLevelBlock` in 0.12.0; this alias is
   * removed in a later minor. The `classifyBlock` PROP and the `ClassifyBlock`
   * type are unaffected.
   */
  classifyTopLevelBlock as classifyBlock,
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

// ag-ui adapter

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

// View

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

// `withImageEmbeds` implements the `images` prop for consumers driving `segmentRuns`/`RunHost` directly.
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
// cross the bridge. `isReservableEmbedSize` is the filter `RunHost` applies to `embeds`.
export type { RunEmbed } from './view/runEmbeds';
export { resolveRunEmbeds, isReservableEmbedSize } from './view/runEmbeds';

// Without `createRunProjectionCache`, a consumer driving `RunHost` reprojects each settle in O(document).
export type { RunProjectionCache } from './view/projectionCache';
export { createRunProjectionCache } from './view/projectionCache';

// Consumers driving `RunHost` need `mapSourceToRunRange` to call `RunHostHandle.setSelection`.
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
