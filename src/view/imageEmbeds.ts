import type { ReactNode } from 'react';
import type { AnyNode, Block, ImageNode, Inline } from '../document/nodes';
import type { EmbedClaimContext } from '../selection/runs';
import type { EmbedRenderer, EmbedSpec } from './SelectableMarkdown';
import type { RenderContext } from './renderers';
import { renderNode } from './renderers';

/**
 * `SelectableMarkdown`'s `images` prop. `'embed'` (default) flows a sole image
 * of a top-level paragraph inside its run; `'standalone'` moves its block out;
 * `'none'` drops every image, and a paragraph left empty with it.
 */
export type ImageMode = 'embed' | 'standalone' | 'none';

/** The object form of `images`, for sizing embedded images. */
export interface ImageOptions {
  /** Default 'embed'. */
  mode?: ImageMode;
  /**
   * Points, or 'container' for the measured content width. Default `spacing.imageWidth`.
   * Container sizing supports numeric padding; percentage padding falls back to the theme's padding.
   */
  width?: number | 'container';
  /**
   * Points, or 'intrinsic' for the image's own aspect ratio (fetched once per
   * URL; `spacing.imageHeight` stands in until it arrives). Default
   * `spacing.imageHeight`.
   */
  height?: number | 'intrinsic';
  /** Caps an 'intrinsic' height. */
  maxHeight?: number;
}

export type ImageBox = { width: number; height: number };

/** An `EmbedSpec` with a numeric size: what `segmentRuns` and `projectRun` take. */
export type SizedEmbedSpec = Omit<EmbedSpec, 'width' | 'height' | 'estimatedHeight'> & {
  width: number;
  height: number;
};

/**
 * Claims isolated paragraph images; inline and indented images retain normal
 * layout. A wrapped claim with `height: 'auto'` reserves its estimate here —
 * measuring is `<SelectableMarkdown>`'s job. So is the container width: a
 * wrapped `width: 'container'` claim is declined.
 */
export function withImageEmbeds(
  embed: EmbedRenderer | undefined,
  box: ImageBox | ((image: ImageNode) => ImageBox),
): (node: AnyNode, context: EmbedClaimContext) => SizedEmbedSpec | undefined {
  return (node: AnyNode, context: EmbedClaimContext): SizedEmbedSpec | undefined => {
    const claimed = embed?.(node, context);
    if (claimed !== undefined) {
      const { estimatedHeight, width, height, ...rest } = claimed;
      if (width === 'container') return undefined;
      return { ...rest, width, height: height === 'auto' ? (estimatedHeight ?? 44) : height };
    }
    if (node.kind !== 'image' || context.soleChildOfTopLevelParagraph !== true) {
      return undefined;
    }
    const size = typeof box === 'function' ? box(node) : box;
    // Declined, not refused downstream: a refused claim strands the image in the run as alt text.
    if (!isPositiveFinite(size.width) || !isPositiveFinite(size.height)) {
      return undefined;
    }
    const spec: SizedEmbedSpec = {
      width: size.width,
      height: size.height,
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

const stripped = new WeakMap<Block, Block | null>();

/**
 * `images: 'none'` removes images and drops paragraphs or headings left empty.
 * Cached per block, so a settled block keeps its
 * identity and its run's memo across snapshots. Spans are untouched, so a
 * copy across a dropped image still carries its markdown.
 */
export function withoutImages(blocks: Block[]): Block[] {
  let changed = false;
  const out: Block[] = [];
  for (const block of blocks) {
    const next = strippedBlock(block);
    if (next !== block) changed = true;
    if (next !== null) out.push(next);
  }
  return changed ? out : blocks;
}

function strippedBlock(block: Block): Block | null {
  const cached = stripped.get(block);
  if (cached !== undefined) return cached;
  const next = stripBlock(block);
  stripped.set(block, next);
  return next;
}

function stripBlock(block: Block): Block | null {
  switch (block.kind) {
    case 'paragraph':
    case 'heading': {
      const children = stripInlines(block.children);
      if (children === block.children) return block;
      return children.some((child) => child.kind !== 'softBreak' && child.kind !== 'hardBreak')
        ? { ...block, children }
        : null;
    }
    case 'blockquote':
    case 'listItem': {
      const children = withoutImages(block.children);
      return children === block.children ? block : { ...block, children };
    }
    case 'list': {
      let changed = false;
      const items = block.items.map((item) => {
        const next = strippedBlock(item);
        if (next !== item) changed = true;
        return (next ?? { ...item, children: [] }) as typeof item;
      });
      return changed ? { ...block, items } : block;
    }
    case 'table': {
      const header = stripRow(block.header);
      let changed = header !== block.header;
      const rows = block.rows.map((row) => {
        const next = stripRow(row);
        if (next !== row) changed = true;
        return next;
      });
      return changed ? { ...block, header, rows } : block;
    }
    default:
      return block;
  }
}

function stripRow<T extends Extract<Block, { kind: 'tableRow' }>>(row: T): T {
  let changed = false;
  const cells = row.cells.map((cell) => {
    const children = stripInlines(cell.children);
    if (children === cell.children) return cell;
    changed = true;
    return { ...cell, children };
  });
  return changed ? { ...row, cells } : row;
}

function stripInlines(children: Inline[]): Inline[] {
  let changed = false;
  const out: Inline[] = [];
  for (const child of children) {
    if (child.kind === 'image') {
      changed = true;
      continue;
    }
    if ('children' in child && Array.isArray(child.children)) {
      const inner = stripInlines(child.children as Inline[]);
      if (inner !== child.children) {
        changed = true;
        out.push({ ...child, children: inner } as Inline);
        continue;
      }
    }
    out.push(child);
  }
  return changed ? out : children;
}
