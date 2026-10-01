import React, { createRef, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SelectableMarkdown, type SelectableMarkdownHandle } from './SelectableMarkdown';
import { RunHost } from './RunHost';
import { describeNative, linkNativeEngineAsDefault } from '../engine/native/__tests__/support';

jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', Image: 'Image',
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
  useColorScheme: () => 'light',
  UIManager: { hasViewManagerConfig: () => true },
  processColor: (color: unknown) => color,
  Linking: { openURL: jest.fn() },
}));

let mockMounts = 0;
let mockUnmounts = 0;
jest.mock('./SelectableRunHostNativeComponent', () => {
  const react = require('react') as typeof React;
  const Native = react.forwardRef((props: any, ref) => {
    react.useImperativeHandle(ref, () => ({ props }), [props]);
    react.useLayoutEffect(() => {
      mockMounts += 1;
      return () => { mockUnmounts += 1; };
    }, []);
    return react.createElement('NativeRunHost', props);
  });
  return {
    __esModule: true,
    default: Native,
    Commands: {
      setSelection: (view: any, start: number, end: number) => view.props.onSelectionChange?.({ nativeEvent: { start, end } }),
      clearSelection: (view: any) => view.props.onSelectionChange?.({ nativeEvent: { start: 0, end: 0 } }),
    },
  };
});

linkNativeEngineAsDefault();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
beforeEach(() => { mockMounts = 0; mockUnmounts = 0; });
afterEach(async () => {
  if (tree) await act(() => tree?.unmount());
  tree = undefined;
});

describeNative('selection component lifecycle', () => {
  test('keeps the native host and selection when the first image arrives', async () => {
    const ref = createRef<SelectableMarkdownHandle>();
    const changed = jest.fn();
    await act(() => { tree = create(<SelectableMarkdown ref={ref} source="Before." onSelectionChange={changed} />); });
    await act(() => { expect(ref.current?.setSelection({ start: 0, end: 3 })).toBe(true); });
    expect(ref.current?.getSelection()?.plain).toBe('Bef');
    await act(() => tree!.update(<SelectableMarkdown ref={ref} source={'Before.\n\n![alt](https://e.test/a.png)\n\nAfter.'} onSelectionChange={changed} />));
    expect(mockMounts).toBe(1);
    expect(mockUnmounts).toBe(0);
    expect(ref.current?.getSelection()?.plain).toBe('Bef');
    await act(() => tree!.update(<SelectableMarkdown ref={ref} source="Before ![alt](https://e.test/a.png)" onSelectionChange={changed} />));
    expect(ref.current?.getSelection()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  test('registers projections before a parent layout effect selects text', async () => {
    const ref = createRef<SelectableMarkdownHandle>();
    const attempts: boolean[] = [];
    function Parent({ source }: { source: string }) {
      useLayoutEffect(() => { attempts.push(ref.current!.setSelection({ start: 0, end: source.length })); }, [source]);
      return <SelectableMarkdown ref={ref} source={source} />;
    }
    await act(() => { tree = create(<Parent source="One" />); });
    expect(ref.current?.getSelection()?.plain).toBe('One');
    await act(() => tree!.update(<Parent source="Another" />));
    expect(attempts).toEqual([true, true]);
    expect(ref.current?.getSelection()?.plain).toBe('Another');
    await act(() => ref.current!.clearSelection());
    expect(ref.current?.getSelection()).toBeNull();
  });

  test('falls back to a surviving run when nonexclusive selection ends', async () => {
    const ref = createRef<SelectableMarkdownHandle>();
    const changed = jest.fn();
    await act(() => { tree = create(<SelectableMarkdown ref={ref} source={'Alpha.\n\nBravo.'} maxRunChars={4} exclusiveSelection={false} onSelectionChange={changed} />); });
    const hosts = tree!.root.findAllByType('NativeRunHost' as any);
    expect(hosts).toHaveLength(2);
    const select = (index: number, start: number, end: number) => act(() => hosts[index].props.onSelectionChange({ nativeEvent: { start, end } }));
    await select(0, 0, 2);
    await select(1, 0, 2);
    await select(1, 0, 0);
    expect(ref.current?.getSelection()?.plain).toBe('Al');
    changed.mockClear();
    await act(() => ref.current!.clearSelection());
    expect(changed.mock.calls).toEqual([[null]]);
  });
});

test('a directly mounted RunHost reports an empty selection when removed', async () => {
  const changed = jest.fn();
  await act(() => { tree = create(<RunHost text="text" selectable onSelectionChange={changed} />); });
  await act(() => tree!.unmount());
  tree = undefined;
  expect(changed).toHaveBeenCalledWith({ start: 0, end: 0 });
});
