import {
  advanceToClusterBoundary,
  retreatToClusterBoundary,
  retreatToStreamBoundary,
  splitsCluster,
} from './clusters';

// ---------------------------------------------------------------------------
// Cluster arithmetic for release cuts. Two consumers, opposite directions:
// StreamSession retreats a cut (released text cannot be recalled) and the
// adaptive smoother advances its own answer. The interesting assertions are
// therefore symmetric, and the strongest of them is the `Intl.Segmenter`
// cross-check at the bottom: the hand-rolled walk exists only because Hermes
// has no Segmenter, so where a real segmenter IS available (Node, in these
// tests) it is the oracle for everything the module claims to cover — and the
// documented gaps are pinned as gaps, so the module comment stays honest.
// ---------------------------------------------------------------------------

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
    // A trailing lone regional indicator is released rather than held
    // forever: no character says its partner is coming.
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
    // Nothing beyond the text to advance into: the caller (the smoother)
    // wanted everything anyway.
    expect(advanceToClusterBoundary(FLAG_US, 2)).toBe(4);
    expect(advanceToClusterBoundary('\u{1F1FA}', 1)).toBe(2);
  });
});

// `Intl.Segmenter` is unavailable on Hermes, which is why this module exists;
// under Node it is the reference implementation to check the walk against.
// The es2020 lib this package compiles against carries no types for it, so it
// is reached through a typed view of `Intl` rather than a lib bump.
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

    // Everything the module claims to cover. Hangul jamo and Indic conjuncts
    // are deliberately absent — see the gap test below.
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
        // Not merely "a" boundary: the NEAREST one in each direction, so no
        // release is held (or let through) longer than the cluster needs.
        expect(Math.max(...[...real].filter((b) => b <= cut))).toBe(down);
        expect(Math.min(...[...real].filter((b) => b >= cut))).toBe(up);
      }
    });

    test('the documented gaps are gaps: Indic conjuncts across a virama', () => {
      // 'हिन्दी': the segmenter keeps 'न्दी' together (the virama conjoins
      // the consonants), the walk only keeps a base with its own marks. The
      // cost is one frame showing 'हिन्' — never invalid UTF-16 — and the
      // module comment says so rather than claiming UAX #29 conformance.
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
  // The stream's two truths: the text on the left of the cut includes what
  // has already been committed, and the text on the right may still grow.
  test('a cut at the end of the buffer holds a cluster that could still grow', () => {
    // Every one of these is the FIRST delta of a two-delta cluster, so the
    // cut has to come back to 0 rather than commit half a glyph.
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
    // No ASCII character continues a cluster this module recognises, so
    // plain prose never pays the wait…
    expect(retreatToStreamBoundary('', 'hello', 5)).toBe(5);
    expect(retreatToStreamBoundary('', 'a b ', 4)).toBe(4);
    // …at the price of an ASCII base whose combining mark is in the next
    // delta, which commits 'cafe' for one frame.
    expect(retreatToStreamBoundary('', 'cafe', 4)).toBe(4);
  });

  test('a cut inside the buffer is judged as before', () => {
    // openEnd only applies AT the end; an interior cut keeps the ordinary
    // retreat, so a finished cluster still releases whole.
    expect(retreatToStreamBoundary('', `${FLAG_US} x`, 4)).toBe(4);
    expect(retreatToStreamBoundary('', `${FAMILY} x`, 3)).toBe(0);
    expect(retreatToStreamBoundary('', `${FAMILY} x`, 9)).toBe(9);
  });

  test('regional-indicator parity spans the committed text', () => {
    // Committed '🇫', pending '🇷🇺🇸!': the run inside the buffer looks even
    // at 4, so a buffer-only count would release the '🇺' of '🇺🇸' alone.
    const committed = '\u{1F1EB}';
    const pending = '\u{1F1F7}\u{1F1FA}\u{1F1F8}!';
    expect(retreatToStreamBoundary(committed, pending, 4)).toBe(2);
    // With nothing committed the same cut is fine: '🇷🇺' is a whole flag.
    expect(retreatToStreamBoundary('', pending, 4)).toBe(4);
  });

  test('a retreat that reaches into committed text answers 0', () => {
    // The joiner is already committed and the buffer holds another one, so
    // the cut walks back past the buffer's start and nothing releases.
    const committed = '\u{1F468}\u200D';
    expect(
      retreatToStreamBoundary(committed, '\u{1F469}\u200D\u{1F467} ok', 2),
    ).toBe(0);
    // …while a buffer that PROVES the cluster ended (a space right after)
    // releases it: the joiner sequence is finished in the combined text.
    expect(retreatToStreamBoundary(committed, '\u{1F469} ok', 2)).toBe(2);
  });

  test('the committed window is bounded, and never starts mid-pair', () => {
    // A long run of flags: the window keeps the parity honest for far more
    // indicators than any real stream carries…
    const flags = FLAG_US.repeat(20);
    expect(retreatToStreamBoundary(flags, '\u{1F1FA}\u{1F1F8} x', 2)).toBe(0);
    // …and a window boundary landing between two surrogates must not hide
    // the high half, which would make an odd run look even. 129 units of
    // ASCII then a lone indicator: the window starts inside the ASCII, so
    // the indicator is seen whole.
    const committed = `${'x'.repeat(129)}\u{1F1EB}`;
    expect(retreatToStreamBoundary(committed, '\u{1F1F7}\u{1F1FA}\u{1F1F8}!', 4)).toBe(2);
  });
});
