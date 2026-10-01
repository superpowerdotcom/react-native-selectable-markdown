import { IS_DEV } from '../dev';
import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { mapSelectionToSource, projectRun, selectionDisplayText } from '../selection/mapSelection';
import type { ProjectedRun, ProjectionGlyphs } from '../selection/mapSelection';
import type { EmbedLookup, RunSegment } from '../selection/runs';

/**
 * The two copy actions this library implements itself. Identifiers cross the
 * JS ↔ native boundary verbatim (`selectionActions` prop down, `action` event
 * field up), so they are part of the native contract in docs/SELECTION.md.
 *
 * The only ids either host can title on its own; any other id must carry a
 * title (see {@link SelectionActionSpec}).
 */
export type SelectionAction = 'copy-text' | 'copy-markdown';

/** A built-in id or a consumer's own; `string & {}` keeps the built-ins autocompleting. */
export type SelectionActionId = SelectionAction | (string & {});

/**
 * One menu item. `title` localises both platforms from JS; a consumer-defined
 * id must carry one, or the hosts drop the item.
 */
export interface SelectionActionSpec {
  /** The identifier echoed back in `SelectionCopyEvent.action`. Must not be
   * empty, and must not contain U+001F — see
   * {@link SELECTION_ACTION_SEPARATOR}. */
  id: SelectionActionId;
  /** The menu item's label. Omitted (or empty) means "use the host's own
   * localised default", which exists for the two built-in ids only. */
  title?: string;
}

/** A bare id, keeping the host's default title, or an `{ id, title }` pair. */
export type SelectionActionInput = SelectionActionId | SelectionActionSpec;

/** Default menu: both built-in actions, plain text first, each with the
 * host's own localised title. */
export const DEFAULT_SELECTION_ACTIONS: readonly SelectionAction[] =
  Object.freeze(['copy-text', 'copy-markdown'] as const);

/**
 * Separates id from title in one wire entry, keeping `selectionActions` the
 * ordered `string[]` the codegen spec asserts. Hosts split at the first
 * occurrence; an entry without one is a bare id, as older binaries read it.
 */
export const SELECTION_ACTION_SEPARATOR = '\u001f';

export function selectionActionId(action: SelectionActionInput): string {
  return typeof action === 'string' ? action : action.id;
}

/** The title of an action, or undefined when it defers to the host's own. */
export function selectionActionTitle(
  action: SelectionActionInput,
): string | undefined {
  if (typeof action === 'string') {
    return undefined;
  }
  const title = action.title;
  return title !== undefined && title.length > 0 ? title : undefined;
}

export function isBuiltInSelectionAction(id: string): id is SelectionAction {
  return id === 'copy-text' || id === 'copy-markdown';
}

/**
 * Shallow per-field equality, so an inline list does not re-render every run.
 * A bare id equals a spec carrying only that id: both encode identically.
 */
export function sameSelectionActionList(
  a: readonly SelectionActionInput[],
  b: readonly SelectionActionInput[],
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!sameSelectionAction(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

const NO_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({});

function fieldsOf(
  action: SelectionActionInput,
): Readonly<Record<string, unknown>> {
  return typeof action === 'string'
    ? NO_FIELDS
    : (action as unknown as Record<string, unknown>);
}

function sameSelectionAction(
  x: SelectionActionInput,
  y: SelectionActionInput,
): boolean {
  if (x === y) {
    return true;
  }
  // Through the accessor: a bare string entry has no `id` property.
  if (selectionActionId(x) !== selectionActionId(y)) {
    return false;
  }
  const xf = fieldsOf(x);
  const yf = fieldsOf(y);
  // An absent field and an `undefined` one compare equal; they encode identically.
  for (const key of Object.keys(xf)) {
    if (key !== 'id' && xf[key] !== yf[key]) {
      return false;
    }
  }
  for (const key of Object.keys(yf)) {
    if (key !== 'id' && xf[key] !== yf[key]) {
      return false;
    }
  }
  return true;
}

const warnedUntitledActions = new Set<string>();

/** DEV, once per id: the hosts drop an untitled consumer id without a trace. */
export function warnAboutUntitledSelectionActions(
  actions: readonly SelectionActionInput[],
): void {
  if (!IS_DEV) {
    return;
  }
  let untitled: string[] | null = null;
  for (const action of actions) {
    const id = selectionActionId(action);
    if (
      isBuiltInSelectionAction(id) ||
      selectionActionTitle(action) !== undefined ||
      warnedUntitledActions.has(id)
    ) {
      continue;
    }
    warnedUntitledActions.add(id);
    (untitled ??= []).push(id);
  }
  if (untitled === null) {
    return;
  }
  console.warn(
    '[react-native-selectable-markdown] selectionActions contains ' +
      `id(s) with no title (${untitled.join(', ')}), so the selection ` +
      'menu drops them: neither native host has a label for an ' +
      'identifier it does not know, and an untitled item would render ' +
      "blank. Write them as { id, title } — only 'copy-text' and " +
      "'copy-markdown' have a built-in localised title.",
  );
}

/**
 * One wire string per item, in menu order: `id` or `id + U+001F + title`.
 * Empty ids and ids containing the separator are dropped; an untitled consumer
 * id is not, so its DEV warning still fires.
 */
export function encodeSelectionActions(
  actions: readonly SelectionActionInput[],
): string[] {
  const encoded: string[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const id = selectionActionId(action);
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (id.includes(SELECTION_ACTION_SEPARATOR)) {
      continue;
    }
    const title = selectionActionTitle(action);
    encoded.push(
      title === undefined ? id : id + SELECTION_ACTION_SEPARATOR + title,
    );
  }
  return encoded;
}

/** The inverse of one {@link encodeSelectionActions} entry: the split both hosts perform. */
export function decodeSelectionAction(entry: string): SelectionActionSpec {
  const at = entry.indexOf(SELECTION_ACTION_SEPARATOR);
  if (at < 0) {
    return { id: entry };
  }
  const title = entry.slice(at + SELECTION_ACTION_SEPARATOR.length);
  return title.length > 0
    ? { id: entry.slice(0, at), title }
    : { id: entry.slice(0, at) };
}

/** Payload delivered to `onSelectionCopy` for any menu action. */
export interface SelectionCopyEvent {
  /** The invoked action's id, verbatim; an event carrying no action reports 'copy-markdown'. */
  action: SelectionActionId;
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
  /** The exact markdown source slice for the mapped span — which covers the
   * syntax of every construct the selection covers whole (a heading's `# `, a
   * list item's marker, a fence), not just the characters on screen. */
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
  /** DEV cross-check: warns when an id arrives that this menu never offered. Never changes the reported id. */
  actions?: readonly SelectionActionInput[];
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
 * - `markdown` is the exact source slice of the mapped span, which takes the
 *   syntax of any construct the selection covers whole (see `ProjectedExtent`).
 * - `action` passes through verbatim; an event with no action, from a binary
 *   older than the field, resolves to 'copy-markdown'.
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
  const plain = selectionDisplayText(projected, start, end);
  const action = resolveActionId(event.action, ctx?.actions);

  return { action, plain, markdown, span };
}

/** Never renames a non-empty id; an absent one means 'copy-markdown', from binaries older than the field. */
function resolveActionId(
  raw: string | undefined,
  configured: readonly SelectionActionInput[] | undefined,
): SelectionActionId {
  if (raw === undefined || raw.length === 0) {
    return 'copy-markdown';
  }
  if (IS_DEV && !isBuiltInSelectionAction(raw) && configured !== undefined) {
    let offered = false;
    for (let i = 0; i < configured.length; i += 1) {
      if (selectionActionId(configured[i]) === raw) {
        offered = true;
        break;
      }
    }
    if (!offered && !warnedUnknownActions.has(raw)) {
      warnedUnknownActions.add(raw);
      console.warn(
        `[react-native-selectable-markdown] selection action "${raw}" arrived ` +
          'from the host but is not in the selectionActions list this menu was ' +
          'built from. It is reported unchanged; if you did not add it, the ' +
          'native side and the JS bundle disagree about the menu.',
      );
    }
  }
  return raw;
}



const warnedUnknownActions = new Set<string>();

/**
 * The display slice with each embed placeholder replaced by its declared
 * text (or removed — see {@link SelectionCopyEvent.plain}). Substitutes
 * RIGHT-TO-LEFT so earlier placeholders' offsets are still valid while later
 * ones are being replaced; embeds are recorded in ascending placeholder
 * order, so a reversed walk is the descending one.
 */
export { selectionDisplayText } from '../selection/mapSelection';
