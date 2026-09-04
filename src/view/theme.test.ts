/**
 * `mergeTheme`: its deprecation aliases, and its DEV guard against tokens
 * that do not exist.
 *
 * Each alias exists for the same back-compat promise: a token that used to
 * style something keeps styling it after the schema grew a more specific home
 * for the value — an existing client theme touching only the old name must
 * still visibly affect rendering, while an explicit override of the new name
 * always wins. What an alias does NOT do is ship a default of its own; see
 * 'deprecated tokens are inputs only'.
 */

/* `theme.ts` reaches for `Platform.select` to pick default font families;
 * stub the one API used rather than pulling a whole RN preset into a Node
 * test environment. */
jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) =>
      options.ios !== undefined ? options.ios : options.default,
  },
}));

import { defaultDarkTheme, defaultTheme, mergeTheme } from './theme';
import type { PartialTheme } from './theme';

describe('mergeTheme aliases', () => {
  test('colors.quoteBar alone recolours the quote bar (pre-`quote`-group themes)', () => {
    const merged = mergeTheme({ colors: { quoteBar: '#e11d48' } });
    expect(merged.quote.barColor).toBe('#e11d48');
    expect(merged.colors.quoteBar).toBe('#e11d48');
  });

  test('an explicit quote.barColor wins over colors.quoteBar', () => {
    const merged = mergeTheme({
      colors: { quoteBar: '#e11d48' },
      quote: { barColor: '#123456' },
    });
    expect(merged.quote.barColor).toBe('#123456');
  });

  test('code.borderRadius alone still rounds tables (the token that used to)', () => {
    const merged = mergeTheme({ code: { borderRadius: 12 } });
    expect(merged.code.borderRadius).toBe(12);
    expect(merged.table.borderRadius).toBe(12);
  });

  test('an explicit table.borderRadius wins over code.borderRadius', () => {
    const merged = mergeTheme({
      code: { borderRadius: 12 },
      table: { borderRadius: 0 },
    });
    expect(merged.code.borderRadius).toBe(12);
    expect(merged.table.borderRadius).toBe(0);
  });

  test('spacing.quoteIndent and spacing.tableCellPadding still feed their new homes', () => {
    const merged = mergeTheme({
      spacing: { quoteIndent: 24, tableCellPadding: 10 },
    });
    expect(merged.quote.indent).toBe(24);
    expect(merged.table.cellPaddingH).toBe(10);
    expect(merged.table.cellPaddingV).toBe(10);
  });

  test('aliases read only the overrides, whatever the base', () => {
    // A dark base with no overrides keeps its own bar colour — the alias
    // must never re-link the two defaults after the fact.
    expect(mergeTheme(undefined, defaultDarkTheme).quote.barColor).toBe(
      defaultDarkTheme.quote.barColor,
    );
    expect(mergeTheme({}, defaultTheme).quote.barColor).toBe(
      defaultTheme.quote.barColor,
    );
  });
});

describe('the image box', () => {
  test('both dimensions ship a default, and both are overridable', () => {
    // The two tokens are one box: `imageHeight` is the standalone `<Image>`'s
    // height AND the height an image embed reserves, and `imageWidth` is the
    // reserved width. A theme that resizes images has to be able to move the
    // reservation with them, or the picture and the space the host measured
    // for it stop agreeing.
    expect(defaultTheme.spacing.imageHeight).toBeGreaterThan(0);
    expect(defaultTheme.spacing.imageWidth).toBeGreaterThan(0);

    const merged = mergeTheme({ spacing: { imageWidth: 320, imageHeight: 180 } });

    expect(merged.spacing.imageWidth).toBe(320);
    expect(merged.spacing.imageHeight).toBe(180);
  });
});

describe('deprecated tokens are inputs only', () => {
  test('neither default theme ships colors.quoteBar', () => {
    // The alias is an accepted INPUT and nothing else. A shipped default for
    // it would be a readable colour on the theme that the rendered bar does
    // not follow: override `quote.barColor` alone and this token would sit
    // there still naming the old one, which is the trap its own doc comment
    // promises to avoid.
    expect(defaultTheme.colors.quoteBar).toBeUndefined();
    expect(defaultDarkTheme.colors.quoteBar).toBeUndefined();
  });

  test('an explicit quote.barColor leaves colors.quoteBar unset', () => {
    const merged = mergeTheme({ quote: { barColor: '#123456' } });
    expect(merged.quote.barColor).toBe('#123456');
    expect(merged.colors.quoteBar).toBeUndefined();
  });
});

/**
 * The DEV guard over override keys. `mergeGroup` copies every own key of an
 * override onto the merged theme, so a token that does not exist survives the
 * merge, is read by nothing, and changes no pixel — the failure mode is
 * silence. TypeScript rejects it as an excess property; an untyped JS theme
 * gets only this warning.
 */
describe('unknown theme tokens warn in DEV', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('a token that does not exist warns, naming it and the group', () => {
    // `fonts.family` is the one the README taught for two releases; the key
    // that actually sets the body face is `fonts.body`.
    const merged = mergeTheme({
      fonts: { baseSize: 16, family: 'Inter' },
    } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fonts.family');
    expect(warn.mock.calls[0][0]).toContain('body');
    // The rest of the group still merges, and the body face is untouched —
    // which is exactly why the warning has to exist.
    expect(merged.fonts.baseSize).toBe(16);
    expect(merged.fonts.body).toBe(defaultTheme.fonts.body);
  });

  test('the warning is once per token, not once per merge', () => {
    // `mergeTheme` re-runs whenever the theme's identity changes, so an
    // object literal passed inline would otherwise warn on every render.
    mergeTheme({ colors: { accent: '#f00' } } as unknown as PartialTheme);
    mergeTheme({ colors: { accent: '#0f0' } } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a group that does not exist warns too', () => {
    mergeTheme({ typography: { size: 12 } } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('typography');
  });

  test('deprecated aliases and optional unset tokens do not warn', () => {
    // Every one of these is declared: three deprecated inputs plus four
    // tokens that no default theme ships. A check built from `defaultTheme`'s
    // own keys would flag all seven.
    mergeTheme({
      colors: {
        quoteBar: '#e11d48',
        blockedLink: '#f00',
        listMarker: '#0f0',
        strong: '#00f',
      },
      spacing: { quoteIndent: 24, tableCellPadding: 10 },
      fonts: { strongFamily: 'Inter-Medium' },
      headings: { lineHeight: 24 },
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
