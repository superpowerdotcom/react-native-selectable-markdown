import type { AnyNode, ParsedDocument } from './nodes';

export type Visitor = (node: AnyNode, parent: AnyNode | null) => void | false;

const NO_CHILDREN: readonly AnyNode[] = [];

/** Direct children of a node in document order (empty for leaves). */
export function childrenOf(node: AnyNode): readonly AnyNode[] {
  switch (node.kind) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'listItem':
    case 'tableCell':
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'underline':
    case 'link':
    case 'spoiler':
      return node.children;
    case 'list':
      return node.items;
    case 'table':
      return [node.header, ...node.rows];
    case 'tableRow':
      return node.cells;
    default:
      return NO_CHILDREN;
  }
}

/**
 * Pre-order traversal. Returning `false` from the visitor skips the node's
 * children (the traversal continues with its siblings).
 */
export function visit(node: AnyNode | ParsedDocument, fn: Visitor): void {
  if ('kind' in node) {
    walk(node, null, fn);
    return;
  }
  for (const block of node.blocks) {
    walk(block, null, fn);
  }
}

function walk(node: AnyNode, parent: AnyNode | null, fn: Visitor): void {
  if (fn(node, parent) === false) {
    return;
  }
  for (const child of childrenOf(node)) {
    walk(child, node, fn);
  }
}

/**
 * The path of nodes (outermost block first, innermost node last) whose span
 * contains `offset`. Empty when the offset falls between blocks.
 */
export function findAt(doc: ParsedDocument, offset: number): AnyNode[] {
  const path: AnyNode[] = [];
  let level: readonly AnyNode[] = doc.blocks;
  for (;;) {
    const hit = level.find(
      (n) => n.span.start <= offset && offset < n.span.end,
    );
    if (!hit) {
      return path;
    }
    path.push(hit);
    level = childrenOf(hit);
  }
}
