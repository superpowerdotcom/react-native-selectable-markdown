import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { mapSelectionToSource } from '../selection/mapSelection';
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
  selectionDisplayText,
  warnAboutUntitledSelectionActions,
} from './selectionActions';
import type {
  SelectionActionInput,
  SelectionCopyEvent,
} from './selectionActions';
import { selectSpanInRuns } from './selectionRange';
import type { RunSelectionCandidate } from './selectionRange';
import { defaultDarkTheme, defaultTheme, mergeTheme } from './theme';
import type { MarkdownTheme, PartialTheme } from './theme';

// The selection-menu vocabulary a `<SelectableMarkdown>` consumer needs,
// re-exported here so `selectionActions`, `onSelectionAction` and
// `onSelectionCopy` can be typed from the same module the component comes
// from. Named rather than `export *`: the wire codec next to these
// (`encodeSelectionActions`, `decodeSelectionAction`,
// `SELECTION_ACTION_SEPARATOR` and the two accessors) is `RunHost`'s business
// with the native hosts, not a prop vocabulary, and a star here published it
// through the package root as well.
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
   * The markdown to render, parsed on every change of the string.
   *
   * A `session` SUPERSEDES IT COMPLETELY: with both set, the session's
   * document is what renders and this string is never parsed at all (DEV
   * warns, because nothing else about the render says so). Use `source` for a
   * document that has finished arriving and a session for one that has not.
   */
  source?: string;
  /**
   * A stream to render instead of `source`: its committed snapshot is
   * subscribed and redrawn on every commit, and the still-arriving tail
   * follows the per-platform tail policy (`RunHostProps.unsettledTail`).
   */
  session?: StreamSession;
  /**
   * Parse options for `source`; a session carries its own options.
   *
   * Give this a stable identity (module scope, one of `presets`, or
   * `useMemo`): it is a dependency of the parse, so an inline object literal
   * is a new identity on every render and reparses the whole document through
   * md4c each time.
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
   * Give it a stable identity (module scope, or `useMemo`): the merged theme
   * is memoized on this object's identity and every run compares the result
   * by reference, so an inline literal re-merges the theme and re-renders
   * every run on every render of the parent. `mergeTheme(overrides, base)`
   * computes one ahead of render if that is easier than memoizing.
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
   * Per-kind renderer overrides for the STANDALONE path only — and that scope
   * is narrow enough to be the first thing to know about this prop, because
   * an override outside it is not an error, it is simply never called.
   *
   * A block is standalone when it carries a spoiler (the one inline that
   * owns a tap target of its own), when `classifyBlock` claims it, or when
   * it carries an image that nothing claimed as an embed — which under the
   * default `images: 'embed'` means an image the theme's box cannot be
   * reserved for, or one still arriving. Everything else flows into a
   * native selection run: paragraphs, headings, lists and blockquotes, and
   * since they joined the prose kinds, code blocks, tables, thematic breaks
   * and HTML blocks as well. A run is drawn by the native host from `text`
   * plus `attributes`, which is a different rendering path with no React
   * elements in it, so a typical answer produces zero standalone runs and
   * runs no renderer from this map at all. A `codeBlock` or `table`
   * override, in particular, draws nothing until `classifyBlock` claims
   * those blocks back, and a `link` override never draws a blocked link in
   * ordinary prose — that range is a `blockedLink` mark inside a run (DEV
   * warns when those two props are paired).
   *
   * `image` is the one override that reaches BOTH paths: the built-in image
   * embed overlays whatever this map's `image` renderer draws, so there is
   * only ever one image renderer to configure.
   *
   * The channels that DO reach a flowing run: `attributeForMark` for
   * typography and colour, `embed` for a real element inside the sweep,
   * `onLinkPress` for link routing, and the theme for everything a token can
   * express. A look that must apply everywhere has to be stated on both
   * paths.
   *
   * Each renderer is placed as an ELEMENT, so hooks work inside one: it gets
   * its own component instance, and its state lives as long as its node keeps
   * its position in the tree. (`ctx.selectable` is worth passing through to
   * any `selectable` text a renderer draws — see `RenderContext`.)
   *
   * EACH RENDERER FUNCTION IS ITS OWN COMPONENT TYPE, which is what makes
   * `renderers={editing ? draft : read}` safe: replacing the renderer for one
   * kind unmounts the old one and mounts the new one, so two renderers with
   * different hooks never share a hook list. The flip side is the ordinary
   * React rule about inline components — a renderer written as an arrow
   * literal inside JSX is a new function every render and therefore remounts
   * its subtree every render, losing whatever state it held.
   *
   * So give both this object AND the functions in it a stable identity (module
   * scope, or `useMemo`/`useCallback`): the resolved renderer map is memoized
   * on this object's identity and compared by reference per run, so an inline
   * literal re-renders every run.
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
   * How many SOURCE characters one flowing run may span before the next
   * flowing block starts a new one. Default `DEFAULT_MAX_RUN_CHARS` (8000,
   * exported from the package root); `Infinity` opts out.
   *
   * A RUN IS A NATIVE TEXT HOST, AND A CAP IS A SELECTION BOUNDARY. Raising
   * it lets a gesture sweep further in one go and costs a longer re-measure
   * every time the run grows (the host re-lays-out everything it already
   * held); lowering it does the reverse. The default sits far above the
   * documents people actually sweep across — ~1300 words — so an ordinary
   * message is exactly one run and this prop changes nothing for it.
   *
   * The cap only ever breaks BETWEEN top-level blocks, so a single enormous
   * block is one run whatever this says. See `segmentRuns` for the packing
   * rule that keeps every boundary stable as the document grows.
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
   * The `render` INSIDE a returned claim wants a stable identity too, for a
   * different reason: it is the overlay's component type (see `EmbedSpec`), so
   * a fresh arrow per call remounts the card every time the document is
   * reprojected, while a different function genuinely does remount — which is
   * what keeps an app that swaps one card for another out of React's hook
   * bookkeeping.
   */
  embed?: EmbedRenderer;
  /**
   * How an image participates in selection. Default `'embed'`.
   *
   * `'embed'` claims every image node as an embed, exactly as the `embed`
   * prop would: the image projects one placeholder character, the host
   * reserves `spacing.imageWidth` × `spacing.imageHeight` there, and the
   * `image` renderer (yours, if you overrode it) is overlaid on the reserved
   * space. The point is what it does NOT do — an image no longer demotes its
   * paragraph, list or table to `standalone`, so one gesture still sweeps
   * across an illustrated answer and the block keeps `onSelectionCopy`.
   *
   * `'standalone'` restores the older behaviour: the image's containing
   * block leaves the run and renders through `renderers`. Choose it when the
   * picture matters more than the sweep — when your images are full-bleed,
   * or sized from their own intrinsic aspect ratio, neither of which a fixed
   * declared box can express, and when a streamed image should draw the
   * instant it arrives: an embedded one follows the ordinary overlay rule
   * and stays reserved-but-unmounted while its run is the unsettled tail.
   *
   * Your own `embed` claim is consulted first either way, so a consumer that
   * already claims image nodes is unaffected by this prop.
   *
   * ONE INTERACTION TO KNOW ABOUT: an embed claim beats a `classifyBlock`
   * claim on the same node, so `classifyBlock: (n) => n.kind === 'image' ?
   * 'standalone' : undefined` no longer forces the block out of the run —
   * `images: 'standalone'` is what does that now (claiming the containing
   * BLOCK still works, as it always did).
   */
  images?: ImageMode;
  /**
   * Which custom actions the platform selection menu offers, in order.
   * Default: both built-ins. The system Copy item always remains on both
   * platforms.
   *
   * AN ENTRY IS AN ID OR AN `{ id, title }` PAIR, and the title is how the
   * menu gets localised. A bare id keeps the host's own string — 'copy-text'
   * and 'copy-markdown' have one on each platform (iOS `NSLocalizedString`
   * against `Bundle.main`, Android `R.string.selectable_markdown_copy_*`),
   * both overridable in that platform's resources. Passing a title instead
   * routes the label through whatever i18n the app already has, in one place
   * for both platforms:
   *
   *   selectionActions={[
   *     { id: 'copy-text', title: t('copyText') },
   *     { id: 'copy-markdown', title: t('copyMarkdown') },
   *   ]}
   *
   * ANY OTHER ID IS YOUR OWN ACTION, and it arrives in `onSelectionCopy` as
   * `payload.action` with the same `plain`/`markdown`/`span` a built-in item
   * would have produced — the library does the mapping and hands it over
   * rather than copying anything itself:
   *
   *   selectionActions={['copy-text', { id: 'share', title: t('share') }]}
   *
   * A consumer id MUST carry a title. Neither host has a string for an id it
   * does not recognise, so an untitled one never appears on the menu; DEV
   * warns when that is the shape it is given.
   *
   * REQUIRES `onSelectionCopy`. Custom items are suppressed entirely when
   * there is no handler for them — a menu item that reports nowhere is worse
   * than one that is not offered — so `selectionActions={['copy-markdown']}`
   * on its own yields an EMPTY custom menu, not a one-item one. DEV warns
   * when that is the shape it is given, because nothing else does: the
   * document renders exactly as it should, minus the menu.
   *
   * The dependency runs one way only. `onSelectionCopy` on its own — the
   * common case — needs nothing here: the default list stands and the menu
   * offers both items.
   */
  selectionActions?: readonly SelectionActionInput[];
  /**
   * Called when the user picks one of `selectionActions`. Also the switch
   * that puts those items on the menu at all; see `selectionActions`.
   *
   * Identity does not matter here, unlike `theme`, `options` or
   * `attributeForMark`: the component keeps the latest handler in a ref and
   * hands every run one stable wrapper, so an inline arrow costs nothing.
   * PRESENCE matters — whether a handler exists at all is what decides
   * whether the custom menu items are offered, so a handler that appears
   * later does re-render the runs, once.
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
   * Identity does not matter, for the same reason as `onSelectionCopy`: the
   * latest handler is held in a ref behind one stable wrapper per run. This
   * line used to ask for a `useCallback` because the raw handler took part in
   * the per-run memo comparison, which it no longer does. Presence still
   * does: supplying a handler at all is what takes routing over.
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
   * Called whenever the document's selection changes — as the user drags a
   * handle, when a tap dismisses it, when `setSelection` moves it, and when a
   * selection elsewhere takes it away. `null` means nothing is selected.
   *
   * THIS IS THE PROP A FLOATING TOOLBAR IS BUILT ON, and it is the thing
   * `onSelectionCopy` could never be: that one fires once, after the user has
   * already committed to a platform menu item, so an app that wants its own
   * toolbar had no way to learn a selection existed at all.
   *
   * IT IS ALSO A SWITCH, and what it switches is the JS work. Identity does
   * not matter (the latest handler is kept in a ref behind one stable
   * wrapper), but PRESENCE does, exactly like `onSelectionCopy`: without this
   * handler AND without a `ref`, no run maps its offsets through the piece
   * table or slices its display text while a handle is dragged. The native
   * dispatch itself is not gated — Fabric gives a host no way to know whether
   * JS is listening — so the hosts' own dedupe is what keeps that side down
   * to genuine changes.
   *
   * The payload's `span` is the same source range copying the selection would
   * produce, construct syntax included; see `SelectableMarkdownSelection`,
   * which also says how to get the markdown for it. What arrives here can lag
   * a gesture by a frame, like any native event — `getSelection()` on the ref
   * reads the same value, and neither is a substitute for the other.
   */
  onSelectionChange?: (selection: SelectableMarkdownSelection | null) => void;
  /**
   * Whether this document's runs take part in the process-wide
   * one-active-selection coordination. Default `true`, which is the behaviour
   * that predates the prop.
   *
   * WHAT TRUE BUYS. Neither platform clears one text view's selection because
   * a selection began in another, so without coordination a transcript
   * accumulates live selections: only the focused run draws a highlight, but
   * every earlier range is still set, still reported through
   * `onSelectionChange`, and still what `getSelection()` and a copy would use.
   * Every host therefore claims a single process-wide slot when a selection
   * lands in it and clears whoever held it before, which is what makes "the
   * document has one selection" true of the state and not just of the pixels.
   *
   * WHAT FALSE IS FOR. The coordination is per PROCESS, so by default two
   * unrelated `<SelectableMarkdown>` trees — two messages in a transcript, two
   * panes in a split view — erase each other's selections, and a consumer
   * cannot even build cross-message copy by hand (select in A, select in B,
   * merge the two payloads) because the second selection destroys the first.
   * `exclusiveSelection={false}` opts this document's runs out in BOTH
   * directions: they clear nobody, and because they never take the slot,
   * nobody clears them.
   *
   * THE COST IS REAL AND IT IS YOURS TO MANAGE, and the first part of it is
   * that the older selections are INVISIBLE. Neither platform draws a
   * selection in a view that does not hold focus — a non-editable
   * `UITextView` paints nothing unless it is first responder, and Android's
   * `TextView` only while it is focused or pressed — so when a second run
   * takes focus the first one's range survives everywhere it matters (the
   * event fired, `getSelection()` answers with it, the copy payload is exact)
   * while the highlight under it disappears. Draw your own if the reader needs
   * to see it. `clearSelection()` also has to clear every mounted run rather
   * than the one run that holds the slot.
   *
   * Document-level cross-view selection — one gesture that genuinely spans
   * two messages — is not this prop; it is still future work.
   */
  exclusiveSelection?: boolean;
  /**
   * Style for the document's container view, composed OVER the padding
   * `spacing.containerPadding` sets — so `{ padding: 16 }` here wins, and a
   * margin or background needs nothing from the theme at all.
   *
   * It exists because the container is otherwise unreachable: the theme's one
   * token is padding, and every other box in the document belongs to a run.
   * The token still defaults to 0, so a consumer's own wrapper has never had
   * to fight it; this is for the cases where a wrapper is one view too many.
   */
  style?: StyleProp<ViewStyle>;
  /** Layout of the container view — the document's measured box, which is
   * what a consumer needs to size or scroll around it. */
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Test identifier for the container view. The per-run native hosts carry
   * none of their own, so this is the document's one handle. */
  testID?: string;
}

/**
 * The accessibility props the document container accepts, forwarded verbatim
 * to its root `View`.
 *
 * DELIBERATELY THE CONTAINER'S, NOT EACH RUN'S. A document is one thing to
 * label ("assistant reply"), and the per-run hosts already read their own text
 * out — each is a plain `UITextView`/`TextView`.
 *
 * HEADINGS AND LINKS INSIDE A RUN ARE NOT STYLED TEXT ANY MORE, so these props
 * are not what recovers them. `resolveRunAttributes` puts `role: 'heading'`
 * (with its level) on the attribute entries that cross the wire, and both
 * hosts vend a real element per heading — a `UIAccessibilityElement` with the
 * `.header` trait on iOS, a virtual node through the ExploreByTouch helper on
 * Android — with link ranges vended the same way from `pressables`. List items
 * and table cells cross too (`role: 'listItem'` with its ordinal and count,
 * `role: 'tableCell'` with row and column), so Android announces them through
 * `CollectionItemInfo` and iOS vends one element per item or cell. What stays
 * flat inside a merged run is code-block and blockquote STRUCTURE.
 * `classifyBlock` is the way to give one of those its own element, at the cost
 * of ending the run around it.
 *
 * SETTING `accessible` OR `accessibilityRole` HERE MASKS THOSE ELEMENTS. Both
 * are the platform's "this subtree is ONE element" switch, so a document (or a
 * run) marked that way is read out as a single label and the per-heading and
 * per-link elements underneath it stop being reachable. Label the container by
 * all means; do not make it accessible as a leaf unless flattening the whole
 * document is what you want.
 *
 * `RunHost` takes the same props (`RunHostAccessibilityProps`) for a consumer
 * driving runs itself.
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
 * `render` is placed as an element, so it may use hooks: its output is its own
 * component instance (`EmbedOverlay`), mounted when the host reports where the
 * reservation landed and unmounted when the embed goes away. The component
 * TYPE is built per `render` function, so swapping in a different one for the
 * same span remounts the card instead of reusing its hooks — and an arrow
 * rebuilt on every claim remounts it on every reprojection. Keep it stable.
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
 * A live selection, in the terms the rest of this library speaks: an exact
 * range of the SOURCE, plus the text the user can see highlighted.
 *
 * `span` IS THE AUTHORITATIVE HALF, and it is the same mapping
 * `onSelectionCopy` performs — the run's display offsets walked back through
 * its piece table (`mapSelectionToSource`), construct extents included. So a
 * sweep over a whole heading reports the span of the heading *with* its `# `,
 * exactly as copying it would, and `source.slice(span.start, span.end)` is
 * the markdown for the selection. That slice is deliberately not carried
 * here: it is one line for a consumer who wants it, and re-slicing the
 * document on every frame of a handle drag for the consumers who do not is
 * not.
 *
 * `plain` is the visible text — `ProjectedRun.text.slice(...)` with each
 * embed placeholder replaced by that embed's declared `text` — i.e. byte for
 * byte the `plain` of the `onSelectionCopy` payload the same selection would
 * produce. It is what a floating toolbar shows.
 *
 * ONE RUN, ALWAYS. A selection never spans hosts, so this describes a range
 * inside exactly one run of the document.
 */
export interface SelectableMarkdownSelection {
  /** The selection mapped back to UTF-16 offsets in the original source. */
  span: SourceSpan;
  /** The projected display text the user has highlighted. */
  plain: string;
}

/**
 * What a `ref` on `<SelectableMarkdown>` gives you: the imperative half of
 * selection.
 *
 * WHY THESE THREE, AND WHY IMPERATIVE. Selection is state the user owns —
 * they drag it, and the platform moves it under a streamed text swap — so it
 * cannot be declared as a prop without the component fighting whoever touched
 * it last. Reading it is a `getSelection()` rather than a piece of React state
 * for the same reason the event exists: a toolbar wants to be told, and
 * everything else wants to ask at the moment it acts.
 *
 * WHAT IS NOT HERE: scrolling a span into view. The document does not own a
 * scroll view — a consumer wraps it in their own — and the honest primitive
 * for that is a measurement, which this library does not have a channel for
 * yet. `setSelection` moves the selection without scrolling to it.
 */
export interface SelectableMarkdownHandle {
  /**
   * The selection as of the last change reported by the native hosts, or
   * null when nothing is selected.
   *
   * It is a snapshot, not a subscription: it reflects the last
   * `onSelectionChange`, which is emitted for gestures, commands, one-active
   * -selection clears and text swaps alike. It returns null before any
   * selection has ever been made.
   */
  getSelection(): SelectableMarkdownSelection | null;
  /**
   * Drop the document's selection and dismiss the platform menu over it.
   *
   * With the default `exclusiveSelection` this clears the one run that holds
   * a selection — the component tracks which, because the hosts guarantee
   * there is at most one. With `exclusiveSelection={false}` there may be
   * several, so every mounted run is cleared.
   */
  clearSelection(): void;
  /**
   * Select a range of the SOURCE, mapping it through the projection of
   * whichever run shows it. Returns whether a run took it.
   *
   * FALSE IS A REAL ANSWER AND WORTH HANDLING, and it covers two kinds of
   * refusal. The span may not be showable: it is past the end of the
   * document, it is inside a block that rendered standalone, it covers only
   * markup that projects no characters (a fence, a `# `), or the run that
   * shows it has not mounted yet. Or the run that shows it cannot take a
   * selection right now: a run is not selectable while it is the UNSETTLED
   * STREAMING TAIL on Android (the tail policy — the text under a selection
   * must not be swapped there), a consumer may have rendered it
   * `selectable={false}`, and a binary built against a native spec older than
   * the selection commands has nothing to dispatch to. Every candidate run is
   * asked in document order and the answer is whether any of them took it —
   * so mid-stream on Android, `setSelection` over the live tail returns false
   * rather than reporting a selection nobody made. Nothing is cleared when it
   * returns false; the previous selection stands.
   *
   * TRUE IS NOT A PROMISE ABOUT THE RESULTING RANGE — it says a run accepted
   * the command, not what the run then selected. The answer is decided in JS,
   * from what JS knows (`RunHostHandle.setSelection` carries the same hedge);
   * the commands themselves return nothing, so nothing native ever answers
   * back. Each host clamps and orders the offsets against the text IT holds,
   * which a streamed delta may already have moved on from, and a range that
   * clamps to empty selects nothing — on iOS it also collapses that run's
   * selection to zero length, so `true` there can mean the selection was
   * cleared rather than set. Read `getSelection()` afterwards if the exact
   * resulting range matters.
   *
   * WHAT THE JS-SIDE ANSWER MODELS, AND WHAT IT CANNOT. It mirrors both hosts'
   * `isSelectable`/`isTextSelectable` refusal, which subsumes Android's second
   * guard: `setSelection` there also refuses text that is not a `Spannable`,
   * and `TextView` only holds a non-spannable buffer while
   * `setTextIsSelectable(false)` — the state the mirror has already refused
   * for. What it cannot model is a race: a `selectable` (or `unsettledTail`)
   * change that React has committed to JS but Fabric has not yet pushed to the
   * host leaves the mirror one frame ahead of the platform, so a call made in
   * that window can be accepted here and dropped there.
   *
   * THE RESULTING SELECTION CAN BE WIDER THAN THE SPAN, in the same places
   * copying is: a piece whose display text is not a character-for-character
   * copy of its source — a decoded entity, an image's alt text, an embed's
   * placeholder — is indivisible, so a span landing inside one selects all of
   * it. Round-tripping through `getSelection()` therefore widens once and
   * then settles.
   *
   * IT PRESENTS NO MENU AND ISSUES NO SCROLL, but it does take focus — the
   * iOS first responder, the Android view focus — because on both platforms a
   * text view that does not have it draws no selection at all. A scrolling
   * ancestor is entitled to react to a focus change, so on Android in
   * particular this can move a `ScrollView`. That is the platform's doing, not
   * a scroll-to-span: there is no such API here (see
   * `SelectableMarkdownHandle`).
   */
  setSelection(span: SourceSpan): boolean;
}

/**
 * One mounted run's contribution to the imperative API: what it shows, and
 * how to command it.
 *
 * A MUTABLE OBJECT PER RUNVIEW INSTANCE, updated at commit and registered
 * once, rather than a fresh entry per render. The registry is walked only by
 * imperative calls — never during render — so what it has to be is CURRENT at
 * the moment one arrives, which a stable object with refreshed fields is and
 * a snapshot captured in a dependency array is not.
 */
interface RunSelectionEntry extends RunSelectionCandidate {
  /** The run's source span, used to order candidates document-first when a
   * `setSelection` span could plausibly land in more than one. */
  span: SourceSpan;
  /** The run's projection, or null for a standalone run — which renders no
   * `RunHost` and therefore cannot hold a native selection at all. */
  projected: ProjectedRun | null;
  /** The run's host handle. Null between mount and the first commit, and
   * after unmount. */
  host: { current: RunHostHandle | null };
}

/**
 * Every mounted run, by React key.
 *
 * A PLAIN MAP IN A REF, NOT STATE. Nothing renders from it: it is read by the
 * three handle methods and written by mount/unmount effects, so putting it in
 * state would re-render the whole document once per run per commit to
 * redisplay nothing.
 */
type RunSelectionRegistry = Map<string, RunSelectionEntry>;

const EMPTY_DOCUMENT: ParsedDocument = { source: '', blocks: [] };

const NO_SUBSCRIPTION = (): void => {};

/** Whether two snapshots describe the same committed state; see
 * `useSessionSnapshot` for why a session can hand out two objects for one. */
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
 * The session's committed snapshot, subscribed the way React 18 asks an
 * external store to be subscribed.
 *
 * This used to be a `useReducer` counter bumped from a `useEffect`
 * subscription, with `session.snapshot()` read straight out of the render
 * body — mutable external state read during render, plus one guaranteed extra
 * render on mount from the bump that covered updates delivered between render
 * and subscription. `useSyncExternalStore` is the API for exactly this shape:
 * it subscribes, re-reads at the right moments, and is safe under concurrent
 * rendering, so the mount-time bump goes away with it.
 *
 * The cache is what makes the store a legal one. `StreamSession.snapshot()`
 * returns its committed snapshot object — stable, so the common path is an
 * identity hit — but before the first commit it BUILDS an empty snapshot per
 * call, and a `getSnapshot` that returns a fresh object every time makes
 * `useSyncExternalStore` re-render forever. Returning the held object whenever
 * the new one describes the same state settles that in the view, without the
 * session having to promise anything about allocation.
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
  /** The link allowlist in force, from the options the document was parsed
   * with — re-checked at press time on both paths; see `openUrl`. */
  linkPrefixes: readonly string[];
  /** Whether the run's host takes part in one-active-selection coordination;
   * see `SelectableMarkdownProps.exclusiveSelection`. */
  exclusiveSelection: boolean;
  /**
   * This run's React key, passed as a prop because a component cannot read
   * its own key — and the registry below has to be keyed by something that
   * identifies the INSTANCE. It is constant for the life of an instance (a
   * different key is a different element and therefore a remount), which is
   * why nothing here has to cope with it changing.
   */
  runKey: string;
  /** The document's live run registry, a stable object for the component's
   * whole life; this run adds and removes its own entry. */
  registry: RunSelectionRegistry;
  /**
   * Where a native selection change is reported, or undefined when nobody is
   * watching selection at all — which is also what stops the hosts emitting
   * it. Stable identity, like `onSelectionCopy` and `onLinkPress`.
   */
  onSelectionChange?: (
    selection: SelectableMarkdownSelection | null,
    runKey: string,
  ) => void;
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

  // The standalone half of the tail policy, carried to every renderer through
  // the context. Deliberately the same expression as `effectiveSelectable` in
  // `RunHost` (which is where the policy itself is explained), so a block gets
  // the same answer whether it flowed into a host or stands alone.
  //
  // `segmentRuns` computes `selectable` for standalone runs too — false while
  // the block's text is still being repaired — but the standalone branch below
  // renders through `renderBlocks`, which had no channel to hear about it, and
  // the block renderers hardcoded `selectable`. So the computed value was
  // dead: a paragraph whose image had already arrived sat selectable on
  // Android over text that changed on every delta, which is the one thing the
  // tail policy exists to prevent.
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
  // The memo alone is not enough, and this is where the streaming cost used to
  // live. A settled prose run GROWS: every settle merges one more block into
  // it, so `run` is a new segment with a longer span and one more block, the
  // memo misses, and the whole accumulated run was reprojected — O(document)
  // per settle, quadratic over a message. The cache below carries the previous
  // projection into `projectRun`, which extends it with the appended blocks
  // only; see `projectionCache.ts`. It is per-component-instance state, and
  // the instance survives the growth because `runKey` keeps a settled run's
  // key fixed at its start offset.
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

  // The imperative channel to this run's native host. `RunHost` forwards a
  // `RunHostHandle`, not the native view — see its class doc.
  const hostRef = useRef<RunHostHandle | null>(null);

  // This run's registry entry: one object for the life of the instance, with
  // its fields refreshed at commit. See `RunSelectionEntry` for why it is
  // mutable rather than rebuilt.
  const entryRef = useRef<RunSelectionEntry | null>(null);
  entryRef.current ??= { span: run.span, projected, host: hostRef };
  const registryEntry = entryRef.current;

  // Refreshed on EVERY commit, with no dependency array. The two fields track
  // props that change on most streamed ticks, and the alternative — listing
  // them as dependencies — would only save an assignment of two references
  // while adding a way for the entry to go stale. Deliberately an effect and
  // not a render-time write, for the same reason `useLatest` is one: a render
  // React throws away must not leave this pointing at a projection no
  // committed tree ever showed.
  useEffect(() => {
    registryEntry.span = run.span;
    registryEntry.projected = projected;
  });

  // Membership, which is genuinely mount/unmount-scoped. The unregister is
  // guarded on identity so that a remount whose effects interleave with the
  // old instance's cleanup cannot delete the new entry — React runs the
  // cleanup of the old tree before the effects of the new one, but the key is
  // the same string in both, and that is the one collision worth spending a
  // comparison on.
  useEffect(() => {
    registry.set(selfKey, registryEntry);
    return () => {
      if (registry.get(selfKey) === registryEntry) {
        registry.delete(selfKey);
      }
    };
  }, [registry, selfKey, registryEntry]);

  // An unmount is a selection ending, and nothing else reports it. The host
  // goes away with its selection and emits no final change, so a consumer's
  // toolbar would otherwise sit over a run that is no longer on screen. It is
  // reachable in ordinary streaming: a run's React key moves when a settle
  // resegments around it, and a moved key IS a remount of the native host
  // (see `runKey`) — the case that comment already calls out as destroying a
  // live selection.
  //
  // The handler is read through a ref rather than listed as a dependency, so
  // this cleanup runs at unmount and NOT when the handler appears or
  // disappears — which would report the selection gone while the run still
  // holds it. `selfKey` cannot change without a remount, so the two
  // dependencies are constants.
  //
  // The parent drops this for any run that is not the recorded owner, so a
  // document unmounting run by run reports at most one `null`.
  const latestSelectionReport = useLatest(onSelectionChange);
  useEffect(
    () => () => {
      latestSelectionReport.current?.(null, selfKey);
    },
    [latestSelectionReport, selfKey],
  );

  // Reported rects, keyed by each embed's SOURCE SPAN rather than by the
  // per-projection `embedId` or by the projection object's identity — see
  // `embedRectKey`, which is where the reasoning lives. Rects survive a
  // reprojection because the thing they are filed under does; the hosts only
  // ever re-report a rect that MOVED, so anything dropped here would stay
  // dropped for the rest of the stream.
  const [rects, setRects] =
    useState<ReadonlyMap<string, EmbedRect>>(NO_EMBED_RECTS);

  const onNativeEmbedLayout = useCallback(
    (event: EmbedLayoutEvent) => {
      const embeds = projected?.embeds;
      if (!embeds) {
        return;
      }
      // Bounds-checking, pruning and the no-op bail-out all live in
      // `applyEmbedRect`; returning the same map skips the re-render.
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
  // `linkPrefixes` goes with the href because "already refused" is a promise
  // only `nativeEngine` keeps: it applies the allowlist as it builds each
  // node, while `parseDocument` runs no policy pass over a substituted
  // engine's output. `openUrl` re-checks against the document's own resolved
  // prefixes, so a `javascript:` href from a custom parser is a no-op here
  // rather than an `openURL` — see `openUrl` in renderers.tsx.
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
        // The menu this run was mounted with, so a consumer-defined id
        // ('share-quote') reaches the handler as itself instead of being
        // read as version skew and normalized to 'copy-markdown'.
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

  // The live selection, mapped the same way a copy is.
  //
  // AN EMPTY RANGE IS A REAL REPORT and becomes `null` — "nothing is selected
  // in this run" — which is the half of this event `onSelectionAction` could
  // never deliver and the half a floating toolbar needs. So is a non-empty
  // range that maps to nothing: a selection covering only synthetic glyphs (a
  // list bullet, a block separator) has no source to report, and reporting
  // the previous span for it would be worse than reporting nothing.
  //
  // The mapping is `mapSelectionToSource`, not `handleSelectionAction`: the
  // two agree on `span` and `plain`, and the difference is the `markdown`
  // slice, which this path deliberately does not build. It fires on every
  // frame of a handle drag, and `doc.source.slice(span)` on a select-all is a
  // copy of the whole message per frame — for a field most consumers of this
  // event never read. `SelectableMarkdownSelection` says how to get it.
  const onNativeSelectionChange = useCallback(
    (event: SelectionChangeEvent) => {
      if (!onSelectionChange) {
        return;
      }
      if (!projected || event.start >= event.end) {
        onSelectionChange(null, selfKey);
        return;
      }
      const span = mapSelectionToSource(projected, event);
      if (!span) {
        onSelectionChange(null, selfKey);
        return;
      }
      onSelectionChange(
        {
          span,
          // The same helper `onSelectionCopy`'s `plain` is built with, so the
          // two events describe one selection identically — embed
          // placeholders substituted, synthetic glyphs kept.
          plain: selectionDisplayText(projected, event.start, event.end),
        },
        selfKey,
      );
    },
    [onSelectionChange, projected, selfKey],
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
      exclusiveSelection={exclusiveSelection}
      onEmbedLayout={runEmbeds?.length ? onNativeEmbedLayout : undefined}
      onInlinePress={pressables?.length ? onNativeInlinePress : undefined}
      onSelectionAction={onSelectionCopy ? onNativeSelectionAction : undefined}
      // Presence travels, exactly like the other two handlers: with nobody
      // watching selection, this run maps and slices nothing while a handle
      // is dragged (RunHost says what the gate does and does not save).
      onSelectionChange={onSelectionChange ? onNativeSelectionChange : undefined}
      pressables={pressables}
      ref={hostRef}
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
  // holding one `EmbedOverlay` per embed whose rect the host has reported.
  // The overlay is a SIBLING of the host, not a child: the native component
  // is a leaf on both architectures and cannot mount React children. The card
  // owns its own area — which also means a long-press ON the card starts no
  // selection, the documented trade for it being tappable.
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
          const key = embedRectKey(entry);
          const rect = rects.get(key);
          if (!rect) {
            return null;
          }
          const spec = entry.content as Partial<EmbedSpec>;
          if (typeof spec.render !== 'function') {
            return null;
          }
          // The element's TYPE is the wrapper built for this particular
          // `render` function, so a claim that starts returning a different
          // one for the same span remounts rather than handing the new
          // function the old one's hook list.
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
 * One embed's element, positioned over the space the host reserved for it.
 *
 * A COMPONENT, NOT A CALL, and that is the whole reason it exists. The
 * overlay used to be `{spec.render(entry.node, ctx)}` inline — a function call
 * inside `RunView`'s body, made only for embeds whose rect had already
 * arrived. Any hook a consumer wrote in `render` therefore joined RUNVIEW's
 * hook list, and rects arrive one `onEmbedLayout` at a time, so the hook count
 * changed between renders: "Rendered more hooks than during the previous
 * render", from a callback whose documented job is to draw a card. Here the
 * hooks belong to this component, which mounts when its rect arrives and
 * unmounts when its embed goes away, like any other element.
 *
 * ONE WRAPPER TYPE PER `render` FUNCTION, for the same reason `renderNode`
 * builds one per renderer (see `wrapperFor` in renderers.tsx). A single shared
 * overlay type made every embed look like the same component to React, so a
 * claim that returned a DIFFERENT `render` for the same source span — an
 * `embed` callback that switches on app state — reconciled in place at a
 * stable key and gave the new function the old function's hook list. A
 * per-function type makes that a remount. The consequence is the ordinary
 * React one: an `embed` callback that builds its `render` as a fresh arrow on
 * every call remounts the card every time the document is reprojected, so give
 * `render` a stable identity the way the `embed` prop's docstring asks.
 *
 * `pointerEvents="box-none"` keeps the positioning wrapper from swallowing
 * touches around the card; the card itself owns its own area.
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

/** The overlay component built for each embed `render`, kept weakly so a claim
 * that goes away takes its wrapper with it. */
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
  // Named for the React devtools tree, where a document is otherwise a wall of
  // identically-named overlays.
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
 * WHAT IT CANNOT SKIP, and what that costs now. A settled prose run GROWS: on
 * every settle `segmentRuns` merges one more block into it, so its span and
 * block list genuinely differ and this comparison genuinely fails — once per
 * settle, for the one run that absorbed the block. That is a real change, not
 * a missed memo, and the answer is to make the re-render cheap rather than to
 * pretend it away: `RunView` holds a projection cache that extends the
 * previous projection with the appended blocks (`projectionCache.ts`), and
 * `DEFAULT_MAX_RUN_CHARS` bounds how much text the native host beneath it can
 * be re-handed. Every OTHER run — every settled run the settle did not touch —
 * hits here and re-renders zero times, which is the part that is invariant.
 *
 * The two handler props are still compared by reference, but what they hold
 * is the component's own stable wrapper (see `useLatest`), so the comparison
 * fails only when a handler APPEARS or DISAPPEARS — which is a real change:
 * presence is what decides whether the menu items are offered and whether
 * link routing is taken over. `selectionActions` gets a value comparison
 * because an inline `['copy-text']` is the documented way to write it.
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
    // The registry object never changes identity, and the key cannot change
    // without a remount (a different key is a different element). Both are
    // compared anyway, because a memo that silently keeps a stale registration
    // would produce an imperative call against the wrong run — the failure
    // this whole surface exists to make impossible.
    prev.registry === next.registry &&
    prev.runKey === next.runKey
  );
}

const MemoRunView = memo(RunView, runPropsEqual);

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

/**
 * Which paired-prop warnings have already fired, so each is said once per JS
 * runtime rather than once per render of every message in a transcript. Same
 * warn-once discipline as the unknown-renderer warning in `renderers.tsx`.
 */
const warnedPairs = new Set<string>();

/**
 * The prop shapes that fail SILENTLY, named in DEV.
 *
 * The library's own rule is that a silent failure has to say its name — it is
 * why `RunHost` throws instead of rendering nothing when the native component
 * is missing ("a blank screen is the single hardest symptom to trace back to a
 * missing pod"). Every case below is that same shape: a perfectly
 * healthy-looking document that is missing the thing the consumer asked for.
 * They are listed in the order the function checks them.
 *
 * 1. `selectionActions` with no `onSelectionCopy` yields an EMPTY custom menu,
 *    not a one-item one — `RunHost` sends `NO_ACTIONS` when there is no
 *    listener, because a menu item that reports nowhere is worse than one that
 *    is not offered. The converse is not a failure and must never warn:
 *    `onSelectionCopy` alone is the common case, and the default list stands.
 *
 * 2. A consumer-defined `selectionActions` id with no `title` never appears
 *    on either menu, because neither host has a string for an id it does not
 *    know and an untitled item is dropped rather than rendered blank — the
 *    same silent shape as (1), one item down. The two built-in ids are
 *    exempt: a bare 'copy-text'/'copy-markdown' is the documented way to take
 *    the host's own localised title. This one is warned PER ID rather than
 *    once for the whole runtime, and lives in `selectionActions.ts` with the
 *    other per-id action warning — a transcript is many documents, and the
 *    second one's mistake is a different mistake.
 *
 * 3. `source` alongside a `session` is dropped: the session's document is what
 *    renders, and the string is never parsed. Nothing about the rendered
 *    output says which of the two is on screen, which is what makes it worth a
 *    line. An empty `source` is not warned about — passing `''` next to a
 *    session loses nothing.
 *
 * 4. `urlPolicy.blockedLinks: 'node'` with a `link` renderer override and no
 *    other channel. The pairing reads like the whole feature — keep the node
 *    so a renderer can claim it — and it is the one shape where the renderer
 *    never runs: prose flows into a native run, which has no renderers in it,
 *    so the blocked link is a `blockedLink` mark and the override draws
 *    nothing for the paragraphs a model actually emits. The warning names the
 *    three channels that do reach a run (`onLinkPress`, `embed`,
 *    `classifyBlock`), and stays quiet when any of them is already supplied.
 */
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
    // Warn-once PER ID rather than per runtime, which is why the latch is not
    // in `warnedPairs`: this list changes between documents, so a transcript
    // whose second message offers a different untitled id has a second thing
    // to say. `selectionActions.ts` owns the set and the wording, next to the
    // per-id cross-check on the way back.
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
 * A ref holding the latest `value`, updated at commit.
 *
 * IN AN EFFECT AND NOT DURING RENDER, deliberately: a render React throws away
 * — a concurrent one, or StrictMode's double invocation — must not leave the
 * ref pointing at props that no committed tree ever had. Everything that reads
 * one of these refs is an event handler, and an event cannot fire before the
 * commit that mounted the host it comes from, so commit time is always soon
 * enough.
 */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
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
    // What is left is exactly `SelectableMarkdownAccessibilityProps`, put on
    // the container view below. A rest element for the same reason `RunHost`
    // uses one: the set is a type, and a prop added to it should not need a
    // second edit here.
    ...accessibility
  } = props;

  warnAboutPairedProps(props);

  // The handler props reach the runs through wrappers whose identity
  // never changes, so an inline arrow — which is how the README writes
  // `onSelectionCopy`, and how anyone writes a two-line handler — no longer
  // costs a re-render of every run on every parent render.
  const latestSelectionCopy = useLatest(onSelectionCopy);
  const latestLinkPress = useLatest(onLinkPress);
  const latestSelectionChange = useLatest(onSelectionChange);
  const stableSelectionCopy = useCallback(
    (payload: SelectionCopyEvent) => latestSelectionCopy.current?.(payload),
    [latestSelectionCopy],
  );
  const stableLinkPress = useCallback(
    (press: InlineLinkPress) => latestLinkPress.current?.(press),
    [latestLinkPress],
  );
  // PRESENCE still has to travel, because both props are switches as well as
  // handlers: `onSelectionCopy` decides whether the custom menu items exist
  // at all, and `onLinkPress` decides whether the built-in link routing is
  // taken over. Passing the wrapper unconditionally would turn both on for
  // every consumer.
  const runSelectionCopy = onSelectionCopy ? stableSelectionCopy : undefined;
  const runLinkPress = onLinkPress ? stableLinkPress : undefined;

  // ---- Imperative selection ------------------------------------------------

  // Every mounted run, so an imperative call can reach the one it means. A
  // ref, not state: nothing renders from it. See `RunSelectionRegistry`.
  const registryRef = useRef<RunSelectionRegistry | null>(null);
  registryRef.current ??= new Map();
  const registry = registryRef.current;

  // The document's selection as of the last report, and WHICH run holds it.
  //
  // The key is what makes an empty report safe to act on. When a selection
  // lands in run B, B's host reports its own non-empty range first and then
  // clears run A, whose host reports empty — so an empty report from a run
  // that is not the recorded holder is stale by construction and must not
  // null out B's fresh selection. Both hosts emit self-first for exactly this
  // reason.
  const selectionRef = useRef<SelectableMarkdownSelection | null>(null);
  const selectionOwnerRef = useRef<string | null>(null);

  const stableSelectionChange = useCallback(
    (selection: SelectableMarkdownSelection | null, runKey: string) => {
      if (selection) {
        selectionRef.current = selection;
        selectionOwnerRef.current = runKey;
      } else {
        if (selectionOwnerRef.current !== runKey) {
          // A clear from a run that no longer holds the document's selection
          // — the other half of a hand-off, or a run that never had one.
          // Silent: reporting `null` here would say the document has no
          // selection one frame after it gained one.
          return;
        }
        selectionRef.current = null;
        selectionOwnerRef.current = null;
      }
      latestSelectionChange.current?.(selectionRef.current);
    },
    [latestSelectionChange],
  );

  // THE SWITCH IS A HANDLER *OR* A REF, and the ref half is what makes
  // `getSelection()`/`clearSelection()` work for a consumer who registered no
  // handler at all: both read state this component only has because the
  // native event feeds it. With neither, no run subscribes and the per-frame
  // mapping work never runs.
  const runSelectionChange =
    onSelectionChange !== undefined || (ref !== null && ref !== undefined)
      ? stableSelectionChange
      : undefined;

  // Rebuilt only when the exclusivity policy changes, because that is the one
  // thing `clearSelection` branches on. Everything else it needs is read from
  // a ref at call time, so a handle held across a whole stream stays live.
  useImperativeHandle(
    ref,
    () => ({
      getSelection: () => selectionRef.current,
      clearSelection() {
        if (exclusiveSelection) {
          // At most one run can hold a selection, and this is it. Clearing
          // only that one keeps the call O(1) in a transcript of hundreds of
          // mounted runs, where the alternative is a bridge message per run.
          const owner = selectionOwnerRef.current;
          if (owner === null) return;
          registry.get(owner)?.host.current?.clearSelection();
          return;
        }
        // Opted out of coordination: several runs may hold a selection at
        // once, and nothing tracks which, so every one of them is told.
        for (const entry of registry.values()) {
          entry.host.current?.clearSelection();
        }
      },
      setSelection(span: SourceSpan) {
        if (span === null || typeof span !== 'object') {
          return false;
        }
        // The walk itself lives in `selectionRange.ts` — which run shows the
        // span, which of those will take it, and in what order they are asked
        // — because that module has no React Native in it and can be tested.
        return selectSpanInRuns(registry.values(), span);
      },
    }),
    [registry, exclusiveSelection],
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

  // The parse options in force, which a session owns when there is one (it
  // parses with its own, and `options` is ignored — the same precedence the
  // `source`/`session` warning describes). `parseContext` allocates its
  // wrapper per call, so the memo keys on the options object inside it.
  const parseOptions = session ? session.parseContext.options : options;
  // The link allowlist, resolved once and threaded to both press paths. It is
  // read at NAVIGATION time, not at parse time, because the parse-time
  // guarantee belongs to `nativeEngine` alone: a substituted engine may treat
  // `urlPolicy` as the optional flag the `Engine` contract says it is, and
  // `parseDocument` does not re-filter what an engine returns. Memoized
  // because `resolveOptions` builds a fresh array, and this array is compared
  // by identity in `runPropsEqual`.
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
  // Whether a STREAM is what put this document on screen — true for the whole
  // life of a session-backed document, settled included. It is what decides
  // the tail run's key (`runKey`): a document that streamed keeps its tail
  // host across the moment the stream stops, and a document rendered from a
  // plain `source` string never has a tail at all.
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

  // The embed lookup the whole pipeline runs on: the consumer's claim, with
  // the built-in image claim behind it unless `images: 'standalone'` turns it
  // off (see `withImageEmbeds` for why images are embedded by default).
  //
  // Keyed on the two box TOKENS rather than on the theme object, deliberately.
  // The lookup takes part in the projection key — a claim changes the
  // projected text — and this component re-merges its theme whenever the
  // appearance flips, so keying on the theme would reproject every run on a
  // colour change, which is the one thing `attributes` is memoized separately
  // to avoid. The overlay reads the live theme through the render context, so
  // only the reserved box has to be in the key.
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
        // While the stream runs, the last block stays in the tail run even
        // when every block has settled — see `segmentRuns`' `liveTail`. A
        // chunk that ends on a completed blank line otherwise collapses the
        // document to one run for a frame, and the tail's host (with any
        // selection in it) is unmounted and remounted for nothing.
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
  // segmentRuns broke prose merging between them without a standalone block
  // in between, which happens for two reasons: the settled boundary, and the
  // run-size budget (`DEFAULT_MAX_RUN_CHARS`). Both are splits inside what
  // would otherwise be one run of blocks sitting one blank line apart, so the
  // blank-line height is the gap that draws them where they belong. Rendering
  // it at blockGap instead made every paragraph visibly drop by the difference
  // the instant the tail settled and the two runs merged into one.
  //
  // IT IS A LAYOUT NO-OP FOR PROSE, AND NOT QUITE FOR A BOX AT THE SPLIT. A
  // run whose first or last block draws a box — a code block, a table — needs
  // vertical padding at that edge that no block separator can absorb, so each
  // host measures itself taller by it (`runEdgeInsets` on iOS,
  // `RunDecorations.edgePaddingDp` on Android). Merging two runs turns that
  // edge into an interior one, and the padding it reserved goes away: a
  // settled run ENDING in a code block or table therefore loses
  // `code.paddingVertical` / `table.cellPaddingV` of height at the moment the
  // tail merges into it, and everything below shifts up by that much. Prose on
  // both sides of the split — the ordinary case — moves by nothing.
  const proseGap = Math.round(
    mergedTheme.fonts.baseSize * mergedTheme.fonts.lineHeight,
  );

  // Composed, not replaced: the theme's padding is the base and the consumer's
  // style wins over it, so `style={{ padding: 16 }}` is the whole answer while
  // `style={{ marginTop: 8 }}` leaves the token in place. The padding object
  // is memoized on the token it holds — this component re-renders on every
  // streamed tick, and it used to hand React a fresh style object each time —
  // and a consumer who passes no style still gets that one object rather than
  // a new array wrapping it.
  const containerPadding = useMemo(
    () => ({ padding: mergedTheme.spacing.containerPadding }),
    [mergedTheme.spacing.containerPadding],
  );
  const containerStyle: StyleProp<ViewStyle> =
    style === undefined ? containerPadding : [containerPadding, style];

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
        // Not `run:${run.span.start}` for the tail: its start moves on every
        // settle, and a moved key remounts the native host under a live
        // selection. See `runKey` — the flag it takes is whether a STREAM is
        // driving this document (true after it finishes, so the tail run is
        // not re-keyed at the end of the stream), not whether this run is
        // unsettled. It is passed as a PROP as well as the key because a
        // component cannot read its own key, and the selection registry has to
        // file each run under something that identifies the instance — the
        // same string, so an entry and its React element can never disagree
        // about which run they are.
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
 * The document component.
 *
 * IT FORWARDS A REF, and the ref is a `SelectableMarkdownHandle` — three
 * selection methods, not the container `View`. Passing one used to be a type
 * error, which meant an app could not clear a stale selection on navigation,
 * highlight a span it had computed, or read what the user had selected
 * without waiting for them to pick a menu item. See `SelectableMarkdownHandle`
 * for what each method promises, and `onSelectionChange` for the push half of
 * the same state.
 *
 * Attaching a ref also SUBSCRIBES TO THE SELECTION EVENT, because
 * `getSelection()` has nothing to report otherwise. With neither a ref nor an
 * `onSelectionChange` handler, no run does the per-frame mapping work while a
 * selection handle is dragged.
 */
export const SelectableMarkdown = forwardRef(SelectableMarkdownWithRef);
// Without this React DevTools and every error boundary say
// `ForwardRef(SelectableMarkdownWithRef)`, which names an implementation
// detail in a stack trace a consumer reads.
SelectableMarkdown.displayName = 'SelectableMarkdown';
