import type { ReactNode } from 'react';
import type { AnyNode } from '../document/nodes';
import type { EmbedClaimContext } from '../selection/runs';
import type { EmbedRenderer, EmbedSpec } from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { renderNode } from './renderers';

/**
 * How the view treats an image node. `SelectableMarkdown`'s `images` prop.
 *
 * - `'embed'` (the default): an image is claimed as an EMBED, so it flows
 *   inside its run — one U+FFFC placeholder, a reserved box, the built-in
 *   `image` renderer overlaid on it.
 * - `'standalone'`: no built-in claim, so `VIEW_KINDS` in
 *   `src/selection/runs.ts` applies and the image's whole containing block
 *   leaves the run — the behaviour every image had before this prop.
 */
export type ImageMode = 'embed' | 'standalone';

/**
 * WHY IMAGES ARE EMBEDDED BY DEFAULT.
 *
 * `image` was one of the two `VIEW_KINDS`, so a single inline image demoted
 * its whole containing block to `standalone` — a paragraph, but also the
 * whole list or table it sat in. That is the widest blast radius in the
 * library: a standalone block gets its own selection scope, so a gesture
 * cannot sweep from the prose above an illustrated list to the prose below
 * it, and every standalone block loses `selectionActions` /
 * `onSelectionCopy` entirely (the table in docs/SELECTION.md). The reason
 * for it was real — flowing an image does not degrade the picture, it
 * DELETES it and leaves the alt text — but the mechanism that fixes it
 * already ships: an embed claim reserves space at a placeholder and overlays
 * a React element on it, so the picture survives INSIDE the run.
 *
 * So the built-in claim is the same one a consumer would have written by
 * hand, wired to the theme's image box and to the `image` renderer already
 * in `ctx.renderers` (overrides included, which is what keeps this from
 * being a second, divergent image path). `VIEW_KINDS` keeps `image` as the
 * fallback for everything this claim declines: `images: 'standalone'`, a
 * theme whose image box is not a positive finite size, and — through
 * `embedContentFor` — synthetic or still-streaming image nodes, whose spans
 * are still moving.
 *
 * WHAT THE CLAIM CANNOT DO. The reservation is a fixed `width` × `height`
 * box at one character, so an image is drawn at the theme's box rather than
 * at the picture's own aspect ratio, and on iOS an image mid-paragraph is
 * clamped to the paragraph's line height (the paragraph style resolves from
 * the paragraph's first character — the documented inline-chip constraint on
 * `embed`). An image alone in its paragraph — which is how markdown almost
 * always writes one, and the only shape that used to cost a whole block its
 * selection scope — is the case this is for. `images: 'standalone'` is the
 * one-prop way back for the rest.
 */
export function withImageEmbeds(
  embed: EmbedRenderer | undefined,
  box: { width: number; height: number },
): EmbedRenderer {
  return (node: AnyNode, context: EmbedClaimContext): EmbedSpec | undefined => {
    // The consumer's claim is consulted FIRST and wins outright, so an app
    // that renders its own image cards — a lightbox trigger, a sized
    // remote-image component — is never fighting this one. Only what it
    // declines reaches the built-in claim.
    const claimed = embed?.(node, context);
    if (claimed !== undefined) {
      return claimed;
    }
    if (node.kind !== 'image') {
      return undefined;
    }
    // A non-positive or infinite box is left to `VIEW_KINDS`: returning it
    // would be refused by `embedContentFor` anyway (and by both hosts'
    // reservation guards), and the refusal there would strand the image
    // inside a flowing run with nothing but its alt text — the one outcome
    // this whole path exists to prevent. Declining instead keeps the
    // standalone renderer, which draws the picture.
    if (!isPositiveFinite(box.width) || !isPositiveFinite(box.height)) {
      return undefined;
    }
    const spec: EmbedSpec = {
      width: box.width,
      height: box.height,
      render: renderImageEmbed,
    };
    // `text` is what a copy-text payload shows in place of the placeholder,
    // and `alt` is exactly what the projection used to emit for an image
    // that flowed. An image with no alt declares none, so its placeholder is
    // removed from `plain` rather than copied as U+FFFC. `markdown` carries
    // the node's own source either way.
    if (node.alt.length > 0) {
      spec.text = node.alt;
    }
    return spec;
  };
}

/**
 * The overlay: the `image` renderer from the context, so a consumer's
 * `renderers.image` override draws the embedded image too and there is only
 * ever one image renderer in the library. A module-level function, not a
 * closure per claim, so the claim object's shape does not depend on when it
 * was built.
 *
 * The built-in renderer draws at `height: spacing.imageHeight` and
 * `width: '100%'`, and `EmbedOverlay` positions it in a box of exactly the
 * reserved size — which is that same height by construction (see the
 * `imageHeight` token), so the picture fills the space the host reserved.
 *
 * IT GOES THROUGH `renderNode`, not through `ctx.renderers.image(node, ctx)`.
 * A renderer is placed as an ELEMENT everywhere else in the library, which is
 * what gives it its own component instance and lets it use hooks; calling it
 * here would have run a consumer's `image` override inside `EmbedOverlay`'s
 * body instead, so its hooks would have joined the overlay's list — the one
 * exception to a rule the `renderers` docstring states without one. Routing
 * through `renderNode` also puts the override under the same depth cap and
 * unknown-kind fallback as every other renderer.
 */
function renderImageEmbed(node: AnyNode, ctx: RenderContext): ReactNode {
  // Narrowed rather than cast: `withImageEmbeds` only ever attaches this to
  // an image node, and a node of any other kind draws nothing rather than
  // reaching the image renderer with the wrong shape.
  return node.kind === 'image' ? renderNode(node, ctx) : null;
}

/** `Number.isFinite` plus `> 0` — the same test `isReservableEmbedSize`
 * applies to a claim, so a box this accepts is one both hosts will reserve
 * (and a NaN, a zero and an `Infinity` are all refused here first). */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
