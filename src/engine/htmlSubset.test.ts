import { parseDocument } from './Engine';
import { describeNative, linkNativeEngineAsDefault } from './native/__tests__/support';
import { projectRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { AnyNode } from '../document/nodes';

linkNativeEngineAsDefault();

const subset = { html: { allow: ['a', 'br', 'strong', 'b', 'em'] } } as const;
const shape = (node: AnyNode): unknown =>
  'children' in node
    ? [node.kind, ...('href' in node ? [node.href] : []), (node.children as AnyNode[]).map(shape)]
    : [node.kind, ('value' in node ? node.value : undefined) ?? ''];

describeNative('html: { allow }', () => {
  test('allowed tags become nodes, others strip', () => {
    const doc = parseDocument('x <a href="https://e.test">link <b>bold</b></a> y <span>z</span>\n', subset);
    expect(doc.blocks.map(shape)).toEqual([
      ['paragraph', [
        ['text', 'x '],
        ['link', 'https://e.test', [['text', 'link '], ['strong', [['text', 'bold']]]]],
        ['text', ' y '],
        ['text', 'z'],
      ]],
    ]);
  });

  test('a refused href degrades to its text; other: raw keeps unknown tags', () => {
    expect(parseDocument('bad <a href="javascript:x">no</a>\n', subset).blocks.map(shape)).toEqual([
      ['paragraph', [['text', 'bad '], ['text', 'no']]],
    ]);
    const raw = parseDocument('a <span>b</span>\n', { html: { allow: ['br'], other: 'raw' } });
    expect(raw.blocks.map(shape)).toEqual([
      ['paragraph', [['text', 'a '], ['htmlSpan', ''], ['text', 'b'], ['htmlSpan', '']]],
    ]);
  });

  test('a line opening with <br> keeps the text after it', () => {
    expect(parseDocument('<br>\nafter text\n', subset).blocks.map(shape)).toEqual([
      ['paragraph', [['text', 'after text']]],
    ]);
    // Without the allow-list, strip drops the whole HTML block, text included.
    expect(parseDocument('<br>\nafter text\n', { html: 'strip' }).blocks).toEqual([]);
  });

  test('spans stay exact, so the projection maps back to the source', () => {
    const source = 'see <a href="https://e.test">docs</a> now\n';
    const doc = parseDocument(source, subset);
    const run = segmentRuns(doc)[0];
    const projected = projectRun(run, doc);
    expect(projected.text).toBe('see docs now');
    const link = projected.marks.find((mark) => mark.kind === 'link')!;
    expect(projected.text.slice(link.start, link.end)).toBe('docs');
  });
});
