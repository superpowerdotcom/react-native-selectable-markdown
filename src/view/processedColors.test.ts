const calls: string[] = [];

jest.mock('react-native', () => ({
  processColor: (color: string) => {
    calls.push(color);
    return color === 'not-a-colour' ? null : color.length;
  },
}));

import {
  MAX_PROCESSED_COLORS,
  memoizedProcessColor,
  processedColorCacheSize,
} from './processedColors';

beforeEach(() => {
  calls.length = 0;
});

describe('memoizedProcessColor', () => {
  it('converts once per distinct string', () => {
    const first = memoizedProcessColor('#1f2328');
    const second = memoizedProcessColor('#1f2328');

    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(calls).toEqual(['#1f2328']);
  });

  it('caches the null of a string it cannot parse', () => {
    expect(memoizedProcessColor('not-a-colour')).toBeNull();
    expect(memoizedProcessColor('not-a-colour')).toBeNull();

    expect(calls).toEqual(['not-a-colour']);
  });

  it('stays bounded when a consumer mints a colour per instance', () => {
    for (let i = 0; i < MAX_PROCESSED_COLORS * 4; i += 1) {
      memoizedProcessColor(`hsl(${i}, 50%, 50%)`);
    }

    expect(processedColorCacheSize()).toBeLessThanOrEqual(
      MAX_PROCESSED_COLORS,
    );
    // The last minted colour is still a hit; the first was evicted.
    calls.length = 0;
    memoizedProcessColor(`hsl(${MAX_PROCESSED_COLORS * 4 - 1}, 50%, 50%)`);
    memoizedProcessColor('hsl(0, 50%, 50%)');
    expect(calls).toEqual(['hsl(0, 50%, 50%)']);
  });

  it('still caches a token minted after the cap is reached', () => {
    for (let i = 0; i < MAX_PROCESSED_COLORS * 2; i += 1) {
      memoizedProcessColor(`hsl(${i}, 50%, 50%)`);
    }

    calls.length = 0;
    const token = 'rgb(1, 2, 3)';
    const first = memoizedProcessColor(token);
    const second = memoizedProcessColor(token);
    const third = memoizedProcessColor(token);

    expect(calls).toEqual([token]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('keeps converting correctly across an eviction', () => {
    const before = memoizedProcessColor('#abcdef');
    for (let i = 0; i < MAX_PROCESSED_COLORS + 1; i += 1) {
      memoizedProcessColor(`hsl(${i}, 10%, 10%)`);
    }

    expect(before).toBe(7);
    expect(memoizedProcessColor('#abcdef')).toBe(7);
  });
});
