// ts-jest type-checks this file, so a declaration that stops compiling fails the suite.
// The components are `import type` because both load `react-native` at module scope.

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
import type { segmentRuns } from '../selection/runs';

describe('SelectableMarkdownProps.selectionActions', () => {
  test('accepts the exported default list', () => {
    // The default is a frozen readonly array; a mutable prop type rejects it (TS4104).
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
    // `(string & {})` lets this compile while 'copy-text' still autocompletes.
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
  // Both components enumerate the props they forward, so each must be listed to reach the host.
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
  test('ref is a legal prop, and it is the selection handle', () => {
    type DocumentProps = ComponentPropsWithRef<typeof SelectableMarkdown>;
    const documentRef: RefObject<SelectableMarkdownHandle | null> = { current: null };
    const withRef: DocumentProps = { source: 'x', ref: documentRef };
    expect(withRef.source).toBe('x');

    type HostProps = ComponentPropsWithRef<typeof RunHost>;
    const hostRef: RefObject<RunHostHandle | null> = { current: null };
    const hostWithRef: HostProps = {
      text: 'A run',
      selectable: true,
      ref: hostRef,
    };
    expect(hostWithRef.text).toBe('A run');
  });

  test('onSelectionChange takes a selection or null', () => {
    // Null is the only report that a selection ended.
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
    // Deliberately not `SelectableMarkdownHandle`'s shape, so source offsets cannot reach a run.
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
    // Undefined, not false: the default lives in the component and the codegen spec.
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
    const omitted: SelectableMarkdownProps = { source: '# hi' };
    expect(omitted.maxRunChars).toBeUndefined();
  });
});
