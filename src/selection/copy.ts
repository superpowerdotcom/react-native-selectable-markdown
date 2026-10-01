import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import { projectRun, selectionDisplayText } from './mapSelection';
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
   * Should match the embed lookup the document was projected with, or `plain`
   * shows claimed nodes' text where the screen shows placeholders. It is called
   * with nodes from the reparsed slice, so a lookup keyed on node identity
   * claims nothing.
   */
  embed?: EmbedLookup;
  /**
   * Should match the `classifyBlock` the document was segmented with. Like
   * `embed`, it is called with nodes from the reparsed slice.
   */
  classifyBlock?: ClassifyBlock;
}

/**
 * Builds the copy payload for a source span: `markdown` is the exact source
 * slice, and `plain` is that slice reparsed and reprojected, with each embed
 * placeholder replaced by the text its claim declared.
 *
 * `markdown` is not guaranteed to re-parse to what the screen showed: a slice
 * can mean something else standing alone, or lose a reference definition.
 * conformance/selection/projection-oracle.test.ts measures which cases hold.
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

function runText(run: ProjectedRun): string {
  return selectionDisplayText(run, 0, run.text.length);
}
