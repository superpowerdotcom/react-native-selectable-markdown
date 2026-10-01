import type { ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { projectRun } from '../selection/mapSelection';
import type { ProjectedRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import {
  EMPTY_SELECTION_STATE,
  reduceRunSelection,
  resetSelection,
} from './selectionTracking';
import type { SelectionTrackingState } from './selectionTracking';

// Hand-built, since md4c needs a compiled addon: a decoded entity is one text node spanning all of `&amp;`.
const entityDoc: ParsedDocument = {
  source: 'a &amp; b',
  blocks: [
    {
      kind: 'paragraph',
      span: { start: 0, end: 9 },
      children: [
        { kind: 'text', value: 'a ', span: { start: 0, end: 2 } },
        { kind: 'text', value: '&', span: { start: 2, end: 7 } },
        { kind: 'text', value: ' b', span: { start: 7, end: 9 } },
      ],
    },
  ],
};

function plainDoc(source: string): ParsedDocument {
  const span = { start: 0, end: source.length };
  return {
    source,
    blocks: [
      { kind: 'paragraph', span, children: [{ kind: 'text', value: source, span }] },
    ],
  };
}

function project(doc: ParsedDocument): ProjectedRun {
  return projectRun(segmentRuns(doc)[0], doc);
}

const KEY = 'run:0';

linkNativeEngineAsDefault();

/** The state after the user selects the `b` in `a &amp; b`. */
function selectedB(): { state: SelectionTrackingState; projected: ProjectedRun } {
  const projected = project(entityDoc);
  const { state, emit } = reduceRunSelection(EMPTY_SELECTION_STATE, KEY, {
    kind: 'select',
    range: { start: 4, end: 5 },
    projected,
  });
  expect(emit).toBe(true);
  expect(state.selection).toEqual({ span: { start: 8, end: 9 }, plain: 'b' });
  return { state, projected };
}

describe('reduceRunSelection: a projection change under a live selection', () => {
  it('remaps a source-only edit that leaves the display text identical', () => {
    const { state } = selectedB();
    const next = project(plainDoc('a & b'));
    expect(next.text).toBe('a & b');

    const result = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected: next,
    });
    expect(result.emit).toBe(true);
    expect(result.state.selection).toEqual({
      span: { start: 4, end: 5 },
      plain: 'b',
    });
    expect(result.state.owner).toBe(KEY);
    expect(result.state.projected).toBe(next);
  });

  it('clears and reports null when the stored range no longer maps', () => {
    const { state } = selectedB();
    // The display text shrinks under the range: [4,5) is past the end of `a`.
    const result = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected: project(plainDoc('a')),
    });
    expect(result.emit).toBe(true);
    expect(result.state).toEqual(EMPTY_SELECTION_STATE);
  });

  it('does not re-emit when the source range comes out the same', () => {
    const { state } = selectedB();
    // A fresh projection object of the same document.
    const result = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected: project(entityDoc),
    });
    expect(result.emit).toBe(false);
    expect(result.state.selection).toBe(state.selection);
    expect(
      reduceRunSelection(state, KEY, {
        kind: 'reproject',
        projected: project(plainDoc('a & b')),
      }).emit,
    ).toBe(true);
  });

  it('ignores a projection change from a run that does not own the selection', () => {
    const { state } = selectedB();
    const result = reduceRunSelection(state, 'run:20', {
      kind: 'reproject',
      projected: null,
    });
    expect(result.emit).toBe(false);
    expect(result.state).toBe(state);
    const fromOwner = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected: null,
    });
    expect(fromOwner.emit).toBe(true);
    expect(fromOwner.state.selection).toBeNull();
  });

  it('ignores the same projection reported again', () => {
    const { state, projected } = selectedB();
    const result = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected,
    });
    expect(result.emit).toBe(false);
    expect(result.state).toBe(state);
    const fresh = project(entityDoc);
    expect(
      reduceRunSelection(state, KEY, { kind: 'reproject', projected: fresh })
        .state.projected,
    ).toBe(fresh);
  });
});

describe('reduceRunSelection: the owner run going standalone', () => {
  it('clears and reports null, since the host unmounted without a report', () => {
    const { state } = selectedB();
    const result = reduceRunSelection(state, KEY, {
      kind: 'reproject',
      projected: null,
    });
    expect(result.emit).toBe(true);
    expect(result.state).toEqual(EMPTY_SELECTION_STATE);
  });
});

describe('reduceRunSelection: native reports', () => {
  it('treats an empty range as a clear from that run', () => {
    const { state, projected } = selectedB();
    const result = reduceRunSelection(state, KEY, {
      kind: 'select',
      range: { start: 3, end: 3 },
      projected,
    });
    expect(result.emit).toBe(true);
    expect(result.state).toEqual(EMPTY_SELECTION_STATE);
  });

  it('drops a clear from a run that is not the owner', () => {
    const { state } = selectedB();
    const result = reduceRunSelection(state, 'run:20', { kind: 'clear' });
    expect(result.emit).toBe(false);
    expect(result.state).toBe(state);
    const fromOwner = reduceRunSelection(state, KEY, { kind: 'clear' });
    expect(fromOwner.emit).toBe(true);
    expect(fromOwner.state.selection).toBeNull();
  });
});

describe('resetSelection: imperative clearSelection()', () => {
  it('ends the stored selection even when the owner host is unreachable', () => {
    // The owner went standalone without the reducer hearing of it, so the
    // host handle is null and the native clear reaches nothing.
    const { state } = selectedB();
    const result = resetSelection(state);
    expect(result.emit).toBe(true);
    expect(result.state).toEqual(EMPTY_SELECTION_STATE);

    const late = reduceRunSelection(result.state, KEY, { kind: 'clear' });
    expect(late.emit).toBe(false);
  });

  it('emits nothing when there is no selection', () => {
    const result = resetSelection(EMPTY_SELECTION_STATE);
    expect(result.emit).toBe(false);
    expect(result.state).toBe(EMPTY_SELECTION_STATE);
    expect(resetSelection(selectedB().state).emit).toBe(true);
  });
});

describeNative('reduceRunSelection: md4c, a source edit the host cannot see', () => {
  // Both display `A & B`, so the host never re-reports; left at 8..9 the span would name the `;` of `&#x26;`.
  it('moves the selected `B` from `A &amp; B` to `A &#x26; B`', () => {
    const before = parseDocument('A &amp; B');
    const after = parseDocument('A &#x26; B');
    const projectedBefore = project(before);
    const projectedAfter = project(after);
    expect(projectedBefore.text).toBe('A & B');
    expect(projectedAfter.text).toBe(projectedBefore.text);

    const selected = reduceRunSelection(EMPTY_SELECTION_STATE, KEY, {
      kind: 'select',
      range: { start: 4, end: 5 },
      projected: projectedBefore,
    });
    expect(selected.state.selection).toEqual({
      span: { start: 8, end: 9 },
      plain: 'B',
    });

    const result = reduceRunSelection(selected.state, KEY, {
      kind: 'reproject',
      projected: projectedAfter,
    });
    expect(result.emit).toBe(true);
    expect(result.state.selection).toEqual({
      span: { start: 9, end: 10 },
      plain: 'B',
    });
    expect(after.source.slice(9, 10)).toBe('B');
  });
});


describe('nonexclusive selections', () => {
  test('clearing the newest selection restores the preceding live selection', () => {
    const projected = project(plainDoc('abc'));
    let state = EMPTY_SELECTION_STATE;
    for (const key of ['a', 'b']) {
      state = reduceRunSelection(state, key, {
        kind: 'select', projected, range: { start: 0, end: 2 },
      }, false).state;
    }
    const cleared = reduceRunSelection(state, 'b', { kind: 'clear' }, false);
    expect(cleared.emit).toBe(true);
    expect(cleared.state.owner).toBe('a');
    expect(cleared.state.selection?.plain).toBe('ab');
    expect(reduceRunSelection(cleared.state, 'a', { kind: 'clear' }, false).state.selection).toBeNull();
  });

  test('a background selection follows projection changes until it becomes current again', () => {
    const before = project(plainDoc('abc'));
    const after = project(plainDoc('xyz'));
    let state = reduceRunSelection(EMPTY_SELECTION_STATE, 'a', {
      kind: 'select', projected: before, range: { start: 0, end: 2 },
    }, false).state;
    state = reduceRunSelection(state, 'b', {
      kind: 'select', projected: before, range: { start: 1, end: 3 },
    }, false).state;
    const changed = reduceRunSelection(state, 'a', { kind: 'reproject', projected: after }, false);
    expect(changed.emit).toBe(false);
    state = reduceRunSelection(changed.state, 'b', { kind: 'clear' }, false).state;
    expect(state.selection?.plain).toBe('xy');
    expect(resetSelection(state).state).toBe(EMPTY_SELECTION_STATE);
  });
});
