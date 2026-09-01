// Document model
export * from './document/span';
export * from './document/nodes';
export * from './document/visit';

// Engine: the pluggable seam, its options, and the md4c-backed default
export * from './engine/options';
export * from './engine/Engine';
export * from './engine/native';
export * from './engine/extensions/spoilers';

// Streaming
export * from './stream/StreamSession';
export * from './stream/smoothing';
export * from './stream/repair';
export * from './stream/placeholders';

// Selection
export * from './selection/runs';
export * from './selection/mapSelection';
export * from './selection/copy';

// ag-ui adapter
export * from './agui/useAgUiSession';
export * from './agui/bindRunTextEvents';

// View
export * from './view/theme';
export * from './view/renderers';
// `RunHostProps.attributes` is public API and its element type was previously
// unnameable from the package entry: a consumer could pass the array but not
// write down what was in it. That is untenable now that the same shape is also
// the native prop contract — `RunTextAttribute` is what `NativeRunTextAttribute`
// in the codegen spec mirrors, field for field.
export * from './view/runAttributes';
// Same reasoning as runAttributes: `RunHostProps.pressables` is public API,
// so its element type must be nameable from the package entry.
export * from './view/runPressables';
// And again for `RunHostProps.decorations` — `RunDecoration` is what
// `NativeRunDecoration` in the codegen spec mirrors, field for field.
export * from './view/runDecorations';
export * from './view/RunHost';
export * from './view/SelectableMarkdown';
