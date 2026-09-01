import type {
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
    expect(spoilerCount(doc)).toBe(0);
  });

  test('the commonmark preset keeps spoilers off', () => {
    const doc = parse('||x||', presets.commonmark);
    expect(spoilerCount(doc)).toBe(0);
  });
});

describeNative('spoilers with the everything preset', () => {
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
    expect(spoilerCount(doc)).toBe(0);
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
    expect(spoilerCount(doc)).toBe(0);
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

  test('escaped pipes are skipped: the text run no longer maps 1:1', () => {
    const doc = parse('\\|\\|not a spoiler\\|\\|', presets.everything);
    expect(spoilerCount(doc)).toBe(0);
  });
});
