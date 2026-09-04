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
  /** The identifier the host echoes back through `onEmbedLayout` — this
   * entry's index in `ProjectedRun.embeds`, which is what an event is
   * resolved against. Not necessarily its index in the resolved list: an
   * unreservable claim is dropped from that list without renumbering the
   * ones around it. */
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
 * Whether a declared size can actually be reserved: positive AND FINITE on
 * both axes.
 *
 * Finiteness is the half that used to be missing everywhere. `!(x > 0)`
 * rejects NaN, zero and negatives — which is what `embedContentFor` advertises
 * — but `Infinity > 0` is true, so an infinite dimension passed every layer:
 * iOS built a `CGRectMake(0, descender, inf, inf)` attachment and handed it to
 * TextKit, Android saturated `PixelUtil.toPixelFromDIP(inf).toInt()` to
 * `Int.MAX_VALUE` for a replacement span, and the geometry attribute below
 * sent `lineHeight: Infinity` across the bridge. None of that is the "degrade
 * a bad entry to no reservation" the guards promise.
 *
 * Shared by the wire list and the geometry attribute (`runAttributes.ts`) so
 * the two cannot disagree about which claims are reservable: an entry that is
 * dropped here must not leave a line-height reservation behind for a card that
 * will never be drawn.
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
 * `embedId` order, and the id travels as a FIELD, not as an array index: an
 * `onEmbedLayout` event is resolved against `ProjectedRun.embeds` (bounds-
 * checked, the `pressableId` discipline) and the overlay map is keyed by id,
 * so nothing here indexes this list positionally.
 *
 * Which is what lets an unreservable entry be dropped rather than sent: a
 * claim whose declared size is not positive and finite would be refused by
 * both hosts' own guards anyway (`continue` in the iOS embed loop, `return
 * null` in `RunEmbeds.kt`), and dropping it in JS makes the outcome the same
 * on every layer — no reservation, no reported rect, and therefore no overlay
 * — instead of depending on which layer noticed first. Ids of the surviving
 * entries are untouched, so a drop never renumbers anything.
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
