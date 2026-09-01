import type { AnyNode, Block, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { childrenOf } from '../document/visit';

export interface RunSegment {
  span: SourceSpan;
  blocks: Block[];
  selectable: boolean;
  /** A block that gets its own selection scope; see `classifyBlock`. */
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
 * Block kinds that merge into a shared prose run. Everything else
 * (code blocks, tables, thematic breaks, html blocks) is standalone.
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
  // text in its place — so a paragraph with an inline image, or a table cell
  // holding one, still has to keep its own renderer.
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

function containsStandalone(node: AnyNode, classify?: ClassifyBlock): boolean {
  const claimed = classify?.(node);
  if (claimed !== undefined) {
    return claimed === 'standalone';
  }
  if (VIEW_KINDS.has(node.kind)) {
    return true;
  }
  return childrenOf(node).some((child) => containsStandalone(child, classify));
}

/**
 * Classifies one top-level block. A consumer claim wins outright; otherwise a
 * non-prose kind is standalone, and a prose kind is standalone when it
 * carries a standalone construct inside — a code block nested in a list item,
 * an image in a paragraph. Such a block cannot merge either: a run is one
 * text tree, and the nested construct has to keep its own renderer and
 * gestures.
 */
export function classifyBlock(block: Block, classify?: ClassifyBlock): BlockClass {
  const claimed = classify?.(block);
  if (claimed !== undefined) {
    return claimed;
  }
  if (!PROSE_KINDS.has(block.kind)) {
    return 'standalone';
  }
  return childrenOf(block).some((child) => containsStandalone(child, classify))
    ? 'standalone'
    : 'flowing';
}

/**
 * Segments the document into runs: maximal sequences of adjacent flowing
 * blocks (paragraph, heading, blockquote, list) merged into one selectable
 * unit; every standalone block is its own `standalone` run. See
 * `classifyBlock` for what makes a block one or the other, and
 * `opts.classifyBlock` for claiming app-specific blocks. One exception to the
 * classification: a flowing sequence of nothing but thematic breaks demotes
 * to standalone runs — see the note in `flushProse` — so every non-standalone
 * run this returns projects non-empty text.
 *
 * When `settledUntil` is given, a run never mixes settled and unsettled
 * blocks: prose merging breaks at the settled boundary, so blocks past
 * `settledUntil` form the tail run(s). Tail runs are emitted with
 * `selectable: false` as a conservative default — the view applies its own
 * per-platform policy (e.g. iOS may keep the tail selectable).
 */
export function segmentRuns(
  doc: ParsedDocument,
  opts?: { settledUntil?: number; classifyBlock?: ClassifyBlock },
): RunSegment[] {
  const settledUntil = opts?.settledUntil ?? Number.POSITIVE_INFINITY;
  const classify = opts?.classifyBlock;
  const runs: RunSegment[] = [];

  let pending: Block[] = [];
  let pendingSettled = true;

  const flushProse = (): void => {
    if (pending.length === 0) {
      return;
    }
    // A thematic break flows only in company. It projects no text — a
    // zero-length mark, with separators emitted only BETWEEN blocks — so a
    // run of nothing but thematic breaks projects the empty string, and an
    // empty run cannot draw its rule: both native hosts measure empty text
    // to a 0×0 box and skip decoration drawing when the text length is
    // zero. Falling back to standalone hands each lone rule to the built-in
    // `thematicBreak` renderer (the pre-0.5.0 path), which draws the same
    // 1px border-colored hairline the decoration would have. Nothing is
    // lost selection-wise: a rule contributes no selectable text, and any
    // HR with a flowing neighbour still merges and keeps the sweep intact.
    if (pending.every((block) => block.kind === 'thematicBreak')) {
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
    if (classifyBlock(block, classify) === 'flowing') {
      if (pending.length > 0 && pendingSettled !== settled) {
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
  flushProse();

  return runs;
}
