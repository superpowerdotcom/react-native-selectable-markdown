import type {
  AnyNode,
  HeadingNode,
  ParsedDocument,
  ParagraphNode,
} from './nodes';
import { isBlock, isInline } from './nodes';
import { sliceSpan, spanContains, spanIntersects, spanLength } from './span';
import { childrenOf, findAt, visit } from './visit';

// source layout:  # Hi\n\n*a* b
// offsets:        0123 4 5 678910
const source = '# Hi\n\n*a* b';

const heading: HeadingNode = {
  kind: 'heading',
  level: 1,
  span: { start: 0, end: 4 },
  children: [{ kind: 'text', value: 'Hi', span: { start: 2, end: 4 } }],
};

const paragraph: ParagraphNode = {
  kind: 'paragraph',
  span: { start: 6, end: 11 },
  children: [
    {
      kind: 'emphasis',
      span: { start: 6, end: 9 },
      children: [{ kind: 'text', value: 'a', span: { start: 7, end: 8 } }],
    },
    { kind: 'text', value: ' b', span: { start: 9, end: 11 } },
  ],
};

const doc: ParsedDocument = { source, blocks: [heading, paragraph] };

describe('span helpers', () => {
  it('spanLength', () => {
    expect(spanLength({ start: 2, end: 4 })).toBe(2);
    expect(spanLength({ start: 5, end: 5 })).toBe(0);
  });

  it('spanContains', () => {
    expect(spanContains({ start: 0, end: 10 }, { start: 2, end: 4 })).toBe(true);
    expect(spanContains({ start: 0, end: 10 }, { start: 0, end: 10 })).toBe(true);
    expect(spanContains({ start: 2, end: 4 }, { start: 0, end: 10 })).toBe(false);
    expect(spanContains({ start: 0, end: 4 }, { start: 3, end: 5 })).toBe(false);
  });

  it('spanIntersects', () => {
    expect(spanIntersects({ start: 0, end: 4 }, { start: 3, end: 6 })).toBe(true);
    expect(spanIntersects({ start: 3, end: 6 }, { start: 0, end: 4 })).toBe(true);
    // adjacent, half-open ranges do not intersect
    expect(spanIntersects({ start: 0, end: 4 }, { start: 4, end: 6 })).toBe(false);
    expect(spanIntersects({ start: 0, end: 2 }, { start: 5, end: 7 })).toBe(false);
  });

  it('sliceSpan returns exactly the construct source', () => {
    expect(sliceSpan(source, heading.span)).toBe('# Hi');
    expect(sliceSpan(source, { start: 6, end: 9 })).toBe('*a*');
    expect(sliceSpan(source, { start: 9, end: 11 })).toBe(' b');
  });
});

describe('type guards', () => {
  it('classifies blocks and inlines', () => {
    expect(isBlock(heading)).toBe(true);
    expect(isInline(heading)).toBe(false);
    expect(isBlock(heading.children[0])).toBe(false);
    expect(isInline(heading.children[0])).toBe(true);
  });
});

describe('visit', () => {
  it('traverses a document pre-order with correct parents', () => {
    const kinds: string[] = [];
    const parents: (string | null)[] = [];
    visit(doc, (n, parent) => {
      kinds.push(n.kind);
      parents.push(parent ? parent.kind : null);
    });
    expect(kinds).toEqual([
      'heading',
      'text',
      'paragraph',
      'emphasis',
      'text',
      'text',
    ]);
    expect(parents).toEqual([
      null,
      'heading',
      null,
      'paragraph',
      'emphasis',
      'paragraph',
    ]);
  });

  it('returning false skips children but not siblings', () => {
    const kinds: string[] = [];
    visit(doc, (n) => {
      kinds.push(n.kind);
      if (n.kind === 'paragraph') {
        return false;
      }
    });
    expect(kinds).toEqual(['heading', 'text', 'paragraph']);
  });

  it('traverses a single node', () => {
    const kinds: string[] = [];
    visit(paragraph, (n) => {
      kinds.push(n.kind);
    });
    expect(kinds).toEqual(['paragraph', 'emphasis', 'text', 'text']);
  });
});

describe('childrenOf', () => {
  it('returns children in document order and empty for leaves', () => {
    expect(childrenOf(paragraph).map((n: AnyNode) => n.kind)).toEqual([
      'emphasis',
      'text',
    ]);
    expect(childrenOf(paragraph.children[1])).toEqual([]);
  });
});

describe('findAt', () => {
  it('returns the outermost-to-innermost path containing the offset', () => {
    expect(findAt(doc, 7).map((n) => n.kind)).toEqual([
      'paragraph',
      'emphasis',
      'text',
    ]);
    expect(findAt(doc, 2).map((n) => n.kind)).toEqual(['heading', 'text']);
  });

  it('stops at the deepest containing node', () => {
    // offset 6 is the '*' opener: inside emphasis but not inside its text
    expect(findAt(doc, 6).map((n) => n.kind)).toEqual([
      'paragraph',
      'emphasis',
    ]);
  });

  it('returns an empty path for offsets between blocks', () => {
    expect(findAt(doc, 4)).toEqual([]);
    expect(findAt(doc, 5)).toEqual([]);
    expect(findAt(doc, 11)).toEqual([]);
  });
});
