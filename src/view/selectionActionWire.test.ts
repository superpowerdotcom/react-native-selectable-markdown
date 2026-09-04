import type { ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { segmentRuns } from '../selection/runs';
import type { RunSegment } from '../selection/runs';
import {
  DEFAULT_SELECTION_ACTIONS,
  SELECTION_ACTION_SEPARATOR,
  decodeSelectionAction,
  encodeSelectionActions,
  handleSelectionAction,
  isBuiltInSelectionAction,
  selectionActionId,
  selectionActionTitle,
} from './selectionActions';

/*
 * The selection menu's WIRE FORMAT and its title/id split.
 *
 * `selectionActions` is one ordered `std::vector<std::string>` on both hosts
 * — scripts/check-codegen.mjs pins that type and says why it cannot become an
 * array of objects — so a menu item's title travels inside the same string as
 * its identifier, separated by U+001F. Both native hosts implement that split
 * (SelectableRunHostView.swift `parseSelectionAction`,
 * SelectableRunHostView.kt `parseSelectionAction`), and neither is reachable
 * from jest. What IS reachable is the encoder they decode and the decoder
 * that mirrors them, so this file pins the format itself: get it wrong here
 * and a title arrives as part of an identifier, which shows up as a menu item
 * that silently vanishes on both platforms.
 *
 * The second half is the id round-trip: an action a consumer defined must
 * reach `onSelectionCopy` as ITSELF, while an id no menu offered must still
 * normalize to 'copy-markdown' (version skew — an older binary's only custom
 * item predates the `action` field). The offered list is the only thing that
 * tells those two apart, which is why `ctx.actions` exists.
 */

/** Parses `source` and returns the document plus its single run. */
function docWithRun(source: string): { doc: ParsedDocument; run: RunSegment } {
  const doc = parseDocument(source);
  const runs = segmentRuns(doc);
  expect(runs).toHaveLength(1);
  return { doc, run: runs[0] };
}

linkNativeEngineAsDefault();

describe('selectionActions wire format', () => {
  test('a bare id encodes to itself, which is the pre-title wire format', () => {
    // The whole backward-compatibility story rests on this: the default menu
    // must reach an older native binary byte-for-byte as it always did.
    expect(encodeSelectionActions(DEFAULT_SELECTION_ACTIONS)).toEqual([
      'copy-text',
      'copy-markdown',
    ]);
    expect(encodeSelectionActions(['share-quote'])).toEqual(['share-quote']);
  });

  test('an { id, title } pair packs into one string around U+001F', () => {
    expect(
      encodeSelectionActions([
        { id: 'copy-text', title: 'Texte' },
        { id: 'copy-markdown', title: 'Markdown' },
      ]),
    ).toEqual([
      `copy-text${SELECTION_ACTION_SEPARATOR}Texte`,
      `copy-markdown${SELECTION_ACTION_SEPARATOR}Markdown`,
    ]);
    // Spelled as an escape so the assertion survives anything that eats
    // control characters on the way through.
    expect(SELECTION_ACTION_SEPARATOR).toBe('\u001f');
  });

  test('an empty title is the same as no title: take the host default', () => {
    // Not a special case in the hosts either — both treat an empty tail as
    // "no title sent" and fall back to their own string.
    expect(encodeSelectionActions([{ id: 'copy-text', title: '' }])).toEqual([
      'copy-text',
    ]);
  });

  test('order is the menu order and is preserved exactly', () => {
    expect(
      encodeSelectionActions([
        'copy-markdown',
        { id: 'share', title: 'Share' },
        'copy-text',
      ]),
    ).toEqual([
      'copy-markdown',
      `share${SELECTION_ACTION_SEPARATOR}Share`,
      'copy-text',
    ]);
  });

  test('an entry that could never round-trip is dropped, not truncated', () => {
    // An empty id has nothing to report back; an id containing the separator
    // would arrive at the host split in the wrong place, so the item would
    // render under a bogus title and emit a bogus identifier. Both are
    // dropped here rather than sent — and dropping one must not disturb the
    // items around it.
    expect(
      encodeSelectionActions([
        'copy-text',
        '',
        { id: '', title: 'Nameless' },
        { id: `bad${SELECTION_ACTION_SEPARATOR}id`, title: 'Bad' },
        'copy-markdown',
      ]),
    ).toEqual(['copy-text', 'copy-markdown']);
  });

  test('decode is the exact inverse, splitting at the FIRST separator', () => {
    // The hosts split at the first occurrence, so a title containing the
    // separator survives intact rather than being cut short.
    expect(decodeSelectionAction('copy-text')).toEqual({ id: 'copy-text' });
    expect(
      decodeSelectionAction(`share${SELECTION_ACTION_SEPARATOR}Share this`),
    ).toEqual({ id: 'share', title: 'Share this' });
    expect(
      decodeSelectionAction(
        `share${SELECTION_ACTION_SEPARATOR}a${SELECTION_ACTION_SEPARATOR}b`,
      ),
    ).toEqual({
      id: 'share',
      title: `a${SELECTION_ACTION_SEPARATOR}b`,
    });
    // A trailing separator with nothing after it is "no title", matching the
    // empty-title encode above.
    expect(
      decodeSelectionAction(`copy-text${SELECTION_ACTION_SEPARATOR}`),
    ).toEqual({ id: 'copy-text' });
  });

  test('every encoded entry decodes back to the id and title it was written with', () => {
    const actions = [
      'copy-text',
      { id: 'copy-markdown', title: 'Copier le Markdown' },
      { id: 'share-quote', title: 'Partager' },
    ] as const;
    const decoded = encodeSelectionActions([...actions]).map(
      decodeSelectionAction,
    );
    expect(decoded.map((entry) => entry.id)).toEqual([
      'copy-text',
      'copy-markdown',
      'share-quote',
    ]);
    expect(decoded.map((entry) => entry.title)).toEqual([
      undefined,
      'Copier le Markdown',
      'Partager',
    ]);
  });

  test('the id/title accessors read both spellings', () => {
    expect(selectionActionId('copy-text')).toBe('copy-text');
    expect(selectionActionId({ id: 'share' })).toBe('share');
    expect(selectionActionTitle('copy-text')).toBeUndefined();
    expect(selectionActionTitle({ id: 'share' })).toBeUndefined();
    expect(selectionActionTitle({ id: 'share', title: 'Share' })).toBe('Share');
  });

  test('only the two ids the hosts can title on their own are built in', () => {
    // This predicate is what decides whether an untitled entry is a mistake
    // worth a DEV warning or the documented way to take the host's own
    // localised string.
    expect(isBuiltInSelectionAction('copy-text')).toBe(true);
    expect(isBuiltInSelectionAction('copy-markdown')).toBe(true);
    expect(isBuiltInSelectionAction('share-quote')).toBe(false);
    expect(isBuiltInSelectionAction('')).toBe(false);
  });
});

describeNative('handleSelectionAction action identity', () => {
  test('a consumer action the menu offered arrives as itself, with the full payload', () => {
    const { doc, run } = docWithRun('Hello **bold** world.');
    const payload = handleSelectionAction(
      doc,
      run,
      { start: 6, end: 10, action: 'share-quote' },
      { actions: [{ id: 'share-quote', title: 'Share' }] },
    );
    expect(payload?.action).toBe('share-quote');
    // The mapping work is identical for every menu item — that is the point
    // of routing consumer actions through here rather than past it. Both
    // halves are exactly what 'copy-markdown' would have produced for the
    // same sweep, emphasis syntax and all (the span is construct-aware).
    expect(payload?.plain).toBe('bold');
    expect(payload?.markdown).toBe('**bold**');
  });

  test('a bare-string entry in ctx.actions counts as offered', () => {
    const { doc, run } = docWithRun('Hello world.');
    const payload = handleSelectionAction(
      doc,
      run,
      { start: 0, end: 5, action: 'share-quote' },
      { actions: ['share-quote'] },
    );
    expect(payload?.action).toBe('share-quote');
  });

  test('an id the menu did not offer is reported unchanged, not renamed', () => {
    // This used to normalize to 'copy-markdown' whenever `ctx.actions` did not
    // account for the id — including when it was not threaded at all, which is
    // the ordinary shape for a caller driving `RunHost` itself. That silently
    // handed a consumer's own action to their copy-markdown branch. The id is
    // now passed through; the offered list is a DEV cross-check (it warns,
    // once per id, that the menu and the binary disagree).
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { doc, run } = docWithRun('Hello world.');
      const offeredSomethingElse = handleSelectionAction(
        doc,
        run,
        { start: 0, end: 5, action: 'share-quote' },
        { actions: ['copy-text', { id: 'other', title: 'Other' }] },
      );
      const offeredNothing = handleSelectionAction(
        doc,
        run,
        { start: 0, end: 5, action: 'share-quote' },
        { actions: [] },
      );
      const noContext = handleSelectionAction(doc, run, {
        start: 0,
        end: 5,
        action: 'share-quote',
      });
      expect(offeredSomethingElse?.action).toBe('share-quote');
      expect(offeredNothing?.action).toBe('share-quote');
      expect(noContext?.action).toBe('share-quote');
      // Only the two calls that said what the menu offered can warn, and the
      // warning is once per id for the whole runtime.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('an event carrying NO action is the one case that resolves', () => {
    // Version skew, and the only shape of it left: a binary older than the
    // `action` field emits nothing there, and its sole custom item was "Copy
    // Markdown".
    const { doc, run } = docWithRun('Hello world.');
    expect(
      handleSelectionAction(doc, run, { start: 0, end: 5 })?.action,
    ).toBe('copy-markdown');
    expect(
      handleSelectionAction(doc, run, { start: 0, end: 5, action: '' })?.action,
    ).toBe('copy-markdown');
  });

  test('the built-in ids never need ctx.actions to survive', () => {
    const { doc, run } = docWithRun('Hello world.');
    expect(
      handleSelectionAction(doc, run, { start: 0, end: 5, action: 'copy-text' })
        ?.action,
    ).toBe('copy-text');
    expect(
      handleSelectionAction(
        doc,
        run,
        { start: 0, end: 5, action: 'copy-text' },
        { actions: ['copy-markdown'] },
      )?.action,
    ).toBe('copy-text');
  });

  test('an empty action string is skew, not an action', () => {
    const { doc, run } = docWithRun('Hello world.');
    expect(
      handleSelectionAction(
        doc,
        run,
        { start: 0, end: 5, action: '' },
        { actions: [''] },
      )?.action,
    ).toBe('copy-markdown');
  });
});
