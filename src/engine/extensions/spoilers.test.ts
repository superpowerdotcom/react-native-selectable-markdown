import type {
  Block,
  BlockquoteNode,
  ListNode,
  ParsedDocument,
  ParagraphNode,
  SpoilerNode,
} from '../../document/nodes';
import { visit } from '../../document/visit';
import { parseDocument } from '../Engine';
import type { EngineOptions } from '../options';
import { presets } from '../options';
import { describeNative, linkNativeEngineAsDefault } from '../native/__tests__/support';
import { StreamSession } from '../../stream/StreamSession';
import { applySpoilers } from './spoilers';

/**
 * Spoilers are a post-parse transform, but every case here needs a real
 * document to transform, so the whole file goes through the package default —
 * `parseDocument(source, options)` with no engine argument, exactly the call
 * an app makes. That default is md4c now, and in Node nothing links it on its
 * own, so this puts the worker in the state a launched app is already in. On a
 * machine that cannot build the addon there is no parser at all and
 * `describeNative` reports the blocks as skipped; see the loader for why that
 * is a supported configuration rather than a hidden failure.
 */
linkNativeEngineAsDefault();

function parse(source: string, options?: EngineOptions): ParsedDocument {
  return parseDocument(source, options);
}

function slice(doc: ParsedDocument, node: { span: { start: number; end: number } }): string {
  return doc.source.slice(node.span.start, node.span.end);
}

function spoilerCount(doc: ParsedDocument): number {
  let count = 0;
  visit(doc, (n) => {
    if (n.kind === 'spoiler') count += 1;
  });
  return count;
}

describeNative('spoilers are OFF by default (the stray-pipe fix)', () => {
  test('"a | b" parses as plain text', () => {
    const doc = parse('a | b');
    expect(spoilerCount(doc)).toBe(0);
    const p = doc.blocks[0] as ParagraphNode;
    expect(p.children).toHaveLength(1);
    expect(p.children[0]).toMatchObject({ kind: 'text', value: 'a | b' });
  });

  test('"a || b" parses as plain text', () => {
    const doc = parse('a || b');
    expect(spoilerCount(doc)).toBe(0);
    const p = doc.blocks[0] as ParagraphNode;
    expect(p.children[0]).toMatchObject({ kind: 'text', value: 'a || b' });
  });

  test('"||x||" parses as plain text', () => {
    const doc = parse('||x||');
    expect(spoilerCount(doc)).toBe(0);
    const p = doc.blocks[0] as ParagraphNode;
    expect(p.children[0]).toMatchObject({ kind: 'text', value: '||x||' });
  });

  test('llmChat preset also keeps spoilers off', () => {
    const doc = parse('||x||', presets.llmChat);
    expect((doc.blocks[0] as ParagraphNode).children).toEqual([
      { kind: 'text', span: { start: 0, end: 5 }, value: '||x||' },
    ]);
  });

  test('the commonmark preset keeps spoilers off', () => {
    const doc = parse('||x||', presets.commonmark);
    expect((doc.blocks[0] as ParagraphNode).children).toEqual([
      { kind: 'text', span: { start: 0, end: 5 }, value: '||x||' },
    ]);
  });
});

describeNative('spoilers with the everything preset', () => {
  test.each([1, 2, 3, 4])('respects escape parity with %i backslashes', (count) => {
    const source = 'a' + '\\'.repeat(count) + '||b||';
    expect(spoilerCount(parse(source, presets.everything))).toBe(count % 2 === 0 ? 1 : 0);
  });
  test('"||hidden||" becomes a spoiler node with an exact span', () => {
    const doc = parse('||hidden||', presets.everything);
    const p = doc.blocks[0] as ParagraphNode;
    const sp = p.children[0] as SpoilerNode;
    expect(sp.kind).toBe('spoiler');
    expect(slice(doc, sp)).toBe('||hidden||');
    expect(sp.children).toHaveLength(1);
    expect(sp.children[0]).toMatchObject({ kind: 'text', value: 'hidden' });
    expect(slice(doc, sp.children[0])).toBe('hidden');
  });

  test('surrounding text is preserved with exact spans', () => {
    const doc = parse('before ||mid|| after', presets.everything);
    const p = doc.blocks[0] as ParagraphNode;
    expect(p.children.map((c) => c.kind)).toEqual(['text', 'spoiler', 'text']);
    expect(slice(doc, p.children[0])).toBe('before ');
    expect(slice(doc, p.children[1])).toBe('||mid||');
    expect(slice(doc, p.children[2])).toBe(' after');
  });

  test('inner inline formatting is reused inside the spoiler', () => {
    const doc = parse('||a **b** c||', presets.everything);
    const p = doc.blocks[0] as ParagraphNode;
    const sp = p.children[0] as SpoilerNode;
    expect(sp.kind).toBe('spoiler');
    expect(sp.children.map((c) => c.kind)).toEqual(['text', 'strong', 'text']);
    expect(slice(doc, sp.children[1])).toBe('**b**');
  });

  test('two spoilers in one paragraph', () => {
    const doc = parse('||a|| and ||b||', presets.everything);
    expect(spoilerCount(doc)).toBe(2);
    const p = doc.blocks[0] as ParagraphNode;
    expect(slice(doc, p.children[0])).toBe('||a||');
    expect(slice(doc, p.children[2])).toBe('||b||');
  });

  test('spoilers inside headings', () => {
    const doc = parse('# Answer: ||42||', presets.everything);
    const h = doc.blocks[0];
    expect(h.kind).toBe('heading');
    if (h.kind !== 'heading') throw new Error('unreachable');
    expect(h.children.map((c) => c.kind)).toEqual(['text', 'spoiler']);
    const sp = h.children[1] as SpoilerNode;
    expect(slice(doc, sp)).toBe('||42||');
    expect(sp.children[0]).toMatchObject({ kind: 'text', value: '42' });
  });

  test('a stray pipe in a heading stays literal even when enabled', () => {
    const doc = parse('# a | b || c', presets.everything);
    expect(doc.blocks).toEqual([
      {
        kind: 'heading',
        span: { start: 0, end: 12 },
        level: 1,
        children: [{ kind: 'text', span: { start: 2, end: 12 }, value: 'a | b || c' }],
      },
    ]);
  });

  test('spoilers inside blockquotes and list items', () => {
    const doc = parse('> ||q||\n\n- ||i||', presets.everything);
    const quote = doc.blocks[0] as BlockquoteNode;
    const qp = quote.children[0] as ParagraphNode;
    expect(qp.children[0].kind).toBe('spoiler');
    expect(slice(doc, qp.children[0])).toBe('||q||');
    const list = doc.blocks[1] as ListNode;
    const ip = list.items[0].children[0] as ParagraphNode;
    expect(ip.children[0].kind).toBe('spoiler');
  });
});

describeNative('a stray | never produces a spoiler, even when enabled', () => {
  test.each([
    'a | b',
    'a || b',
    'open || only',
    'a | b | c',
    'ends with ||',
    '|| starts only',
    'triple |||x||| pipes',
    '|',
    '||',
  ])('%j stays spoiler-free', (src) => {
    const doc = parse(src, presets.everything);
    const span = { start: 0, end: src.length };
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', span, children: [{ kind: 'text', span, value: src }] },
    ]);
  });

  test('an unpaired trailing || after a real pair stays literal', () => {
    const doc = parse('||a|| and || dangling', presets.everything);
    expect(spoilerCount(doc)).toBe(1);
    const p = doc.blocks[0] as ParagraphNode;
    const tail = p.children[p.children.length - 1];
    expect(tail).toMatchObject({ kind: 'text', value: ' and || dangling' });
  });

  test('pipes inside code spans are never markers', () => {
    const doc = parse('`||x||` and ||real||', presets.everything);
    const p = doc.blocks[0] as ParagraphNode;
    expect(p.children[0].kind).toBe('codeSpan');
    expect(spoilerCount(doc)).toBe(1);
  });
});

describeNative('applySpoilers transform contract', () => {
  test('returns the same document object when nothing matches (identity)', () => {
    const doc = parse('no pipes here');
    expect(applySpoilers(doc)).toBe(doc);
    const unbalanced = parse('one || only');
    expect(applySpoilers(unbalanced)).toBe(unbalanced);
  });

  test('untouched sibling blocks keep referential identity', () => {
    const doc = parse('plain paragraph\n\n||hidden||');
    const out = applySpoilers(doc);
    expect(out).not.toBe(doc);
    expect(out.blocks[0]).toBe(doc.blocks[0]);
    expect(out.blocks[1]).not.toBe(doc.blocks[1]);
  });

  test('the engine itself never parses spoilers — the transform is separate', () => {
    // Parsing with the everything preset but a custom engine call path:
    // the raw engine output (before the transform) must not contain spoilers.
    const raw = parse('||x||', {
      extensions: { ...presets.everything.extensions, spoilers: false },
    });
    expect(spoilerCount(raw)).toBe(0);
    const p = raw.blocks[0] as ParagraphNode;
    expect(p.children[0]).toMatchObject({ kind: 'text', value: '||x||' });
  });

  test('escaped pipes are skipped: the source has no `||` run to match', () => {
    // `\|\|` is two runs of one pipe in the source against one run of two in
    // the value.
    const doc = parse('\\|\\|not a spoiler\\|\\|', presets.everything);
    expect((doc.blocks[0] as ParagraphNode).children).toEqual([
      { kind: 'text', span: { start: 0, end: 21 }, value: '||not a spoiler||' },
    ]);
  });

  test('an escaped pipe touching a real one is skipped too', () => {
    // Same run lengths in source and value, but the source's runs start inside
    // an escape.
    const doc = parse('\\||x\\||', presets.everything);
    expect((doc.blocks[0] as ParagraphNode).children).toEqual([
      { kind: 'text', span: { start: 0, end: 7 }, value: '||x||' },
    ]);
  });

  test('an entity written as pipes never becomes a marker', () => {
    const doc = parse('&#124;&#124;x&#124;&#124;', presets.everything);
    expect((doc.blocks[0] as ParagraphNode).children).toEqual([
      { kind: 'text', span: { start: 0, end: 25 }, value: '||x||' },
    ]);
  });
});

describeNative('a divergence that leaves the pipes alone keeps the spoiler', () => {
  /**
   * Spans are asserted too: a spoiler placed by value offsets in a diverged
   * node copies the wrong markdown.
   */
  test.each([
    ['smart ellipsis', '||secret|| and so on ...'],
    ['smart dash', '||secret|| and a -- dash'],
    ['a decoded entity', '||secret|| and 5 &amp; 6'],
    ['a backslash escape', '||secret|| and \\*escaped\\*'],
    ['a smart quote', '||secret|| and "quoted"'],
  ])('%s later in the paragraph: the spoiler survives', (_label, source) => {
    const doc = parse(source, presets.everything);
    expect(spoilerCount(doc)).toBe(1);
    const p = doc.blocks[0] as ParagraphNode;
    const sp = p.children[0] as SpoilerNode;
    expect(slice(doc, sp)).toBe('||secret||');
    expect(sp.children[0]).toMatchObject({ kind: 'text', value: 'secret' });
    const tail = p.children[1];
    expect(slice(doc, tail)).toBe(source.slice(10));
  });

  test('a divergence INSIDE the spoiler keeps exact spans on both sides', () => {
    const source = '||5 &amp; 6|| after';
    const doc = parse(source, presets.everything);
    const p = doc.blocks[0] as ParagraphNode;
    const sp = p.children[0] as SpoilerNode;
    expect(sp.kind).toBe('spoiler');
    expect(slice(doc, sp)).toBe('||5 &amp; 6||');
    expect(sp.children[0]).toMatchObject({ kind: 'text', value: '5 & 6' });
    expect(slice(doc, sp.children[0])).toBe('5 &amp; 6');
    expect(slice(doc, p.children[1])).toBe(' after');
  });

  test('two spoilers around a rewrite still pair in source order', () => {
    const source = '||a|| ... ||b||';
    const doc = parse(source, presets.everything);
    expect(spoilerCount(doc)).toBe(2);
    const p = doc.blocks[0] as ParagraphNode;
    expect(slice(doc, p.children[0])).toBe('||a||');
    expect(slice(doc, p.children[1])).toBe(' ... ');
    expect(p.children[1]).toMatchObject({ value: ' … ' });
    expect(slice(doc, p.children[2])).toBe('||b||');
  });
});

/**
 * The first case builds the tree directly, so the bound holds even without the
 * native addon.
 */
describe('applySpoilers is depth-bounded', () => {
  function nestedQuotes(depth: number, leaf: ParagraphNode): ParsedDocument {
    let block: BlockquoteNode | ParagraphNode = leaf;
    for (let i = 0; i < depth; i += 1) {
      block = { kind: 'blockquote', span: { start: 0, end: 1 }, children: [block] };
    }
    return { source: '||x||', blocks: [block] };
  }

  test('a 20000-deep blockquote transforms without overflowing the stack', () => {
    const leaf: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: 5 },
      children: [{ kind: 'text', span: { start: 0, end: 5 }, value: '||x||' }],
    };
    const doc = nestedQuotes(20000, leaf);
    const out = applySpoilers(doc);
    expect(out).not.toBe(doc);
    // Reached the bottom rather than stopping early.
    expect(spoilerCount(out)).toBe(1);
  });

  test('a deep tree with nothing to rewrite keeps its identity', () => {
    const leaf: ParagraphNode = {
      kind: 'paragraph',
      span: { start: 0, end: 3 },
      children: [{ kind: 'text', span: { start: 0, end: 3 }, value: 'a b' }],
    };
    const doc = nestedQuotes(20000, leaf);
    expect(applySpoilers(doc)).toBe(doc);
  });
});

describeNative('deep nesting under the everything preset', () => {
  test('a 3000-level blockquote parses instead of throwing', () => {
    const source = '> '.repeat(3000) + 'hi\n';
    for (const options of [presets.everything, presets.llmChat]) {
      const doc = parse(source, options);
      expect(doc.blocks).toHaveLength(1);
      let node: Block = doc.blocks[0];
      let depth = 0;
      while (node.kind === 'blockquote') {
        depth += 1;
        node = node.children[0];
      }
      expect(depth).toBe(3000);
      expect(node).toEqual({
        kind: 'paragraph',
        span: { start: 6000, end: 6002 },
        children: [{ kind: 'text', span: { start: 6000, end: 6002 }, value: 'hi' }],
      });
    }
  });

  test('a 5000-level blockquote streams and finalizes under everything', () => {
    const source = '> '.repeat(5000) + 'hi\n';
    const session = new StreamSession({ options: presets.everything });
    for (let at = 0; at < source.length; at += 64) {
      expect(() => session.append(source.slice(at, at + 64))).not.toThrow();
    }
    expect(() => session.finalize()).not.toThrow();
    const { document } = session.snapshot();
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].kind).toBe('blockquote');
  });
});
