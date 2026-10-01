import type { AnyNode } from '../document/nodes';
import type { ProjectedRun } from '../selection/mapSelection';

/**
 * One embedded range of a projected run: the placeholder's display range,
 * the declared reservation, and the node the embed stands for.
 *
 * WHY THIS EXISTS. The native selection host renders the whole run as one
 * platform text view, so a custom UI that used to force its block
 * `standalone` broke the run into separate selection scopes — a gesture
 * could not sweep across a citation card, and the card's block lost
 * `onSelectionCopy` entirely. With embeds the host instead reserves
 * `width` × `height` points at the run's U+FFFC placeholder and reports the
 * reserved rect back through `onEmbedLayout`; the view overlays the
 * consumer's React element there, and selection flows across as if the card
 * were one character — which, to the piece table, it is.
 *
 * Derived from `ProjectedRun.embeds` rather than re-consulted from the
 * consumer's lookup so it cannot disagree with what the run projected: the
 * ranges here are exactly the 'embed' marks, the sizes are the ones the
 * geometry attribute in `runAttributes` reserves height for, and the ids are
 * the ones `onEmbedLayout` echoes back. Only `start`/`end`/`embedId`/
 * `width`/`height` ever cross the bridge — the node and the copy text stay
 * in JS, the same division of knowledge pressables use for hrefs.
 */
export interface RunEmbed {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive;
   * `end === start + 1` (one U+FFFC). */
  start: number;
  end: number;
  /** Index in `ProjectedRun.embeds`, echoed back by `onEmbedLayout`; drops never renumber it. */
  embedId: number;
  /** Declared reservation in points. */
  width: number;
  height: number;
  /** What this embed contributes to a copy-text payload; absent means the
   * placeholder is removed from `plain`. Never crosses the bridge. */
  text?: string;
  /** The embedded node, for the view layer to hand to the consumer's render
   * function. Never crosses the bridge. */
  node: AnyNode;
}

/**
 * Positive and finite on both axes. Shared with the geometry attribute, so a
 * dropped entry leaves no line-height reservation behind.
 */
export function isReservableEmbedSize(size: {
  width: number;
  height: number;
}): boolean {
  return (
    Number.isFinite(size.width) &&
    size.width > 0 &&
    Number.isFinite(size.height) &&
    size.height > 0
  );
}

/**
 * The embedded ranges of a projected run, in placeholder order — which is
 * `embedId` order. A claim whose size is not reservable is dropped, as both
 * hosts would refuse it; surviving ids are not renumbered.
 */
export function resolveRunEmbeds(projected: ProjectedRun): RunEmbed[] {
  if (projected.embeds === undefined) {
    return [];
  }
  const out: RunEmbed[] = [];
  for (const embed of projected.embeds) {
    if (!isReservableEmbedSize(embed.content)) {
      continue;
    }
    const entry: RunEmbed = {
      start: embed.start,
      end: embed.end,
      embedId: embed.embedId,
      width: embed.content.width,
      height: embed.content.height,
      node: embed.node,
    };
    if (embed.content.text !== undefined) {
      entry.text = embed.content.text;
    }
    out.push(entry);
  }
  return out;
}
