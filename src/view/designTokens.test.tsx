/**
 * Theme tokens and props that restore a designed document on both paths:
 * block spacing, per-level headings, list markers, tables, link decoration,
 * pressable presentation, highlights, font scaling, soft breaks and images.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: Object.assign('Image', { getSize: jest.fn() }),
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
  StyleSheet: { flatten: (style: unknown) => style },
  useColorScheme: () => 'light',
  UIManager: { hasViewManagerConfig: () => true },
  processColor: (color: unknown) => color,
  Linking: { openURL: jest.fn() },
  ScrollView: 'ScrollView',
  NativeModules: { SelectableMarkdown: { copyText: jest.fn() } },
}));

jest.mock('./SelectableRunHostNativeComponent', () => {
  const react = require('react') as typeof React;
  const Native = react.forwardRef((props: Record<string, unknown>, _ref) =>
    react.createElement('NativeRunHost', props),
  );
  return { __esModule: true, default: Native, Commands: { setSelection: () => {}, clearSelection: () => {} } };
});

import { parseDocument } from '../engine/Engine';
import { presets } from '../engine/options';
import { describeNative, linkNativeEngineAsDefault } from '../engine/native/__tests__/support';
import { mapSelectionToSource, projectRun } from '../selection/mapSelection';
import { extractLinks } from '../engine/links';
import type { ProjectedRun, ProjectRunOptions } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import { StreamSession } from '../stream/StreamSession';
import { resolveRunSpacing } from './blockSpacing';
import { withImageEmbeds, withoutImages } from './imageEmbeds';
import { resolveRunAttributes } from './runAttributes';
import type { RunTextAttribute } from './runAttributes';
import { hiddenHeaderLines, resolveRunDecorations } from './runDecorations';
import { presentPressables, queryRanges, resolveChips, resolveRunHighlights } from './runPresentation';
import { resolveRunPressables } from './runPressables';
import { SelectableMarkdown } from './SelectableMarkdown';
import type { InlineLinkPress } from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { defaultTheme, headingStyle, mergeTheme } from './theme';
import type { PartialTheme } from './theme';

linkNativeEngineAsDefault();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function project(source: string, options?: ProjectRunOptions): ProjectedRun {
  const doc = parseDocument(source, presets.everything);
  const run = segmentRuns(doc).find((r) => !r.standalone);
  if (!run) throw new Error(`no prose run in ${JSON.stringify(source)}`);
  return projectRun(run, doc, options);
}

const theme = (overrides: PartialTheme) => mergeTheme(overrides);

function lineAt(attributes: readonly RunTextAttribute[], at: number): number | undefined {
  return attributes.find((a) => a.start === at && a.end === at + 1)?.lineHeight;
}

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(() => tree?.unmount());
  tree = undefined;
});

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  await act(() => {
    tree = create(element);
  });
  return tree!;
}

function hosts(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => (node.type as unknown) === 'NativeRunHost');
}

describeNative('block spacing', () => {
  const spaced = theme({
    blocks: {
      paragraph: { before: 10, after: 10 },
      heading: { before: 4, after: 2 },
      code: { before: 0, after: 0 },
      rule: { before: 16, after: 16 },
    },
  });

  test('records the run blocks only when asked', () => {
    expect(project('One\n\nTwo\n').blocks).toBeUndefined();
    const blocks = project('# Title\n\n- a\n- b\n', { recordBlocks: true }).blocks;
    expect(blocks?.map((b) => [b.kind, b.parent])).toEqual([
      ['heading', -1],
      ['list', -1],
      ['listItem', 1],
      ['paragraph', 2],
      ['listItem', 1],
      ['paragraph', 4],
    ]);
  });

  test('an unmanaged theme leaves the blank lines alone', () => {
    const projected = project('One\n\nTwo\n', { recordBlocks: true });
    expect(resolveRunSpacing(projected, defaultTheme)).toEqual({ attributes: [], decorations: [] });
  });

  test('sizes each separator blank line to the collapsed margin', () => {
    const projected = project('# Title\n\nBody\n\nMore\n', { recordBlocks: true });
    const { attributes } = resolveRunSpacing(projected, spaced);
    const title = projected.text.indexOf('Title') + 'Title'.length;
    // max(heading.after 2, paragraph.before 10)
    expect(lineAt(attributes, title + 1)).toBe(10);
    const body = projected.text.indexOf('Body') + 'Body'.length;
    expect(lineAt(attributes, body + 1)).toBe(10);
  });

  test('a box paints its padding into the blank line, outside the margin', () => {
    const projected = project('Body\n\n```\ncode\n```\n', { recordBlocks: true });
    const { attributes } = resolveRunSpacing(projected, spaced);
    const at = projected.text.indexOf('Body') + 4 + 1;
    expect(lineAt(attributes, at)).toBe(10 + spaced.code.paddingVertical);
  });

  test('a rule gets a hairline of its own between two margins', () => {
    const projected = project('Above\n\n---\n\nBelow\n', { recordBlocks: true });
    const { attributes } = resolveRunSpacing(projected, spaced);
    const rule = projected.marks.find((m) => m.kind === 'thematicBreak')!;
    expect(lineAt(attributes, rule.start - 1)).toBe(16);
    expect(lineAt(attributes, rule.start)).toBe(spaced.rule.thickness);
    expect(lineAt(attributes, rule.start + 1)).toBe(16);
  });

  test('list items get paragraph spacing, deduplicated per paragraph end', () => {
    const projected = project('- a\n- b\n  - c\n- d\n', { recordBlocks: true });
    const { decorations } = resolveRunSpacing(projected, theme({ list: { itemGap: 8 } }));
    expect(decorations.every((d) => d.kind === 'spacing' && d.paddingBottom === 8)).toBe(true);
    const ends = decorations.map((d) => d.end);
    expect(new Set(ends).size).toBe(ends.length);
    // Not after the last item: nothing follows it in the run.
    expect(ends).not.toContain(projected.text.length);
  });

  test('the component sets run gaps and the first-block lead from the margins', async () => {
    const renderer = await render(
      <SelectableMarkdown
        classifyBlock={(node) => (node.kind === 'codeBlock' ? 'standalone' : undefined)}
        source={'# Title\n\n```\ncode\n```\n\nAfter\n'}
        theme={{ blocks: { heading: { before: 30, after: 6 }, code: { before: 12, after: 4 }, firstBlockLead: true } }}
      />,
    );
    const runs = renderer.root.findAll(
      (node) => (node.type as unknown) === 'View' && node.props.style?.marginBottom !== undefined,
    );
    expect(runs[0].props.style).toMatchObject({ marginTop: 30, marginBottom: 12 });
    expect(runs[1].props.style.marginBottom).toBe(4);
  });

  test('a firstBlockLead list leads only the kinds it names', async () => {
    const leadOf = async (source: string) => {
      const renderer = await render(
        <SelectableMarkdown
          source={source}
          theme={{ blocks: { heading: { before: 30 }, paragraph: { before: 10 }, firstBlockLead: ['heading'] } }}
        />,
      );
      const runs = renderer.root.findAll(
        (node) => (node.type as unknown) === 'View' && node.props.style?.marginBottom !== undefined,
      );
      return runs[0].props.style.marginTop;
    };
    expect(await leadOf('### Rx\n\nBody\n')).toBe(30);
    expect(await leadOf('Body\n\n### Rx\n')).toBeUndefined();
  });
});

describeNative('headings', () => {
  test('a level carries its own size, leading, family, colour and tracking on both paths', () => {
    const t = theme({
      headings: {
        letterSpacing: -0.2,
        levels: [{ fontSize: 28, lineHeight: 34, fontFamily: 'Display', color: '#111', letterSpacing: -0.6 }],
      },
    });
    expect(headingStyle(t, 1)).toEqual({
      fontSize: 28,
      lineHeight: 34,
      fontFamily: 'Display',
      color: '#111',
      fontWeight: '700',
      letterSpacing: -0.6,
    });
    const projected = project('# Big\n\n## Small\n');
    const [, h1, h2] = resolveRunAttributes(projected, t);
    expect(h1).toMatchObject({ fontSize: 28, lineHeight: 34, fontFamily: 'Display', letterSpacing: -0.6 });
    expect(h2).toMatchObject({ letterSpacing: -0.2 });
    expect(h2.fontFamily).toBeUndefined();
  });
});

describeNative('links', () => {
  test('underline style and colour, or none', () => {
    const projected = project('[go](https://e.test)\n');
    const dashed = resolveRunAttributes(projected, theme({ link: { underline: 'dashed', underlineColor: '#d4d4d8' } }));
    expect(dashed[1]).toMatchObject({
      textDecorationLine: 'underline',
      textDecorationStyle: 'dashed',
      textDecorationColor: '#d4d4d8',
    });
    const plain = resolveRunAttributes(projected, theme({ link: { underline: 'none' } }));
    expect(plain[1].textDecorationLine).toBe('none');
    expect(resolveRunAttributes(projected, defaultTheme)[1].textDecorationStyle).toBeUndefined();
  });
});

describeNative('list markers', () => {
  const dot = theme({ list: { marker: { kind: 'dot', size: 6, gap: 10, color: '#71717a' } } });

  test('a dot hides the bullet glyph and pins the marker column', () => {
    const projected = project('- one\n- two\n');
    const marker = resolveRunAttributes(projected, dot).filter((a) => a.color === 'transparent');
    expect(marker).toHaveLength(2);
    const columns = resolveRunDecorations(projected, dot).filter((d) => d.kind === 'marker');
    expect(columns).toEqual([
      expect.objectContaining({ minWidth: 16, dotSize: 6, color: '#71717a' }),
      expect.objectContaining({ minWidth: 16, dotSize: 6, color: '#71717a' }),
    ]);
    const indent = resolveRunDecorations(projected, dot).find((d) => d.kind === 'indent');
    expect(indent).toMatchObject({ textInset: 0, hang: 16 });
  });

  test('ordered numbers keep their glyphs in the pinned column', () => {
    const projected = project('1. one\n2. two\n');
    expect(resolveRunAttributes(projected, dot).some((a) => a.color === 'transparent')).toBe(false);
    const columns = resolveRunDecorations(projected, dot).filter((d) => d.kind === 'marker');
    expect(columns.every((c) => c.dotSize === undefined && c.minWidth === 16)).toBe(true);
  });

  test('a glyph marker restyles and replaces the bullet', () => {
    const t = theme({ list: { marker: { kind: 'glyph', glyph: '– ', color: '#999' } } });
    const projected = project('- one\n', { glyphs: { bullet: '– ' } });
    const marker = projected.marks.find((m) => m.kind === 'listMarker')!;
    const style = resolveRunAttributes(projected, t).find((a) => a.start === marker.start && a.end === marker.end);
    expect(style?.color).toBe('#999');
    // No pinned column without a hanging indent.
    expect(resolveRunDecorations(projected, t).some((d) => d.kind === 'marker')).toBe(false);
  });
});

describeNative('tables', () => {
  const source = '| | |\n|---|---|\n| a | b |\n| c | d |\n';

  test('header and body typography ride the table marks', () => {
    const t = theme({
      table: {
        header: { fontSize: 14, lineHeight: 21, color: '#71717a', weight: '500' },
        body: { fontSize: 14, lineHeight: 21 },
      },
    });
    const projected = project('| H |\n|---|\n| b |\n');
    const attributes = resolveRunAttributes(projected, t);
    const body = projected.marks.find((m) => m.kind === 'tableBody')!;
    const header = projected.marks.find((m) => m.kind === 'tableHeader')!;
    expect(attributes.find((a) => a.start === body.start && a.end === body.end && a.fontSize === 14)).toBeDefined();
    expect(attributes.find((a) => a.start === header.start && a.end === header.end)).toMatchObject({
      color: '#71717a',
      fontWeight: '500',
    });
  });

  test('frame off and separate rule colour', () => {
    const projected = project('| H |\n|---|\n| b |\n');
    const decorations = resolveRunDecorations(projected, theme({ table: { frame: false, ruleColor: '#eee' } }));
    const box = decorations.find((d) => d.kind === 'box' && d.textInset !== undefined)!;
    expect(box.borderWidth).toBeUndefined();
    expect(box.borderColor).toBeUndefined();
    expect(decorations.filter((d) => d.kind === 'rule').every((d) => d.color === '#eee')).toBe(true);
  });

  test('an empty header row collapses with its band and first rule', () => {
    const t = theme({ table: { hideEmptyHeader: true } });
    const projected = project(source);
    const decorations = resolveRunDecorations(projected, t);
    expect(decorations.filter((d) => d.kind === 'rule')).toHaveLength(1);
    expect(decorations.some((d) => d.kind === 'box' && d.corners === 'top')).toBe(false);
    const table = projected.marks.find((m) => m.kind === 'table')!;
    const columns = decorations.find((d) => d.kind === 'columns')!;
    expect(columns.start).toBe(projected.text.indexOf('\n', table.start) + 1);
    expect(hiddenHeaderLines(projected, t)).toEqual([
      { start: table.start, end: columns.start, lineHeight: 0.01 },
    ]);
    // A header with text stays.
    expect(hiddenHeaderLines(project('| H |\n|---|\n| b |\n'), t)).toEqual([]);
  });
});

describeNative('pressables', () => {
  const projected = () =>
    project('See [3](https://e.test/cite-3) and [x](https://e.test/product/x) and [y](https://e.test).\n');

  test('labels, roles, pressed fill and hit slop; role none drops the range', () => {
    const run = projected();
    const presented = presentPressables(resolveRunPressables(run), run.text, {
      accessibilityForPressable: ({ href, text }) =>
        href.includes('/cite-')
          ? { label: `Open citation ${text}`, role: 'button' }
          : href.includes('/product/')
            ? { role: 'none' }
            : undefined,
      pressedStyle: { backgroundColor: '#fde', borderRadius: 6 },
      hitSlop: 8,
    });
    expect(presented.map((p) => p.href)).toEqual(['https://e.test/cite-3', 'https://e.test']);
    const tracked = presentPressables(resolveRunPressables(run), run.text, {
      accessibilityForPressable: () => ({ role: 'text' }),
    });
    expect(tracked).toHaveLength(3);
    expect(tracked.every((p) => p.accessibilityRole === 'text')).toBe(true);
    expect(presented[0]).toMatchObject({
      accessibilityLabel: 'Open citation 3',
      accessibilityRole: 'button',
      pressedColor: '#fde',
      pressedRadius: 6,
      hitSlop: 8,
    });
  });

  test('a chip decorates the marks chipForMark styles', () => {
    const run = projected();
    const { decorations: chips, attributes } = resolveChips(run, (mark) =>
      mark.href?.includes('/cite-')
        ? {
            backgroundColor: '#fff1eb',
            borderRadius: 8,
            paddingHorizontal: 4,
            paddingVertical: 2,
            minWidth: 20,
            fontSize: 12,
            color: '#fc5f2b',
          }
        : undefined,
    );
    expect(attributes).toEqual([
      { start: chips[0]?.start, end: chips[0]?.end, fontSize: 12, color: '#fc5f2b' },
    ]);
    expect(chips).toEqual([
      expect.objectContaining({
        kind: 'chip',
        color: '#fff1eb',
        paddingH: 4,
        paddingTop: 2,
        paddingBottom: 2,
        minWidth: 20,
      }),
    ]);
    expect(run.text.slice(chips[0].start, chips[0].end)).toBe('3');
  });
});

describeNative('highlights', () => {
  test('a query matches display text case-insensitively', () => {
    expect(queryRanges('Iron and iron', { query: 'IRON' })).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
    ]);
    expect(queryRanges('Iron and iron', { query: 'Iron', caseSensitive: true })).toEqual([{ start: 0, end: 4 }]);
  });

  test('matchTokens falls back to words only where the phrase is missing', () => {
    const text = 'Low ferritin, and iron is low too.';
    expect(queryRanges(text, { query: 'iron low' })).toEqual([]);
    expect(queryRanges(text, { query: 'iron low', matchTokens: true }).map((r) => text.slice(r.start, r.end))).toEqual([
      'Low',
      'iron',
      'low',
    ]);
    // The phrase wins when present.
    expect(queryRanges(text, { query: 'is low', matchTokens: true }).map((r) => text.slice(r.start, r.end))).toEqual([
      'is low',
    ]);
    // Overlapping word hits merge into one range.
    expect(queryRanges('ironing', { query: 'iron ironing x', matchTokens: true })).toEqual([{ start: 0, end: 7 }]);
  });

  test('spans map through the piece table, and the run stays native', async () => {
    const source = 'Ferritin is **low** today.\n';
    const run = project(source);
    const at = source.indexOf('low');
    const [range] = resolveRunHighlights(run, [{ start: at, end: at + 3 }], defaultTheme);
    expect(run.text.slice(range.start, range.end)).toBe('low');
    expect(range.backgroundColor).toBe(defaultTheme.colors.highlight);

    const renderer = await render(<SelectableMarkdown highlights={{ query: 'today' }} source={source} />);
    const [host] = hosts(renderer);
    const attributes = host.props.attributes as RunTextAttribute[];
    expect(attributes.some((a) => a.backgroundColor === defaultTheme.colors.highlight)).toBe(true);
  });
});

describeNative('font scaling and soft breaks', () => {
  test('allowFontScaling and the cap reach the native host', async () => {
    const renderer = await render(
      <SelectableMarkdown allowFontScaling={false} maxFontSizeMultiplier={1.5} source="Text" />,
    );
    const [host] = hosts(renderer);
    expect(host.props.allowFontScaling).toBe(false);
    expect(host.props.maxFontSizeMultiplier).toBe(1.5);
  });

  test('a soft break can project as a newline, offsets unchanged', () => {
    const space = project('one\ntwo\n');
    const newline = project('one\ntwo\n', { softBreak: 'newline' });
    expect(space.text).toBe('one two');
    expect(newline.text).toBe('one\ntwo');
    expect(newline.pieces).toEqual(space.pieces);
  });
});

describeNative('images', () => {
  test("'none' drops images and their now-empty paragraphs, keeping identity", () => {
    const doc = parseDocument('Before\n\n![a](https://e.test/a.png)\n\nInline ![b](https://e.test/b.png) text\n', presets.everything);
    const once = withoutImages(doc.blocks);
    expect(once.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
    expect(withoutImages(doc.blocks)[1]).toBe(once[1]);
    expect(once[0]).toBe(doc.blocks[0]);
  });

  test('a sizing function sizes each image claim', () => {
    const doc = parseDocument('![a](https://e.test/a.png)\n', presets.everything);
    const paragraph = doc.blocks[0];
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph');
    const lookup = withImageEmbeds(undefined, (image) => ({ width: 300, height: image.src.length }));
    expect(lookup(paragraph.children[0], { topLevel: false, soleChildOfTopLevelParagraph: true })).toMatchObject({
      width: 300,
      height: 'https://e.test/a.png'.length,
    });
  });
});

describeNative('the standalone renderers', () => {
  const standalone = () => 'standalone' as const;

  function texts(renderer: ReactTestRenderer) {
    return renderer.root.findAll((node) => (node.type as unknown) === 'Text');
  }

  /** The characters a `<Text>` subtree draws, which is what a selection copies. */
  function drawn(node: ReturnType<ReactTestRenderer['root']['findAll']>[number] | string): string {
    if (typeof node === 'string') return node;
    // Host views (an inline spacer) draw no characters; components pass through.
    const type: unknown = node.type;
    if (typeof type === 'string' && type !== 'Text') return '';
    return node.children.map((child) => drawn(child as never)).join('');
  }

  function outerTexts(renderer: ReactTestRenderer) {
    return texts(renderer).filter((node) => node.props.selectable !== undefined && !hasTextAncestor(node));
  }

  function hasTextAncestor(node: ReturnType<ReactTestRenderer['root']['findAll']>[number]): boolean {
    for (let up = node.parent; up !== null; up = up.parent) {
      if ((up.type as unknown) === 'Text') return true;
    }
    return false;
  }

  test('a list is one selectable Text, markers and nested items included', async () => {
    const source = '- one\n- two\n  1. deep\n  2. deeper\n- [x] done\n';
    const renderer = await render(<SelectableMarkdown classifyBlock={standalone} options={presets.everything} source={source} />);
    const [list, ...rest] = outerTexts(renderer);
    expect(rest).toHaveLength(0);
    expect(list.props.selectable).toBe(true);
    // Same characters as the run would project, so a copy matches either path.
    expect(drawn(list)).toBe(project(source).text);
    // The nested list is inset by a spacer view, not by copied spaces.
    const spacers = list.findAll((node) => (node.type as unknown) === 'View' && node.props.style?.width === 18);
    expect(spacers).toHaveLength(2);
  });

  test('a dot marker is a coloured text glyph, the item gap an empty line', async () => {
    const renderer = await render(
      <SelectableMarkdown
        classifyBlock={standalone}
        source={'- one\n- two\n'}
        theme={{ list: { marker: { kind: 'dot', size: 6, gap: 10, color: '#f00' }, itemGap: 8 } }}
      />,
    );
    const [list] = outerTexts(renderer);
    expect(drawn(list)).toBe('• one\n\n• two');
    const dots = texts(renderer).filter((node) => node.props.style?.color === '#f00');
    expect(dots.map((node) => node.props.children)).toEqual(['• ', '• ']);
    expect(texts(renderer).filter((node) => node.props.style?.lineHeight === 8)).toHaveLength(1);
  });

  test('no marker is width-constrained, so a long ordinal never wraps', async () => {
    const renderer = await render(
      <SelectableMarkdown
        classifyBlock={standalone}
        source={'100. hundred\n101. more\n'}
        theme={{ list: { hangingIndent: 15 } }}
      />,
    );
    const [list] = outerTexts(renderer);
    expect(drawn(list)).toBe('100. hundred\n101. more');
    expect(renderer.root.findAll((node) => node.props.style?.width === 15)).toHaveLength(0);
  });

  test('a quote is one selectable Text in the quote colour, children a blank line apart', async () => {
    const renderer = await render(<SelectableMarkdown classifyBlock={standalone} source={'> one\n>\n> two\n'} />);
    const [quote, ...rest] = outerTexts(renderer);
    expect(rest).toHaveLength(0);
    expect(drawn(quote)).toBe('one\n\ntwo');
    expect(quote.props.style.color).toBe(defaultTheme.colors.quoteText);
  });

  test('a managed quote sizes the blank line to the margin', async () => {
    const renderer = await render(
      <SelectableMarkdown classifyBlock={standalone} source={'> one\n>\n> two\n'}
        theme={{ blocks: { paragraph: { after: 12 } } }} />,
    );
    const [quote] = outerTexts(renderer);
    expect(drawn(quote)).toBe('one\n\ntwo');
    expect(texts(renderer).filter((node) => node.props.style?.lineHeight === 12)).toHaveLength(1);
  });

  test('allowFontScaling={false} reaches every block-level Text', async () => {
    const renderer = await render(
      <SelectableMarkdown allowFontScaling={false} classifyBlock={standalone} source={'# H\n\nBody\n\n- item\n'} />,
    );
    const blockTexts = texts(renderer).filter((node) => node.props.selectable !== undefined);
    expect(blockTexts.length).toBeGreaterThan(2);
    expect(blockTexts.every((node) => node.props.allowFontScaling === false)).toBe(true);
  });

  test('a hidden empty header row is not drawn', async () => {
    const renderer = await render(
      <SelectableMarkdown
        classifyBlock={standalone}
        options={presets.everything}
        source={'| | |\n|---|---|\n| a | b |\n'}
        theme={{ table: { hideEmptyHeader: true } }}
      />,
    );
    const rows = renderer.root.findAll(
      (node) => (node.type as unknown) === 'View' && node.props.style?.flexDirection === 'row',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].props.style.borderTopWidth).toBe(0);
  });
});

describeNative('link presses, autolinks and inline transforms', () => {
  const standalone = () => 'standalone' as const;

  test('attributeForMark, chipForMark and accessibilityForPressable apply on the standalone path', async () => {
    const source = '## A **b** [3](https://e.test/cite/3) [x](https://e.test/x)\n';
    const renderer = await render(
      <SelectableMarkdown
        accessibilityForPressable={(p) => (p.href.includes('/cite/') ? { label: 'Citation 3', role: 'button' } : { role: 'none' })}
        attributeForMark={(mark) =>
          mark.kind === 'strong' ? { color: '#f00' } : mark.kind === 'heading' ? { fontFamily: 'Serif' } : undefined
        }
        chipForMark={(mark) =>
          mark.kind === 'link' && mark.href?.includes('/cite/') ? { backgroundColor: '#eee', borderRadius: 4, paddingHorizontal: 3 } : undefined
        }
        classifyBlock={standalone}
        source={source}
      />,
    );
    const texts = renderer.root.findAll((node) => (node.type as unknown) === 'Text');
    expect(texts[0].props.style.fontFamily).toBe('Serif');
    expect(texts.find((t) => t.props.style?.color === '#f00')).toBeDefined();
    const chip = renderer.root.find((node) => (node.type as unknown) === 'View' && node.props.style?.backgroundColor === '#eee');
    expect(chip.props.style).toMatchObject({ borderRadius: 4, paddingHorizontal: 3 });
    const citation = chip.findByType('Text' as never);
    expect(citation.props).toMatchObject({ accessibilityLabel: 'Citation 3', accessibilityRole: 'button' });
    // A heading's chip restates the heading's size, since it starts a new text root.
    expect(citation.props.style.fontSize).toBe(texts[0].props.style.fontSize);
    // role 'none' is inert.
    const plain = texts.find((t) => t.props.children === 'x' || (Array.isArray(t.props.children) && t.props.children.includes('x')));
    expect(texts.filter((t) => t.props.onPress !== undefined)).toHaveLength(1);
    expect(plain?.props.onPress).toBeUndefined();
  });

  test('a standalone link routes through onLinkPress with its span and touch point', async () => {
    const presses: InlineLinkPress[] = [];
    const source = 'See [docs](https://e.test/docs).\n';
    const renderer = await render(
      <SelectableMarkdown classifyBlock={standalone} onLinkPress={(press) => presses.push(press)} source={source} />,
    );
    const link = renderer.root.find((node) => (node.type as unknown) === 'Text' && node.props.accessibilityRole === 'link');
    await act(() => link.props.onPress({ nativeEvent: { pageX: 40, pageY: 90 } }));
    expect(presses).toEqual([
      {
        href: 'https://e.test/docs',
        blocked: false,
        span: { start: source.indexOf('['), end: source.indexOf(')') + 1 },
        rect: { x: 40, y: 90, width: 0, height: 0 },
      },
    ]);
  });

  test('a native press carries display offsets, the source span and the rect', async () => {
    const presses: InlineLinkPress[] = [];
    const source = 'See [docs](https://e.test/docs).\n';
    const renderer = await render(<SelectableMarkdown onLinkPress={(press) => presses.push(press)} source={source} />);
    const [host] = hosts(renderer);
    await act(() =>
      host.props.onInlinePress({ nativeEvent: { start: 4, end: 8, pressableId: 0, x: 10, y: 20, width: 30, height: 18 } }),
    );
    expect(presses[0]).toMatchObject({
      start: 4,
      end: 8,
      span: { start: source.indexOf('['), end: source.indexOf(')') + 1 },
      rect: { x: 10, y: 20, width: 30, height: 18 },
    });
  });

  test('an autolink keeps the address as written', () => {
    const doc = parseDocument('Mail <foo@bar.com> or <https://e.test>.\n', presets.everything);
    const autolinks = extractLinks(doc.source, presets.everything).filter((l) => l.kind === 'autolink');
    expect(autolinks.map((l) => [l.text, l.href])).toEqual([
      ['foo@bar.com', 'mailto:foo@bar.com'],
      ['https://e.test', 'https://e.test'],
    ]);
  });

  test('extractLinks lists what renders, in order', () => {
    const links = extractLinks('[a](https://e.test/a) and **[b](https://e.test/b)**\n', presets.everything);
    expect(links.map((l) => [l.text, l.href])).toEqual([
      ['a', 'https://e.test/a'],
      ['b', 'https://e.test/b'],
    ]);
  });

  const transform = (node: Parameters<NonNullable<ProjectRunOptions['transformInline']>>[0]) => {
    if (node.kind !== 'link') return undefined;
    if (node.href.endsWith('/hidden')) return { hide: true };
    if (node.href.endsWith('/3')) return { text: '[1]' };
    return undefined;
  };
  const source = 'Fact [x](https://e.test/hidden). Claim [3](https://e.test/3).\n';

  test('transformInline hides and renumbers in a run, mapping to the original source', () => {
    const run = project(source, { transformInline: transform });
    expect(run.text).toBe('Fact. Claim [1].');
    const link = run.marks.find((m) => m.kind === 'link')!;
    expect(run.text.slice(link.start, link.end)).toBe('[1]');
    expect(link.href).toBe('https://e.test/3');
    const span = mapSelectionToSource(run, { start: link.start, end: link.end })!;
    expect(source.slice(span.start, span.end)).toBe('[3](https://e.test/3)');
    const all = mapSelectionToSource(run, { start: 0, end: run.text.length })!;
    expect(source.slice(all.start, all.end)).toBe(source.trimEnd());
  });

  test('a transformInline prefix draws in its own style on both paths and copies no markdown', async () => {
    const dot = (node: Parameters<NonNullable<ProjectRunOptions['transformInline']>>[0]) =>
      node.kind === 'link' && node.href.includes('/cite/')
        ? { prefix: { text: '\u25CF', style: { color: '#16a34a', fontSize: 10 } } }
        : undefined;
    const md = 'Iron [1](https://e.test/cite/1) is low.\n';
    const run = project(md, { transformInline: dot });
    expect(run.text).toBe('Iron \u25CF1 is low.');
    expect(run.prefixes).toEqual([{ start: 5, end: 6, style: { color: '#16a34a', fontSize: 10 } }]);
    const link = run.marks.find((m) => m.kind === 'link')!;
    expect(run.text.slice(link.start, link.end)).toBe('1');
    const attributes = resolveRunAttributes(run, theme({}));
    expect(attributes.find((a) => a.start === 5 && a.end === 6)).toMatchObject({ color: '#16a34a', fontSize: 10 });
    const span = mapSelectionToSource(run, { start: 5, end: run.text.length })!;
    expect(md.slice(span.start, span.end)).toBe('[1](https://e.test/cite/1) is low.');

    const renderer = await render(<SelectableMarkdown classifyBlock={standalone} source={md} transformInline={dot} />);
    const glyph = renderer.root.find(
      (node) => (node.type as unknown) === 'Text' && node.props.children === '\u25CF',
    );
    expect(glyph.props.style).toEqual({ color: '#16a34a', fontSize: 10 });
  });

  test('a hidden node keeps the space before it when a word follows directly', async () => {
    const hideCitations = (node: Parameters<NonNullable<ProjectRunOptions['transformInline']>>[0]) =>
      node.kind === 'link' && node.href.includes('/cite/') ? { hide: true } : undefined;
    const md = 'lead [1](https://e.test/cite/1)mg and [2](https://e.test/cite/2)[3](https://e.test/cite/3). Done [4](https://e.test/cite/4) here.\n';
    expect(project(md, { transformInline: hideCitations }).text).toBe('lead mg and. Done here.');
    const renderer = await render(
      <SelectableMarkdown classifyBlock={standalone} source={md} transformInline={hideCitations} />,
    );
    const flatten = (node: unknown): string =>
      typeof node === 'string'
        ? node
        : Array.isArray(node)
          ? node.map(flatten).join('')
          : node && typeof node === 'object' && 'children' in (node as object)
            ? flatten((node as { children: unknown }).children)
            : '';
    expect(flatten(renderer.toJSON())).toBe('lead mg and. Done here.');
  });

  test('transformInline applies on the renderer path too', async () => {
    const renderer = await render(
      <SelectableMarkdown classifyBlock={standalone} source={source} transformInline={transform} />,
    );
    const flatten = (node: unknown): string =>
      typeof node === 'string'
        ? node
        : Array.isArray(node)
          ? node.map(flatten).join('')
          : node && typeof node === 'object' && 'children' in (node as object)
            ? flatten((node as { children: unknown }).children)
            : '';
    expect(flatten(renderer.toJSON())).toBe('Fact. Claim [1].');
  });

  test('copy snapping widens a selection that starts inside a heading', () => {
    const md = '## Title\n\nBody\n';
    const run = project(md);
    const start = run.text.indexOf('itle');
    const plain = mapSelectionToSource(run, { start, end: run.text.length })!;
    expect(md.slice(plain.start, plain.end)).toBe('itle\n\nBody');
    const snapped = mapSelectionToSource(run, { start, end: run.text.length }, { snapHeadings: true })!;
    expect(md.slice(snapped.start, snapped.end)).toBe('## Title\n\nBody');
  });
});

describeNative('smaller tokens', () => {
  test('emphasis colour and rule colour', () => {
    const t = theme({ colors: { emphasis: '#52525b' }, rule: { color: '#ccc' } });
    const run = project('*soft*\n\n---\n\nnext\n');
    expect(resolveRunAttributes(run, t)[1]).toMatchObject({ fontStyle: 'italic', color: '#52525b' });
    const rule = resolveRunDecorations(run, t).find((d) => d.kind === 'rule')!;
    expect(rule.color).toBe('#ccc');
    expect(resolveRunDecorations(project('| a |\n|---|\n| b |\n'), t).find((d) => d.kind === 'rule')!.color).toBe(
      defaultTheme.colors.border,
    );
  });

  test('lastBlockTrail adds the last block\'s after margin below the document', async () => {
    const renderer = await render(
      <SelectableMarkdown source={'Body\n'} theme={{ blocks: { paragraph: { after: 16 }, lastBlockTrail: true } }} />,
    );
    const runs = renderer.root.findAll(
      (node) => (node.type as unknown) === 'View' && node.props.style?.marginBottom !== undefined,
    );
    expect(runs[0].props.style.marginBottom).toBe(16);
  });

  test('with block margins set and no trail, the last run gets no blockGap', async () => {
    const renderer = await render(
      <SelectableMarkdown source={'Body\n'} theme={{ blocks: { paragraph: { after: 16 } }, spacing: { blockGap: 24 } }} />,
    );
    const runs = renderer.root.findAll(
      (node) => (node.type as unknown) === 'View' && node.props.style?.marginBottom !== undefined,
    );
    expect(runs.map((run) => run.props.style.marginBottom)).toEqual([0]);
  });

  test('an equal inline theme literal does not re-render runs', async () => {
    const renders: number[] = [];
    const renderers = {
      paragraph: (_node: unknown, ctx: RenderContext) => {
        renders.push(1);
        return null;
      },
    };
    const renderer = await render(
      <SelectableMarkdown classifyBlock={() => 'standalone'} renderers={{ ...renderers }} source="Body" theme={{ colors: { text: '#111' } }} />,
    );
    const before = renders.length;
    await act(() =>
      renderer.update(
        <SelectableMarkdown classifyBlock={() => 'standalone'} renderers={{ ...renderers }} source="Body" theme={{ colors: { text: '#111' } }} />,
      ),
    );
    expect(renders.length).toBe(before);
  });

  test('ctx.marks carries the enclosing constructs into a custom link renderer', async () => {
    const seen: string[] = [];
    await render(
      <SelectableMarkdown
        classifyBlock={() => 'standalone'}
        renderers={{
          link: (_node, ctx) => {
            seen.push((ctx.marks ?? []).map((m) => (m.level ? `${m.kind}${m.level}` : m.kind)).join('>'));
            return null;
          },
        }}
        source={'## A **[x](https://e.test)**\n'}
      />,
    );
    expect(seen).toEqual(['heading2>strong']);
  });
});

describeNative('auto-height embeds', () => {
  test("reserve the estimate, then re-reserve once at the overlay's measured height", async () => {
    const card = (): React.ReactElement => React.createElement('Card');
    const embed = (node: { kind: string }) =>
      node.kind === 'codeBlock' ? { width: 300, height: 'auto' as const, estimatedHeight: 60, render: card } : undefined;
    const renderer = await render(<SelectableMarkdown embed={embed} source={'Before\n\n```\ncards\n```\n\nAfter\n'} />);
    const [host] = hosts(renderer);
    expect(host.props.embeds).toEqual([expect.objectContaining({ width: 300, height: 60 })]);
    await act(() => host.props.onEmbedLayout({ nativeEvent: { embedId: 0, x: 0, y: 30, width: 300, height: 60 } }));
    const overlay = renderer.root.find(
      (node) => (node.type as unknown) === 'View' && node.props.style?.position === 'absolute',
    );
    expect(overlay.props.style.height).toBeUndefined();
    await act(() => overlay.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 132.4 } } }));
    expect(hosts(renderer)[0].props.embeds).toEqual([expect.objectContaining({ height: 133 })]);
  });
});


describeNative('container-width and streaming embeds', () => {
  const card = (): React.ReactElement => React.createElement('Card');
  const overlays = (renderer: ReactTestRenderer) =>
    renderer.root.findAll((node) => (node.type as unknown) === 'View' && node.props.style?.position === 'absolute');

  test("a 'container' claim waits for the measured width, less padding", async () => {
    const embed = (node: { kind: string }) =>
      node.kind === 'codeBlock' ? { width: 'container' as const, height: 80, render: card } : undefined;
    const renderer = await render(
      <SelectableMarkdown embed={embed} source={'Before\n\n```\ncard\n```\n'} style={{ padding: 10 }} />,
    );
    expect(hosts(renderer)).toHaveLength(0);
    await act(() => renderer.root.find((node) => (node.type as unknown) === 'View' && typeof node.props.onLayout === 'function').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 0 } } }));
    expect(hosts(renderer)[0].props.embeds).toEqual([expect.objectContaining({ width: 380, height: 80 })]);
  });

  test('numeric claims do not wait for layout', async () => {
    const embed = (node: { kind: string }) =>
      node.kind === 'codeBlock' ? { width: 200, height: 80, render: card } : undefined;
    const renderer = await render(<SelectableMarkdown embed={embed} source={'Before\n\n```\ncard\n```\n'} />);
    expect(hosts(renderer)[0].props.embeds).toEqual([expect.objectContaining({ width: 200 })]);
  });

  test.each([
    [false, 0],
    [true, 1],
  ])('streamingEmbeds %s mounts %i overlays on the streaming tail', async (streamingEmbeds, count) => {
    const embed = (node: { kind: string; href?: string }) =>
      node.kind === 'link' && node.href === 'https://e.test/card' ? { width: 40, height: 16, render: card } : undefined;
    const session = new StreamSession({ options: presets.everything });
    session.append('See [card](https://e.test/card) and more');
    const renderer = await render(<SelectableMarkdown embed={embed} session={session} streamingEmbeds={streamingEmbeds} />);
    const host = hosts(renderer).find((h) => h.props.embeds?.length)!;
    await act(() => host.props.onEmbedLayout({ nativeEvent: { embedId: 0, x: 0, y: 0, width: 40, height: 16 } }));
    expect(overlays(renderer)).toHaveLength(count);
  });
});

describeNative('code block cards', () => {
  const source = 'Run this:\n\n```sh\nnpm i\nnpm test\n```\n\nDone.\n';
  const layout = (renderer: ReactTestRenderer) =>
    act(() =>
      renderer.root
        .find((node) => (node.type as unknown) === 'View' && typeof node.props.onLayout === 'function')
        .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 0 } } }),
    );
  const mountCard = async (renderer: ReactTestRenderer) => {
    await layout(renderer);
    const host = hosts(renderer).find((h) => h.props.embeds?.length)!;
    await act(() => host.props.onEmbedLayout({ nativeEvent: { embedId: 0, x: 0, y: 30, width: 344, height: 80 } }));
  };
  const button = (renderer: ReactTestRenderer) =>
    renderer.root.find((node) => (node.type as unknown) === 'Text' && node.props.accessibilityRole === 'button');

  test('a closed top-level block becomes a full-width card in the run that copies through onCodeCopy', async () => {
    const copies: unknown[] = [];
    const renderer = await render(
      <SelectableMarkdown codeBlocks="card" onCodeCopy={(event) => copies.push(event)} source={source} style={{ padding: 8 }} />,
    );
    await mountCard(renderer);
    const [host] = hosts(renderer);
    expect(host.props.embeds).toEqual([expect.objectContaining({ width: 344 })]);
    expect(renderer.root.findAll((node) => (node.type as unknown) === 'ScrollView' && node.props.horizontal)).toHaveLength(1);
    expect(button(renderer).props.children).toBe('Copy');
    await act(() => button(renderer).props.onPress());
    expect(copies).toEqual([{ code: 'npm i\nnpm test', language: 'sh', span: { start: source.indexOf('```'), end: expect.any(Number) } }]);
    expect(button(renderer).props.children).toBe('Copied');
  });

  test('without onCodeCopy the card writes the native clipboard', async () => {
    const { NativeModules } = jest.requireMock('react-native') as { NativeModules: { SelectableMarkdown: { copyText: jest.Mock } } };
    NativeModules.SelectableMarkdown.copyText.mockClear();
    const renderer = await render(<SelectableMarkdown codeBlocks={{ copyLabel: 'Copy code' }} source={source} />);
    await mountCard(renderer);
    expect(button(renderer).props.children).toBe('Copy code');
    await act(() => button(renderer).props.onPress());
    expect(NativeModules.SelectableMarkdown.copyText).toHaveBeenCalledWith('npm i\nnpm test');
  });

  test("the default 'text' mode leaves code in the run text", async () => {
    const renderer = await render(<SelectableMarkdown source={source} />);
    expect(hosts(renderer)[0].props.embeds ?? []).toHaveLength(0);
  });
});

describeNative('review regressions', () => {
  test.each([
    [undefined, 30],
    [7, 7],
  ])('item children: itemGap %s wins, else their margins, on both paths', async (gap, expected) => {
    const source = '- parent\n  - child\n';
    const overrides: PartialTheme = {
      blocks: { paragraph: { after: 30 }, list: { before: 20 } },
      list: gap === undefined ? {} : { itemGap: gap },
    };
    const renderer = await render(
      <SelectableMarkdown source={source} classifyBlock={() => 'standalone'} theme={overrides} />,
    );
    const lines = renderer.root.findAll((node) =>
      (node.type as unknown) === 'Text' && node.props.children === '\n' && node.props.style?.lineHeight !== undefined,
    ).map((node) => node.props.style.lineHeight);
    expect(lines).toEqual([expected]);
    const native = resolveRunSpacing(project(source, { recordBlocks: true }), theme(overrides));
    expect(native.decorations.map((d) => d.paddingBottom)).toEqual([expected]);
  });

  test('blocks.listItem counts as a configured item gap inside an item', () => {
    const overrides = theme({ blocks: { paragraph: { after: 30 }, listItem: { after: 4 } } });
    const native = resolveRunSpacing(project('- parent\n  - child\n', { recordBlocks: true }), overrides);
    expect(native.decorations.map((d) => d.paddingBottom)).toEqual([4]);
  });

  test('highlights exclude each embed for source spans and display queries', () => {
    const source = 'Before\n\n![one](https://e.test/1.png)\n\nMiddle\n\n![two](https://e.test/2.png)\n\nAfter';
    const doc = parseDocument(source, presets.everything);
    const embed = withImageEmbeds(undefined, { width: 100, height: 60 });
    const [run] = segmentRuns(doc, { embed });
    const projected = projectRun(run, doc, { embed });
    expect(projected.embeds).toHaveLength(2);
    for (const highlights of [[{ start: 0, end: source.length }], { query: projected.text }]) {
      const attrs = resolveRunHighlights(projected, highlights, defaultTheme);
      expect(attrs).toHaveLength(3);
      for (const attribute of attrs) {
        expect(projected.embeds!.every((e) => attribute.end <= e.start || attribute.start >= e.end)).toBe(true);
      }
      expect(attrs.map((a) => projected.text.slice(a.start, a.end)).join('')).toBe(projected.text.replace(/\uFFFC/g, ''));
    }
    expect(resolveRunHighlights(projected, { query: '\uFFFC' }, defaultTheme)).toEqual([]);
  });

  test('images none drops image-only headings and preserves other headings', () => {
    const doc = parseDocument('# ![a](https://e.test/a.png)\n\n## Keep ![b](https://e.test/b.png)\n\n### Unchanged', presets.everything);
    const blocks = withoutImages(doc.blocks);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(blocks[1]).toBe(doc.blocks[2]);
    expect(withoutImages(doc.blocks)[0]).toBe(blocks[0]);
  });

  test('container images mount hosts at the measured width and resize with the container', async () => {
    const onLayout = jest.fn();
    const renderer = await render(
      <SelectableMarkdown testID="column" source={'Before\n\n![a](https://e.test/a.png)\n\nAfter'}
        images={{ width: 'container' }} style={{ paddingHorizontal: 12 }} onLayout={onLayout} />,
    );
    expect(hosts(renderer)).toHaveLength(0);
    const container = renderer.root.findAll((node) => (node.type as unknown) === 'View' && node.props.testID === 'column')[0];
    await act(() => container.props.onLayout({ nativeEvent: { layout: { width: 240, height: 0, x: 0, y: 0 } } }));
    const host = hosts(renderer)[0];
    expect(host.props.embeds[0].width).toBe(216);
    const attributes = host.props.attributes;
    await act(() => container.props.onLayout({ nativeEvent: { layout: { width: 240, height: 300, x: 0, y: 0 } } }));
    expect(hosts(renderer)[0].props.attributes).toBe(attributes);
    await act(() => container.props.onLayout({ nativeEvent: { layout: { width: 200, height: 300, x: 0, y: 0 } } }));
    expect(hosts(renderer)[0]).toBe(host);
    expect(host.props.embeds[0].width).toBe(176);
    expect(onLayout).toHaveBeenCalledTimes(3);
  });

  test('switching to container sizing and changing padding reuse the measured width', async () => {
    const source = '![a](https://e.test/a.png)';
    const renderer = await render(<SelectableMarkdown testID="column" source={source} images={{ width: 100 }} />);
    const container = renderer.root.findAll((node) => (node.type as unknown) === 'View' && node.props.testID === 'column')[0];
    const attributes = hosts(renderer)[0].props.attributes;
    await act(() => container.props.onLayout({ nativeEvent: { layout: { width: 240, height: 200, x: 0, y: 0 } } }));
    expect(hosts(renderer)[0].props.attributes).toBe(attributes);
    await act(() => renderer.update(<SelectableMarkdown testID="column" source={source} images={{ width: 'container' }} style={{ paddingHorizontal: 12 }} />));
    expect(hosts(renderer)[0].props.embeds[0].width).toBe(216);
    await act(() => renderer.update(<SelectableMarkdown testID="column" source={source} images={{ width: 'container' }} style={{ paddingHorizontal: 20 }} />));
    expect(hosts(renderer)[0].props.embeds[0].width).toBe(200);
  });

  test('container sizing does not defer or reproject image-free prose', async () => {
    const renderer = await render(<SelectableMarkdown testID="column" source="Plain text" images={{ width: 'container' }} />);
    const attributes = hosts(renderer)[0].props.attributes;
    const container = renderer.root.findAll((node) => (node.type as unknown) === 'View' && node.props.testID === 'column')[0];
    await act(() => container.props.onLayout({ nativeEvent: { layout: { width: 240, height: 40, x: 0, y: 0 } } }));
    expect(hosts(renderer)[0].props.attributes).toBe(attributes);
  });
});
