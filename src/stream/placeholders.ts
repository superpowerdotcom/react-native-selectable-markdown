import type {
  Block,
  BlockquoteNode,
  ListItemNode,
  ListNode,
} from '../document/nodes';

/**
 * How a finished child list folds back into the container it was trimmed
 * for. A blockquote hands its `children` down; a list hands down the
 * children of its LAST item — the only one a trailing placeholder can be in.
 */
type PendingParent =
  | { kind: 'blockquote'; block: BlockquoteNode }
  | { kind: 'list'; block: ListNode; item: ListItemNode };

/**
 * One block list being trimmed from its end: `end` is the exclusive index of
 * the survivors so far, `replacement` the rebuilt last block when one was
 * rebuilt rather than dropped, `done` marks the tail loop as finished, and
 * `parent` says which container is waiting for this list (`null` at the top).
 */
interface Frame {
  blocks: Block[];
  end: number;
  replacement: Block | null;
  done: boolean;
  parent: PendingParent | null;
}

/**
 * Drops render-time-only trailing empties left behind by mid-stream input:
 * a lone empty heading, an empty trailing list item (descending into nested
 * lists), a blockquote emptied by its own trimming, an empty trailing
 * fenced code block, and a trailing partial table row.
 *
 * Identity-preserving: returns the same array when nothing needed trimming,
 * and untouched blocks keep their references when something did.
 *
 * ITERATIVE, for the reason `shiftSpans` is: this runs on every streamed
 * append, over a tree whose nesting depth is whatever the model emitted.
 * The blockquote and list cases used to recurse into
 * `trimTrailingPlaceholders` mutually, a pair of frames per level, so 6 kB
 * of `'> '` threw `RangeError: Maximum call stack size exceeded` from inside
 * `StreamSession.update` — a streamed append, not a pathological one-shot
 * parse. The frame stack below walks the same path (down the right spine of
 * the tail, then back up rebuilding) bounded by the heap instead.
 */
export function trimTrailingPlaceholders(blocks: Block[]): Block[] {
  const stack: Frame[] = [
    {
      blocks,
      end: blocks.length,
      replacement: null,
      done: blocks.length === 0,
      parent: null,
    },
  ];
  for (;;) {
    const frame = stack[stack.length - 1];
    if (!frame.done) {
      // One step of this list's tail loop: look at the last survivor and
      // either finish, drop it, or replace it. A container descends instead,
      // and its answer arrives through `fold` below.
      const last = frame.blocks[frame.end - 1];
      if (last.kind === 'blockquote') {
        stack.push(childFrame(last.children, { kind: 'blockquote', block: last }));
        continue;
      }
      if (last.kind === 'list' && last.items.length > 0) {
        const item = last.items[last.items.length - 1];
        stack.push(childFrame(item.children, { kind: 'list', block: last, item }));
        continue;
      }
      // An empty list is a placeholder in its own right; every other kind is
      // judged without descending.
      const trimmed = last.kind === 'list' ? null : trimLeaf(last);
      step(frame, last, trimmed);
      continue;
    }

    // Finished: materialize this list with the same identity-preserving
    // contract the recursive version had.
    const result = finish(frame);
    stack.pop();
    if (frame.parent === null) {
      return result;
    }
    // The container the list belonged to, rebuilt around it. That value is
    // exactly what the recursive `trimBlock` used to return to the parent's
    // tail loop, so it is fed to that loop the same way.
    const parent = stack[stack.length - 1];
    step(parent, frame.parent.block, fold(frame.parent, result));
  }
}

function childFrame(blocks: Block[], parent: PendingParent): Frame {
  return {
    blocks,
    end: blocks.length,
    replacement: null,
    done: blocks.length === 0,
    parent,
  };
}

/**
 * Applies one `trimBlock`-shaped answer for `frame`'s current last block:
 * the block itself ends the tail loop, `null` drops it and moves on to the
 * one before, and anything else is the rebuilt replacement (which also ends
 * the loop — a rebuilt block is by construction non-empty).
 */
function step(frame: Frame, last: Block, trimmed: Block | null): void {
  if (trimmed === last) {
    frame.done = true;
    return;
  }
  if (trimmed === null) {
    frame.end -= 1;
    frame.done = frame.end === 0;
    return;
  }
  frame.replacement = trimmed;
  frame.done = true;
}

/**
 * The surviving prefix of a finished frame with its rebuilt last block
 * spliced in — the ORIGINAL array when nothing changed, which is the
 * identity signal the session's snapshot path reads.
 */
function finish(frame: Frame): Block[] {
  if (frame.end === frame.blocks.length && frame.replacement === null) {
    return frame.blocks;
  }
  const out = frame.blocks.slice(0, frame.end);
  if (frame.replacement !== null) {
    out[out.length - 1] = frame.replacement;
  }
  return out;
}

/**
 * A container plus its trimmed child list: the container itself when nothing
 * changed, null when the trimming emptied it, or a rebuilt container.
 */
function fold(parent: PendingParent, result: Block[]): Block | null {
  if (parent.kind === 'blockquote') {
    const block = parent.block;
    if (result === block.children) {
      return block.children.length === 0 ? null : block;
    }
    if (result.length === 0) {
      return null;
    }
    return { ...block, children: result };
  }
  const { block, item } = parent;
  const items = block.items;
  if (result === item.children) {
    if (item.children.length > 0) {
      return block;
    }
    return items.length === 1 ? null : { ...block, items: items.slice(0, -1) };
  }
  if (result.length === 0) {
    return items.length === 1 ? null : { ...block, items: items.slice(0, -1) };
  }
  return {
    ...block,
    items: [...items.slice(0, -1), { ...item, children: result }],
  };
}

/**
 * Trims one trailing block that cannot hold another block: the block itself
 * when untouched, null when it should be dropped entirely, or a replacement
 * with trailing emptiness removed. Blockquotes and lists are the frame
 * stack's business instead — they are where the depth lives.
 */
function trimLeaf(block: Block): Block | null {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return block.children.length === 0 ? null : block;
    case 'codeBlock':
      return block.fenced && block.literal === '' ? null : block;
    case 'table': {
      const headerCells = block.header.cells.length;
      let rows = block.rows;
      while (rows.length > 0) {
        const last = rows[rows.length - 1];
        const partial =
          last.cells.length < headerCells ||
          last.cells.every((cell) => cell.children.length === 0);
        if (!partial) {
          break;
        }
        rows = rows.slice(0, -1);
      }
      return rows === block.rows ? block : { ...block, rows };
    }
    default:
      return block;
  }
}
