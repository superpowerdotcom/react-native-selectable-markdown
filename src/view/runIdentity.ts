import type { ProjectedRunEmbed } from '../selection/mapSelection';
import type { RunSegment } from '../selection/runs';

/** In points, in the run host's coordinate space. */
export interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NO_EMBED_RECTS: ReadonlyMap<string, EmbedRect> = new Map();

/**
 * A streamed document's last run is keyed 'run:tail', so a settle hands its host
 * new text instead of remounting it and destroying a live selection. `live`
 * means stream-driven and stays true after the stream ends. A single run keys
 * on its span, so at the first split the settled prefix keeps the host.
 */
export function runKey(
  run: RunSegment,
  index: number,
  count: number,
  live: boolean,
): string {
  const isTail = live && !run.standalone && index === count - 1 && count > 1;
  return isTail ? 'run:tail' : `run:${run.span.start}`;
}

/**
 * The embed's source span, not `embedId` or the projection: the projection
 * changes every settle, but hosts re-report a rect only when it moves.
 */
export function embedRectKey(embed: ProjectedRunEmbed): string {
  return `${embed.node.span.start}:${embed.node.span.end}`;
}

function sameRect(rect: EmbedRect, event: EmbedRect): boolean {
  return (
    rect.x === event.x &&
    rect.y === event.y &&
    rect.width === event.width &&
    rect.height === event.height
  );
}

/**
 * Returns `previous` itself for a repeated rect or an out-of-range id (a report
 * can race a prop swap by a frame), so the state update bails out. Rects of
 * embeds no longer projected are dropped.
 */
export function applyEmbedRect(
  previous: ReadonlyMap<string, EmbedRect>,
  embeds: readonly ProjectedRunEmbed[],
  event: { embedId: number } & EmbedRect,
): ReadonlyMap<string, EmbedRect> {
  if (
    !Number.isInteger(event.embedId) ||
    event.embedId < 0 ||
    event.embedId >= embeds.length
  ) {
    return previous;
  }
  const key = embedRectKey(embeds[event.embedId]);
  const held = previous.get(key);
  if (held !== undefined && sameRect(held, event)) {
    return previous;
  }
  const next = new Map<string, EmbedRect>();
  for (const embed of embeds) {
    const embedKey = embedRectKey(embed);
    const rect = previous.get(embedKey);
    if (rect !== undefined) {
      next.set(embedKey, rect);
    }
  }
  next.set(key, {
    x: event.x,
    y: event.y,
    width: event.width,
    height: event.height,
  });
  return next;
}
