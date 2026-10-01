import type {
  Block,
  BlockquoteNode,
  ListItemNode,
  ListNode,
} from '../document/nodes';

type PendingParent =
  | { kind: 'blockquote'; block: BlockquoteNode }
  | { kind: 'list'; block: ListNode; item: ListItemNode };

/** `end` is the exclusive end of the surviving prefix of `blocks`. */
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
 * Iterative for the reason `shiftSpans` is: model-controlled nesting depth.
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
      // Only an empty list reaches here, and it is itself a placeholder.
      const trimmed = last.kind === 'list' ? null : trimLeaf(last);
      step(frame, last, trimmed);
      continue;
    }

    const result = finish(frame);
    stack.pop();
    if (frame.parent === null) {
      return result;
    }
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

/** A rebuilt replacement ends the tail loop: it is non-empty by construction. */
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
 * Returns the original array when nothing changed: the session's snapshot
 * path reads that identity.
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
