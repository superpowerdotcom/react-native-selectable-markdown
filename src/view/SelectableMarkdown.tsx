import { IS_DEV } from '../dev';
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode, Ref } from 'react';
import { Platform, View, useColorScheme } from 'react-native';
import type {
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import type { AnyNode, Block, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { parseDocument } from '../engine/Engine';
import type { Engine } from '../engine/Engine';
import { resolveOptions } from '../engine/options';
import type { EngineOptions } from '../engine/options';
import type { ProjectedRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type {
  ClassifyBlock,
  EmbedClaimContext,
  EmbedContent,
  RunSegment,
} from '../selection/runs';
import { trimTrailingPlaceholders } from '../stream/placeholders';
import type { SessionSnapshot, StreamSession } from '../stream/StreamSession';
import { RunHost } from './RunHost';
import type {
  EmbedLayoutEvent,
  InlinePressEvent,
  RunHostAccessibilityProps,
  RunHostHandle,
  SelectionActionEvent,
  SelectionChangeEvent,
} from './RunHost';
import { withImageEmbeds } from './imageEmbeds';
import type { ImageMode } from './imageEmbeds';
import { createRunProjectionCache } from './projectionCache';
import type { RunProjectionCache } from './projectionCache';
import { openUrl, renderBlocks, resolveRenderers } from './renderers';
import type { RenderContext, RendererMap, RendererOverrides } from './renderers';
import { resolveRunAttributes } from './runAttributes';
import type { MarkAttribute } from './runAttributes';
import { resolveRunDecorations } from './runDecorations';
import { resolveRunEmbeds } from './runEmbeds';
import {
  NO_EMBED_RECTS,
  applyEmbedRect,
  embedRectKey,
  runKey,
} from './runIdentity';
import type { EmbedRect } from './runIdentity';
import { resolveRunPressables } from './runPressables';
import {
  DEFAULT_SELECTION_ACTIONS,
  handleSelectionAction,
  sameSelectionActionList,
  warnAboutUntitledSelectionActions,
} from './selectionActions';
import type {
  SelectionActionInput,
  SelectionCopyEvent,
} from './selectionActions';
import { selectSpanInRuns } from './selectionRange';
import {
  EMPTY_SELECTION_STATE,
  reduceRunSelection,
  resetSelection,
} from './selectionTracking';
import type {
  RunSelectionReport,
  SelectionTrackingResult,
  SelectionTrackingState,
} from './selectionTracking';
import type { RunSelectionCandidate } from './selectionRange';
import { defaultDarkTheme, defaultTheme, mergeTheme } from './theme';
import type { MarkdownTheme, PartialTheme } from './theme';

// Named rather than `export *`, so the wire codec stays out of the package root.
export type {
  SelectionAction,
  SelectionActionId,
  SelectionActionSpec,
  SelectionActionInput,
  SelectionCopyEvent,
  SelectionActionContext,
} from './selectionActions';
export {
  DEFAULT_SELECTION_ACTIONS,
  handleSelectionAction,
  selectionDisplayText,
} from './selectionActions';

export interface SelectableMarkdownProps extends SelectableMarkdownAccessibilityProps {
  /**
   * The markdown to render. Never parsed when `session` is set (DEV warns).
   */
  source?: string;
  /**
   * A stream to render instead of `source`, redrawn on every commit; its tail
   * follows `RunHostProps.unsettledTail`.
   */
  session?: StreamSession;
  /**
   * Parse options for `source`; a session carries its own. Keep its identity
   * stable: a new object reparses the whole document.
   */
  options?: EngineOptions;
  /**
   * Which engine parses `source`. Ignored when a `session` is given — a session
   * carries its own engine, passed to its constructor.
   *
   * DEFAULTS TO THE NATIVE md4c ENGINE, which is the package's only parser. It
   * needs the native module linked into *this* JS context: on device that
   * means an app rebuilt after the package was added or updated (installing
   * the pod or the Gradle dependency and then reloading JS is not enough — a
   * JS reload cannot link native code), and under plain Node it means the test
   * addon was built. Where it is not linked — Expo Go, web, a binary that
   * predates the package — the first non-empty document throws out of
   * `parseDocument`, with a message naming the build step that is missing.
   *
   * That hard failure is deliberate, and it is a change of policy. The package
   * used to carry a second parser written in TypeScript and quietly parse with
   * it whenever the native module was absent, which meant an app could ship to
   * production having never once run the parser it had linked, and a decoder
   * difference only ever showed up as "it looks different on device". There is
   * now one parser and one answer to "why did nothing render": the error says
   * so.
   *
   * Pass an engine here to substitute your own parser. This prop is the
   * pluggability seam and the only supported way to render without the native
   * module. Whatever the engine returns IS the document — nothing validates or
   * normalizes it — so it has to honour the `Engine` contract, in particular
   * that every node's `SourceSpan` holds UTF-16 offsets into the exact
   * `source` string the engine was handed. Selection, copy and streaming all
   * read those offsets back out, so an engine with plausible nodes and wrong
   * spans renders correctly and then selects the wrong characters.
   */
  engine?: Engine;
  /**
   * Token overrides, merged one group deep over the base theme `colorScheme`
   * resolves (`defaultTheme` or `defaultDarkTheme`). The same overrides apply
   * to whichever base is active — they are a delta, not a whole theme.
   *
   * Keep its identity stable: an inline literal re-renders every run on every
   * parent render.
   */
  theme?: PartialTheme;
  /**
   * Which built-in base theme the `theme` overrides layer onto: 'light' is
   * `defaultTheme`, 'dark' is `defaultDarkTheme`, and 'auto' (the default)
   * follows the system appearance via `useColorScheme()` — flipping the
   * device's appearance restyles the document in place.
   */
  colorScheme?: 'light' | 'dark' | 'auto';
  /**
   * Overrides for STANDALONE blocks only; an override for anything that flows
   * into a native run is never called. A block is standalone when it carries a
   * spoiler, `classifyBlock` claims it, or it holds an image nothing embedded;
   * code blocks, tables and prose links flow. `image` alone reaches both paths.
   *
   * Each renderer function is its own component type, so keep this object and
   * its functions stable, or runs re-render and renderers remount.
   */
  renderers?: RendererOverrides;
  /**
   * Claims app-specific blocks as `standalone` so they never merge into a
   * prose run — a paragraph rendered as a button or a citation anchor owns a
   * tap target, and a tap target inside a selection host fights the selection
   * gesture. Return `undefined` to leave a node to the built-in rules.
   *
   * Give this a stable identity (module scope, or `useCallback`): the whole
   * document is resegmented whenever it changes.
   */
  classifyBlock?: ClassifyBlock;
  /**
   * The most SOURCE characters one flowing run may span. Default
   * `DEFAULT_MAX_RUN_CHARS` (8000); `Infinity` opts out. Each cap is a
   * selection boundary, and it only breaks between top-level blocks.
   */
  maxRunChars?: number;
  /**
   * Claims nodes as EMBEDS: custom-rendered UIs that participate in
   * cross-paragraph selection instead of ending the run the way a
   * `classifyBlock: 'standalone'` claim does. A claimed node's block flows;
   * the node projects as a single placeholder character mapped to its whole
   * source span; the native host reserves the declared `width` × `height`
   * at that character; and the returned `render` element is overlaid on the
   * reserved space once the host reports where it landed. One selection
   * gesture sweeps across the card; copying the sweep yields the node's
   * exact markdown, and copy-text substitutes the declared `text`.
   *
   * Consulted for every node, blocks and inlines alike, BEFORE
   * `classifyBlock` and before the built-in view-kind rules — so a claimed
   * image or blocked link flows too. Return `undefined` to leave a node
   * alone. Synthetic and still-streaming (`incomplete`) nodes are never
   * embedded regardless of a claim, and while a run is the unsettled
   * streaming tail its overlays are not mounted (the space is still
   * reserved, so nothing reflows when they appear).
   *
   * Sizing is declared, not measured: `height` becomes the placeholder
   * line's height through the attribute channel, which is what makes the
   * measured run and the drawn run agree. A block-level embed (its own
   * paragraph) may be any height; an inline embed must fit within its
   * line's height on iOS — declare chips, not towers.
   *
   * Must be pure, deterministic, and referentially stable (module scope, or
   * `useCallback`): the whole document is resegmented AND reprojected
   * whenever the callback's identity changes, because a claim changes the
   * projected text itself.
   *
   * Keep each claim's `render` stable too: it is the overlay's component type,
   * so a fresh arrow remounts the card on every reprojection.
   */
  embed?: EmbedRenderer;
  /**
   * How an image participates in selection. Default `'embed'`: a top-level
   * paragraph's sole image reserves `spacing.imageWidth` × `spacing.imageHeight`
   * and the `image` renderer is overlaid. `'standalone'` sends the image's block
   * to `renderers`, and it draws even while streaming.
   *
   * An `embed` claim beats `classifyBlock` on the same node, so this prop, not
   * `classifyBlock`, is what forces an image out of the run.
   */
  images?: ImageMode;
  /**
   * Which custom actions the platform selection menu offers, in order.
   * Default: both built-ins; the system Copy item always remains. An entry is
   * an id or `{ id, title }`, and a bare id keeps the host's own localised
   * string, which only the built-ins have. Any other id is your own action,
   * delivered to `onSelectionCopy` as `payload.action`; it must carry a title
   * or it never appears (DEV warns).
   *
   * REQUIRES `onSelectionCopy`. Custom items are suppressed entirely when
   * there is no handler for them — a menu item that reports nowhere is worse
   * than one that is not offered — so `selectionActions={['copy-markdown']}`
   * on its own yields an EMPTY custom menu (DEV warns).
   */
  selectionActions?: readonly SelectionActionInput[];
  /**
   * Called when the user picks one of `selectionActions`. Also the switch
   * that puts those items on the menu at all; see `selectionActions`.
   *
   * Identity does not matter; presence decides whether custom items appear.
   */
  onSelectionCopy?: (payload: SelectionCopyEvent) => void;
  /**
   * A press on a link-shaped range inside a native selection run.
   *
   * SUPPLYING THIS TAKES OVER ROUTING COMPLETELY, for live and blocked ranges
   * alike. With no handler the built-in behaviour stands: a live link opens via
   * `openUrl`, a blocked one does nothing.
   *
   * You want it in two cases, and the second is the one that bites. First, if
   * your `link` renderer is overridden — in-app navigation, a bottom sheet,
   * anything that is not "hand the href to the OS" — then without this the run
   * path calls `openUrl` while the renderer path calls yours, and the same link
   * behaves differently depending on whether it happened to flow into a run.
   * Second, if any of your blocked schemes are identifiers you resolve
   * yourself (`#…-citation-3`, `product://…`), this is the only way to hear
   * about them, and hearing about them is what lets those blocks stay inside
   * selectable runs instead of being classified `standalone`.
   *
   * Identity does not matter; presence is what takes routing over.
   */
  onLinkPress?: (press: InlineLinkPress) => void;
  /**
   * Per-mark styling, overriding the theme for that range — a designed heading
   * ramp, a bold FACE instead of a weight, two blocked schemes that must look
   * different. See `MarkAttribute` for why each of those needs the mark rather
   * than a token.
   *
   * This is how a consumer's typography reaches the NATIVE host. The renderer
   * tree it may already have configured is not used for a flowing run, so
   * without this, linking the native module silently replaces a designed
   * document with the theme's approximation of it.
   *
   * Give it a stable identity (module scope, or `useCallback`): it takes part
   * in the attribute memo, so a fresh closure per render re-resolves every
   * run's attributes on every streaming tick.
   */
  attributeForMark?: MarkAttribute;
  /**
   * Called on every change to the document's selection, including ones made
   * by `setSelection` or by another selection taking it away; `null` means
   * nothing is selected. Identity does not matter, but presence (or a `ref`)
   * is what turns on the per-frame mapping work.
   *
   * `span` is what copying would produce, construct syntax included; see
   * `SelectableMarkdownSelection`. It can lag a gesture by a frame, as can
   * `getSelection()`.
   */
  onSelectionChange?: (selection: SelectableMarkdownSelection | null) => void;
  /**
   * Default `true`: runs take part in the process-wide one-active-selection
   * coordination, so two `<SelectableMarkdown>` trees clear each other's
   * selections. `false` opts this document's runs out in both directions.
   *
   * Opted out, an older selection survives with no visible highlight (only the
   * focused view draws one), so draw your own; `clearSelection()` then clears
   * every mounted run.
   */
  exclusiveSelection?: boolean;
  /**
   * Composed over the `spacing.containerPadding` padding, so `{ padding: 16 }`
   * here wins.
   */
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Set on the container only; the per-run hosts carry no test ID. */
  testID?: string;
}

/**
 * Forwarded verbatim to the container's root `View`. Setting `accessible` or
 * `accessibilityRole` flattens the document to one label, hiding the
 * per-heading and per-link elements inside its runs.
 */
export type SelectableMarkdownAccessibilityProps = RunHostAccessibilityProps;

/**
 * A press on a link-shaped range inside a native run.
 *
 * `blocked` mirrors the mark kind: `false` for 'link' (the URL policy allowed
 * it), `true` for 'blockedLink' (it did not). Treat it as the authority on
 * whether `href` is a destination or an identifier — it is the same bit the
 * parser decided, carried through unchanged.
 *
 * `start`/`end` are UTF-16 offsets into the run's projected text, for consumers
 * that need to know *which* occurrence was pressed rather than only which href.
 */
export interface InlineLinkPress {
  href: string;
  blocked: boolean;
  start: number;
  end: number;
}

/**
 * What an embed claim declares: the reservation (`EmbedContent`) plus the
 * element overlaid on it. `render` receives the claimed node and the same
 * `RenderContext` the block renderers get; it runs only in the view layer —
 * segmentation and projection see the object purely as `EmbedContent`, which
 * is what lets the `embed` prop double as the `EmbedLookup` threaded to
 * `segmentRuns`/`projectRun` without a second callback to keep in sync.
 *
 * `render` is placed as an element, so hooks work; its component type is built
 * per function, so keep it stable or the card remounts on every reprojection.
 */
export interface EmbedSpec extends EmbedContent {
  render: (node: AnyNode, ctx: RenderContext) => ReactNode;
}

/** The `embed` prop's shape. Structurally an `EmbedLookup` — every
 * `EmbedSpec` is an `EmbedContent`. The context tells a claim whether the
 * node is a direct child of the document (`topLevel`) — the one position a
 * full-column-width reservation is safe in; see `EmbedClaimContext`. */
export type EmbedRenderer = (
  node: AnyNode,
  context: EmbedClaimContext,
) => EmbedSpec | undefined;

/**
 * A live selection inside exactly one run. `span` is authoritative and is what
 * `onSelectionCopy` would map, construct syntax included, so
 * `source.slice(span.start, span.end)` is its markdown. `plain` equals the copy
 * payload's `plain`.
 */
export interface SelectableMarkdownSelection {
  span: SourceSpan;
  plain: string;
}

/** Nothing here scrolls a span into view; the document owns no scroll view. */
export interface SelectableMarkdownHandle {
  /** The last selection the hosts reported, or null. A snapshot, not a
   * subscription. */
  getSelection(): SelectableMarkdownSelection | null;
  /** With `exclusiveSelection={false}` this clears every mounted run. */
  clearSelection(): void;
  /**
   * Selects a SOURCE span in whichever run shows it, returning whether a run
   * took it.
   *
   * False when the span is past the end, standalone, markup-only, in a run not
   * yet mounted (runs count as mounted from their commit's layout phase), or in
   * a run that cannot select now: Android's unsettled tail, `selectable={false}`,
   * or a binary without the commands. The previous selection then stands.
   *
   * True promises nothing about the range: hosts clamp it, an empty result
   * clears the selection on iOS, and indivisible pieces (entities, alt text,
   * embeds) widen it. Read `getSelection()` if the exact range matters.
   *
   * Takes focus, which can scroll an ancestor on Android, but shows no menu.
   */
  setSelection(span: SourceSpan): boolean;
}

/** Mutable and registered once: imperative calls need it current at call
 * time, which a snapshot captured in deps is not. */
interface RunSelectionEntry extends RunSelectionCandidate {
  span: SourceSpan;
  /** Null for a standalone run, which renders no `RunHost`. */
  projected: ProjectedRun | null;
  host: { current: RunHostHandle | null };
}

/** Every mounted run by React key; held in a ref because nothing renders
 * from it. */
type RunSelectionRegistry = Map<string, RunSelectionEntry>;

const EMPTY_DOCUMENT: ParsedDocument = { source: '', blocks: [] };

const NO_SUBSCRIPTION = (): void => {};

function sameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.revision !== b.revision ||
    a.phase !== b.phase ||
    a.settledUntil !== b.settledUntil
  ) {
    return false;
  }
  return (
    a.document === b.document ||
    (a.document.source === b.document.source &&
      sameBlockIdentity(a.document.blocks, b.document.blocks))
  );
}

/**
 * Before the first commit `snapshot()` builds a fresh empty snapshot per call,
 * so returning the held object for an equal state is what stops
 * `useSyncExternalStore` re-rendering forever.
 */
function useSessionSnapshot(session?: StreamSession): SessionSnapshot | null {
  const held = useRef<SessionSnapshot | null>(null);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      session ? session.subscribe(onStoreChange) : NO_SUBSCRIPTION,
    [session],
  );
  const getSnapshot = useCallback(() => {
    if (!session) {
      return null;
    }
    const next = session.snapshot();
    const previous = held.current;
    if (previous !== null && sameSnapshot(previous, next)) {
      return previous;
    }
    held.current = next;
    return next;
  }, [session]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

interface RunViewProps {
  run: RunSegment;
  doc: ParsedDocument;
  theme: MarkdownTheme;
  renderers: RendererMap;
  /** The run's bottom margin, in points — `spacing.blockGap` against a
   * standalone neighbour, the blank-line height against an adjacent PROSE
   * run (the settled/tail split; see the gap computation in
   * `SelectableMarkdown`). */
  gap: number;
  unsettledTail: boolean;
  selectionActions: readonly SelectionActionInput[];
  onSelectionCopy?: (payload: SelectionCopyEvent) => void;
  onLinkPress?: (press: InlineLinkPress) => void;
  attributeForMark?: MarkAttribute;
  embed?: EmbedRenderer;
  /** Re-checked at press time; see `openUrl`. */
  linkPrefixes: readonly string[];
  exclusiveSelection: boolean;
  /** A component cannot read its own key, and the registry must be keyed per
   * instance. */
  runKey: string;
  registry: RunSelectionRegistry;
  /** Undefined when nobody watches selection. Stable identity. */
  onSelectionChange?: (report: RunSelectionReport, runKey: string) => void;
}

function RunView(props: RunViewProps): ReactNode {
  const {
    run,
    doc,
    theme,
    renderers,
    gap,
    unsettledTail,
    selectionActions,
    onSelectionCopy,
    onLinkPress,
    attributeForMark,
    embed,
    linkPrefixes,
    exclusiveSelection,
    runKey: selfKey,
    registry,
    onSelectionChange,
  } = props;

  // The same tail policy as `effectiveSelectable` in `RunHost`, applied to
  // standalone renderers.
  const selectable = unsettledTail ? Platform.OS === 'ios' : run.selectable;

  const ctx: RenderContext = useMemo(
    () => ({
      theme,
      renderers,
      source: doc.source,
      listDepth: 0,
      selectable,
      linkPrefixes,
    }),
    [theme, renderers, doc.source, selectable, linkPrefixes],
  );

  // Keyed on the glyph VALUES, not the theme object: the marker glyphs are
  // part of the projected text — and so of every offset downstream — while
  // the rest of the theme only styles it. A colour change must restyle
  // without reprojecting; a stale projection under new glyphs would corrupt
  // every attribute, decoration and pressable range built from it. The
  // `embed` callback joins the key for the same reason: a claim replaces a
  // node's projection with a placeholder character, so a different lookup is
  // different projected text.
  //
  // The cache extends the previous projection with appended blocks, so a
  // growing settled run is not reprojected per settle (`projectionCache.ts`).
  // A discarded render may replace it; prefix validation keeps reuse safe.
  const cacheRef = useRef<RunProjectionCache | null>(null);
  cacheRef.current ??= createRunProjectionCache();
  const cache = cacheRef.current;
  const { bullet, taskChecked, taskUnchecked } = theme.glyphs;
  const projected = useMemo(
    () =>
      run.standalone
        ? null
        : cache.project(run, doc, {
            glyphs: { bullet, taskChecked, taskUnchecked },
            embed,
          }),
    [cache, run, doc, bullet, taskChecked, taskUnchecked, embed],
  );

  // Theme resolution for the native host. Memoized separately from the
  // projection because a theme change has to restyle without reprojecting,
  // and a content change must not rebuild the theme lookup.
  const attributes = useMemo(
    () =>
      projected
        ? resolveRunAttributes(projected, theme, attributeForMark)
        : undefined,
    [projected, theme, attributeForMark],
  );

  // The run's block chrome (code boxes, table borders and rules, thematic
  // breaks) for the native host. Memoized like `attributes` — a theme change
  // restyles it without reprojecting, a content change rebuilds it.
  const decorations = useMemo(
    () => (projected ? resolveRunDecorations(projected, theme) : undefined),
    [projected, theme],
  );

  // The run's tappable link ranges, for the native host. Theme-independent —
  // derived from the projection alone — so a theme change never rebuilds it.
  const pressables = useMemo(
    () => (projected ? resolveRunPressables(projected) : undefined),
    [projected],
  );

  // The run's embedded ranges, for the native host and the overlay below.
  // Derived from the projection alone, like pressables.
  const runEmbeds = useMemo(
    () => (projected ? resolveRunEmbeds(projected) : undefined),
    [projected],
  );

  const hostRef = useRef<RunHostHandle | null>(null);

  const entryRef = useRef<RunSelectionEntry | null>(null);
  entryRef.current ??= { span: run.span, projected, host: hostRef };
  const registryEntry = entryRef.current;

  // A layout effect on every commit: a discarded render must not leave the
  // entry on an uncommitted projection, and the handle reads the registry
  // from the layout phase on.
  useLayoutEffect(() => {
    registryEntry.span = run.span;
    registryEntry.projected = projected;
  });

  // Guarded on identity so the old instance's cleanup cannot delete a
  // remount's entry under the same key.
  useLayoutEffect(() => {
    registry.set(selfKey, registryEntry);
    return () => {
      if (registry.get(selfKey) === registryEntry) {
        registry.delete(selfKey);
      }
    };
  }, [registry, selfKey, registryEntry]);

  // An unmounting host emits no final change, so the clear is reported here.
  // The handler is read through a ref so this fires only at unmount, and in
  // the layout phase so `getSelection()` never returns a run already gone.
  const latestSelectionReport = useLatest(onSelectionChange);
  useLayoutEffect(
    () => () => {
      latestSelectionReport.current?.({ kind: 'clear' }, selfKey);
    },
    [latestSelectionReport, selfKey],
  );

  // A new projection can give an unchanged display range different source
  // offsets, and the host reports nothing, so the document remaps. A run gone
  // standalone reports a null projection here.
  useLayoutEffect(() => {
    latestSelectionReport.current?.({ kind: 'reproject', projected }, selfKey);
  }, [latestSelectionReport, projected, selfKey]);

  // Keyed by source span (see `embedRectKey`) so rects survive reprojection:
  // hosts re-report only rects that moved, so a dropped one stays dropped.
  const [rects, setRects] =
    useState<ReadonlyMap<string, EmbedRect>>(NO_EMBED_RECTS);

  const onNativeEmbedLayout = useCallback(
    (event: EmbedLayoutEvent) => {
      const embeds = projected?.embeds;
      if (!embeds) {
        return;
      }
      setRects((previous) => applyEmbedRect(previous, embeds, event));
    },
    [projected],
  );

  // The native half of link presses. `pressableId` is the index RunHost
  // assigned when it sent the ranges — which is the index into this same
  // list, so the lookup is the whole resolution. The bounds check absorbs
  // version skew (an event against a list that was swapped in the same
  // frame).
  //
  // `onLinkPress` EXISTS BECAUSE `openUrl` WAS NOT ACTUALLY THE SAME
  // BEHAVIOUR. This used to call `openUrl` unconditionally, justified as
  // matching the JS `link` renderer so that "a link must not act differently
  // depending on whether the native module is linked" — but the renderer is
  // OVERRIDABLE, and a consumer that had replaced it (in-app routing, a sheet,
  // an analytics hop) got its own handler on the renderer path and this
  // hardcoded `openUrl` on the run path. The divergence was invisible only
  // because such consumers also had to mark link-bearing blocks `standalone`
  // to keep blocked links alive, so the run path never ran for them. Fixing
  // blocked links removes that cover, which makes this the same bug's second
  // half rather than a separate feature.
  //
  // When a handler is supplied it owns routing completely — including blocked
  // ranges, which are the whole reason a consumer wants this. With none, the
  // default stands: live links open, blocked links do nothing, because the URL
  // policy already refused them as destinations.
  //
  // `openUrl` re-checks `linkPrefixes`: a substituted engine's output never
  // went through the URL policy.
  const onNativeInlinePress = useCallback(
    (event: InlinePressEvent) => {
      const target = pressables?.[event.pressableId];
      if (!target) return;
      if (onLinkPress) {
        onLinkPress({
          href: target.href,
          blocked: target.blocked === true,
          start: target.start,
          end: target.end,
        });
        return;
      }
      if (!target.blocked) openUrl(target.href, linkPrefixes);
    },
    [pressables, onLinkPress, linkPrefixes],
  );

  const onNativeSelectionAction = useCallback(
    (event: SelectionActionEvent) => {
      if (!onSelectionCopy || !projected) {
        return;
      }
      const payload = handleSelectionAction(doc, run, event, {
        projected,
        // This run's menu, so a consumer id reaches the handler as itself
        // rather than being normalized as version skew.
        actions: selectionActions,
        // The same glyphs `projected` was built with, so the payload's
        // `plain` shows the markers the user saw on screen.
        glyphs: theme.glyphs,
        // And the same embed lookup, for the same reason — `projected` is
        // supplied so the fallback reprojection should never run, but if it
        // ever does it must not run with different offsets.
        embed,
      });
      if (payload) {
        onSelectionCopy(payload);
      }
    },
    [onSelectionCopy, projected, doc, run, theme.glyphs, embed, selectionActions],
  );

  const onNativeSelectionChange = useCallback(
    (event: SelectionChangeEvent) => {
      if (!onSelectionChange) {
        return;
      }
      onSelectionChange(
        {
          kind: 'select',
          range: { start: event.start, end: event.end },
          projected,
        },
        selfKey,
      );
    },
    [onSelectionChange, projected, selfKey],
  );

  const marginStyle = useMemo(() => ({ marginBottom: gap }), [gap]);
  const embedContainerStyle = useMemo(() => ({ position: 'relative' as const, marginBottom: gap }), [gap]);

  if (run.standalone) {
    return (
      <View style={marginStyle}>{renderBlocks(run.blocks, ctx)}</View>
    );
  }

  const host = (
    <RunHost
      attributes={attributes}
      decorations={decorations}
      embeds={runEmbeds}
      exclusiveSelection={exclusiveSelection}
      onEmbedLayout={runEmbeds?.length ? onNativeEmbedLayout : undefined}
      onInlinePress={pressables?.length ? onNativeInlinePress : undefined}
      onSelectionAction={onSelectionCopy ? onNativeSelectionAction : undefined}
      onSelectionChange={onSelectionChange ? onNativeSelectionChange : undefined}
      pressables={pressables}
      ref={hostRef}
      selectable={run.selectable}
      selectionActions={selectionActions}
      text={projected?.text ?? ''}
      unsettledTail={unsettledTail}
    />
  );

  // Keep the native host mounted when its first embed arrives.
  return (
    <View style={embedContainerStyle}>
      {host}
      {!unsettledTail &&
        projected?.embeds?.map((entry) => {
          const key = embedRectKey(entry);
          const rect = rects.get(key);
          if (!rect) {
            return null;
          }
          const spec = entry.content as Partial<EmbedSpec>;
          if (typeof spec.render !== 'function') {
            return null;
          }
          const Overlay = embedOverlayFor(spec.render);
          return (
            <Overlay
              ctx={ctx}
              key={`embed:${key}`}
              node={entry.node}
              rect={rect}
              render={spec.render}
            />
          );
        })}
    </View>
  );
}

/**
 * One wrapper component per `render` function: `render`'s hooks get their own
 * instance, and a different `render` for the same span remounts instead of
 * inheriting a hook list.
 */
type EmbedRender = (node: AnyNode, ctx: RenderContext) => ReactNode;

type EmbedOverlayProps = {
  render: EmbedRender;
  node: AnyNode;
  ctx: RenderContext;
  rect: EmbedRect;
};

type EmbedOverlayType = ((props: EmbedOverlayProps) => ReactNode) & {
  displayName?: string;
};

const embedOverlays = new WeakMap<EmbedRender, EmbedOverlayType>();

function embedOverlayFor(render: EmbedRender): EmbedOverlayType {
  const cached = embedOverlays.get(render);
  if (cached !== undefined) {
    return cached;
  }
  function EmbedOverlay(props: EmbedOverlayProps): ReactNode {
    const { render: draw, node, ctx, rect } = props;
    return (
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
      >
        {draw(node, ctx)}
      </View>
    );
  }
  EmbedOverlay.displayName = `EmbedOverlay(${render.name || 'anonymous'})`;
  embedOverlays.set(render, EmbedOverlay);
  return EmbedOverlay;
}

function sameBlockIdentity(a: Block[], b: Block[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Per-run memoization keyed on the run's span plus settled block identity.
 * `doc` is deliberately not compared: when a run's span and every block
 * reference are unchanged, its render output is unchanged too — settled
 * blocks keep referential identity and their spans index into a source
 * prefix that no longer changes.
 *
 * A growing settled run fails this once per settle; the projection cache keeps
 * that re-render cheap. Handlers are stable wrappers, so they differ only on
 * presence, and `selectionActions` is compared by value for inline literals.
 */
function runPropsEqual(prev: RunViewProps, next: RunViewProps): boolean {
  return (
    prev.run.span.start === next.run.span.start &&
    prev.run.span.end === next.run.span.end &&
    prev.run.selectable === next.run.selectable &&
    prev.run.standalone === next.run.standalone &&
    sameBlockIdentity(prev.run.blocks, next.run.blocks) &&
    prev.gap === next.gap &&
    prev.unsettledTail === next.unsettledTail &&
    prev.theme === next.theme &&
    prev.renderers === next.renderers &&
    sameSelectionActionList(prev.selectionActions, next.selectionActions) &&
    prev.onSelectionCopy === next.onSelectionCopy &&
    prev.onLinkPress === next.onLinkPress &&
    prev.onSelectionChange === next.onSelectionChange &&
    prev.attributeForMark === next.attributeForMark &&
    prev.embed === next.embed &&
    prev.linkPrefixes === next.linkPrefixes &&
    prev.exclusiveSelection === next.exclusiveSelection &&
    // Constant in practice, but compared so a memo cannot keep a stale
    // registration.
    prev.registry === next.registry &&
    prev.runKey === next.runKey
  );
}

const MemoRunView = memo(RunView, runPropsEqual);



const warnedPairs = new Set<string>();

function warnAboutPairedProps(props: SelectableMarkdownProps): void {
  if (!IS_DEV) {
    return;
  }
  if (
    props.selectionActions !== undefined &&
    props.selectionActions.length > 0 &&
    props.onSelectionCopy === undefined &&
    !warnedPairs.has('selectionActions')
  ) {
    warnedPairs.add('selectionActions');
    console.warn(
      '[react-native-selectable-markdown] selectionActions was set without ' +
        'onSelectionCopy, so the selection menu offers NO custom items at all ' +
        '(a menu item with no handler reports nowhere). Pass onSelectionCopy, ' +
        'or drop selectionActions — a handler on its own already gets both ' +
        'default items.',
    );
  }
  if (props.selectionActions !== undefined) {
    // Latched per id inside the helper, since each document may offer a
    // different list.
    warnAboutUntitledSelectionActions(props.selectionActions);
  }
  if (
    props.session !== undefined &&
    props.source !== undefined &&
    props.source.length > 0 &&
    !warnedPairs.has('source')
  ) {
    warnedPairs.add('source');
    console.warn(
      '[react-native-selectable-markdown] both source and session were given; ' +
        'the session supersedes source, which is never parsed. Pass one or the ' +
        'other.',
    );
  }
  const parseOptions = props.session
    ? props.session.parseContext.options
    : props.options;
  if (
    parseOptions?.urlPolicy?.blockedLinks === 'node' &&
    props.renderers?.link !== undefined &&
    props.onLinkPress === undefined &&
    props.embed === undefined &&
    props.classifyBlock === undefined &&
    !warnedPairs.has('blockedLinks')
  ) {
    warnedPairs.add('blockedLinks');
    console.warn(
      '[react-native-selectable-markdown] urlPolicy.blockedLinks: "node" was ' +
        'set with a link renderer, but inside a selection run there are no ' +
        'renderers: a blocked link is a "blockedLink" mark over the run text, ' +
        'so the override runs only for blocks that are already standalone. ' +
        'Route the press with onLinkPress, draw a real element with embed, or ' +
        'send the block to the renderer path with classifyBlock.',
    );
  }
}

/**
 * Updated in a layout effect: a discarded render must not leak into the ref,
 * and `RunView`'s layout effects declared after it read this commit's value.
 */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function SelectableMarkdownWithRef(
  props: SelectableMarkdownProps,
  ref: Ref<SelectableMarkdownHandle>,
): ReactNode {
  const {
    source,
    session,
    options,
    engine,
    theme,
    colorScheme,
    renderers,
    classifyBlock,
    maxRunChars,
    embed,
    images,
    selectionActions,
    onSelectionCopy,
    onLinkPress,
    onSelectionChange,
    exclusiveSelection = true,
    attributeForMark,
    style,
    onLayout,
    testID,
    // The remainder is exactly `SelectableMarkdownAccessibilityProps`.
    ...accessibility
  } = props;

  warnAboutPairedProps(props);

  const latestSelectionCopy = useLatest(onSelectionCopy);
  const latestLinkPress = useLatest(onLinkPress);
  const latestSelectionChange = useLatest(onSelectionChange);
  const latestExclusiveSelection = useLatest(exclusiveSelection);
  const stableSelectionCopy = useCallback(
    (payload: SelectionCopyEvent) => latestSelectionCopy.current?.(payload),
    [latestSelectionCopy],
  );
  const stableLinkPress = useCallback(
    (press: InlineLinkPress) => latestLinkPress.current?.(press),
    [latestLinkPress],
  );
  // Presence is a switch: `onSelectionCopy` decides whether custom items
  // exist, and `onLinkPress` whether built-in routing is taken over.
  const runSelectionCopy = onSelectionCopy ? stableSelectionCopy : undefined;
  const runLinkPress = onLinkPress ? stableLinkPress : undefined;

  const registryRef = useRef<RunSelectionRegistry | null>(null);
  registryRef.current ??= new Map();
  const registry = registryRef.current;

  // An empty report from a run that is not the recorded owner is stale: hosts
  // report their own range before clearing the previous owner. Transitions
  // live in `selectionTracking.ts`.
  const selectionStateRef = useRef<SelectionTrackingState>(
    EMPTY_SELECTION_STATE,
  );

  const applySelection = useCallback(
    (result: SelectionTrackingResult) => {
      selectionStateRef.current = result.state;
      if (result.emit) {
        latestSelectionChange.current?.(result.state.selection);
      }
    },
    [latestSelectionChange],
  );

  const stableSelectionChange = useCallback(
    (report: RunSelectionReport, runKey: string) => {
      applySelection(
        reduceRunSelection(selectionStateRef.current, runKey, report, latestExclusiveSelection.current),
      );
    },
    [applySelection, latestExclusiveSelection],
  );

  // A ref alone also subscribes: `getSelection()` reads state only the event
  // feeds.
  const runSelectionChange =
    onSelectionChange !== undefined || (ref !== null && ref !== undefined)
      ? stableSelectionChange
      : undefined;

  useImperativeHandle(
    ref,
    () => ({
      getSelection: () => selectionStateRef.current.selection,
      clearSelection() {
        const owner = selectionStateRef.current.owner;
        applySelection(resetSelection(selectionStateRef.current));
        if (exclusiveSelection) {
          // Only the owner can hold a selection; skip a bridge message per run.
          if (owner !== null) {
            registry.get(owner)?.host.current?.clearSelection();
          }
        } else {
          for (const entry of registry.values()) {
            entry.host.current?.clearSelection();
          }
        }
      },
      setSelection(span: SourceSpan) {
        if (span === null || typeof span !== 'object') {
          return false;
        }
        return selectSpanInRuns(registry.values(), span);
      },
    }),
    [registry, exclusiveSelection, applySelection],
  );

  // Always subscribed, even under an explicit scheme — hooks cannot be
  // conditional — but the appearance only decides the base under 'auto'.
  // The memo keeps the resolved theme referentially stable across renders:
  // runPropsEqual and every downstream memo compare it by identity, and
  // streaming re-renders this component every tick.
  const systemScheme = useColorScheme();
  const scheme = colorScheme ?? 'auto';
  const dark =
    scheme === 'dark' || (scheme === 'auto' && systemScheme === 'dark');
  const mergedTheme = useMemo(
    () => mergeTheme(theme, dark ? defaultDarkTheme : defaultTheme),
    [theme, dark],
  );
  const rendererMap = useMemo(() => resolveRenderers(renderers), [renderers]);

  // `parseContext` allocates its wrapper per call, so the memo keys on the
  // options inside it.
  const parseOptions = session ? session.parseContext.options : options;
  // Checked at navigation time because a substituted engine need not apply
  // `urlPolicy`. Memoized because `runPropsEqual` compares it by identity.
  const linkPrefixes = useMemo(
    () => resolveOptions(parseOptions).urlPolicy.linkPrefixes,
    [parseOptions],
  );

  const snapshot = useSessionSnapshot(session);

  // NO ENGINE PROP MEANS `parseDocument` USES `nativeEngine`, and this render
  // path deliberately does not probe the platform first to decide that.
  //
  // It used to. An `isNativeEngineAvailable() ? nativeEngine : undefined` gate
  // resolved once per JS runtime sat here, because `undefined` was meaningful:
  // it let `parseDocument` reach the TypeScript parser the package used to
  // bundle, and handing an unusable `nativeEngine` to a binary without the
  // module would have turned a missing pod into a render crash on every
  // platform that never had one. With that second parser gone both arms of the
  // gate lead to the same engine, so the probe could only buy a synchronous
  // native round trip on the first render in exchange for throwing a different
  // exception — and `nativeEngine`'s own error is the better one, because it
  // names the rebuild (or `scripts/build-node-addon.mjs`) that would fix it.
  const staticDoc = useMemo(
    () => (session ? null : parseDocument(source ?? '', options, engine)),
    [session, source, options, engine],
  );

  const doc = snapshot?.document ?? staticDoc ?? EMPTY_DOCUMENT;
  const streaming = snapshot?.phase === 'streaming';
  // True for the whole life of a session-backed document, so `runKey` keeps
  // the tail host when the stream stops.
  const streamed = snapshot !== null;
  const settledUntil =
    streaming && snapshot ? snapshot.settledUntil : doc.source.length;

  const visibleDoc = useMemo(() => {
    if (!streaming) {
      return doc;
    }
    const trimmed = trimTrailingPlaceholders(doc.blocks);
    return trimmed === doc.blocks
      ? doc
      : { source: doc.source, blocks: trimmed };
  }, [doc, streaming]);

  // Keyed on the box tokens, not the theme: the lookup is part of the
  // projection key, and a colour change must not reproject every run.
  const { imageWidth, imageHeight } = mergedTheme.spacing;
  const embedLookup = useMemo(
    () =>
      images === 'standalone'
        ? embed
        : withImageEmbeds(embed, { width: imageWidth, height: imageHeight }),
    [embed, images, imageWidth, imageHeight],
  );

  const runs = useMemo(
    () =>
      segmentRuns(visibleDoc, {
        settledUntil,
        classifyBlock,
        embed: embedLookup,
        maxRunChars,
        // Keeps the last block in the tail while streaming, so a chunk ending
        // on a blank line does not remount the tail host.
        liveTail: streaming,
      }),
    [
      visibleDoc,
      settledUntil,
      classifyBlock,
      embedLookup,
      maxRunChars,
      streaming,
    ],
  );

  // The gap below a PROSE run that abuts another PROSE run is the height of
  // the blank line the '\n\n' block separator would render between them —
  // NOT `spacing.blockGap`. Two flowing runs are only ever adjacent because
  // segmentRuns split prose between them (the settled boundary or the
  // run-size budget), so the blank-line height draws them where one run
  // would. A code block or table at the split still loses its edge padding
  // when the tail merges into it.
  const proseGap = Math.round(
    mergedTheme.fonts.baseSize * mergedTheme.fonts.lineHeight,
  );

  const containerPadding = useMemo(
    () => ({ padding: mergedTheme.spacing.containerPadding }),
    [mergedTheme.spacing.containerPadding],
  );
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => style === undefined ? containerPadding : [containerPadding, style],
    [containerPadding, style],
  );

  return (
    <View
      {...accessibility}
      onLayout={onLayout}
      style={containerStyle}
      testID={testID}
    >
      {runs.map((run, index) => {
        const next = runs[index + 1];
        const gap =
          !run.standalone && next !== undefined && !next.standalone
            ? proseGap
            : mergedTheme.spacing.blockGap;
        const unsettledTail = streaming && run.span.end > settledUntil;
        // The tail is not keyed by start: a moved key remounts the host under a
        // live selection. `streamed`, not `unsettledTail`, so the tail keeps
        // its key when the stream ends.
        const key = runKey(run, index, runs.length, streamed);
        return (
          <MemoRunView
            attributeForMark={attributeForMark}
            doc={visibleDoc}
            embed={embedLookup}
            exclusiveSelection={exclusiveSelection}
            gap={gap}
            key={key}
            linkPrefixes={linkPrefixes}
            onLinkPress={runLinkPress}
            onSelectionChange={runSelectionChange}
            onSelectionCopy={runSelectionCopy}
            registry={registry}
            renderers={rendererMap}
            run={run}
            runKey={key}
            selectionActions={selectionActions ?? DEFAULT_SELECTION_ACTIONS}
            theme={mergedTheme}
            unsettledTail={unsettledTail}
          />
        );
      })}
    </View>
  );
}

/**
 * Attaching a ref subscribes to selection changes, since `getSelection()` has
 * nothing to report otherwise.
 */
export const SelectableMarkdown = forwardRef(SelectableMarkdownWithRef);
SelectableMarkdown.displayName = 'SelectableMarkdown';
