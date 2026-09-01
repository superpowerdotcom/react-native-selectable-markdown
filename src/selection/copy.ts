import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import { projectRun } from './mapSelection';
import type { ProjectionGlyphs } from './mapSelection';
import { segmentRuns } from './runs';

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
}

/**
 * Builds the copy payload for a source span: `markdown` is the exact source
 * slice; `plain` is the projected display text of that slice reparsed. For
 * any selection inside real (non-synthetic) pieces, `markdown` re-parses to
 * the same visible text as the selection.
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
): string {
  return segmentRuns(doc)
    .map((run) => projectRun(run, doc, { glyphs }).text)
    .join('\n\n');
}
