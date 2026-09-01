import type { ComponentType, ReactNode, Ref, RefAttributes } from 'react';
import { useMemo } from 'react';
import {
  Platform,
  UIManager,
  processColor,
} from 'react-native';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import type { RunTextAttribute } from './runAttributes';
import type { RunDecoration } from './runDecorations';
import type { RunPressable } from './runPressables';
import { DEFAULT_SELECTION_ACTIONS } from './selectionActions';
import type { SelectionAction } from './selectionActions';

export interface InlinePressEvent {
  /** The pressed range, UTF-16 offsets into the run's projected display
   * text, clamped against the text as currently set. Informational — the
   * id is what a handler routes on. */
  start: number;
  end: number;
  /** The identifier `RunHost` sent with the range: its index into the
   * `pressables` prop as passed, echoed back verbatim by the host. */
  pressableId: number;
}

export interface SelectionActionEvent {
  /** UTF-16 offsets into the run's projected display text. */
  start: number;
  end: number;
  /**
   * Which selection-menu action fired. Absent only under version skew (a
   * native binary older than the `action` field, whose sole custom item was
   * "Copy Markdown"); `handleSelectionAction` normalizes missing/unknown
   * values to 'copy-markdown'.
   */
  action?: SelectionAction;
  /** Informational (debugging/analytics); offsets are authoritative. */
  selectedText: string;
}

/**
 * A `RunTextAttribute` with its colours converted for the platform.
 *
 * `processColor` is the reason this shape exists: it turns every CSS colour
 * React Native accepts — hex, `rgba()`, `hsl()`, a named colour, a platform
 * colour — into the single packed integer both hosts decode. Doing it here
 * rather than in `resolveRunAttributes` keeps that module free of React
 * Native, so the styling rules stay unit-testable in plain Node.
 */
interface NativeTextAttribute extends Omit<RunTextAttribute, 'color' | 'backgroundColor'> {
  color?: ReturnType<typeof processColor>;
  backgroundColor?: ReturnType<typeof processColor>;
}

/** `RunDecoration` with its colours converted, exactly like the attributes. */
interface NativeRunDecoration
  extends Omit<RunDecoration, 'color' | 'borderColor' | 'barColor'> {
  color?: ReturnType<typeof processColor>;
  borderColor?: ReturnType<typeof processColor>;
  barColor?: ReturnType<typeof processColor>;
}

/**
 * The props of the native host, as this file needs to describe them.
 *
 * This deliberately restates the codegen spec's `NativeProps` rather than
 * importing it. The spec module must never be pulled into tsc's program — an
 * `import`, `import type` included, puts a transpiled copy of it into `dist/`,
 * and a transpiled spec is the silent degradation `tsconfig.build.json`
 * documents at length. `loadNativeHost` therefore reaches it through a
 * call-expression `require` and casts the result to this shape, which is the
 * one place the two declarations have to be kept in step.
 */
/**
 * `RunPressable` with the URL swapped for an opaque id — the wire shape of
 * the `pressables` prop. The host hit-tests taps against the ranges and
 * echoes the id back; the href never crosses the bridge, which is what keeps
 * the host free of markdown semantics (docs/SELECTION.md).
 */
interface NativePressableRange {
  /** UTF-16 offsets into `text`, end-exclusive. */
  start: number;
  end: number;
  /** Index into the `pressables` prop this component was given. */
  pressableId: number;
}

interface NativeRunHostProps {
  text: string;
  /**
   * Styled ranges over `text`. The host renders the text verbatim either
   * way — these only change how it looks, never what it is — so offsets,
   * the piece table and selection mapping are unaffected by them.
   */
  attributes: readonly NativeTextAttribute[];
  /**
   * Block chrome painted around ranges of `text` (boxes, rules, column
   * alignment). Like `attributes`, they never change what the text is; the
   * two layout-affecting fields (`textInset`, 'columns') are applied inside
   * the host's string builder so measurement stays in agreement.
   */
  decorations: readonly NativeRunDecoration[];
  pressables: readonly NativePressableRange[];
  selectable: boolean;
  selectionActions: readonly SelectionAction[];
  onSelectionAction?: (e: NativeSyntheticEvent<SelectionActionEvent>) => void;
  onInlinePress?: (e: NativeSyntheticEvent<InlinePressEvent>) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const NATIVE_HOST_NAME = 'SelectableRunHost';

/** Menu config sent when no listener exists: a menu item that visibly does
 * nothing is worse than no item, and the host cannot copy on its own. */
const NO_ACTIONS: readonly SelectionAction[] = Object.freeze([]);

/** Shared empty attribute list, so an unstyled run does not allocate one. */
const NO_ATTRIBUTES: readonly RunTextAttribute[] = Object.freeze([]);

/** Shared empty decoration list; `never[]` so the one frozen array serves
 * both the `RunDecoration` prop default and the native wire value. */
const NO_DECORATIONS: readonly never[] = Object.freeze([]);

/** Sent when no `onInlinePress` listener exists — same discipline as
 * NO_ACTIONS: a host with no ranges to report never intercepts a tap.
 * `never[]` so the one frozen array serves both the `RunPressable` prop
 * default and the `NativePressableRange` wire value. */
const NO_PRESSABLES: readonly never[] = Object.freeze([]);

/**
 * `processColor` results, keyed by the colour string that produced them.
 *
 * The attribute array is rebuilt and re-sent on every streamed snapshot, and
 * every colour in it is one of a dozen constant theme tokens — the same
 * '#1f2328' re-normalized over and over, because `processColor` re-parses its
 * argument on every call. Measurement of a real streamed transcript put
 * `.map(toNativeAttribute)` at 3.5x the cost of `resolveRunAttributes` itself
 * for that reason alone, which made colour conversion the most expensive step
 * in a pipeline that also parses markdown.
 *
 * Keyed by the string and not by the attribute object, because the strings are
 * what repeat: two marks that both resolve to `theme.colors.codeText` are two
 * distinct objects carrying one identical colour. So the map is bounded by how
 * many distinct colour strings a theme ever produces, not by the length of the
 * stream — a handful, for the lifetime of the process.
 */
const processedColors = new Map<string, ReturnType<typeof processColor>>();

function memoizedProcessColor(color: string): ReturnType<typeof processColor> {
  // `has`, not a truthiness test on `get`: `processColor` returns null for a
  // string it cannot parse, and that null is worth caching too — otherwise a
  // theme with one unparseable token pays the full parse on every snapshot,
  // which is the exact cost this exists to remove.
  if (!processedColors.has(color)) {
    processedColors.set(color, processColor(color));
  }
  return processedColors.get(color);
}

function toNativeAttribute(attribute: RunTextAttribute): NativeTextAttribute {
  const { color, backgroundColor, ...rest } = attribute;
  const native: NativeTextAttribute = { ...rest };
  // Only set the keys that were present: every entry is sparse, and a
  // `color: null` from processColor would read on the native side as "this
  // range clears the colour" rather than "this range says nothing about it".
  if (color !== undefined) native.color = memoizedProcessColor(color);
  if (backgroundColor !== undefined) {
    native.backgroundColor = memoizedProcessColor(backgroundColor);
  }
  return native;
}

function toNativeDecoration(decoration: RunDecoration): NativeRunDecoration {
  const { color, borderColor, barColor, ...rest } = decoration;
  const native: NativeRunDecoration = { ...rest };
  // Same only-if-present discipline as toNativeAttribute: an absent colour
  // must stay absent (no fill, no stroke, no bar), not become null.
  if (color !== undefined) native.color = memoizedProcessColor(color);
  if (borderColor !== undefined) {
    native.borderColor = memoizedProcessColor(borderColor);
  }
  if (barColor !== undefined) {
    native.barColor = memoizedProcessColor(barColor);
  }
  return native;
}

/** The native component with `ref` made legal to pass: commands dispatch on
 * the ref, so `RunHost` has to be able to hand one through. */
type NativeHostComponent = ComponentType<
  NativeRunHostProps & RefAttributes<unknown>
>;

let cachedNativeHost: NativeHostComponent | null | undefined;

/**
 * Resolves the native selection host once per JS runtime. Every step is
 * guarded: when the native module is not linked (Expo Go, web, tests) the JS
 * fallback renders instead of red-screening.
 */
function loadNativeHost(): NativeHostComponent | null {
  if (cachedNativeHost !== undefined) {
    return cachedNativeHost;
  }
  cachedNativeHost = resolveNativeHost();
  return cachedNativeHost;
}

/**
 * THE PROBE IS `hasViewManagerConfig`, NOT `getViewManagerConfig`, AND THAT IS
 * THE POINT. Under bridgeless — every new-architecture app — `getViewManagerConfig`
 * does not consult the Fabric component registry at all: with no ViewConfig
 * interop layer installed it raises a soft error and returns null
 * (BridgelessUIManager.js:273-291). A correctly linked Fabric component would
 * therefore be reported as missing, every run would drop to the
 * `<Text selectable>` fallback, and `onSelectionAction` and both custom menu
 * items would silently be gone on exactly the architecture this component was
 * ported for. `hasViewManagerConfig` exists on both UIManager implementations
 * and asks the right registry on each: a lazy ViewManager lookup on paper
 * (PaperUIManager.js:105-107), `unstable_hasComponent` under bridgeless
 * (BridgelessUIManager.js:292-294).
 *
 * THE PROBE MUST STAY INSIDE A BARE `catch`. `unstable_hasComponent` throws a
 * bare *string* — not an Error — when `global.__nativeComponentRegistry__hasComponent`
 * has not been installed yet (NativeComponentRegistryUnstable.js:26). A
 * `catch (e) { e.message }` reads `undefined` there, so nothing may be read off
 * the caught value; the only safe thing to do with it is to treat it as "not
 * available" and fall through.
 *
 * Once something is registered under the name, three tiers, in order:
 *
 * 1. **The codegen spec.** `./SelectableRunHostNativeComponent`, whose default
 *    export React Native's babel plugin has rewritten into
 *    `NativeComponentRegistry.get('SelectableRunHost', () => viewConfig)`. One
 *    declaration serves both architectures: `get` prefers native reflection on
 *    paper and the static view config under bridgeless
 *    (NativeComponentRegistry.js:52-72). It is reached through a
 *    call-expression `require` and not an `import`, for a reason that has
 *    nothing to do with laziness — an `import`, `import type` included, pulls
 *    the spec into tsc's program and emits a transpiled copy into `dist/`,
 *    which is precisely the silent degradation `tsconfig.build.json` exists to
 *    prevent. `require` is the one form tsc does not follow. It also has to
 *    stay a *static* string: Metro only puts the spec module in the bundle if
 *    the bundler can resolve the specifier at build time, so hiding it behind
 *    an indirection to dodge the problem below would break the path this whole
 *    tier exists for.
 *
 * 2. **null** → `RunHost` THROWS. Expo Go, web, jest, an unlinked module.
 *    There used to be a `<Text selectable>` tier here, and removing it is a
 *    deliberate trade: on the architecture this component was ported for that
 *    tier was not selection at all — iOS Fabric implements `selectable` as a
 *    long-press gesture offering a whole-block Copy menu
 *    (RCTParagraphComponentView.mm, `enableContextMenu`), with no handles and
 *    no range, and selection offsets never reached JS so no custom menu item
 *    could be offered. It rendered a document that merely *looked* selectable,
 *    and two separate defects hid behind that appearance for a release each.
 *    A run also now carries code blocks and tables, whose `children` renderers
 *    emit views that could never have lived inside a `<Text>`. See the throw
 *    in the component body for what the message says.
 *
 *    A `requireNativeComponent` tier used to sit between the two, for a
 *    consumer whose bundler resolves `main` (`dist/index.js`) rather than the
 *    `react-native` field and therefore loads the spec shim
 *    (`scripts/emit-dist-spec-shim.mjs`) instead of the real spec. It went
 *    with the old architecture: it built its view config through
 *    `getViewManagerConfig`, which soft-errors to null under bridgeless, and
 *    a null config is an invariant violation at render time
 *    (ReactNativeViewConfigRegistry.js:122). Under the package's
 *    `react-native >= 0.82` floor bridgeless is the only mode, so that tier
 *    could only ever have produced a red screen. Such a consumer now lands on
 *    tier 2 and gets the throw, which says what to fix.
 */
function resolveNativeHost(): NativeHostComponent | null {
  let registered: boolean | undefined;
  try {
    registered = UIManager.hasViewManagerConfig?.(NATIVE_HOST_NAME);
  } catch {
    return null;
  }
  if (!registered) {
    return null;
  }

  try {
    const spec = require('./SelectableRunHostNativeComponent') as {
      default?: ComponentType<NativeRunHostProps>;
    };
    if (spec.default) {
      return spec.default;
    }
  } catch {
    // The spec did not resolve — see tier 2 above for the only build in which
    // that happens, and why it is not an error.
  }

  return null;
}

export interface RunHostProps {
  /** The run's projected plain display text (drives the native host). */
  text: string;
  /**
   * Styled ranges over `text` for the native host, from
   * `resolveRunAttributes`. The JS fallback ignores them — it renders the
   * rich `children` tree instead, which carries the same styling as real
   * React Native elements.
   */
  attributes?: readonly RunTextAttribute[];
  /**
   * Block chrome over `text` for the native host, from
   * `resolveRunDecorations`: the code block's box, the table's border, row
   * rules and column alignment, the thematic break's rule. Purely additive
   * over `attributes` — a binary that predates the prop ignores it and
   * renders the flat text it rendered before.
   */
  decorations?: readonly RunDecoration[];
  /**
   * Tappable ranges over `text` for the native host, from
   * `resolveRunPressables`. The JS fallback ignores them for the same reason
   * it ignores `attributes`: its rich `children` tree already carries a per-
   * node `onPress`. Without an `onInlinePress` listener the list is not sent,
   * so the host never intercepts a tap it has nothing to do with.
   */
  pressables?: readonly RunPressable[];
  selectable: boolean;
  /**
   * Which custom items the platform selection menu offers, in order.
   * Defaults to both actions. The system Copy item is always kept on both
   * platforms regardless of this list.
   */
  selectionActions?: readonly SelectionAction[];
  /** True while the run still contains unsettled streaming content. */
  unsettledTail?: boolean;
  onSelectionAction?: (e: SelectionActionEvent) => void;
  /**
   * Fired by the native host when a single tap lands inside one of
   * `pressables`. `pressableId` is the range's index into that array, which
   * is how the caller gets back to the URL it kept: the href deliberately
   * never crosses the bridge. Native host only — the JS fallback's links
   * press through their own `<Text onPress>`.
   */
  onInlinePress?: (e: InlinePressEvent) => void;
  /**
   * View-level style for the run's box — margins, padding, background.
   *
   * `ViewStyle` and not `TextStyle`: the native host has always ignored text
   * properties passed here (it styles its text from `attributes`, which is the
   * channel that survives to both platforms' text stores), so a `fontSize` in
   * this prop silently did nothing on the path that matters. Under Fabric it
   * would be a codegen lie as well as an API one — `style` reaches the native
   * component through `ViewProps`, so there is no text style for it to land
   * in. Typography belongs to the theme, which reaches both paths.
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Selection host for one run. Requires the native 'SelectableRunHost'
 * component; there is no JS fallback, and its absence throws.
 *
 * ONE RENDERING, WHICH IS THE CHANGE. There used to be two — the native host
 * and a nested `<Text selectable>` tree built from `children` — sharing their
 * inputs so they would agree. They never fully did, and the second one was
 * actively harmful: on the architecture this component was ported for, RN's
 * `selectable` is a long-press block-Copy menu with no handles and no range, so
 * the fallback rendered a document that only looked selectable. Every failure
 * of the native path therefore degraded into something that looked almost
 * right, and two defects — a missing autolinking entry and a collapsed TextKit
 * stack — each hid there for a full release.
 *
 * The run's whole appearance now comes from `text` plus `attributes`, both
 * derived from one projection (`mapSelection`, `runAttributes`). That is also
 * what lets a run carry code blocks, tables and thematic breaks: they project
 * text and marks like anything else, whereas their `children` renderers emit
 * views that could never have lived inside a text host.
 */
export function RunHost(props: RunHostProps): ReactNode {
  const {
    text,
    attributes = NO_ATTRIBUTES,
    decorations = NO_DECORATIONS,
    pressables = NO_PRESSABLES,
    selectable,
    selectionActions = DEFAULT_SELECTION_ACTIONS,
    unsettledTail = false,
    onSelectionAction,
    onInlinePress,
    style,
    testID,
  } = props;

  // Per-platform tail policy (runs.ts emits tail runs with selectable:false
  // as a conservative default; the view decides). Android's selection
  // ActionMode misbehaves (and in some OEM builds crashes) when the text
  // under an active selection is swapped, so the unsettled tail is not
  // selectable there until it settles. iOS's host preserves selection across
  // text swaps, so the tail stays selectable.
  const effectiveSelectable = unsettledTail
    ? Platform.OS === 'ios'
    : selectable;

  // Colour conversion is per attribute and this array is re-sent on every
  // streamed snapshot, so it is memoized on the identity `resolveRunAttributes`
  // already gives us.
  const nativeAttributes = useMemo(
    () => attributes.map(toNativeAttribute),
    [attributes],
  );

  // Memoized like `attributes` and for the same reason: the list is re-sent
  // on every streamed snapshot, and `resolveRunDecorations` already gives the
  // array a stable identity per (projection, theme).
  const nativeDecorations = useMemo(
    () => decorations.map(toNativeDecoration),
    [decorations],
  );

  // The href is dropped here, on purpose: the host gets ranges and ids, and
  // the id is the index the event hands back. The mapping is trivial, but it
  // is memoized anyway because the array is re-sent on every streamed
  // snapshot, like `attributes` above.
  const nativePressables = useMemo<readonly NativePressableRange[]>(
    () =>
      pressables.map((pressable, index) => ({
        start: pressable.start,
        end: pressable.end,
        pressableId: index,
      })),
    [pressables],
  );

  const Native = loadNativeHost();
  if (!Native) {
    // THERE IS NO FALLBACK, DELIBERATELY, AND IT THROWS RATHER THAN RENDERING
    // NOTHING.
    //
    // This used to render `<Text selectable>{children ?? text}</Text>`. That
    // path is gone for two reasons. The first is that it was a lie: on iOS
    // Fabric `selectable` is a long-press block-Copy menu with no handles and
    // no range, so a binary missing the pod silently rendered a document that
    // merely looked selectable, and two separate defects hid inside that
    // silence for as long as it existed. The second is structural: runs now
    // carry code blocks, tables and rules, and the `children` tree for those
    // contains real views — rendering it inside a `<Text>` nests a view in a
    // text host, which is precisely what run segmentation exists to prevent
    // and which mis-measures on Fabric.
    //
    // Throwing, rather than returning null, because a chat surface that renders
    // no text is broken either way and a blank screen is the single hardest
    // symptom to trace back to a missing pod — as this library has now
    // demonstrated twice. A message naming the cause costs one line and cannot
    // ship unnoticed.
    throw new Error(
      'react-native-selectable-markdown: the native SelectableRunHost component is ' +
        'not registered in this binary, and there is no JS fallback. On iOS check that ' +
        "the app's generated RCTThirdPartyComponentsProvider.mm contains a " +
        '"SelectableRunHost" entry (it comes from this package\'s ' +
        'codegenConfig.ios.componentProvider), then pod install and rebuild the app — a ' +
        'JS reload cannot pick up a native component. In Expo Go, on web, or in a test ' +
        'renderer this component cannot render at all.',
    );
  }

  return (
    <Native
      attributes={nativeAttributes}
      decorations={nativeDecorations}
      onInlinePress={
        onInlinePress ? (event) => onInlinePress(event.nativeEvent) : undefined
      }
      onSelectionAction={
        onSelectionAction
          ? (event) => onSelectionAction(event.nativeEvent)
          : undefined
      }
      pressables={onInlinePress ? nativePressables : NO_PRESSABLES}
      selectable={effectiveSelectable}
      selectionActions={onSelectionAction ? selectionActions : NO_ACTIONS}
      style={style}
      testID={testID}
      text={text}
    />
  );
}
