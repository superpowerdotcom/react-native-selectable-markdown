import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import { projectRun } from './mapSelection';
import type { ProjectedRun, ProjectionGlyphs } from './mapSelection';
import { segmentRuns } from './runs';
import type { ClassifyBlock, EmbedLookup } from './runs';

export interface CopyContext {
  engine?: Engine;
  /**
   * Should match the options the document was parsed with, so the reparse
   * of the slice sees the same syntax (tables, strikethrough, ...).
   */
  options?: EngineOptions;
  /**
   * Should match the marker glyphs the document was projected with, so
   * `plain` shows the same bullets the user saw on screen. Unset means the
   * projection defaults.
   */
  glyphs?: Partial<ProjectionGlyphs>;
  /**
   * Should match the embed lookup the document was segmented and projected
   * with, for the same reason as `glyphs` only more so: a claim replaces a
   * node's whole projection with one placeholder character, so a `plain`
   * built without the lookup projects the embedded node's markdown in full
   * and differs from the screen everywhere after the first claimed node.
   *
   * THE LOOKUP IS CALLED WITH NODES FROM THE REPARSED SLICE, not with the
   * nodes the document on screen was projected from — `plain` is computed by
   * parsing `markdown` again. A lookup that keys on node shape (kind, href,
   * literal) claims the same constructs either way; one that keys on node
   * identity claims nothing here.
   */
  embed?: EmbedLookup;
  /**
   * Should match the `classifyBlock` the document was segmented with, so the
   * slice is grouped into runs the way the screen groups it.
   *
   * IT IS THE WEAKEST OF THE FOUR, AND THAT IS WORTH SAYING. Runs are joined
   * with a blank line and a run's own blocks are separated by one, so
   * regrouping the same blocks does not change `plain` today — this is here
   * because everything that shapes a projection should be settable from one
   * place, and because the grouping is free to matter later. Like `embed`, it
   * is called with nodes from the REPARSED slice.
   *
   * Threading it also keeps the two callers of `segmentRuns` in an app
   * agreed: classification is memoized per block on the pair of callbacks it
   * was computed with (`classifyTopLevelBlock`), so two callers that disagree
   * about them each rewrite the other's entry for any block they share.
   * Nothing here shares blocks with the document on screen — the slice is
   * reparsed into fresh objects — but a caller who segments the LIVE document
   * without the callbacks does, and pays a full re-walk on the next delta.
   */
  classifyBlock?: ClassifyBlock;
}

/**
 * Builds the copy payload for a source span: `markdown` is the exact source
 * slice, and `plain` is that slice reparsed and reprojected — the display
 * text those characters would show on screen, with each embed placeholder
 * replaced by the text its claim declared.
 *
 * WHAT `markdown` IS, AND WHAT IT IS NOT. It is the source between two
 * offsets and nothing else. `mapSelectionToSource` returns the hull of the
 * pieces a selection touched, WIDENED to every construct the selection covers
 * whole: a block's own syntax projects no text — the `# ` of a heading, the
 * `> ` of a quote, a list item's marker, a fence, a table's pipes — so it
 * belongs to no piece, and without that widening a copied heading came back
 * as body text and a copied list as a paragraph. Sweep a whole list and the
 * markdown is a list; sweep a whole heading and the `# ` is there.
 *
 * IT IS STILL NOT A GUARANTEE OF RE-PARSE. A slice can mean something else
 * standing alone — a paragraph whose text is literally `## foo` re-parses as
 * a heading — a reference link or image points at a definition the slice does
 * not carry, and a selection that starts INSIDE a fenced block can still take
 * the closing fence with it and swallow what follows on paste. Which cases
 * hold and which do not is measured rather than asserted: the round-trip
 * census in conformance/selection/projection-oracle.test.ts copies every
 * block in the CommonMark corpus and counts. The copy menu
 * (`handleSelectionAction`) slices the same span, so the same holds there.
 *
 * The span is normalized and clamped into the document source. Copy must
 * never throw mid-gesture: if no engine can parse the slice, `plain`
 * degrades to the raw markdown text.
 */
export function buildCopyPayload(
  doc: ParsedDocument,
  span: SourceSpan,
  context?: CopyContext,
): { plain: string; markdown: string } {
  const start = clampOffset(Math.min(span.start, span.end), doc.source.length);
  const end = clampOffset(Math.max(span.start, span.end), doc.source.length);
  const markdown = doc.source.slice(start, end);

  let plain: string;
  try {
    plain = projectDocumentText(
      parseDocument(markdown, context?.options, context?.engine),
      context?.glyphs,
      context?.embed,
      context?.classifyBlock,
    );
  } catch {
    plain = markdown;
  }

  return { plain, markdown };
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(offset, 0), length);
}

function projectDocumentText(
  doc: ParsedDocument,
  glyphs?: Partial<ProjectionGlyphs>,
  embed?: EmbedLookup,
  classifyBlock?: ClassifyBlock,
): string {
  return segmentRuns(doc, { embed, classifyBlock })
    .map((run) => runText(projectRun(run, doc, { glyphs, embed })))
    .join('\n\n');
}

/**
 * A run's projected text with each embed placeholder (U+FFFC) replaced by the
 * text its claim declared, or removed when it declared none — the same
 * substitution `handleSelectionAction` applies to its own `plain`, so the two
 * copy paths agree about what an embedded card contributes to copied text.
 * Right to left, so the placeholders still to be replaced keep their offsets.
 */
function runText(run: ProjectedRun): string {
  const embeds = run.embeds;
  if (embeds === undefined) {
    return run.text;
  }
  let text = run.text;
  for (let i = embeds.length - 1; i >= 0; i -= 1) {
    const embed = embeds[i];
    text =
      text.slice(0, embed.start) +
      (embed.content.text ?? '') +
      text.slice(embed.end);
  }
  return text;
}
