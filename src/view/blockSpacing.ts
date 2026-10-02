import type { Block } from '../document/nodes';
import type { ProjectedBlock, ProjectedRun } from '../selection/mapSelection';
import type { RunDecoration } from './runDecorations';
import type { RunTextAttribute } from './runAttributes';
import type { BlockSpacing, BlockSpacingKind, MarkdownTheme } from './theme';

/**
 * Per-kind block margins (`theme.blocks`), on both render paths.
 *
 * INSIDE A RUN the space between two blocks is the blank line their '\n\n'
 * separator projects, so a margin is that line's height: one `lineHeight`
 * attribute over the empty paragraph. The separator stays in the text, so no
 * offset moves. Siblings joined by a single '\n' (list items, an item's own
 * blocks) have no blank line and get a 'spacing' decoration instead.
 *
 * Margins sit outside boxes: a code block, table or quote paints its padding
 * into the blank line, so the line is the margin plus that padding.
 */

/** iOS reads a maximum line height of 0 as "no maximum", and 0 is the wire's absent sentinel. */
const MIN_LINE = 0.01;

const NO_MARGINS: Required<BlockSpacing> = { before: 0, after: 0 };

/** True once the theme sets any block margin; until then the old spacing stands. */
export function spacingManaged(theme: MarkdownTheme): boolean {
  const { blocks } = theme;
  for (const key of Object.keys(blocks) as (keyof MarkdownTheme['blocks'])[]) {
    if (key !== 'firstBlockLead' && key !== 'lastBlockTrail' && blocks[key] !== undefined) return true;
  }
  return (
    theme.headings.levels?.some(
      (level) => level?.before !== undefined || level?.after !== undefined,
    ) ?? false
  );
}

function marginsFor(
  theme: MarkdownTheme,
  kind: BlockSpacingKind,
  level?: number,
): Required<BlockSpacing> {
  const own = theme.blocks[kind];
  let before = own?.before ?? 0;
  let after = own?.after ?? 0;
  if (kind === 'heading' && level !== undefined) {
    const pinned = theme.headings.levels?.[level - 1];
    before = pinned?.before ?? before;
    after = pinned?.after ?? after;
  }
  return own === undefined && kind !== 'heading' ? NO_MARGINS : { before, after };
}

function spacedKindOf(kind: Block['kind'] | ProjectedBlock['kind']): BlockSpacingKind | null {
  switch (kind) {
    case 'paragraph':
    case 'htmlBlock':
      return 'paragraph';
    case 'heading':
      return 'heading';
    case 'list':
      return 'list';
    case 'listItem':
      return 'listItem';
    case 'blockquote':
      return 'quote';
    case 'codeBlock':
      return 'code';
    case 'table':
      return 'table';
    case 'thematicBreak':
      return 'rule';
    default:
      return null;
  }
}

/** A block on either path: a document node or a projected run block. */
type SpacedBlock = { kind: Block['kind'] | ProjectedBlock['kind']; level?: number };

function blockMargins(theme: MarkdownTheme, block: SpacedBlock): Required<BlockSpacing> {
  const kind = spacedKindOf(block.kind);
  if (kind === null) return NO_MARGINS;
  return marginsFor(theme, kind, block.kind === 'heading' ? block.level : undefined);
}

/** Collapsed margin between two adjacent blocks, edge to edge. */
export function marginBetween(theme: MarkdownTheme, above: Block, below: Block): number {
  return Math.max(blockMargins(theme, above).after, blockMargins(theme, below).before);
}

/** The first block's lead, when `blocks.firstBlockLead` asks for it. */
export function leadMargin(theme: MarkdownTheme, first: Block | undefined): number {
  const lead = theme.blocks.firstBlockLead;
  if (!lead || first === undefined) return 0;
  if (lead !== true) {
    const kind = spacedKindOf(first.kind);
    if (kind === null || !lead.includes(kind)) return 0;
  }
  return blockMargins(theme, first).before;
}

/** The last block's trailing margin, when `blocks.lastBlockTrail` asks for it. */
export function trailMargin(theme: MarkdownTheme, last: Block | undefined): number {
  if (!theme.blocks.lastBlockTrail || last === undefined) return 0;
  return blockMargins(theme, last).after;
}

/** `list.itemGap`, else `blocks.listItem`; undefined when the theme sets neither. */
function configuredItemGap(theme: MarkdownTheme): number | undefined {
  if (theme.list.itemGap !== undefined) return theme.list.itemGap;
  const item = theme.blocks.listItem;
  return item === undefined ? undefined : Math.max(item.after ?? 0, item.before ?? 0);
}

/** The gap between list items; undefined keeps the default. */
export function itemGap(theme: MarkdownTheme): number | undefined {
  return configuredItemGap(theme) ?? (spacingManaged(theme) ? 0 : undefined);
}

/**
 * The gap between two blocks inside one list item, on both paths: a
 * configured item gap (`list.itemGap`, else `blocks.listItem`) wins, else the
 * blocks' own collapsed margins. Undefined keeps the default (no gap).
 */
export function innerItemGap(
  theme: MarkdownTheme, above: SpacedBlock, below: SpacedBlock,
): number | undefined {
  const configured = configuredItemGap(theme);
  if (configured !== undefined) return configured;
  if (!spacingManaged(theme)) return undefined;
  return Math.max(blockMargins(theme, above).after, blockMargins(theme, below).before);
}

export interface RunSpacing {
  attributes: RunTextAttribute[];
  decorations: RunDecoration[];
}

const NO_SPACING: RunSpacing = { attributes: [], decorations: [] };

/**
 * Separator line heights and paragraph spacing for one run. Needs a
 * projection made with `recordBlocks`.
 */
export function resolveRunSpacing(projected: ProjectedRun, theme: MarkdownTheme): RunSpacing {
  const blocks = projected.blocks;
  if (blocks === undefined || blocks.length < 2) return NO_SPACING;
  const managed = spacingManaged(theme);
  const gapBetweenItems = itemGap(theme);
  if (!managed && gapBetweenItems === undefined) return NO_SPACING;

  const { text } = projected;
  const children = childIndex(blocks);
  const attributes: RunTextAttribute[] = [];
  // Keyed by paragraph end, so nested items ending together get one entry.
  const after = new Map<number, number>();

  const padTop = (index: number): number => edgePadding(blocks, children, index, theme, 'top');
  const padBottom = (index: number): number => edgePadding(blocks, children, index, theme, 'bottom');
  const setLine = (at: number, height: number): void => {
    if (at < 0 || at >= text.length || text.charCodeAt(at) !== 10) return;
    attributes.push({ start: at, end: at + 1, lineHeight: Math.max(height, MIN_LINE) });
  };

  for (const [parent, siblings] of children) {
    const parentKind = parent < 0 ? null : blocks[parent].kind;
    const tight = parentKind === 'list' || parentKind === 'listItem';
    for (let i = 0; i < siblings.length; i += 1) {
      const index = siblings[i];
      const block = blocks[index];
      // A rule's own blank line holds only the rule.
      if (managed && !tight && block.kind === 'thematicBreak' && block.start === block.end) {
        setLine(block.start, theme.rule.thickness);
      }
      if (i + 1 >= siblings.length) continue;
      const next = blocks[siblings[i + 1]];
      if (tight) {
        const gap = parentKind === 'listItem' ? innerItemGap(theme, block, next) : gapBetweenItems;
        if (gap === undefined || gap <= 0) continue;
        if (block.end <= block.start) continue;
        const end = block.end;
        after.set(end, Math.max(after.get(end) ?? 0, gap));
        continue;
      }
      if (!managed) continue;
      const height =
        Math.max(blockMargins(theme, block).after, blockMargins(theme, next).before) +
        padBottom(index) +
        padTop(siblings[i + 1]);
      // After a non-empty block the blank line is the separator's second '\n';
      // after a rule, its own line comes first.
      setLine(block.end > block.start ? block.end + 1 : block.start + 1, height);
    }
  }

  const decorations: RunDecoration[] = [];
  for (const [end, gap] of after) {
    decorations.push({ start: end - 1, end, kind: 'spacing', paddingBottom: gap });
  }
  decorations.sort((a, b) => a.start - b.start);
  return { attributes, decorations };
}

function childIndex(blocks: readonly ProjectedBlock[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < blocks.length; i += 1) {
    const parent = blocks[i].parent;
    const list = out.get(parent);
    if (list === undefined) out.set(parent, [i]);
    else list.push(i);
  }
  return out;
}

function ownPadding(block: ProjectedBlock, theme: MarkdownTheme): number {
  switch (block.kind) {
    case 'codeBlock':
      return theme.code.paddingVertical;
    case 'table':
      return theme.table.cellPaddingV;
    case 'blockquote':
      return theme.quote.paddingVertical;
    default:
      return 0;
  }
}

/** Boxes sharing an edge overlap there, so the deepest chain's widest padding wins. */
function edgePadding(
  blocks: readonly ProjectedBlock[],
  children: ReadonlyMap<number, readonly number[]>,
  index: number,
  theme: MarkdownTheme,
  edge: 'top' | 'bottom',
): number {
  let padding = 0;
  let current: number | undefined = index;
  while (current !== undefined) {
    padding = Math.max(padding, ownPadding(blocks[current], theme));
    const kids = children.get(current);
    if (kids === undefined || kids.length === 0) break;
    current = edge === 'top' ? kids[0] : kids[kids.length - 1];
  }
  return padding;
}
