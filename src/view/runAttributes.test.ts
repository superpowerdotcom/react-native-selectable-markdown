/**
 * The native host's styling, and the projection marks it is built from.
 *
 * These two halves used to not exist at all: `RunHost` handed the native
 * component nothing but `text`, so every run on a device with the native
 * module linked rendered as undifferentiated system text — no headings, no
 * emphasis, no link colour, and spoiler content in the clear. The invariant
 * that makes the fix safe, and the one asserted hardest here, is that
 * attributing the text does not move it: marks and attributes only ever
 * describe ranges of `ProjectedRun.text`, never change it.
 */

/* `theme.ts` reaches for `Platform.select` to pick default font families, and
 * React Native's entry point is ESM that this Node test environment cannot
 * load (the same reason the rest of the suite keeps RN out of the core). The
 * one API used is stubbed rather than pulling a whole RN preset in. */
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
import type { ProjectedRun, RunMark } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { ClassifyBlock } from '../selection/runs';
import {
  resetUnpairedFontSizeWarningsForTests,
  resolveRunAttributes,
} from './runAttributes';
import type { RunTextAttribute } from './runAttributes';
import { defaultTheme, mergeTheme } from './theme';

const EVERYTHING: EngineOptions = presets.everything;

/** Project the first non-standalone run of `source`. */
function project(
  source: string,
  options: EngineOptions = EVERYTHING,
  classifyBlock?: ClassifyBlock,
): ProjectedRun {
  const doc = parseDocument(source, options);
  const run = segmentRuns(doc, { classifyBlock }).find((r) => !r.standalone);
  if (!run) throw new Error(`no prose run in ${JSON.stringify(source)}`);
  return projectRun(run, doc);
}

/**
 * Forces every block into a prose run.
 *
 * `segmentRuns` makes a block carrying a spoiler standalone, because a spoiler
 * owns a tap target and the native host cannot offer one. That is the right
 * default and it is asserted in `runs.test.ts` — but it is not the *only*
 * configuration: `classifyBlock` is the documented seam for an app that wants
 * such a block inside a run anyway, and it is exactly that app whose spoilers
 * are protected by nothing but the mask attribute below.
 */
const ALWAYS_FLOWING: ClassifyBlock = () => 'flowing';

/** Every mark of `kind`, with the text it covers. */
function marksOf(run: ProjectedRun, kind: RunMark['kind']): { text: string; level?: number }[] {
  return run.marks
    .filter((m) => m.kind === kind)
    .map((m) => (m.level === undefined
      ? { text: run.text.slice(m.start, m.end) }
      : { text: run.text.slice(m.start, m.end), level: m.level }));
}

/** The style a character ends up with once every covering range is applied. */
function styleAt(attributes: RunTextAttribute[], index: number): Partial<RunTextAttribute> {
  const out: Partial<RunTextAttribute> = {};
  for (const attribute of attributes) {
    if (index < attribute.start || index >= attribute.end) continue;
    const { start: _s, end: _e, ...style } = attribute;
    Object.assign(out, style);
  }
  return out;
}

/*
 * Every case below parses through the package default —
 * `parseDocument(source, options)` with no engine argument, the call
 * `SelectableMarkdown` itself makes. That default is the md4c engine, and
 * nothing links it in a Node worker on its own, so this does what a launched
 * app's `installNativeEngine()` does. Without a compiled addon there is no
 * parser at all and `describeNative` reports these blocks as skipped rather
 * than failing; see src/engine/native/__tests__/support.ts.
 */
linkNativeEngineAsDefault();

describeNative('projection marks', () => {
  test('cover exactly the text of their construct', () => {
    const run = project('A **bold** and *soft* and `code` here.\n');
    expect(marksOf(run, 'strong')).toEqual([{ text: 'bold' }]);
    expect(marksOf(run, 'emphasis')).toEqual([{ text: 'soft' }]);
    expect(marksOf(run, 'code')).toEqual([{ text: 'code' }]);
  });

  test('a heading carries its level', () => {
    const run = project('### Third\n');
    expect(marksOf(run, 'heading')).toEqual([{ text: 'Third', level: 3 }]);
  });

  test('nest, outermost first, so the inner construct wins', () => {
    const run = project('# A **b** c\n');
    const kinds = run.marks.map((m) => m.kind);
    expect(kinds).toEqual(['heading', 'strong']);
    const [heading, strong] = run.marks;
    expect(heading.start).toBeLessThanOrEqual(strong.start);
    expect(heading.end).toBeGreaterThanOrEqual(strong.end);
  });

  test('never move the projected text', () => {
    // The whole safety argument for attributing the native host: the text it
    // renders is byte-identical with and without marks, so selection offsets
    // and the piece table are untouched by styling.
    const source = '# Title\n\nA **bold** [link](https://e.com) and `code`.\n\n- one\n- two\n';
    const doc = parseDocument(source, EVERYTHING);
    const run = segmentRuns(doc).find((r) => !r.standalone);
    if (!run) throw new Error('no run');
    const projected = projectRun(run, doc);
    for (const mark of projected.marks) {
      expect(mark.start).toBeGreaterThanOrEqual(0);
      expect(mark.end).toBeLessThanOrEqual(projected.text.length);
      expect(mark.start).toBeLessThan(mark.end);
    }
    // Pieces still tile the text exactly — the contract mapping depends on.
    expect(projected.pieces[0].textStart).toBe(0);
    expect(projected.pieces[projected.pieces.length - 1].textEnd).toBe(
      projected.text.length,
    );
  });

  test('a link that cannot be followed carries no link mark', () => {
    // Matches the `link` renderer, which drops the affordance for a blocked
    // href. The two paths must agree about what looks tappable.
    const blocked = project('[x](javascript:alert(1))\n', {
      ...EVERYTHING,
      urlPolicy: { linkPrefixes: ['https:'], imagePrefixes: ['https:'] },
    });
    expect(marksOf(blocked, 'link')).toEqual([]);
    const allowed = project('[x](https://e.com)\n');
    expect(marksOf(allowed, 'link')).toEqual([{ text: 'x' }]);
  });

  test('an autolink is a link', () => {
    const run = project('see https://example.com now\n');
    expect(marksOf(run, 'link')).toEqual([{ text: 'https://example.com' }]);
  });
});

describeNative('resolveRunAttributes', () => {
  const theme = defaultTheme;

  test('an empty run needs no attributes at all', () => {
    expect(resolveRunAttributes({ text: '', pieces: [], marks: [] }, theme)).toEqual([]);
    expect(
      resolveRunAttributes({ text: 'a', pieces: [], marks: [] }, theme).map(
        (a) => [a.start, a.end],
      ),
    ).toEqual([[0, 1]]);
  });

  test('every character starts from the body style', () => {
    const run = project('plain text\n');
    const [base, ...rest] = resolveRunAttributes(run, theme);
    expect(base).toEqual({
      start: 0,
      end: run.text.length,
      fontFamily: theme.fonts.body,
      fontSize: theme.fonts.baseSize,
      lineHeight: theme.fonts.baseSize * theme.fonts.lineHeight,
      fontWeight: '400',
      fontStyle: 'normal',
      textDecorationLine: 'none',
      color: theme.colors.text,
    });
    expect(rest).toEqual([]);
  });

  test('a heading is sized and coloured from the theme', () => {
    const run = project('## Heading\n');
    const attributes = resolveRunAttributes(run, theme);
    const style = styleAt(attributes, run.text.indexOf('Heading'));
    expect(style.fontSize).toBe(22);
    expect(style.color).toBe(theme.colors.heading);
    expect(style.fontWeight).toBe('700');
  });

  test('line height follows the font size, on the base run and on a heading', () => {
    // The native host has no natural leading to fall back on that agrees with
    // the fallback tree's, so both values are sent explicitly and both have to
    // scale with the size they belong to. A heading that inherited the body's
    // line height would measure — and under Fabric, lay out — too short for
    // its own glyphs.
    const run = project('# Big\n\nbody\n');
    const attributes = resolveRunAttributes(run, theme);

    const body = styleAt(attributes, run.text.indexOf('body'));
    expect(body.lineHeight).toBe(theme.fonts.baseSize * theme.fonts.lineHeight);

    const heading = styleAt(attributes, run.text.indexOf('Big'));
    expect(heading.lineHeight).toBe(36.4);
    expect(heading.lineHeight).toBeGreaterThan(body.lineHeight as number);
  });

  test('a mark that does not change the font size does not change the leading', () => {
    // Line height is only ever set alongside a font size, so a code span or a
    // link inherits the base run's leading rather than resetting it. Setting
    // it per mark would fragment the paragraph style on iOS, where line height
    // is a paragraph attribute and the last range applied over a paragraph
    // wins for the whole of it.
    const run = project('a `code` [x](https://e.com) **b**\n');
    const attributes = resolveRunAttributes(run, theme);
    for (const attribute of attributes.slice(1)) {
      expect(attribute.lineHeight).toBeUndefined();
    }
    expect(styleAt(attributes, run.text.indexOf('code')).lineHeight).toBe(
      theme.fonts.baseSize * theme.fonts.lineHeight,
    );
  });

  test('a consumer line-height multiplier reaches the native host', () => {
    const custom = mergeTheme({ fonts: { baseSize: 20, lineHeight: 2 } });
    const run = project('plain text\n');
    expect(styleAt(resolveRunAttributes(run, custom), 0).lineHeight).toBe(40);
  });

  test('headings.lineHeight pins every level to one absolute leading', () => {
    // A design that lays headings on the body's grid: the multiplier cannot
    // express it (h1 would get fontSize × multiplier), the token can.
    const custom = mergeTheme({ headings: { lineHeight: 24 } });
    const run = project('# Big\n\n###### Small\n');
    const attributes = resolveRunAttributes(run, custom);
    expect(styleAt(attributes, run.text.indexOf('Big')).lineHeight).toBe(24);
    expect(styleAt(attributes, run.text.indexOf('Small')).lineHeight).toBe(24);
    // Unset (the default) keeps the multiplier behaviour.
    const plain = resolveRunAttributes(run, theme);
    expect(styleAt(plain, run.text.indexOf('Big')).lineHeight).toBe(36.4);
  });

  test('strongFamily and colors.strong restyle bold only when set', () => {
    const run = project('a **b**\n');
    // Unset: weight alone, no family or colour contribution.
    const plain = styleAt(resolveRunAttributes(run, theme), run.text.indexOf('b'));
    expect(plain.fontWeight).toBe(theme.fonts.strongWeight);
    expect(plain.fontFamily).toBe(theme.fonts.body); // from the base run
    expect(plain.color).toBe(theme.colors.text);
    // The single-face-family design: bold is a family swap in its own shade,
    // with the weight pinned back so iOS cannot resolve it to regular.
    const custom = mergeTheme({
      fonts: { strongFamily: 'MyFont-Medium', strongWeight: '400' },
      colors: { strong: '#27272A' },
    });
    const styled = styleAt(
      resolveRunAttributes(run, custom),
      run.text.indexOf('b'),
    );
    expect(styled.fontFamily).toBe('MyFont-Medium');
    expect(styled.fontWeight).toBe('400');
    expect(styled.color).toBe('#27272A');
  });

  test('an inner mark overrides an outer one, and inherits the rest', () => {
    const run = project('# A **b** c\n');
    const attributes = resolveRunAttributes(run, theme);
    const bold = styleAt(attributes, run.text.indexOf('b', 2));
    expect(bold.fontWeight).toBe('700');
    // Still a heading: size and colour survive the inner mark.
    expect(bold.fontSize).toBe(26);
    expect(bold.color).toBe(theme.colors.heading);
  });

  test('a spoiler paints its text with the mask colour', () => {
    // The one styling gap that was a confidentiality bug: unattributed, the
    // native host displayed hidden spoiler content in the clear. A spoiler
    // only reaches a run at all when a consumer claims its block as flowing
    // (see ALWAYS_FLOWING) — but in that configuration this attribute is the
    // whole of the protection, so it is the configuration worth testing.
    const run = project('before ||hidden|| after\n', EVERYTHING, ALWAYS_FLOWING);
    expect(run.text).toContain('hidden');
    const attributes = resolveRunAttributes(run, theme);
    const style = styleAt(attributes, run.text.indexOf('hidden'));
    expect(style.color).toBe(theme.colors.spoilerMask);
    expect(style.backgroundColor).toBe(theme.colors.spoilerMask);
    // ...and the surrounding prose is untouched.
    expect(styleAt(attributes, 0).color).toBe(theme.colors.text);
  });

  test('a consumer theme flows all the way through', () => {
    const custom = mergeTheme({ colors: { link: '#ff00ff' }, fonts: { baseSize: 22 } });
    const run = project('a [link](https://e.com)\n');
    const attributes = resolveRunAttributes(run, custom);
    expect(styleAt(attributes, 0).fontSize).toBe(22);
    const link = styleAt(attributes, run.text.indexOf('link'));
    expect(link.color).toBe('#ff00ff');
    expect(link.textDecorationLine).toBe('underline');
  });

  describe("blockedLink (urlPolicy.blockedLinks: 'node')", () => {
    // A blocked link now carries a mark where it previously carried none, so
    // the thing worth asserting is that the NEW mark is invisible until a
    // consumer opts in. Two ways it could go wrong, and the second is why the
    // colour is optional rather than defaulted:
    //
    //   1. an unconditional colour would restyle every existing consumer's
    //      blocked schemes without them asking;
    //   2. marks apply outermost-first with the inner winning, so ANY colour
    //      returned for a blocked link inside a heading would override the
    //      heading colour — a visible regression in a construct that used to
    //      render as plain heading text.
    const KEEP_BLOCKED: EngineOptions = {
      ...EVERYTHING,
      urlPolicy: { linkPrefixes: ['https://'], blockedLinks: 'node' },
    };

    test('the mark exists and covers exactly the label', () => {
      const run = project('cite [3](#src-citation-3) here', KEEP_BLOCKED);
      expect(marksOf(run, 'blockedLink')).toEqual([{ text: '3' }]);
    });

    test('it contributes nothing when the theme does not set a colour', () => {
      const run = project('cite [3](#src-citation-3) here', KEEP_BLOCKED);
      const at = styleAt(resolveRunAttributes(run, theme), run.text.indexOf('3'));
      // Identical to the body text beside it — which is what these ranges
      // looked like before the mark existed.
      expect(at.color).toBe(theme.colors.text);
      expect(at.textDecorationLine).toBe('none');
    });

    test('a heading colour survives a blocked link inside it', () => {
      const run = project('# Title [3](#src-citation-3)', KEEP_BLOCKED);
      const attributes = resolveRunAttributes(run, theme);
      expect(styleAt(attributes, run.text.indexOf('3')).color).toBe(
        theme.colors.heading,
      );
    });

    test('an opted-in theme colours it, and still does not underline it', () => {
      const custom = mergeTheme({ colors: { blockedLink: '#FC5F2B' } });
      const run = project('cite [3](#src-citation-3) here', KEEP_BLOCKED);
      const at = styleAt(resolveRunAttributes(run, custom), run.text.indexOf('3'));
      expect(at.color).toBe('#FC5F2B');
      // No underline even when coloured: the policy refused this href as a
      // destination, and an underline is the affordance that reads "navigates".
      expect(at.textDecorationLine).not.toBe('underline');
    });

    test('a live link in the same run keeps the link colour and underline', () => {
      const custom = mergeTheme({ colors: { blockedLink: '#FC5F2B', link: '#0000ff' } });
      const run = project('[a](https://e.com) and [3](#src-citation-3)', KEEP_BLOCKED);
      const attributes = resolveRunAttributes(run, custom);
      const live = styleAt(attributes, run.text.indexOf('a'));
      expect(live.color).toBe('#0000ff');
      expect(live.textDecorationLine).toBe('underline');
      expect(styleAt(attributes, run.text.indexOf('3')).color).toBe('#FC5F2B');
    });
  });

  describe('attributeForMark', () => {
    // The seam that exists because one colour per kind is not enough: an app
    // whose URL policy rejects both a citation marker (the reader should see it)
    // and an entity reference (should read as ordinary prose) has to tell them
    // apart, and the href is the only thing that can.
    const KEEP_BLOCKED: EngineOptions = {
      ...EVERYTHING,
      urlPolicy: { linkPrefixes: ['https://'], blockedLinks: 'node' },
    };

    const CITATION = /-citation-\d+$/;
    const byMark = (mark: RunMark) => {
      if (mark.kind === 'link') return undefined; // keep the theme's link style
      if (mark.kind !== 'blockedLink') return undefined;
      const href = mark.href ?? '';
      if (CITATION.test(href)) return { color: '#FC5F2B', backgroundColor: '#FFEBE0' };
      return {}; // every other blocked scheme reads as body text
    };

    test('styles two blocked hrefs differently in the same run', () => {
      const run = project(
        'see [3](#src-citation-3) and [iron](product://iron) here',
        KEEP_BLOCKED,
      );
      const attributes = resolveRunAttributes(run, theme, byMark);
      const citation = styleAt(attributes, run.text.indexOf('3'));
      expect(citation.color).toBe('#FC5F2B');
      expect(citation.backgroundColor).toBe('#FFEBE0');
      // The product reference is indistinguishable from the prose around it.
      const body = styleAt(attributes, run.text.indexOf('see'));
      const product = styleAt(attributes, run.text.indexOf('iron'));
      expect(product.color).toBe(body.color);
      expect(product.backgroundColor).toBe(body.backgroundColor);
    });

    test('returning undefined defers to the theme', () => {
      const run = project('a [link](https://e.com) b', KEEP_BLOCKED);
      const attributes = resolveRunAttributes(run, theme, byMark);
      const live = styleAt(attributes, run.text.indexOf('link'));
      expect(live.color).toBe(theme.colors.link);
      expect(live.textDecorationLine).toBe('underline');
    });

    test('an empty object overrides a theme token the consumer set', () => {
      // `{}` and `undefined` must not mean the same thing: with
      // `colors.blockedLink` set, only `{}` can put a range back to body text.
      const custom = mergeTheme({ colors: { blockedLink: '#FC5F2B' } });
      const run = project('x [iron](product://iron) y', KEEP_BLOCKED);
      const suppressed = styleAt(
        resolveRunAttributes(run, custom, byMark),
        run.text.indexOf('iron'),
      );
      const themed = styleAt(
        resolveRunAttributes(run, custom),
        run.text.indexOf('iron'),
      );
      expect(themed.color).toBe('#FC5F2B');
      expect(suppressed.color).toBe(custom.colors.text);
    });

    test('every mark is offered, not only link-shaped ones', () => {
      const calls: string[] = [];
      const run = project('**bold** and [a](https://e.com) and `code`', KEEP_BLOCKED);
      resolveRunAttributes(run, theme, (mark) => {
        calls.push(mark.kind);
        return undefined;
      });
      // Every mark is offered now, not only the link-shaped ones — that is the
      // generalisation: a consumer pins heading sizes and the bold face here too.
      expect(calls).toEqual(['strong', 'link', 'code']);
    });
  });

  test('every attribute range is in bounds', () => {
    const source = '# T\n\n> quoted **b**\n\n- a `c`\n- ~~d~~\n\nhttps://e.com\n';
    const run = project(source);
    const attributes = resolveRunAttributes(run, theme);
    for (const attribute of attributes) {
      expect(attribute.start).toBeGreaterThanOrEqual(0);
      expect(attribute.end).toBeLessThanOrEqual(run.text.length);
      expect(attribute.start).toBeLessThan(attribute.end);
    }
    expect(attributes.map((a) => run.text.slice(a.start, a.end))).toEqual([
      run.text,
      'T',
      'quoted b',
      'b',
      '• a c',
      'c',
      '• d',
      'd',
      'https://e.com',
    ]);
    expect(run.text).toBe('T\n\nquoted b\n\n• a c\n• d\n\nhttps://e.com');
  });
});

/*
 * Embed geometry attributes need no parser: `resolveRunAttributes` reads the
 * projection object alone, so these cases hand-build one — which also keeps
 * them running on a machine with no compiled addon.
 */
describeNative('semantic roles', () => {
  linkNativeEngineAsDefault();

  function rolesOf(run: ProjectedRun, attributes: RunTextAttribute[]) {
    return attributes
      .filter((a) => a.role !== undefined)
      .map((a) => ({
        role: a.role,
        level: a.roleLevel,
        text: run.text.slice(a.start, a.end),
      }));
  }

  function collectionsOf(run: ProjectedRun, attributes: RunTextAttribute[]) {
    return attributes
      .filter((a) => a.role !== undefined)
      .map((a) => ({
        role: a.role,
        text: run.text.slice(a.start, a.end),
        row: a.roleRow,
        rowCount: a.roleRowCount,
        column: a.roleColumn,
        columnCount: a.roleColumnCount,
      }));
  }

  test('every heading in a merged run carries its role and its level', () => {
    const run = project('# One\n\nBody.\n\n### Three\n\nMore.\n');
    expect(run.text).toContain('One');
    expect(run.text).toContain('Three');

    expect(rolesOf(run, resolveRunAttributes(run, defaultTheme))).toEqual([
      { role: 'heading', level: 1, text: 'One' },
      { role: 'heading', level: 3, text: 'Three' },
    ]);
  });

  test('nothing outside the three roles claims one', () => {
    const run = project(
      '**bold** and `code` and [a](https://example.com/x)\n\n> quoted\n\n- item\n\n```js\nx\n```\n',
      EVERYTHING,
      ALWAYS_FLOWING,
    );
    expect(rolesOf(run, resolveRunAttributes(run, defaultTheme))).toEqual([
      { role: 'listItem', level: 1, text: '\u2022 item' },
    ]);
  });

  test('a flowed list numbers its items, and a sublist numbers its own', () => {
    const run = project('Intro.\n\n- one\n- two\n  - deep\n- three\n');
    expect(collectionsOf(run, resolveRunAttributes(run, defaultTheme))).toEqual([
      { role: 'listItem', text: '\u2022 one', row: 1, rowCount: 3, column: undefined, columnCount: undefined },
      // Own text only; the sublist vends entries of its own.
      {
        role: 'listItem',
        text: '\u2022 two',
        row: 2,
        rowCount: 3,
        column: undefined,
        columnCount: undefined,
      },
      // The sublist is a collection of its own: "item 1 of 1", not "3 of 4".
      { role: 'listItem', text: '\u2022 deep', row: 1, rowCount: 1, column: undefined, columnCount: undefined },
      { role: 'listItem', text: '\u2022 three', row: 3, rowCount: 3, column: undefined, columnCount: undefined },
    ]);
    const levels = resolveRunAttributes(run, defaultTheme)
      .filter((a) => a.role === 'listItem')
      .map((a) => a.roleLevel);
    expect(levels).toEqual([1, 1, 2, 1]);
  });

  test('a parent list item stops where its sublist begins, on both hosts', () => {
    const run = project(
      '## Getting started\n\nSee the [installation guide](https://x.com/g) first.\n\n' +
        '- alpha item\n- beta item\n  - nested one\n  - nested two\n- gamma item\n\n' +
        '| h1 | h2 |\n| - | - |\n| a | b |\n| c | d |\n',
      EVERYTHING,
      ALWAYS_FLOWING,
    );
    const attributes = resolveRunAttributes(run, defaultTheme);
    expect(
      attributes
        .filter((a) => a.role === 'listItem')
        .map((a) => [run.text.slice(a.start, a.end), a.roleLevel, `${a.roleRow} of ${a.roleRowCount}`]),
    ).toEqual([
      ['• alpha item', 1, '1 of 3'],
      ['• beta item', 1, '2 of 3'],
      ['• nested one', 2, '1 of 2'],
      ['• nested two', 2, '2 of 2'],
      ['• gamma item', 1, '3 of 3'],
    ]);
    // Not even touching: iOS merges adjacent equal attribute runs back into one.
    const items = attributes.filter((a) => a.role === 'listItem');
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i].start).toBeGreaterThan(items[i - 1].end);
    }
  });

  test('one merged run can offer several grids of different shapes', () => {
    // Android's `RunAccessibility.collectionOf` reads these shapes off the wire.
    const run = project(
      '- alpha\n- beta\n  - nested one\n  - nested two\n- gamma\n\n' +
        '| h1 | h2 |\n| - | - |\n| a | b |\n| c | d |\n',
      EVERYTHING,
      ALWAYS_FLOWING,
    );
    const shapes = new Map<string, number>();
    for (const attribute of resolveRunAttributes(run, defaultTheme)) {
      if (attribute.roleRow === undefined) continue;
      const key = `${attribute.roleRowCount}x${attribute.roleColumnCount ?? 1}`;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    expect([...shapes.entries()]).toEqual([
      ['3x1', 3],
      ['2x1', 2],
      ['3x2', 6],
    ]);
  });

  test('a list item holding a table stops where the table begins', () => {
    const run = project(
      '- intro\n\n  | a | b |\n  | - | - |\n  | c | d |\n',
      EVERYTHING,
      ALWAYS_FLOWING,
    );
    const attributes = resolveRunAttributes(run, defaultTheme);
    const item = attributes.find((a) => a.role === 'listItem');
    expect(item).toBeDefined();
    expect(run.text.slice(item!.start, item!.end)).toBe('• intro');
    expect(
      attributes
        .filter((a) => a.role === 'tableCell')
        .map((a) => run.text.slice(a.start, a.end)),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  test('two lists separated by a blank line are two collections', () => {
    const run = project('- a\n- b\n\n* c\n');
    const rows = resolveRunAttributes(run, defaultTheme)
      .filter((a) => a.role === 'listItem')
      .map((a) => `${a.roleRow} of ${a.roleRowCount}`);
    expect(rows).toEqual(['1 of 2', '2 of 2', '1 of 1']);
  });

  test('a flowed table gives every cell its row and column', () => {
    const run = project('| a | b |\n| - | - |\n| c | d |\n', EVERYTHING, ALWAYS_FLOWING);
    expect(
      collectionsOf(run, resolveRunAttributes(run, defaultTheme)).filter(
        (entry) => entry.role === 'tableCell',
      ),
    ).toEqual([
      { role: 'tableCell', text: 'a', row: 1, rowCount: 2, column: 1, columnCount: 2 },
      { role: 'tableCell', text: 'b', row: 1, rowCount: 2, column: 2, columnCount: 2 },
      { role: 'tableCell', text: 'c', row: 2, rowCount: 2, column: 1, columnCount: 2 },
      { role: 'tableCell', text: 'd', row: 2, rowCount: 2, column: 2, columnCount: 2 },
    ]);
  });

  test('a list item role survives an attributeForMark that restyles it', () => {
    const run = project('- one\n- two\n');
    const attributes = resolveRunAttributes(run, defaultTheme, (mark) =>
      mark.kind === 'listItem' ? { color: '#ff0000' } : undefined,
    );
    expect(
      attributes
        .filter((a) => a.role === 'listItem')
        .map((a) => [a.roleRow, a.roleRowCount, a.color]),
    ).toEqual([
      [1, 2, '#ff0000'],
      [2, 2, '#ff0000'],
    ]);
  });

  test('a role survives an attributeForMark that returns nothing at all', () => {
    const run = project('# Title\n\nBody.\n');
    const attributes = resolveRunAttributes(run, defaultTheme, (mark) =>
      mark.kind === 'heading' ? {} : undefined,
    );
    expect(rolesOf(run, attributes)).toEqual([
      { role: 'heading', level: 1, text: 'Title' },
    ]);
    expect(styleAt(attributes, run.text.indexOf('Title')).fontSize).toBe(
      defaultTheme.fonts.baseSize,
    );
  });

  test('a run with no headings sends no role at all', () => {
    const run = project('Just prose, with *emphasis*.\n');
    const attributes = resolveRunAttributes(run, defaultTheme);
    expect(attributes.every((a) => a.role === undefined)).toBe(true);
    expect(attributes.every((a) => a.roleLevel === undefined)).toBe(true);
    const withHeading = project('# Head\n\nJust prose, with *emphasis*.\n');
    expect(rolesOf(withHeading, resolveRunAttributes(withHeading, defaultTheme))).toEqual([
      { role: 'heading', level: 1, text: 'Head' },
    ]);
  });
});

describe('semantic roles from synthetic marks', () => {
  function runWith(text: string, marks: RunMark[]): ProjectedRun {
    return {
      text,
      pieces: [{ textStart: 0, textEnd: text.length, source: { start: 0, end: text.length } }],
      marks,
    } as ProjectedRun;
  }

  test('a heading mark with no level is announced without one', () => {
    const run = runWith('Title', [{ kind: 'heading', start: 0, end: 5 }]);
    const heading = resolveRunAttributes(run, defaultTheme).find(
      (a) => a.role === 'heading',
    );
    expect(heading).toMatchObject({ start: 0, end: 5, role: 'heading' });
    expect(heading?.roleLevel).toBeUndefined();
    const leveled = resolveRunAttributes(
      runWith('Title', [{ kind: 'heading', start: 0, end: 5, level: 2 }]),
      defaultTheme,
    ).find((a) => a.role === 'heading');
    expect(leveled?.roleLevel).toBe(2);
  });

  test('a level outside 1-6 is dropped, and the role is kept', () => {
    const run = runWith('Title', [{ kind: 'heading', start: 0, end: 5, level: 9 }]);
    const heading = resolveRunAttributes(run, defaultTheme).find(
      (a) => a.role === 'heading',
    );
    expect(heading?.role).toBe('heading');
    expect(heading?.roleLevel).toBeUndefined();
    const six = resolveRunAttributes(
      runWith('Title', [{ kind: 'heading', start: 0, end: 5, level: 6 }]),
      defaultTheme,
    ).find((a) => a.role === 'heading');
    expect(six?.roleLevel).toBe(6);
  });
});

describe('embed geometry attributes', () => {
  const embedNode = { kind: 'link', span: { start: 4, end: 17 } };
  const projectedWithEmbed: ProjectedRun = {
    text: 'See ￼ here.',
    pieces: [
      { textStart: 0, textEnd: 4, source: { start: 0, end: 4 } },
      { textStart: 4, textEnd: 5, source: { start: 4, end: 17 } },
      { textStart: 5, textEnd: 11, source: { start: 17, end: 23 } },
    ],
    marks: [{ kind: 'embed', start: 4, end: 5, embedId: 0 }],
    embeds: [
      {
        embedId: 0,
        start: 4,
        end: 5,
        node: embedNode as never,
        content: { width: 200, height: 80, text: '[1]' },
      },
    ],
  };

  test('appends a transparent, height-carrying attribute over the placeholder', () => {
    const attributes = resolveRunAttributes(projectedWithEmbed, defaultTheme);

    expect(attributes[attributes.length - 1]).toEqual({
      start: 4,
      end: 5,
      color: 'transparent',
      lineHeight: 80,
    });
  });

  test('the geometry attribute sits after every mark attribute, so it wins innermost', () => {
    const withHeading: ProjectedRun = {
      ...projectedWithEmbed,
      marks: [
        { kind: 'heading', start: 0, end: 11, level: 1 },
        ...projectedWithEmbed.marks,
      ],
    };
    const attributes = resolveRunAttributes(withHeading, defaultTheme);
    const geometryIndex = attributes.findIndex(
      (attribute) => attribute.lineHeight === 80,
    );
    const headingIndex = attributes.findIndex(
      (attribute) => attribute.fontWeight === defaultTheme.headings.weight,
    );

    expect(geometryIndex).toBeGreaterThan(headingIndex);
  });

  test('attributeForMark never sees the embed mark and cannot drop the geometry', () => {
    const seen: string[] = [];
    const attributes = resolveRunAttributes(
      projectedWithEmbed,
      defaultTheme,
      (mark) => {
        seen.push(mark.kind);
        // "Suppress everything" — the geometry attribute must survive it.
        return {};
      },
    );

    expect(seen).not.toContain('embed');
    expect(attributes).toContainEqual({
      start: 4,
      end: 5,
      color: 'transparent',
      lineHeight: 80,
    });
  });

  test('a projection without embeds gains no geometry attribute', () => {
    const bare: ProjectedRun = {
      text: projectedWithEmbed.text,
      pieces: projectedWithEmbed.pieces,
      marks: [],
    };
    const attributes = resolveRunAttributes(bare, defaultTheme);

    expect(attributes).toHaveLength(1);
    expect(attributes[0].start).toBe(0);
  });
});

describe('embed geometry line-height floor', () => {
  const chipProjection = (height: number): ProjectedRun => ({
    text: 'See ￼ here.',
    pieces: [
      { textStart: 0, textEnd: 4, source: { start: 0, end: 4 } },
      { textStart: 4, textEnd: 5, source: { start: 4, end: 17 } },
      { textStart: 5, textEnd: 11, source: { start: 17, end: 23 } },
    ],
    marks: [{ kind: 'embed', start: 4, end: 5, embedId: 0 }],
    embeds: [
      {
        embedId: 0,
        start: 4,
        end: 5,
        node: { kind: 'link', span: { start: 4, end: 17 } } as never,
        content: { width: 40, height },
      },
    ],
  });

  test('a chip shorter than the line never shrinks it', () => {
    // Line height clamps in BOTH directions on both platforms, so a 10pt
    // chip must not squash the body line around it.
    const attributes = resolveRunAttributes(chipProjection(10), defaultTheme);
    const geometry = attributes[attributes.length - 1];
    const bodyLineHeight =
      defaultTheme.fonts.baseSize * defaultTheme.fonts.lineHeight;

    expect(geometry.lineHeight).toBe(bodyLineHeight);
  });

  test('a chip inside a heading floors at the heading line height', () => {
    const projected = chipProjection(10);
    projected.marks = [
      { kind: 'heading', start: 0, end: 11, level: 1 },
      ...projected.marks,
    ];
    const attributes = resolveRunAttributes(projected, defaultTheme);
    const geometry = attributes[attributes.length - 1];

    // h1 is 26pt at the default 1.4 multiplier.
    expect(geometry.lineHeight).toBe(36.4);
  });

  test('a card taller than the line raises it to the declared height', () => {
    const attributes = resolveRunAttributes(chipProjection(200), defaultTheme);
    const geometry = attributes[attributes.length - 1];

    expect(geometry.lineHeight).toBe(200);
  });

  describe('with several embeds', () => {
    // 'H ￼ x\n\nSee ￼ tail' — a chip inside a heading, a card in the body.
    const multi: ProjectedRun = {
      text: 'H ￼ x\n\nSee ￼ tail',
      pieces: [],
      marks: [
        { kind: 'heading', start: 0, end: 5, level: 1 },
        { kind: 'embed', start: 2, end: 3, embedId: 0 },
        { kind: 'embed', start: 11, end: 12, embedId: 1 },
      ],
      embeds: [
        {
          embedId: 0,
          start: 2,
          end: 3,
          node: { kind: 'link', span: { start: 0, end: 1 } } as never,
          content: { width: 40, height: 10 },
        },
        {
          embedId: 1,
          start: 11,
          end: 12,
          node: { kind: 'link', span: { start: 2, end: 3 } } as never,
          content: { width: 40, height: 12 },
        },
      ],
    };

    test('each placeholder floors on the marks that cover it, not on the run', () => {
      const attributes = resolveRunAttributes(multi, defaultTheme);
      const geometry = attributes.filter(
        (attribute) => attribute.color === 'transparent',
      );
      expect(geometry).toHaveLength(2);
      // Inside the heading: 26pt x 1.4.
      expect(geometry[0].lineHeight).toBe(36.4);
      // Outside it: the base, 16pt x 1.4.
      expect(geometry[1].lineHeight).toBe(22.4);
    });

    test("a tall card never raises another embed's floor", () => {
      const withTallCard: ProjectedRun = {
        ...multi,
        embeds: [
          { ...multi.embeds![0], content: { width: 300, height: 400 } },
          multi.embeds![1],
        ],
      };
      const geometry = resolveRunAttributes(withTallCard, defaultTheme).filter(
        (attribute) => attribute.color === 'transparent',
      );

      expect(geometry[0].lineHeight).toBe(400);
      expect(geometry[1].lineHeight).toBe(
        defaultTheme.fonts.baseSize * defaultTheme.fonts.lineHeight,
      );
    });

    test('a wide placeholder cannot retire a covering attribute out from under a narrow one', () => {
      // Breaks `ProjectedRunEmbed`'s `end === start + 1` on purpose: a wide placeholder encloses a narrow one.
      const nested: ProjectedRun = {
        text: 'ABCDEFGH',
        pieces: [],
        marks: [{ kind: 'heading', start: 0, end: 4, level: 1 }],
        embeds: [
          {
            embedId: 0,
            start: 0,
            end: 6,
            node: { kind: 'link', span: { start: 0, end: 1 } } as never,
            content: { width: 10, height: 1 },
          },
          {
            embedId: 1,
            start: 1,
            end: 2,
            node: { kind: 'link', span: { start: 1, end: 2 } } as never,
            content: { width: 10, height: 1 },
          },
        ],
      };
      const attributes = resolveRunAttributes(nested, defaultTheme);
      const geometry = attributes.filter(
        (attribute) => attribute.color === 'transparent',
      );

      expect(geometry).toHaveLength(2);
      // Runs past the heading's end: the body's 22.4.
      expect(geometry[0].lineHeight).toBe(22.4);
      // Inside the heading, asked before it retires: the h1's 36.4.
      expect(geometry[1].lineHeight).toBe(36.4);
    });
  });

  test.each([
    ['an infinite height', Number.POSITIVE_INFINITY, 40],
    ['an infinite width', 80, Number.POSITIVE_INFINITY],
    ['a NaN height', Number.NaN, 40],
    ['a zero height', 0, 40],
  ])(
    '%s reserves nothing: transparent placeholder, no line height',
    (_label, height, width) => {
      const projected = chipProjection(height);
      projected.embeds![0].content = { width, height };
      const attributes = resolveRunAttributes(projected, defaultTheme);

      expect(attributes[attributes.length - 1]).toEqual({
        start: 4,
        end: 5,
        color: 'transparent',
      });
    },
  );
});

// One mark kind per case: the warning is warn-once per kind.
describe('attributeForMark fontSize/lineHeight pairing warning', () => {
  function oneMark(kind: RunMark['kind'], level?: number): ProjectedRun {
    return {
      text: 'Heading',
      pieces: [{ textStart: 0, textEnd: 7, source: { start: 0, end: 7 } }],
      marks: [{ kind, start: 0, end: 7, ...(level === undefined ? {} : { level }) }],
    } as ProjectedRun;
  }

  let warn: jest.SpyInstance;
  beforeEach(() => {
    // The warned-kinds Set is module state, so each case resets it.
    resetUnpairedFontSizeWarningsForTests();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test('warns for a font size above the base with no line height', () => {
    const attributes = resolveRunAttributes(oneMark('heading', 1), defaultTheme, () => ({
      fontSize: 28,
    }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('lineHeight');
    expect(attributes[1]).toEqual({
      start: 0,
      end: 7,
      fontSize: 28,
      role: 'heading',
      roleLevel: 1,
    });
  });

  test('warns once per mark kind, not once per snapshot', () => {
    resolveRunAttributes(oneMark('heading', 2), defaultTheme, () => ({ fontSize: 30 }));
    resolveRunAttributes(oneMark('heading', 3), defaultTheme, () => ({ fontSize: 32 }));
    resolveRunAttributes(oneMark('heading', 2), defaultTheme, () => ({ fontSize: 30 }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fontSize 30 for a "heading" mark');
    resolveRunAttributes(oneMark('code'), defaultTheme, () => ({ fontSize: 30 }));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('fontSize 30 for a "code" mark');
  });

  test('a matching line height is the documented shape and is silent', () => {
    resolveRunAttributes(oneMark('strong'), defaultTheme, () => ({
      fontFamily: 'Tiempos-Bold',
      fontSize: 28,
      lineHeight: 34,
    }));
    expect(warn).not.toHaveBeenCalled();
    resolveRunAttributes(oneMark('strong'), defaultTheme, () => ({
      fontFamily: 'Tiempos-Bold',
      fontSize: 28,
    }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"strong" mark');
  });

  test('a size at or below the base is silent: a roomier box does not clip', () => {
    resolveRunAttributes(oneMark('code'), defaultTheme, () => ({
      fontSize: defaultTheme.fonts.baseSize,
    }));
    resolveRunAttributes(oneMark('emphasis'), defaultTheme, () => ({ fontSize: 11 }));
    expect(warn).not.toHaveBeenCalled();
    resolveRunAttributes(oneMark('code'), defaultTheme, () => ({
      fontSize: defaultTheme.fonts.baseSize + 1,
    }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fontSize 17 for a "code" mark');
  });

  test('the theme path never warns: it pairs the two itself', () => {
    const themed = resolveRunAttributes(oneMark('heading', 4), defaultTheme);
    resolveRunAttributes(oneMark('blockquote'), defaultTheme, () => undefined);
    expect(warn).not.toHaveBeenCalled();
    // h4 is 18pt (16 x 1.1, rounded) with its paired 1.4 leading.
    expect(themed[1]).toMatchObject({ fontSize: 18, lineHeight: 25.2 });
  });
});

describeNative('headings in list items', () => {
  test('a heading owns its text without a second marker-only item role', () => {
    const projected = project('- # Title');
    const roles = resolveRunAttributes(projected, defaultTheme).filter(attribute => attribute.role);
    expect(roles.filter(attribute => attribute.role === 'heading')).toHaveLength(1);
    expect(roles.filter(attribute => attribute.role === 'listItem')).toHaveLength(0);
    expect(roles.map((a) => [a.role, a.roleLevel, projected.text.slice(a.start, a.end)])).toEqual([
      ['heading', 1, 'Title'],
    ]);
  });
});
