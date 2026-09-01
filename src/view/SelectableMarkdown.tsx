import { memo, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import { View, useColorScheme } from 'react-native';
import type { AnyNode, Block, ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import type { Engine } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import { projectRun } from '../selection/mapSelection';
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
  SelectionActionEvent,
} from './RunHost';
import { openUrl, renderBlocks, resolveRenderers } from './renderers';
import type { RenderContext, RendererMap, RendererOverrides } from './renderers';
import { resolveRunAttributes } from './runAttributes';
import type { MarkAttribute } from './runAttributes';
import { resolveRunDecorations } from './runDecorations';
import { resolveRunEmbeds } from './runEmbeds';
import { resolveRunPressables } from './runPressables';
import {
  DEFAULT_SELECTION_ACTIONS,
  handleSelectionAction,
} from './selectionActions';
import type { SelectionAction, SelectionCopyEvent } from './selectionActions';
import { defaultDarkTheme, defaultTheme, mergeTheme } from './theme';
import type { MarkdownTheme, PartialTheme } from './theme';

export * from './selectionActions';

export interface SelectableMarkdownProps {
  source?: string;
  session?: StreamSession;
  /** Parse options for `source`; a session carries its own options. */
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
   */
  theme?: PartialTheme;
  /**
   * Which built-in base theme the `theme` overrides layer onto: 'light' is
   * `defaultTheme`, 'dark' is `defaultDarkTheme`, and 'auto' (the default)
   * follows the system appearance via `useColorScheme()` — flipping the
   * device's appearance restyles the document in place.
   */
  colorScheme?: 'light' | 'dark' | 'auto';
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
   */
  embed?: EmbedRenderer;
  /**
   * Which custom actions the platform selection menu offers, in order.
   * Default: both. The system Copy item always remains on both platforms.
   *
   * REQUIRES `onSelectionCopy`. Custom items are suppressed entirely when
   * there is no handler for them — a menu item that reports nowhere is worse
   * than one that is not offered — so `selectionActions={['copy-markdown']}`
   * on its own yields an EMPTY custom menu, not a one-item one. Set both, or
   * neither.
   */
  selectionActions?: SelectionAction[];
  /**
   * Called when the user picks one of `selectionActions`. Also the switch
   * that puts those items on the menu at all; see `selectionActions`.
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
   * Give it a stable identity (`useCallback`) — it participates in the per-run
   * memo comparison.
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
  testID?: string;
}

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

/** One reported embed rect, in the run host's coordinate space. */
interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const NO_EMBED_RECTS: ReadonlyMap<number, EmbedRect> = new Map();

const EMPTY_DOCUMENT: ParsedDocument = { source: '', blocks: [] };

function useSessionSnapshot(session?: StreamSession): SessionSnapshot | null {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!session) {
      return undefined;
    }
    const unsubscribe = session.subscribe(() => bump());
    // Catch updates delivered between render and subscription.
    bump();
    return unsubscribe;
  }, [session]);
  return session ? session.snapshot() : null;
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
  selectionActions: readonly SelectionAction[];
  onSelectionCopy?: (payload: SelectionCopyEvent) => void;
  onLinkPress?: (press: InlineLinkPress) => void;
  attributeForMark?: MarkAttribute;
  embed?: EmbedRenderer;
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
  } = props;

  const ctx: RenderContext = useMemo(
    () => ({ theme, renderers, source: doc.source, listDepth: 0 }),
    [theme, renderers, doc.source],
  );

  // Keyed on the glyph VALUES, not the theme object: the marker glyphs are
  // part of the projected text — and so of every offset downstream — while
  // the rest of the theme only styles it. A colour change must restyle
  // without reprojecting; a stale projection under new glyphs would corrupt
  // every attribute, decoration and pressable range built from it. The
  // `embed` callback joins the key for the same reason: a claim replaces a
  // node's projection with a placeholder character, so a different lookup is
  // different projected text.
  const { bullet, taskChecked, taskUnchecked } = theme.glyphs;
  const projected = useMemo(
    () =>
      run.standalone
        ? null
        : projectRun(run, doc, {
            glyphs: { bullet, taskChecked, taskUnchecked },
            embed,
          }),
    [run, doc, bullet, taskChecked, taskUnchecked, embed],
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

  // Reported rects, keyed by embedId and OWNED BY the projection they were
  // reported against: embedIds are per-projection ordinals, so a rect that
  // arrived for a previous projection must never position an overlay over
  // the current one. Tying ownership to `projected`'s identity drops stale
  // rects at read time, with no effect and no extra render on a swap.
  const [embedRects, setEmbedRects] = useState<{
    owner: ProjectedRun | null;
    rects: ReadonlyMap<number, EmbedRect>;
  }>({ owner: null, rects: NO_EMBED_RECTS });
  const rects =
    embedRects.owner === projected ? embedRects.rects : NO_EMBED_RECTS;

  const onNativeEmbedLayout = useCallback(
    (event: EmbedLayoutEvent) => {
      // Bounds-check the id against the list this projection sent — the
      // pressableId discipline: a report can race a prop swap by a frame.
      if (
        !projected?.embeds ||
        !Number.isInteger(event.embedId) ||
        event.embedId < 0 ||
        event.embedId >= projected.embeds.length
      ) {
        return;
      }
      setEmbedRects((previous) => {
        const rects = new Map(
          previous.owner === projected ? previous.rects : NO_EMBED_RECTS,
        );
        rects.set(event.embedId, {
          x: event.x,
          y: event.y,
          width: event.width,
          height: event.height,
        });
        return { owner: projected, rects };
      });
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
      if (!target.blocked) openUrl(target.href);
    },
    [pressables, onLinkPress],
  );

  const onNativeSelectionAction = useCallback(
    (event: SelectionActionEvent) => {
      if (!onSelectionCopy || !projected) {
        return;
      }
      const payload = handleSelectionAction(doc, run, event, {
        projected,
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
    [onSelectionCopy, projected, doc, run, theme.glyphs, embed],
  );

  if (run.standalone) {
    return (
      <View style={{ marginBottom: gap }}>{renderBlocks(run.blocks, ctx)}</View>
    );
  }

  const host = (
    <RunHost
      attributes={attributes}
      decorations={decorations}
      embeds={runEmbeds}
      onEmbedLayout={runEmbeds?.length ? onNativeEmbedLayout : undefined}
      onInlinePress={pressables?.length ? onNativeInlinePress : undefined}
      onSelectionAction={onSelectionCopy ? onNativeSelectionAction : undefined}
      pressables={pressables}
      selectable={run.selectable}
      selectionActions={selectionActions}
      style={runEmbeds?.length ? undefined : { marginBottom: gap }}
      text={projected?.text ?? ''}
      unsettledTail={unsettledTail}
    />
  );

  // Runs without embeds keep the exact structure they always had — no
  // wrapper, margin on the host. A run WITH embeds gains a relatively
  // positioned wrapper (the margin moves onto it, so layout is unchanged)
  // holding one absolutely positioned overlay per embed whose rect the host
  // has reported. The overlay is a SIBLING of the host, not a child: the
  // native component is a leaf on both architectures and cannot mount React
  // children. `pointerEvents="box-none"` keeps the positioning wrapper from
  // swallowing touches around the card; the card itself owns its own area —
  // which also means a long-press ON the card starts no selection, the
  // documented trade for it being tappable.
  //
  // While the run is the unsettled streaming tail no overlay mounts at all:
  // repair can rewrite the tail's text every tick, and a card sliding around
  // over moving prose is the artifact this library exists to avoid. The
  // reservation is native either way, so nothing reflows when the run
  // settles and the card appears.
  if (!runEmbeds?.length || !projected?.embeds) {
    return host;
  }
  return (
    <View style={{ position: 'relative', marginBottom: gap }}>
      {host}
      {!unsettledTail &&
        projected.embeds.map((entry) => {
          const rect = rects.get(entry.embedId);
          if (!rect) {
            return null;
          }
          const spec = entry.content as Partial<EmbedSpec>;
          if (typeof spec.render !== 'function') {
            return null;
          }
          return (
            <View
              key={`embed:${entry.embedId}`}
              pointerEvents="box-none"
              style={{
                position: 'absolute',
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            >
              {spec.render(entry.node, ctx)}
            </View>
          );
        })}
    </View>
  );
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

function sameActionList(
  a: readonly SelectionAction[],
  b: readonly SelectionAction[],
): boolean {
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
    sameActionList(prev.selectionActions, next.selectionActions) &&
    prev.onSelectionCopy === next.onSelectionCopy &&
    prev.onLinkPress === next.onLinkPress &&
    prev.attributeForMark === next.attributeForMark &&
    prev.embed === next.embed
  );
}

const MemoRunView = memo(RunView, runPropsEqual);

export function SelectableMarkdown(props: SelectableMarkdownProps): ReactNode {
  const {
    source,
    session,
    options,
    engine,
    theme,
    colorScheme,
    renderers,
    classifyBlock,
    embed,
    selectionActions,
    onSelectionCopy,
    onLinkPress,
    attributeForMark,
    testID,
  } = props;

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

  const runs = useMemo(
    () => segmentRuns(visibleDoc, { settledUntil, classifyBlock, embed }),
    [visibleDoc, settledUntil, classifyBlock, embed],
  );

  // The gap below a PROSE run that abuts another PROSE run is the height of
  // the blank line the '\n\n' block separator would render between them —
  // NOT `spacing.blockGap`. Two flowing runs are only ever adjacent because
  // the settled boundary split them (segmentRuns breaks prose merging
  // there; every other break has a standalone run between), and that split
  // is a streaming artifact: the moment the tail settles, the same blocks
  // merge into one run whose paragraphs sit one blank line apart. Rendering
  // the split at blockGap made every paragraph visibly drop by the
  // difference the instant it finished streaming; rendering it at the
  // blank-line height makes the merge a layout no-op.
  const proseGap = Math.round(
    mergedTheme.fonts.baseSize * mergedTheme.fonts.lineHeight,
  );

  return (
    <View
      style={{ padding: mergedTheme.spacing.containerPadding }}
      testID={testID}
    >
      {runs.map((run, index) => {
        const next = runs[index + 1];
        const gap =
          !run.standalone && next !== undefined && !next.standalone
            ? proseGap
            : mergedTheme.spacing.blockGap;
        return (
          <MemoRunView
            attributeForMark={attributeForMark}
            doc={visibleDoc}
            embed={embed}
            gap={gap}
            key={`run:${run.span.start}`}
            onLinkPress={onLinkPress}
            onSelectionCopy={onSelectionCopy}
            renderers={rendererMap}
            run={run}
            selectionActions={selectionActions ?? DEFAULT_SELECTION_ACTIONS}
            theme={mergedTheme}
            unsettledTail={streaming && run.span.end > settledUntil}
          />
        );
      })}
    </View>
  );
}
