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

  // A BLOCK THAT PROJECTS NO TEXT FLOWS ONLY IN COMPANY. Alone it projects
  // the empty string — no text of its own, and separators exist only between
  // blocks — and the native hosts measure empty text to a 0×0 box and skip
  // decoration drawing, so such a run would silently vanish.
  //
  // The rule is not about thematic breaks, and the cases are not
  // pathological: '```', '```py\n' and '> ' are all ordinary STREAMING
  // PREFIXES, so a message that opens with a code fence or a quote used to
  // draw a 0×0 host until its first character of content arrived. These pin
  // the standalone fallback that keeps every one of them visible.
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
      // '```py\n' arriving from a stream: the fence is open and not one
      // character of code has landed, so the projection is the empty string
      // — and worse than the rule's case, an empty `codeBlock` mark is
      // dropped when it closes, so there is not even a zero-length mark for
      // the view layer to draw a box around.
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
      // The emptiness is two levels down, which is why the test is a walk
      // and not a `kind === 'thematicBreak'` check on the top-level block.
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
      // THE DEMOTION IS ABOUT THE WHOLE GROUP, NOT THE BLOCK. One paragraph
      // is text enough for the host to lay out, so breaking the run here
      // would cost the sweep and buy nothing — the empty block still draws no
      // box (an empty range leaves no mark to decorate), but it is no longer
      // a hole where the run should be.
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
      // The frame after the fence prefix: as soon as the stream delivers a
      // character, the block projects text again and rejoins the sweep.
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
      // Every item projects its bullet glyph, so the run has characters to
      // lay out even when no item has content of its own.
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
      // Infinity is here because it is the one that used to get through:
      // `Infinity > 0` is true, so an infinite reservation reached the hosts
      // and saturated a CGRect / a ReplacementSpan width.
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
      expect(withLookup).toEqual(segmentRuns(doc));
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
      // The exemption is not special-cased per kind: it lives in the
      // projects-text test, which counts an embed's U+FFFC placeholder as
      // the character it is.
      const fenceSource = '```\n```';
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        literal: '',
        fenced: true,
        closed: true,
        span: { start: 0, end: fenceSource.length },
      };
      const fenceDoc = makeDoc(fenceSource, [code]);

      // Unclaimed, an empty fence demotes (an empty run cannot draw)…
      expect(segmentRuns(fenceDoc)[0].standalone).toBe(true);
      // …embedded, it projects a placeholder character, so it may flow.
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

/**
 * NESTING DEPTH IS UNTRUSTED INPUT, and segmentation is the first walk that
 * sees it: `classifyTopLevelBlock` asks whether a prose block holds anything
 * that cannot live in a run's text tree, and answering means descending the whole
 * subtree. Five kilobytes of `'> '` is 2500 levels, which used to overflow
 * the JS stack right here — before any of the document reached the screen.
 * The tree is hand-built, so the test needs no parser.
 */
describe('unbounded nesting depth', () => {
  const DEPTH = 20_000;

  it('walks to the bottom of a 20000-deep block without overflowing', () => {
    // An image at the very bottom is the worst case: it is a view kind, so
    // the walk cannot stop early — it has to reach the last level to find the
    // thing that makes the whole stack standalone.
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
    // The top-level block, every nested blockquote, the paragraph and its
    // text node — the same nodes the recursive walk visited.
    expect(seen).toBe(DEPTH + 2);
  });
});

/**
 * A document of `count` paragraphs, each `width` characters wide, separated by
 * blank lines. Spans are computed rather than searched, so the paragraphs need
 * not be unique and a 200-block document costs nothing to build — `plainParagraph`
 * locates its span with `indexOf`, which cannot express repeated prose.
 */
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

/**
 * THE COST OF SEGMENTING A DOCUMENT THAT MOSTLY DID NOT CHANGE.
 *
 * `segmentRuns` runs on every streamed snapshot (the view's memo keys on the
 * snapshot's document object, which is new per delta) and classifying a prose
 * block descends its whole subtree. Unmemoized that is an O(document nodes)
 * walk per token — quadratic over a message, and measured at the same order as
 * the entire parse+decode+append path it sits behind. Settled blocks are the
 * SAME OBJECTS on every later snapshot, which is what makes the memo in
 * `classifyTopLevelBlock` both possible and exact.
 */
describe('classification memo', () => {
  /** A `ClassifyBlock` that claims nothing and counts what it was offered. */
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

    // One "delta" per block: the document grows by one block, every earlier
    // block is the same object, and only the new one may be walked.
    for (let count = 1; count <= doc.blocks.length; count += 1) {
      const before = visits();
      segmentRuns(makeDoc(doc.source, doc.blocks.slice(0, count)), {
        classifyBlock: classify,
        settledUntil: doc.blocks[count - 1].span.end,
      });
      perDelta.push(visits() - before);
    }

    // Flat, not merely sublinear: a paragraph is offered as itself, its text
    // node, and nothing else, however long the document in front of it is.
    expect(new Set(perDelta.slice(1)).size).toBe(1);
    expect(perDelta[perDelta.length - 1]).toBe(perDelta[1]);
    expect(perDelta.reduce((a, b) => a + b, 0)).toBeLessThan(
      doc.blocks.length * 4,
    );
  });

  it('re-walks when the classifyBlock identity changes', () => {
    const doc = proseDocument(10, 40);
    const first = counting();
    const second = counting();

    segmentRuns(doc, { classifyBlock: first.classify });
    segmentRuns(doc, { classifyBlock: second.classify });

    expect(second.visits()).toBe(first.visits());
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

    // An image makes its paragraph standalone…
    expect(segmentRuns(doc)).toHaveLength(2);
    // …unless a lookup claims it, and the memo must not answer for the first
    // call when the second passes a different lookup.
    const claim: EmbedLookup = (node) =>
      node.kind === 'image' ? { width: 40, height: 40 } : undefined;
    expect(segmentRuns(doc, { embed: claim })).toHaveLength(1);
    expect(segmentRuns(doc)).toHaveLength(2);
  });
});

/**
 * THE RUN-SIZE BUDGET. A run is one native text host, and the host re-measures
 * everything it holds each time the run grows — so with no cap a message is one
 * run and settling costs O(message) native layout per settle. The cap trades a
 * selection boundary (a sweep cannot cross hosts) for a bound on that, which is
 * why the default sits far above the length of anything anyone sweeps across.
 *
 * The property that matters as much as the cap itself is STABILITY: the packing
 * is greedy from the start of the document and depends only on blocks already
 * placed, so a boundary, once chosen, never moves. A boundary that moved would
 * change a run's `run:${span.start}` key mid-stream — a remount under a live
 * selection — and invalidate the incremental projection filed under it.
 */
describe('run-size budget', () => {
  it('splits a long flowing sequence into several runs', () => {
    const doc = proseDocument(40, 100);
    const runs = segmentRuns(doc, { maxRunChars: 500 });

    expect(runs.length).toBeGreaterThan(4);
    for (const run of runs) {
      expect(run.standalone).toBe(false);
      expect(run.span.end - run.span.start).toBeLessThanOrEqual(500);
    }
    // Every block still lands in exactly one run, in order.
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

      // The previous tick's boundaries are still boundaries: the last run may
      // have grown, and a new one may have opened, but nothing moved.
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
    // ~4 kB, longer than the shipped transcript fixtures and still half the
    // default cap: nothing about a normal answer's selection changes.
    const doc = proseDocument(40, 100);

    expect(segmentRuns(doc)).toHaveLength(1);
  });

  it('treats Infinity as the documented opt-out, and rejects nonsense', () => {
    const doc = proseDocument(400, 100);

    expect(segmentRuns(doc, { maxRunChars: Infinity })).toHaveLength(1);
    // 0, negatives and NaN fall back to the default rather than producing one
    // run per block.
    const zero = segmentRuns(doc, { maxRunChars: 0 });
    expect(zero).toEqual(segmentRuns(doc));
    expect(zero.length).toBeGreaterThan(1);
    expect(segmentRuns(doc, { maxRunChars: Number.NaN })).toEqual(zero);
  });
});

/**
 * THE LIVE TAIL, which is a run-boundary rule and not a settledness one.
 *
 * A stream settles at completed blank lines, so a chunk that ends on one
 * leaves nothing unsettled — every block frozen, `settledUntil` at the end of
 * the source — for as long as the next chunk takes to arrive. The settled/tail
 * break has nothing to break at, so the document collapses to one run and the
 * view's tail host (holding whatever the reader had selected in the last
 * paragraph) is unmounted and recycled. `liveTail` keeps the last block in a
 * run of its own across that window, so the boundary stays exactly where the
 * previous frame put it.
 */
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
    // Both halves are settled, because they are: this is a boundary, not a
    // claim that the text is still being repaired. Marking the tail unsettled
    // would make the last paragraph unselectable on Android for the whole
    // window.
    expect(kept.map((run) => run.selectable)).toEqual([true, true]);
    expect(kept.flatMap((run) => run.blocks)).toEqual(doc.blocks);
  });

  it('puts the boundary exactly where the unsettled frame had it', () => {
    // The frame before the collapse and the collapse frame must segment the
    // same way, or a host is handed different text (or destroyed) for a change
    // the reader never made.
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
    for (const settledUntil of doc.blocks.slice(0, -1).map((b) => b.span.end)) {
      expect(segmentRuns(doc, { settledUntil, liveTail: true })).toEqual(
        segmentRuns(doc, { settledUntil }),
      );
    }
  });

  it('leaves a one-block document, and a standalone last run, alone', () => {
    // Nothing to peel: a single block cannot be both the settled prefix and
    // the tail, and the first split is deliberately the one place the settled
    // host wins (see `runKey`).
    const single = proseDocument(1, 100);
    expect(
      segmentRuns(single, { settledUntil: single.source.length, liveTail: true }),
    ).toEqual(segmentRuns(single, { settledUntil: single.source.length }));

    // A standalone block at the end is already its own run.
    const standalone = classifiedDocument();
    expect(
      segmentRuns(standalone, {
        settledUntil: standalone.source.length,
        liveTail: true,
        classifyBlock: (node) => (node === standalone.blocks[2] ? 'standalone' : undefined),
      }),
    ).toEqual(
      segmentRuns(standalone, {
        settledUntil: standalone.source.length,
        classifyBlock: (node) => (node === standalone.blocks[2] ? 'standalone' : undefined),
      }),
    );
  });
});

/** Three paragraphs, so a test can claim the last one standalone. */
function classifiedDocument(): ParsedDocument {
  return proseDocument(3, 40);
}
