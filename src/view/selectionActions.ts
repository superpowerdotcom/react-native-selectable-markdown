import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { mapSelectionToSource, projectRun } from '../selection/mapSelection';
import type { ProjectedRun, ProjectionGlyphs } from '../selection/mapSelection';
import type { EmbedLookup, RunSegment } from '../selection/runs';

/**
 * The copy actions the selection menu can offer. Identifiers cross the JS ↔
 * native boundary verbatim (`selectionActions` prop down, `action` event
 * field up), so they are part of the native contract in docs/SELECTION.md.
 */
export type SelectionAction = 'copy-text' | 'copy-markdown';

/** Default menu: both actions, plain text first. */
export const DEFAULT_SELECTION_ACTIONS: readonly SelectionAction[] =
  Object.freeze(['copy-text', 'copy-markdown'] as const);

/** Payload delivered to `onSelectionCopy` for either menu action. */
export interface SelectionCopyEvent {
  /** Which menu action the user invoked. */
  action: SelectionAction;
  /**
   * The projected display text the user visually selected — exactly
   * `ProjectedRun.text.slice(start, end)`, synthetic glyphs (bullets,
   * separators) included — with ONE amendment: each embed placeholder
   * (U+FFFC) inside the slice is replaced by that embed's declared
   * `EmbedContent.text`, or removed when none was declared. Without embeds
   * this is byte-for-byte what the platform's own Copy would yield; with
   * them, the system Copy still carries the raw placeholder (the platform's
   * native behaviour for attachments) while this payload carries the text
   * the consumer said the card stands for.
   */
  plain: string;
  /** The exact markdown source slice for the mapped span. */
  markdown: string;
  /** The selection mapped back to UTF-16 offsets in the original source. */
  span: SourceSpan;
}

export interface SelectionActionContext {
  /**
   * An already-computed projection to reuse (the view memoizes one per run).
   * Must correspond to `run` AND to the glyphs the run is displayed with:
   * given the same glyphs the projection is deterministic, so passing it
   * changes cost, never the result — but a projection built with different
   * glyphs than the on-screen text has different offsets everywhere.
   */
  projected?: ProjectedRun;
  /**
   * Marker-glyph overrides the run was projected with (`theme.glyphs`).
   * The native event's offsets are into the glyph-aware on-screen text, so
   * when `projected` is not supplied the fallback projection must be built
   * with the same glyphs or every offset after the first list marker shifts.
   * Unset means the projection defaults.
   */
  glyphs?: Partial<ProjectionGlyphs>;
  /**
   * The embed lookup the run was segmented and projected with. The same rule
   * as `glyphs`, for the same reason: an embed claim replaces a node's whole
   * projection with one placeholder character, so a fallback projection built
   * without it has different offsets everywhere after the first claimed node
   * — and would silently map the user's selection through the wrong piece
   * table. `<SelectableMarkdown>` threads this for you; hand-rolled callers
   * that pass an `embed` prop must too.
   */
  embed?: EmbedLookup;
}

/**
 * Pure core of the selection-menu flow: maps a native
 * `{start, end, action}` event (offsets into the run's projected display
 * text) through `mapSelectionToSource` and returns the `onSelectionCopy`
 * payload.
 *
 * - `plain` is the display slice the user visually selected (see
 *   {@link SelectionCopyEvent.plain}), not a reparse of the source slice —
 *   the two can differ around list glyphs and block separators.
 * - `markdown` is the exact source slice of the mapped span.
 * - Unknown or missing `action` values normalize to 'copy-markdown': the
 *   only custom menu item older native binaries emit (version skew) is
 *   "Copy Markdown", and it predates the `action` field.
 *
 * Returns null (no payload, nothing to copy) when the selection is empty,
 * out of range, or covers only synthetic glyphs. Never throws mid-gesture.
 */
export function handleSelectionAction(
  doc: ParsedDocument,
  run: RunSegment,
  event: { start: number; end: number; action?: string },
  ctx?: SelectionActionContext,
): SelectionCopyEvent | null {
  if (!Number.isFinite(event.start) || !Number.isFinite(event.end)) {
    return null;
  }
  const projected =
    ctx?.projected ??
    projectRun(run, doc, { glyphs: ctx?.glyphs, embed: ctx?.embed });
  const start = Math.max(0, Math.min(event.start, event.end));
  const end = Math.min(
    projected.text.length,
    Math.max(event.start, event.end),
  );
  if (start >= end) {
    return null;
  }

  const span = mapSelectionToSource(projected, { start, end });
  if (!span) {
    return null;
  }

  // A PURE SLICE, DELIBERATELY, AND NOT `buildCopyPayload`.
  //
  // `buildCopyPayload` returns the same `markdown` — it slices `doc.source`
  // too — but it also builds a `plain` by re-parsing that slice through the
  // engine and re-projecting every run of the result. This path has never
  // used that `plain`: it computes its own from the projection it already
  // holds, which is the display text the user actually selected rather than
  // a reparse of the source under it. Calling through meant a full md4c
  // parse plus a full resegmentation on every copy gesture, discarded one
  // line later — on a select-all over a long answer, a second parse of the
  // whole document per tap.
  //
  // `buildCopyPayload` stays public for callers that do want both halves.
  const markdown = doc.source.slice(
    Math.max(0, Math.min(span.start, span.end)),
    Math.min(doc.source.length, Math.max(span.start, span.end)),
  );
  const plain = substituteEmbeds(projected, start, end);
  const action: SelectionAction =
    event.action === 'copy-text' ? 'copy-text' : 'copy-markdown';

  return { action, plain, markdown, span };
}

/**
 * The display slice with each embed placeholder replaced by its declared
 * text (or removed — see {@link SelectionCopyEvent.plain}). Substitutes
 * RIGHT-TO-LEFT so earlier placeholders' offsets are still valid while later
 * ones are being replaced; embeds are recorded in ascending placeholder
 * order, so a reversed walk is the descending one.
 */
function substituteEmbeds(
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
