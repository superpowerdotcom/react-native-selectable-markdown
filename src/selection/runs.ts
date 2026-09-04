import type { AnyNode, Block, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { childrenOf, visit } from '../document/visit';

export interface RunSegment {
  span: SourceSpan;
  blocks: Block[];
  selectable: boolean;
  /** A block that gets its own selection scope; see `classifyTopLevelBlock`. */
  standalone: boolean;
}

/**
 * How a top-level block participates in selection.
 *
 * - `flowing`: the block may merge with its neighbours into one run, so a
 *   single gesture selects across it.
 * - `standalone`: the block cannot live inside a run's text tree — it renders
 *   a view, or owns a gesture that would fight the selection gesture. It ends
 *   the run before it, and a new run begins after it.
 */
export type BlockClass = 'flowing' | 'standalone';

/**
 * Consumer-supplied classification. Return a class to claim the node, or
 * `undefined` to fall back to the built-in rules. This is how an app
 * registers its own standalone blocks — a paragraph that renders as a copy
 * button or a citation anchor, say — without changing the library.
 *
 * Called for inline nodes as well as blocks, because the construct that makes
 * a block standalone is often an inline one: a link whose href carries an
 * app-specific scheme is what turns its paragraph into a tap target. Claiming
 * such an inline makes the block containing it standalone.
 */
export type ClassifyBlock = (node: AnyNode) => BlockClass | undefined;

/**
 * What an embedded node contributes to the run: the layout space its overlay
 * needs, and the text it stands for when a selection that swept across it is
 * copied. The React element itself lives one layer up (`EmbedSpec` in the
 * view) — nothing below the view layer renders.
 */
export interface EmbedContent {
  /** Reserved size in points, declared up front — the reservation is
   * layout-affecting and measured off the UI thread, so there is no
   * measure-the-card-first feedback loop. Must be positive AND finite:
   * an infinity is a number that passes every `> 0` test and then saturates
   * whatever text system it reaches, so `embedContentFor` refuses it exactly
   * as it refuses a NaN or a zero. */
  width: number;
  height: number;
  /** What `plain` shows for this embed in a copy-text payload. Absent means
   * the embed contributes nothing to `plain` (its placeholder is removed);
   * `markdown` always carries the node's exact source either way. */
  text?: string;
}

/**
 * Where a node sits when an embed claim consults it. `topLevel` is true only
 * for a direct child of the document — the one position whose reservation
 * spans the full run width. A nested node (a code block inside a list item,
 * a table inside a blockquote, any inline) is offered with `topLevel: false`
 * so a consumer sizing an embed against the column width can decline it:
 * the native hosts do not clamp a declared width against the line's leading
 * margins, so a full-width claim inside an indented context overflows the
 * host to the right.
 */
export interface EmbedClaimContext {
  topLevel: boolean;
}

/** The two context values, frozen module constants: the lookup runs for
 * every node of every projection, and the flag has exactly two states. */
const TOP_LEVEL_CLAIM: EmbedClaimContext = Object.freeze({ topLevel: true });
const NESTED_CLAIM: EmbedClaimContext = Object.freeze({ topLevel: false });

/**
 * Consumer-supplied embed claim. Return content to claim the node as an
 * embed, or `undefined` to leave it alone. A claimed node FLOWS: its block
 * merges with its neighbours into one run, the projection stands the node
 * down to a single U+FFFC placeholder mapped to the node's whole source
 * span, and the view overlays the consumer's element on the space the host
 * reserves — so one gesture selects across it, and copying a sweep that
 * covers it yields the node's exact markdown.
 *
 * Consulted before `classifyBlock` claims and before the built-in view-kind
 * rules, for blocks and inlines alike — so an image or a blocked link can be
 * claimed without also being forced standalone. Like `classifyBlock`, it
 * must be pure, deterministic, and referentially stable: the whole document
 * is resegmented and reprojected whenever the callback's identity changes.
 * Purity includes the context argument: segmentation and projection may
 * consult the same node from different walks, and the claim must not depend
 * on anything but `(node, context)`.
 *
 * Nodes that cannot be embedded are left to normal projection regardless of
 * a claim: `synthetic` nodes (their text is not in the source, so there is
 * no span to map the placeholder to) and `incomplete` ones (a construct the
 * stream is still repairing — its span is still moving, and an overlay on
 * moving text is exactly the artifact this library exists to avoid).
 */
export type EmbedLookup = (
  node: AnyNode,
  context: EmbedClaimContext,
) => EmbedContent | undefined;

/**
 * The one gate for "may this node be embedded at all", returning the claimed
 * content when it may. Shared by segmentation and projection so the two
 * cannot disagree about a claim. Rejects synthetic and incomplete nodes (see
 * `EmbedLookup`) and every size that is not POSITIVE AND FINITE.
 *
 * THE FINITENESS HALF IS NOT PEDANTRY. `!(x > 0)` catches a NaN, which is why
 * the test was written that way, but `Infinity > 0` is true — so an infinite
 * width used to be claimed as a real embed and travel down: iOS builds a
 * `CGRectMake(0, descender, width, height)` attachment out of it and Android
 * runs it through `PixelUtil.toPixelFromDIP(...).toInt()`, which saturates to
 * `Int.MAX_VALUE` for a `ReplacementSpan`. `Number.isFinite` covers NaN and
 * both infinities in one test, so the explicit `<= 0` beside it is safe.
 *
 * This is the gate, not the only defence: the view layer re-checks with
 * `isReservableEmbedSize` (src/view/runEmbeds.ts) before anything crosses the
 * bridge, and both hosts check again. A consumer using the exported `RunHost`
 * directly never reaches this function at all.
 */
export function embedContentFor(
  node: AnyNode,
  embed?: EmbedLookup,
  topLevel = false,
): EmbedContent | undefined {
  if (embed === undefined || node.synthetic === true || node.incomplete === true) {
    return undefined;
  }
  const content = embed(node, topLevel ? TOP_LEVEL_CLAIM : NESTED_CLAIM);
  if (
    content === undefined ||
    !Number.isFinite(content.width) ||
    content.width <= 0 ||
    !Number.isFinite(content.height) ||
    content.height <= 0
  ) {
    return undefined;
  }
  return content;
}

function embeddable(node: AnyNode, embed?: EmbedLookup, topLevel = false): boolean {
  return embedContentFor(node, embed, topLevel) !== undefined;
}

/**
 * Block kinds that merge into a shared prose run — the eight below, which is
 * every kind the parsers put at the top level of a document. Everything else
 * (a kind nobody has classified, a `listItem` or a `tableRow` somehow hoisted
 * to the top) is standalone.
 *
 * An allowlist rather than a denylist, deliberately: a kind nobody has
 * classified gets its own selection scope, which is the safe failure. Merging
 * an unknown kind into a run is not.
 */
const PROSE_KINDS: ReadonlySet<Block['kind']> = new Set<Block['kind']>([
  'paragraph',
  'heading',
  'blockquote',
  'list',
  // THE FOUR BELOW USED TO BE STANDALONE, AND MOVING THEM IS THE POINT.
  //
  // They were excluded because the built-in renderer draws each as a VIEW — a
  // padded box, a grid, a rule — and a view cannot live inside a run's text
  // host. But that reasoning conflated "the renderer draws a view" with "this
  // content is not text", and only the first was ever true: `mapSelection`
  // already projects all four (`codeBlock` carries its literal under a
  // `codeBlock` mark, a table projects its header under `tableHeader` with rows
  // joined by '\n' and cells by '\t', `htmlBlock` its literal), and
  // `runAttributes` already styles the marks. The text was there the whole
  // time; nothing consumed it.
  //
  // What it cost: a run ended at every code block, table and rule, so a reader
  // could not sweep a selection across an answer that contained one — which, in
  // an LLM chat surface, is most answers. That is a worse outcome than losing a
  // box, and a consumer who wants the box back can still claim the block
  // `standalone` through `classifyBlock`; the hook simply runs in the other
  // direction now.
  //
  // The box came back without ending the run. The projection now carries
  // block marks ('codeBlock', 'table', 'tableHeader', a zero-length
  // 'thematicBreak'), `runDecorations.ts` turns them into draw instructions,
  // and the native host paints the code block's box, the table's border, row
  // rules and aligned columns, and the thematic break's rule around text
  // that still flows through one selection host. The chrome is decoration
  // over unchanged text, so nothing about offsets or selection moved.
  'codeBlock',
  'table',
  'thematicBreak',
  'htmlBlock',
]);

/**
 * Kinds whose built-in renderer emits a view rather than text. Used only when
 * walking *inside* a prose block, where the question is not "may this merge?"
 * but "does this subtree hold something that cannot be part of a text tree?" —
 * a property of the renderer, so it is a denylist and not the `PROSE_KINDS`
 * allowlist. An allowlist would be wrong here: `text`, `emphasis`, `listItem`
 * and friends are all perfectly at home inside a run, and treating every kind
 * outside `PROSE_KINDS` as standalone would make every paragraph standalone.
 *
 * This set must stay in step with `renderers.tsx`: a kind that renders a view
 * and is missing here ends up nested in the run's text host, which is exactly
 * what run segmentation exists to prevent.
 */
const VIEW_KINDS: ReadonlySet<AnyNode['kind']> = new Set<AnyNode['kind']>([
  // ONLY WHAT GENUINELY CANNOT BE TEXT REMAINS HERE. `codeBlock`, `table`,
  // `thematicBreak` and `htmlBlock` left this set when they joined
  // `PROSE_KINDS` above — they all project text and carry marks, so they can
  // flow. These two cannot, for two different reasons.
  //
  // An image projects nothing but its `alt` (mapSelection, the `image` case).
  // Flowing one does not degrade the picture, it DELETES it and leaves the alt
  // text in its place — so an image that is nothing but projected text has to
  // keep its own renderer, and the block holding it has to leave the run.
  //
  // THIS IS NOW THE FALLBACK, NOT THE USUAL PATH. The view claims image nodes
  // as EMBEDS by default (`images: 'embed'`, `src/view/imageEmbeds.ts`), and
  // an embed claim is consulted above — so an ordinary image flows, the
  // projection stands it down to one placeholder, and the picture is drawn
  // over the space the host reserves instead of being deleted. What still
  // reaches this line is what no claim covered: `images: 'standalone'`, a
  // theme whose image box is not a reservable size, a synthetic or
  // still-streaming image (`embedContentFor` refuses both), and a consumer
  // driving `segmentRuns` with no `embed` lookup at all. For those the old
  // rule is still the right one — the alternative is a paragraph that renders
  // its alt text where a picture should be.
  'image',
  // A spoiler is here for the *gesture* half of the rule above, not the view
  // half: `SpoilerSpan` is the only inline in the library that owns a tap
  // target, because hiding text nobody can reveal is not a spoiler. Inside a
  // run there is no tap target to own — the native host can paint the mask
  // (`runAttributes.ts`, the `spoiler` case) and nothing else, so the content
  // stays hidden with no way out. Standalone is the documented answer:
  // docs/SELECTION.md already states that a block owning a tap target should
  // not also be a selection host, which is the same trade `classifyBlock`'s
  // consumer hook exists for. The blast radius is nil — spoilers are off in
  // every preset but `everything`.
  'spoiler',
]);

/**
 * Whether `node`'s subtree holds anything that cannot live inside a run's
 * text tree.
 *
 * ON `visit`, NOT ON A DESCENT OF ITS OWN. The two answers this search gives
 * are exactly the two signals a visitor may return: `false` to prune a
 * subtree there is no point looking under, `'stop'` the moment the answer is
 * yes. Before `visit` could say the second, this walk was written out by hand
 * off `childrenOf` purely to get the short circuit.
 *
 * `visit` runs DEPTH-FIRST OFF AN EXPLICIT STACK, which is what this needs:
 * nesting depth is untrusted input — `'> '.repeat(2500)` is five kilobytes of
 * model output — and a recursive walk used to overflow the JS stack right
 * here, before any of it reached the screen. The visit order is the same one
 * this function always used — pre-order, children left to right, stopping at
 * the first standalone construct — so a `classifyBlock` callback sees exactly
 * the nodes, in the order, it always did.
 */
function containsStandalone(
  node: AnyNode,
  classify?: ClassifyBlock,
  embed?: EmbedLookup,
): boolean {
  let found = false;
  visit(node, (current) => {
    // An embed claim beats everything, including a `classifyBlock` claim on
    // the same node: the projection stands the whole subtree down to one
    // placeholder, so nothing inside it can render a view — there is no reason
    // to descend, and descending would let a nested image force standalone a
    // block whose image the consumer just said flows.
    if (embeddable(current, embed /* nested: this walk is always inside a block */)) {
      return false;
    }
    const claimed = classify?.(current);
    if (claimed !== undefined) {
      if (claimed === 'standalone') {
        found = true;
        return 'stop';
      }
      return false;
    }
    if (VIEW_KINDS.has(current.kind)) {
      found = true;
      return 'stop';
    }
    return undefined;
  });
  return found;
}

/**
 * Whether `node` emits projected characters OF ITS OWN, ignoring anything its
 * children emit. This is `mapSelection`'s `blockTasks` and `inlineTasks` read
 * as a table: which cases push an `emit` or a `literal` task, and with what.
 *
 * IT HAS TO KEEP MIRRORING THEM. A kind that starts projecting text and is
 * not added here is harmless — the run it sits in is non-empty either way, it
 * just may be demoted when it is alone. A kind that STOPS projecting text and
 * stays here is the real hazard: it goes back to drawing nothing. The
 * corpus-scale guard is the "every flowing run projects non-empty text" case
 * in conformance/selection/projection-oracle.test.ts.
 */
function emitsOwnText(node: AnyNode): boolean {
  switch (node.kind) {
    case 'text':
    case 'codeSpan':
    case 'math':
      return node.value.length > 0;
    case 'codeBlock':
    case 'htmlBlock':
    case 'htmlSpan':
      return node.literal.length > 0;
    case 'image':
      // An image projects its `alt` and nothing else, so an image with no alt
      // text projects nothing — hence a length test rather than a bare true.
      return node.alt.length > 0;
    case 'list':
      // Every item is prefixed with its marker glyph — bullet, ordinal or
      // task box — so a list holding an item is never blank, however empty
      // that item's own content is.
      return node.items.length > 0;
    case 'autolink':
      // The URL the author typed, falling back to `href`. Both empty is not a
      // shape any parser here produces.
      return true;
    case 'hardBreak':
    case 'softBreak':
      // '\n' and ' ' respectively; see the `softBreak` case in mapSelection.
      return true;
    default:
      // Containers emit only what their children emit (paragraph, heading,
      // blockquote, list items, table rows and cells, every inline wrapper),
      // and `thematicBreak` emits a zero-length mark and no text at all.
      return false;
  }
}

/**
 * Whether this block would project any text — the question `flushProse` asks
 * before letting a group of blocks merge into one flowing run.
 *
 * The separators the projector emits BETWEEN siblings do not count: a run
 * whose only characters are the '\n\n' between two thematic breaks is
 * exactly as blank as an empty one, and wants the same recovery.
 *
 * Short-circuits at the first character found, which in prose is two nodes
 * in — the block, then its first text node — so the common case costs
 * nothing. Only a genuinely blank subtree is walked to the end, and those are
 * small by definition.
 */
function projectsText(block: Block, embed?: EmbedLookup): boolean {
  let text = false;
  visit(block, (node) => {
    // `topLevel` is offered exactly as the projector offers it — true only
    // for the block itself, since `projectRun` starts each top-level block
    // with `topLevel: true` and every descendant with false — so this asks
    // about the same claim the projection will honour. A claimed node stands
    // down to one U+FFFC placeholder, and a placeholder is text.
    if (embeddable(node, embed, node === block) || emitsOwnText(node)) {
      text = true;
      return 'stop';
    }
    return undefined;
  });
  return text;
}

/**
 * One remembered classification: the answer, plus the two callbacks it was
 * computed with. Both are part of the key — the `classifyBlock` and `embed`
 * callbacks' contract is that they are pure and referentially stable, so a
 * change of identity is the only signal that the answer may have moved.
 */
interface CachedClass {
  classify: ClassifyBlock | undefined;
  embed: EmbedLookup | undefined;
  result: BlockClass;
}

/**
 * Classification results, keyed on BLOCK IDENTITY.
 *
 * WHY THIS IS THE ONE MEMO ON THE SEGMENTATION PATH. Classifying a prose block
 * walks its entire subtree (`containsStandalone`), and `segmentRuns` runs over
 * every top-level block of the document on every streamed snapshot — the memo
 * in the view keys on the snapshot's document object, which is new per delta.
 * So the walk was O(document nodes) per token: measured at 592 node visits and
 * ~65 µs per delta on a 19 kB document, quadratic over a stream, and comparable
 * to the whole parse+decode+append path it sits behind.
 *
 * Block identity is exactly the right key because `StreamSession` splices the
 * frozen prefix back in verbatim (see "Blocks keep referential identity" in
 * docs/STREAMING.md): every block but the tail one is the SAME OBJECT as on the
 * previous tick, and a block's subtree is immutable once parsed. So a hit is
 * sound, and the only misses are the blocks that genuinely changed.
 *
 * A `WeakMap` so a finished message's blocks are collected with the snapshot
 * that held them; nothing here needs eviction of its own.
 *
 * ONE ENTRY PER BLOCK, KEYED ON BOTH CALLBACKS, so two callers that segment
 * the SAME block objects with different callbacks each overwrite the other's
 * answer and both pay a full subtree walk every time. Nothing in the library
 * does that — `buildCopyPayload` segments a freshly reparsed slice, whose
 * blocks are new objects, and takes the same callbacks through `CopyContext`
 * anyway — but a second consumer of `segmentRuns` over the live document
 * should pass the same `classifyBlock`/`embed` the view has, or silently give
 * up the memo for both of them.
 */
const classCache = new WeakMap<Block, CachedClass>();

/**
 * Classifies one top-level block. An embed claim wins first (an embedded
 * block flows — that is the point of embedding); then a consumer claim wins
 * outright; otherwise a kind outside `PROSE_KINDS` is standalone, and a prose
 * kind is standalone when it carries a standalone construct ANYWHERE in its
 * subtree — one of the `VIEW_KINDS` (an image in a paragraph, a spoiler in a
 * table cell) or a node the consumer claimed. Such a block cannot merge
 * either: a run is one text tree, and the nested construct has to keep its
 * own renderer and gestures. Note the blast radius — it is the whole
 * containing block that leaves the run, not just the construct: one
 * unclaimed spoiler or image makes its entire list or table standalone.
 * Which is why the view claims images as embeds by default: an embedded
 * construct keeps its element AND its block's place in the run, so the blast
 * radius only applies to what nothing claimed.
 *
 * MEMOIZED ON BLOCK IDENTITY (see `classCache`), which is what makes repeated
 * segmentation of a streaming document cost O(new blocks) rather than
 * O(document nodes). The memo is only as sound as the callbacks' purity, which
 * is already their documented contract; a callback whose identity changes
 * invalidates every entry it wrote.
 */
export function classifyTopLevelBlock(
  block: Block,
  classify?: ClassifyBlock,
  embed?: EmbedLookup,
): BlockClass {
  const cached = classCache.get(block);
  if (
    cached !== undefined &&
    cached.classify === classify &&
    cached.embed === embed
  ) {
    return cached.result;
  }
  const result = computeBlockClass(block, classify, embed);
  classCache.set(block, { classify, embed, result });
  return result;
}

/** `classifyTopLevelBlock` with the memo taken off — the rules themselves. */
function computeBlockClass(
  block: Block,
  classify?: ClassifyBlock,
  embed?: EmbedLookup,
): BlockClass {
  // Top-level by contract — see the doc comment above; `segmentRuns` only
  // ever calls this for direct children of the document.
  if (embeddable(block, embed, true)) {
    return 'flowing';
  }
  const claimed = classify?.(block);
  if (claimed !== undefined) {
    return claimed;
  }
  if (!PROSE_KINDS.has(block.kind)) {
    return 'standalone';
  }
  return childrenOf(block).some((child) => containsStandalone(child, classify, embed))
    ? 'standalone'
    : 'flowing';
}

/**
 * How many SOURCE characters one flowing run may span before the next flowing
 * block starts a new one.
 *
 * WHY A CAP EXISTS AT ALL. A run is one native text host, and a host's cost is
 * paid per settle, not per delta: each time a block settles it joins the
 * settled run, and the host is handed longer text, which re-measures and
 * re-lays-out everything it already held (`RNSMRunHostShadowNode::measureContent`
 * resets its cached measurement on any new props). With no cap, a message is
 * one run, so a message of n characters costs O(n) native layout per settle and
 * O(n²) over the stream — the shape that turned a 28 kB document into 2.5 M
 * projected characters and one 25 kB re-measure on a late settle.
 *
 * WHY IT IS THIS LARGE. A cap is a selection boundary: a gesture cannot sweep
 * from one host into the next, which is the very thing merging `codeBlock`,
 * `table`, `thematicBreak` and `htmlBlock` into `PROSE_KINDS` bought back. So
 * the cap must sit far above the documents people actually sweep across. Eight
 * thousand characters is ~1300 words — several times the longest chat answer in
 * the shipped corpus — so an ordinary message is still exactly one run and
 * nothing about its selection changes; only documents already past the point
 * where a single host is the wrong shape get split.
 *
 * Pass `maxRunChars: Infinity` to opt out entirely (one run per flowing
 * sequence, whatever its length), or a smaller number to trade sweep distance
 * for smaller per-settle layouts.
 */
export const DEFAULT_MAX_RUN_CHARS = 8000;

/**
 * The cap in force: the caller's when it is a positive number (`Infinity`
 * included — that is the documented opt-out), the default otherwise. `> 0`
 * rather than `>= 0` so 0, a negative and a `NaN` all fall back rather than
 * producing one run per block.
 */
function runBudget(given: number | undefined): number {
  return typeof given === 'number' && given > 0 ? given : DEFAULT_MAX_RUN_CHARS;
}

/**
 * Segments the document into runs: maximal sequences of adjacent flowing
 * blocks — any of the eight `PROSE_KINDS`, so a code block and a table merge
 * into the prose around them like a paragraph does — into one selectable
 * unit; every standalone block is its own `standalone` run. See
 * `classifyTopLevelBlock` for what makes a block one or the other, and
 * `opts.classifyBlock` for claiming app-specific blocks. One exception to the
 * classification: a flowing sequence whose blocks ALL project no text — a
 * lone thematic break, an unfinished '```' fence, an empty blockquote —
 * demotes to standalone runs, see the note in `flushProse`, so every
 * non-standalone run this returns projects non-empty text.
 *
 * When `settledUntil` is given, a run never mixes settled and unsettled
 * blocks: prose merging breaks at the settled boundary, so blocks past
 * `settledUntil` form the tail run(s). Tail runs are emitted with
 * `selectable: false` as a conservative default — the view applies its own
 * per-platform policy (e.g. iOS may keep the tail selectable).
 *
 * Merging also breaks at `opts.maxRunChars` (see `DEFAULT_MAX_RUN_CHARS`), so
 * a very long document becomes several native hosts instead of one growing
 * one. The packing is GREEDY FROM THE START OF THE DOCUMENT and depends only on
 * blocks already placed, which is what keeps every boundary — and therefore
 * every `run:${span.start}` key and every cached projection — stable as the
 * document grows: a block that settles can only ever be added to the run it
 * would have joined anyway, or start the next one.
 *
 * `opts.liveTail` keeps the tail run in existence while the stream is still
 * running; see the option's own note.
 */
export function segmentRuns(
  doc: ParsedDocument,
  opts?: {
    settledUntil?: number;
    classifyBlock?: ClassifyBlock;
    embed?: EmbedLookup;
    maxRunChars?: number;
    /**
     * The document is still streaming, so its LAST block is where the next
     * characters will arrive: keep it in a run of its own even when
     * `settledUntil` covers the whole document.
     *
     * WHAT IT IS FOR. A stream settles at completed blank lines, so a chunk
     * that ends on one leaves `settledUntil === doc.source.length` for as long
     * as the next chunk takes to arrive — every block settled, nothing
     * unsettled, and the settled/tail break has nothing to break at. The
     * document therefore collapses to ONE run for a frame or two and splits
     * again when the next block starts. The view keys the tail run by its role
     * (`runKey`), so that collapse unmounts the tail's native host — on iOS
     * `prepareForRecycle` clears the attributed text, zeroes `selectedRange`
     * and resigns first responder — and a selection the reader had made in the
     * live tail dies, several times per message, at moments that look to them
     * like nothing happened at all.
     *
     * WHAT IT DOES. Only the boundary moves: the last block leaves the settled
     * run and becomes the tail run again, both halves still `selectable` (they
     * really are settled — this is not a claim about repair), and the split
     * lands exactly where the previous frame's settled boundary already was,
     * so no host is handed different text and none is destroyed. When the next
     * block does arrive the tail grows into it, which is the ordinary settle
     * path. It does nothing when the tail is genuinely unsettled (the break is
     * already there), when the last run is standalone, or when the last run
     * holds a single block.
     */
    liveTail?: boolean;
  },
): RunSegment[] {
  const settledUntil = opts?.settledUntil ?? Number.POSITIVE_INFINITY;
  const classify = opts?.classifyBlock;
  const embed = opts?.embed;
  const maxRunChars = runBudget(opts?.maxRunChars);
  const liveTail = opts?.liveTail === true;
  const runs: RunSegment[] = [];

  let pending: Block[] = [];
  let pendingSettled = true;

  const flushProse = (): void => {
    if (pending.length === 0) {
      return;
    }
    // A BLOCK THAT PROJECTS NO TEXT FLOWS ONLY IN COMPANY, because an empty
    // run cannot draw anything at all: both native hosts measure empty text
    // to a 0×0 box and skip decoration drawing when the length is zero, and
    // `resolveRunAttributes` returns nothing to draw with. Separators are
    // emitted only BETWEEN blocks, so a group whose blocks all project
    // nothing projects the empty string (or, for several of them, only the
    // blank lines between).
    //
    // This is not just the pathological `---`-only document. A thematic
    // break projects a zero-length mark and no characters; an empty fenced
    // block projects no mark at all; and the streaming prefixes '```',
    // '```py\n' and '> ' all project the empty string, so a message that
    // opens with a code fence or a quote would render a 0×0 host until its
    // first character of content arrived.
    //
    // Falling back to standalone hands each such block to its built-in
    // renderer (the pre-0.5.0 path), which draws the rule, the code box or
    // the quote bar the decoration would have. Nothing is lost
    // selection-wise: these blocks contribute no selectable text by
    // definition, and any of them with a text-projecting neighbour still
    // merges and keeps the sweep intact. An EMBEDDED block is exempt —
    // it projects a placeholder character, so its run is not empty, and
    // demoting it would hand it to `renderBlocks`, which ignores the embed
    // claim; `projectsText` is where that exemption lives.
    if (pending.every((block) => !projectsText(block, embed))) {
      for (const block of pending) {
        runs.push({
          span: { start: block.span.start, end: block.span.end },
          blocks: [block],
          selectable: pendingSettled,
          standalone: true,
        });
      }
      pending = [];
      return;
    }
    runs.push({
      span: {
        start: pending[0].span.start,
        end: pending[pending.length - 1].span.end,
      },
      blocks: pending,
      selectable: pendingSettled,
      standalone: false,
    });
    pending = [];
  };

  for (const block of doc.blocks) {
    const settled = block.span.end <= settledUntil;
    if (classifyTopLevelBlock(block, classify, embed) === 'flowing') {
      // Two reasons to end the run before this block, and the budget test is
      // deliberately written against SOURCE extent rather than projected
      // characters: it has to be answerable without projecting anything, and
      // it has to give the same answer for the same prefix every tick. Both
      // ends of the measurement are settled offsets, so they do not move.
      const overBudget =
        pending.length > 0 && block.span.end - pending[0].span.start > maxRunChars;
      if (pending.length > 0 && (pendingSettled !== settled || overBudget)) {
        flushProse();
      }
      pendingSettled = settled;
      pending.push(block);
    } else {
      flushProse();
      runs.push({
        span: { start: block.span.start, end: block.span.end },
        blocks: [block],
        selectable: settled,
        standalone: true,
      });
    }
  }
  // The live-tail split (see `opts.liveTail`), applied where the whole
  // document has settled into one trailing prose group: peel the last block
  // back off it so the tail run — and the host holding it — still exists.
  // `pendingSettled` is the test for "nothing is unsettled": an unsettled tail
  // has already broken the group at the boundary, and this would then be
  // splitting the tail itself.
  if (liveTail && pendingSettled && pending.length > 1) {
    const last = pending[pending.length - 1];
    pending = pending.slice(0, -1);
    flushProse();
    pending = [last];
  }
  flushProse();

  return runs;
}
