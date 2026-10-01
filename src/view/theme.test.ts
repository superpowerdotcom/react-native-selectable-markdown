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
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeTheme({ colors: { quoteBar: '#e11d48' } });
    expect(merged.quote.barColor).toBe('#e11d48');
    expect(merged.colors.quoteBar).toBe('#e11d48');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('colors.quoteBar is deprecated'));
    mergeTheme({ colors: { quoteBar: '#123456' } });
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
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
      '#3d444d',
    );
    expect(mergeTheme({}, defaultTheme).quote.barColor).toBe('#c9ced6');
  });
});

describe('the image box', () => {
  test('both dimensions ship a default, and both are overridable', () => {
    expect(defaultTheme.spacing.imageHeight).toBeGreaterThan(0);
    expect(defaultTheme.spacing.imageWidth).toBeGreaterThan(0);

    const merged = mergeTheme({ spacing: { imageWidth: 320, imageHeight: 180 } });

    expect(merged.spacing.imageWidth).toBe(320);
    expect(merged.spacing.imageHeight).toBe(180);
  });
});

describe('deprecated tokens are inputs only', () => {
  test('neither default theme ships colors.quoteBar', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeTheme(undefined, defaultTheme).colors.quoteBar).toBeUndefined();
    expect(mergeTheme(undefined, defaultDarkTheme).colors.quoteBar).toBeUndefined();
    expect(
      mergeTheme({ colors: { quoteBar: '#e11d48' } }, defaultDarkTheme).colors
        .quoteBar,
    ).toBe('#e11d48');
    warning.mockRestore();
  });

  test('an explicit quote.barColor leaves colors.quoteBar unset', () => {
    const merged = mergeTheme({ quote: { barColor: '#123456' } });
    expect(merged.quote.barColor).toBe('#123456');
    expect(merged.colors.quoteBar).toBeUndefined();
  });
});

describe('unknown theme tokens warn in DEV', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('a token that does not exist warns, naming it and the group', () => {
    // `fonts.family` is the key the README once taught; the body face is `fonts.body`.
    const merged = mergeTheme({
      fonts: { baseSize: 16, family: 'Inter' },
    } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('fonts.family');
    expect(warn.mock.calls[0][0]).toContain('body');
    expect(merged.fonts.baseSize).toBe(16);
    expect(merged.fonts.body).toBe(defaultTheme.fonts.body);
  });

  test('the warning is once per token, not once per merge', () => {
    mergeTheme({ colors: { accent: '#f00' } } as unknown as PartialTheme);
    mergeTheme({ colors: { accent: '#0f0' } } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('colors.accent');
  });

  test('a group that does not exist warns too', () => {
    mergeTheme({ typography: { size: 12 } } as unknown as PartialTheme);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('typography');
  });

  test('deprecated aliases and optional unset tokens do not warn', () => {
    // Declared but absent from `defaultTheme`, so a check built from its keys would flag them.
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

    // Filtered: `colors.quoteBar` also logs its own deprecation notice.
    const unknownTokenWarnings = () =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('Unknown theme'));
    expect(unknownTokenWarnings()).toEqual([]);

    mergeTheme({
      colors: { listMarker: '#0f0', listMarkr: '#0f0' },
      fonts: { strongFamily: 'Inter-Medium' },
    } as unknown as PartialTheme);

    expect(unknownTokenWarnings()).toHaveLength(1);
    expect(unknownTokenWarnings()[0]).toContain('"colors.listMarkr"');
  });
});
