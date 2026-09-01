import type { AnyNode } from '../document/nodes';

/**
 * Deep-clones a node with every span (its own and all descendants') shifted
 * by `delta`. Used by the incremental splice: the engine parses only the
 * unsettled tail slice, so every span it emits is tail-relative and must be
 * rebased to absolute document offsets.
 *
 * Pure: the input node (typically engine output) is never mutated — the
 * session later sets streaming flags on the clones, and the view's memo
 * comparator relies on "changed content = new object" identity semantics.
 *
 * Child containers are detected structurally (`children`, `items`, `rows`,
 * `cells`, `header`) rather than by an exhaustive kind switch, so a node
 * kind added later is shifted correctly as long as it stores its children
 * under one of the established container keys.
 *
 * An UNANCHORED span (`start < 0`, the engines' "this node has no source
 * offsets") is copied through untouched rather than rebased. Adding an
 * anchor's delta to -1 produces an offset that is positive, in bounds, and
 * wrong — it silently becomes a real-looking location that selection and
 * copy will happily map back into the document. Leaving it negative keeps a
 * decoder bug looking like a decoder bug: the span-invariant sweeps fail on
 * it instead of the splice laundering it into something plausible.
 */
export function shiftSpans<T extends AnyNode>(node: T, delta: number): T {
  const source = node as unknown as Record<string, unknown>;
  const clone: Record<string, unknown> = { ...source };
  clone.span =
    node.span.start < 0
      ? node.span
      : { start: node.span.start + delta, end: node.span.end + delta };
  if (Array.isArray(source.children)) {
    clone.children = (source.children as AnyNode[]).map((c) =>
      shiftSpans(c, delta),
    );
  }
  if (Array.isArray(source.items)) {
    clone.items = (source.items as AnyNode[]).map((c) => shiftSpans(c, delta));
  }
  if (Array.isArray(source.rows)) {
    clone.rows = (source.rows as AnyNode[]).map((c) => shiftSpans(c, delta));
  }
  if (Array.isArray(source.cells)) {
    clone.cells = (source.cells as AnyNode[]).map((c) => shiftSpans(c, delta));
  }
  if (source.header !== undefined) {
    clone.header = shiftSpans(source.header as AnyNode, delta);
  }
  return clone as unknown as T;
}
