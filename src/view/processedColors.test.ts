/**
 * The `processColor` memo: it must stay bounded, and it must not stop caching.
 *
 * The bound exists because `attributeForMark` is the documented channel for
 * PER-INSTANCE styling — a colour minted per href, per heading level, per
 * citation id — and this map is module scope, so an unbounded one grows for
 * the life of the process. What the bound must NOT do is freeze: filling the
 * cap and refusing every later insert hands the whole memo to whichever
 * strings arrived first, so a theme switch after that re-parses every token on
 * every streamed snapshot forever — the exact cost the memo was measured to
 * remove, made permanent.
 *
 * `react-native` is stubbed with a counting `processColor`, the way the other
 * view tests stub it: this module imports that one function and nothing else,
 * which is why it is a module of its own rather than a private helper in
 * `RunHost`.
 */

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

    expect(second).toBe(first);
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
  });

  it('still caches a token minted after the cap is reached', () => {
    // The theme-switch case. Fill the cache past the cap with per-instance
    // colours, then introduce a token the way an appearance flip does: it has
    // to be cached, or it re-parses on every snapshot from here on.
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
    // Whatever the cache does, the answer is the converter's. A hit and a miss
    // must be indistinguishable to the caller.
    const before = memoizedProcessColor('#abcdef');
    for (let i = 0; i < MAX_PROCESSED_COLORS + 1; i += 1) {
      memoizedProcessColor(`hsl(${i}, 10%, 10%)`);
    }

    expect(memoizedProcessColor('#abcdef')).toBe(before);
  });
});
