import type { AnyNode, Block, ParsedDocument } from '../document/nodes';
import { visit } from '../document/visit';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { presets } from '../engine/options';
import { StreamSession } from './StreamSession';
import { shiftSpans } from './shiftSpans';

const FIXTURE = [
  '# Heading with **strong** text',
  '',
  '> quoted *emphasis* here',
  '',
  '- item one with `code`',
  '- item two',
  '  - nested [link](https://example.com)',
  '',
  '| a | b |',
  '| --- | --- |',
  '| one | two |',
  '',
  'Closing paragraph.',
].join('\n');

function collectNodes(block: Block): AnyNode[] {
  const nodes: AnyNode[] = [];
  visit(block, (n) => {
    nodes.push(n);
  });
  return nodes;
}

/*
 * `shiftSpans` is pure span arithmetic, but the shapes it has to walk are not:
 * a table's `header`/`rows`, a list's `items`, an inline's `children` are four
 * different child-container conventions, and a real parse is the only way to
 * be sure the fixture actually contains all of them. So the tree comes from
 * the package default — md4c — and the block is gated on it, while the
 * hand-built unanchored-span case below needs no parser and runs everywhere.
 */
linkNativeEngineAsDefault();

describeNative('shiftSpans over a real parsed tree', () => {
  // Parsed in `beforeAll` rather than in the describe body: Jest evaluates the
  // body of a skipped block too, so a top-level parse here would throw on a
  // machine with no compiled addon — the exact machine the skip exists for.
  let doc!: ParsedDocument;
  beforeAll(() => {
    doc = parseDocument(FIXTURE, presets.llmChat);
  });

  test('shifts every descendant span by exactly delta', () => {
    const delta = 137;
    const kinds = new Set<string>();
    for (const block of doc.blocks) {
      const shifted = shiftSpans(block, delta);
      const before = collectNodes(block);
      const after = collectNodes(shifted);
      expect(after).toHaveLength(before.length);
      for (let i = 0; i < before.length; i += 1) {
        expect(after[i].kind).toBe(before[i].kind);
        expect(after[i].span).toEqual({
          start: before[i].span.start + delta,
          end: before[i].span.end + delta,
        });
        kinds.add(after[i].kind);
      }
    }
    expect([...kinds].sort()).toEqual([
      'blockquote',
      'codeSpan',
      'emphasis',
      'heading',
      'link',
      'list',
      'listItem',
      'paragraph',
      'strong',
      'table',
      'tableCell',
      'tableRow',
      'text',
    ]);
  });

  test('never mutates the input tree', () => {
    const snapshot = JSON.parse(JSON.stringify(doc.blocks));
    const shifted = doc.blocks.map((block) => shiftSpans(block, 999));
    expect(JSON.parse(JSON.stringify(doc.blocks))).toEqual(snapshot);
    expect(doc.blocks[0].span).toEqual({ start: 0, end: 30 });
    expect(shifted[0].span).toEqual({ start: 999, end: 1029 });
  });

  test('returns a fully independent deep clone', () => {
    const list = doc.blocks.find((b) => b.kind === 'list');
    expect(list).toBeDefined();
    const shifted = shiftSpans(list as Block, 0);
    expect(shifted).not.toBe(list);
    const before = collectNodes(list as Block);
    const after = collectNodes(shifted);
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]).not.toBe(before[i]);
    }
    // Same structure at delta 0 — only identity differs.
    expect(JSON.parse(JSON.stringify(shifted))).toEqual(
      JSON.parse(JSON.stringify(list)),
    );
  });

  test('preserves non-span payload fields verbatim', () => {
    const table = doc.blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table === undefined || table.kind !== 'table') {
      return;
    }
    const shifted = shiftSpans(table, 41);
    expect(shifted.align).toEqual(table.align);
    expect(shifted.header.cells).toHaveLength(table.header.cells.length);
    expect(shifted.rows).toHaveLength(table.rows.length);

    const code = doc.blocks
      .flatMap((b) => collectNodes(b))
      .find((n) => n.kind === 'codeSpan');
    expect(code).toBeDefined();
    if (code !== undefined && code.kind === 'codeSpan') {
      const shiftedCode = shiftSpans(code, 7);
      expect(shiftedCode.value).toBe(code.value);
    }
  });
});

describe('shiftSpans over hand-built nodes', () => {
  test('leaves an unanchored span unanchored instead of rebasing it', () => {
    // -1 is the decoder's "this node has no source offsets". Rebasing it the
    // way every other span is rebased turns it into a positive, in-bounds,
    // entirely fictional offset that selection and copy then trust. The
    // splice must not launder a decoder bug into a plausible location.
    //
    // Hand-built on purpose: no parse produces this tree today (the padding
    // cell that used to was fixed), and a case that only exists while a bug
    // does is a case that disappears the moment it is needed most.
    const unanchored: Block = {
      kind: 'paragraph',
      span: { start: -1, end: -1 },
      children: [
        { kind: 'text', span: { start: -1, end: -1 }, value: 'x' },
        { kind: 'text', span: { start: 0, end: 1 }, value: 'y' },
      ],
    };
    const shifted = shiftSpans(unanchored, 500);
    expect(shifted.span).toEqual({ start: -1, end: -1 });
    expect(shifted.children[0].span).toEqual({ start: -1, end: -1 });
    // The anchored sibling still moves — the guard is per node, not per tree.
    expect(shifted.children[1].span).toEqual({ start: 500, end: 501 });
  });
});

describe('shiftSpans at depth', () => {
  function nest(depth: number): Block {
    let node: Block = {
      kind: 'paragraph',
      span: { start: depth, end: depth + 4 },
      children: [
        { kind: 'text', span: { start: depth, end: depth + 4 }, value: 'echo' },
      ],
    };
    for (let i = depth - 1; i >= 0; i -= 1) {
      node = {
        kind: 'blockquote',
        span: { start: i, end: depth + 4 },
        children: [node],
      };
    }
    return node;
  }

  test('shifts a 20000-deep tree without overflowing the stack', () => {
    const deep = nest(20_000);
    const shifted = shiftSpans(deep, 7);

    // A recursive check would overflow on its own at this depth.
    let source: AnyNode = deep;
    let clone: AnyNode = shifted;
    let levels = 0;
    for (;;) {
      expect(clone).not.toBe(source);
      expect(clone.kind).toBe(source.kind);
      expect(clone.span).toEqual({
        start: source.span.start + 7,
        end: source.span.end + 7,
      });
      const next: AnyNode[] | undefined = (source as { children?: AnyNode[] })
        .children;
      if (next === undefined || next.length === 0) {
        break;
      }
      source = next[0];
      clone = (clone as { children: AnyNode[] }).children[0];
      levels += 1;
    }
    expect(levels).toBe(20_001);
  });
});

describeNative('shiftSpans inside a streamed deep blockquote', () => {
  test.each([1500, 3000])(
    "streams a '> ' prefix %i levels deep without overflowing",
    (levels) => {
      const source = '> '.repeat(levels) + 'echo\n';
      const session = new StreamSession();
      // Many appends, so the splice runs on a deep tree repeatedly, not once.
      for (let i = 0; i < source.length; i += 64) {
        session.append(source.slice(i, i + 64));
      }
      session.finalize();
      const snap = session.snapshot();
      expect(snap.document.source).toBe(source);
      expect(snap.document.blocks).toHaveLength(1);
      expect(snap.document.blocks[0].kind).toBe('blockquote');
    },
  );
});
