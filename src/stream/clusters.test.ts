import {
  advanceToClusterBoundary,
  retreatToClusterBoundary,
  retreatToStreamBoundary,
  splitsCluster,
} from './clusters';

const FLAG_US = '\u{1F1FA}\u{1F1F8}';
const FLAG_GB = '\u{1F1EC}\u{1F1E7}';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const HEART_ON_FIRE = '❤️‍\u{1F525}';
const ASTRONAUT = '\u{1F469}\u{1F3FD}‍\u{1F680}';
const KEYCAP = '1️⃣';
const CAFE_NFD = 'café';
const THAI = 'กุ๊'; // ก + vowel sign + tone mark
const SCOTLAND =
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';

describe('splitsCluster', () => {
  test('the ends are always safe: nothing to split from, nothing arrived yet', () => {
    expect(splitsCluster(FAMILY, 0)).toBe(false);
    expect(splitsCluster(FAMILY, FAMILY.length)).toBe(false);
    expect(splitsCluster('\u{1F1FA}', 2)).toBe(false);
  });

  test('names the cases the release cuts care about', () => {
    expect(splitsCluster('a\u{1F600}b', 2)).toBe(true); // inside a pair
    expect(splitsCluster(FAMILY, 2)).toBe(true); // before a joiner
    expect(splitsCluster(FAMILY, 3)).toBe(true); // after a joiner
    expect(splitsCluster(`${HEART_ON_FIRE}x`, 1)).toBe(true); // before VS16
    expect(splitsCluster(`${ASTRONAUT}x`, 2)).toBe(true); // before a skin tone
    expect(splitsCluster(`${CAFE_NFD}x`, 4)).toBe(true); // before a mark
    expect(splitsCluster(`${KEYCAP}x`, 2)).toBe(true); // before the keycap
    expect(splitsCluster(`${SCOTLAND}x`, 2)).toBe(true); // before a tag
    expect(splitsCluster(`${FLAG_US}x`, 2)).toBe(true); // odd indicator run
    // …and an even run is a boundary, however long the flag sequence.
    expect(splitsCluster(`${FLAG_US}${FLAG_GB}x`, 4)).toBe(false);
    expect(splitsCluster(`${FLAG_US}${FLAG_GB}x`, 6)).toBe(true);
  });
});

describe('retreatToClusterBoundary', () => {
  test('never moves up, and is idempotent', () => {
    const text = `${FAMILY}${FLAG_US}${CAFE_NFD}`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const at = retreatToClusterBoundary(text, cut);
      expect(at).toBeLessThanOrEqual(cut);
      expect(splitsCluster(text, at)).toBe(false);
      expect(retreatToClusterBoundary(text, at)).toBe(at);
    }
  });

  test('clamps out-of-range cuts', () => {
    expect(retreatToClusterBoundary(FAMILY, -5)).toBe(0);
    expect(retreatToClusterBoundary(FAMILY, 99)).toBe(FAMILY.length);
  });

  test('walks a whole cluster down rather than committing part of it', () => {
    expect(retreatToClusterBoundary(`${FAMILY} ok`, 7)).toBe(0);
    expect(retreatToClusterBoundary(`x${FLAG_US} ok`, 3)).toBe(1);
    expect(retreatToClusterBoundary(`${CAFE_NFD} ok`, 4)).toBe(3);
    expect(retreatToClusterBoundary(`${SCOTLAND} ok`, 10)).toBe(0);
  });
});

describe('advanceToClusterBoundary', () => {
  test('never moves down, and is idempotent', () => {
    const text = `${FAMILY}${FLAG_US}${CAFE_NFD}`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const at = advanceToClusterBoundary(text, cut);
      expect(at).toBeGreaterThanOrEqual(cut);
      expect(splitsCluster(text, at)).toBe(false);
      expect(advanceToClusterBoundary(text, at)).toBe(at);
    }
  });

  test('carries a cut through the rest of the cluster', () => {
    expect(advanceToClusterBoundary(`${FAMILY} ok`, 2)).toBe(FAMILY.length);
    expect(advanceToClusterBoundary(`${FLAG_US} ok`, 2)).toBe(4);
    expect(advanceToClusterBoundary(`${CAFE_NFD} ok`, 4)).toBe(5);
    expect(advanceToClusterBoundary(`${SCOTLAND} ok`, 4)).toBe(SCOTLAND.length);
  });

  test('a cut past the last boundary lands at the end', () => {
    expect(advanceToClusterBoundary(FLAG_US, 2)).toBe(4);
    expect(advanceToClusterBoundary('\u{1F1FA}', 1)).toBe(2);
  });
});

// The es2020 lib carries no types for `Intl.Segmenter`, hence the typed view.
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
const Segmenter = (
  Intl as unknown as {
    Segmenter?: new (
      locale: string,
      options: { granularity: 'grapheme' },
    ) => GraphemeSegmenter;
  }
).Segmenter;
const hasSegmenter = typeof Segmenter === 'function';

(hasSegmenter ? describe : describe.skip)(
  'agreement with Intl.Segmenter',
  () => {
    function boundaries(text: string): Set<number> {
      const segmenter = new Segmenter!('en', { granularity: 'grapheme' });
      const found = new Set<number>([0]);
      let at = 0;
      for (const { segment } of segmenter.segment(text)) {
        at += segment.length;
        found.add(at);
      }
      return found;
    }

    const covered = [
      `plain ${FLAG_US}${FLAG_GB} flags`,
      `hi ${FAMILY}!`,
      `${HEART_ON_FIRE} hot`,
      `${ASTRONAUT} go`,
      `${KEYCAP} first`,
      `${CAFE_NFD} ok`,
      `${THAI} thai`,
      `${SCOTLAND} flag`,
      'ab\u{1F600}cd',
    ];

    test.each(covered)('every cut in %j lands on a real boundary', (text) => {
      const real = boundaries(text);
      for (let cut = 0; cut <= text.length; cut += 1) {
        const down = retreatToClusterBoundary(text, cut);
        const up = advanceToClusterBoundary(text, cut);
        expect(real.has(down)).toBe(true);
        expect(real.has(up)).toBe(true);
        expect(Math.max(...[...real].filter((b) => b <= cut))).toBe(down);
        expect(Math.min(...[...real].filter((b) => b >= cut))).toBe(up);
      }
    });

    test('the documented gaps are gaps: Indic conjuncts across a virama', () => {
      // The segmenter keeps 'न्दी' together across the virama; the walk does not.
      const hindi = 'हिन्दी';
      const real = boundaries(hindi);
      expect([...real]).toEqual([0, 2, 6]);
      expect(retreatToClusterBoundary(hindi, 4)).toBe(4);
      expect(real.has(4)).toBe(false);
      // The marks themselves are still never split off their base.
      expect(retreatToClusterBoundary(hindi, 1)).toBe(0);
      expect(retreatToClusterBoundary(hindi, 3)).toBe(2);
      expect(retreatToClusterBoundary(hindi, 5)).toBe(4);
    });
  },
);

describe('retreatToStreamBoundary', () => {
  test('a cut at the end of the buffer holds a cluster that could still grow', () => {
    // Each is the first delta of a two-delta cluster.
    for (const first of [
      '\u{1F1FA}', // a lone regional indicator
      '\u{1F468}', // an emoji before its joiner
      '\u{1F469}', // an emoji before its skin-tone modifier
      '1\uFE0F', // a keycap before U+20E3
      '\u0939', // a Devanagari consonant before its matra
    ]) {
      expect(retreatToStreamBoundary('', first, first.length)).toBe(0);
    }
  });

  test('ASCII is released: the documented gap, and the reason for it', () => {
    expect(retreatToStreamBoundary('', 'hello', 5)).toBe(5);
    expect(retreatToStreamBoundary('', 'a b ', 4)).toBe(4);
    expect(retreatToStreamBoundary('', 'cafe', 4)).toBe(4);
  });

  test('a cut inside the buffer is judged as before', () => {
    expect(retreatToStreamBoundary('', `${FLAG_US} x`, 4)).toBe(4);
    expect(retreatToStreamBoundary('', `${FAMILY} x`, 3)).toBe(0);
    expect(retreatToStreamBoundary('', `${FAMILY} x`, 9)).toBe(9);
  });

  test('regional-indicator parity spans the committed text', () => {
    // A buffer-only count sees an even run and releases the '🇺' of '🇺🇸'.
    const committed = '\u{1F1EB}';
    const pending = '\u{1F1F7}\u{1F1FA}\u{1F1F8}!';
    expect(retreatToStreamBoundary(committed, pending, 4)).toBe(2);
    // With nothing committed the same cut is fine: '🇷🇺' is a whole flag.
    expect(retreatToStreamBoundary('', pending, 4)).toBe(4);
  });

  test('a retreat that reaches into committed text answers 0', () => {
    // The committed text ends in a joiner, so the cluster is still open.
    const committed = '\u{1F468}\u200D';
    expect(
      retreatToStreamBoundary(committed, '\u{1F469}\u200D\u{1F467} ok', 2),
    ).toBe(0);
    // A following space proves the cluster ended.
    expect(retreatToStreamBoundary(committed, '\u{1F469} ok', 2)).toBe(2);
  });

  test('the committed window is bounded, and never starts mid-pair', () => {
    const flags = FLAG_US.repeat(20);
    expect(retreatToStreamBoundary(flags, '\u{1F1FA}\u{1F1F8} x', 2)).toBe(0);
    // The window starts inside the ASCII, so the indicator is seen whole.
    const committed = `${'x'.repeat(129)}\u{1F1EB}`;
    expect(retreatToStreamBoundary(committed, '\u{1F1F7}\u{1F1FA}\u{1F1F8}!', 4)).toBe(2);
  });
});

test('long regional-indicator runs retain committed parity', () => {
  const pending = '🇧🇨🇩!';
  for (const count of [64, 65, 66, 67, 129]) {
    expect(retreatToStreamBoundary('🇦'.repeat(count), pending, 4))
      .toBe(count % 2 === 0 ? 4 : 2);
  }
});
