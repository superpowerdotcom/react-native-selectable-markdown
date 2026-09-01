import type {
  Block,
  CodeBlockNode,
  HeadingNode,
  ImageNode,
  LinkNode,
  ListNode,
  ParagraphNode,
  SpoilerNode,
  TableNode,
  ThematicBreakNode,
} from '../../document/nodes';
import { classifyBlock, segmentRuns } from '../runs';
import type { ClassifyBlock } from '../runs';
import { makeDoc, plainParagraph, spanOf, textNode } from './fixtures';

describe('segmentRuns', () => {
  it('returns no runs for an empty document', () => {
    expect(segmentRuns(makeDoc('', []))).toEqual([]);
  });

  it('merges adjacent prose blocks into a single run', () => {
    const source = '## Title\n\nFirst body.\n\n> quoted\n\n- item';
    const heading: HeadingNode = {
      kind: 'heading',
      level: 2,
      span: spanOf(source, '## Title'),
      children: [textNode(source, 'Title')],
    };
    const para = plainParagraph(source, 'First body.');
    const quote: Block = {
      kind: 'blockquote',
      span: spanOf(source, '> quoted'),
      children: [plainParagraph(source, 'quoted')],
    };
    const list: ListNode = {
      kind: 'list',
      ordered: false,
      tight: true,
      span: spanOf(source, '- item'),
      items: [
        {
          kind: 'listItem',
          span: spanOf(source, '- item'),
          children: [plainParagraph(source, 'item')],
        },
      ],
    };
    const runs = segmentRuns(makeDoc(source, [heading, para, quote, list]));

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
    expect(runs[0].selectable).toBe(true);
    expect(runs[0].blocks).toEqual([heading, para, quote, list]);
    expect(runs[0].span).toEqual({
      start: heading.span.start,
      end: list.span.end,
    });
  });

  // THE NEXT THREE ASSERT THE INVERSE OF WHAT THEY USED TO, DELIBERATELY.
  //
  // Code blocks, tables and thematic breaks were standalone because their
  // built-in RENDERERS emit views. But all three project text and marks
  // (mapSelection: a `codeBlock` mark over the literal, a `tableHeader` mark
  // with rows joined by '\n' and cells by '\t', and nothing at all for a rule),
  // so all three can flow. Keeping them standalone ended a run at every one of
  // them, which in an LLM chat surface means a reader could not sweep a
  // selection across most answers — a worse outcome than a code block losing
  // its padded box.
  //
  // A consumer who wants the box back claims the block `standalone` through
  // `classifyBlock`; that hook now runs in the other direction, and the two
  // tests in the `classifyBlock seam` block below cover both directions.
  it('merges code blocks into the surrounding prose run', () => {
    const source = 'Intro.\n\n```js\nconst x = 1;\n```\n\nAfter.';
    const intro = plainParagraph(source, 'Intro.');
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      language: 'js',
      literal: 'const x = 1;\n',
      fenced: true,
      closed: true,
      span: spanOf(source, '```js\nconst x = 1;\n```'),
    };
    const after = plainParagraph(source, 'After.');
    const runs = segmentRuns(makeDoc(source, [intro, code, after]));

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
    expect(runs[0].blocks).toEqual([intro, code, after]);
  });

  it('merges a table and an adjacent code block into one run', () => {
    const source = '| a |\n| - |\n| b |\n```\nx\n```';
    const headerCell = spanOf(source, 'a');
    const bodyCell = spanOf(source, 'b');
    const table: TableNode = {
      kind: 'table',
      align: [null],
      span: { start: 0, end: spanOf(source, '| b |').end },
      header: {
        kind: 'tableRow',
        span: spanOf(source, '| a |'),
        cells: [
          { kind: 'tableCell', span: headerCell, children: [textNode(source, 'a')] },
        ],
      },
      rows: [
        {
          kind: 'tableRow',
          span: spanOf(source, '| b |'),
          cells: [
            { kind: 'tableCell', span: bodyCell, children: [textNode(source, 'b')] },
          ],
        },
      ],
    };
    const code: CodeBlockNode = {
      kind: 'codeBlock',
      literal: 'x\n',
      fenced: true,
      closed: true,
      span: spanOf(source, '```\nx\n```'),
    };
    const runs = segmentRuns(makeDoc(source, [table, code]));

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
    expect(runs[0].blocks).toEqual([table, code]);
  });

  it('merges thematic breaks, so a selection crosses a rule', () => {
    const source = 'Above.\n\n---\n\nBelow.';
    const rule: ThematicBreakNode = {
      kind: 'thematicBreak',
      span: spanOf(source, '---'),
    };
    const above = plainParagraph(source, 'Above.');
    const below = plainParagraph(source, 'Below.');
    const runs = segmentRuns(makeDoc(source, [above, rule, below]));

    // One run spanning the rule is the whole point: a reader sweeping from
    // "Above." to "Below." used to hit three separate selection scopes.
    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
    expect(runs[0].blocks).toEqual([above, rule, below]);
  });

  // A rule flows only in company. Alone it projects the empty string — no
  // text of its own, and separators exist only between blocks — and the
  // native hosts measure empty text to a 0×0 box and skip decoration
  // drawing, so a flowing lone rule would silently vanish. These pin the
  // standalone fallback that keeps it visible.
  describe('lone thematic breaks', () => {
    it('makes a document that is only a rule a standalone run', () => {
      const source = '---\n';
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const runs = segmentRuns(makeDoc(source, [rule]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(true);
      expect(runs[0].blocks).toEqual([rule]);
      expect(runs[0].span).toEqual(rule.span);
    });

    it('makes a rule between two standalone blocks standalone', () => {
      const source = '![a](1.png)\n\n---\n\n![b](2.png)';
      const imageParagraph = (fragment: string, src: string): ParagraphNode => {
        const span = spanOf(source, fragment);
        return {
          kind: 'paragraph',
          span,
          children: [{ kind: 'image', src, alt: '', span }],
        };
      };
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const runs = segmentRuns(
        makeDoc(source, [
          imageParagraph('![a](1.png)', '1.png'),
          rule,
          imageParagraph('![b](2.png)', '2.png'),
        ]),
      );

      expect(runs).toHaveLength(3);
      expect(runs.map((r) => r.standalone)).toEqual([true, true, true]);
      expect(runs[1].blocks).toEqual([rule]);
    });

    it('splits adjacent lone rules into one standalone run each', () => {
      // Even two rules together project only the separator between them —
      // blank text with nothing selectable — so the fallback applies to the
      // whole all-rule stretch, not just a single orphan.
      const source = '---\n\n***';
      const first: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const second: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '***'),
      };
      const runs = segmentRuns(makeDoc(source, [first, second]));

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.standalone)).toEqual([true, true]);
      expect(runs[0].blocks).toEqual([first]);
      expect(runs[1].blocks).toEqual([second]);
    });

    it('keeps the settled flag on a rule isolated by the streaming boundary', () => {
      const source = 'Done.\n\n---';
      const done = plainParagraph(source, 'Done.');
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const runs = segmentRuns(makeDoc(source, [done, rule]), {
        settledUntil: done.span.end,
      });

      expect(runs).toHaveLength(2);
      expect(runs[1].standalone).toBe(true);
      expect(runs[1].blocks).toEqual([rule]);
      expect(runs[1].selectable).toBe(false);
    });
  });


  describe('nested standalone constructs', () => {
    it('merges a list carrying a code block, since both flow now', () => {
      const source = 'Intro.\n\n- item\n\n  ```\n  x\n  ```\n\nAfter.';
      const intro = plainParagraph(source, 'Intro.');
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: 'x\n',
        fenced: true,
        closed: true,
        span: spanOf(source, '```\n  x\n  ```'),
      };
      const itemSpan = {
        start: spanOf(source, '- item').start,
        end: code.span.end,
      };
      const list: ListNode = {
        kind: 'list',
        ordered: false,
        tight: false,
        span: itemSpan,
        items: [
          {
            kind: 'listItem',
            span: itemSpan,
            children: [plainParagraph(source, 'item'), code],
          },
        ],
      };
      const after = plainParagraph(source, 'After.');
      const runs = segmentRuns(makeDoc(source, [intro, list, after]));

      // A nested code block was the classic reason a whole list went
      // standalone. Now that `codeBlock` flows, there is nothing in this list
      // that cannot be text, so the stretch stays one run.
      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
      expect(runs[0].blocks).toEqual([intro, list, after]);
    });

    it('makes a paragraph carrying an image standalone', () => {
      const source = 'Before.\n\n![alt](img.png)\n\nAfter.';
      const image: ImageNode = {
        kind: 'image',
        src: 'img.png',
        alt: 'alt',
        span: spanOf(source, '![alt](img.png)'),
      };
      const withImage: ParagraphNode = {
        kind: 'paragraph',
        span: image.span,
        children: [image],
      };
      const runs = segmentRuns(
        makeDoc(source, [
          plainParagraph(source, 'Before.'),
          withImage,
          plainParagraph(source, 'After.'),
        ]),
      );

      expect(runs).toHaveLength(3);
      expect(runs.map((r) => r.standalone)).toEqual([false, true, false]);
    });

    it('makes a paragraph carrying a spoiler standalone', () => {
      // A spoiler is the one inline that owns a tap target: without its own
      // renderer there is no way to reveal it, and the native host can only
      // paint the mask. Standalone is what gives it back its renderer.
      const source = 'Before.\n\nsee ||hidden|| now\n\nAfter.';
      const spoiler: SpoilerNode = {
        kind: 'spoiler',
        span: spanOf(source, '||hidden||'),
        children: [textNode(source, 'hidden')],
      };
      const withSpoiler: ParagraphNode = {
        kind: 'paragraph',
        span: spanOf(source, 'see ||hidden|| now'),
        children: [
          textNode(source, 'see '),
          spoiler,
          textNode(source, ' now'),
        ],
      };
      const runs = segmentRuns(
        makeDoc(source, [
          plainParagraph(source, 'Before.'),
          withSpoiler,
          plainParagraph(source, 'After.'),
        ]),
      );

      expect(runs).toHaveLength(3);
      expect(runs.map((r) => r.standalone)).toEqual([false, true, false]);
      expect(runs[1].blocks).toEqual([withSpoiler]);
    });

    it('keeps a blockquote carrying a thematic break flowing', () => {
      const source = '> quoted\n>\n> ---';
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const quote: Block = {
        kind: 'blockquote',
        span: { start: 0, end: source.length },
        children: [plainParagraph(source, 'quoted'), rule],
      };
      const runs = segmentRuns(makeDoc(source, [quote]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    // The counterpart to the three inverted tests above: an image is the one
    // block-level construct that still cannot flow, because it projects only
    // its `alt` — flowing it does not degrade the picture, it removes it. This
    // is the assertion that stops a future tidy-up from emptying VIEW_KINDS.
    it('still makes a table carrying an image standalone', () => {
      const source = '| ![alt](img.png) |\n| - |\n| b |';
      const image: ImageNode = {
        kind: 'image',
        src: 'img.png',
        alt: 'alt',
        span: spanOf(source, '![alt](img.png)'),
      };
      const table: TableNode = {
        kind: 'table',
        align: [null],
        span: { start: 0, end: source.length },
        header: {
          kind: 'tableRow',
          span: spanOf(source, '| ![alt](img.png) |'),
          cells: [
            { kind: 'tableCell', span: image.span, children: [image] },
          ],
        },
        rows: [
          {
            kind: 'tableRow',
            span: spanOf(source, '| b |'),
            cells: [
              {
                kind: 'tableCell',
                span: spanOf(source, 'b'),
                children: [textNode(source, 'b')],
              },
            ],
          },
        ],
      };
      const runs = segmentRuns(makeDoc(source, [table]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(true);
    });

    it('keeps a nested list flowing: depth alone is not a standalone reason', () => {
      const source = 'Intro.\n\n- outer\n  - inner';
      const innerSpan = spanOf(source, '- inner');
      const inner: ListNode = {
        kind: 'list',
        ordered: false,
        tight: true,
        span: innerSpan,
        items: [
          {
            kind: 'listItem',
            span: innerSpan,
            children: [plainParagraph(source, 'inner')],
          },
        ],
      };
      const outerSpan = {
        start: spanOf(source, '- outer').start,
        end: innerSpan.end,
      };
      const outer: ListNode = {
        kind: 'list',
        ordered: false,
        tight: true,
        span: outerSpan,
        items: [
          {
            kind: 'listItem',
            span: outerSpan,
            children: [plainParagraph(source, 'outer'), inner],
          },
        ],
      };
      const intro = plainParagraph(source, 'Intro.');
      const runs = segmentRuns(makeDoc(source, [intro, outer]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
      expect(runs[0].blocks).toEqual([intro, outer]);
    });
  });

  describe('classifyBlock seam', () => {
    // The chat-app case: a link with an app-specific scheme renders as a
    // button, so the paragraph carrying it owns a tap target.
    const claimActionLinks: ClassifyBlock = (node) =>
      node.kind === 'link' && node.href.startsWith('copy://')
        ? 'standalone'
        : undefined;

    const source = 'Answer text.\n\n[Copy](copy://msg-1)\n\nFollow-up.';
    const answer = plainParagraph(source, 'Answer text.');
    const link: LinkNode = {
      kind: 'link',
      href: 'copy://msg-1',
      span: spanOf(source, '[Copy](copy://msg-1)'),
      children: [textNode(source, 'Copy')],
    };
    const button: ParagraphNode = {
      kind: 'paragraph',
      span: link.span,
      children: [link],
    };
    const followUp = plainParagraph(source, 'Follow-up.');
    const doc = makeDoc(source, [answer, button, followUp]);

    it('splits the prose run around a claimed inline', () => {
      const runs = segmentRuns(doc, { classifyBlock: claimActionLinks });

      expect(runs).toHaveLength(3);
      expect(runs.map((r) => r.standalone)).toEqual([false, true, false]);
      expect(runs[1].blocks).toEqual([button]);
      expect(runs[1].span).toEqual(button.span);
    });

    it('merges the same document into one run without a classifier', () => {
      const runs = segmentRuns(doc);

      expect(runs).toHaveLength(1);
      expect(runs[0].blocks).toEqual([answer, button, followUp]);
    });

    it('leaves unclaimed nodes to the built-in rules', () => {
      const seen: string[] = [];
      const runs = segmentRuns(doc, {
        classifyBlock: (node) => {
          seen.push(node.kind);
          return undefined;
        },
      });

      expect(runs).toHaveLength(1);
      expect(seen).toContain('link');
    });

    // BOTH DIRECTIONS, and the second one is the one that now carries weight.
    // Code blocks, tables and rules flow by default, so `standalone` is how a
    // consumer buys back a padded box or a real grid — the inverse of the trade
    // this hook used to be for.
    it('lets a flowing claim override a built-in standalone default', () => {
      const image: ImageNode = {
        kind: 'image',
        src: 'img.png',
        alt: 'alt',
        span: spanOf(source, 'Answer'),
      };
      const withImage: ParagraphNode = {
        kind: 'paragraph',
        span: image.span,
        children: [image],
      };

      // An image is the remaining built-in standalone: it projects only `alt`.
      expect(classifyBlock(withImage)).toBe('standalone');
      // The consumer can still override that, and owns the consequence — the
      // image renderer emits a view, which inside a run's text host is exactly
      // what segmentation normally prevents.
      expect(
        classifyBlock(withImage, (node) =>
          node.kind === 'paragraph' ? 'flowing' : undefined,
        ),
      ).toBe('flowing');
    });

    it('lets a standalone claim override a built-in flowing default', () => {
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: 'x\n',
        fenced: true,
        closed: true,
        span: spanOf(source, 'Answer text.'),
      };

      expect(classifyBlock(code)).toBe('flowing');
      expect(
        classifyBlock(code, (node) =>
          node.kind === 'codeBlock' ? 'standalone' : undefined,
        ),
      ).toBe('standalone');
    });

    it('lets a claim on a block win over its standalone contents', () => {
      const image: ImageNode = {
        kind: 'image',
        src: 'img.png',
        alt: 'alt',
        span: spanOf(source, 'Answer text.'),
      };
      const quote: Block = {
        kind: 'blockquote',
        span: image.span,
        children: [
          { kind: 'paragraph', span: image.span, children: [image] },
        ],
      };

      expect(classifyBlock(quote)).toBe('standalone');
      expect(
        classifyBlock(quote, (node) =>
          node.kind === 'blockquote' ? 'flowing' : undefined,
        ),
      ).toBe('flowing');
    });
  });

  describe('streaming (settledUntil)', () => {
    const source = 'Done paragraph.\n\nStreaming tail…';
    const settled = plainParagraph(source, 'Done paragraph.');
    const tail = plainParagraph(source, 'Streaming tail…');
    const doc = makeDoc(source, [settled, tail]);

    it('splits the tail run at the settled boundary instead of merging prose', () => {
      const runs = segmentRuns(doc, { settledUntil: settled.span.end });

      expect(runs).toHaveLength(2);
      expect(runs[0].blocks).toEqual([settled]);
      expect(runs[0].selectable).toBe(true);
      expect(runs[1].blocks).toEqual([tail]);
      expect(runs[1].selectable).toBe(false);
    });

    it('puts a block straddling the boundary into the tail run', () => {
      const runs = segmentRuns(doc, { settledUntil: tail.span.start + 3 });

      expect(runs).toHaveLength(2);
      expect(runs[1].blocks).toEqual([tail]);
      expect(runs[1].selectable).toBe(false);
    });

    it('merges everything once settledUntil covers the whole source', () => {
      const runs = segmentRuns(doc, { settledUntil: source.length });

      expect(runs).toHaveLength(1);
      expect(runs[0].selectable).toBe(true);
      expect(runs[0].blocks).toEqual([settled, tail]);
    });

    it('marks everything unsettled when settledUntil is 0', () => {
      const runs = segmentRuns(doc, { settledUntil: 0 });

      expect(runs).toHaveLength(1);
      expect(runs[0].selectable).toBe(false);
    });

    it('marks an unsettled standalone block unselectable too', () => {
      // An image paragraph, since a code block flows now: the property under
      // test is that the settled boundary applies to standalone runs as well,
      // so it needs a block that is genuinely still standalone.
      const imgSource = 'Done.\n\n![alt](img.png)';
      const done = plainParagraph(imgSource, 'Done.');
      const image: ImageNode = {
        kind: 'image',
        src: 'img.png',
        alt: 'alt',
        span: spanOf(imgSource, '![alt](img.png)'),
      };
      const withImage: ParagraphNode = {
        kind: 'paragraph',
        span: image.span,
        children: [image],
      };
      const runs = segmentRuns(makeDoc(imgSource, [done, withImage]), {
        settledUntil: done.span.end,
      });

      expect(runs).toHaveLength(2);
      expect(runs[1].standalone).toBe(true);
      expect(runs[1].selectable).toBe(false);
    });
  });

});
