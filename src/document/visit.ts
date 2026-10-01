import type { AnyNode, ParsedDocument } from './nodes';

/** `false` skips this node's children; `'stop'` ends the whole traversal. */
export type VisitSignal = void | false | 'stop';

export type Visitor = (node: AnyNode, parent: AnyNode | null) => VisitSignal;

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
 * children (the traversal continues with its siblings); returning `'stop'`
 * ends the traversal.
 */
export function visit(node: AnyNode | ParsedDocument, fn: Visitor): void {
  walk('kind' in node ? [node] : node.blocks, fn);
}

/**
 * Iterative because nesting depth is untrusted input and recursion overflows
 * the JS stack; parallel stacks, not frames, so no allocation per node.
 */
function walk(roots: readonly AnyNode[], fn: Visitor): void {
  const nodes: AnyNode[] = [];
  const parents: (AnyNode | null)[] = [];
  pushChildren(nodes, parents, roots, null);
  for (;;) {
    const node = nodes.pop();
    if (node === undefined) {
      return;
    }
    const parent = parents.pop() ?? null;
    const signal = fn(node, parent);
    if (signal === 'stop') {
      return;
    }
    if (signal === false) {
      continue;
    }
    pushChildren(nodes, parents, childrenOf(node), node);
  }
}

/** Reversed, so the stack pops the children in document order. */
function pushChildren(
  nodes: AnyNode[],
  parents: (AnyNode | null)[],
  children: readonly AnyNode[],
  parent: AnyNode | null,
): void {
  for (let i = children.length - 1; i >= 0; i -= 1) {
    nodes.push(children[i]);
    parents.push(parent);
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
