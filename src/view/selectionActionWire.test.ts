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

// Pins the U+001F split both hosts' `parseSelectionAction` implements, which jest cannot reach.

function docWithRun(source: string): { doc: ParsedDocument; run: RunSegment } {
  const doc = parseDocument(source);
  const runs = segmentRuns(doc);
  expect(runs).toHaveLength(1);
  return { doc, run: runs[0] };
}

linkNativeEngineAsDefault();

describe('selectionActions wire format', () => {
  test('a bare id encodes to itself, which is the pre-title wire format', () => {
    // Older native binaries must get the default menu byte-for-byte.
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
      // Only the calls passing `actions` can warn, and only once per id.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('an event carrying NO action is the one case that resolves', () => {
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
