import type {
  Block,
  CodeBlockNode,
  HeadingNode,
  ImageNode,
  LinkNode,
  ListNode,
  ParagraphNode,
  ParsedDocument,
  SpoilerNode,
  TableNode,
  ThematicBreakNode,
} from '../../document/nodes';
import { classifyTopLevelBlock, segmentRuns } from '../runs';
import type { ClassifyBlock, EmbedLookup } from '../runs';
import { makeDoc, plainParagraph, spanOf, textNode } from './fixtures';

describe('segmentRuns', () => {
  it('returns no runs for an empty document', () => {
    expect(segmentRuns(makeDoc('', []))).toEqual([]);
    expect(segmentRuns(makeDoc('a', [plainParagraph('a', 'a')]))).toHaveLength(1);
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

  describe('blocks that project no text', () => {
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

    it('makes an unfinished code fence standalone', () => {
      const source = '```py\n';
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        language: 'py',
        literal: '',
        fenced: true,
        closed: false,
        span: { start: 0, end: source.length },
      };
      const runs = segmentRuns(makeDoc(source, [code]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(true);
      expect(runs[0].blocks).toEqual([code]);
    });

    it('makes a blockquote holding nothing but a rule standalone', () => {
      const source = '> ***\n';
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '***'),
      };
      const quote: Block = {
        kind: 'blockquote',
        span: { start: 0, end: source.length },
        children: [rule],
      };
      const runs = segmentRuns(makeDoc(source, [quote]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(true);
      expect(runs[0].blocks).toEqual([quote]);
    });

    it('makes the bare "> " prefix of a streaming quote standalone', () => {
      const source = '> ';
      const quote: Block = {
        kind: 'blockquote',
        span: { start: 0, end: source.length },
        children: [],
      };
      const runs = segmentRuns(makeDoc(source, [quote]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(true);
    });

    it('splits a mixed blank stretch into one standalone run per block', () => {
      const source = '---\n\n```\n```';
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(source, '---'),
      };
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: '',
        fenced: true,
        closed: true,
        span: spanOf(source, '```\n```'),
      };
      const runs = segmentRuns(makeDoc(source, [rule, code]));

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.standalone)).toEqual([true, true]);
      expect(runs.map((r) => r.blocks)).toEqual([[rule], [code]]);
    });

    it('keeps an empty code fence flowing when a neighbour carries the text', () => {
      const source = 'Intro.\n\n```\n```';
      const intro = plainParagraph(source, 'Intro.');
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: '',
        fenced: true,
        closed: true,
        span: spanOf(source, '```\n```'),
      };
      const runs = segmentRuns(makeDoc(source, [intro, code]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
      expect(runs[0].blocks).toEqual([intro, code]);
    });

    it('keeps a code fence with one character of content flowing', () => {
      const source = '```py\nx';
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        language: 'py',
        literal: 'x',
        fenced: true,
        closed: false,
        span: { start: 0, end: source.length },
      };
      const runs = segmentRuns(makeDoc(source, [code]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    it('keeps a list of empty items flowing: the markers are text', () => {
      const source = '-\n-';
      const list: ListNode = {
        kind: 'list',
        ordered: false,
        tight: true,
        span: { start: 0, end: source.length },
        items: [
          { kind: 'listItem', span: { start: 0, end: 1 }, children: [] },
          { kind: 'listItem', span: { start: 2, end: 3 }, children: [] },
        ],
      };
      const runs = segmentRuns(makeDoc(source, [list]));

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
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
      expect(classifyTopLevelBlock(withImage)).toBe('standalone');
      // The consumer can still override that, and owns the consequence — the
      // image renderer emits a view, which inside a run's text host is exactly
      // what segmentation normally prevents.
      expect(
        classifyTopLevelBlock(withImage, (node) =>
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

      expect(classifyTopLevelBlock(code)).toBe('flowing');
      expect(
        classifyTopLevelBlock(code, (node) =>
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

      expect(classifyTopLevelBlock(quote)).toBe('standalone');
      expect(
        classifyTopLevelBlock(quote, (node) =>
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

  describe('embed seam', () => {
    // The chat-app case the seam exists for: a blocked citation link renders
    // as a card, and the card must FLOW so a selection sweeps across it —
    // the inverse of the classifyBlock claim, which ends the run.
    const claimCitations: EmbedLookup = (node) =>
      node.kind === 'link' && node.href.startsWith('cite://')
        ? { width: 200, height: 80 }
        : undefined;

    const source = 'Answer text.\n\n[1](cite://a)\n\nFollow-up.';
    const answer = plainParagraph(source, 'Answer text.');
    const link: LinkNode = {
      kind: 'link',
      href: 'cite://a',
      blocked: true,
      span: spanOf(source, '[1](cite://a)'),
      children: [textNode(source, '1')],
    };
    const card: ParagraphNode = {
      kind: 'paragraph',
      span: link.span,
      children: [link],
    };
    const followUp = plainParagraph(source, 'Follow-up.');
    const doc = makeDoc(source, [answer, card, followUp]);

    it('keeps a run whole across an embedded inline', () => {
      const runs = segmentRuns(doc, { embed: claimCitations });

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
      expect(runs[0].blocks).toEqual([answer, card, followUp]);
    });

    it('keeps a run whole across an embedded image — the claim beats VIEW_KINDS', () => {
      const imgSource = 'Before.\n\n![alt](img.png)\n\nAfter.';
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
      const imgDoc = makeDoc(imgSource, [
        plainParagraph(imgSource, 'Before.'),
        withImage,
        plainParagraph(imgSource, 'After.'),
      ]);

      // Unclaimed, the image forces its paragraph standalone…
      expect(segmentRuns(imgDoc)).toHaveLength(3);
      // …claimed as an embed, everything flows.
      const runs = segmentRuns(imgDoc, {
        embed: (node) =>
          node.kind === 'image' ? { width: 120, height: 90 } : undefined,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    it('wins over a conflicting classifyBlock claim on the same node', () => {
      const runs = segmentRuns(doc, {
        embed: claimCitations,
        classifyBlock: (node) =>
          node.kind === 'link' ? 'standalone' : undefined,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    it('never embeds synthetic or incomplete nodes', () => {
      const incomplete: LinkNode = { ...link, incomplete: true };
      const withIncomplete: ParagraphNode = {
        kind: 'paragraph',
        span: incomplete.span,
        children: [incomplete],
      };
      // An incomplete node falls through the embed claim to the normal rules,
      // under which a link-bearing paragraph flows anyway — so the property
      // observable here is via classifyBlock precedence: with the embed claim
      // inert, a standalone classifyBlock claim on the link stands.
      const runs = segmentRuns(makeDoc(source, [answer, withIncomplete, followUp]), {
        embed: claimCitations,
        classifyBlock: (node) =>
          node.kind === 'link' ? 'standalone' : undefined,
      });
      expect(runs).toHaveLength(3);
      expect(runs[1].standalone).toBe(true);
    });

    it('rejects every size that is not positive and finite', () => {
      // Each of these is inert as a claim, so the standalone `classifyBlock`
      // claim on the same link decides and the document stays three runs.
      const sizes: { width: number; height: number }[] = [
        { width: 0, height: 80 },
        { width: -10, height: 80 },
        { width: 200, height: 0 },
        { width: Number.NaN, height: 80 },
        { width: 200, height: Number.NaN },
        { width: Number.POSITIVE_INFINITY, height: 80 },
        { width: 200, height: Number.POSITIVE_INFINITY },
        { width: Number.NEGATIVE_INFINITY, height: 80 },
      ];
      for (const size of sizes) {
        const runs = segmentRuns(doc, {
          embed: (node) => (node.kind === 'link' ? size : undefined),
          classifyBlock: (node) =>
            node.kind === 'link' ? 'standalone' : undefined,
        });
        expect({ size, runs: runs.length }).toEqual({ size, runs: 3 });
      }
    });

    it('behaves byte-identically to today when nothing is claimed', () => {
      const withLookup = segmentRuns(doc, { embed: () => undefined });
      expect(withLookup).toEqual([
        {
          span: { start: 0, end: source.length },
          blocks: [answer, card, followUp],
          selectable: true,
          standalone: false,
        },
      ]);
    });

    it('still splits at the settled boundary', () => {
      const runs = segmentRuns(doc, {
        embed: claimCitations,
        settledUntil: answer.span.end,
      });

      expect(runs).toHaveLength(2);
      expect(runs[0].blocks).toEqual([answer]);
      expect(runs[1].selectable).toBe(false);
    });

    it('does not demote an embedded lone thematic break to standalone', () => {
      const hrSource = '---';
      const rule: ThematicBreakNode = {
        kind: 'thematicBreak',
        span: spanOf(hrSource, '---'),
      };
      const hrDoc = makeDoc(hrSource, [rule]);

      // Unclaimed, a lone rule demotes (an empty run cannot draw)…
      expect(segmentRuns(hrDoc)[0].standalone).toBe(true);
      // …embedded, it projects a placeholder character, so it may flow.
      const runs = segmentRuns(hrDoc, {
        embed: (node) =>
          node.kind === 'thematicBreak'
            ? { width: 300, height: 40 }
            : undefined,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    it('does not demote an embedded empty code fence to standalone', () => {
      const fenceSource = '```\n```';
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: '',
        fenced: true,
        closed: true,
        span: { start: 0, end: fenceSource.length },
      };
      const fenceDoc = makeDoc(fenceSource, [code]);

      expect(segmentRuns(fenceDoc)[0].standalone).toBe(true);
      const runs = segmentRuns(fenceDoc, {
        embed: (node) =>
          node.kind === 'codeBlock' ? { width: 300, height: 40 } : undefined,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });

    it('offers topLevel only for direct children of the document', () => {
      // A wide-code-block claim sized against the column width must be able
      // to decline a nested instance: the native hosts do not clamp declared
      // width against leading margins, so a full-width reservation inside a
      // list item would overflow. `context.topLevel` is that signal.
      const codeSource = '```\nwide\n```\n\n- item';
      const topCode: CodeBlockNode = {
        kind: 'codeBlock',
        literal: 'wide\n',
        fenced: true,
        closed: true,
        span: spanOf(codeSource, '```\nwide\n```'),
      };
      const nestedCode: CodeBlockNode = {
        ...topCode,
        span: spanOf(codeSource, 'item'),
      };
      const list: ListNode = {
        kind: 'list',
        ordered: false,
        tight: true,
        span: spanOf(codeSource, '- item'),
        items: [
          {
            kind: 'listItem',
            span: spanOf(codeSource, '- item'),
            children: [nestedCode],
          },
        ],
      };
      const codeDoc = makeDoc(codeSource, [topCode, list]);

      const offers: { kind: string; topLevel: boolean }[] = [];
      const claimWideCode: EmbedLookup = (node, context) => {
        if (node.kind !== 'codeBlock') return undefined;
        offers.push({ kind: node.kind, topLevel: context.topLevel });
        return context.topLevel ? { width: 320, height: 60 } : undefined;
      };

      const runs = segmentRuns(codeDoc, { embed: claimWideCode });

      // The top-level block was offered as such and claimed (it flows with
      // the list); the nested one was offered nested and declined.
      expect(offers).toContainEqual({ kind: 'codeBlock', topLevel: true });
      expect(offers).toContainEqual({ kind: 'codeBlock', topLevel: false });
      expect(offers.some((offer) => offer.topLevel)).toBe(true);
      expect(runs).toHaveLength(1);
      expect(runs[0].standalone).toBe(false);
    });
  });
});

describe('unbounded nesting depth', () => {
  const DEPTH = 20_000;

  it('walks to the bottom of a 20000-deep block without overflowing', () => {
    // An image at the bottom forces the walk to reach the last level.
    const source = '> '.repeat(DEPTH) + '![alt](img.png)';
    const span = { start: DEPTH * 2, end: source.length };
    const image: ImageNode = { kind: 'image', src: 'img.png', alt: 'alt', span };
    let block: Block = { kind: 'paragraph', span, children: [image] };
    for (let level = DEPTH - 1; level >= 0; level -= 1) {
      block = {
        kind: 'blockquote',
        span: { start: level * 2, end: source.length },
        children: [block],
      };
    }

    const runs = segmentRuns(makeDoc(source, [block]));

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(true);
  });

  it('offers every level to classifyBlock, outermost first', () => {
    const source = '> '.repeat(DEPTH) + 'echo';
    const span = { start: DEPTH * 2, end: source.length };
    let block: Block = {
      kind: 'paragraph',
      span,
      children: [textNode(source, 'echo')],
    };
    for (let level = DEPTH - 1; level >= 0; level -= 1) {
      block = {
        kind: 'blockquote',
        span: { start: level * 2, end: source.length },
        children: [block],
      };
    }

    let seen = 0;
    const count: ClassifyBlock = () => {
      seen += 1;
      return undefined;
    };
    const runs = segmentRuns(makeDoc(source, [block]), { classifyBlock: count });

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
    // The top-level block, every nested blockquote, the paragraph and its text node.
    expect(seen).toBe(DEPTH + 2);
  });
});

function proseDocument(count: number, width: number): ParsedDocument {
  let source = '';
  const blocks: Block[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      source += '\n\n';
    }
    const value = `${String(index).padStart(4, '0')}${'x'.repeat(width - 4)}`;
    const span = { start: source.length, end: source.length + value.length };
    source += value;
    blocks.push({
      kind: 'paragraph',
      span,
      children: [{ kind: 'text', value, span }],
    });
  }
  return makeDoc(source, blocks);
}

describe('classification memo', () => {
  function counting(): { classify: ClassifyBlock; visits: () => number } {
    let seen = 0;
    return {
      classify: () => {
        seen += 1;
        return undefined;
      },
      visits: () => seen,
    };
  }

  it('re-segments the same blocks without walking them again', () => {
    const doc = proseDocument(40, 60);
    const { classify, visits } = counting();

    segmentRuns(doc, { classifyBlock: classify });
    const first = visits();
    segmentRuns(doc, { classifyBlock: classify });

    expect(first).toBeGreaterThan(40);
    expect(visits()).toBe(first);
  });

  it('keeps per-delta work flat as the settled prefix grows', () => {
    const doc = proseDocument(60, 60);
    const { classify, visits } = counting();
    const perDelta: number[] = [];

    for (let count = 1; count <= doc.blocks.length; count += 1) {
      const before = visits();
      segmentRuns(makeDoc(doc.source, doc.blocks.slice(0, count)), {
        classifyBlock: classify,
        settledUntil: doc.blocks[count - 1].span.end,
      });
      perDelta.push(visits() - before);
    }

    // Each new paragraph is offered as itself and its text node, and nothing else.
    expect(perDelta).toEqual(new Array(doc.blocks.length).fill(2));
  });

  it('re-walks when the classifyBlock identity changes', () => {
    const doc = proseDocument(10, 40);
    const first = counting();
    const second = counting();

    segmentRuns(doc, { classifyBlock: first.classify });
    segmentRuns(doc, { classifyBlock: second.classify });

    // Ten paragraphs, each offered as itself and its text node.
    expect(first.visits()).toBe(20);
    expect(second.visits()).toBe(20);
  });

  it('re-walks when the embed identity changes, and can change the answer', () => {
    const source = 'Alpha.\n\n![alt](img.png)';
    const intro = plainParagraph(source, 'Alpha.');
    const image: ImageNode = {
      kind: 'image',
      src: 'img.png',
      alt: 'alt',
      span: spanOf(source, '![alt](img.png)'),
    };
    const block: ParagraphNode = {
      kind: 'paragraph',
      span: image.span,
      children: [image],
    };
    const doc = makeDoc(source, [intro, block]);

    expect(segmentRuns(doc)).toHaveLength(2);
    const claim: EmbedLookup = (node) =>
      node.kind === 'image' ? { width: 40, height: 40 } : undefined;
    expect(segmentRuns(doc, { embed: claim })).toHaveLength(1);
    expect(segmentRuns(doc)).toHaveLength(2);
  });
});

describe('run-size budget', () => {
  it('splits a long flowing sequence into several runs', () => {
    const doc = proseDocument(40, 100);
    const runs = segmentRuns(doc, { maxRunChars: 500 });

    expect(runs.length).toBeGreaterThan(4);
    for (const run of runs) {
      expect(run.standalone).toBe(false);
      expect(run.span.end - run.span.start).toBeLessThanOrEqual(500);
    }
    expect(runs.flatMap((run) => run.blocks)).toEqual(doc.blocks);
  });

  it('keeps every boundary put as the document grows', () => {
    const doc = proseDocument(60, 100);
    let previous: number[] = [];

    for (let count = 1; count <= doc.blocks.length; count += 1) {
      const starts = segmentRuns(makeDoc(doc.source, doc.blocks.slice(0, count)), {
        maxRunChars: 500,
        settledUntil: doc.blocks[count - 1].span.end,
      }).map((run) => run.span.start);

      expect(starts.slice(0, previous.length)).toEqual(previous);
      previous = starts;
    }

    expect(previous.length).toBeGreaterThan(5);
  });

  it('never splits a single block, however far past the budget it is', () => {
    const doc = proseDocument(1, 4000);
    const runs = segmentRuns(doc, { maxRunChars: 100 });

    expect(runs).toHaveLength(1);
    expect(runs[0].blocks).toEqual(doc.blocks);
  });

  it('splits at the settled boundary before the budget applies to the tail', () => {
    const doc = proseDocument(6, 100);
    const settledUntil = doc.blocks[4].span.end;
    const runs = segmentRuns(doc, { maxRunChars: 10_000, settledUntil });

    expect(runs).toHaveLength(2);
    expect(runs[0].selectable).toBe(true);
    expect(runs[1].blocks).toEqual([doc.blocks[5]]);
    expect(runs[1].selectable).toBe(false);
  });

  it('keeps an ordinary message in one run under the default budget', () => {
    // ~4 kB: longer than the shipped transcript fixtures, half the default cap.
    const doc = proseDocument(40, 100);

    expect(segmentRuns(doc)).toHaveLength(1);
  });

  it('treats Infinity as the documented opt-out, and rejects nonsense', () => {
    const doc = proseDocument(400, 100);

    expect(segmentRuns(doc, { maxRunChars: Infinity })).toHaveLength(1);
    const zero = segmentRuns(doc, { maxRunChars: 0 });
    expect(zero).toEqual(segmentRuns(doc));
    expect(zero.length).toBeGreaterThan(1);
    expect(segmentRuns(doc, { maxRunChars: Number.NaN })).toEqual(zero);
  });
});

describe('live tail', () => {
  it('keeps the last block in its own run when everything has settled', () => {
    const doc = proseDocument(5, 100);
    const everythingSettled = doc.source.length;

    const collapsed = segmentRuns(doc, { settledUntil: everythingSettled });
    expect(collapsed).toHaveLength(1);

    const kept = segmentRuns(doc, {
      settledUntil: everythingSettled,
      liveTail: true,
    });
    expect(kept).toHaveLength(2);
    expect(kept[0].blocks).toEqual(doc.blocks.slice(0, 4));
    expect(kept[1].blocks).toEqual([doc.blocks[4]]);
    // An unsettled tail would make the last paragraph unselectable on Android.
    expect(kept.map((run) => run.selectable)).toEqual([true, true]);
    expect(kept.flatMap((run) => run.blocks)).toEqual(doc.blocks);
  });

  it('puts the boundary exactly where the unsettled frame had it', () => {
    const doc = proseDocument(5, 100);
    const beforeCollapse = segmentRuns(doc, {
      settledUntil: doc.blocks[3].span.end,
      liveTail: true,
    });
    const collapsed = segmentRuns(doc, {
      settledUntil: doc.source.length,
      liveTail: true,
    });

    expect(collapsed.map((run) => run.span)).toEqual(
      beforeCollapse.map((run) => run.span),
    );
  });

  it('changes nothing while the tail is genuinely unsettled', () => {
    const doc = proseDocument(5, 100);
    for (let settled = 1; settled < doc.blocks.length; settled += 1) {
      const settledUntil = doc.blocks[settled - 1].span.end;
      const runs = segmentRuns(doc, { settledUntil, liveTail: true });
      expect(runs.map((run) => [run.blocks.length, run.selectable])).toEqual([
        [settled, true],
        [doc.blocks.length - settled, false],
      ]);
      expect(runs.map((run) => run.span)).toEqual([
        { start: 0, end: settledUntil },
        { start: doc.blocks[settled].span.start, end: doc.source.length },
      ]);
      expect(runs).toEqual(segmentRuns(doc, { settledUntil }));
    }
  });

  it('leaves a one-block document, and a standalone last run, alone', () => {
    const single = proseDocument(1, 100);
    expect(
      segmentRuns(single, { settledUntil: single.source.length, liveTail: true }),
    ).toEqual([
      {
        span: { start: 0, end: 100 },
        blocks: single.blocks,
        selectable: true,
        standalone: false,
      },
    ]);

    const standalone = classifiedDocument();
    expect(
      segmentRuns(standalone, {
        settledUntil: standalone.source.length,
        liveTail: true,
        classifyBlock: (node) => (node === standalone.blocks[2] ? 'standalone' : undefined),
      }),
    ).toEqual([
      {
        span: { start: 0, end: 82 },
        blocks: standalone.blocks.slice(0, 2),
        selectable: true,
        standalone: false,
      },
      {
        span: { start: 84, end: 124 },
        blocks: [standalone.blocks[2]],
        selectable: true,
        standalone: true,
      },
    ]);
  });
});

function classifiedDocument(): ParsedDocument {
  return proseDocument(3, 40);
}

test('growing an unsettled paragraph preserves its run boundary', () => {
  for (const source of ['one\n\ntwo', 'one\n\ntwo long']) {
    const second = source.slice(5);
    const doc = makeDoc(source, [plainParagraph(source, 'one'), plainParagraph(source, second)]);
    expect(segmentRuns(doc, { settledUntil: 0, maxRunChars: 10 })).toHaveLength(1);
  }
});

test('independent classifier identities retain their own cached results', () => {
  const block = plainParagraph('one', 'one');
  const first = jest.fn(() => 'flowing' as const);
  const second = jest.fn(() => 'standalone' as const);
  for (let i = 0; i < 3; i++) {
    expect(classifyTopLevelBlock(block, first)).toBe('flowing');
    expect(classifyTopLevelBlock(block, second)).toBe('standalone');
  }
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
