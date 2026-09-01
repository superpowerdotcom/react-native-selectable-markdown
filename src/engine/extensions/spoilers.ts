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
 * - text nodes whose decoded value diverges from their raw source
 *   (entities, escapes) are skipped, so offsets always map exactly;
 * - table cells are deliberately excluded: `|` is structural syntax there
 *   (an unescaped `||` splits cells before this transform ever runs, and an
 *   escaped `\|\|` breaks the 1:1 raw-source mapping rule above), so a cell
 *   can never carry a well-formed marker.
 */
export function applySpoilers(doc: ParsedDocument): ParsedDocument {
  let changed = false;
  const blocks = doc.blocks.map((b) => {
    const nb = transformBlock(b);
    if (nb !== b) changed = true;
    return nb;
  });
  return changed ? { source: doc.source, blocks } : doc;
}

function transformBlock(block: Block): Block {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return transformInlineContainer(block);
    case 'blockquote': {
      const children = block.children.map(transformBlock);
      return children.some((c, i) => c !== block.children[i])
        ? { ...block, children }
        : block;
    }
    case 'list': {
      const items = block.items.map((item) => {
        const children = item.children.map(transformBlock);
        return children.some((c, i) => c !== item.children[i])
          ? { ...item, children }
          : item;
      });
      return items.some((it, i) => it !== block.items[i]) ? { ...block, items } : block;
    }
    case 'listItem': {
      const children = block.children.map(transformBlock);
      return children.some((c, i) => c !== block.children[i])
        ? { ...block, children }
        : block;
    }
    default:
      return block;
  }
}

interface MarkerEvent {
  /** Index of the text node in the paragraph's children. */
  node: number;
  /** Offset of the `||` run inside that node's value (== raw offset). */
  offset: number;
  role: 'open' | 'close';
}

function transformInlineContainer(para: ParagraphNode | HeadingNode): Block {
  const markers: { node: number; offset: number }[] = [];
  para.children.forEach((child, ci) => {
    if (child.kind !== 'text') return;
    // Only text runs whose value maps 1:1 onto the raw source are scanned,
    // so every marker offset is also an exact source offset.
    if (child.value.length !== child.span.end - child.span.start) return;
    const value = child.value;
    let p = 0;
    while (p < value.length) {
      if (value[p] !== '|') {
        p += 1;
        continue;
      }
      let run = 1;
      while (value[p + run] === '|') run += 1;
      if (run === 2) markers.push({ node: ci, offset: p });
      p += run;
    }
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
    for (const ev of nodeEvents) {
      if (ev.offset > cursor) push(sliceText(child, cursor, ev.offset));
      if (ev.role === 'open') {
        spoilerChildren = [];
        spoilerSrcStart = child.span.start + ev.offset;
      } else {
        const children = spoilerChildren ?? [];
        spoilerChildren = null;
        out.push({
          kind: 'spoiler',
          children,
          span: { start: spoilerSrcStart, end: child.span.start + ev.offset + 2 },
        });
      }
      cursor = ev.offset + 2;
    }
    if (cursor < child.value.length) push(sliceText(child, cursor, child.value.length));
  });

  return { ...para, children: out };
}

function sliceText(node: TextNode, from: number, to: number): TextNode {
  return {
    kind: 'text',
    value: node.value.slice(from, to),
    span: { start: node.span.start + from, end: node.span.start + to },
  };
}
