import type {
  Block,
  HeadingNode,
  Inline,
  ParsedDocument,
  ParagraphNode,
  TextNode,
} from '../../document/nodes';

/**
 * Opt-in post-parse transform: replaces balanced `||…||` pairs within a
 * single inline container (paragraph or heading, including those nested in
 * blockquotes and list items) with `spoiler` nodes (exact spans, inner
 * inlines reused). Called by `parseDocument` ONLY when `extensions.spoilers`
 * is true.
 *
 * Safety rules — a stray pipe in prose must never change rendering:
 * - a marker is a run of EXACTLY two `|` characters inside a top-level
 *   text node of the container; single `|` and runs of 3+ are never markers;
 * - markers pair up sequentially; an unpaired trailing `||` stays literal;
 * - an escaped or entity-written pipe is never a marker (see below);
 * - table cells are deliberately excluded: `|` is structural syntax there
 *   (an unescaped `||` splits cells before this transform ever runs), so a
 *   cell can never carry a well-formed marker, and `transformBlock` never
 *   descends into a table to look.
 *
 * WHY EVERY MARKER IS FOUND TWICE. A text node carries a `value` (what the
 * reader sees) and a `span` (the source it came from), and the two diverge in
 * a closed list of ways: a backslash escape loses its backslash, `&amp;`
 * becomes `&`, a NUL becomes U+FFFD, and `smartPunctuation` rewrites quotes,
 * `...` and dash runs. Splitting the node needs offsets into the *value*;
 * placing the resulting spans needs offsets into the *source*. Those are
 * different numbers as soon as anything in the paragraph diverges.
 *
 * The rule this used to enforce instead was "skip any node whose value is not
 * the same length as its slice", which sounds per-node and is not: the
 * decoder merges adjacent text events into one run, so an entity or an
 * ellipsis *anywhere* in a paragraph usually produced a single text node
 * covering the whole paragraph and disabled every spoiler in it. `everything`
 * is the only preset that ships spoilers and it also enables
 * `smartPunctuation`, so `||secret|| and so on ...` rendered the secret in
 * the clear.
 *
 * So the two offsets are recovered instead of demanded: the `|` runs of the
 * raw slice and of the value are listed and paired positionally, and the pair
 * is trusted only when the two lists have the same number of runs of the same
 * lengths. That is exactly the condition under which no divergence touched a
 * pipe — an escaped `\|\|` is two runs of one in the source against one run
 * of two in the value, and `&#124;&#124;` is no runs in the source against
 * one in the value, so both mismatch and the node is skipped, which is the
 * "escaped pipes are not markers" rule falling out rather than being
 * special-cased. A divergence that leaves the pipes alone (`&amp;`, `\*`, a
 * smart ellipsis) keeps the lists aligned and the spoiler survives with exact
 * spans on both sides.
 */
export function applySpoilers(doc: ParsedDocument): ParsedDocument {
  let changed = false;
  const blocks = doc.blocks.map((b) => {
    const nb = transformBlock(b, doc.source);
    if (nb !== b) changed = true;
    return nb;
  });
  return changed ? { source: doc.source, blocks } : doc;
}

/**
 * One container being rebuilt: `block` is the source node, `children` is the
 * child array being walked (`items` for a list, `children` for a blockquote
 * or a list item), and `out` collects each child's answer at its own index.
 * `into[intoIndex]` is where this frame's own answer goes once the walk
 * folds back up — carrying the destination on the frame is what lets the
 * walk be a loop instead of a recursion.
 */
interface Frame {
  block: Block;
  key: 'children' | 'items';
  children: readonly Block[];
  out: Block[];
  next: number;
  changed: boolean;
  into: Block[];
  intoIndex: number;
}

/** Containers this transform descends into; a table is deliberately not one. */
function childArrayKey(block: Block): 'children' | 'items' | null {
  if (block.kind === 'blockquote' || block.kind === 'listItem') return 'children';
  if (block.kind === 'list') return 'items';
  return null;
}

function frameFor(
  block: Block,
  key: 'children' | 'items',
  into: Block[],
  intoIndex: number,
): Frame {
  const children: readonly Block[] =
    key === 'items' ? (block as { items: Block[] }).items : (block as { children: Block[] }).children;
  return {
    block,
    key,
    children,
    out: new Array<Block>(children.length),
    next: 0,
    changed: false,
    into,
    intoIndex,
  };
}

/** A paragraph or heading transformed; every other leaf kind passes through. */
function transformLeaf(block: Block, source: string): Block {
  return block.kind === 'paragraph' || block.kind === 'heading'
    ? transformInlineContainer(block, source)
    : block;
}

/**
 * Rewrites one top-level block and everything under it, returning the same
 * object when nothing inside it changed (which is what lets `applySpoilers`
 * hand back the original document unchanged).
 *
 * ITERATIVE, NOT RECURSIVE, and that is load-bearing rather than a style
 * choice. This runs inside `parseDocument` for every parse with
 * `extensions.spoilers` on — `presets.everything` — over untrusted model
 * output whose nesting depth is unbounded. The blockquote/list/listItem arms
 * used to recurse, one frame per level, so 5 kB of `'> '` threw
 * `RangeError: Maximum call stack size exceeded` out of `parseDocument` and
 * out of `StreamSession.append`. The explicit frame stack below is bounded by
 * the heap instead, matching the other deep walks in this package
 * (`shiftSpans`, `trimTrailingPlaceholders`, the run projector).
 */
function transformBlock(block: Block, source: string): Block {
  const key = childArrayKey(block);
  if (key === null) return transformLeaf(block, source);

  // A one-slot holder so the root has a destination like every other node,
  // which keeps the fold below free of an "is this the root?" branch.
  const root: Block[] = [block];
  const stack: Frame[] = [frameFor(block, key, root, 0)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.children.length) {
      const index = frame.next;
      frame.next += 1;
      const child = frame.children[index];
      const childKey = childArrayKey(child);
      if (childKey !== null) {
        stack.push(frameFor(child, childKey, frame.out, index));
        continue;
      }
      const transformed = transformLeaf(child, source);
      frame.out[index] = transformed;
      if (transformed !== child) frame.changed = true;
      continue;
    }
    // Every child is in: materialize this container with the same
    // identity-preserving contract the recursive version had, hand it to the
    // parent's slot, and let the parent inherit "something changed" from the
    // fact that a new object came back.
    const result = frame.changed ? { ...frame.block, [frame.key]: frame.out } as Block : frame.block;
    stack.pop();
    frame.into[frame.intoIndex] = result;
    if (stack.length > 0 && result !== frame.block) {
      stack[stack.length - 1].changed = true;
    }
  }
  return root[0];
}

interface Marker {
  /** Index of the text node in the container's children. */
  node: number;
  /** Offset of the `||` run inside that node's `value`. */
  valueOffset: number;
  /** Offset of the same run inside that node's source slice. */
  rawOffset: number;
}

interface MarkerEvent extends Marker {
  role: 'open' | 'close';
}

interface PipeRun {
  offset: number;
  length: number;
}

/** Every run of `|` in `s`, in order. */
function pipeRuns(s: string): PipeRun[] {
  const runs: PipeRun[] = [];
  let p = s.indexOf('|');
  while (p !== -1) {
    let length = 1;
    while (s[p + length] === '|') length += 1;
    runs.push({ offset: p, length });
    p = s.indexOf('|', p + length);
  }
  return runs;
}

/**
 * The `||` markers in one text node, with both offsets, or `null` when the
 * node's pipes cannot be matched to its source (see the module comment).
 */
function markersIn(node: TextNode, index: number, source: string): Marker[] | null {
  const valueRuns = pipeRuns(node.value);
  if (valueRuns.length === 0) return [];
  const raw = source.slice(node.span.start, node.span.end);
  const rawRuns = pipeRuns(raw);
  if (rawRuns.length !== valueRuns.length) return null;
  const out: Marker[] = [];
  for (let i = 0; i < rawRuns.length; i += 1) {
    if (rawRuns[i].length !== valueRuns[i].length) return null;
    // A run the source escapes is not the run the value shows, even when the
    // lengths happen to line up: `\||` is one escaped pipe beside one real
    // one, and reading it as a marker would put the spoiler's span one
    // character inside the construct the author wrote.
    if (rawRuns[i].offset > 0 && raw[rawRuns[i].offset - 1] === '\\') return null;
    if (rawRuns[i].length === 2) {
      out.push({ node: index, valueOffset: valueRuns[i].offset, rawOffset: rawRuns[i].offset });
    }
  }
  return out;
}

function transformInlineContainer(
  para: ParagraphNode | HeadingNode,
  source: string,
): Block {
  const markers: Marker[] = [];
  para.children.forEach((child, ci) => {
    if (child.kind !== 'text') return;
    const found = markersIn(child, ci, source);
    if (found !== null) markers.push(...found);
  });

  const pairCount = Math.floor(markers.length / 2);
  if (pairCount === 0) return para;

  const events: MarkerEvent[] = [];
  for (let m = 0; m < pairCount * 2; m += 1) {
    events.push({ ...markers[m], role: m % 2 === 0 ? 'open' : 'close' });
  }

  const out: Inline[] = [];
  let spoilerChildren: Inline[] | null = null;
  let spoilerSrcStart = 0;
  const push = (n: Inline): void => {
    (spoilerChildren ?? out).push(n);
  };

  para.children.forEach((child, ci) => {
    const nodeEvents = events.filter((e) => e.node === ci);
    if (child.kind !== 'text' || nodeEvents.length === 0) {
      push(child);
      return;
    }
    let cursor = 0;
    let rawCursor = 0;
    for (const ev of nodeEvents) {
      if (ev.valueOffset > cursor) {
        push(sliceText(child, cursor, ev.valueOffset, rawCursor, ev.rawOffset));
      }
      if (ev.role === 'open') {
        spoilerChildren = [];
        spoilerSrcStart = child.span.start + ev.rawOffset;
      } else {
        const children = spoilerChildren ?? [];
        spoilerChildren = null;
        out.push({
          kind: 'spoiler',
          children,
          span: { start: spoilerSrcStart, end: child.span.start + ev.rawOffset + 2 },
        });
      }
      cursor = ev.valueOffset + 2;
      rawCursor = ev.rawOffset + 2;
    }
    if (cursor < child.value.length) {
      push(sliceText(child, cursor, child.value.length, rawCursor, child.span.end - child.span.start));
    }
  });

  return { ...para, children: out };
}

/**
 * A slice of a text node, cut at a value range and a source range that were
 * established together. The two ranges have the same length only when nothing
 * in the node diverges; passing both is what lets a spoiler survive next to an
 * entity or a smart-punctuation rewrite.
 */
function sliceText(
  node: TextNode,
  from: number,
  to: number,
  rawFrom: number,
  rawTo: number,
): TextNode {
  return {
    kind: 'text',
    value: node.value.slice(from, to),
    span: { start: node.span.start + rawFrom, end: node.span.start + rawTo },
  };
}
