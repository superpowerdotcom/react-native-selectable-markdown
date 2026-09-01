/**
 * The deprecation aliases in `mergeTheme`. Each one exists for the same
 * back-compat promise: a token that used to style something keeps styling it
 * after the schema grew a more specific home for the value — an existing
 * client theme touching only the old name must still visibly affect
 * rendering, while an explicit override of the new name always wins.
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
