import type { AnyNode } from '../document/nodes';

/**
 * Child containers, in the order a clone writes them back. Detected
 * structurally rather than by an exhaustive kind switch, so a node kind added
 * later is shifted correctly as long as it stores its children under one of
 * the established keys.
 */
const CHILD_ARRAYS = ['children', 'items', 'rows', 'cells'] as const;

/**
 * One pending clone: `node` is the source, and the clone is written back into
 * `into[key]` — an index in a freshly allocated child array, or the `header`
 * property of a parent clone. Carrying the destination on the job is what
 * lets the walk below be a loop instead of a recursion: a recursive clone
 * returns its result up the stack, an iterative one has to be told where to
 * put it.
 */
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
 * ITERATIVE, NOT RECURSIVE, and that is load-bearing rather than a style
 * choice. Model output is untrusted, and nesting depth in markdown is
 * unbounded: 6 kB of `'> '` is a 3000-deep blockquote, which this function
 * used to walk with 3000 nested calls — a `RangeError: Maximum call stack
 * size exceeded` thrown from inside `StreamSession.update`, i.e. from a
 * streamed append, on a device stack smaller than V8's. The explicit job
 * stack below is bounded only by the heap, so depth costs memory instead of
 * crashing the session. The other walks on the same document (the run
 * projector, `containsStandalone`, `walk`) are explicit stacks for the same
 * reason; the view bounds its own nesting with a render cap
 * (`MAX_RENDER_DEPTH` in `src/view/renderers.tsx`), because React elements
 * cost more than a stack frame.
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
  // A one-slot holder so the root's clone has a destination like every other
  // node's, which keeps the loop body free of a "is this the root?" branch.
  const root: Record<string, unknown> = {};
  const stack: CloneJob[] = [{ node, into: root, key: 'value' }];
  while (stack.length > 0) {
    // Order is irrelevant — every job writes into its own slot and reads
    // nothing another job wrote — so pop the cheap end.
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
        // Allocated at full length and filled by the child jobs: the spread
        // above copied the SOURCE array onto the clone, and leaving it there
        // for even one iteration would let a caller reading mid-walk (there
        // is none today) see unshifted children hanging off a shifted node.
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
