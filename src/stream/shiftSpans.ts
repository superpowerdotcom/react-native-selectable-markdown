import type { AnyNode } from '../document/nodes';

const CHILD_ARRAYS = ['children', 'items', 'rows', 'cells'] as const;

interface CloneJob {
  node: AnyNode;
  into: Record<string | number, unknown>;
  key: string | number;
}

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
 * Iterative on purpose: nesting is unbounded (6 kB of `> ` is 3000 levels)
 * and recursion overflows a device stack.
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
  const root: Record<string, unknown> = {};
  const stack: CloneJob[] = [{ node, into: root, key: 'value' }];
  while (stack.length > 0) {
    const job = stack.pop() as CloneJob;
    const source = job.node as unknown as Record<string, unknown>;
    const span = job.node.span;
    const clone: Record<string, unknown> = { ...source };
    clone.span =
      span.start < 0
        ? span
        : { start: span.start + delta, end: span.end + delta };
    job.into[job.key] = clone;
    for (const key of CHILD_ARRAYS) {
      const children = source[key];
      if (Array.isArray(children)) {
        const shifted: unknown[] = new Array(children.length);
        clone[key] = shifted;
        for (let i = 0; i < children.length; i += 1) {
          stack.push({
            node: children[i] as AnyNode,
            into: shifted as unknown as Record<string | number, unknown>,
            key: i,
          });
        }
      }
    }
    if (source.header !== undefined) {
      stack.push({
        node: source.header as AnyNode,
        into: clone as Record<string | number, unknown>,
        key: 'header',
      });
    }
  }
  return root.value as T;
}
