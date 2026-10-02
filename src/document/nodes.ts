import type { SourceSpan } from './span';

/**
 * Shared shape of every AST node. The invariant every engine must uphold:
 * `source.slice(span.start, span.end)` is exactly the construct's source.
 */
export interface NodeBase {
  readonly kind: string;
  readonly span: SourceSpan;
  /**
   * Present only during streaming: the node's tail construct was virtually
   * repaired before parsing, so its source text is not yet finished.
   */
  incomplete?: true;
  /**
   * Present only during streaming: content that does not exist in the source
   * (e.g. the padding cell of a ragged streamed table row). Set only on nodes
   * whose span starts at or past the end of the real text; a repaired closer is
   * absorbed into its node's span, which is flagged `incomplete` instead.
   */
  synthetic?: true;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type TableAlignment = 'left' | 'center' | 'right' | null;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface ParagraphNode extends NodeBase {
  kind: 'paragraph';
  children: Inline[];
}

export interface HeadingNode extends NodeBase {
  kind: 'heading';
  level: HeadingLevel;
  children: Inline[];
}

export interface CodeBlockNode extends NodeBase {
  kind: 'codeBlock';
  language?: string;
  literal: string;
  fenced: boolean;
  /** False while a fenced block's closing fence has not been seen. */
  closed: boolean;
}

export interface BlockquoteNode extends NodeBase {
  kind: 'blockquote';
  children: Block[];
}

export interface ListNode extends NodeBase {
  kind: 'list';
  ordered: boolean;
  start?: number;
  tight: boolean;
  items: ListItemNode[];
}

export interface ListItemNode extends NodeBase {
  kind: 'listItem';
  task?: 'checked' | 'unchecked';
  children: Block[];
}

export interface TableNode extends NodeBase {
  kind: 'table';
  align: TableAlignment[];
  header: TableRowNode;
  rows: TableRowNode[];
}

export interface TableRowNode extends NodeBase {
  kind: 'tableRow';
  cells: TableCellNode[];
}

export interface TableCellNode extends NodeBase {
  kind: 'tableCell';
  children: Inline[];
}

export interface ThematicBreakNode extends NodeBase {
  kind: 'thematicBreak';
}

export interface HtmlBlockNode extends NodeBase {
  kind: 'htmlBlock';
  literal: string;
}

// ---------------------------------------------------------------------------
// Inlines
// ---------------------------------------------------------------------------

export interface TextNode extends NodeBase {
  kind: 'text';
  /** Decoded value (entities resolved); span still covers the raw source. */
  value: string;
}

export interface EmphasisNode extends NodeBase {
  kind: 'emphasis';
  children: Inline[];
}

export interface StrongNode extends NodeBase {
  kind: 'strong';
  children: Inline[];
}

export interface StrikethroughNode extends NodeBase {
  kind: 'strikethrough';
  children: Inline[];
}

/**
 * `_underline_` when `extensions.underline` is on (md4c MD_FLAG_UNDERLINE
 * semantics: `_` stops meaning emphasis and every matched underscore
 * contributes one underline level, so `__x__` nests two of these).
 */
export interface UnderlineNode extends NodeBase {
  kind: 'underline';
  children: Inline[];
}

export interface CodeSpanNode extends NodeBase {
  kind: 'codeSpan';
  value: string;
}

export interface LinkNode extends NodeBase {
  kind: 'link';
  href: string;
  title?: string;
  children: Inline[];
  /**
   * Present only under `urlPolicy.blockedLinks: 'node'`: `href` failed the
   * link allowlist. The node exists so a renderer can give the destination
   * meaning of its own; it must never be navigated.
   */
  blocked?: true;
}

export interface ImageNode extends NodeBase {
  kind: 'image';
  src: string;
  alt: string;
  title?: string;
}

export interface AutolinkNode extends NodeBase {
  kind: 'autolink';
  href: string;
  /**
   * The address as written, without `<>` or an added `mailto:` / `http://`.
   * Set by the built-in engine; a custom engine may leave it out, and
   * renderers then fall back to the source slice or `href`.
   */
  text?: string;
}

export interface HardBreakNode extends NodeBase {
  kind: 'hardBreak';
}

export interface SoftBreakNode extends NodeBase {
  kind: 'softBreak';
}

export interface MathNode extends NodeBase {
  kind: 'math';
  value: string;
  display: boolean;
}

export interface SpoilerNode extends NodeBase {
  kind: 'spoiler';
  children: Inline[];
}

export interface HtmlSpanNode extends NodeBase {
  kind: 'htmlSpan';
  literal: string;
}

// ---------------------------------------------------------------------------
// Unions and the document root
// ---------------------------------------------------------------------------

export type Block =
  | ParagraphNode
  | HeadingNode
  | CodeBlockNode
  | BlockquoteNode
  | ListNode
  | ListItemNode
  | TableNode
  | TableRowNode
  | TableCellNode
  | ThematicBreakNode
  | HtmlBlockNode;

export type Inline =
  | TextNode
  | EmphasisNode
  | StrongNode
  | StrikethroughNode
  | UnderlineNode
  | CodeSpanNode
  | LinkNode
  | ImageNode
  | AutolinkNode
  | HardBreakNode
  | SoftBreakNode
  | MathNode
  | SpoilerNode
  | HtmlSpanNode;

export type AnyNode = Block | Inline;

export interface ParsedDocument {
  source: string;
  blocks: Block[];
}

// EXHAUSTIVE BY CONSTRUCTION, AND THAT IS THE POINT OF THE RECORD.
//
// `new Set<Block['kind']>([...])` rejects a kind that is not in the union but
// does not require every kind that is. So adding a member to `Block` and
// forgetting it here used to compile — and the new kind was then classified
// as an INLINE by `isBlock`/`isInline`, which in the native decoder wraps it
// in a synthesized paragraph and yields a malformed tree from a change that
// looked type-safe. A `Record<Block['kind'], true>` makes the omission a
// compile error instead.
const BLOCK_KIND_TABLE: Record<Block['kind'], true> = {
  paragraph: true,
  heading: true,
  codeBlock: true,
  blockquote: true,
  list: true,
  listItem: true,
  table: true,
  tableRow: true,
  tableCell: true,
  thematicBreak: true,
  htmlBlock: true,
};

const BLOCK_KINDS: ReadonlySet<string> = new Set(Object.keys(BLOCK_KIND_TABLE));

export function isBlock(node: AnyNode): node is Block {
  return BLOCK_KINDS.has(node.kind);
}

export function isInline(node: AnyNode): node is Inline {
  return !BLOCK_KINDS.has(node.kind);
}
