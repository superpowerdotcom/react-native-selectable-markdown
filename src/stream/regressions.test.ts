/** Timing budgets are cliff detectors, not targets: far above the linear cost, far below a super-linear one. */

import { describeNative, linkNativeEngineAsDefault } from '../engine/native/__tests__/support';
import { presets, resolveOptions } from '../engine/options';
import type { RepairSeed } from './repair';
import { repairTail } from './repair';
import { StreamSession } from './StreamSession';

linkNativeEngineAsDefault();

const SEED: RepairSeed = { openFence: null, inMath: false };
const base = resolveOptions(presets.llmChat);

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('repairTail trailing whitespace', () => {
  test('a long run of spaces before a pending closer trims in linear time', () => {
    const tail = '*a' + ' '.repeat(60000) + 'b ';
    let repaired = '';
    expect(timed(() => { repaired = repairTail(tail, SEED, base).text; })).toBeLessThan(1000);
    expect(repaired).toBe('*a' + ' '.repeat(60000) + 'b*');
  });
});

describeNative('fast-path guards', () => {
  test('a NUL in a plain delta reparses, so it becomes U+FFFD as in a fresh parse', () => {
    const session = new StreamSession({ options: presets.llmChat });
    session.append('abc');
    session.append('\u0000d');
    expect(session.snapshot().document.blocks).toEqual([
      {
        kind: 'paragraph',
        span: { start: 0, end: 5 },
        children: [{ kind: 'text', span: { start: 0, end: 5 }, value: 'abc�d' }],
      },
    ]);
  });

  test('many autolink candidates on one line do not make a plain delta quadratic', () => {
    const session = new StreamSession({ options: presets.llmChat });
    session.append('(http:x'.repeat(20000) + '　');
    expect(timed(() => session.append('a'))).toBeLessThan(1000);
    expect(session.snapshot().document.blocks).toMatchObject([
      { kind: 'paragraph', children: [{ kind: 'text', value: '(http:x'.repeat(20000) + '　a' }] },
    ]);
  });
});
