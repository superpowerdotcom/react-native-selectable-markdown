import type { ComponentType, ReactNode, Ref, RefAttributes } from 'react';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
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
  /** The identifier `RunHost` sent with the range — the `embedId` of the
   * `RunEmbed` it came from, echoed back verbatim by the host. Handlers must
   * bounds-check it against the list the reporting projection sent: a report
   * can race a prop swap by a frame, exactly like `pressableId`. */
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
  /**
   * Which selection-menu action fired: the identifier half of the
   * `selectionActions` entry the item was built from, so a consumer-defined
   * action reports its own id here.
   *
   * Absent only under version skew (a native binary older than the `action`
   * field, whose sole custom item was "Copy Markdown"), which is the one case
   * `handleSelectionAction` resolves to 'copy-markdown'; every id that is
   * actually present is reported unchanged.
   */
  action?: SelectionActionId;
  /** Informational (debugging/analytics); offsets are authoritative. */
  selectedText: string;
}

export interface SelectionChangeEvent {
  /**
   * Where the run's selection stands now: UTF-16 offsets into its projected
   * display text, end-exclusive, clamped and ordered — the same unit and the
   * same guarantees as `SelectionActionEvent`, with ONE difference that is
   * the entire point of the event. `start === end` is a real payload here and
   * means "nothing is selected in this run", which is what a floating toolbar
   * has to hear to dismiss itself; `onSelectionAction` never emits an empty
   * range.
   *
   * There is no `selectedText`: this fires on every frame of a
   * selection-handle drag, and the caller already holds the projected text.
   */
  start: number;
  end: number;
}

/**
 * What `RunHost`'s ref exposes — the imperative half of the selection API for
 * ONE run, dispatched as codegen commands to the native host.
 *
 * Offsets are the run's own display offsets, the unit every event on this
 * component reports. `<SelectableMarkdown>` is the layer that speaks
 * `SourceSpan`; a caller driving `RunHost` itself holds its own projection
 * and can map with `mapSourceToRunRange`.
 *
 * Every method is a no-op — never a throw — when the host is not mounted, so
 * a handle held across an unmount stays safe to call.
 */
export interface RunHostHandle {
  /** Drop this run's selection and dismiss its menu. */
  clearSelection(): void;
  /**
   * Select `[start, end)` of this run's current display text, returning
   * whether the command was DISPATCHED to the host.
   *
   * FALSE MEANS NOTHING WAS ASKED OF THE PLATFORM, and it is a real answer:
   * the host is not mounted yet (or no longer is), the run is not selectable
   * on this platform — which includes the unsettled streaming tail on Android,
   * where the whole tail policy is that a selection must not sit over text
   * that is still being swapped — or the offsets are not finite. The native
   * side refuses a non-selectable run too, so returning true for it would be
   * reporting success for a call that provably did nothing.
   *
   * TRUE IS NOT A PROMISE ABOUT THE RESULTING RANGE. The host clamps and
   * orders the offsets against the text it currently holds, so a range that
   * survives as empty selects nothing — and on iOS collapses the run's
   * selection to zero length rather than leaving the previous one alone. The
   * command returns nothing, so this answer is JS's model of the host and not
   * a report from it: it mirrors the `isSelectable`/`isTextSelectable` guard
   * (which subsumes Android's `text as? Spannable` refusal — a `TextView`
   * holds a non-spannable buffer only while `setTextIsSelectable(false)`), but
   * it cannot see a `selectable` change that has committed here and not yet
   * been pushed to the host.
   *
   * It presents no menu — the platform menu belongs to the user's gesture —
   * and it issues no scroll of its own. It does take focus (iOS first
   * responder, Android view focus), which is what makes a selection visible
   * at all on both platforms, and a scrolling ancestor is entitled to react
   * to that.
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
  /** The `embedId` of the `RunEmbed` this range came from. An index into
   * `ProjectedRun.embeds`, which is not always this array's own index: an
   * unreservable claim is dropped without renumbering the rest. */
  embedId: number;
  width: number;
  height: number;
}

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
  /** Whether this host takes part in the process-wide one-active-selection
   * coordination. See `RunHostProps.exclusiveSelection`. */
  exclusiveSelection: boolean;
  /** The wire form: one string per menu item, `id` or `id + U+001F + title`
   * (see `encodeSelectionActions`), in menu order. */
  selectionActions: readonly string[];
  onSelectionAction?: (e: NativeSyntheticEvent<SelectionActionEvent>) => void;
  onInlinePress?: (e: NativeSyntheticEvent<InlinePressEvent>) => void;
  onEmbedLayout?: (e: NativeSyntheticEvent<EmbedLayoutEvent>) => void;
  onSelectionChange?: (e: NativeSyntheticEvent<SelectionChangeEvent>) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The generated `Commands` object from the same codegen spec — how JS tells
 * one mounted host to do something now.
 *
 * Restated here for the same reason `NativeRunHostProps` is: nothing may
 * `import` the spec module (see `loadNativeHost`), so what comes back from
 * the call-expression `require` is cast to this shape. The first argument of
 * each is the native component's ref, which is why `RunHost` forwards one.
 */
interface NativeHostCommands {
  clearSelection(ref: unknown): void;
  setSelection(ref: unknown, start: number, end: number): void;
}

/**
 * The accessibility props a run host accepts and forwards VERBATIM to the
 * native view.
 *
 * They cost nothing to support and were unreachable anyway: the codegen spec's
 * `NativeProps extends ViewProps`, so the native host has always accepted the
 * whole RN accessibility surface — but `RunHost` enumerates the props it
 * passes (there is no spread of `props`), so nothing a consumer set could ever
 * reach it. This type is what those props travel in, and it is a `Pick` rather
 * than the whole of `ViewProps` on purpose: `style` and `testID` are declared
 * separately with their own contracts, and layout/pointer props on a run's box
 * are not something this component can honour without breaking the run's
 * geometry.
 *
 * WHAT A SCREEN READER GETS WITHOUT THEM, so a consumer knows what these add.
 * Each host is a plain `UITextView`/`TextView`, so its text is already read
 * out and nothing is hidden — and headings and links inside it are not merely
 * styled text: `resolveRunAttributes` marks heading ranges with `role`/
 * `roleLevel` on the wire, and each host vends a real element per heading (a
 * `UIAccessibilityElement` carrying the `.header` trait on iOS, a virtual node
 * through the ExploreByTouch helper on Android), with link ranges vended the
 * same way from `pressables`, and list items and table cells cross as
 * `role: 'listItem'` / `role: 'tableCell'` (Android announces them through
 * `CollectionItemInfo`, iOS vends an element per item or cell). What is
 * missing is code-block and blockquote STRUCTURE: both read as one stretch of
 * text.
 *
 * These props are the channel for saying what a run IS when that matters —
 * labelling a document, or marking one run as a header. Use them knowing that
 * `accessible` and `accessibilityRole` are the platform's "this subtree is one
 * element" switch: setting either collapses the host to a single label and the
 * per-heading and per-link elements below it stop being reachable.
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
 * The generated `Commands` object, resolved alongside the component and cached
 * with it. Null when the spec did not resolve, and — separately — null when it
 * resolved but carries no `Commands`, which is what a bundle built from an
 * older version of this package's spec looks like. Both are the same answer
 * here: no command can be dispatched, so the imperative handle's methods are
 * no-ops rather than a TypeError inside a consumer's callback.
 */
let cachedNativeCommands: NativeHostCommands | null | undefined;

/**
 * Resolves the native selection host once per JS runtime. Every step is
 * guarded so the probe itself never throws: when the native module is not
 * linked (Expo Go, web, tests) this returns null, and the caller turns that
 * null into the named throw in the component body. There is no JS fallback to
 * degrade into, so a null here is always a hard, visible failure.
 */
function loadNativeHost(): NativeHostComponent | null {
  if (cachedNativeHost !== undefined) {
    return cachedNativeHost;
  }
  cachedNativeHost = resolveNativeHost();
  return cachedNativeHost;
}

/**
 * The commands half of the same resolution. It goes through `loadNativeHost`
 * rather than requiring the spec a second time so that the `require` — and its
 * failure — happen exactly once, in the one place that documents why it is a
 * `require` at all.
 */
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
      // Read off the SAME module object as the component, in the same tier.
      // The babel plugin emits both from one rewrite of this file, so a spec
      // that produced a component and no `Commands` is a version skew (a
      // bundle built against a spec older than the commands) rather than a
      // state this package can reach — hence the guard, not an assertion.
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
   * `resolveRunAttributes`. This is the only channel that styles a run: the
   * host renders `text` plus these ranges and nothing else, so a run handed
   * no attributes draws as unstyled plain text.
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
   * `resolveRunPressables`. Without an `onInlinePress` listener the list is
   * not sent, so the host never intercepts a tap it has nothing to do with.
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
   * Defaults to both built-in actions. The system Copy item is always kept
   * on both platforms regardless of this list.
   *
   * An entry is a bare identifier — which keeps the host's own localised
   * title, and is what the two built-ins want — or an `{ id, title }` pair,
   * which is how the menu gets its strings from JS (and the only way to
   * localise both platforms from one place). A consumer-defined id needs a
   * title: neither host has a string for an id it does not know, so an
   * untitled one is dropped from the menu. See
   * {@link SelectionActionSpec}.
   */
  selectionActions?: readonly SelectionActionInput[];
  /**
   * True while the run still contains unsettled streaming content — what
   * `<SelectableMarkdown>` passes as `streaming && run.span.end > settledUntil`.
   *
   * IT OVERRIDES `selectable`, per platform, rather than combining with it:
   * set, the run is selectable on iOS and not on Android regardless of what
   * `selectable` says (see `effectiveSelectable` in the component body for
   * why each platform answers the way it does). A host rendering runs directly
   * that leaves this unset gets `selectable` verbatim and owns the tail policy
   * itself.
   */
  unsettledTail?: boolean;
  /**
   * Whether this host takes part in the process-wide one-active-selection
   * coordination. Defaults to true, which is the behaviour that predates the
   * prop.
   *
   * Both platforms let two text views hold a selection at once — neither
   * clears one because the other started — so each host records itself as the
   * process's one selection owner and clears the host that held the slot
   * before. What that buys is one selection in STATE: focus is what already
   * kept the screen to one highlight (see below), so without the coordination
   * a transcript would carry live invisible ranges in every run the reader had
   * ever swept.
   *
   * FALSE OPTS THIS HOST OUT IN BOTH DIRECTIONS: it clears nobody, and
   * because it never takes the slot, nobody clears it. Two selections held at
   * once is only reachable that way — an opt-out that only stopped the
   * clearing would still lose the first selection to the next host that
   * selected.
   *
   * WHAT SURVIVES IS THE RANGE, NOT THE HIGHLIGHT. Both platforms draw a
   * selection only in the view that holds focus: a non-editable `UITextView`
   * paints no selection, no handles and no menu unless it is first responder,
   * and Android's `TextView` draws one only while it is focused or pressed. So
   * once a second host takes focus the first host's selection is still THERE —
   * its `selectedRange`/`Selection` stands, `onSelectionChange` has already
   * reported it, `getSelection()` still answers with it, and its copy payload
   * is still exact — but the user sees no highlight on it. That is what makes
   * "select in A, select in B, merge the two payloads" reachable in code while
   * looking to the reader like only one selection exists.
   *
   * So it is opt-in and off by default, and a consumer using it owns the
   * feedback: draw your own highlight from the reported spans if the first
   * selection has to stay visible.
   *
   * The coordination is per PROCESS, not per document, which is the other
   * reason this prop exists: two unrelated `<SelectableMarkdown>` trees in a
   * split view clear each other without it.
   */
  exclusiveSelection?: boolean;
  onSelectionAction?: (e: SelectionActionEvent) => void;
  /**
   * Fired whenever this run's selection changes — a gesture, a command, a
   * text swap that moved it, or another host taking the one-active-selection
   * slot. Unlike `onSelectionAction` it reports EMPTY selections, which is
   * how a consumer's own toolbar learns to dismiss itself.
   *
   * Both hosts dedupe before dispatching: an unchanged range is not
   * re-announced, so a streamed snapshot that re-applies identical text emits
   * nothing. iOS re-announces an unchanged RANGE when the characters under it
   * were rewritten, because the payload a caller derives from those offsets
   * would otherwise be stale; Android needs no such rule, since `setText`
   * there drops the selection outright.
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
 *
 * IT FORWARDS A REF, and the ref is a `RunHostHandle` rather than the native
 * view. Commands dispatch on the native component's own ref, which this
 * component holds privately: handing it out would put the generated
 * `Commands` object, the native offsets and the "is it even mounted" question
 * into every caller. The handle is two methods with the same clamping
 * contract as the events.
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
    // Everything the interface still holds is a `RunHostAccessibilityProps`
    // field, forwarded verbatim below. A rest element rather than ten more
    // names, so a prop added to that type reaches the host without a second
    // edit here — the whole reason the type is a `Pick` and not `ViewProps`.
    ...accessibility
  } = props;

  // The native component's ref, kept private (see the class doc). Null
  // whenever nothing is mounted — before the first commit, and after
  // unmount — which is what makes every handle method a no-op rather than a
  // throw at those moments.
  const nativeRef = useRef<unknown>(null);

  // Per-platform tail policy (runs.ts emits tail runs with selectable:false
  // as a conservative default; the view decides). Android's selection
  // ActionMode misbehaves (and in some OEM builds crashes) when the text
  // under an active selection is swapped, so the unsettled tail is not
  // selectable there until it settles.
  //
  // iOS keeps it selectable because its host carries a selection across a
  // text swap: an append splices the new tail in and leaves the selection
  // alone, and a swap that is not an append clamps it into the new text. That
  // holds only for as long as the HOST LIVES, which is why the tail run's
  // React key is its role and not its start offset (`runKey`): keyed on the
  // start it moved at every settle, and a remounted host is reset — text
  // cleared, `selectedRange` zeroed, first responder resigned — so a
  // selection made in the live tail was destroyed by the next settled block
  // rather than clamped through it.
  const effectiveSelectable = unsettledTail
    ? Platform.OS === 'ios'
    : selectable;

  // Read by `setSelection` below at CALL time. The policy flips once per
  // settle for the tail run, and rebuilding the handle each time would break
  // the promise that a caller may hold one across a whole stream, so the
  // current answer is parked in a ref instead of in the handle's deps.
  const selectableRef = useRef(effectiveSelectable);
  selectableRef.current = effectiveSelectable;

  // The handle is rebuilt on no dependency at all: it reads `nativeRef.current`
  // at call time, so it never goes stale and never has to be re-created when
  // the run's text changes. A caller may therefore hold it across an entire
  // stream.
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
        // The same answer the host would give, given here so the caller hears
        // it. Both hosts refuse the command on a non-selectable text view
        // (`guard textView.isSelectable` / `if (!textView.isTextSelectable)`),
        // and JS is the side that knows the tail policy produced that state —
        // see `effectiveSelectable` above. Reporting true here would tell
        // `<SelectableMarkdown>` that a run had taken a span it cannot show.
        if (!selectableRef.current) return false;
        // Integers only. The generated Android delegate reads the arguments
        // with `ReadableArray.getInt`, which throws on a fractional number,
        // and a fractional UTF-16 offset is meaningless anyway. Ordering and
        // clamping to the text are the hosts' job — they alone know what the
        // text currently is — but a non-finite value cannot survive that, so
        // it is refused here.
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
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

  // The node and copy text are dropped here the way pressables drop the
  // href: the host gets ranges, sizes and ids, nothing else. Memoized like
  // the rest — the array is re-sent on every streamed snapshot.
  //
  // The size filter is for the callers that skip `resolveRunEmbeds`: this
  // component is exported, so a consumer can hand `embeds` straight to it, and
  // a size that cannot be reserved (non-positive, or infinite) must not reach
  // a platform text store — see `isReservableEmbedSize`. Ids are carried, not
  // re-indexed, so a filtered entry never renumbers the rest.
  // Packed to the wire form once per list identity. The hosts diff this prop
  // by VALUE (a `std::vector<std::string>` comparison on iOS, a list equality
  // check on Android), so a fresh array of equal strings would cost nothing
  // even unmemoized — this is here to keep an inline `['copy-text']` from
  // re-packing on every streamed snapshot, like the arrays above.
  const nativeSelectionActions = useMemo<readonly string[]>(
    () => encodeSelectionActions(selectionActions),
    [selectionActions],
  );

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
      // Always sent, and NOT gated on a listener the way `selectionActions`
      // and `pressables` are. Those two are gated because sending them turns
      // something ON in the host (a menu item, a tap interception) that would
      // then report nowhere. This one turns a coordination OFF, so a host
      // that does not hear it must keep coordinating — which is what the
      // codegen default of true already says.
      exclusiveSelection={exclusiveSelection}
      onEmbedLayout={
        onEmbedLayout ? (event) => onEmbedLayout(event.nativeEvent) : undefined
      }
      onInlinePress={
        onInlinePress ? (event) => onInlinePress(event.nativeEvent) : undefined
      }
      onSelectionAction={
        onSelectionAction
          ? (event) => onSelectionAction(event.nativeEvent)
          : undefined
      }
      // WHAT LEAVING THIS UNDEFINED SAVES, AND WHAT IT DOES NOT. Fabric has
      // no channel for telling a host whether JS is listening — event
      // handlers are not props on the C++ side — so both hosts dispatch a
      // selection change whether or not anyone reads it, exactly as React
      // Native's own TextInput does. What the gate saves is everything ABOVE
      // the bridge: with no handler nothing maps the offsets through the
      // piece table or slices the display text, which is the per-frame cost
      // during a handle drag. The hosts' own dedupe is what keeps the
      // dispatch itself down to genuine changes.
      onSelectionChange={
        onSelectionChange
          ? (event) => onSelectionChange(event.nativeEvent)
          : undefined
      }
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
// Without this React DevTools and every error boundary say
// `ForwardRef(RunHostWithRef)`, which names an implementation detail in a
// stack trace a consumer reads.
RunHost.displayName = 'RunHost';
