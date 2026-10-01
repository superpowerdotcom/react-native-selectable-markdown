import type { ComponentType, ReactNode, Ref, RefAttributes } from 'react';
import { forwardRef, useCallback, useLayoutEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  Platform,
  UIManager,
  processColor,
} from 'react-native';
import type {
  NativeSyntheticEvent,
  StyleProp,
  ViewProps,
  ViewStyle,
} from 'react-native';
import type { RunTextAttribute } from './runAttributes';
import type { RunDecoration } from './runDecorations';
import { isReservableEmbedSize } from './runEmbeds';
import type { RunEmbed } from './runEmbeds';
import type { RunPressable } from './runPressables';
import { memoizedProcessColor } from './processedColors';
import {
  DEFAULT_SELECTION_ACTIONS,
  encodeSelectionActions,
} from './selectionActions';
import type {
  SelectionActionId,
  SelectionActionInput,
} from './selectionActions';

export interface EmbedLayoutEvent {
  /** The `RunEmbed.embedId`, echoed verbatim. Bounds-check it: a report can
   * race a prop swap by a frame, exactly like `pressableId`. */
  embedId: number;
  /** The reserved rect in the host view's coordinate space, points. */
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Absent only from a native binary older than this field, which
   * `handleSelectionAction` resolves to 'copy-markdown'. */
  action?: SelectionActionId;
  /** Informational (debugging/analytics); offsets are authoritative. */
  selectedText: string;
}

export interface SelectionChangeEvent {
  /** UTF-16 display offsets, end-exclusive. Unlike `SelectionActionEvent`,
   * `start === end` is a real payload: nothing is selected in this run. */
  start: number;
  end: number;
}

/**
 * Offsets are the run's display offsets, not source spans. Every method is a
 * no-op when the host is not mounted.
 */
export interface RunHostHandle {
  clearSelection(): void;
  /**
   * Returns false when nothing was dispatched: unmounted, not selectable on
   * this platform (Android's unsettled tail included), or non-finite offsets.
   * True promises nothing about the range: the host clamps it, and on iOS an
   * empty result collapses the existing selection. Takes focus, shows no menu.
   */
  setSelection(start: number, end: number): boolean;
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

/**
 * `RunEmbed` with the JS-only fields stripped — the wire shape of the
 * `embeds` prop. The host reserves the rect and echoes the id through
 * `onEmbedLayout`; the node and the copy text never cross the bridge, same
 * division of knowledge as `pressables` and its hrefs.
 */
interface NativeRunEmbedRange {
  /** UTF-16 offsets into `text`, end-exclusive; end === start + 1. */
  start: number;
  end: number;
  /** Not always this array's index: an unreservable claim is dropped
   * without renumbering the rest. */
  embedId: number;
  width: number;
  height: number;
}

/**
 * Restates the codegen spec's `NativeProps`: importing the spec, even as
 * `import type`, emits a transpiled copy into `dist/`. Keep the two in step.
 */
interface NativeRunHostProps extends RunHostAccessibilityProps {
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
  /**
   * Embedded ranges over `text`. Unlike `pressables` this channel is
   * LAYOUT-AFFECTING — the reservation moves where glyphs sit and how tall
   * the run measures — so it is always sent when embeds exist, not gated on
   * an event listener.
   */
  embeds: readonly NativeRunEmbedRange[];
  selectable: boolean;
  exclusiveSelection: boolean;
  /** Wire form from `encodeSelectionActions`. */
  selectionActions: readonly string[];
  onSelectionAction?: (e: NativeSyntheticEvent<SelectionActionEvent>) => void;
  onInlinePress?: (e: NativeSyntheticEvent<InlinePressEvent>) => void;
  onEmbedLayout?: (e: NativeSyntheticEvent<EmbedLayoutEvent>) => void;
  onSelectionChange?: (e: NativeSyntheticEvent<SelectionChangeEvent>) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Restated rather than imported, for the reason `NativeRunHostProps` is. */
interface NativeHostCommands {
  clearSelection(ref: unknown): void;
  setSelection(ref: unknown, start: number, end: number): void;
}

/**
 * Forwarded verbatim to the native view. Setting `accessible` or
 * `accessibilityRole` collapses the host to one element, hiding its
 * per-heading and per-link elements.
 */
export type RunHostAccessibilityProps = Pick<
  ViewProps,
  | 'accessible'
  | 'accessibilityLabel'
  | 'accessibilityHint'
  | 'accessibilityRole'
  | 'accessibilityState'
  | 'accessibilityValue'
  | 'accessibilityLanguage'
  | 'accessibilityElementsHidden'
  | 'accessibilityLiveRegion'
  | 'importantForAccessibility'
>;

const NATIVE_HOST_NAME = 'SelectableRunHost';

/** Menu config sent when no listener exists: a menu item that visibly does
 * nothing is worse than no item, and the host cannot copy on its own. */
const NO_ACTIONS: readonly string[] = Object.freeze([]);

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

/** Shared empty embed list; `never[]` for the same double duty as
 * NO_PRESSABLES. */
const NO_EMBEDS: readonly never[] = Object.freeze([]);

function toNativeAttribute(attribute: RunTextAttribute): NativeTextAttribute {
  const { color, backgroundColor, ...rest } = attribute;
  const native: NativeTextAttribute = { ...rest };
  // Only set the keys that were present: every entry is sparse, and a
  // `color: null` from processColor would read on the native side as "this
  // range clears the colour" rather than "this range says nothing about it".
  const processedColor = color === undefined ? null : memoizedProcessColor(color);
  if (processedColor != null) native.color = processedColor;
  if (backgroundColor !== undefined) {
    const processed = memoizedProcessColor(backgroundColor);
    if (processed != null) native.backgroundColor = processed;
  }
  return native;
}

function toNativeDecoration(decoration: RunDecoration): NativeRunDecoration {
  const { color, borderColor, barColor, ...rest } = decoration;
  const native: NativeRunDecoration = { ...rest };
  // Same only-if-present discipline as toNativeAttribute: an absent colour
  // must stay absent (no fill, no stroke, no bar), not become null.
  const processedColor = color === undefined ? null : memoizedProcessColor(color);
  if (processedColor != null) native.color = processedColor;
  if (borderColor !== undefined) {
    const processed = memoizedProcessColor(borderColor);
    if (processed != null) native.borderColor = processed;
  }
  if (barColor !== undefined) {
    const processed = memoizedProcessColor(barColor);
    if (processed != null) native.barColor = processed;
  }
  return native;
}

/** The native component with `ref` made legal to pass: commands dispatch on
 * the ref, so `RunHost` has to be able to hand one through. */
type NativeHostComponent = ComponentType<
  NativeRunHostProps & RefAttributes<unknown>
>;

let cachedNativeHost: NativeHostComponent | null | undefined;

/** Null when the spec did not resolve or predates `Commands`; either way the
 * handle's methods are no-ops. */
let cachedNativeCommands: NativeHostCommands | null | undefined;

/**
 * Resolves the native selection host once per JS runtime. Every step is
 * guarded so the probe itself never throws: when the native module is not
 * linked (Expo Go, web, tests) this returns null.
 */
function loadNativeHost(): NativeHostComponent | null {
  if (cachedNativeHost !== undefined) {
    return cachedNativeHost;
  }
  cachedNativeHost = resolveNativeHost();
  return cachedNativeHost;
}

function loadNativeCommands(): NativeHostCommands | null {
  if (cachedNativeCommands !== undefined) {
    return cachedNativeCommands;
  }
  loadNativeHost();
  return cachedNativeCommands ?? null;
}

/**
 * THE PROBE IS `hasViewManagerConfig`, NOT `getViewManagerConfig`, AND THAT IS
 * THE POINT. Under bridgeless — every new-architecture app — `getViewManagerConfig`
 * does not consult the Fabric component registry at all: with no ViewConfig
 * interop layer installed it raises a soft error and returns null
 * (BridgelessUIManager.js:273-291). A correctly linked Fabric component would
 * therefore be reported as missing, the host would never resolve, and every
 * run would throw at render on exactly the architecture this component was
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
  cachedNativeCommands = null;
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
      Commands?: NativeHostCommands;
    };
    if (spec.default) {
      // A component without `Commands` is a bundle built from an older spec.
      cachedNativeCommands = spec.Commands ?? null;
      return spec.default;
    }
  } catch {
    // The spec did not resolve — see tier 2 above for the only build in which
    // that happens, and why it is not an error.
  }

  return null;
}

export interface RunHostProps extends RunHostAccessibilityProps {
  /** The run's projected plain display text (drives the native host). */
  text: string;
  /**
   * Styled ranges over `text` for the native host, from
   * `resolveRunAttributes`; the only channel that styles a run.
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
   * `resolveRunPressables`. Not sent without an `onInlinePress` listener.
   */
  pressables?: readonly RunPressable[];
  /**
   * Embedded ranges over `text` for the native host, from
   * `resolveRunEmbeds`. Layout-affecting (the host reserves each embed's
   * declared rect at its placeholder character), so the list is sent
   * whenever it is non-empty — presence does not depend on an
   * `onEmbedLayout` listener, though without one no overlay can ever be
   * positioned. A binary that predates the prop ignores it and the
   * placeholder renders as an invisible gap (see the codegen spec).
   */
  embeds?: readonly RunEmbed[];
  selectable: boolean;
  /**
   * Which custom items the platform selection menu offers, in order.
   * Defaults to both built-ins; the system Copy item is always kept. A
   * consumer-defined id needs a title or the host drops it. See
   * {@link SelectionActionSpec}.
   */
  selectionActions?: readonly SelectionActionInput[];
  /**
   * True while the run holds unsettled streaming content. Overrides
   * `selectable` per platform: selectable on iOS, not on Android.
   */
  unsettledTail?: boolean;
  /**
   * Defaults to true. False opts this host out of the process-wide
   * one-active-selection coordination in both directions: it clears nobody
   * and nobody clears it. Its range then survives another host taking focus,
   * but with no visible highlight, so the consumer must draw one.
   */
  exclusiveSelection?: boolean;
  onSelectionAction?: (e: SelectionActionEvent) => void;
  /**
   * Also reports empty selections. An unchanged range is not re-announced,
   * except on iOS when the characters under it were rewritten.
   */
  onSelectionChange?: (e: SelectionChangeEvent) => void;
  /**
   * Fired by the native host when a single tap lands inside one of
   * `pressables`. `pressableId` is the range's index into that array, which
   * is how the caller gets back to the URL it kept: the href deliberately
   * never crosses the bridge.
   */
  onInlinePress?: (e: InlinePressEvent) => void;
  /**
   * Fired by the native host, per embed, after layout with the reserved
   * rect (re-fired only when the rect moved). `embedId` is the range's own
   * `embedId`, which is how the caller gets back to the node and render
   * function it kept: only offsets and sizes cross the bridge.
   */
  onEmbedLayout?: (e: EmbedLayoutEvent) => void;
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
function RunHostWithRef(
  props: RunHostProps,
  ref: Ref<RunHostHandle>,
): ReactNode {
  const {
    text,
    attributes = NO_ATTRIBUTES,
    decorations = NO_DECORATIONS,
    pressables = NO_PRESSABLES,
    embeds = NO_EMBEDS,
    selectable,
    exclusiveSelection = true,
    selectionActions = DEFAULT_SELECTION_ACTIONS,
    unsettledTail = false,
    onSelectionAction,
    onInlinePress,
    onEmbedLayout,
    onSelectionChange,
    style,
    testID,
    // The remainder is exactly `RunHostAccessibilityProps`.
    ...accessibility
  } = props;

  const nativeRef = useRef<unknown>(null);

  // Per-platform tail policy (runs.ts emits tail runs with selectable:false
  // as a conservative default; the view decides). Android's selection
  // ActionMode misbehaves (and in some OEM builds crashes) when the text
  // under an active selection is swapped, so the unsettled tail is not
  // selectable there until it settles.
  //
  // iOS keeps it selectable because its host carries a selection across a
  // text swap, but only while the host lives, which is why `runKey` keys the
  // tail run by role rather than start offset.
  const effectiveSelectable = unsettledTail
    ? Platform.OS === 'ios'
    : selectable;

  // Read at call time: the policy flips per settle, and a handle may be held
  // across a whole stream.
  const selectableRef = useRef(effectiveSelectable);
  useLayoutEffect(() => {
    selectableRef.current = effectiveSelectable;
  }, [effectiveSelectable]);

  const selectionChangeRef = useRef(onSelectionChange);
  useLayoutEffect(() => {
    selectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);
  useLayoutEffect(() => () => {
    selectionChangeRef.current?.({ start: 0, end: 0 });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      clearSelection() {
        const commands = loadNativeCommands();
        if (!commands || nativeRef.current === null) return;
        commands.clearSelection(nativeRef.current);
      },
      setSelection(start: number, end: number): boolean {
        const commands = loadNativeCommands();
        if (!commands || nativeRef.current === null) return false;
        // Both hosts refuse a non-selectable text view; say so instead of true.
        if (!selectableRef.current) return false;
        // Android's generated delegate reads these with `ReadableArray.getInt`,
        // which throws on a fractional number.
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        // Safe from the mounting commit's layout phase: both platforms hold a
        // command that beats its view. On Android it runs before the same
        // batch's prop updates, so it clamps against the previous text.
        commands.setSelection(
          nativeRef.current,
          Math.trunc(Math.min(start, end)),
          Math.trunc(Math.max(start, end)),
        );
        return true;
      },
    }),
    [],
  );

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

  const nativeSelectionActions = useMemo<readonly string[]>(
    () => encodeSelectionActions(selectionActions),
    [selectionActions],
  );

  // The node and copy text are dropped here the way pressables drop the
  // href: the host gets ranges, sizes and ids, nothing else. Memoized like
  // the rest — the array is re-sent on every streamed snapshot.
  //
  // Filtered again for consumers that skip `resolveRunEmbeds`; ids are
  // carried, so a dropped entry never renumbers the rest.
  const nativeEmbeds = useMemo<readonly NativeRunEmbedRange[]>(
    () =>
      embeds.filter(isReservableEmbedSize).map((embed) => ({
        start: embed.start,
        end: embed.end,
        embedId: embed.embedId,
        width: embed.width,
        height: embed.height,
      })),
    [embeds],
  );

  const onEmbedLayoutEvent = useCallback(
    (event: NativeSyntheticEvent<EmbedLayoutEvent>) => onEmbedLayout?.(event.nativeEvent),
    [onEmbedLayout],
  );
  const onInlinePressEvent = useCallback(
    (event: NativeSyntheticEvent<InlinePressEvent>) => onInlinePress?.(event.nativeEvent),
    [onInlinePress],
  );
  const onSelectionActionEvent = useCallback(
    (event: NativeSyntheticEvent<SelectionActionEvent>) => onSelectionAction?.(event.nativeEvent),
    [onSelectionAction],
  );
  const onSelectionChangeEvent = useCallback(
    (event: NativeSyntheticEvent<SelectionChangeEvent>) => onSelectionChange?.(event.nativeEvent),
    [onSelectionChange],
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
      {...accessibility}
      attributes={nativeAttributes}
      decorations={nativeDecorations}
      // Always sent, unlike pressables: the reservation is layout-affecting,
      // so gating it on the listener would make the run measure differently
      // depending on whether anyone positions overlays.
      embeds={nativeEmbeds}
      // Not listener-gated: it switches coordination off, not a feature on.
      exclusiveSelection={exclusiveSelection}
      onEmbedLayout={onEmbedLayout ? onEmbedLayoutEvent : undefined}
      onInlinePress={onInlinePress ? onInlinePressEvent : undefined}
      onSelectionAction={onSelectionAction ? onSelectionActionEvent : undefined}
      // Hosts dispatch regardless, since Fabric cannot tell them JS listens;
      // the gate only skips the JS-side mapping on each drag frame.
      onSelectionChange={onSelectionChange ? onSelectionChangeEvent : undefined}
      pressables={onInlinePress ? nativePressables : NO_PRESSABLES}
      ref={nativeRef}
      selectable={effectiveSelectable}
      selectionActions={onSelectionAction ? nativeSelectionActions : NO_ACTIONS}
      style={style}
      testID={testID}
      text={text}
    />
  );
}

export const RunHost = forwardRef(RunHostWithRef);
RunHost.displayName = 'RunHost';
