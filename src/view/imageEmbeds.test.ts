// The claim's `render` goes through `renderNode`, which pulls in `react-native`.

jest.mock('react-native', () => ({
  Image: 'Image',
  Linking: { openURL: () => Promise.resolve() },
  Text: 'Text',
  View: 'View',
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) =>
      options.ios !== undefined ? options.ios : options.default,
  },
}));

import type { ReactElement } from 'react';
import type {
  AnyNode,
  ImageNode,
  ParagraphNode,
} from '../document/nodes';
import { EMBED_PLACEHOLDER, projectRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { EmbedClaimContext } from '../selection/runs';
import { makeDoc, plainParagraph, spanOf } from '../selection/__tests__/fixtures';
import { withImageEmbeds } from './imageEmbeds';
import type { EmbedRenderer } from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { parseDocument } from '../engine/Engine';
import { presets } from '../engine/options';
import { describeNative, requireNativeEngine } from '../engine/native/__tests__/support';

const BOX = { width: 280, height: 200 };
const NESTED: EmbedClaimContext = { topLevel: false, soleChildOfTopLevelParagraph: true };

const SOURCE = 'Before.\n\n![alt](img.png)\n\nAfter.';

describeNative('image placement boundaries', () => {
  it.each([
    ['![alt](https://e.test/a.png)', false],
    ['text ![alt](https://e.test/a.png)', true],
    ['# ![alt](https://e.test/a.png)', true],
    ['**![alt](https://e.test/a.png)**', true],
    ['- ![alt](https://e.test/a.png)', true],
    ['> ![alt](https://e.test/a.png)', true],
    ['| Image |\n| --- |\n| ![alt](https://e.test/a.png) |', true],
  ])('keeps segmentation and projection consistent for %j', (source, standalone) => {
    const doc = parseDocument(source, presets.llmChat, requireNativeEngine());
    const embed = withImageEmbeds(undefined, BOX);
    const [run] = segmentRuns(doc, { embed });
    expect(run.standalone).toBe(standalone);
    const projected = projectRun(run, doc, { embed });
    expect(projected.embeds ?? []).toHaveLength(standalone ? 0 : 1);
  });
});

function imageNode(alt = 'alt'): ImageNode {
  return {
    kind: 'image',
    src: 'img.png',
    alt,
    span: spanOf(SOURCE, '![alt](img.png)'),
  };
}

function imageDoc(image: ImageNode) {
  const paragraph: ParagraphNode = {
    kind: 'paragraph',
    span: image.span,
    children: [image],
  };
  return makeDoc(SOURCE, [
    plainParagraph(SOURCE, 'Before.'),
    paragraph,
    plainParagraph(SOURCE, 'After.'),
  ]);
}

describe('withImageEmbeds', () => {
  it('claims an image at the theme box', () => {
    const claim = withImageEmbeds(undefined, BOX)(imageNode(), NESTED);

    expect(claim).toMatchObject({ width: 280, height: 200, text: 'alt' });
    expect(typeof claim?.render).toBe('function');
  });

  it('declares no copy text for an image with no alt', () => {
    // No `text` drops the placeholder from copy text instead of copying U+FFFC.
    const claim = withImageEmbeds(undefined, BOX)(imageNode(''), NESTED);

    expect(claim).toMatchObject({ width: 280, height: 200 });
    expect(claim).not.toHaveProperty('text');
  });

  it('claims nothing but images', () => {
    const lookup = withImageEmbeds(undefined, BOX);
    const text: AnyNode = {
      kind: 'text',
      value: 'hi',
      span: { start: 0, end: 2 },
    };

    expect(lookup(text, NESTED)).toBeUndefined();
    expect(lookup(imageNode(), NESTED)).toMatchObject({ width: 280, height: 200 });
  });

  it('lets the consumer claim win outright', () => {
    const consumer: EmbedRenderer = (node) =>
      node.kind === 'image'
        ? { width: 40, height: 40, text: '[pic]', render: () => null }
        : undefined;

    const claim = withImageEmbeds(consumer, BOX)(imageNode(), NESTED);

    expect(claim).toMatchObject({ width: 40, height: 40, text: '[pic]' });
  });

  it('passes the claim context through to the consumer unchanged', () => {
    const seen: EmbedClaimContext[] = [];
    const consumer: EmbedRenderer = (_node, context) => {
      seen.push(context);
      return undefined;
    };
    const lookup = withImageEmbeds(consumer, BOX);
    lookup(imageNode(), { topLevel: true });
    lookup(imageNode(), NESTED);

    expect(seen).toEqual([{ topLevel: true }, NESTED]);
  });

  it.each([
    ['zero', { width: 0, height: 200 }],
    ['negative', { width: 280, height: -1 }],
    ['NaN', { width: Number.NaN, height: 200 }],
    ['infinite', { width: 280, height: Number.POSITIVE_INFINITY }],
  ])('declines a %s box, leaving the image to VIEW_KINDS', (_label, box) => {
    expect(withImageEmbeds(undefined, box)(imageNode(), NESTED)).toBeUndefined();
    expect(withImageEmbeds(undefined, BOX)(imageNode(), NESTED)).toMatchObject(BOX);
  });

  it('renders through the context image renderer, overrides included', () => {
    // Placed as an element, not called, so an override's hooks get their own instance.
    const drawn: ImageNode[] = [];
    const image = imageNode();
    const renderImage = (node: ImageNode): null => {
      drawn.push(node);
      return null;
    };
    const ctx = {
      renderers: { image: renderImage },
    } as unknown as RenderContext;
    const claim = withImageEmbeds(undefined, BOX)(image, NESTED);

    const element = claim?.render(image, ctx) as ReactElement<{
      node: unknown;
      render: unknown;
    }>;

    expect(drawn).toEqual([]);
    expect(element.props.node).toBe(image);
    expect(element.props.render).toBe(renderImage);

    (element.type as (props: unknown) => unknown)(element.props);
    expect(drawn).toEqual([image]);
  });
});

describe('the images: "embed" default, through the pipeline', () => {
  it('keeps an image paragraph inside the prose run', () => {
    const image = imageNode();
    const doc = imageDoc(image);

    expect(segmentRuns(doc).map((run) => run.standalone)).toEqual([
      false,
      true,
      false,
    ]);

    const runs = segmentRuns(doc, {
      embed: withImageEmbeds(undefined, BOX),
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].standalone).toBe(false);
  });

  it('projects the image as one placeholder that maps to its whole source', () => {
    const image = imageNode();
    const doc = imageDoc(image);
    const embed = withImageEmbeds(undefined, BOX);
    const [run] = segmentRuns(doc, { embed });
    const projected = projectRun(run, doc, { embed });

    expect(projected.text).toBe(
      `Before.\n\n${EMBED_PLACEHOLDER}\n\nAfter.`,
    );
    expect(projected.embeds).toHaveLength(1);
    expect(projected.embeds?.[0]).toMatchObject({
      embedId: 0,
      node: image,
      content: { width: 280, height: 200, text: 'alt' },
    });
    expect(projected.text).not.toContain('alt');
  });

  it('leaves the image standalone when the claim is declined', () => {
    const doc = imageDoc(imageNode());
    const runs = segmentRuns(doc, {
      embed: withImageEmbeds(undefined, { width: 0, height: 0 }),
    });

    expect(runs.map((run) => run.standalone)).toEqual([false, true, false]);
  });

  it('never embeds an image the stream is still repairing', () => {
    // `embedContentFor` refuses incomplete nodes whatever the claim says.
    const image = { ...imageNode(), incomplete: true as const };
    const runs = segmentRuns(imageDoc(image), {
      embed: withImageEmbeds(undefined, BOX),
    });

    expect(runs.map((run) => run.standalone)).toEqual([false, true, false]);
  });
});
