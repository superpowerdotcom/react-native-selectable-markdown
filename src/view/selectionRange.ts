import type { SourceSpan } from '../document/span';
import type { ProjectedRun } from '../selection/mapSelection';

/**
 * UTF-16, end-exclusive offsets into one run's `ProjectedRun.text`. Deliberately
 * not `SourceSpan`, which indexes `doc.source`.
 */
export interface RunTextRange {
  start: number;
  end: number;
}

/**
 * The inverse of `mapSelectionToSource`: the hull of every display range a
 * source span touches, so it can be wider than the span. An indivisible piece
 * (entity, alt text, embed) counts whole. Null when the span shows nothing in
 * this run or is empty; a reversed span is normalized and offsets are clamped.
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

  for (const extent of projected.extents ?? []) {
    if (sourceStart <= extent.source.start && sourceEnd >= extent.source.end) {
      textStart = Math.min(textStart, extent.start);
      textEnd = Math.max(textEnd, extent.end);
    }
  }

  if (!Number.isFinite(textStart) || textStart >= textEnd) {
    return null;
  }
  return {
    start: Math.max(0, textStart),
    end: Math.min(projected.text.length, textEnd),
  };
}

/** Structural, so `RunSelectionEntry` in `SelectableMarkdown.tsx` satisfies it without a cast. */
export interface RunSelectionCandidate {
  /** The run's source span, used to order candidates document-first. */
  span: { start: number; end: number };
  /** Null for a standalone run, which has no host. */
  projected: ProjectedRun | null;
  /** The run's host handle. Null between mount and the first commit, and
   * after unmount. */
  host: {
    current: { setSelection(start: number, end: number): boolean } | null;
  };
}

/**
 * Selects a source span in the first run, in document order rather than mount
 * order, that both shows it and accepts it: `setSelection` returns false for
 * Android's live tail or a non-selectable run. Returns whether any run did.
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
