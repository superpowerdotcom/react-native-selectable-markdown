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
 * - an escaped or entity-written pipe is never a marker;
 * - table cells are deliberately excluded: `|` is structural syntax there
 *   (an unescaped `||` splits cells before this transform runs).
 *
 * Value and source offsets diverge under escapes, entities and smart
 * punctuation, so the `|` runs of each are paired positionally and trusted
 * only when their counts and lengths match.
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
 * `into[intoIndex]` receives this container's rebuilt node once its children
 * are done.
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

/** A table is deliberately not descended into. */
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

function transformLeaf(block: Block, source: string): Block {
  return block.kind === 'paragraph' || block.kind === 'heading'
    ? transformInlineContainer(block, source)
    : block;
}

/**
 * Iterative because nesting depth is untrusted input. Returns `block` itself
 * when nothing under it changed, so `applySpoilers` can return the original.
 */
function transformBlock(block: Block, source: string): Block {
  const key = childArrayKey(block);
  if (key === null) return transformLeaf(block, source);

  // A one-slot destination for the root, so the fold needs no root branch.
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
  valueOffset: number;
  rawOffset: number;
}

interface MarkerEvent extends Marker {
  role: 'open' | 'close';
}

interface PipeRun {
  offset: number;
  length: number;
}

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

/** `null` when the node's pipes cannot be paired with its source's. */
function markersIn(node: TextNode, index: number, source: string): Marker[] | null {
  const valueRuns = pipeRuns(node.value);
  if (valueRuns.length === 0) return [];
  const raw = source.slice(node.span.start, node.span.end);
  const rawRuns = pipeRuns(raw);
  if (rawRuns.length !== valueRuns.length) return null;
  const out: Marker[] = [];
  for (let i = 0; i < rawRuns.length; i += 1) {
    if (rawRuns[i].length !== valueRuns[i].length) return null;
    // `\||` is an escaped pipe beside a real one: lengths match, yet it is no
    // marker.
    let slashes = 0;
    for (let j = rawRuns[i].offset - 1; j >= 0 && raw[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 !== 0) return null;
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
