import type { Block } from '../document/nodes';

/**
 * Drops render-time-only trailing empties left behind by mid-stream input:
 * a lone empty heading, an empty trailing list item (recursing into nested
 * lists), a blockquote emptied by its own trimming, an empty trailing
 * fenced code block, and a trailing partial table row.
 *
 * Identity-preserving: returns the same array when nothing needed trimming,
 * and untouched blocks keep their references when something did.
 */
export function trimTrailingPlaceholders(blocks: Block[]): Block[] {
  let end = blocks.length;
  let replacement: Block | null = null;
  while (end > 0) {
    const last = blocks[end - 1];
    const trimmed = trimBlock(last);
    if (trimmed === last) {
      break;
    }
    if (trimmed === null) {
      end--;
      continue;
    }
    replacement = trimmed;
    break;
  }
  if (end === blocks.length && replacement === null) {
    return blocks;
  }
  const out = blocks.slice(0, end);
  if (replacement !== null) {
    out[out.length - 1] = replacement;
  }
  return out;
}

/**
 * Trims one trailing block: returns the block itself when untouched, null
 * when it should be dropped entirely, or a replacement with trailing
 * emptiness removed.
 */
function trimBlock(block: Block): Block | null {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return block.children.length === 0 ? null : block;
    case 'codeBlock':
      return block.fenced && block.literal === '' ? null : block;
    case 'blockquote': {
      const trimmed = trimTrailingPlaceholders(block.children);
      if (trimmed === block.children) {
        return block.children.length === 0 ? null : block;
      }
      if (trimmed.length === 0) {
        return null;
      }
      return { ...block, children: trimmed };
    }
    case 'list': {
      const items = block.items;
      if (items.length === 0) {
        return null;
      }
      const last = items[items.length - 1];
      const trimmed = trimTrailingPlaceholders(last.children);
      if (trimmed === last.children) {
        if (last.children.length > 0) {
          return block;
        }
        return items.length === 1
          ? null
          : { ...block, items: items.slice(0, -1) };
      }
      if (trimmed.length === 0) {
        return items.length === 1
          ? null
          : { ...block, items: items.slice(0, -1) };
      }
      return {
        ...block,
        items: [...items.slice(0, -1), { ...last, children: trimmed }],
      };
    }
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
