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
import { resolveRunAttributes } from './runAttributes';
import type { RunTextAttribute } from './runAttributes';
import { defaultTheme, headingFontSize, mergeTheme } from './theme';

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
    expect(style.fontSize).toBe(headingFontSize(theme, 2));
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
    expect(heading.lineHeight).toBe(
      headingFontSize(theme, 1) * theme.fonts.lineHeight,
    );
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
    expect(styleAt(plain, run.text.indexOf('Big')).lineHeight).toBe(
      headingFontSize(theme, 1) * theme.fonts.lineHeight,
    );
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
    expect(bold.fontSize).toBe(headingFontSize(theme, 1));
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
      const body = styleAt(resolveRunAttributes(run, theme), run.text.indexOf('cite'));
      expect(at.color).toBe(body.color);
      expect(at.textDecorationLine).toBe(body.textDecorationLine);
    });

    test('a heading colour survives a blocked link inside it', () => {
      const run = project('# Title [3](#src-citation-3)', KEEP_BLOCKED);
      const attributes = resolveRunAttributes(run, theme);
      expect(styleAt(attributes, run.text.indexOf('3')).color).toBe(
        styleAt(attributes, run.text.indexOf('Title')).color,
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
    for (const attribute of resolveRunAttributes(run, theme)) {
      expect(attribute.start).toBeGreaterThanOrEqual(0);
      expect(attribute.end).toBeLessThanOrEqual(run.text.length);
      expect(attribute.start).toBeLessThan(attribute.end);
    }
  });
});

/*
 * Embed geometry attributes need no parser: `resolveRunAttributes` reads the
 * projection object alone, so these cases hand-build one — which also keeps
 * them running on a machine with no compiled addon.
 */
