import type {
  Block,
  BlockquoteNode,
  CodeBlockNode,
  HeadingNode,
  Inline,
  ListItemNode,
  ListNode,
  ParagraphNode,
  TableCellNode,
  TableNode,
  TableRowNode,
  TextNode,
  ThematicBreakNode,
} from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { trimTrailingPlaceholders } from './placeholders';

const span = (start = 0, end = 1): SourceSpan => ({ start, end });

const text = (value: string): TextNode => ({
  kind: 'text',
  span: span(0, value.length),
  value,
});

const para = (content?: string): ParagraphNode => ({
  kind: 'paragraph',
  span: span(),
  children: content ? [text(content)] : [],
});

const heading = (content?: string): HeadingNode => ({
  kind: 'heading',
  span: span(),
  level: 1,
  children: content ? [text(content)] : [],
});

const fence = (literal: string, closed: boolean): CodeBlockNode => ({
  kind: 'codeBlock',
  span: span(),
  literal,
  fenced: true,
  closed,
});

const quote = (children: Block[]): BlockquoteNode => ({
  kind: 'blockquote',
  span: span(),
  children,
});

const item = (children: Block[]): ListItemNode => ({
  kind: 'listItem',
  span: span(),
  children,
});

const list = (items: ListItemNode[]): ListNode => ({
  kind: 'list',
  span: span(),
  ordered: false,
  tight: true,
  items,
});

const cell = (children: Inline[]): TableCellNode => ({
  kind: 'tableCell',
  span: span(),
  children,
});

const row = (cells: TableCellNode[]): TableRowNode => ({
  kind: 'tableRow',
  span: span(),
  cells,
});

const table = (header: TableRowNode, rows: TableRowNode[]): TableNode => ({
  kind: 'table',
  span: span(),
  align: [null, null],
  header,
  rows,
});

const hr = (): ThematicBreakNode => ({ kind: 'thematicBreak', span: span() });

describe('trimTrailingPlaceholders', () => {
  test('returns the same array when nothing needs trimming', () => {
    const blocks: Block[] = [para('a'), heading('b')];
    expect(trimTrailingPlaceholders(blocks)).toBe(blocks);
  });

  test('empty input returns the same array', () => {
    const blocks: Block[] = [];
    expect(trimTrailingPlaceholders(blocks)).toBe(blocks);
  });

  test('drops a trailing empty heading', () => {
    const out = trimTrailingPlaceholders([para('a'), heading()]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('paragraph');
  });

  test('drops a trailing empty paragraph', () => {
    const first = para('a');
    expect(trimTrailingPlaceholders([first, para()])).toEqual([first]);
  });

  test('drops multiple trailing empties', () => {
    const first = para('a');
    expect(trimTrailingPlaceholders([first, heading(), para()])).toEqual([
      first,
    ]);
  });

  test('untouched leading blocks keep identity after a trim', () => {
    const first = para('a');
    const out = trimTrailingPlaceholders([first, heading()]);
    expect(out[0]).toBe(first);
  });

  test('drops an empty trailing fence', () => {
    const first = para('a');
    expect(trimTrailingPlaceholders([first, fence('', false)])).toEqual([
      first,
    ]);
  });

  test('keeps a non-empty unclosed fence', () => {
    const blocks: Block[] = [para('a'), fence('code', false)];
    expect(trimTrailingPlaceholders(blocks)).toBe(blocks);
  });

  test('drops an empty trailing list item, keeping earlier items by identity', () => {
    const kept = item([para('one')]);
    const out = trimTrailingPlaceholders([list([kept, item([])])]);
    expect(out).toHaveLength(1);
    const trimmed = out[0] as ListNode;
    expect(trimmed.items).toHaveLength(1);
    expect(trimmed.items[0]).toBe(kept);
  });

  test('drops a list whose only item is empty', () => {
    const out = trimTrailingPlaceholders([para('a'), list([item([])])]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('paragraph');
  });

  test('recurses into nested lists on the last item', () => {
    const inner = list([item([])]);
    const out = trimTrailingPlaceholders([
      list([item([para('one')]), item([inner])]),
    ]);
    expect(out).toHaveLength(1);
    const trimmed = out[0] as ListNode;
    expect(trimmed.items).toHaveLength(1);
    expect(trimmed.items[0].children[0].kind).toBe('paragraph');
  });

  test('drops a blockquote emptied by its own trimming', () => {
    const out = trimTrailingPlaceholders([para('a'), quote([para()])]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('paragraph');
  });

  test('trims inside a trailing blockquote, preserving earlier children', () => {
    const kept = para('kept');
    const out = trimTrailingPlaceholders([quote([kept, para()])]);
    expect(out).toHaveLength(1);
    const trimmed = out[0] as BlockquoteNode;
    expect(trimmed.children).toHaveLength(1);
    expect(trimmed.children[0]).toBe(kept);
  });

  test('drops a trailing partial table row (fewer cells than header)', () => {
    const header = row([cell([text('a')]), cell([text('b')])]);
    const full = row([cell([text('1')]), cell([text('2')])]);
    const partial = row([cell([text('3')])]);
    const out = trimTrailingPlaceholders([table(header, [full, partial])]);
    const trimmed = out[0] as TableNode;
    expect(trimmed.rows).toHaveLength(1);
    expect(trimmed.rows[0]).toBe(full);
  });

  test('drops a trailing all-empty table row', () => {
    const header = row([cell([text('a')]), cell([text('b')])]);
    const full = row([cell([text('1')]), cell([text('2')])]);
    const empty = row([cell([]), cell([])]);
    const out = trimTrailingPlaceholders([table(header, [full, empty])]);
    const trimmed = out[0] as TableNode;
    expect(trimmed.header).toBe(header);
    expect(trimmed.rows).toEqual([full]);
  });

  test('keeps a complete table untouched', () => {
    const header = row([cell([text('a')]), cell([text('b')])]);
    const full = row([cell([text('1')]), cell([text('2')])]);
    const blocks: Block[] = [table(header, [full])];
    expect(trimTrailingPlaceholders(blocks)).toBe(blocks);
  });

  test('keeps a trailing thematic break', () => {
    const blocks: Block[] = [para('a'), hr()];
    expect(trimTrailingPlaceholders(blocks)).toBe(blocks);
  });
});
