import type { ProjectedRunEmbed } from '../selection/mapSelection';
import type { RunSegment } from '../selection/runs';

/**
 * Identity for the two things a streaming document re-derives on every
 * snapshot and must NOT treat as new each time: a run's React element, and
 * the rects the native host has reported for that run's embeds.
 *
 * Both defects this module fixes had the same shape — a value that is
 * recomputed on every commit was being used as an identity, so content that
 * had not changed at all was thrown away once per settle.
 *
 * Kept out of `SelectableMarkdown.tsx` so it is reachable from a plain Node
 * test: the component module pulls React Native in, and there is no renderer
 * in this test environment to mount it with.
 */

/** One reported embed rect, in the run host's coordinate space, points. */
export interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The empty rect map, shared so a run with no reports allocates nothing. */
export const NO_EMBED_RECTS: ReadonlyMap<string, EmbedRect> = new Map();

/**
 * The React key for one run.
 *
 * WHY THE UNSETTLED TAIL IS NOT KEYED ON ITS SPAN. Every run used to be
 * `run:${span.start}`, and for a settled run that is a stable identity: the
 * settled prefix only ever grows at its end, so its start stays put. The TAIL
 * run's start is the first UNSETTLED offset, which moves forward every time a
 * block settles (`segmentRuns` breaks the prose run at the settled boundary).
 * Its key therefore changed once per settled block — measured at one new key
 * per paragraph over a streamed message — and a changed key is not a re-render
 * but a REMOUNT: React unmounts the run's `RunHost`, the platform view is
 * recycled (on iOS `prepareForRecycle` → `reset()`, which clears the attributed
 * text, zeroes `selectedRange` and resigns first responder), and a fresh one
 * mounts in its place. Everything the hosts do to protect a live selection
 * across a text swap — iOS's prefix-append fast path and its clamp on a full
 * swap — is bypassed by a remount, so a selection the reader had made in the
 * live tail was destroyed on the next settle rather than clamped, and every
 * settle churned a native text view for content that had barely changed.
 *
 * So the tail is keyed by its ROLE. The tail run is the LAST run — there is
 * only ever one, which makes 'run:tail' unique — and it stays the same element
 * across a settle: the host is handed new text instead of being torn down. The
 * tail region can also hold a standalone block ahead of the tail prose, and
 * two runs answering to one key is a duplicate-key bug, not an identity, so
 * only the last one may claim it.
 *
 * IT IS THE POSITION, NOT THE SETTLED FLAG, that decides. Keying on "this run
 * is still unsettled" flipped the key twice more, both times under a live
 * selection:
 *
 *  - AT THE END OF THE STREAM, for a document whose last run does not merge
 *    into the settled prefix — an image, a spoiler or a consumer-claimed
 *    standalone block sits in front of it. The run is unchanged and goes on
 *    existing, but 'run:tail' became `run:${start}` the instant the stream
 *    stopped, remounting the host (and blanking any embed overlay in it for a
 *    layout pass) exactly at the moment the reader is finally free to select.
 *  - WHEN THE STREAM MOMENTARILY SETTLES THE WHOLE DOCUMENT, which happens
 *    whenever a chunk ends on a completed blank line. `segmentRuns`' own
 *    `liveTail` keeps the tail run in existence there; without a positional
 *    key the surviving run would still be re-keyed and remounted.
 *
 * So `live` is "this document is driven by a stream" and stays true after the
 * stream finishes, rather than "this run is unsettled". A document rendered
 * from a plain `source` string is keyed on spans throughout: it has no live
 * tail, and its runs' starts do not move.
 *
 * The FIRST run is the one place the two identities compete, which is why the
 * key is positional only while there is more than one run. A document whose
 * stream has not settled anything yet is a single run; the moment its first
 * block settles it becomes two, and React matches by key, not by position.
 * Keyed 'run:tail' the single run would be matched to the new TAIL and the
 * settled prefix — the longer-lived host, holding the text a reader has had
 * time to select — would mount fresh. Keyed on its span it is matched to the
 * settled run instead, which is where it grows into, and the tail is the one
 * that mounts. Either way exactly one host mounts at that first split; this
 * chooses which one survives it.
 *
 * The same rule keeps the FINAL merge cheap. When the last run really does
 * merge into the settled prefix at the end of a stream the document becomes
 * one run again, so the count falls back to 1 and the key with it: the merged
 * run's start is the settled run's start, so the long-lived host holding most
 * of the document is reused (on iOS through the append fast path, since the
 * merged text extends what it already showed) rather than the tail's
 * short-lived one being grown into it.
 */
export function runKey(
  run: RunSegment,
  index: number,
  count: number,
  live: boolean,
): string {
  const isTail = live && index === count - 1 && count > 1;
  return isTail ? 'run:tail' : `run:${run.span.start}`;
}

/**
 * The key a reported rect is filed under: the embed's SOURCE span.
 *
 * WHY NOT `embedId`, AND WHY NOT THE PROJECTION OBJECT. `embedId` is a
 * per-projection ordinal, so a rect filed under it could be read back for a
 * different node after a reprojection — which is why the rect map used to be
 * owned by the `ProjectedRun` object it was reported against, and dropped
 * wholesale whenever that object changed. But the projection object changes on
 * every settle (the run's span and blocks grow, so the per-run memo misses and
 * the projection memo re-runs), while the native hosts re-emit a rect only
 * when it MOVES — and a settled embed's rect never moves, because a settled
 * run only ever grows at its end. So every settle silently dropped every valid
 * rect, no report ever came to replace it, and the consumer's card unmounted
 * mid-stream and never came back, leaving the reserved blank space behind it.
 *
 * The source span is the identity that survives reprojection: it is stable for
 * a settled node, unique within a run (two nodes can only share a span by
 * nesting, and a claimed node's subtree is stood down to one placeholder, so
 * no embed contains another), and it is what the overlay actually needs to
 * know — "where did the card for THIS node land". A rect that is stale because
 * the embed genuinely moved is corrected by the report the move itself
 * triggers.
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
 * Files one `onEmbedLayout` report against the current projection's embeds,
 * returning the next rect map — or the previous one unchanged, which lets the
 * state update bail out of a re-render, when the report is out of range or
 * repeats a rect already held.
 *
 * The id is bounds-checked against `embeds` rather than trusted: a report can
 * race a prop swap by a frame, the same discipline `pressableId` follows.
 *
 * Rects for embeds the current projection no longer has are dropped as the map
 * is rebuilt — repair can retract a claimed node, and nothing else would ever
 * remove its entry.
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
