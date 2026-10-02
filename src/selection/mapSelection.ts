import { IS_DEV } from '../dev';
import type { AnyNode, Block, Inline, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { ThemeFontWeight } from '../view/theme';
import { decodeEntityAt } from '../engine/entities';
import type { EmbedContent, EmbedLookup, RunSegment } from './runs';
import { constrainsEmbedWidth, embedContentFor } from './runs';

export interface ProjectedRun {
  text: string;
  pieces: RunPiece[];
  marks: RunMark[];
  /**
   * The run's embedded nodes, in placeholder order (which is also `embedId`
   * order — the id is the index into this array). Present only when the run
   * was projected with an `embed` lookup that claimed something, so every
   * projection without embeds keeps its exact previous shape.
   */
  embeds?: ProjectedRunEmbed[];
  /**
   * Every construct whose source holds syntax its projection does not show,
   * outermost first; see `ProjectedExtent`. Absent when the run has none.
   */
  extents?: ProjectedExtent[];
  /** Present only when projected with `recordBlocks`; see `ProjectedBlock`. */
  blocks?: ProjectedBlock[];
  /** Each `transformInline` prefix's range and style. Absent when the run has none. */
  prefixes?: ProjectedPrefix[];
}

/** Where a `transformInline` prefix landed in `ProjectedRun.text`. */
export interface ProjectedPrefix {
  start: number;
  end: number;
  style?: InlinePrefixStyle;
}

/**
 * One block as projected, in document (pre-)order: where it sits in the text
 * and which block contains it. Table rows and cells are not recorded. The
 * view's block spacing reads the separators between siblings off this list.
 */
export interface ProjectedBlock {
  kind:
    | 'paragraph'
    | 'heading'
    | 'list'
    | 'listItem'
    | 'blockquote'
    | 'codeBlock'
    | 'table'
    | 'thematicBreak'
    | 'htmlBlock';
  /** Heading level; absent otherwise. */
  level?: number;
  /** UTF-16 offsets into `ProjectedRun.text`; a thematic break has `start === end`. */
  start: number;
  end: number;
  /** Index of the containing block in `blocks`, or -1 at the top level. */
  parent: number;
}

/**
 * A construct's projected range paired with its source span, recorded only
 * when the source holds syntax no piece covers: a heading's `# `, a list
 * marker, a link's `](url)`. `mapSelectionToSource` unions it in when a
 * selection covers the whole projected range, so a whole construct copies
 * with its syntax. Incomplete constructs are not recorded.
 */
export interface ProjectedExtent {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
  /** The construct's own source span, syntax included. */
  source: SourceSpan;
}

/**
 * One embedded node as the projection recorded it: where its placeholder
 * sits, which node it stands for, and the content the lookup declared —
 * captured at projection time, so the lookup is consulted exactly once per
 * node and everything downstream (attributes, the wire prop, copy-text
 * substitution) reads the same values.
 */
export interface ProjectedRunEmbed {
  /** The index of this entry — carried explicitly so a consumer holding one
   * entry can still say which `embedId` it is. */
  embedId: number;
  /**
   * UTF-16 offsets of the placeholder into `ProjectedRun.text`.
   * `end === start + 1` always and entries ascend by `start`; consumers sweep
   * the list in one pass relying on both offsets increasing.
   */
  start: number;
  end: number;
  node: AnyNode;
  content: EmbedContent;
}

export interface RunPiece {
  textStart: number;
  textEnd: number;
  /** null = synthetic glyph (bullet, separator, task glyph). */
  source: SourceSpan | null;
}

/**
 * A construct that covers a range of the projected text.
 *
 * SEMANTIC, NOT STYLED — deliberately. The projection is the one thing the
 * native host must reproduce character-for-character, so it lives here next
 * to the piece table that depends on it; a theme does not. `src/view` turns
 * these kinds into fonts and colours, and the same list drives the native
 * host's attributed text and could drive anything else that needs to know
 * where the bold bits are.
 *
 * Marks nest, and `marks` is ordered outermost-first at each offset, so a
 * consumer that applies them in order gets the inner construct winning —
 * which is what a code span inside a heading, or a link inside emphasis,
 * has to do.
 */
export interface RunMark {
  kind: MarkKind;
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
  /** Heading level 1-6 when `kind` is 'heading'; list nesting depth
   * (1 = top level) when `kind` is 'listItem'. Absent otherwise. */
  level?: number;
  /**
   * The link destination. Present when `kind` is 'link' or 'blockedLink' — the
   * two together are every link the author wrote that is still on screen as a
   * link-shaped thing, which is what `resolveRunPressables` turns into the
   * native host's pressable list. The `kind` is what says whether the range is
   * navigable: 'link' passed the URL policy, 'blockedLink' did not.
   *
   * A still-streaming link (`incomplete`) carries no mark and no href, because
   * its destination does not exist yet — half a URL is not a target, and a
   * range that looks tappable for one frame and then moves is worse than one
   * that appears when it is real.
   *
   * Semantic, like the rest of this type: which URL the range refers to, not
   * how it looks or whether tapping it does anything.
   */
  href?: string;
  /** The embed's identifier when `kind` is 'embed' — its index into
   * `ProjectedRun.embeds`. Absent otherwise, same absent-not-undefined rule
   * as `level` and `href`. */
  embedId?: number;
}

export type MarkKind =
  | 'emphasis'
  | 'strong'
  | 'strikethrough'
  | 'underline'
  | 'code'
  | 'codeBlock'
  | 'link'
  /**
   * A link the URL policy rejected under `urlPolicy.blockedLinks: 'node'`.
   *
   * SEPARATE FROM `link` BECAUSE IT IS NOT NAVIGABLE, AND PRESENT AT ALL
   * BECAUSE ERASING IT WAS WORSE. A blocked link used to carry no mark, so
   * inside a native run it projected as bare unstyled text and got no
   * pressable — the construct vanished. That defeats the entire purpose of
   * `blockedLinks: 'node'`, which exists so the consumer sees every link the
   * author wrote and decides what it means; the promise held on the renderer
   * path and was silently broken on the run path. A consumer whose blocked
   * schemes are *identifiers* — citation markers, product references, an app's
   * own deep links — was therefore forced to classify every block containing
   * one as `standalone` just to keep it visible, which is to say forced to give
   * up selection across most of a document.
   *
   * It carries its `href` like `link` does, so the consumer can route a press
   * through `onLinkPress`. It is deliberately NOT fed to `openUrl` by default:
   * "blocked" means the policy refused it as a destination, and that refusal
   * still stands.
   */
  | 'blockedLink'
  | 'spoiler'
  | 'heading'
  | 'blockquote'
  /**
   * The whole table: header and every row. Exists so the view layer can put
   * the table's chrome back — the border box, the row separators, the aligned
   * columns — around text that now flows through the native selection host
   * (`runDecorations.ts` is the consumer). `tableHeader` alone was not enough:
   * it covers only the first row, and a border needs to know where the table
   * *ends*.
   */
  | 'table'
  | 'tableHeader'
  /**
   * Every body row of a table: the text after the header row and its
   * separator. Carries `theme.table.body` so the body typography stays off
   * the header row, which the enclosing 'table' mark also covers.
   */
  | 'tableBody'
  /**
   * A thematic break. THE ONE ZERO-LENGTH MARK KIND: a rule contributes no
   * selectable text (see the `thematicBreak` case below), so `start === end`,
   * and the mark exists purely to say *where* the rule sits so the view layer
   * can draw one there. Every consumer that styles text ranges skips it
   * naturally — there are no characters to style — but a consumer iterating
   * marks for other reasons must not assume `end > start`.
   */
  | 'thematicBreak'
  /**
   * One list item: its marker glyph plus everything the item contains,
   * nested sublists included, with `level` carrying the nesting depth
   * (1 = a top-level list's items). Exists for the view layer's indentation:
   * the projector emits NO indent glyphs — injected spaces would end up in
   * copied text and could never give wrapped lines a hanging indent — so
   * `runDecorations.ts` turns these marks into paragraph-indent decorations
   * instead. Deeper items' marks nest inside their ancestors', exactly like
   * every other nesting mark.
   */
  | 'listItem'
  /**
   * A list item's marker glyph alone — the '\u2022 ', '<n>. ', or task-box
   * glyph the projector synthesizes at the head of each item, nested just
   * inside that item's 'listItem' mark. Exists so a consumer can style the
   * marker apart from the item's text (a muted bullet, a smaller number)
   * via `attributeForMark`; it contributes no styling of its own. The glyph
   * is synthetic (its piece maps to null source), so styling it never
   * affects copied text.
   */
  | 'listMarker'
  | 'math'
  | 'html'
  /**
   * An embedded node (`EmbedLookup` claimed it): exactly ONE character of
   * projected text — the U+FFFC placeholder — whose piece maps to the node's
   * whole source span as an indivisible unit. THE ONE MARK WHOSE TEXT IS A
   * PLACEHOLDER, NOT PROSE: the character exists so the run has something to
   * select and the host has somewhere to reserve the embed's space; the view
   * overlays the consumer's element on top, and copy-text substitutes the
   * declared `EmbedContent.text` for it. Carries `embedId`.
   */
  | 'embed';

/** The placeholder an embedded node projects: U+FFFC OBJECT REPLACEMENT
 * CHARACTER — the character both platforms' text systems already use to
 * stand for an inline attachment. Exported for consumers that post-process
 * projected text themselves. `ProjectedRun.text` and the native host's own
 * Copy carry it; a copy payload's `plain` replaces each one with its
 * `EmbedContent.text`, or removes it.
 */
export const EMBED_PLACEHOLDER = '￼';

// Deterministic display glyphs and separators. These are part of the
// projection contract: the native host renders exactly this text, and
// mapSelectionToSource assumes the piece list produced here.
//   - '\n\n' between sibling blocks (also inside blockquotes and list items)
//   - '\n'   between list items and between table rows
//   - '\t'   between table cells
//   - '• ' (bullet) before unordered list items
//   - '<n>. '  before ordered list items (n = list.start ?? 1, incrementing)
//   - '☑ ' / '☐ ' instead of the item's whole marker (bullet or ordinal) for
//            task list items
//   - '\n'   for a hard break, ' ' for a soft break — the two are not the same
//            glyph, and the reason is on the `softBreak` case below
//            (`ProjectRunOptions.softBreak: 'newline'` projects '\n' instead)
// The separators are STRUCTURAL AND FIXED — they are what block boundaries,
// item boundaries and table cells look like to every consumer of the
// projected text. The three marker glyphs are only the DEFAULTS: a caller
// may substitute its own via `ProjectRunOptions.glyphs`, and every mark and
// piece offset downstream is computed from whatever was actually emitted.
const BLOCK_SEPARATOR = '\n\n';
const ITEM_SEPARATOR = '\n';
const ROW_SEPARATOR = '\n';
const CELL_SEPARATOR = '\t';

/**
 * The marker strings the projector synthesizes at the head of list items.
 * Configurable — unlike the structural separators — because they are display
 * chrome, not structure: they map to null source, so substituting them moves
 * offsets but never changes what a selection maps back to.
 */
export interface ProjectionGlyphs {
  bullet: string;
  taskChecked: string;
  taskUnchecked: string;
}

const DEFAULT_GLYPHS: ProjectionGlyphs = {
  bullet: '• ',
  taskChecked: '☑ ',
  taskUnchecked: '☐ ',
};



let warnedNewlineGlyph = false;

/**
 * A glyph override, unless it contains '\n' — decorations and the native
 * hosts treat newlines as line boundaries (band geometry, table row rules),
 * so a newline inside a marker would silently corrupt both. Rejected here,
 * at the one place glyphs enter the projection, with the same warn-once
 * pattern `renderNode` uses for unknown kinds; the default glyph stands in
 * so the projection stays total.
 */
function safeGlyph(override: string | undefined, fallback: string): string {
  if (override === undefined) {
    return fallback;
  }
  if (override.includes('\n')) {
    if (IS_DEV && !warnedNewlineGlyph) {
      warnedNewlineGlyph = true;
      console.warn(
        '[react-native-selectable-markdown] Marker glyphs must not contain "\\n" ' +
          '(decorations treat newlines as line boundaries); using the default glyph instead.',
      );
    }
    return fallback;
  }
  return override;
}

export interface ProjectRunOptions {
  /**
   * Marker glyph overrides; any glyph left unset keeps its default.
   *
   * CHANGING A GLYPH CHANGES THE PROJECTED TEXT, and with it every offset
   * derived from it — marks, pieces, attributes, decorations, pressables.
   * Anything that caches a `ProjectedRun` must therefore key on the glyph
   * values it was projected with: a cached projection built with different
   * glyphs corrupts every downstream offset.
   */
  glyphs?: Partial<ProjectionGlyphs>;
  /**
   * The embed lookup the run was segmented with. IT JOINS THE PROJECTION KEY
   * EXACTLY AS GLYPHS DO: a claim replaces a node's whole projection with one
   * placeholder character, so projecting the same run with a different lookup
   * (or none) moves every offset after the first claimed node. Anything that
   * caches a `ProjectedRun` must key on this callback's identity, and every
   * reprojection of the same run — including the fallback projection inside
   * `handleSelectionAction` — must be handed the same lookup.
   */
  embed?: EmbedLookup;
  /**
   * A projection of an earlier, shorter version of this run, to extend
   * instead of redoing; ignored unless `reusablePrefix` accepts it. It carries
   * no key of its own, so it must have been projected with the same `glyphs`
   * and `embed`. `createRunProjectionCache` (src/view/projectionCache.ts) keys
   * on all three.
   */
  previous?: PreviousProjection;
  /**
   * What a soft break projects as: ' ' (default, CommonMark) or '\n', the
   * same glyph a hard break gets. Offset-neutral either way, but it changes
   * the text, so it keys a cached projection like `glyphs` does.
   */
  softBreak?: 'space' | 'newline';
  /** Record `ProjectedRun.blocks`. Keys a cached projection like `glyphs`. */
  recordBlocks?: boolean;
  /**
   * Rewrites or hides inline nodes as they project. Keys a cached projection
   * like `embed`: keep it pure and referentially stable.
   */
  transformInline?: InlineTransform;
}

/**
 * What an inline node shows instead of its own projection.
 *
 * - `text`: the node displays this string. A container (a link, emphasis)
 *   keeps its mark — a renumbered citation stays pressable — and the string
 *   maps to the node's whole source span as one indivisible piece, so a
 *   selection across it still copies the original markdown.
 * - `prefix`: display-only text before the node — a status dot, an icon
 *   font glyph — in its own style. It maps to no source, so copy-as-markdown
 *   leaves it out; plain-text copy keeps it. It sits outside the node's
 *   marks: not part of a link's press target or chip.
 * - `hide`: the node displays nothing, and a single space just before it
 *   goes too, so "fact [3]." reads "fact.". The space stays when a letter or
 *   digit follows directly: "lead [1]mg" reads "lead mg". Its source still
 *   copies with any selection spanning it.
 */
export interface InlineTransformResult {
  text?: string;
  hide?: boolean;
  prefix?: InlinePrefix;
}

export interface InlinePrefix {
  /** Must not contain a line break. */
  text: string;
  style?: InlinePrefixStyle;
}

export interface InlinePrefixStyle {
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: ThemeFontWeight;
}

export type InlineTransform = (node: Inline) => InlineTransformResult | undefined;

/**
 * A projection to grow. `blocks` must be a prefix of the run's blocks by
 * identity: a parsed block's subtree is immutable, so the same blocks
 * reproject to the same text and the run's growth is pure append.
 */
export interface PreviousProjection {
  blocks: readonly Block[];
  projected: ProjectedRun;
}

/** The length check rejects a document whose source has since been truncated. */
function reusablePrefix(
  run: RunSegment,
  doc: ParsedDocument,
  previous: PreviousProjection | undefined,
): PreviousProjection | null {
  if (previous === undefined) {
    return null;
  }
  const prefix = previous.blocks;
  if (prefix.length === 0 || prefix.length > run.blocks.length) {
    return null;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== run.blocks[i]) {
      return null;
    }
  }
  return prefix[prefix.length - 1].span.end <= doc.source.length
    ? previous
    : null;
}

/**
 * Deterministic projection of a run to display text plus a piece table
 * mapping every display range back to source (or to null for synthetic
 * glyphs). Pieces tile the text exactly: piece i ends where piece i+1
 * starts, the first starts at 0 and the last ends at text.length.
 *
 * Real pieces whose display length equals their source length map
 * code-unit-for-code-unit; pieces whose display form differs from the source
 * keep their whole source range and are mapped as an indivisible unit. A
 * respelling inside a node (an escape, an entity, a smart quote) is pinned
 * alone rather than the whole node; see `literal`.
 *
 * With `options.previous` only the blocks appended since are projected, and
 * the result equals a projection from scratch
 * (conformance/selection/incremental-projection.test.ts).
 */
export function projectRun(
  run: RunSegment,
  doc: ParsedDocument,
  options?: ProjectRunOptions,
): ProjectedRun {
  const overrides = options?.glyphs;
  const glyphs: ProjectionGlyphs = overrides
    ? {
        bullet: safeGlyph(overrides.bullet, DEFAULT_GLYPHS.bullet),
        taskChecked: safeGlyph(overrides.taskChecked, DEFAULT_GLYPHS.taskChecked),
        taskUnchecked: safeGlyph(
          overrides.taskUnchecked,
          DEFAULT_GLYPHS.taskUnchecked,
        ),
      }
    : DEFAULT_GLYPHS;
  const reuse = reusablePrefix(run, doc, options?.previous);
  if (reuse !== null && reuse.blocks.length === run.blocks.length) {
    // The same object, not a copy: downstream memos key on projection identity.
    return reuse.projected;
  }
  const projector = new RunProjector(
    doc.source,
    glyphs,
    options?.embed,
    reuse?.projected,
    options?.softBreak === 'newline' ? '\n' : ' ',
    options?.recordBlocks === true,
    options?.transformInline,
  );
  projector.project(
    reuse === null ? run.blocks : run.blocks.slice(reuse.blocks.length),
    reuse !== null,
  );
  return projector.finish();
}

/**
 * One step of the projection walk, run off an explicit stack because nesting
 * depth is untrusted input: the recursive form overflowed at ~1250 levels of
 * `> ` inside a render-time `useMemo`.
 */
type ProjectionTask =
  | { op: 'block'; node: Block; topLevel: boolean; listDepth: number }
  | { op: 'inline'; node: Inline; next?: Inline }
  | { op: 'emit'; chunk: string; source: SourceSpan | null }
  | { op: 'prefix'; prefix: InlinePrefix }
  | { op: 'literal'; node: AnyNode; display: string }
  | { op: 'openMark'; kind: MarkKind; level?: number; href?: string }
  | { op: 'closeMark' }
  | { op: 'openExtent'; source: SourceSpan }
  | { op: 'closeExtent' }
  | { op: 'openBlock'; kind: ProjectedBlock['kind']; level?: number; start?: number }
  | { op: 'closeBlock' };

interface OpenMark {
  kind: MarkKind;
  start: number;
  level?: number;
  href?: string;
}

interface OpenExtent {
  start: number;
  source: SourceSpan;
}

const NO_TASKS: ProjectionTask[] = [];

function marked(
  kind: MarkKind,
  body: ProjectionTask[],
  level?: number,
  href?: string,
): ProjectionTask[] {
  return [{ op: 'openMark', kind, level, href }, ...body, { op: 'closeMark' }];
}

function separated<T>(
  items: readonly T[],
  separator: string,
  tasksFor: (item: T, index: number) => ProjectionTask[],
): ProjectionTask[] {
  const tasks: ProjectionTask[] = [];
  items.forEach((item, index) => {
    if (index > 0) {
      tasks.push({ op: 'emit', chunk: separator, source: null });
    }
    const produced = tasksFor(item, index);
    for (let i = 0; i < produced.length; i += 1) {
      tasks.push(produced[i]);
    }
  });
  return tasks;
}

function blockSeq(
  children: Block[],
  separator: string,
  listDepth: number,
): ProjectionTask[] {
  return separated(children, separator, (child) => [
    { op: 'block', node: child, topLevel: false, listDepth },
  ]);
}

/** The kinds `ProjectedRun.blocks` records; rows and cells ride their table. */
function loggedKind(node: Block): ProjectedBlock['kind'] | null {
  switch (node.kind) {
    case 'tableRow':
    case 'tableCell':
    case 'listItem':
      return null;
    default:
      return node.kind;
  }
}

function inlineSeq(children: Inline[]): ProjectionTask[] {
  return children.map((node, i): ProjectionTask => ({ op: 'inline', node, next: children[i + 1] }));
}

const WORD_START = /^[\p{L}\p{N}]/u;

/**
 * Whether `node` shows a letter or digit first. A hidden node keeps the
 * space before it when one follows directly: hiding the `[1]` in
 * 'lead [1]mg' reads 'lead mg', not 'leadmg'.
 */
export function startsWithWord(node: Inline | undefined): boolean {
  for (let at = node; at !== undefined; ) {
    switch (at.kind) {
      case 'text':
      case 'codeSpan':
      case 'math':
        return WORD_START.test(at.value);
      case 'autolink':
        return WORD_START.test(at.text ?? at.href);
      case 'image':
        return WORD_START.test(at.alt);
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'underline':
      case 'spoiler':
      case 'link':
        at = at.children[0];
        break;
      default:
        return false;
    }
  }
  return false;
}

class RunProjector {
  private text: string;
  private readonly pieces: RunPiece[];
  private readonly marks: RunMark[];
  private readonly embeds: ProjectedRunEmbed[];
  private readonly prefixes: ProjectedPrefix[];
  /** The piece the last embed pushed, so `emit`'s linear merge can refuse to
   * grow it: an embed's piece is atomic BY CONTRACT, not by the length
   * inequality that usually keeps a piece indivisible — a claimed node whose
   * source span is exactly one code unit would otherwise read as linear and
   * merge into adjacent prose. */
  private embedPiece: RunPiece | null = null;
  private readonly stack: ProjectionTask[] = [];
  private readonly openMarks: OpenMark[] = [];
  private readonly extents: ProjectedExtent[];
  private readonly openExtents: OpenExtent[] = [];
  private readonly blockLog: ProjectedBlock[] | null;
  /** Indices into `blockLog` of the blocks still open, innermost last. */
  private readonly openBlocks: number[] = [];

  /**
   * `seed` resumes a projection at a top-level block boundary, where
   * `openMarks`, `openExtents` and `stack` are always empty. Its holder may
   * keep using it, so its arrays are sliced and its last piece cloned: `emit`
   * grows the last piece in place.
   */
  constructor(
    private readonly source: string,
    private readonly glyphs: ProjectionGlyphs,
    private readonly embedLookup?: EmbedLookup,
    seed?: ProjectedRun,
    private readonly softBreakGlyph = ' ',
    recordBlocks = false,
    private readonly transform?: InlineTransform,
  ) {
    if (seed === undefined) {
      this.text = '';
      this.pieces = [];
      this.marks = [];
      this.embeds = [];
      this.prefixes = [];
      this.extents = [];
      this.blockLog = recordBlocks ? [] : null;
      return;
    }
    this.text = seed.text;
    this.pieces = seed.pieces.slice();
    this.marks = seed.marks.slice();
    this.embeds = seed.embeds === undefined ? [] : seed.embeds.slice();
    this.prefixes = seed.prefixes === undefined ? [] : seed.prefixes.slice();
    this.extents = seed.extents === undefined ? [] : seed.extents.slice();
    this.blockLog = recordBlocks ? (seed.blocks ?? []).slice() : null;
    const last = this.pieces[this.pieces.length - 1];
    if (last !== undefined) {
      const clone: RunPiece = { ...last };
      this.pieces[this.pieces.length - 1] = clone;
      // The seed ended on an embed: keep its piece unmergeable across the seam.
      const lastEmbed = this.embeds[this.embeds.length - 1];
      if (
        lastEmbed !== undefined &&
        lastEmbed.start === clone.textStart &&
        lastEmbed.end === clone.textEnd
      ) {
        this.embedPiece = clone;
      }
    }
  }

  project(blocks: Block[], continuing = false): void {
    const tasks = separated(blocks, BLOCK_SEPARATOR, (block) => [
      { op: 'block', node: block, topLevel: true, listDepth: 0 },
    ]);
    if (continuing && blocks.length > 0) {
      tasks.unshift({ op: 'emit', chunk: BLOCK_SEPARATOR, source: null });
    }
    this.drain(tasks);
  }

  finish(): ProjectedRun {
    // Outermost-first at each offset: marks are pushed as their construct
    // *closes*, so the raw order is innermost-first and a consumer applying
    // them in sequence would let the outer construct overwrite the inner one.
    // Seeded marks all start before new ones, so the stable sort orders a
    // seeded run exactly as a from-scratch one.
    const marks = this.marks
      .slice()
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const projected: ProjectedRun = { text: this.text, pieces: this.pieces, marks };
    // Optional and absent when empty, so a projection without embeds keeps
    // its exact previous shape (marks and pieces are deep-compared in tests
    // and serialized in debugging output).
    if (this.embeds.length > 0) {
      projected.embeds = this.embeds;
    }
    // Pushed as each construct closes, so sorted outermost-first like marks.
    if (this.extents.length > 0) {
      projected.extents = this.extents
        .slice()
        .sort((a, b) => a.start - b.start || b.end - a.end);
    }
    if (this.blockLog !== null) {
      projected.blocks = this.blockLog;
    }
    if (this.prefixes.length > 0) {
      projected.prefixes = this.prefixes;
    }
    return projected;
  }

  private drain(tasks: ProjectionTask[]): void {
    this.push(tasks);
    for (;;) {
      const task = this.stack.pop();
      if (task === undefined) {
        return;
      }
      this.step(task);
    }
  }

  private push(tasks: ProjectionTask[]): void {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      this.stack.push(tasks[i]);
    }
  }

  private step(task: ProjectionTask): void {
    switch (task.op) {
      case 'block': {
        // Taken first: an embed claim emits its placeholder inside `blockTasks`.
        const start = this.text.length;
        const tasks = this.blockTasks(task.node, task.topLevel, task.listDepth);
        const kind = this.blockLog === null ? null : loggedKind(task.node);
        if (kind === null) {
          this.push(tasks);
          return;
        }
        const level = task.node.kind === 'heading' ? task.node.level : undefined;
        this.push([{ op: 'openBlock', kind, level, start }, ...tasks, { op: 'closeBlock' }]);
        return;
      }
      case 'inline':
        this.push(this.inlineTasks(task.node, task.next));
        return;
      case 'emit':
        this.emit(task.chunk, task.source);
        return;
      case 'prefix': {
        const start = this.text.length;
        this.emit(task.prefix.text, null);
        const prefix: ProjectedPrefix = { start, end: this.text.length };
        if (task.prefix.style !== undefined) prefix.style = task.prefix.style;
        this.prefixes.push(prefix);
        return;
      }
      case 'literal':
        this.literal(task.node, task.display);
        return;
      case 'openMark':
        this.openMarks.push({
          kind: task.kind,
          start: this.text.length,
          level: task.level,
          href: task.href,
        });
        return;
      case 'closeMark':
        this.closeMark();
        return;
      case 'openExtent':
        this.openExtents.push({ start: this.text.length, source: task.source });
        return;
      case 'closeExtent':
        this.closeExtent();
        return;
      case 'openBlock': {
        if (this.blockLog === null) return;
        const parent = this.openBlocks.length > 0 ? this.openBlocks[this.openBlocks.length - 1] : -1;
        const entry: ProjectedBlock = {
          kind: task.kind,
          start: task.start ?? this.text.length,
          end: this.text.length,
          parent,
        };
        if (task.level !== undefined) entry.level = task.level;
        this.openBlocks.push(this.blockLog.length);
        this.blockLog.push(entry);
        return;
      }
      case 'closeBlock': {
        const index = this.openBlocks.pop();
        if (index !== undefined && this.blockLog !== null) {
          this.blockLog[index].end = this.text.length;
        }
        return;
      }
    }
  }

  /**
   * Drops empty ranges, and leaves `level` and `href` off rather than
   * `undefined` so marks deep-compare equal.
   */
  private closeMark(): void {
    const open = this.openMarks.pop();
    if (open === undefined) {
      return;
    }
    const end = this.text.length;
    if (end <= open.start) {
      return;
    }
    const mark: RunMark = { kind: open.kind, start: open.start, end };
    if (open.level !== undefined) mark.level = open.level;
    if (open.href !== undefined) mark.href = open.href;
    this.marks.push(mark);
  }

  private closeExtent(): void {
    const open = this.openExtents.pop();
    if (open === undefined) {
      return;
    }
    this.pushExtent(open.start, open.source);
  }

  /** Skips empty ranges and exact repeats, which a one-item list and its item produce. */
  private pushExtent(start: number, source: SourceSpan): void {
    const end = this.text.length;
    if (end <= start) {
      return;
    }
    const last = this.extents[this.extents.length - 1];
    if (
      last !== undefined &&
      last.start === start &&
      last.end === end &&
      last.source.start === source.start &&
      last.source.end === source.end
    ) {
      return;
    }
    this.extents.push({ start, end, source });
  }

  /**
   * The span an extent for `node` should carry, or null for a synthetic or
   * incomplete node, or a reference-style link or image: no slice can carry
   * its definition, and only an inline destination ends in ')'.
   */
  private extentSpan(node: AnyNode): SourceSpan | null {
    if (node.incomplete === true) {
      return null;
    }
    const span = this.realSpan(node);
    if (span === null) {
      return null;
    }
    if (
      (node.kind === 'link' || node.kind === 'image') &&
      this.source[span.end - 1] !== ')'
    ) {
      return null;
    }
    return span;
  }

  private extended(node: AnyNode, body: ProjectionTask[]): ProjectionTask[] {
    const source = this.extentSpan(node);
    if (source === null) {
      return body;
    }
    return [{ op: 'openExtent', source }, ...body, { op: 'closeExtent' }];
  }

  /**
   * Projects a claimed node as one U+FFFC placeholder and returns true, or
   * returns false to let normal projection proceed. The gate is
   * `embedContentFor` — the same call segmentation makes, so the two cannot
   * disagree about a claim — plus a real span for the placeholder to map to.
   *
   * The piece is pushed DIRECTLY, not through `emit`: an embed's piece must
   * be exactly one piece covering exactly the placeholder, never merged into
   * a neighbour, because `mapSelectionToSource` treats it as an indivisible
   * unit (display length ≠ source length) — that is what makes a sweep
   * across the card yield the node's whole markdown. The mark is pushed
   * directly too, since its range is known outright.
   */
  private tryEmbed(node: AnyNode, topLevel = false): boolean {
    const content = embedContentFor(node, this.embedLookup, topLevel, this.withinContainer, node === this.soleParagraphChild);
    if (content === undefined) {
      return false;
    }
    const span = this.realSpan(node);
    if (span === null) {
      return false;
    }
    const start = this.text.length;
    this.text += EMBED_PLACEHOLDER;
    const piece: RunPiece = { textStart: start, textEnd: this.text.length, source: span };
    this.pieces.push(piece);
    this.embedPiece = piece;
    const embedId = this.embeds.length;
    this.marks.push({ kind: 'embed', start, end: this.text.length, embedId });
    this.embeds.push({ embedId, start, end: this.text.length, node, content });
    return true;
  }

  emit(chunk: string, source: SourceSpan | null): void {
    if (chunk.length === 0) {
      return;
    }
    const textStart = this.text.length;
    this.text += chunk;
    const last = this.pieces[this.pieces.length - 1];
    if (last && last !== this.embedPiece) {
      if (last.source === null && source === null) {
        last.textEnd = this.text.length;
        return;
      }
      // Merge linear pieces that continue each other in the source, so
      // e.g. text + softBreak + text collapse into one mappable piece.
      if (
        last.source !== null &&
        source !== null &&
        last.source.end === source.start &&
        last.textEnd - last.textStart === last.source.end - last.source.start &&
        chunk.length === source.end - source.start
      ) {
        last.textEnd = this.text.length;
        last.source = { start: last.source.start, end: source.end };
        return;
      }
    }
    this.pieces.push({ textStart, textEnd: this.text.length, source });
  }

  private withinContainer = false;
  private soleParagraphChild: AnyNode | null = null;

  private blockTasks(
    node: Block,
    topLevel: boolean,
    listDepth: number,
  ): ProjectionTask[] {
    if (topLevel) {
      this.withinContainer = constrainsEmbedWidth(node);
      this.soleParagraphChild = node.kind === 'paragraph' && node.children.length === 1 ? node.children[0] : null;
    }
    if (this.tryEmbed(node, topLevel)) {
      return NO_TASKS;
    }
    switch (node.kind) {
      case 'paragraph':
        return inlineSeq(node.children);
      case 'heading':
        return this.extended(
          node,
          marked('heading', inlineSeq(node.children), node.level),
        );
      case 'blockquote':
        return this.extended(
          node,
          marked(
            'blockquote',
            blockSeq(node.children, BLOCK_SEPARATOR, listDepth),
          ),
        );
      case 'list': {
        const base = node.start ?? 1;
        // Depth rides on each item's 'listItem' mark. NO indent glyphs are
        // emitted — spaces here would land in every copied selection, and no
        // amount of them could hang-indent a wrapped line. Indentation is the
        // view layer's job (runDecorations.ts), driven by these marks.
        const depth = listDepth + 1;
        return this.extended(
          node,
          separated(node.items, ITEM_SEPARATOR, (item, index) => {
          // A task glyph replaces the ordinal too: `1. [x] done` projects '\u2611 done'.
          const glyph =
            item.task === 'checked'
              ? this.glyphs.taskChecked
              : item.task === 'unchecked'
                ? this.glyphs.taskUnchecked
                : node.ordered
                  ? `${base + index}. `
                  : this.glyphs.bullet;
          // The mark wraps marker AND children, so a nested sublist sits
          // inside its parent item's mark the way every other construct
          // nests. ITEM_SEPARATOR, not the block default, for the children:
          // an item's own blocks — its paragraph and a nested sublist — sit
          // one line apart, so the sublist lands directly under its parent
          // bullet. This walks `item.children` rather than delegating to
          // `case 'listItem'`, which is why that case carrying the same
          // separator was not enough on its own.
          const itemTasks = this.extended(
            item,
            marked(
              'listItem',
              [
                ...marked('listMarker', [
                  { op: 'emit', chunk: glyph, source: null },
                ]),
                ...blockSeq(item.children, ITEM_SEPARATOR, depth),
              ],
              depth,
            ),
          );
          return this.blockLog === null
            ? itemTasks
            : [{ op: 'openBlock', kind: 'listItem' }, ...itemTasks, { op: 'closeBlock' }];
          }),
        );
      }
      case 'listItem':
        // ITEM_SEPARATOR, matching the `listItem` renderer: a nested sublist
        // sits directly under its parent bullet, not after a blank line.
        return this.extended(
          node,
          blockSeq(node.children, ITEM_SEPARATOR, listDepth),
        );
      case 'codeBlock':
        return marked('codeBlock', [
          { op: 'literal', node, display: node.literal },
        ]);
      case 'table':
        // The outer 'table' mark wraps the whole emission so the view layer
        // knows the table's full extent (border box, row rules, column
        // alignment — see runDecorations.ts). Marks sort outermost-first, so
        // it precedes the 'tableHeader' mark that shares its start.
        return this.extended(
          node,
          marked('table', [
            ...marked('tableHeader', [
              { op: 'block', node: node.header, topLevel: false, listDepth },
            ]),
            // The separator after the header stays outside 'tableBody', so
            // the body mark covers exactly the body rows' text.
            ...(node.rows.length === 0
              ? NO_TASKS
              : ([
                  { op: 'emit', chunk: ROW_SEPARATOR, source: null },
                  ...marked(
                    'tableBody',
                    separated(node.rows, ROW_SEPARATOR, (row) => [
                      { op: 'block', node: row, topLevel: false, listDepth },
                    ]),
                  ),
                ] satisfies ProjectionTask[])),
          ]),
        );
      case 'tableRow':
        return separated(node.cells, CELL_SEPARATOR, (cell) =>
          inlineSeq(cell.children),
        );
      case 'tableCell':
        return inlineSeq(node.children);
      case 'thematicBreak':
        // Contributes no selectable text — a rule is chrome, and injecting a
        // glyph for it would put characters in the copy that the author never
        // wrote. What it leaves behind instead is a ZERO-LENGTH mark at this
        // offset, pushed directly because `closeMark` drops empty ranges.
        this.marks.push({
          kind: 'thematicBreak',
          start: this.text.length,
          end: this.text.length,
        });
        return NO_TASKS;
      case 'htmlBlock':
        // Marked 'html' like the inline `htmlSpan` case, so a raw HTML block
        // flowing through the native host renders in the same muted mono the
        // fallback renderer gives it, instead of as bare body text.
        return marked('html', [{ op: 'literal', node, display: node.literal }]);
    }
  }

  private inlineTasks(node: Inline, next?: Inline): ProjectionTask[] {
    if (this.tryEmbed(node)) {
      return NO_TASKS;
    }
    const transformed = this.transform?.(node);
    if (transformed?.hide === true) {
      if (!startsWithWord(next)) this.dropTrailingSpace();
      return NO_TASKS;
    }
    const prefix = transformed?.prefix;
    const tasks =
      transformed?.text !== undefined ? this.replacedTasks(node, transformed.text) : this.nodeTasks(node);
    return prefix === undefined || prefix.text === '' || /[\r\n]/.test(prefix.text)
      ? tasks
      : [{ op: 'prefix', prefix }, ...tasks];
  }

  private nodeTasks(node: Inline): ProjectionTask[] {
    switch (node.kind) {
      case 'text':
        return [{ op: 'literal', node, display: node.value }];
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'underline':
      case 'spoiler':
        return this.extended(node, marked(node.kind, inlineSeq(node.children)));
      case 'link':
        // Three outcomes, not two, and the middle one is the point.
        //
        // A live link marks as 'link' and carries its href, which is what
        // `resolveRunPressables` turns into the native host's pressable list.
        //
        // A BLOCKED link marks as 'blockedLink' and ALSO carries its href.
        // This used to fall into the unmarked branch below, on the reasoning
        // that "the two paths must not disagree about what looks tappable" —
        // but agreeing by erasure is what broke `blockedLinks: 'node'`: the
        // renderer path saw the node and decided, the run path silently
        // reduced it to bare text. A consumer whose blocked schemes are
        // identifiers rather than destinations got a construct that vanished
        // whenever it flowed, and had to abandon native runs — and with them
        // selection — for every block containing one. The kinds are distinct,
        // so nothing has to guess: `runAttributes` styles them separately and
        // `onLinkPress` is told which it got.
        //
        // A STILL-STREAMING link marks as nothing. Its href is half-written,
        // so there is no range worth pointing at yet, and one that appeared
        // tappable for a frame and then moved would be worse than one that
        // shows up when it is real.
        if (node.incomplete) {
          return inlineSeq(node.children);
        }
        const linked = marked(
          node.blocked ? 'blockedLink' : 'link',
          inlineSeq(node.children),
          undefined,
          node.href,
        );
        return this.extended(node, linked);
      case 'codeSpan':
        return marked('code', [{ op: 'literal', node, display: node.value }]);
      case 'image':
        return [{ op: 'literal', node, display: node.alt }];
      case 'autolink': {
        // THE TEXT THE AUTHOR TYPED, NOT THE NORMALIZED HREF. Linkify rewrites a
        // bare `www.host` into `http://www.host`, and projecting the href made
        // the run show a URL nobody wrote — the projection silently editing the
        // prose. The built-in renderer has always used the source slice with the
        // href only as a fallback (`sliceSpan(...) || node.href`); this brings
        // the projection in line. The href still rides on the mark, so the
        // pressable and its target are unchanged.
        // The delimiters of a `<url>` autolink are markup, not text, and the
        // node's span covers them — so they are stripped here. A linkified bare
        // `www.host` has no delimiters and passes through untouched. `literal`
        // then finds the result inside the raw span, which maps the projected
        // range onto the URL itself rather than onto the brackets.
        const span = this.realSpan(node);
        const raw = span ? this.source.slice(span.start, span.end) : '';
        const typed =
          raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
        return marked(
          'link',
          [{ op: 'literal', node, display: typed || node.href }],
          undefined,
          node.href,
        );
      }
      case 'hardBreak':
        // An explicit break the author asked for (two trailing spaces, or a
        // backslash), so it projects as one.
        return [{ op: 'emit', chunk: '\n', source: this.realSpan(node) }];
      case 'softBreak':
        // A soft break is only where the *author* wrapped the source line, and
        // CommonMark renders it as a space. Projecting '\n' for it put the
        // native host at odds with both the fallback (`softBreak: () => ' '`
        // in renderers.tsx) and every other CommonMark renderer: hard-wrapped
        // prose — which is what LLM output usually is, and what the shipped
        // transcript fixture is — came out of the host as forced line breaks
        // mid-sentence while the fallback showed one flowing paragraph. The
        // two paths must not disagree about what characters are on screen;
        // that is the same rule the `link` case above follows.
        //
        // THIS IS OFFSET-NEUTRAL, which is the only reason it can land as its
        // own change rather than behind a projection version bump. `emit`
        // decides the piece table from `chunk.length` and the source span
        // alone: ' ' is one UTF-16 code unit exactly as '\n' was, against the
        // same `realSpan(node)`. So the linear-merge test above
        // (`chunk.length === source.end - source.start`) takes the same branch
        // it took before, the pieces tile identically, and every offset on
        // either side of the break is unchanged — the character sitting at
        // that offset simply looks different, and still maps to the source
        // newline it came from. Nothing in `mapSelectionToSource`, the copy
        // payload or the streaming prefix oracle moves.
        return [{ op: 'emit', chunk: this.softBreakGlyph, source: this.realSpan(node) }];
      case 'math':
        return marked('math', [{ op: 'literal', node, display: node.value }]);
      case 'htmlSpan':
        return marked('html', [{ op: 'literal', node, display: node.literal }]);
    }
  }

  /** A transformed node: its marks as usual, the replacement text inside. */
  private replacedTasks(node: Inline, text: string): ProjectionTask[] {
    const body: ProjectionTask[] =
      text.length === 0 ? NO_TASKS : [{ op: 'emit', chunk: text, source: this.realSpan(node) }];
    switch (node.kind) {
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'underline':
      case 'spoiler':
        return marked(node.kind, body);
      case 'link':
        if (node.incomplete) return body;
        return marked(node.blocked ? 'blockedLink' : 'link', body, undefined, node.href);
      case 'autolink':
        return marked('link', body, undefined, node.href);
      case 'codeSpan':
        return marked('code', body);
      case 'math':
        return marked('math', body);
      case 'htmlSpan':
        return marked('html', body);
      default:
        return body;
    }
  }

  /**
   * Takes back one ' ' just emitted, for a hidden node. Only from a linear
   * piece, and only when no open mark or extent starts after it.
   */
  private dropTrailingSpace(): void {
    const at = this.text.length - 1;
    if (at < 0 || this.text.charCodeAt(at) !== 32) return;
    const last = this.pieces[this.pieces.length - 1];
    if (last === undefined || last === this.embedPiece || last.textEnd !== this.text.length) return;
    if (this.openMarks.some((mark) => mark.start > at)) return;
    if (this.openExtents.some((extent) => extent.start > at)) return;
    if (this.marks.some((mark) => mark.end > at)) return;
    if (this.extents.some((extent) => extent.end > at)) return;
    if (last.source !== null) {
      const linear = last.textEnd - last.textStart === last.source.end - last.source.start;
      if (!linear) return;
      last.source = { start: last.source.start, end: last.source.end - 1 };
    }
    last.textEnd -= 1;
    this.text = this.text.slice(0, at);
    if (last.textEnd === last.textStart) this.pieces.pop();
  }

  /**
   * Emits display text for a node whose rendered form may differ from its
   * source, pinning it to as small a source range as the two forms allow:
   *
   * 1. The display occurs verbatim in the node's slice: one linear piece.
   * 2. Otherwise `alignLiteral` covers it with linear pieces where the two
   *    agree and one indivisible piece per respelled stretch (`\*`,
   *    `&hellip;`, a smart quote, a stripped indent). The native decoder
   *    merges a paragraph's text into one node, so pinning it whole would make
   *    any selection near a respelling copy the whole paragraph.
   * 3. Nothing in the display is spelled in the slice: one indivisible piece
   *    over the whole node span.
   */
  private literal(node: AnyNode, display: string): void {
    if (display.length === 0) {
      return;
    }
    const span = this.realSpan(node);
    if (span === null) {
      this.emit(display, null);
      return;
    }
    const start = this.text.length;
    const raw = this.source.slice(span.start, span.end);
    const from = contentStart(node, raw);
    // Only text and alt text arrive decoded; elsewhere `&copy;` displays as typed.
    const refs =
      node.kind === 'text' || node.kind === 'image'
        ? scanReferences(raw, from)
        : null;
    const at = raw.indexOf(display, from);
    // A hit inside a reference is a coincidence: `&amp;amp` displays `&amp`,
    // which the slice spells at 0, inside the entity.
    if (at >= 0 && !overlapsReference(refs, at, at + display.length)) {
      this.emit(display, {
        start: span.start + at,
        end: span.start + at + display.length,
      });
      // Text records no extent: syntax around its value is markup the parse
      // dropped, like the brackets of a link the URL policy degraded.
      if (node.kind !== 'text' && (at > 0 || display.length < raw.length)) {
        this.recordExtent(node, start);
      }
      return;
    }
    const cover = alignLiteral(display, raw, from, refs);
    if (cover === null) {
      // The whole span IS the piece, so an extent over it would say nothing.
      this.emit(display, span);
      return;
    }
    for (const piece of cover) {
      const chunk = display.slice(piece.display, piece.display + piece.length);
      // md4c synthesizes an indented code block's leftover indent
      // (md4c.c:5355-5357), so it maps to no source, like a bullet.
      this.emit(
        chunk,
        piece.sourceLength === 0
          ? null
          : {
              start: span.start + piece.source,
              end: span.start + piece.source + piece.sourceLength,
            },
      );
    }
    if (node.kind !== 'text') this.recordExtent(node, start);
  }

  private recordExtent(node: AnyNode, start: number): void {
    const source = this.extentSpan(node);
    if (source !== null) {
      this.pushExtent(start, source);
    }
  }

  /**
   * The node's span clamped into the real source, or null when the node is
   * synthetic (streaming-repair output living past all real offsets).
   */
  private realSpan(node: AnyNode): SourceSpan | null {
    if (node.synthetic) {
      return null;
    }
    const start = Math.min(Math.max(node.span.start, 0), this.source.length);
    const end = Math.min(Math.max(node.span.end, start), this.source.length);
    return end > start ? { start, end } : null;
  }
}

/**
 * Past the fence line for a fenced code block, so a body equal to the info
 * string (```` ```js\njs\n``` ````) cannot match inside the fence.
 */
function contentStart(node: AnyNode, raw: string): number {
  if (node.kind !== 'codeBlock' || !node.fenced) {
    return 0;
  }
  const eol = raw.indexOf('\n');
  return eol < 0 ? 0 : eol + 1;
}

/**
 * `length` display code units at `display` standing for `sourceLength` source
 * code units at `source`: linear when the lengths are equal, indivisible
 * otherwise.
 */
interface AlignedPiece {
  display: number;
  length: number;
  source: number;
  sourceLength: number;
}

/**
 * Covers `display` with pieces against `raw`, consuming `raw` monotonically
 * from `from`; null only when the slice runs out before anything matched.
 * Agreeing stretches become linear pieces; at a divergence the walk resyncs
 * and covers the gap with one indivisible piece, so a respelling costs only
 * itself.
 */
function alignLiteral(
  display: string,
  raw: string,
  from: number,
  refs: References | null = null,
): AlignedPiece[] | null {
  const pieces: AlignedPiece[] = [];
  let d = 0;
  let r = from;
  let resyncer: Resyncer | null = null;
  while (d < display.length) {
    if (r >= raw.length) {
      // Fold the unspelled tail into the last piece, making it indivisible.
      // A whole-span pin would read as linear for an indented code block (one
      // tab in, one newline out: equal lengths) and map it off by one.
      if (pieces.length === 0) {
        return null;
      }
      const last = pieces[pieces.length - 1];
      last.length += display.length - d;
      return pieces;
    }
    const ref = refs?.at.get(r);
    if (ref !== undefined) {
      const shown = referenceDisplay(ref, display, d, raw, r);
      if (shown > 0) {
        // Atomic: copying `©` copies `&copy;`, never `&`.
        pieces.push({ display: d, length: shown, source: r, sourceLength: ref.length });
        d += shown;
        r += ref.length;
        continue;
      }
    }
    const length = verbatimRun(display, d, raw, r, refs);
    if (length > 0) {
      pieces.push({ display: d, length, source: r, sourceLength: length });
      d += length;
      r += length;
      continue;
    }
    resyncer ??= new Resyncer(display, raw, from, refs);
    const resync = resyncer.next(d, r);
    if (resync === null) {
      pieces.push({
        display: d,
        length: display.length - d,
        source: r,
        sourceLength: raw.length - r,
      });
      return pieces;
    }
    if (resync.display > d) {
      pieces.push({
        display: d,
        length: resync.display - d,
        source: r,
        sourceLength: resync.source - r,
      });
    }
    // `resync.display === d` is an escape: the skipped backslash belongs to no piece.
    d = resync.display;
    r = resync.source;
  }
  return pieces;
}

function verbatimRun(
  display: string,
  d: number,
  raw: string,
  r: number,
  refs: References | null = null,
  limit = Infinity,
): number {
  let length = 0;
  while (
    length < limit &&
    d + length < display.length &&
    r + length < raw.length &&
    display[d + length] === raw[r + length] &&
    // Stop at a reference: in `a &amp; b` the `&` is the entity's, not the prose's.
    (length === 0 || refs === null || !refs.at.has(r + length))
  ) {
    length += 1;
  }
  if (
    length > 0 &&
    d + length < display.length &&
    isHighSurrogate(display.charCodeAt(d + length - 1))
  ) {
    length -= 1;
  }
  return length;
}

/**
 * The nearest place `display` and `raw` can meet again after a divergence,
 * or null.
 *
 * Two candidates: `forward` takes the first later display code point the
 * slice spells (right for a respelling like `\*` → `*`); `held` keeps the
 * source cursor and advances the display (right where md4c synthesized display
 * text, CommonMark example 274). The winner is the one followed by the longer
 * verbatim run, not the one skipping fewer characters; a tie goes to `forward`.
 *
 * Both cursors only move forward, so the indexes and `frontier` keep the whole
 * walk linear. `spelled` never lists an offset inside a reference.
 */
class Resyncer {
  private readonly spelled: CodePointIndex;
  private readonly shown: CodePointIndex;
  private frontier = 0;

  constructor(
    private readonly display: string,
    private readonly raw: string,
    from: number,
    private readonly refs: References | null,
  ) {
    this.spelled = new CodePointIndex();
    for (let i = from; i < raw.length; ) {
      if (refs !== null) {
        if (refs.interior[i] === 1) {
          i += 1;
          continue;
        }
        const ref = refs.at.get(i);
        if (ref !== undefined && ref.value != null && ref.value.length > 0) {
          this.spelled.add(ref.value.codePointAt(0) ?? 0, i);
          i += ref.length;
          continue;
        }
      }
      const point = raw.codePointAt(i) ?? 0;
      this.spelled.add(point, i);
      i += point > 0xffff ? 2 : 1;
    }
    this.shown = new CodePointIndex();
    for (let i = 0; i < display.length; ) {
      const point = display.codePointAt(i) ?? 0;
      this.shown.add(point, i);
      i += point > 0xffff ? 2 : 1;
    }
  }

  /** `d` and `r` must never decrease from one call to the next. */
  next(d: number, r: number): { display: number; source: number } | null {
    const forward = this.forward(d, r);
    const held = this.held(d, r);
    if (held === null) return forward;
    if (forward === null) return held;
    // Only which run is longer matters, so both are capped.
    const cap = RUN_COMPARISON_CAP;
    const { display, raw, refs } = this;
    const heldRun = verbatimRun(display, held.display, raw, held.source, refs, cap);
    const forwardRun = verbatimRun(display, forward.display, raw, forward.source, refs, cap);
    return heldRun > forwardRun ? held : forward;
  }

  /** The first display code point at or after `d` spelled strictly after `r`, so the source advances. */
  private forward(d: number, r: number): { display: number; source: number } | null {
    const { display } = this;
    for (let i = Math.max(d, this.frontier); i < display.length; ) {
      const point = display.codePointAt(i) ?? 0;
      const at = this.spelled.next(point, r + 1);
      if (at >= 0) {
        this.frontier = i;
        return { display: i, source: at };
      }
      i += point > 0xffff ? 2 : 1;
    }
    this.frontier = display.length;
    return null;
  }

  /**
   * The source held at `r` and the display advanced strictly past `d`;
   * strictly, or `&fjlig;` against `fx` would resync onto itself forever.
   */
  private held(d: number, r: number): { display: number; source: number } | null {
    const value = this.refs?.at.get(r)?.value;
    const point =
      (value != null && value.length > 0
        ? value.codePointAt(0)
        : this.raw.codePointAt(r)) ?? 0;
    let at = this.shown.next(point, d);
    if (at === d) at = this.shown.next(point, d + 1);
    return at < 0 ? null : { display: at, source: r };
  }
}

/** Past this many characters, two agreeing runs are as good as each other. */
const RUN_COMPARISON_CAP = 256;

/** Offsets by code point; `next` assumes `from` never decreases per code point. */
class CodePointIndex {
  private readonly lists = new Map<number, { at: number[]; cursor: number }>();

  add(point: number, offset: number): void {
    const list = this.lists.get(point);
    if (list === undefined) {
      this.lists.set(point, { at: [offset], cursor: 0 });
    } else {
      list.at.push(offset);
    }
  }

  next(point: number, from: number): number {
    const list = this.lists.get(point);
    if (list === undefined) return -1;
    let k = list.cursor;
    while (k < list.at.length && list.at[k] < from) k += 1;
    list.cursor = k;
    return k < list.at.length ? list.at[k] : -1;
  }
}

/**
 * A character reference or backslash escape. `value` is its display, or null
 * for a well-formed name the JS entity table lacks but md4c may decode.
 */
interface Reference {
  length: number;
  value: string | null;
}

interface References {
  at: Map<number, Reference>;
  /** Start offsets, ascending. */
  starts: number[];
  /** 1 at every offset strictly inside a reference. */
  interior: Uint8Array;
}

const NAMED_REFERENCE = /^&[A-Za-z][A-Za-z0-9]{0,31};/;

/**
 * The references `raw` spells from `from` on, or null when there are none.
 * One left-to-right pass, so `\&copy;` is an escape and not an entity.
 */
function scanReferences(raw: string, from: number): References | null {
  let found: Array<[number, Reference]> | null = null;
  for (let i = from; i < raw.length; ) {
    const code = raw.charCodeAt(i);
    let ref: Reference | null = null;
    if (code === 0x5c /* \ */ && i + 1 < raw.length) {
      if (isAsciiPunctuation(raw.charCodeAt(i + 1))) {
        ref = { length: 2, value: raw[i + 1] };
      }
    } else if (code === 0x26 /* & */) {
      const decoded = decodeEntityAt(raw, i);
      if (decoded !== null) {
        ref = { length: decoded.length, value: decoded.value };
      } else {
        const named = NAMED_REFERENCE.exec(raw.slice(i, i + 34));
        if (named !== null) {
          ref = { length: named[0].length, value: null };
        }
      }
    }
    if (ref === null) {
      i += 1;
      continue;
    }
    (found ??= []).push([i, ref]);
    i += ref.length;
  }
  if (found === null) {
    return null;
  }
  const interior = new Uint8Array(raw.length);
  for (const [start, ref] of found) {
    interior.fill(1, start + 1, start + ref.length);
  }
  return {
    at: new Map(found),
    starts: found.map(([start]) => start),
    interior,
  };
}

function overlapsReference(
  refs: References | null,
  start: number,
  end: number,
): boolean {
  if (refs === null) return false;
  for (const at of refs.starts) {
    if (at >= end) return false;
    if (at + (refs.at.get(at)?.length ?? 0) > start) return true;
  }
  return false;
}

/** Display width of a decoded reference or an unknown name left literal. */
function referenceDisplay(
  ref: Reference,
  display: string,
  d: number,
  raw: string,
  r: number,
): number {
  if (ref.value !== null) {
    return display.startsWith(ref.value, d) ? ref.value.length : 0;
  }
  if (display.startsWith(raw.slice(r, r + ref.length), d)) {
    return ref.length;
  }
  return 0;
}

function isAsciiPunctuation(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Maps a display-text selection back to a source span. The selection is
 * normalized (swapped if reversed) and clamped to the projected text; only
 * real pieces contribute — synthetic glyphs at the edges are skipped, and
 * synthetics strictly inside the selection are bridged by the enclosing
 * source range. Returns null when the selection is empty, out of range, or
 * touches only synthetic glyphs.
 *
 * Every `ProjectedExtent` the selection covers whole is unioned in, so a whole
 * construct copies with its syntax; a partial one maps to its pieces alone.
 */
export function mapSelectionToSource(
  projected: ProjectedRun,
  sel: { start: number; end: number },
  /**
   * `snapHeadings`: a selection that starts inside a heading and runs past
   * its end widens to the heading's start, syntax included.
   */
  options?: { snapHeadings?: boolean },
): SourceSpan | null {
  if (!Number.isFinite(sel.start) || !Number.isFinite(sel.end)) {
    return null;
  }
  let start = Math.min(sel.start, sel.end);
  let end = Math.max(sel.start, sel.end);
  start = Math.max(0, start);
  end = Math.min(projected.text.length, end);
  if (start >= end) {
    return null;
  }

  let sourceStart = Number.POSITIVE_INFINITY;
  let sourceEnd = Number.NEGATIVE_INFINITY;

  const pieces = projected.pieces;
  let lo = 0;
  let hi = pieces.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pieces[mid].textEnd <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < pieces.length && pieces[i].textStart < end; i += 1) {
    const piece = pieces[i];
    if (piece.source === null) {
      continue;
    }
    const overlapStart = Math.max(start, piece.textStart);
    const overlapEnd = Math.min(end, piece.textEnd);
    if (overlapStart >= overlapEnd) {
      continue;
    }
    const textLength = piece.textEnd - piece.textStart;
    const sourceLength = piece.source.end - piece.source.start;
    if (sourceLength <= 0) {
      continue;
    }
    let pieceStart: number;
    let pieceEnd: number;
    if (textLength === sourceLength) {
      pieceStart = piece.source.start + (overlapStart - piece.textStart);
      pieceEnd = piece.source.start + (overlapEnd - piece.textStart);
    } else {
      // Non-linear piece (decoded entity, alt text, ...): indivisible.
      pieceStart = piece.source.start;
      pieceEnd = piece.source.end;
    }
    if (pieceStart < sourceStart) {
      sourceStart = pieceStart;
    }
    if (pieceEnd > sourceEnd) {
      sourceEnd = pieceEnd;
    }
  }

  if (sourceStart >= sourceEnd || !Number.isFinite(sourceStart)) {
    // An all-synthetic selection maps to nothing, even over a whole extent.
    return null;
  }

  const extents = projected.extents ?? [];
  lo = 0;
  hi = extents.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (extents[mid].start < start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < extents.length && extents[i].start < end; i += 1) {
    const extent = extents[i];
    if (start > extent.start || extent.end > end) {
      continue;
    }
    if (extent.source.start < sourceStart) {
      sourceStart = extent.source.start;
    }
    if (extent.source.end > sourceEnd) {
      sourceEnd = extent.source.end;
    }
  }

  if (options?.snapHeadings === true) {
    for (const mark of projected.marks) {
      if (mark.kind !== 'heading' || mark.start >= start) continue;
      if (mark.end <= start || mark.end > end) continue;
      // The heading's extent carries its source, `#`s included.
      const extent = extents.find((e) => e.start === mark.start && e.end === mark.end);
      if (extent !== undefined && extent.source.start < sourceStart) sourceStart = extent.source.start;
    }
  }

  return { start: sourceStart, end: sourceEnd };
}

export function selectionDisplayText(
  projected: ProjectedRun,
  start: number,
  end: number,
): string {
  let plain = projected.text.slice(start, end);
  const embeds = projected.embeds;
  if (embeds === undefined) {
    return plain;
  }
  for (let i = embeds.length - 1; i >= 0; i -= 1) {
    const embed = embeds[i];
    if (embed.start < start || embed.end > end) {
      continue;
    }
    plain =
      plain.slice(0, embed.start - start) +
      (embed.content.text ?? '') +
      plain.slice(embed.end - start);
  }
  return plain;
}
