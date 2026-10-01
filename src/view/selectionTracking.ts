import type { SourceSpan } from '../document/span';
import { mapSelectionToSource } from '../selection/mapSelection';
import type { ProjectedRun } from '../selection/mapSelection';
import { selectionDisplayText } from './selectionActions';
import type { RunTextRange } from './selectionRange';

// The state keeps the display range and its projection: source can change under
// byte-identical display text (`a &amp; b` to `a & b`), so the host reports
// nothing and only a remap through the new projection notices.

/** Structurally `SelectableMarkdownSelection`, restated so this module does
 * not import the component. */
export interface TrackedSelection {
  span: SourceSpan;
  plain: string;
}

export interface SelectionTrackingState {
  /** What `getSelection()` returns. */
  selection: TrackedSelection | null;
  /** The run key holding `selection`, or null. */
  owner: string | null;
  /** The owner's display range `selection` was mapped from. */
  range: RunTextRange | null;
  /** The projection `range` was mapped through. */
  projected: ProjectedRun | null;
  /** Live runs, in selection order, when native exclusivity is disabled. */
  selections?: ReadonlyMap<string, SelectionTrackingState>;
}

export const EMPTY_SELECTION_STATE: SelectionTrackingState = {
  selection: null,
  owner: null,
  range: null,
  projected: null,
};

/**
 * - `select`: the host reported a range. An empty range, or one that maps to
 *   no source, is a clear from that run.
 * - `clear`: the run's selection ended without a range, as on unmount.
 * - `reproject`: the run's projection changed. `projected` is null when the
 *   run went standalone, which unmounts its host and its selection with it.
 */
export type RunSelectionReport =
  | { kind: 'select'; range: RunTextRange; projected: ProjectedRun | null }
  | { kind: 'clear' }
  | { kind: 'reproject'; projected: ProjectedRun | null };

export interface SelectionTrackingResult {
  state: SelectionTrackingState;
  /** Whether `onSelectionChange` should hear `state.selection`. */
  emit: boolean;
}

/** A display range mapped through a projection, or null if it no longer
 * maps: empty, past the end of the text, or covering only synthetic glyphs. */
export function mapRunRange(
  projected: ProjectedRun | null,
  range: RunTextRange,
): TrackedSelection | null {
  if (!projected || range.start >= range.end) {
    return null;
  }
  if (range.start < 0 || range.end > projected.text.length) {
    return null;
  }
  const span = mapSelectionToSource(projected, range);
  if (!span) {
    return null;
  }
  return {
    span,
    plain: selectionDisplayText(projected, range.start, range.end),
  };
}

function cleared(
  state: SelectionTrackingState,
  runKey: string,
): SelectionTrackingResult {
  // A clear from a non-owner is the other half of a hand-off; emitting it would drop the new selection.
  if (state.owner !== runKey) {
    return { state, emit: false };
  }
  return { state: EMPTY_SELECTION_STATE, emit: true };
}

export function reduceRunSelection(
  state: SelectionTrackingState,
  runKey: string,
  report: RunSelectionReport,
  exclusive = true,
): SelectionTrackingResult {
  if (exclusive) {
    const { selections: _selections, ...single } = state;
    return reduceSingleSelection(state.selections ? single : state, runKey, report);
  }
  const selections = new Map(state.selections ?? (
    state.owner === null ? [] : [[state.owner, state]]
  ));
  const previous = selections.get(runKey) ?? EMPTY_SELECTION_STATE;
  const result = reduceSingleSelection(previous, runKey, report);
  if (result.state === previous) return { state, emit: false };
  if (result.state.selection === null) {
    selections.delete(runKey);
  } else {
    if (report.kind === 'select') selections.delete(runKey);
    selections.set(runKey, result.state);
  }
  let owner = state.owner;
  if (report.kind === 'select' && result.state.selection !== null) owner = runKey;
  if (owner === null || !selections.has(owner)) {
    owner = null;
    for (const key of selections.keys()) owner = key;
  }
  const selected = owner === null ? EMPTY_SELECTION_STATE : selections.get(owner)!;
  return {
    state: { ...selected, selections },
    emit: state.selection !== selected.selection,
  };
}

function reduceSingleSelection(
  state: SelectionTrackingState,
  runKey: string,
  report: RunSelectionReport,
): SelectionTrackingResult {
  switch (report.kind) {
    case 'select': {
      const selection = mapRunRange(report.projected, report.range);
      if (!selection) {
        return cleared(state, runKey);
      }
      return {
        state: {
          selection,
          owner: runKey,
          range: { start: report.range.start, end: report.range.end },
          projected: report.projected,
        },
        emit: true,
      };
    }
    case 'clear':
      return cleared(state, runKey);
    case 'reproject': {
      if (state.owner !== runKey || state.projected === report.projected) {
        return { state, emit: false };
      }
      const selection = state.range
        ? mapRunRange(report.projected, state.range)
        : null;
      if (!selection) {
        return { state: EMPTY_SELECTION_STATE, emit: true };
      }
      const previous = state.selection;
      const changed =
        previous === null ||
        previous.span.start !== selection.span.start ||
        previous.span.end !== selection.span.end ||
        previous.plain !== selection.plain;
      return {
        state: {
          ...state,
          selection: changed ? selection : previous,
          projected: report.projected,
        },
        emit: changed,
      };
    }
  }
}

/**
 * The imperative `clearSelection()`: the stored selection ends whether or not
 * the owner's host is still reachable to be told. The host's own empty report
 * arrives later from a run that is no longer the owner, and is dropped.
 */
export function resetSelection(
  state: SelectionTrackingState,
): SelectionTrackingResult {
  if (state.owner === null && state.selection === null) {
    return { state, emit: false };
  }
  return { state: EMPTY_SELECTION_STATE, emit: state.selection !== null };
}
