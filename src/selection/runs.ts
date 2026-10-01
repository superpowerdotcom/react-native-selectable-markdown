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
   * measure-the-card-first feedback loop. Must be positive and finite, or the
   * claim is ignored. */
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
  /** Descendant of a list, table, or blockquote with reduced line width. */
  withinContainer?: boolean;
  /** The only inline in a paragraph directly under the document. */
  soleChildOfTopLevelParagraph?: boolean;
}

/** The two context values, frozen module constants: the lookup runs for
 * every node of every projection, and the flag has exactly two states. */
const TOP_LEVEL_CLAIM: EmbedClaimContext = Object.freeze({ topLevel: true });
const NESTED_CLAIM: EmbedClaimContext = Object.freeze({ topLevel: false });
const SOLE_PARAGRAPH_CHILD_CLAIM: EmbedClaimContext = Object.freeze({
  topLevel: false,
  soleChildOfTopLevelParagraph: true,
});
const CONTAINER_CLAIM: EmbedClaimContext = Object.freeze({
  topLevel: false,
  withinContainer: true,
});

export function constrainsEmbedWidth(block: Block): boolean {
  return block.kind === 'list' || block.kind === 'table' || block.kind === 'blockquote';
}

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
 * `EmbedLookup`) and every size that is not positive and finite. `!(x > 0)`
 * alone would admit Infinity, which saturates native layout on both hosts.
 */
export function embedContentFor(
  node: AnyNode,
  embed?: EmbedLookup,
  topLevel = false,
  withinContainer = false,
  soleChildOfTopLevelParagraph = false,
): EmbedContent | undefined {
  if (embed === undefined || node.synthetic === true || node.incomplete === true) {
    return undefined;
  }
  const context = topLevel ? TOP_LEVEL_CLAIM : withinContainer ? CONTAINER_CLAIM
    : soleChildOfTopLevelParagraph ? SOLE_PARAGRAPH_CHILD_CLAIM : NESTED_CLAIM;
  const content = embed(node, context);
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

function embeddable(node: AnyNode, embed?: EmbedLookup, topLevel = false, withinContainer = false, soleChildOfTopLevelParagraph = false): boolean {
  return embedContentFor(node, embed, topLevel, withinContainer, soleChildOfTopLevelParagraph) !== undefined;
}

/**
 * Block kinds that merge into a shared prose run. Everything else is
 * standalone.
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
  // text in its place — so an unclaimed image keeps its own renderer and its
  // block leaves the run. Images claimed as embeds (the view's default,
  // `src/view/imageEmbeds.ts`) are pruned before this set is consulted.
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

function containsStandalone(
  node: AnyNode,
  classify?: ClassifyBlock,
  embed?: EmbedLookup,
  withinContainer = false,
  soleChildOfTopLevelParagraph = false,
): boolean {
  let found = false;
  visit(node, (current) => {
    // An embed claim outranks `classifyBlock` and prunes: the subtree projects as one placeholder.
    if (embeddable(current, embed, false, withinContainer, current === node && soleChildOfTopLevelParagraph)) {
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
 * Must mirror the `emit` and `literal` tasks in mapSelection's `blockTasks`
 * and `inlineTasks`; conformance/selection/projection-oracle.test.ts guards it.
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
      return node.alt.length > 0;
    case 'list':
      // Every item is prefixed with a marker glyph, however empty its content.
      return node.items.length > 0;
    case 'autolink':
      // The typed URL or `href`; no parser produces both empty.
      return true;
    case 'hardBreak':
    case 'softBreak':
      // '\n' and ' ' respectively; see the `softBreak` case in mapSelection.
      return true;
    default:
      // `thematicBreak` emits a zero-length mark and no text.
      return false;
  }
}

function projectsText(block: Block, embed?: EmbedLookup): boolean {
  let text = false;
  const soleChild = block.kind === 'paragraph' && block.children.length === 1 ? block.children[0] : null;
  visit(block, (node) => {
    // The claim context `projectRun` will offer, so a claim here is a U+FFFC placeholder there.
    if (embeddable(node, embed, node === block, constrainsEmbedWidth(block), node === soleChild) || emitsOwnText(node)) {
      text = true;
      return 'stop';
    }
    return undefined;
  });
  return text;
}

const DEFAULT_CLASS_KEY = {};
const classCache = new WeakMap<Block, WeakMap<object, WeakMap<object, BlockClass>>>();

/**
 * Classifies one top-level block. An embed claim wins first (an embedded
 * block flows — that is the point of embedding); then a consumer claim wins
 * outright; otherwise a kind outside `PROSE_KINDS` is standalone, and so is
 * a prose block whose subtree holds a `VIEW_KINDS` node or a node claimed
 * standalone. Such a block cannot merge
 * either: a run is one text tree, and the nested construct has to keep its
 * own renderer and gestures. The whole block leaves the run, not just the
 * construct.
 *
 * Memoized on block identity and both callbacks' identities, so the
 * callbacks must be pure.
 */
export function classifyTopLevelBlock(
  block: Block,
  classify?: ClassifyBlock,
  embed?: EmbedLookup,
): BlockClass {
  const classifyKey = classify ?? DEFAULT_CLASS_KEY;
  const embedKey = embed ?? DEFAULT_CLASS_KEY;
  let byClassify = classCache.get(block);
  if (byClassify === undefined) {
    byClassify = new WeakMap();
    classCache.set(block, byClassify);
  }
  let byEmbed = byClassify.get(classifyKey);
  if (byEmbed === undefined) {
    byEmbed = new WeakMap();
    byClassify.set(classifyKey, byEmbed);
  }
  const cached = byEmbed.get(embedKey);
  if (cached !== undefined) return cached;
  const result = computeBlockClass(block, classify, embed);
  byEmbed.set(embedKey, result);
  return result;
}

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
  const soleChild = block.kind === 'paragraph' && block.children.length === 1;
  return childrenOf(block).some((child) => containsStandalone(child, classify, embed, constrainsEmbedWidth(block), soleChild))
    ? 'standalone'
    : 'flowing';
}

/**
 * How many SOURCE characters one flowing run may span before the next flowing
 * block starts a new one. Each run is one native host that re-lays-out its
 * whole text on every settle, and a run boundary is one a selection cannot
 * cross. `maxRunChars: Infinity` opts out.
 */
export const DEFAULT_MAX_RUN_CHARS = 8000;

function runBudget(given: number | undefined): number {
  return typeof given === 'number' && given > 0 ? given : DEFAULT_MAX_RUN_CHARS;
}

/**
 * Segments the document into runs: maximal sequences of adjacent flowing
 * blocks merged into one selectable
 * unit; every standalone block is its own `standalone` run. See
 * `classifyTopLevelBlock` for what makes a block one or the other, and
 * `opts.classifyBlock` for claiming app-specific blocks. One exception to the
 * classification: a flowing sequence whose blocks all project no text (a lone
 * thematic break, an unfinished '```' fence) demotes to standalone runs, so
 * every non-standalone run this returns projects non-empty text.
 *
 * When `settledUntil` is given, a run never mixes settled and unsettled
 * blocks: prose merging breaks at the settled boundary, so blocks past
 * `settledUntil` form the tail run(s). Tail runs are emitted with
 * `selectable: false` as a conservative default — the view applies its own
 * per-platform policy (e.g. iOS may keep the tail selectable).
 *
 * Merging also breaks at `opts.maxRunChars` (see `DEFAULT_MAX_RUN_CHARS`), so
 * a very long document becomes several native hosts. The packing is greedy
 * from the start of the document, so every boundary and `run:${span.start}`
 * key stays stable as the document grows.
 */
export function segmentRuns(
  doc: ParsedDocument,
  opts?: {
    settledUntil?: number;
    classifyBlock?: ClassifyBlock;
    embed?: EmbedLookup;
    maxRunChars?: number;
    /**
     * The document is still streaming: keep its last block in a run of its
     * own even when `settledUntil` covers the whole document, so the tail
     * run's host is not unmounted (and its selection lost) between chunks.
     * No-op when the tail is unsettled or standalone, or the last run holds
     * a single block.
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
    // An all-blank group would be an empty run, which both hosts draw as a
    // 0×0 box; each block falls back to its built-in renderer instead.
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
      // Measured in source extent over settled offsets only (an unsettled
      // block's start), so the split is the same for the same prefix every tick.
      const overBudget =
        pending.length > 0 &&
        (settled ? block.span.end : block.span.start) - pending[0].span.start > maxRunChars;
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
  // See `opts.liveTail`; an unsettled tail has already split the group.
  if (liveTail && pendingSettled && pending.length > 1) {
    const last = pending[pending.length - 1];
    pending = pending.slice(0, -1);
    flushProse();
    pending = [last];
  }
  flushProse();

  return runs;
}
