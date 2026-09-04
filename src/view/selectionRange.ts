import type { SourceSpan } from '../document/span';
import type { ProjectedRun } from '../selection/mapSelection';

/**
 * A range of a run's projected display text — the unit every native selection
 * offset is in (UTF-16 code units into `ProjectedRun.text`, end-exclusive).
 *
 * Deliberately NOT `SourceSpan`, even though the two are structurally
 * identical: a `SourceSpan` indexes `doc.source` and this indexes one run's
 * `text`, and confusing the two is the failure this whole layer exists to
 * prevent. The distinct name is the only thing standing between an imperative
 * `setSelection` and a well-formed selection of the wrong characters.
 */
export interface RunTextRange {
  start: number;
  end: number;
}

/**
 * The inverse of `mapSelectionToSource`: where a span of the SOURCE lands in
 * one run's projected text, or null when the run does not show it.
 *
 * WHY IT IS NOT SIMPLY THAT FUNCTION RUN BACKWARDS. Projection is lossy in
 * one direction only. Every display character comes from at most one source
 * range, so display → source is a walk of the piece table; source → display
 * has to cope with source that reaches NO display character at all — a
 * heading's `# `, a fence, a link's `](url)`, the `> ` of a quote. A span that
 * covers only such characters is unshowable, and this returns null for it
 * rather than inventing a plausible-looking empty range at the nearest piece.
 *
 * WHAT IT RETURNS is the hull of every display range the span touches, which
 * is the same shape `mapSelectionToSource` returns in the other direction and
 * for the same reason: a selection is one contiguous range in one text view,
 * so a span that skips over hidden syntax in the middle (the two words either
 * side of a `**`) has to come back as the range covering both, not as two
 * ranges the platform cannot express. The hull can therefore be WIDER than the
 * span asked for, in exactly the places the source is wider than the screen.
 *
 * AN INDIVISIBLE PIECE IS ALL-OR-NOTHING, matching the forward direction. A
 * piece whose display length differs from its source length — a decoded
 * entity, an image's alt text, an embed's placeholder — has no interior
 * correspondence to offer, so any overlap with it contributes the whole
 * piece. Round-tripping such a span therefore widens it, once, and then
 * stabilises.
 *
 * SYNTHETIC PIECES (a list bullet, a block separator) contribute nothing:
 * they have no source at all, so no source span can ask for them. They are
 * still swept up by the hull when they sit between two real pieces the span
 * touched, which is what makes a selection across a list look like one
 * selection.
 *
 * Both offsets are clamped into the run's text, and a reversed or empty
 * argument returns null rather than throwing — this is reachable from a
 * consumer's imperative call with any two numbers in it.
 */
export function mapSourceToRunRange(
  projected: ProjectedRun,
  span: { start: number; end: number },
): RunTextRange | null {
  if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) {
    return null;
  }
  const sourceStart = Math.min(span.start, span.end);
  const sourceEnd = Math.max(span.start, span.end);
  if (sourceStart >= sourceEnd) {
    return null;
  }

  let textStart = Number.POSITIVE_INFINITY;
  let textEnd = Number.NEGATIVE_INFINITY;

  for (const piece of projected.pieces) {
    if (piece.source === null) {
      continue;
    }
    const overlapStart = Math.max(sourceStart, piece.source.start);
    const overlapEnd = Math.min(sourceEnd, piece.source.end);
    if (overlapStart >= overlapEnd) {
      continue;
    }
    const textLength = piece.textEnd - piece.textStart;
    const sourceLength = piece.source.end - piece.source.start;
    let pieceStart: number;
    let pieceEnd: number;
    if (textLength === sourceLength) {
      pieceStart = piece.textStart + (overlapStart - piece.source.start);
      pieceEnd = piece.textStart + (overlapEnd - piece.source.start);
    } else {
      // Non-linear piece: indivisible in this direction too.
      pieceStart = piece.textStart;
      pieceEnd = piece.textEnd;
    }
    if (pieceStart < textStart) {
      textStart = pieceStart;
    }
    if (pieceEnd > textEnd) {
      textEnd = pieceEnd;
    }
  }

  if (!Number.isFinite(textStart) || textStart >= textEnd) {
    // The span covers only syntax this run does not show (or nothing at all).
    return null;
  }
  return {
    start: Math.max(0, textStart),
    end: Math.min(projected.text.length, textEnd),
  };
}

/**
 * One mounted run, as the document-level `setSelection` sees it: where it sits
 * in the source, what it shows, and how to command it.
 *
 * Structural on purpose — `RunSelectionEntry` in `SelectableMarkdown.tsx`
 * satisfies it without a cast, and stating it here keeps the walk below in a
 * module that has no React Native in it and can therefore be tested.
 */
export interface RunSelectionCandidate {
  /** The run's source span, used to order candidates document-first. */
  span: { start: number; end: number };
  /** The run's projection, or null for a standalone run — which renders no
   * host and therefore cannot hold a native selection at all. */
  projected: ProjectedRun | null;
  /** The run's host handle. Null between mount and the first commit, and
   * after unmount. */
  host: {
    current: { setSelection(start: number, end: number): boolean } | null;
  };
}

/**
 * Selects a SOURCE span in the first run that both shows it and takes it,
 * returning whether any run did.
 *
 * TWO REFUSALS, AND THE SECOND IS WHY THIS ASKS RATHER THAN ASSUMES. A run
 * may not SHOW the span — it is standalone, it has not committed, the span
 * covers only syntax that projects no characters — which `mapSourceToRunRange`
 * answers. Or it may show it and be unable to TAKE it: `RunHostHandle
 * .setSelection` reports false when its host would refuse the command, which
 * is the unsettled streaming tail on Android (the tail policy: no selection
 * over text that is still being swapped), a run rendered `selectable={false}`,
 * and a binary whose native spec predates the selection commands. Treating the
 * mapping as success reported `true` for a selection nobody made — on Android
 * that is every `setSelection` into the live tail of a streaming message.
 *
 * DOCUMENT ORDER, not registry order: a registry iterates in mount order, and
 * a run that remounted mid-stream sits at the end of it, so "the first run
 * that shows this span" has to mean the same thing on every call.
 */
export function selectSpanInRuns(
  candidates: Iterable<RunSelectionCandidate>,
  span: { start: number; end: number },
): boolean {
  if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) {
    return false;
  }
  const ordered = [...candidates].sort((a, b) => a.span.start - b.span.start);
  for (const entry of ordered) {
    const projected = entry.projected;
    const host = entry.host.current;
    if (!projected || !host) {
      continue;
    }
    const range = mapSourceToRunRange(projected, span);
    if (!range) {
      continue;
    }
    if (host.setSelection(range.start, range.end)) {
      return true;
    }
  }
  return false;
}
