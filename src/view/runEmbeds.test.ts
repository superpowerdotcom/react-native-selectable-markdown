/**
 * The embed list the native host reserves space from, and the projection
 * entries it is built from. Pure reshaping — `resolveRunEmbeds` must never
 * invent, drop, or reorder an embed, because `embedId` is the index the host
 * echoes back through `onEmbedLayout` and the view resolves overlays with.
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
  test('a projection without embeds resolves to an empty list', () => {
    expect(resolveRunEmbeds(projectedWith())).toEqual([]);
  });

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
  });

  test('an absent copy text stays absent rather than riding as undefined', () => {
    const [embed] = resolveRunEmbeds(
      projectedWith([
        {
          embedId: 0,
          start: 1,
          end: 2,
          node: node('link'),
          content: { width: 10, height: 10 },
        },
      ]),
    );

    expect('text' in embed).toBe(false);
  });
});
