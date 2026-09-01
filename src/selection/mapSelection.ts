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
  /** UTF-16 offsets of the placeholder into `ProjectedRun.text`;
   * `end === start + 1` always (one U+FFFC). */
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
 * projected or copied text themselves. */
export const EMBED_PLACEHOLDER = '￼';

// Deterministic display glyphs and separators. These are part of the
// projection contract: the native host renders exactly this text, and
// mapSelectionToSource assumes the piece list produced here.
//   - '\n\n' between sibling blocks (also inside blockquotes and list items)
//   - '\n'   between list items and between table rows
//   - '\t'   between table cells
//   - '• ' (bullet) before unordered list items
//   - '<n>. '  before ordered list items (n = list.start ?? 1, incrementing)
//   - '☑ ' / '☐ ' instead of the bullet for task list items
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
}

/**
 * Deterministic projection of a run to display text plus a piece table
 * mapping every display range back to source (or to null for synthetic
 * glyphs). Pieces tile the text exactly: piece i ends where piece i+1
 * starts, the first starts at 0 and the last ends at text.length.
 *
 * Real pieces whose display length equals their source length map
 * code-unit-for-code-unit; pieces whose display form differs from the
 * source (decoded entities, image alt text, multi-char break markers) keep
 * the whole construct span and are mapped as an indivisible unit.
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
  const projector = new RunProjector(doc.source, glyphs, options?.embed);
  run.blocks.forEach((block, index) => {
    if (index > 0) {
      projector.emit(BLOCK_SEPARATOR, null);
    }
    // `run.blocks` are direct children of the document — the only calls that
    // offer the embed lookup a top-level claim.
    projector.block(block, true);
  });
  return projector.finish();
}

class RunProjector {
  private text = '';
  private readonly pieces: RunPiece[] = [];
  private readonly marks: RunMark[] = [];
  private readonly embeds: ProjectedRunEmbed[] = [];
  /** The piece the last embed pushed, so `emit`'s linear merge can refuse to
   * grow it: an embed's piece is atomic BY CONTRACT, not by the length
   * inequality that usually keeps a piece indivisible — a claimed node whose
   * source span is exactly one code unit would otherwise read as linear and
   * merge into adjacent prose. */
  private embedPiece: RunPiece | null = null;
  /** Current list nesting depth while emitting (0 = not inside a list).
   * Carried onto each 'listItem' mark as its `level`. */
  private listDepth = 0;

  constructor(
    private readonly source: string,
    private readonly glyphs: ProjectionGlyphs,
    private readonly embedLookup?: EmbedLookup,
  ) {}

  finish(): ProjectedRun {
    // Outermost-first at each offset: marks are pushed as their construct
    // *closes*, so the raw order is innermost-first and a consumer applying
    // them in sequence would let the outer construct overwrite the inner one.
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
    return projected;
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
   * directly too: `marked()` exists for ranges a body emits, and this range
   * is known outright.
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

  /**
   * Runs `body` and records the text it emitted as one mark. Empty ranges
   * are dropped: a zero-width mark is not a construct anyone can style, and
   * it would make every list item's bullet-only entry noise in the list.
   *
   * `level` and `href` stay off the mark when absent rather than riding along
   * as `undefined`: marks are compared with deep equality in tests and
   * serialized in debugging output, and a key that is present-but-undefined
   * is a difference both of those see.
   */
  private marked(kind: MarkKind, body: () => void, level?: number, href?: string): void {
    const start = this.text.length;
    body();
    const end = this.text.length;
    if (end <= start) return;
    const mark: RunMark = { kind, start, end };
    if (level !== undefined) mark.level = level;
    if (href !== undefined) mark.href = href;
    this.marks.push(mark);
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

  block(node: Block, topLevel = false): void {
    if (this.tryEmbed(node, topLevel)) {
      return;
    }
    switch (node.kind) {
      case 'paragraph':
        this.inlines(node.children);
        return;
      case 'heading':
        this.marked('heading', () => this.inlines(node.children), node.level);
        return;
      case 'blockquote':
        this.marked('blockquote', () => this.blocks(node.children));
        return;
      case 'list': {
        const base = node.start ?? 1;
        // Depth rides on each item's 'listItem' mark. NO indent glyphs are
        // emitted — spaces here would land in every copied selection, and no
        // amount of them could hang-indent a wrapped line. Indentation is the
        // view layer's job (runDecorations.ts), driven by these marks.
        this.listDepth += 1;
        const depth = this.listDepth;
        node.items.forEach((item, index) => {
          if (index > 0) {
            this.emit(ITEM_SEPARATOR, null);
          }
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
          this.marked(
            'listItem',
            () => {
              this.marked('listMarker', () => this.emit(glyph, null));
              this.blocks(item.children, ITEM_SEPARATOR);
            },
            depth,
          );
        });
        this.listDepth -= 1;
        return;
      }
      case 'listItem':
        // ITEM_SEPARATOR, matching the `listItem` renderer: a nested sublist
        // sits directly under its parent bullet, not after a blank line.
        this.blocks(node.children, ITEM_SEPARATOR);
        return;
      case 'codeBlock':
        this.marked('codeBlock', () => this.literal(node, node.literal));
        return;
      case 'table': {
        // The outer 'table' mark wraps the whole emission so the view layer
        // knows the table's full extent (border box, row rules, column
        // alignment — see runDecorations.ts). Marks sort outermost-first, so
        // it precedes the 'tableHeader' mark that shares its start.
        this.marked('table', () => {
          this.marked('tableHeader', () => this.block(node.header));
          for (const row of node.rows) {
            this.emit(ROW_SEPARATOR, null);
            this.block(row);
          }
        });
        return;
      }
      case 'tableRow':
        node.cells.forEach((cell, index) => {
          if (index > 0) {
            this.emit(CELL_SEPARATOR, null);
          }
          this.inlines(cell.children);
        });
        return;
      case 'tableCell':
        this.inlines(node.children);
        return;
      case 'thematicBreak':
        // Contributes no selectable text — a rule is chrome, and injecting a
        // glyph for it would put characters in the copy that the author never
        // wrote. What it leaves behind instead is a ZERO-LENGTH mark at this
        // offset (pushed directly: `marked()` drops empty ranges by design),
        // which is how the view layer knows where to draw the rule. The
        // surrounding BLOCK_SEPARATORs give it a blank line to be drawn in.
        this.marks.push({
          kind: 'thematicBreak',
          start: this.text.length,
          end: this.text.length,
        });
        return;
      case 'htmlBlock':
        // Marked 'html' like the inline `htmlSpan` case, so a raw HTML block
        // flowing through the native host renders in the same muted mono the
        // fallback renderer gives it, instead of as bare body text.
        this.marked('html', () => this.literal(node, node.literal));
        return;
    }
  }

  /**
   * `separator` is a parameter because a list item's child blocks are joined
   * with ONE newline, not two, and that stopped being cosmetic the moment a run
   * became the thing on screen. The built-in `listItem` renderer has always
   * joined with '\n' (`joinChildBlocks`), while this projected '\n\n' — so a
   * bullet with a nested sublist read as `• foo`, a blank line, `• bar`. Nobody
   * saw it while the renderers drew the document; now the projection does.
   */
  private blocks(children: Block[], separator = BLOCK_SEPARATOR): void {
    children.forEach((child, index) => {
      if (index > 0) {
        this.emit(separator, null);
      }
      this.block(child);
    });
  }

  private inlines(children: Inline[]): void {
    for (const child of children) {
      this.inline(child);
    }
  }

  private inline(node: Inline): void {
    if (this.tryEmbed(node)) {
      return;
    }
    switch (node.kind) {
      case 'text':
        this.literal(node, node.value);
        return;
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'underline':
      case 'spoiler':
        this.marked(node.kind, () => this.inlines(node.children));
        return;
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
          this.inlines(node.children);
        } else if (node.blocked) {
          this.marked('blockedLink', () => this.inlines(node.children), undefined, node.href);
        } else {
          this.marked('link', () => this.inlines(node.children), undefined, node.href);
        }
        return;
      case 'codeSpan':
        this.marked('code', () => this.literal(node, node.value));
        return;
      case 'image':
        this.literal(node, node.alt);
        return;
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
        this.marked(
          'link',
          () => this.literal(node, typed || node.href),
          undefined,
          node.href,
        );
        return;
      }
      case 'hardBreak':
        // An explicit break the author asked for (two trailing spaces, or a
        // backslash), so it projects as one.
        this.emit('\n', this.realSpan(node));
        return;
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
        this.emit(' ', this.realSpan(node));
        return;
      case 'math':
        this.marked('math', () => this.literal(node, node.value));
        return;
      case 'htmlSpan':
        this.marked('html', () => this.literal(node, node.literal));
        return;
    }
  }

  /**
   * Emits display text for a node whose rendered form may differ from its
   * source. If the display text occurs verbatim inside the node's source
   * slice (plain text, code span content, fenced code body) the piece is
   * pinned to that exact sub-span so offsets map 1:1; otherwise the piece
   * keeps the whole node span and maps as a unit.
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
    const raw = this.source.slice(span.start, span.end);
    const at = raw.indexOf(display);
    if (at >= 0) {
      this.emit(display, {
        start: span.start + at,
        end: span.start + at + display.length,
      });
      return;
    }
    this.emit(display, span);
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
 * Maps a display-text selection back to a source span. The selection is
 * normalized (swapped if reversed) and clamped to the projected text; only
 * real pieces contribute — synthetic glyphs at the edges are skipped, and
 * synthetics strictly inside the selection are bridged by the enclosing
 * source range. Returns null when the selection is empty, out of range, or
 * touches only synthetic glyphs.
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
    return null;
  }
  return { start: sourceStart, end: sourceEnd };
}
