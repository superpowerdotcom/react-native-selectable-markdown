import type { Block, ParsedDocument } from '../document/nodes';
import { applyHtmlSubset } from './htmlSubset';
import { resolveOptions } from './options';

test('html: { allow } converts under 20,000 nested blockquotes without overflowing', () => {
  const depth = 20000;
  let inner: Block = {
    kind: 'paragraph',
    span: { start: depth, end: depth + 8 },
    children: [
      { kind: 'htmlSpan', span: { start: depth, end: depth + 3 }, literal: '<b>' },
      { kind: 'text', span: { start: depth + 3, end: depth + 4 }, value: 'x' },
      { kind: 'htmlSpan', span: { start: depth + 4, end: depth + 8 }, literal: '</b>' },
    ],
  };
  for (let level = depth - 1; level >= 0; level -= 1) {
    inner = { kind: 'blockquote', span: { start: level, end: depth + 8 }, children: [inner] };
  }
  const source = '>'.repeat(depth) + '<b>x</b>';
  const doc: ParsedDocument = { source, blocks: [inner] };
  const out = applyHtmlSubset(doc, resolveOptions({ html: { allow: ['b'] } }));
  let node: Block = out.blocks[0];
  for (let level = 0; level < depth; level += 1) {
    expect(node.kind).toBe('blockquote');
    node = (node as Extract<Block, { kind: 'blockquote' }>).children[0];
  }
  expect(node).toMatchObject({
    kind: 'paragraph',
    children: [{ kind: 'strong', span: { start: depth, end: depth + 8 }, children: [{ kind: 'text', value: 'x' }] }],
  });
});
