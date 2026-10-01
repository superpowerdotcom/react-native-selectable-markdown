import type { ReactNode } from 'react';
import type { AnyNode } from '../document/nodes';
import type { EmbedClaimContext } from '../selection/runs';
import type { EmbedRenderer, EmbedSpec } from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { renderNode } from './renderers';

/**
 * `SelectableMarkdown`'s `images` prop. `'embed'` (default) flows a sole image
 * of a top-level paragraph inside its run; `'standalone'` moves its block out.
 */
export type ImageMode = 'embed' | 'standalone';

/** Claims isolated paragraph images; inline and indented images retain normal layout. */
export function withImageEmbeds(
  embed: EmbedRenderer | undefined,
  box: { width: number; height: number },
): EmbedRenderer {
  return (node: AnyNode, context: EmbedClaimContext): EmbedSpec | undefined => {
    const claimed = embed?.(node, context);
    if (claimed !== undefined) {
      return claimed;
    }
    if (node.kind !== 'image' || context.soleChildOfTopLevelParagraph !== true) {
      return undefined;
    }
    // Declined, not refused downstream: a refused claim strands the image in the run as alt text.
    if (!isPositiveFinite(box.width) || !isPositiveFinite(box.height)) {
      return undefined;
    }
    const spec: EmbedSpec = {
      width: box.width,
      height: box.height,
      render: renderImageEmbed,
    };
    // No `text` for an empty alt, so the placeholder drops out of `plain` instead of copying as U+FFFC.
    if (node.alt.length > 0) {
      spec.text = node.alt;
    }
    return spec;
  };
}

/** Via `renderNode`, not a direct `ctx.renderers.image` call, so an override's hooks get their own instance. */
function renderImageEmbed(node: AnyNode, ctx: RenderContext): ReactNode {
  return node.kind === 'image' ? renderNode(node, ctx) : null;
}

/** Must match `isReservableEmbedSize`, so an accepted box is one both hosts reserve. */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
