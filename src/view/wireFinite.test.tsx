import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RunHost } from './RunHost';

jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', Image: 'Image',
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
  UIManager: { hasViewManagerConfig: () => true },
  processColor: (color: unknown) => color,
}));

jest.mock('./SelectableRunHostNativeComponent', () => {
  const react = require('react') as typeof React;
  const Native = react.forwardRef((props: any, ref) => {
    react.useImperativeHandle(ref, () => ({ props }), [props]);
    return react.createElement('NativeRunHost', props);
  });
  return { __esModule: true, default: Native, Commands: {} };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(() => tree!.unmount());
  tree = undefined;
});

test('non-finite numbers never reach the native host; the range always does', async () => {
  await act(() => {
    tree = create(
      <RunHost
        text="abc def"
        selectable
        attributes={[{ start: 0, end: 3, fontSize: NaN, lineHeight: Infinity, letterSpacing: 1, roleLevel: -Infinity }]}
        decorations={[{ start: 0, end: 3, kind: 'box', borderRadius: Infinity, paddingTop: 4, textInset: NaN }]}
        pressables={[{ start: 4, end: 7, href: 'https://e.test', hitSlop: NaN, pressedRadius: 2 }]}
        embeds={[
          { start: 0, end: 1, embedId: 0, width: NaN, height: 10, node: { kind: 'text', value: 'x', span: { start: 0, end: 1 } } },
          { start: 4, end: 5, embedId: 1, width: 20, height: 10, node: { kind: 'text', value: 'd', span: { start: 4, end: 5 } } },
        ]}
        onInlinePress={() => {}}
        onEmbedLayout={() => {}}
      />,
    );
  });
  const host = tree!.root.findByType('NativeRunHost' as any);
  expect(host.props.attributes).toEqual([{ start: 0, end: 3, letterSpacing: 1 }]);
  expect(host.props.decorations).toEqual([{ start: 0, end: 3, kind: 'box', paddingTop: 4 }]);
  expect(host.props.pressables).toEqual([{ start: 4, end: 7, pressableId: 0, pressedRadius: 2 }]);
  expect(host.props.embeds).toEqual([{ start: 4, end: 5, embedId: 1, width: 20, height: 10 }]);
});
