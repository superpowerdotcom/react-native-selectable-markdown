import type { AnyNode, Block, Inline, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { EmbedContent, EmbedLookup, RunSegment } from './runs';
import { embedContentFor } from './runs';

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
   * Every construct whose SOURCE holds characters its projection does not
   * show, outermost first — what `mapSelectionToSource` unions back in when a
   * selection covers the whole of one. Absent when the run has none (plain
   * prose with no markup at all).
   */
  extents?: ProjectedExtent[];
}

/**
 * A construct's projected range paired with the source span it came from,
 * recorded ONLY when the two differ by characters no piece covers.
 *
 * WHAT IT IS FOR. A block's own syntax projects no text: the `# ` of a
 * heading, the `> ` of a quote, a list item's marker, a fence, a table's
 * pipes, and inline the `**` of a strong span or the `](url)` of a link. None
 * of it belongs to a piece, so the hull of the pieces a selection touched
 * cannot contain it — and copying that hull yields markdown that re-parses as
 * something else: a heading becomes body text, a list becomes a paragraph.
 * `mapSelectionToSource` therefore unions in an extent whenever the selection
 * covers the construct's WHOLE projected range, which is exactly the case
 * where the syntax is unambiguously part of what the user swept.
 *
 * A construct whose pieces already cover its whole span records nothing —
 * plain prose, an HTML block whose literal is its source — so this list holds
 * only what actually changes an answer.
 *
 * INCOMPLETE CONSTRUCTS ARE NOT RECORDED. A still-streaming heading or link
 * has a span that is still moving and syntax that is not written yet; copying
 * half of `[text](htt` is worse than copying `text`.
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
   *
   * `end === start + 1` ALWAYS — a placeholder is exactly one U+FFFC — and
   * entries are recorded in ascending `start`. Together those two make the
   * entries a strictly increasing, non-overlapping sequence in BOTH offsets,
   * which is a load-bearing invariant and not just a description: consumers
   * sweep the list in one pass and rely on `end` being non-decreasing as well
   * as `start` (`embedLineHeightFloors` in src/view/runAttributes.ts retires
   * covering attributes by `end` as it walks, and the copy-text substitution
   * in `selectionDisplayText` walks the list backwards so earlier offsets stay
   * valid). A multi-character or a zero-width placeholder would break both
   * silently. `projectRun` is the only writer, and its embed task emits one
   * character per claimed node.
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
 * projected text themselves.
 *
 * WHERE IT IS, AND WHERE IT IS NOT. `ProjectedRun.text` carries it, and so
 * does anything read straight off the native host — the platform's own Copy
 * included. A copy payload's `plain` does NOT: `handleSelectionAction`
 * substitutes each in-range placeholder for the embed's declared
 * `EmbedContent.text`, or deletes it when the claim declared none. So a
 * consumer scanning `plain` for this character finds nothing, and one
 * scanning `text` finds one per embed.
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
//   - '☑ ' / '☐ ' instead of the item's WHOLE marker for task list items —
//            the bullet OR the ordinal, whichever the list would have used
//            (see the `list` case)
//   - '\n'   for a hard break, ' ' for a soft break — the two are not the same
//            glyph, and the reason is on the `softBreak` case below
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

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

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
   * A projection of an earlier, SHORTER version of this same run, to extend
   * instead of redoing. Ignored unless it is genuinely reusable; see
   * `reusablePrefix` for the test and `PreviousProjection` for the contract.
   *
   * IT DOES NOT CARRY ITS OWN KEY, so the caller owns the same discipline the
   * two options above spell out: a `previous` built with different glyphs or a
   * different `embed` lookup would splice text projected under one set of rules
   * onto text projected under another, and nothing here can tell. Callers that
   * hold projections across renders should use `createRunProjectionCache`
   * (src/view/projectionCache.ts), which keys on all three.
   */
  previous?: PreviousProjection;
}

/**
 * A projection to grow: the blocks it covered, and what it produced.
 *
 * `blocks` must be a PREFIX of the run's blocks BY IDENTITY. That is the whole
 * validity condition, and it is enough because a `Block` object belongs to one
 * parse of one source: `StreamSession` hands the same object back on every
 * later snapshot precisely because the source under it has frozen (docs/
 * STREAMING.md, "Identity"), and a block's subtree is immutable once parsed. So
 * the same blocks projected against the same glyph/embed key can only produce
 * the text they produced before, and the run's growth is pure APPEND — which is
 * the case this exists for: a settled prose run absorbs one newly settled block
 * per settle, and re-projecting the whole thing each time is what made view
 * work quadratic over a stream.
 */
export interface PreviousProjection {
  blocks: readonly Block[];
  projected: ProjectedRun;
}

/**
 * `previous` if it may be extended into `run`, else null.
 *
 * Identity, not equality: two structurally equal blocks from two different
 * parses are not interchangeable, because the source they index into is not.
 * The final length check is a cheap guard against the one way the invariant
 * could be violated from outside — a caller pairing a projection with a
 * document whose source has since been truncated (a `replace` that diverged),
 * where the reused prefix would map onto offsets that no longer exist.
 */
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
 * keep their whole source range and are mapped as an indivisible unit. A node
 * whose display differs from its source only in places — a backslash escape,
 * an `&amp;`, an `&hellip;`, a smart quote — is covered by SEVERAL pieces
 * rather than pinned whole, so the respelling drags only itself; see
 * `literal`.
 *
 * With `options.previous` the projection is INCREMENTAL: the earlier
 * projection's text, pieces, marks and embeds are carried over and only the
 * blocks appended since are projected. The result is indistinguishable from a
 * projection from scratch — the corpus-scale proof of that is
 * conformance/selection/incremental-projection.test.ts — because the projector
 * is resumed in exactly the state it would have been in at that block
 * boundary; see the constructor.
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
    // Nothing was appended. Returning the SAME object, not a copy: every memo
    // downstream (attributes, decorations, pressables, embeds) keys on the
    // projection's identity, so this is what makes a re-segmentation that
    // changed nothing cost nothing.
    return reuse.projected;
  }
  const projector = new RunProjector(
    doc.source,
    glyphs,
    options?.embed,
    reuse?.projected,
  );
  projector.project(
    reuse === null ? run.blocks : run.blocks.slice(reuse.blocks.length),
    reuse !== null,
  );
  return projector.finish();
}

/**
 * One step of the projection walk.
 *
 * THE PROJECTOR RUNS THESE OFF AN EXPLICIT STACK INSTEAD OF RECURSING, AND
 * THE REASON IS UNTRUSTED INPUT. Markdown nesting depth is unbounded, and
 * three kilobytes of `'> '` is 1500 levels of blockquote — well inside what a
 * model can emit and nothing upstream caps it: the native decoder builds its
 * tree off an explicit stack (`decode.ts`), so it hands back a tree as deep as
 * the source asks for. The recursive form of this projector overflowed the JS
 * stack at roughly 1250 levels, and it did so inside the `useMemo` that
 * projects a run during React render — where a RangeError is not a dropped
 * frame but a torn-down tree. The stack below lives on the heap, so depth
 * costs memory and nothing else.
 *
 * `emit` and `literal` append text; `openMark`/`closeMark` bracket a
 * construct's range and record the mark when it closes, which is what keeps
 * `marks` in innermost-first push order for `finish` to sort;
 * `openExtent`/`closeExtent` do the same for the source span a construct's
 * syntax lives in (see `ProjectedExtent`); `block` and `inline` expand one
 * node into the tasks for its own text and its children.
 */
type ProjectionTask =
  | { op: 'block'; node: Block; topLevel: boolean; listDepth: number }
  | { op: 'inline'; node: Inline }
  | { op: 'emit'; chunk: string; source: SourceSpan | null }
  | { op: 'literal'; node: AnyNode; display: string }
  | { op: 'openMark'; kind: MarkKind; level?: number; href?: string }
  | { op: 'closeMark' }
  | { op: 'openExtent'; source: SourceSpan }
  | { op: 'closeExtent' };

/** A mark whose body is still being emitted. */
interface OpenMark {
  kind: MarkKind;
  start: number;
  level?: number;
  href?: string;
}

/** An extent whose body is still being emitted. */
interface OpenExtent {
  start: number;
  source: SourceSpan;
}

/** Shared empty task list — a node that expands to nothing (an embed claim,
 * a thematic break) returns this rather than allocating. */
const NO_TASKS: ProjectionTask[] = [];

/**
 * `body` bracketed by the mark tasks that record it: the task form of what
 * used to be `marked(kind, () => body())`, with the same rule that a mark
 * covering no text is dropped when it closes (see `closeMark`).
 */
function marked(
  kind: MarkKind,
  body: ProjectionTask[],
  level?: number,
  href?: string,
): ProjectionTask[] {
  return [{ op: 'openMark', kind, level, href }, ...body, { op: 'closeMark' }];
}

/** `tasksFor` over each item, with `separator` emitted between them. */
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

function inlineSeq(children: Inline[]): ProjectionTask[] {
  return children.map((node): ProjectionTask => ({ op: 'inline', node }));
}

class RunProjector {
  private text: string;
  private readonly pieces: RunPiece[];
  private readonly marks: RunMark[];
  private readonly embeds: ProjectedRunEmbed[];
  /** The piece the last embed pushed, so `emit`'s linear merge can refuse to
   * grow it: an embed's piece is atomic BY CONTRACT, not by the length
   * inequality that usually keeps a piece indivisible — a claimed node whose
   * source span is exactly one code unit would otherwise read as linear and
   * merge into adjacent prose. */
  private embedPiece: RunPiece | null = null;
  /** Tasks still to run, innermost last — `drain` takes from the end. */
  private readonly stack: ProjectionTask[] = [];
  /** Marks whose body is still being emitted, innermost last. */
  private readonly openMarks: OpenMark[] = [];
  /** Constructs whose source span outruns their pieces; see
   * `ProjectedExtent`. */
  private readonly extents: ProjectedExtent[];
  /** Extents whose body is still being emitted, innermost last. */
  private readonly openExtents: OpenExtent[] = [];

  /**
   * `seed` RESUMES a projection at a top-level block boundary instead of
   * starting one, which is what makes an append-only run cost only its append.
   *
   * The state restored is everything `emit` and `finish` read, and the boundary
   * is why that is all of it: `openMarks` and `openExtents` are empty between
   * top-level blocks (every mark and extent a block opens, it closes), and
   * `stack` is empty because `drain` runs to exhaustion. So the resumed
   * projector is in exactly the state the from-scratch one was in at the same
   * point, and every later decision — piece merging, mark offsets, extent
   * ranges, embed ids — falls out identically. The corpus-scale proof is
   * conformance/selection/incremental-projection.test.ts, which deep-compares
   * the whole projection at every block boundary of every corpus run.
   *
   * TWO THINGS ARE COPIED RATHER THAN SHARED, both because `seed` is still a
   * live `ProjectedRun` that its holder may keep using. The arrays are sliced,
   * so appending here does not lengthen theirs; and the LAST PIECE is cloned,
   * because `emit` grows the last piece in place when the next chunk continues
   * it. Everything else — the piece objects before the last, the embed and
   * extent entries — is only ever read.
   */
  constructor(
    private readonly source: string,
    private readonly glyphs: ProjectionGlyphs,
    private readonly embedLookup?: EmbedLookup,
    seed?: ProjectedRun,
  ) {
    if (seed === undefined) {
      this.text = '';
      this.pieces = [];
      this.marks = [];
      this.embeds = [];
      this.extents = [];
      return;
    }
    this.text = seed.text;
    this.pieces = seed.pieces.slice();
    this.marks = seed.marks.slice();
    this.embeds = seed.embeds === undefined ? [] : seed.embeds.slice();
    this.extents = seed.extents === undefined ? [] : seed.extents.slice();
    const last = this.pieces[this.pieces.length - 1];
    if (last !== undefined) {
      const clone: RunPiece = { ...last };
      this.pieces[this.pieces.length - 1] = clone;
      // Restore the atomic-embed-piece guard when the run ended on an embed,
      // so a claimed node at the seam is no more mergeable than it was mid-run.
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

  /**
   * Projects the run's blocks, which are direct children of the document —
   * the only position that offers the embed lookup a top-level claim, and the
   * only place list depth starts over at zero.
   *
   * `continuing` says these blocks follow ones already projected (a seeded
   * projector), so the separator that would have been emitted between the last
   * of those and the first of these leads the list. `separated` only ever puts
   * separators BETWEEN the blocks it is given, which is exactly the one thing a
   * resumed projection has to supply for itself.
   */
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
    //
    // A SEEDED projector sorts an already-sorted head followed by raw new
    // marks, and gets the same answer a from-scratch sort would: `Array#sort`
    // is stable (required since ES2019), every seeded mark starts strictly
    // before every new one (the appended blocks begin after a two-character
    // BLOCK_SEPARATOR, and the only zero-length mark kind — `thematicBreak` —
    // sits at most at the seam itself), and re-sorting a sorted head leaves it
    // untouched. So ties keep their push order on both paths.
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
    // Extents sort exactly as marks do, and for the same reason: they are
    // pushed as their construct closes, so the raw order is innermost-first,
    // and a seeded projector sorts an already-sorted head followed by raw new
    // entries to the same answer a from-scratch sort gives.
    if (this.extents.length > 0) {
      projected.extents = this.extents
        .slice()
        .sort((a, b) => a.start - b.start || b.end - a.end);
    }
    return projected;
  }

  /** Runs `tasks` and everything they expand into, depth-first, in order. */
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

  /** Pushed in reverse so the stack pops them in the order given. */
  private push(tasks: ProjectionTask[]): void {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      this.stack.push(tasks[i]);
    }
  }

  private step(task: ProjectionTask): void {
    switch (task.op) {
      case 'block':
        this.push(this.blockTasks(task.node, task.topLevel, task.listDepth));
        return;
      case 'inline':
        this.push(this.inlineTasks(task.node));
        return;
      case 'emit':
        this.emit(task.chunk, task.source);
        return;
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
    }
  }

  /**
   * Records the mark whose body just finished. Empty ranges are dropped: a
   * zero-width mark is not a construct anyone can style, and it would make
   * every list item's bullet-only entry noise in the list.
   *
   * `level` and `href` stay off the mark when absent rather than riding along
   * as `undefined`: marks are compared with deep equality in tests and
   * serialized in debugging output, and a key that is present-but-undefined
   * is a difference both of those see.
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

  /**
   * Records the extent whose body just finished, unless the pieces under it
   * already say everything its span does — a construct that projects nothing
   * (an empty range) or one whose syntax is not actually outside the range
   * the body emitted.
   */
  private closeExtent(): void {
    const open = this.openExtents.pop();
    if (open === undefined) {
      return;
    }
    this.pushExtent(open.start, open.source);
  }

  /**
   * Records an extent over `[start, this.text.length)`, unless it says
   * nothing: an empty range, or a repeat of the entry just pushed. The repeat
   * is not hypothetical — a one-item list closes at the same offsets over the
   * same span as its item, which is what a nested `- two` under `- one` is —
   * and every duplicate would be walked again on every selection map.
   */
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
   * The span an extent for `node` should carry, or null when it must not
   * record one at all. THE ONE GATE, so the task form and the direct form
   * cannot disagree about what is recordable.
   *
   * Three refusals. A SYNTHETIC node — or one whose span `realSpan` clamps
   * away — has no source to point at. An INCOMPLETE one's span is still
   * moving and its syntax is not written yet —
   * copying half of `[text](htt` is worse than copying `text`. And a link or
   * image whose destination is a DEFINITION somewhere else in the document
   * (`[text]`, `[text][]`, `[text][label]`) is not self-contained: no slice
   * of this selection can carry the definition, so copying the brackets would
   * paste literal `[text]` where copying the words at least pastes the words.
   * An inline destination is the only form that closes on ')', which is the
   * whole of that test.
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

  /**
   * `body` bracketed by the extent tasks that record this construct's own
   * source span, so a selection covering the whole of it copies the syntax
   * too.
   */
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
   * directly too: the `openMark`/`closeMark` pair exists for ranges a body
   * emits, and this range is known outright.
   */
  private tryEmbed(node: AnyNode, topLevel = false): boolean {
    const content = embedContentFor(node, this.embedLookup, topLevel);
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

  private blockTasks(
    node: Block,
    topLevel: boolean,
    listDepth: number,
  ): ProjectionTask[] {
    if (this.tryEmbed(node, topLevel)) {
      return NO_TASKS;
    }
    switch (node.kind) {
      case 'paragraph':
        return inlineSeq(node.children);
      case 'heading':
        // Extended: the `# ` (or the setext underline) is the difference
        // between copying a heading and copying a line of body text.
        return this.extended(
          node,
          marked('heading', inlineSeq(node.children), node.level),
        );
      case 'blockquote':
        // Extended: every line's `> ` is chrome the projection drops.
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
        // Extended twice over: the whole list, so selecting all of it copies
        // a list, and each item, so selecting one item copies an item. The
        // item's span is what carries its marker — the projected glyph is
        // synthetic and maps to no source at all.
        return this.extended(
          node,
          separated(node.items, ITEM_SEPARATOR, (item, index) => {
          // A TASK GLYPH REPLACES THE ITEM'S WHOLE MARKER IN BOTH LIST KINDS,
          // not just a bullet: `item.task` is tested before `node.ordered`,
          // so `1. [x] done` projects '\u2611 done' and the ordinal is gone.
          // The checkbox is the thing the reader acts on, and two markers in
          // front of one line reads as chrome; the number is still in the
          // source, which is what copying the item yields either way.
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
          return this.extended(
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
            ...node.rows.flatMap((row): ProjectionTask[] => [
              { op: 'emit', chunk: ROW_SEPARATOR, source: null },
              { op: 'block', node: row, topLevel: false, listDepth },
            ]),
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
        // offset (pushed directly: a closing mark drops an empty range by
        // design), which is how the view layer knows where to draw the rule.
        // The surrounding BLOCK_SEPARATORs give it a blank line to be drawn
        // in.
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

  private inlineTasks(node: Inline): ProjectionTask[] {
    if (this.tryEmbed(node)) {
      return NO_TASKS;
    }
    switch (node.kind) {
      case 'text':
        return [{ op: 'literal', node, display: node.value }];
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'underline':
      case 'spoiler':
        // Extended: the delimiters are the construct. Sweeping exactly the
        // bold words and copying `bold words` loses the bold.
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
        // Extended when the source carries its own destination; see
        // `extentSpan` for the reference-link case, which does not.
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
        return [{ op: 'emit', chunk: ' ', source: this.realSpan(node) }];
      case 'math':
        return marked('math', [{ op: 'literal', node, display: node.value }]);
      case 'htmlSpan':
        return marked('html', [{ op: 'literal', node, display: node.literal }]);
    }
  }

  /**
   * Emits display text for a node whose rendered form may differ from its
   * source, pinning it to as small a source range as the two forms allow.
   * Three outcomes, in order of preference:
   *
   * 1. The display text occurs verbatim inside the node's source slice
   *    (plain text, a code span's content, a fenced block's body): the piece
   *    is pinned to that exact sub-span and offsets map 1:1.
   * 2. It does not, but the slice still spells the display piecewise — what a
   *    backslash escape (`\*` → `*`), an entity that decodes to a character
   *    the source already spells (`&amp;` → `&`), a respelled character
   *    (`&hellip;` → `…`, `--` → `–`, `"` → `“`) or an indented code block's
   *    stripped indent leaves behind. `alignLiteral` covers the display with
   *    LINEAR pieces wherever the two agree and one INDIVISIBLE piece over
   *    each stretch that is respelled, so a respelling costs only itself.
   *    THIS IS NOT A MICRO-OPTIMIZATION: the native decoder merges an
   *    escape's or an entity's text events into ONE text node spanning the
   *    whole run (`appendText` in src/engine/native/decode.ts), and in plain
   *    prose that node is the entire paragraph — so before this, a single
   *    `\*` or `&hellip;` anywhere in a paragraph made a twelve-character
   *    selection copy all hundred-odd characters of it.
   * 3. No alignment exists at all: NOTHING in the display is spelled anywhere
   *    in the slice (a repaired break marker, alt text against a span that no
   *    longer holds it). The piece then keeps the whole node span and maps as
   *    an indivisible unit. A slice that merely runs out early is NOT this
   *    case — `alignLiteral` folds the unmatched tail into its last piece —
   *    and the difference is load-bearing: the whole-span pin is only safe
   *    when nothing matched, because a display and a slice of equal length
   *    read as linear whether or not they say the same thing.
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
    const at = raw.indexOf(display, from);
    if (at >= 0) {
      this.emit(display, {
        start: span.start + at,
        end: span.start + at + display.length,
      });
      // A construct whose content sits INSIDE its source — a code span's
      // backticks, a fenced block's fences, an autolink's angle brackets, an
      // image's `![...](...)`. The piece pins the content; the extent is what
      // puts the delimiters back when the whole of it is selected. Two kinds
      // of literal record nothing here: one that occupies its whole slice
      // (plain prose, an HTML block), because there is nothing outside the
      // piece; and a TEXT node, because whatever surrounds its value is
      // markup the parse has already decided to drop — a link the URL policy
      // degraded to text keeps the brackets in its span, and copying `[foo]`
      // for the word `foo` would paste brackets that mean nothing where they
      // land.
      if (node.kind !== 'text' && (at > 0 || display.length < raw.length)) {
        this.recordExtent(node, start);
      }
      return;
    }
    const cover = alignLiteral(display, raw, from);
    if (cover === null) {
      // The whole span IS the piece, so an extent over it would say nothing.
      this.emit(display, span);
      return;
    }
    for (const piece of cover) {
      const chunk = display.slice(piece.display, piece.display + piece.length);
      // `sourceLength === 0` is display the slice does not account for at all
      // — an indented code block's leftover indent, which md4c SYNTHESIZES as
      // spaces (md4c.c:5355-5357) rather than reporting from the source. It
      // is a glyph like a bullet: real on screen, backed by nothing, so it
      // maps to no source rather than to an empty span.
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
    // The cover skips whatever the source spells differently — a backslash,
    // an entity, a fence, an indent. Selecting the whole literal should still
    // copy all of it.
    this.recordExtent(node, start);
  }

  /**
   * An extent over the text emitted since `start`, for a construct whose
   * pieces do not reach the edges of its span. The task pair exists for
   * constructs with a BODY; this is the direct form, for the ones that emit
   * one literal and know their own range outright.
   */
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
 * Where a literal's content can start inside the node's own source slice.
 * Zero for everything except a FENCED CODE BLOCK, whose slice opens with the
 * fence line: searching from 0 lets the body match inside the INFO STRING
 * when the two coincide (```` ```js\njs\n``` ````), which pins the piece to
 * the fence line and maps every offset in the block onto the wrong source
 * range — the lengths still agree, so the piece reads as linear and nothing
 * downstream notices; the copied markdown just repeats the code line and
 * loses the opening fence. A fenced body always starts after the first line
 * break.
 */
function contentStart(node: AnyNode, raw: string): number {
  if (node.kind !== 'codeBlock' || !node.fenced) {
    return 0;
  }
  const eol = raw.indexOf('\n');
  return eol < 0 ? 0 : eol + 1;
}

/**
 * One piece of an `alignLiteral` cover: `length` display code units starting
 * at `display` stand for `sourceLength` source code units starting at
 * `source` (both offsets relative to their own string).
 *
 * `sourceLength === length` is a LINEAR piece — the two agree character for
 * character, and `mapSelectionToSource` maps offsets through it one for one.
 * Anything else is INDIVISIBLE: the source spells that stretch differently,
 * so any selection touching it maps to the whole of it.
 */
interface AlignedPiece {
  display: number;
  length: number;
  source: number;
  sourceLength: number;
}

/**
 * Covers `display` with pieces against `raw`, consuming `raw` monotonically
 * from `from`. Returns null only when no cover exists at all (the slice runs
 * out before the display does), which leaves `literal` its whole-span pin.
 *
 * THE WALK HAS EXACTLY TWO MOVES, and the second is what makes a respelling
 * cost only itself:
 *
 *  - where display and source agree, take the longest verbatim run and emit
 *    it as a LINEAR piece;
 *  - where they do not, RESYNC: find the earliest later display character the
 *    source still spells ahead of the cursor, and cover everything between
 *    here and there with ONE indivisible piece. `\*` → `*` resyncs on the
 *    `*` itself, so nothing but the backslash is skipped and no indivisible
 *    piece is produced at all; `&hellip;` → `…` resyncs on the character
 *    after it, so the ellipsis alone is pinned to `&hellip;` and the prose on
 *    both sides stays linear; `"` → `“` resyncs the same way onto a
 *    one-for-one piece, which `emit` then merges straight into the linear
 *    prose around it. That last case is why a smart-punctuation paragraph is
 *    one linear piece rather than one indivisible one.
 *
 * A resync always advances the display OR the source, so the walk terminates.
 * It advances the source in the ordinary respelling case; it advances the
 * display alone where the display carries characters the slice never had (an
 * indented code block's synthesized indent), and that piece is emitted with
 * no source at all. Source offsets never move backwards, so the pieces stay
 * in order and a hull over them stays tight.
 */
function alignLiteral(
  display: string,
  raw: string,
  from: number,
): AlignedPiece[] | null {
  const pieces: AlignedPiece[] = [];
  let d = 0;
  let r = from;
  while (d < display.length) {
    if (r >= raw.length) {
      // THE SOURCE RAN OUT FIRST. Nothing matched at all (`pieces` empty)
      // means there is no cover to build and the caller keeps its whole-span
      // pin. Otherwise the display has a TAIL the slice does not spell, and
      // the honest answer is to fold that tail into the last piece — which
      // makes that piece indivisible, because its display is now longer than
      // the source it stands for.
      //
      // AN INDENTED CODE BLOCK IS THE CASE THIS EXISTS FOR, and returning
      // null there was a correctness bug rather than a missed optimization.
      // `\tfoo\tbaz\t\tbim\n` has slice `\tfoo\tbaz\t\tbim` (the indent in,
      // the newline out — `widenCodeBlock`) against the literal
      // `foo\tbaz\t\tbim\n` (the indent stripped by md4c, the newline kept).
      // One leading tab traded for one trailing newline: THE TWO ARE THE SAME
      // LENGTH. So the whole-span fallback produced a piece whose display
      // length equalled its source length — which is exactly what
      // `mapSelectionToSource` reads as linear — and every offset in the
      // block mapped one character to the left, silently. Folding the tail in
      // here pins the block to the source it actually came from and makes the
      // piece indivisible, so the arithmetic that was wrong is not attempted.
      if (pieces.length === 0) {
        return null;
      }
      const last = pieces[pieces.length - 1];
      last.length += display.length - d;
      return pieces;
    }
    const length = verbatimRun(display, d, raw, r);
    if (length > 0) {
      pieces.push({ display: d, length, source: r, sourceLength: length });
      d += length;
      r += length;
      continue;
    }
    const resync = nextResync(display, d, raw, r);
    if (resync === null) {
      // Nothing left in the display is spelled in the rest of the slice, so
      // what remains of each stands for what remains of the other.
      pieces.push({
        display: d,
        length: display.length - d,
        source: r,
        sourceLength: raw.length - r,
      });
      return pieces;
    }
    if (resync.display > d) {
      // The display between here and the resync point is respelled in the
      // source: one indivisible piece over both stretches.
      pieces.push({
        display: d,
        length: resync.display - d,
        source: r,
        sourceLength: resync.source - r,
      });
    }
    // `resync.display === d` is the escape case: the character is spelled the
    // same, just further along (the backslash sits between), so the skipped
    // source belongs to no piece at all.
    d = resync.display;
    r = resync.source;
  }
  return pieces;
}

/**
 * The length of the longest stretch that `display` and `raw` share starting
 * at `d` and `r`, never ending between the halves of a surrogate pair — a
 * piece boundary inside one would hand a consumer half a code point.
 */
function verbatimRun(
  display: string,
  d: number,
  raw: string,
  r: number,
): number {
  let length = 0;
  while (
    d + length < display.length &&
    r + length < raw.length &&
    display[d + length] === raw[r + length]
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
 * The nearest place the two strings can meet again, measured in characters
 * skipped — `(display' - d) + (source' - r)` — with the two candidates below
 * as the only contenders. Whole code points at a time on both sides, so a
 * resync never lands between the halves of a surrogate pair. Null when they
 * cannot meet again at all.
 *
 * WHY THERE ARE TWO CANDIDATES AND NOT JUST THE FIRST. The obvious rule —
 * walk the display forward and take the first code point that occurs later in
 * the slice — is right for a respelling, where the source spells something
 * the display does not (`\*` → `*`, `&hellip;` → `…`). It is badly wrong
 * where the DISPLAY carries something the source never had, because it will
 * happily jump the source cursor across real content to find a spurious
 * later match for the synthesized character. CommonMark example 274
 * (`1.      indented code`) is the case: md4c synthesizes one leading space
 * for the leftover indent, and matching that space against the space in
 * `indented code` skipped eight source characters and mis-aligned the whole
 * block. So the HELD candidate is considered too: keep the source cursor
 * where it is and advance the display to wherever the slice's character at
 * `r` turns up.
 *
 * THE WINNER IS THE ONE THE TWO STRINGS AGREE FOR LONGEST AFTER IT, not the
 * one that skips fewest characters. Skip count picks wrong on the very next
 * block of that same example: `       more code` against the literal `more
 * code\n` skips seven source spaces the forward way and four display
 * characters the held way, so fewest-skipped chooses `held` and mis-aligns it
 * — while the verbatim run after each says 9 against 1 and chooses right. A
 * tie goes to `forward`, which is the rule that was here before this one and
 * the one every respelling case takes.
 */
function nextResync(
  display: string,
  d: number,
  raw: string,
  r: number,
): { display: number; source: number } | null {
  const forward = forwardResync(display, d, raw, r);
  const held = heldResync(display, d, raw, r);
  if (held === null) return forward;
  if (forward === null) return held;
  const heldRun = verbatimRun(display, held.display, raw, held.source);
  const forwardRun = verbatimRun(display, forward.display, raw, forward.source);
  return heldRun > forwardRun ? held : forward;
}

/**
 * The first display code point at or after `d` that occurs in `raw` strictly
 * after `r`, and where it occurs. Advances the source cursor by at least one,
 * so the piece it produces covers real source.
 */
function forwardResync(
  display: string,
  d: number,
  raw: string,
  r: number,
): { display: number; source: number } | null {
  for (let i = d; i < display.length; ) {
    const point = String.fromCodePoint(display.codePointAt(i) ?? 0);
    const at = raw.indexOf(point, r + 1);
    if (at >= 0) {
      return { display: i, source: at };
    }
    i += point.length;
  }
  return null;
}

/**
 * The source cursor held at `r`, with the display advanced to the first place
 * at or after `d` that spells `raw`'s code point there. Always strictly after
 * `d` when it exists — the caller only asks after `display[d]` and `raw[r]`
 * have already failed to match — so the walk still advances.
 */
function heldResync(
  display: string,
  d: number,
  raw: string,
  r: number,
): { display: number; source: number } | null {
  const point = String.fromCodePoint(raw.codePointAt(r) ?? 0);
  const at = display.indexOf(point, d);
  if (at < 0) return null;
  // A match landing on the low half of a surrogate pair is not that code
  // point at all; `indexOf` of a whole code point cannot do that, but a
  // defensive check costs nothing and the alternative is a split pair.
  if (at > 0 && isHighSurrogate(display.charCodeAt(at - 1))) return null;
  return { display: at, source: r };
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
 * THE HULL IS CONSTRUCT-AWARE, and without that copy would be lossy in a way
 * no piece can express. A construct's own syntax projects no text — a
 * heading's `# `, a quote's `> `, a list item's marker, a fence, a table's
 * pipes, a strong span's `**` — so it belongs to no piece and cannot be in
 * the hull of the pieces a selection touched. Copying that hull yielded
 * markdown that re-parsed as something else: `- one\n- two` came back as
 * `one\n- two`, a paragraph. So every `ProjectedExtent` the selection covers
 * WHOLE is unioned in as well, which is exactly the case where the syntax is
 * unambiguously part of what the user swept. A selection that covers only
 * part of a construct still maps to the pieces alone, because half a list is
 * not a list and its markers would be a guess.
 */
export function mapSelectionToSource(
  projected: ProjectedRun,
  sel: { start: number; end: number },
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

  for (const piece of projected.pieces) {
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
    // No real piece was touched, so there is nothing to copy and no construct
    // to complete — an all-synthetic selection maps to nothing, extents or
    // not.
    return null;
  }

  for (const extent of projected.extents ?? []) {
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

  return { start: sourceStart, end: sourceEnd };
}
