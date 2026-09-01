/**
 * The native host's block chrome, and the projection marks it is built from.
 *
 * The invariant asserted hardest here mirrors runAttributes.test.ts: deriving
 * decorations never moves the text. Every decoration only ever points INTO
 * `ProjectedRun.text` — a box over a range, a rule at an offset — so the
 * offsets the host reports back are untouched by the chrome it paints.
 */

/* theme.ts reaches for Platform.select; stub the one API used rather than
 * pulling a whole RN preset into a Node test environment. */
jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) =>
      options.ios !== undefined ? options.ios : options.default,
  },
}));

import { parseDocument } from '../engine/Engine';
import { presets } from '../engine/options';
import type { EngineOptions } from '../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { projectRun } from '../selection/mapSelection';
import type { ProjectedRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import { resolveRunDecorations } from './runDecorations';
import type { RunDecoration } from './runDecorations';
import { defaultTheme } from './theme';

const EVERYTHING: EngineOptions = presets.everything;

/** Project the first non-standalone run of `source`. */
function project(source: string): ProjectedRun {
  const doc = parseDocument(source, EVERYTHING);
  const run = segmentRuns(doc).find((r) => !r.standalone);
  if (!run) throw new Error(`no prose run in ${JSON.stringify(source)}`);
  return projectRun(run, doc);
}

function decorate(source: string): {
  projected: ProjectedRun;
  decorations: RunDecoration[];
} {
  const projected = project(source);
  return { projected, decorations: resolveRunDecorations(projected, defaultTheme) };
}

linkNativeEngineAsDefault();

describeNative('resolveRunDecorations', () => {
  test('a plain paragraph decorates nothing', () => {
    const { decorations } = decorate('Just prose.\n');
    expect(decorations).toEqual([]);
  });

  test('a code block gets a filled, inset box over exactly its literal', () => {
    const { projected, decorations } = decorate(
      'Before.\n\n```js\nconst x = 1;\n```\n\nAfter.\n',
    );
    expect(decorations).toHaveLength(1);
    const box = decorations[0];
    expect(box.kind).toBe('box');
    expect(box.color).toBe(defaultTheme.colors.codeBackground);
    expect(box.borderRadius).toBe(defaultTheme.code.borderRadius);
    expect(box.textInset).toBe(defaultTheme.spacing.codePadding);
    expect(projected.text.slice(box.start, box.end)).toBe('const x = 1;\n');
  });

  test('a table gets a border box, aligned columns, and one rule per row boundary', () => {
    const { projected, decorations } = decorate(
      '| a | b |\n| - | - |\n| c | d |\n| e | f |\n',
    );
    expect(projected.text).toBe('a\tb\nc\td\ne\tf');

    const boxes = decorations.filter((d) => d.kind === 'box');
    const rules = decorations.filter((d) => d.kind === 'rule');
    const columns = decorations.filter((d) => d.kind === 'columns');

    // The border box and the columns entry both span the whole table.
    const border = boxes.find((b) => b.borderColor !== undefined);
    if (!border) throw new Error('no border box');
    expect([border.start, border.end]).toEqual([0, projected.text.length]);
    expect(border.borderColor).toBe(defaultTheme.colors.border);
    expect(columns).toHaveLength(1);
    expect([columns[0].start, columns[0].end]).toEqual([0, projected.text.length]);
    // Interior row padding rides the columns entry; the outer padding stays
    // on the border box (painted into the block-separator slack).
    expect(columns[0].rowPaddingV).toBe(defaultTheme.table.cellPaddingV);
    expect(border.paddingTop).toBe(defaultTheme.table.cellPaddingV);
    expect(border.paddingBottom).toBe(defaultTheme.table.cellPaddingV);

    // The header band covers the header row's cells and rounds only its top.
    const band = boxes.find((b) => b.color !== undefined);
    if (!band) throw new Error('no header band');
    expect(band.color).toBe(defaultTheme.colors.tableHeaderBackground);
    expect(band.corners).toBe('top');
    expect(projected.text.slice(band.start, band.end)).toBe('a\tb');
    expect(band.paddingBottom).toBe(0);
    expect(band.paddingTop).toBe(border.paddingTop);

    // Two '\n' row separators -> two rules, each anchored to the first
    // character of the row below it, flush with the boundary ('top').
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.start).toBe(rule.end);
      expect(rule.align).toBe('top');
      expect(projected.text.charAt(rule.start - 1)).toBe('\n');
    }
    expect(rules.map((r) => r.start)).toEqual([4, 8]);
  });

  test('a thematic break becomes a centered zero-length rule', () => {
    const { projected, decorations } = decorate('Above.\n\n---\n\nBelow.\n');
    expect(decorations).toHaveLength(1);
    const rule = decorations[0];
    expect(rule.kind).toBe('rule');
    expect(rule.align).toBe('center');
    expect(rule.start).toBe(rule.end);
    expect(rule.color).toBe(defaultTheme.colors.border);
    // Anchored between the two block separators around the erased '---'.
    expect(projected.text).toBe('Above.\n\n\n\nBelow.');
    expect(rule.start).toBe('Above.\n\n'.length);
  });

  test('a flat list indents with a hanging indent only', () => {
    const { projected, decorations } = decorate('- one\n- two\n');
    expect(projected.text).toBe('• one\n• two');
    const indents = decorations.filter((d) => d.kind === 'indent');
    // Two items, one segment each (the separator between sibling marks
    // belongs to neither, so the segments do not merge across it).
    expect(indents).toHaveLength(2);
    for (const indent of indents) {
      // Top level: first lines flush like the fallback renderer's, wrapped
      // lines hanging one listIndent under the item's text.
      expect(indent.textInset).toBe(0);
      expect(indent.hang).toBe(defaultTheme.spacing.listIndent);
    }
    expect(projected.text.slice(indents[0].start, indents[0].end)).toBe('• one');
    expect(projected.text.slice(indents[1].start, indents[1].end)).toBe('• two');
  });

  test('nested items indent one step per level, innermost winning, disjoint', () => {
    const { projected, decorations } = decorate('- parent\n  - child\n- next\n');
    expect(projected.text).toBe('• parent\n• child\n• next');
    const indents = decorations.filter((d) => d.kind === 'indent');
    const step = defaultTheme.spacing.listIndent;

    const covering = (needle: string) => {
      const at = projected.text.indexOf(needle);
      const hit = indents.find((d) => d.start <= at && at < d.end);
      if (!hit) throw new Error(`no indent covers ${JSON.stringify(needle)}`);
      return hit;
    };
    expect(covering('parent').textInset).toBe(0);
    expect(covering('child').textInset).toBe(step);
    expect(covering('next').textInset).toBe(0);

    // Disjoint, and never starting on a separator newline: Android's margin
    // spans sum when they overlap a paragraph, so both properties are what
    // keep the two platforms agreeing (see insetSegments).
    const ordered = [...indents].sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      expect(ordered[i].end).toBeLessThanOrEqual(ordered[i + 1].start);
    }
    for (const indent of ordered) {
      expect(projected.text.charAt(indent.start)).not.toBe('\n');
    }
  });

  test('a code block inside a list item is an indent island', () => {
    const { projected, decorations } = decorate(
      '- item\n\n  ```\n  code\n  ```\n\n- after\n',
    );
    const box = decorations.find((d) => d.kind === 'box');
    if (!box) throw new Error('no code box');
    // The box keeps its own textInset; no indent decoration overlaps it —
    // overlap would assign-and-lose on iOS but SUM on Android.
    for (const indent of decorations.filter((d) => d.kind === 'indent')) {
      expect(indent.end <= box.start || indent.start >= box.end).toBe(true);
    }
    expect(projected.text).toContain('code');
  });

  test('a blockquote is a draw-only box; its body inset travels as an indent', () => {
    const { projected, decorations } = decorate('> quoted prose\n');
    expect(projected.text).toBe('quoted prose');

    const box = decorations.find((d) => d.kind === 'box');
    if (!box) throw new Error('no quote box');
    expect([box.start, box.end]).toEqual([0, projected.text.length]);
    expect(box.color).toBe(defaultTheme.quote.background);
    expect(box.barColor).toBe(defaultTheme.quote.barColor);
    expect(box.barWidth).toBe(defaultTheme.quote.barWidth);
    expect(box.borderRadius).toBe(defaultTheme.quote.borderRadius);
    expect(box.paddingTop).toBe(defaultTheme.quote.paddingVertical);
    // No textInset on the box itself: a layout inset spanning the whole
    // quote would overlap the insets of everything inside it, which sums on
    // Android but assigns on iOS (see insetSegments).
    expect(box.textInset).toBeUndefined();

    const indents = decorations.filter((d) => d.kind === 'indent');
    expect(indents).toHaveLength(1);
    expect([indents[0].start, indents[0].end]).toEqual([0, projected.text.length]);
    // Bar plus the body's inset from it — the same sum the fallback's quote
    // view produces with borderLeftWidth + paddingLeft.
    expect(indents[0].textInset).toBe(
      defaultTheme.quote.barWidth + defaultTheme.quote.indent,
    );
    expect(indents[0].hang).toBe(0);
  });

  test('nested blockquotes indent one quoteStep per level, disjoint', () => {
    const { projected, decorations } = decorate('> outer\n> > inner\n');
    expect(projected.text).toBe('outer\n\ninner');
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;

    const indents = decorations
      .filter((d) => d.kind === 'indent')
      .sort((a, b) => a.start - b.start);
    expect(indents).toHaveLength(2);
    expect(indents[0].textInset).toBe(quoteStep);
    expect(indents[1].textInset).toBe(quoteStep * 2);
    expect(projected.text.slice(indents[1].start, indents[1].end)).toBe('inner');
    expect(indents[0].end).toBeLessThanOrEqual(indents[1].start);

    // Every nesting level draws its OWN rail: the outer quote's bar at the
    // margin, the inner's one quoteStep in — not underneath the outer's,
    // which is what an inset-less inner box painted.
    const bars = decorations
      .filter((d) => d.kind === 'box' && d.barColor !== undefined)
      .sort((a, b) => a.start - b.start);
    expect(bars).toHaveLength(2);
    expect(bars[0].inset).toBeUndefined();
    expect(bars[1].inset).toBe(quoteStep);
  });

  test('an immediately nested quote (equal ranges) still offsets its bar', () => {
    // `> > inner` alone: the inner quote projects EXACTLY its parent's
    // range, so containment cannot rank the two — mark order (outermost
    // first) is what does. The regression this pins: both bars at x = 0,
    // reading as one rail.
    const { projected, decorations } = decorate('> > inner\n');
    expect(projected.text).toBe('inner');
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;

    const bars = decorations.filter(
      (d) => d.kind === 'box' && d.barColor !== undefined,
    );
    expect(bars).toHaveLength(2);
    expect(bars[0].inset).toBeUndefined();
    expect(bars[1].inset).toBe(quoteStep);

    const indents = decorations.filter((d) => d.kind === 'indent');
    expect(indents).toHaveLength(1);
    expect(indents[0].textInset).toBe(quoteStep * 2);
  });

  test('a list inside a blockquote folds the quote inset into its indent', () => {
    const { projected, decorations } = decorate('> - one\n> - two\n');
    expect(projected.text).toBe('• one\n• two');
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;

    const indents = decorations.filter((d) => d.kind === 'indent');
    expect(indents).toHaveLength(2);
    for (const indent of indents) {
      // The marker column starts where the quote body does; wrapped lines
      // still hang one listIndent under the item's text.
      expect(indent.textInset).toBe(quoteStep);
      expect(indent.hang).toBe(defaultTheme.spacing.listIndent);
    }
  });

  test('a code block inside a blockquote folds the quote inset into its box', () => {
    const { projected, decorations } = decorate(
      '> before\n>\n> ```\n> code\n> ```\n',
    );
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;

    const code = decorations.find((d) => d.kind === 'box' && d.color === defaultTheme.colors.codeBackground);
    if (!code) throw new Error('no code box');
    expect(code.textInset).toBe(defaultTheme.spacing.codePadding + quoteStep);
    // The band itself moves off the bar too, not just its text: without the
    // draw inset the box's opaque fill would paint from x = 0 across the
    // quote bar (the fallback nests the island inside the quote's padding).
    expect(code.inset).toBe(quoteStep);

    // The quote's own indent stops where the island starts.
    for (const indent of decorations.filter((d) => d.kind === 'indent')) {
      expect(indent.end <= code.start || indent.start >= code.end).toBe(true);
    }
  });

  test('a top-level island carries no draw inset', () => {
    const { decorations } = decorate('```\ncode\n```\n\nAfter.\n');
    const code = decorations.find((d) => d.kind === 'box');
    if (!code) throw new Error('no code box');
    expect(code.inset).toBeUndefined();
  });

  test('a table inside a blockquote insets its border, band and row rules alike', () => {
    const { decorations } = decorate(
      '> | a | b |\n> | - | - |\n> | c | d |\n',
    );
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;

    const border = decorations.find(
      (d) => d.kind === 'box' && d.borderColor !== undefined,
    );
    const band = decorations.find(
      (d) => d.kind === 'box' && d.color === defaultTheme.colors.tableHeaderBackground,
    );
    if (!border || !band) throw new Error('no table chrome');
    expect(border.inset).toBe(quoteStep);
    expect(border.textInset).toBe(defaultTheme.table.cellPaddingH + quoteStep);
    // The header band shares the border's edges inside the quote too.
    expect(band.inset).toBe(quoteStep);
    // Row rules end on the border's edges instead of crossing the bar.
    const rowRules = decorations.filter((d) => d.kind === 'rule');
    expect(rowRules.length).toBeGreaterThan(0);
    for (const rule of rowRules) {
      expect(rule.inset).toBe(quoteStep);
    }
  });

  test('a thematic break inside a blockquote folds the quote inset into its rule', () => {
    const { decorations } = decorate('> above\n>\n> ---\n>\n> below\n');
    const quoteStep = defaultTheme.quote.barWidth + defaultTheme.quote.indent;
    const rule = decorations.find((d) => d.kind === 'rule');
    if (!rule) throw new Error('no rule');
    expect(rule.align).toBe('center');
    expect(rule.inset).toBe(defaultTheme.rule.inset + quoteStep);
  });

  test('every decoration points into the text and none changes it', () => {
    const source =
      '# Title\n\n```py\nx = 1\n```\n\n| h | i |\n| - | - |\n| j | k |\n\n---\n\nDone.\n';
    const { projected, decorations } = decorate(source);
    const bare = project(source);
    // Same text with and without derivation — decorations are read-only.
    expect(projected.text).toBe(bare.text);
    for (const decoration of decorations) {
      expect(decoration.start).toBeGreaterThanOrEqual(0);
      expect(decoration.end).toBeGreaterThanOrEqual(decoration.start);
      expect(decoration.end).toBeLessThanOrEqual(projected.text.length);
    }
  });
});
