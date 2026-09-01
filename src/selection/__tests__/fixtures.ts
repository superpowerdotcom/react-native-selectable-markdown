import type {
  Block,
  ParsedDocument,
  ParagraphNode,
  TextNode,
} from '../../document/nodes';
import type { SourceSpan } from '../../document/span';
import type { Engine } from '../../engine/Engine';
import type { ProjectedRun } from '../mapSelection';

/**
 * Hand-built document fixtures for the selection tests.
 *
 * Deliberately independent of any parser. Spans are located by exact fragment
 * search over the fixture source, so every test asserts real offsets while
 * stating the document it means in the test file itself — a selection failure
 * points at selection code rather than sending the reader to find out what the
 * parser did with a source string. It also means these run on a machine with
 * no compiler, where the package's md4c engine cannot parse anything at all.
 * The corpus-scale counterpart, over documents from a real parse, is
 * conformance/selection/projection-oracle.test.ts.
 */

export function spanOf(
  source: string,
  fragment: string,
  from = 0,
): SourceSpan {
  const start = source.indexOf(fragment, from);
  if (start < 0) {
    throw new Error(`fixture fragment not found: ${JSON.stringify(fragment)}`);
  }
  return { start, end: start + fragment.length };
}

export function textNode(source: string, value: string, from = 0): TextNode {
  return { kind: 'text', value, span: spanOf(source, value, from) };
}

export function plainParagraph(
  source: string,
  value: string,
  from = 0,
): ParagraphNode {
  const span = spanOf(source, value, from);
  return { kind: 'paragraph', span, children: [{ kind: 'text', value, span }] };
}

export function makeDoc(source: string, blocks: Block[]): ParsedDocument {
  return { source, blocks };
}

/**
 * Minimal hand-built engine: splits on blank lines into paragraphs whose
 * text is the exact source slice. Used to exercise `buildCopyPayload`'s
 * reparse path without depending on a parser — the payload's shape is what is
 * under test there, and a real parse would only add a way for the case to fail
 * for reasons that have nothing to do with copy.
 */
export const plainTextEngine: Engine = {
  name: 'fixture-plaintext',
  parse(source: string): ParsedDocument {
    const blocks: Block[] = [];
    let cursor = 0;
    while (cursor < source.length) {
      let boundary = source.indexOf('\n\n', cursor);
      if (boundary === -1) {
        boundary = source.length;
      }
      const value = source.slice(cursor, boundary);
      if (value.length > 0) {
        const span = { start: cursor, end: boundary };
        blocks.push({
          kind: 'paragraph',
          span,
          children: [{ kind: 'text', value, span }],
        });
      }
      cursor = boundary + 2;
    }
    return { source, blocks };
  },
};

/** Asserts that pieces tile the projected text exactly, in order. */
export function expectTiling(projected: ProjectedRun): void {
  let cursor = 0;
  for (const piece of projected.pieces) {
    expect(piece.textStart).toBe(cursor);
    expect(piece.textEnd).toBeGreaterThan(piece.textStart);
    cursor = piece.textEnd;
  }
  expect(cursor).toBe(projected.text.length);
}
