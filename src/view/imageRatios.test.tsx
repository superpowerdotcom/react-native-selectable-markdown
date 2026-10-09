import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SelectableMarkdown } from './SelectableMarkdown';
import { StreamSession } from '../stream/StreamSession';
import { presets } from '../engine/options';
import type { Engine } from '../engine/Engine';
import { nativeEngine } from '../engine/native';
import { describeNative, linkNativeEngineAsDefault } from '../engine/native/__tests__/support';

type SizeCall = {
  src: string;
  ok: (width: number, height: number) => void;
  fail: (error: unknown) => void;
};
const mockSizeCalls: SizeCall[] = [];

jest.mock('react-native', () => ({
  View: 'View', Text: 'Text',
  Image: Object.assign('Image', {
    getSize: (src: string, ok: SizeCall['ok'], fail: SizeCall['fail']) => {
      mockSizeCalls.push({ src, ok, fail });
    },
  }),
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
  useColorScheme: () => 'light',
  UIManager: { hasViewManagerConfig: () => true },
  processColor: (color: unknown) => color,
  Linking: { openURL: jest.fn() },
  StyleSheet: { flatten: (style: unknown) => style },
}));

jest.mock('./SelectableRunHostNativeComponent', () => {
  const react = require('react') as typeof React;
  const Native = react.forwardRef((props: any, ref) => {
    react.useImperativeHandle(ref, () => ({ props }), [props]);
    return react.createElement('NativeRunHost', props);
  });
  return { __esModule: true, default: Native, Commands: {} };
});

linkNativeEngineAsDefault();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGES = { width: 200, height: 'intrinsic' } as const;
const FALLBACK = 200; // defaultTheme.spacing.imageHeight

let trees: ReactTestRenderer[] = [];
let urlCounter = 0;
/** Ratios are cached per URL across the module, so every test uses fresh ones. */
function freshUrl(): string {
  urlCounter += 1;
  return `https://e.test/ratio-${urlCounter}.png`;
}
function doc(src: string): string {
  return `Before.\n\n![alt](${src})\n\nAfter.`;
}
function embedHeights(tree: ReactTestRenderer): number[] {
  return tree.root
    .findAll((node) => (node.type as unknown) === 'NativeRunHost')
    .flatMap((node) => (node.props.embeds ?? []) as { height: number }[])
    .map((embed) => embed.height);
}
async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(() => { tree = create(element); });
  trees.push(tree!);
  return tree!;
}
function resolve(src: string, width: number, height: number): void {
  const calls = mockSizeCalls.filter((call) => call.src === src);
  expect(calls).toHaveLength(1);
  calls[0].ok(width, height);
}

beforeEach(() => { mockSizeCalls.length = 0; });
afterEach(async () => {
  for (const tree of trees) await act(() => tree.unmount());
  trees = [];
});

describeNative('intrinsic image ratios', () => {
  test('one request answers every view of the same URL', async () => {
    const src = freshUrl();
    const first = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    const second = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    expect(embedHeights(first)).toEqual([FALLBACK]);
    expect(embedHeights(second)).toEqual([FALLBACK]);
    await act(() => resolve(src, 400, 100));
    expect(embedHeights(first)).toEqual([50]);
    expect(embedHeights(second)).toEqual([50]);
  });

  test('survives a StrictMode remount of the requesting effect', async () => {
    const src = freshUrl();
    const tree = await render(
      <StrictMode><SelectableMarkdown source={doc(src)} images={IMAGES} /></StrictMode>,
    );
    await act(() => resolve(src, 200, 100));
    expect(embedHeights(tree)).toEqual([100]);
  });

  test('reaches the view that started the request after its effect re-ran mid-load', async () => {
    const src = freshUrl();
    const other = freshUrl();
    const tree = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    await act(() => tree.update(
      <SelectableMarkdown source={`${doc(src)}\n\n![b](${other})`} images={IMAGES} />,
    ));
    await act(() => resolve(src, 100, 50));
    expect(embedHeights(tree)[0]).toBe(100);
  });

  test('picks up a ratio that landed before the view subscribed', async () => {
    const src = freshUrl();
    const first = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    await act(() => resolve(src, 100, 50));
    expect(embedHeights(first)).toEqual([100]);
    const second = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    expect(embedHeights(second)).toEqual([100]);
    expect(mockSizeCalls.filter((call) => call.src === src)).toHaveLength(1);
  });

  test('a failed request keeps the fallback and stops notifying unmounted views', async () => {
    const src = freshUrl();
    const tree = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    await act(() => tree.unmount());
    trees = trees.filter((entry) => entry !== tree);
    const calls = mockSizeCalls.filter((call) => call.src === src);
    expect(calls).toHaveLength(1);
    await act(() => calls[0].fail(new Error('404')));
    const again = await render(<SelectableMarkdown source={doc(src)} images={IMAGES} />);
    expect(embedHeights(again)).toEqual([FALLBACK]);
  });

  test('a failed request is not repeated on later streaming snapshots', async () => {
    const src = freshUrl();
    const session = new StreamSession({ options: presets.llmChat });
    const tree = await render(<SelectableMarkdown session={session} images={IMAGES} />);
    await act(() => session.append(`![a](${src})\n\nText starts here`));
    const calls = mockSizeCalls.filter((call) => call.src === src);
    expect(calls).toHaveLength(1);
    await act(() => calls[0].fail(new Error('404')));
    for (let i = 0; i < 25; i += 1) {
      await act(() => session.append(` word${i}`));
    }
    expect(mockSizeCalls.filter((call) => call.src === src)).toHaveLength(1);
    expect(embedHeights(tree)).toEqual([FALLBACK]);
  });

  test('a src with a newline from an engine that skips the URL policy is not split into requests', async () => {
    const src = `${freshUrl()}\nhttps://e.test/second.png`;
    const engine: Engine = {
      name: 'newline-src',
      parse(source, options) {
        const parsed = nativeEngine.parse(source, options);
        const blocks = parsed.blocks.map((block) =>
          block.kind === 'paragraph' && block.children[0]?.kind === 'image'
            ? { ...block, children: [{ ...block.children[0], src }] }
            : block,
        );
        return { ...parsed, blocks };
      },
    };
    await render(<SelectableMarkdown source={doc(freshUrl())} images={IMAGES} engine={engine} />);
    expect(mockSizeCalls).toEqual([]);
  });
});
