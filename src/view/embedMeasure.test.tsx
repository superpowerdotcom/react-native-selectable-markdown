import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SelectableMarkdown } from './SelectableMarkdown';
import { describeNative, linkNativeEngineAsDefault } from '../engine/native/__tests__/support';

jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', Image: 'Image',
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
  useColorScheme: () => 'light',
  UIManager: { hasViewManagerConfig: () => true },
  processColor: (color: unknown) => color,
  Linking: { openURL: jest.fn() },
  StyleSheet: { flatten: (style: unknown) => style },
  NativeModules: {},
}));

jest.mock('./SelectableRunHostNativeComponent', () => {
  const react = require('react') as typeof React;
  const Native = react.forwardRef((props: any, ref) => {
    react.useImperativeHandle(ref, () => ({ props }), [props]);
    react.useLayoutEffect(() => {
      if (props.embeds?.length && props.onEmbedLayout) {
        for (const embed of props.embeds) {
          props.onEmbedLayout({
            nativeEvent: { embedId: embed.embedId, x: 0, y: 0, width: embed.width, height: embed.height },
          });
        }
      }
    }, [props.embeds, props.onEmbedLayout]);
    return react.createElement('NativeRunHost', props);
  });
  return { __esModule: true, default: Native, Commands: {} };
});

linkNativeEngineAsDefault();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(() => tree!.unmount());
  tree = undefined;
});

const hosts = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => (node.type as unknown) === 'NativeRunHost');
const overlays = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) =>
      (node.type as unknown) === 'View' &&
      typeof node.props.onLayout === 'function' &&
      node.props.pointerEvents === 'box-none',
  );

describeNative("measuring an 'auto' embed", () => {
  const renderCard = (): React.ReactElement => React.createElement('Card');
  const embed = (node: { kind: string }) =>
    node.kind === 'link'
      ? { width: 100, height: 'auto' as const, estimatedHeight: 30, render: renderCard }
      : undefined;
  const paragraphs = (label: string) =>
    Array.from({ length: 20 }, (_, i) => `${label} paragraph ${i}.`).join('\n\n');
  const source = `${paragraphs('Leading')}\n\n[card](https://c.test)\n\n${paragraphs('Trailing')}`;

  const measure = (height: number) =>
    act(() => overlays(tree!)[0].props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 100, height } } }));
  const reservation = (height: number) => [{ start: 0, end: 1, embedId: 0, width: 100, height }];

  test('re-reserves the measured run alone: no other host touched', async () => {
    await act(() => { tree = create(<SelectableMarkdown source={source} embed={embed} maxRunChars={60} />); });
    const before = hosts(tree!).map((host) => host.props);
    expect(before.length).toBeGreaterThan(10);
    expect(before.flatMap((props) => props.embeds)).toEqual(reservation(30));
    const embedded = before.findIndex((props) => props.embeds.length === 1);

    await measure(77);

    const after = hosts(tree!).map((host) => host.props);
    expect(after[embedded].embeds).toEqual(reservation(77));
    const touched = after.flatMap((props, index) => (props === before[index] ? [] : [index]));
    expect(touched).toEqual([embedded]);
  });

  test('the same height measured twice changes nothing', async () => {
    await act(() => { tree = create(<SelectableMarkdown source={source} embed={embed} maxRunChars={60} />); });
    await measure(50);
    const before = hosts(tree!).map((host) => host.props);
    expect(before.flatMap((props) => props.embeds)).toEqual(reservation(50));
    await measure(50);
    const after = hosts(tree!).map((host) => host.props);
    expect(after.every((props, index) => props === before[index])).toBe(true);
  });
});
