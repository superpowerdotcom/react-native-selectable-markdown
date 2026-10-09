/** Timing budgets are cliff detectors, not targets: far above the linear cost, far below a super-linear one. */

import type { AnyNode, CodeBlockNode, ListNode, BlockquoteNode } from '../../../document/nodes';
import { visit } from '../../../document/visit';
import { parseDocument } from '../../Engine';
import { DEFAULT_MAX_SOURCE_LENGTH, presets, resolveOptions } from '../../options';
import { nativeEngine } from '../index';
import { describeNative, linkNativeEngineAsDefault } from './support';

linkNativeEngineAsDefault();

const options = presets.llmChat;

function codeBlocksOf(source: string): CodeBlockNode[] {
  const out: CodeBlockNode[] = [];
  visit(parseDocument(source, options), (node: AnyNode) => {
    if (node.kind === 'codeBlock') out.push(node);
  });
  return out;
}

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describeNative('a fence closed by its container, not by a fence', () => {
  test('a top-level fence after a blockquote is its own block, not the quoted fence\'s closer', () => {
    const source = '> ```\n> code\n\n```';
    const doc = parseDocument(source, options);
    expect(doc.blocks.map((block) => block.kind)).toEqual(['blockquote', 'codeBlock']);
    const quoted = (doc.blocks[0] as BlockquoteNode).children[0] as CodeBlockNode;
    expect(quoted.closed).toBe(false);
    expect(source.slice(quoted.span.start, quoted.span.end)).toBe('```\n> code');
    const second = doc.blocks[1];
    expect(second.span.start).toBeGreaterThanOrEqual(doc.blocks[0].span.end);
    expect(source.slice(second.span.start, second.span.end)).toBe('```');
  });

  test('text before a fence run keeps that line out of a list item\'s fence', () => {
    const source = '- ```\n  code\nx ```\n';
    const doc = parseDocument(source, options);
    expect(doc.blocks.map((block) => block.kind)).toEqual(['list', 'paragraph']);
    const code = (doc.blocks[0] as ListNode).items[0].children[0] as CodeBlockNode;
    expect(code.closed).toBe(false);
    expect(code.span.end).toBeLessThanOrEqual(doc.blocks[1].span.start);
    expect(source.slice(doc.blocks[1].span.start, doc.blocks[1].span.end)).toBe('x ```');
  });

  test('a fence md4c closed stays closed, trailing blank lines included', () => {
    for (const source of ['```\ncode\n\n```\n', '- ```\n  code\n\n  ```\n', '> ```\n> code\n>\n> ```\n']) {
      const [code] = codeBlocksOf(source);
      expect(code.closed).toBe(true);
      expect(source.slice(code.span.end - 3, code.span.end)).toBe('```');
    }
  });

  test('a line of blockquote markers after a fence is tested in linear time', () => {
    const source = '- ```\n  code\n' + '> '.repeat(64) + 'a\n';
    let code: CodeBlockNode | undefined;
    expect(timed(() => { [code] = codeBlocksOf(source); })).toBeLessThan(500);
    expect(code?.closed).toBe(false);
  });
});

describeNative('link tails', () => {
  test('reference links each followed by a lone paren cost linear time', () => {
    const source = '[a]: https://e.com\n\n' + '[a]( '.repeat(20000);
    let count = 0;
    expect(
      timed(() => {
        visit(parseDocument(source, options), (node) => {
          if (node.kind === 'link') {
            count += 1;
            expect(source.slice(node.span.start, node.span.end)).toBe('[a]');
          }
        });
      }),
    ).toBeLessThan(3000);
    expect(count).toBe(20000);
  });

  test('unterminated titles are scanned once, not once per link', () => {
    const source = '[a]: https://e.com\n\n' + '[a]("x '.repeat(20000);
    const links: string[] = [];
    expect(
      timed(() => {
        visit(parseDocument(source, options), (node) => {
          if (node.kind === 'link') links.push(source.slice(node.span.start, node.span.end));
        });
      }),
    ).toBeLessThan(3000);
    expect(links).toEqual(Array(20000).fill('[a]'));
  });

  test('terminated tails keep their exact spans', () => {
    const cases: Array<[string, string[]]> = [
      ['[a](https://e.com "t")', ['[a](https://e.com "t")']],
      ['[a](<https://e.com/x y>)', ['[a](<https://e.com/x y>)']],
      ['[a](https://e.com/(x))', ['[a](https://e.com/(x))']],
      ["![i](https://e.com/p.png 'q')", ["![i](https://e.com/p.png 'q')"]],
      ['[a]: https://e.com\n\n[a][] and [a] x', ['[a][]', '[a]']],
    ];
    for (const [source, expected] of cases) {
      const found: string[] = [];
      visit(parseDocument(source, options), (node) => {
        if (node.kind === 'link' || node.kind === 'image') {
          found.push(source.slice(node.span.start, node.span.end));
        }
      });
      expect(found).toEqual(expected);
    }
  });
});

describeNative('thematic breaks inside containers', () => {
  test.each([
    ['- ***', ['list[0,5]', 'listItem[0,5]', 'thematicBreak[2,5]']],
    ['1. ---', ['list[0,6]', 'listItem[0,6]', 'thematicBreak[3,6]']],
    ['> ***', ['blockquote[0,5]', 'thematicBreak[2,5]']],
    ['- - -', ['thematicBreak[0,5]']],
  ])('%j has a real span at every level', (source, expected) => {
    const spans: string[] = [];
    visit(parseDocument(source, options), (node) => {
      spans.push(`${node.kind}[${node.span.start},${node.span.end}]`);
    });
    expect(spans).toEqual(expected);
  });
});

describe('maxSourceLength', () => {
  test('parseDocument refuses a source over the default before any engine runs', () => {
    expect(() => parseDocument('x'.repeat(DEFAULT_MAX_SOURCE_LENGTH + 1), options)).toThrow(RangeError);
  });

  test('a consumer cap applies to parseDocument and to the engine directly', () => {
    expect(() => parseDocument('abcdef', { ...options, maxSourceLength: 5 })).toThrow(/maxSourceLength/);
    expect(() => nativeEngine.parse('abcdef', resolveOptions({ ...options, maxSourceLength: 5 }))).toThrow(
      RangeError,
    );
  });

  describeNative('with the native engine', () => {
    test('Infinity parses a source past the default', () => {
      const doc = parseDocument('x'.repeat(DEFAULT_MAX_SOURCE_LENGTH + 1), { ...options, maxSourceLength: Infinity });
      expect(doc.blocks).toMatchObject([{ kind: 'paragraph', span: { start: 0, end: DEFAULT_MAX_SOURCE_LENGTH + 1 } }]);
    });
  });
});

