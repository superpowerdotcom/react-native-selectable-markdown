import type { ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { mapSelectionToSource, projectRun } from '../selection/mapSelection';
import type { ProjectedRun, ProjectionGlyphs } from '../selection/mapSelection';
import type { EmbedLookup, RunSegment } from '../selection/runs';

/**
 * The two copy actions this library implements itself. Identifiers cross the
 * JS ↔ native boundary verbatim (`selectionActions` prop down, `action` event
 * field up), so they are part of the native contract in docs/SELECTION.md.
 *
 * They are also the only two ids either host can TITLE on its own: each has a
 * localisable built-in title there (iOS `NSLocalizedString("Copy Text")`,
 * Android `R.string.selectable_markdown_copy_text`), which is what a bare
 * string id in `selectionActions` resolves to. Any other id is a
 * consumer-defined action and must bring its own title — see
 * {@link SelectionActionSpec}.
 */
export type SelectionAction = 'copy-text' | 'copy-markdown';

/**
 * Any menu-item identifier: one of the two built-ins, or a consumer's own.
 *
 * Spelled as a union with `string & {}` rather than as plain `string` so an
 * editor still completes 'copy-text' and 'copy-markdown' while
 * `'share-quote'` needs no cast.
 */
export type SelectionActionId = SelectionAction | (string & {});

/**
 * One menu item, with the title JS wants it to carry.
 *
 * `title` IS WHAT MAKES THE MENU LOCALISABLE, and it is the only channel that
 * localises both platforms. Without it a built-in id falls back to the host's
 * own string — `NSLocalizedString` against `Bundle.main` on iOS, `R.string`
 * on Android — which an app can override, but only per platform and only in
 * the platform's own resource format. Passing the title from JS puts both
 * menus in whatever i18n library the app already uses.
 *
 * A consumer-defined id (anything but the two built-ins) MUST carry a title:
 * neither host has a string for an id it does not know, and an untitled item
 * is dropped rather than rendered blank. `<SelectableMarkdown>` warns about
 * that shape in DEV.
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

/** What `selectionActions` accepts per entry: a bare id — which keeps the
 * host's default title, exactly as this prop behaved before titles existed —
 * or an `{ id, title }` pair. */
export type SelectionActionInput = SelectionActionId | SelectionActionSpec;

/** Default menu: both built-in actions, plain text first, each with the
 * host's own localised title. */
export const DEFAULT_SELECTION_ACTIONS: readonly SelectionAction[] =
  Object.freeze(['copy-text', 'copy-markdown'] as const);

/**
 * The character that separates an id from its title in one wire entry.
 *
 * THE WIRE STAYS AN ORDERED `string[]`, WHICH IS WHY A SEPARATOR EXISTS AT
 * ALL. `selectionActions` is `ReadonlyArray<string>` in the codegen spec and
 * therefore a `std::vector<std::string>` in the generated props — ordered,
 * which the menu needs (scripts/check-codegen.mjs asserts exactly that, and
 * says why an array of a string union cannot replace it). An array of
 * `{id, title}` objects would have changed that type, and a parallel
 * `selectionActionTitles` array would have made a desynchronised pair
 * expressible. Packing both fields into the one string keeps the asserted
 * type, keeps id and title inseparable, and needs no second prop.
 *
 * U+001F (INFORMATION SEPARATOR ONE) because it is a control character no
 * menu title can legitimately contain and no identifier in this library uses.
 * Both hosts split at the FIRST occurrence — everything after it is the
 * title, verbatim — so a title that somehow contains one survives intact; an
 * ID containing one could not round-trip, so {@link encodeSelectionActions}
 * drops that entry instead of sending a truncated identifier.
 *
 * An entry with no separator is a bare id, which is the pre-title wire format
 * unchanged: an older native binary reads it exactly as it always did.
 */
export const SELECTION_ACTION_SEPARATOR = '\u001f';

/** The identifier of an action however it was written. */
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

/** Whether an id is one the hosts can title without help from JS. */
export function isBuiltInSelectionAction(id: string): id is SelectionAction {
  return id === 'copy-text' || id === 'copy-markdown';
}

/**
 * Value comparison over a `selectionActions` list, entry by entry.
 *
 * WHY A VALUE COMPARISON AT ALL. A spec is an object literal, so the
 * documented inline form — `[{ id: 'share', title: t('share') }]` — is a fresh
 * array of fresh objects on every render, and a reference test would re-render
 * every run in the document each time. This is what makes writing it inline
 * free.
 *
 * EVERY FIELD, NOT A NAMED PAIR. It used to compare `id` and `title` and
 * nothing else, which meant any field added to {@link SelectionActionSpec}
 * later would be silently invisible to the memo — a menu that never updated
 * when the only thing that changed was the new field. Comparing the fields the
 * objects actually carry keeps the comparison correct by default: a field this
 * version has never heard of still fails it.
 *
 * The comparison is SHALLOW (`===` per field), which is the right depth for a
 * shape whose fields are strings. A field holding an object literal would
 * compare unequal every render and cost a re-render, not a stale menu — the
 * safe direction.
 *
 * A bare id and a spec with the same id and no other fields are EQUAL, because
 * {@link encodeSelectionActions} sends the identical wire entry for both.
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

/** No fields at all — what a bare-string entry compares as. */
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
  // `id` is compared through the accessor rather than as a field, because it
  // is spelled two ways: a bare string entry has no `id` property at all.
  if (selectionActionId(x) !== selectionActionId(y)) {
    return false;
  }
  const xf = fieldsOf(x);
  const yf = fieldsOf(y);
  // Both directions, so a field present on one side only is caught whichever
  // side carries it. A missing field reads as `undefined`, which is what
  // `title: undefined` means too — and they encode identically.
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

/** Consumer ids already named by {@link warnAboutUntitledSelectionActions};
 * warn-once PER ID, the same discipline as `warnedUnknownActions` below. */
const warnedUntitledActions = new Set<string>();

/**
 * DEV: names every consumer-defined id in `actions` that carries no title.
 *
 * THE SHAPE IT CATCHES FAILS SILENTLY. Neither host has a string for an id it
 * does not know, so an untitled consumer id is dropped rather than rendered
 * blank — the menu simply comes up one item short, with nothing on screen or
 * in a log to say why. The two built-in ids are exempt: a bare 'copy-text' /
 * 'copy-markdown' is the documented way to take the host's own localised
 * title.
 *
 * ONCE PER ID, NOT ONCE PER RUNTIME. This is called from a render, so it has
 * to say each thing once — but the unit of "each thing" is the id, not the
 * warning: a per-runtime latch meant the first bad document silenced every
 * later one, so a transcript whose second message offered a different untitled
 * action got no warning at all. Per id is also what
 * {@link SelectionActionContext.actions}'s cross-check already does, so the
 * one feature no longer has two disciplines.
 */
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
 * The `selectionActions` prop as both hosts read it: one string per item, in
 * menu order, either `id` or `id + U+001F + title`.
 *
 * Entries that could never render are dropped here rather than sent: an empty
 * id, and an id containing the separator (which would arrive truncated). A
 * consumer-defined id with no title is NOT dropped — the hosts drop it, and
 * dropping it twice would only hide the DEV warning that names the mistake.
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

/**
 * The inverse of one {@link encodeSelectionActions} entry — the same split
 * both hosts perform, expressed once where it can be unit-tested.
 */
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
  /**
   * Which menu action the user invoked — a built-in id, or the id of one of
   * the consumer's own actions, verbatim. Only an event that carries NO
   * action at all is reported as 'copy-markdown'; see the note on
   * {@link handleSelectionAction}.
   */
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
  /**
   * The `selectionActions` list the run's menu was built from, as a DEV
   * cross-check.
   *
   * IT DOES NOT DECIDE THE REPORTED ID any more. Every non-empty `action` off
   * the wire is reported verbatim — see `resolveActionId` for why renaming
   * one can only ever be wrong — so a consumer id survives whether or not
   * this is threaded. What the list buys is a DEV warning when an id arrives
   * that this menu never offered, which is the shape a JS bundle and a native
   * binary that disagree about the menu take.
   *
   * Leave it unset and nothing is checked. `<SelectableMarkdown>` threads its
   * own `selectionActions` prop here.
   */
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
 * - `markdown` is the exact source slice of the mapped span — and the span is
 *   construct-aware: a selection covering a whole heading, list, quote, fence
 *   or link takes that construct's own syntax with it, which no piece carries
 *   (see `ProjectedExtent`). Sweep a whole list and the markdown is a list.
 * - `action` is passed through verbatim, built-in ids and consumer-defined
 *   ids alike, so 'share-quote' reaches the handler as 'share-quote' whether
 *   or not the caller threaded `ctx.actions`. An event carrying NO action is
 *   the one case that resolves to something else — 'copy-markdown' — because
 *   the native binaries that emit no action predate the field and their sole
 *   custom item was "Copy Markdown". `ctx.actions` is now only a DEV
 *   cross-check; see {@link SelectionActionContext.actions}.
 *
 * Returns null (no payload, nothing to copy) when the selection is empty,
 * out of range, or covers only synthetic glyphs. Never throws mid-gesture.
 *
 * A CONSUMER ACTION STILL GETS THE FULL PAYLOAD, which is the point: the
 * mapping work — display slice, source span, source slice — is identical for
 * every item on the menu, so 'share-quote' arrives with the same `plain`,
 * `markdown` and `span` "Copy Markdown" would have, and the handler decides
 * what to do with them.
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

/**
 * The event's `action`, verbatim — 'copy-markdown' only when the event
 * carries no action at all.
 *
 * AN ID IS NEVER RENAMED. The empty case is the whole of the version skew
 * this has to absorb: a native binary older than the `action` field emits
 * nothing there, and its one custom item was "Copy Markdown", so an absent id
 * means that and there is no other candidate. A NON-EMPTY id, on the other
 * hand, was put there by a menu item that exists, and the only thing a rename
 * can achieve is to hand a consumer's own action ('share-quote') to their
 * copy-markdown branch — a silent wrong answer, where passing it through
 * gives them an id they can recognise or ignore.
 *
 * This used to normalize any id the offered list did not contain, which meant
 * a hand-rolled caller who built the menu but did not thread
 * {@link SelectionActionContext.actions} got their own actions renamed. The
 * list is now a DEV cross-check instead: it says an id arrived that this menu
 * never offered, and says it once.
 */
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

const IS_DEV = typeof __DEV__ === 'boolean' ? __DEV__ : true;

/** Unknown action ids already named in DEV; warn-once per id, the same
 * discipline as the unknown-renderer warning in `renderers.tsx`. */
const warnedUnknownActions = new Set<string>();

/**
 * The display slice with each embed placeholder replaced by its declared
 * text (or removed — see {@link SelectionCopyEvent.plain}). Substitutes
 * RIGHT-TO-LEFT so earlier placeholders' offsets are still valid while later
 * ones are being replaced; embeds are recorded in ascending placeholder
 * order, so a reversed walk is the descending one.
 *
 * EXPORTED BECAUSE TWO EVENTS NEED THE SAME ANSWER. It is what
 * `SelectionCopyEvent.plain` is, and it is also what a live selection-change
 * report has to carry — and "the text the user selected" is exactly the sort
 * of definition that drifts when it exists twice: the placeholder rule alone
 * (substitute the declared text, or drop the character) is invisible in the
 * output and impossible to notice going wrong.
 *
 * `start`/`end` are UTF-16 offsets into `projected.text`, and the caller is
 * expected to have clamped them — an out-of-range pair yields a short slice
 * rather than throwing, the same as `String.prototype.slice`.
 */
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
