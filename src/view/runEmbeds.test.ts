/**
 * The embed list the native host reserves space from, and the projection
 * entries it is built from. The host echoes `embedId` back, so ids are never
 * renumbered.
 */

import type { AnyNode } from '../document/nodes';
import type { ProjectedRun, ProjectedRunEmbed } from '../selection/mapSelection';
import { resolveRunEmbeds } from './runEmbeds';

const node = (kind: string): AnyNode =>
  ({ kind, span: { start: 0, end: 1 } }) as AnyNode;

function projectedWith(embeds?: ProjectedRunEmbed[]): ProjectedRun {
  const projected: ProjectedRun = { text: 'a￼b', pieces: [], marks: [] };
  if (embeds) projected.embeds = embeds;
  return projected;
}

describe('resolveRunEmbeds', () => {
  test('reshapes each entry, keeping ids and order', () => {
    const first = node('link');
    const second = node('image');
    const embeds = resolveRunEmbeds(
      projectedWith([
        {
          embedId: 0,
          start: 1,
          end: 2,
          node: first,
          content: { width: 200, height: 80, text: '[1]' },
        },
        {
          embedId: 1,
          start: 5,
          end: 6,
          node: second,
          content: { width: 120, height: 90 },
        },
      ]),
    );

    expect(embeds).toEqual([
      {
        start: 1,
        end: 2,
        embedId: 0,
        width: 200,
        height: 80,
        text: '[1]',
        node: first,
      },
      { start: 5, end: 6, embedId: 1, width: 120, height: 90, node: second },
    ]);
    // The invariant the view and the host both index on.
    embeds.forEach((embed, index) => expect(embed.embedId).toBe(index));
    expect(resolveRunEmbeds(projectedWith())).toEqual([]);
  });

  describe('unreservable sizes', () => {
    const withSize = (width: number, height: number): ProjectedRunEmbed[] => [
      {
        embedId: 0,
        start: 1,
        end: 2,
        node: node('link'),
        content: { width, height },
      },
      {
        embedId: 1,
        start: 5,
        end: 6,
        node: node('image'),
        content: { width: 100, height: 40 },
      },
    ];

    test.each([
      ['infinite width', Number.POSITIVE_INFINITY, 40],
      ['infinite height', 100, Number.POSITIVE_INFINITY],
      ['NaN width', Number.NaN, 40],
      ['zero height', 100, 0],
      ['negative width', -100, 40],
    ])('a claim with %s is dropped', (_label, width, height) => {
      const embeds = resolveRunEmbeds(projectedWith(withSize(width, height)));

      expect(embeds).toHaveLength(1);
      expect(embeds[0].embedId).toBe(1);
    });

    test('surviving entries keep their ids rather than being renumbered', () => {
      const [survivor] = resolveRunEmbeds(projectedWith(withSize(0, 0)));

      expect(survivor.embedId).toBe(1);
      expect(survivor.width).toBe(100);
    });
  });

  test('an absent copy text stays absent rather than riding as undefined', () => {
    const [embed, withText] = resolveRunEmbeds(
      projectedWith([
        {
          embedId: 0,
          start: 1,
          end: 2,
          node: node('link'),
          content: { width: 10, height: 10 },
        },
        {
          embedId: 1,
          start: 5,
          end: 6,
          node: node('link'),
          content: { width: 10, height: 10, text: '[2]' },
        },
      ]),
    );

    expect('text' in embed).toBe(false);
    expect(withText.text).toBe('[2]');
  });
});
