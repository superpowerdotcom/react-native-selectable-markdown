/**
 * The public prop surfaces of `<SelectableMarkdown>` and `<RunHost>`, checked
 * as TYPES.
 *
 * These cases assert almost nothing at runtime, and that is the point: every
 * defect they cover was a compile error in a consumer's app and nothing at all
 * in this repository's test run — a prop that rejected the package's own
 * exported constant, a container with no style escape hatch, an accessibility
 * prop with nowhere to go. ts-jest type-checks the file it compiles, so a
 * declaration below that stops type-checking fails this suite the way a bad
 * expectation would.
 *
 * Type-only imports of the two components, deliberately: both modules import
 * `react-native` at module scope, which this Node test environment cannot
 * load. `import type` is erased before anything runs, so the props can be
 * checked here without the renderer being reachable. `DEFAULT_SELECTION_ACTIONS`
 * is a value, but `selectionActions.ts` is React Native-free (its own suite
 * runs in this environment for the same reason).
 */

import type { ComponentPropsWithRef, RefObject } from 'react';
import { DEFAULT_LINK_PREFIXES } from '../engine/options';
import type { RunHost, RunHostHandle, RunHostProps } from './RunHost';
import type { SelectableMarkdown } from './SelectableMarkdown';
import type {
  SelectableMarkdownHandle,
  SelectableMarkdownProps,
  SelectableMarkdownSelection,
} from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { DEFAULT_SELECTION_ACTIONS } from './selectionActions';
import { DEFAULT_MAX_RUN_CHARS, segmentRuns } from '../selection/runs';

describe('SelectableMarkdownProps.selectionActions', () => {
  test('accepts the exported default list', () => {
    // `DEFAULT_SELECTION_ACTIONS` is a frozen `readonly SelectionAction[]`, so
    // a mutable `SelectionAction[]` prop rejected it outright (TS4104) — the
    // package's own default, unusable as a value for the prop it defaults.
    const props: SelectableMarkdownProps = {
      source: '# hi',
      selectionActions: DEFAULT_SELECTION_ACTIONS,
    };
    expect(props.selectionActions).toEqual(['copy-text', 'copy-markdown']);
  });

  test('accepts an `as const` list and a plain array alike', () => {
    const frozen: SelectableMarkdownProps = {
      selectionActions: ['copy-markdown'] as const,
    };
    const mutable: SelectableMarkdownProps = {
      selectionActions: ['copy-text', 'copy-markdown'],
    };
    expect(frozen.selectionActions).toEqual(['copy-markdown']);
    expect(mutable.selectionActions).toHaveLength(2);
  });

  test('matches what RunHost takes, which is where the list ends up', () => {
    const actions: SelectableMarkdownProps['selectionActions'] =
      DEFAULT_SELECTION_ACTIONS;
    const forwarded: RunHostProps['selectionActions'] = actions;
    expect(forwarded).toBe(DEFAULT_SELECTION_ACTIONS);
  });

  test('takes a bare id and an { id, title } pair in the same list', () => {
    // The title channel had to be additive: a bare id is still the whole of
    // the pre-title API, and it is what a consumer writes to keep the host's
    // own localised string. Mixing the two spellings in one list is the
    // documented way to retitle one item and leave the other alone.
    const mixed: SelectableMarkdownProps = {
      source: '# hi',
      selectionActions: [
        'copy-text',
        { id: 'copy-markdown', title: 'Copier le Markdown' },
      ],
    };
    expect(mixed.selectionActions).toHaveLength(2);
    const forwarded: RunHostProps['selectionActions'] =
      mixed.selectionActions;
    expect(forwarded).toBe(mixed.selectionActions);
  });

  test('takes a consumer-defined id without a cast', () => {
    // `SelectionActionId` is `SelectionAction | (string & {})` rather than
    // plain `string` precisely so this compiles while 'copy-text' still
    // autocompletes. A closed union here would have made a consumer action
    // unspellable, which is the defect this prop shape exists to remove.
    const custom: SelectableMarkdownProps = {
      source: '# hi',
      selectionActions: [{ id: 'share-quote', title: 'Share' }, 'copy-text'],
    };
    expect(custom.selectionActions?.[0]).toEqual({
      id: 'share-quote',
      title: 'Share',
    });
  });
});

describe('SelectableMarkdownProps.images', () => {
  test('takes both modes, and defaults by omission', () => {
    // The prop exists because the default CHANGED: an image is claimed as an
    // embed and flows inside its run, where it used to send its whole
    // containing block to a selection scope of its own. `'standalone'` is the
    // one-word way back, so it has to be spellable without a cast.
    const embedded: SelectableMarkdownProps = {
      source: '![a](https://e.com/a.png)',
      images: 'embed',
    };
    const standalone: SelectableMarkdownProps = {
      source: '![a](https://e.com/a.png)',
      images: 'standalone',
    };
    const omitted: SelectableMarkdownProps = { source: 'x' };

    expect(embedded.images).toBe('embed');
    expect(standalone.images).toBe('standalone');
    expect(omitted.images).toBeUndefined();
  });
});

describe('RenderContext.linkPrefixes', () => {
  test('a context can carry the allowlist a press is checked against', () => {
    // `openUrl` re-checks the href at navigation time, because the parse-time
    // allowlist is `nativeEngine`'s property and not `parseDocument`'s. A
    // consumer driving `renderBlocks` itself has to be able to say which list
    // applies; omitting it falls back to `DEFAULT_LINK_PREFIXES`.
    const prefixes: RenderContext['linkPrefixes'] = [
      ...DEFAULT_LINK_PREFIXES,
      'myapp://',
    ];

    expect(prefixes).toContain('mailto:');
    expect(prefixes).toContain('myapp://');
  });
});

describe('the container escape hatches', () => {
  test('style and onLayout reach the document container', () => {
    // The root used to be a bare `<View style={{ padding }}>`: theming's one
    // container token is that padding, so a margin, a background or a measured
    // box meant wrapping the component in a view of your own.
    const layouts: number[] = [];
    const props: SelectableMarkdownProps = {
      source: 'x',
      style: [{ marginTop: 8 }, { backgroundColor: '#fff' }],
      onLayout: (event) => layouts.push(event.nativeEvent.layout.height),
    };
    props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 44 } },
    } as Parameters<NonNullable<SelectableMarkdownProps['onLayout']>>[0]);
    expect(layouts).toEqual([44]);
    expect(props.style).toHaveLength(2);
  });
});

describe('accessibility passthrough', () => {
  // The native host has always accepted these (its codegen spec's `NativeProps
  // extends ViewProps`); what was missing was any way to set them from JS,
  // because both components enumerate the props they forward.
  test('the document container takes the RN accessibility props', () => {
    const props: SelectableMarkdownProps = {
      source: 'x',
      accessible: true,
      accessibilityLabel: 'Assistant reply',
      accessibilityHint: 'Long press to select text',
      accessibilityRole: 'text',
      accessibilityLanguage: 'en-US',
      accessibilityLiveRegion: 'polite',
      importantForAccessibility: 'yes',
    };
    expect(props.accessibilityLabel).toBe('Assistant reply');
  });

  test('a run host takes the same set, for a consumer driving runs itself', () => {
    const props: RunHostProps = {
      text: 'A run',
      selectable: true,
      accessible: true,
      accessibilityLabel: 'Answer, paragraph 1',
      accessibilityRole: 'header',
      accessibilityLanguage: 'ar',
      accessibilityElementsHidden: false,
    };
    expect(props.accessibilityRole).toBe('header');
  });
});

describe('the imperative selection surface', () => {
  // Every case here was a compile error before the API existed — `ref` was
  // not a legal prop, so an app could not clear a stale selection on
  // navigation, highlight a span it had computed, or learn that a selection
  // existed at all until the user picked a menu item.

  test('ref is a legal prop, and it is the selection handle', () => {
    // THE EXACT DEFECT THIS SURFACE FIXES. `<SelectableMarkdown ref={ref} />`
    // used to be `error TS2322: Property 'ref' does not exist on type
    // 'IntrinsicAttributes & SelectableMarkdownProps'` — a plain function
    // component takes no ref — which is a compile error in a consumer's app
    // and nothing at all here. `typeof` on a type-only import is the way to
    // ask that question without loading a module this Node environment
    // cannot: both components import `react-native` at module scope.
    type DocumentProps = ComponentPropsWithRef<typeof SelectableMarkdown>;
    const documentRef: RefObject<SelectableMarkdownHandle> = { current: null };
    const withRef: DocumentProps = { source: 'x', ref: documentRef };
    expect(withRef.source).toBe('x');

    // And the same for a consumer driving runs themselves, with the run's own
    // handle type rather than the document's.
    type HostProps = ComponentPropsWithRef<typeof RunHost>;
    const hostRef: RefObject<RunHostHandle> = { current: null };
    const hostWithRef: HostProps = {
      text: 'A run',
      selectable: true,
      ref: hostRef,
    };
    expect(hostWithRef.text).toBe('A run');
  });

  test('onSelectionChange takes a selection or null', () => {
    // Null is half the contract: a toolbar that can be shown has to be
    // dismissible, and nothing else reports the end of a selection —
    // `onSelectionCopy` fires only after the user has committed to a menu
    // item.
    const seen: (SelectableMarkdownSelection | null)[] = [];
    const props: SelectableMarkdownProps = {
      source: '# Title\n\nBody',
      onSelectionChange: (selection) => seen.push(selection),
    };
    props.onSelectionChange?.({ span: { start: 2, end: 7 }, plain: 'Title' });
    props.onSelectionChange?.(null);
    expect(seen).toEqual([
      { span: { start: 2, end: 7 }, plain: 'Title' },
      null,
    ]);
  });

  test('the handle reads, clears and sets, and setSelection answers', () => {
    // `setSelection` returns a boolean because "no run shows that span" is a
    // real outcome — a standalone block, a span of pure syntax, a run that
    // has not mounted. A void return would have made it silently ignorable.
    const calls: string[] = [];
    const handle: SelectableMarkdownHandle = {
      getSelection: () => null,
      clearSelection: () => calls.push('clear'),
      setSelection: (span) => {
        calls.push(`set:${span.start}-${span.end}`);
        return span.end > span.start;
      },
    };
    handle.clearSelection();
    expect(handle.setSelection({ start: 0, end: 5 })).toBe(true);
    expect(handle.setSelection({ start: 5, end: 5 })).toBe(false);
    expect(handle.getSelection()).toBeNull();
    expect(calls).toEqual(['clear', 'set:0-5', 'set:5-5']);
  });

  test('a run host handle speaks the run’s own offsets, not source ones', () => {
    // The two handles are deliberately different types: `RunHostHandle`
    // takes display offsets (what every event on the native component
    // reports), and `SelectableMarkdownHandle` takes a `SourceSpan`. Making
    // them the same shape is what would let a caller hand source offsets to a
    // run and select the wrong characters.
    //
    // `RunHostHandle.setSelection` also REPORTS whether it dispatched, which
    // is what lets `SelectableMarkdownHandle.setSelection` keep looking (and
    // ultimately answer false) when the run that shows a span cannot take a
    // selection — the unsettled tail on Android, a `selectable={false}` run,
    // a binary with no selection commands.
    const calls: number[][] = [];
    const handle: RunHostHandle = {
      clearSelection: () => calls.push([]),
      setSelection: (start, end) => {
        calls.push([start, end]);
        return end > start;
      },
    };
    expect(handle.setSelection(3, 9)).toBe(true);
    expect(handle.setSelection(9, 9)).toBe(false);
    handle.clearSelection();
    expect(calls).toEqual([[3, 9], [9, 9], []]);
  });

  test('exclusiveSelection is a boolean on both components, default by omission', () => {
    const opted: SelectableMarkdownProps = {
      source: 'x',
      exclusiveSelection: false,
    };
    const omitted: SelectableMarkdownProps = { source: 'x' };
    const run: RunHostProps = {
      text: 'A run',
      selectable: true,
      exclusiveSelection: false,
    };
    expect(opted.exclusiveSelection).toBe(false);
    // Undefined, not false: the default lives in the component (and in the
    // codegen spec's `WithDefault<boolean, true>`), so an omitted prop must
    // stay distinguishable from an explicit opt-out.
    expect(omitted.exclusiveSelection).toBeUndefined();
    expect(run.exclusiveSelection).toBe(false);
  });

  test('a run host takes onSelectionChange with empty ranges', () => {
    const ranges: number[][] = [];
    const props: RunHostProps = {
      text: 'A run',
      selectable: true,
      onSelectionChange: (event) => ranges.push([event.start, event.end]),
    };
    props.onSelectionChange?.({ start: 4, end: 9 });
    // An empty range is a legal payload on this event alone.
    props.onSelectionChange?.({ start: 0, end: 0 });
    expect(ranges).toEqual([
      [4, 9],
      [0, 0],
    ]);
  });
});

describe('SelectableMarkdownProps.maxRunChars', () => {
  test('is the same knob segmentRuns takes, and the component forwards it', () => {
    // The gap this closes: the cap is a SELECTION boundary — a sweep cannot
    // cross from one native host into the next — and it had no prop, so a
    // consumer of `<SelectableMarkdown>` could not raise it, lower it, or opt
    // out. Only a caller reaching past the component into `segmentRuns` could.
    const props: SelectableMarkdownProps = {
      source: '# hi',
      maxRunChars: 2000,
    };
    const opted: SelectableMarkdownProps = { maxRunChars: Infinity };
    const forwarded: Parameters<typeof segmentRuns>[1] = {
      maxRunChars: props.maxRunChars,
    };

    expect(forwarded.maxRunChars).toBe(2000);
    expect(opted.maxRunChars).toBe(Infinity);
    // Omitted is the documented default, which is the exported constant.
    const omitted: SelectableMarkdownProps = { source: '# hi' };
    expect(omitted.maxRunChars).toBeUndefined();
    expect(DEFAULT_MAX_RUN_CHARS).toBe(8000);
  });
});
