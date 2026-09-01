import type { ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { projectRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import type { EmbedLookup, RunSegment } from '../selection/runs';
import {
  DEFAULT_SELECTION_ACTIONS,
  handleSelectionAction,
} from './selectionActions';

/** Parses `source` and returns the document plus its single run. */
function docWithRun(source: string): { doc: ParsedDocument; run: RunSegment } {
  const doc = parseDocument(source);
  const runs = segmentRuns(doc);
  expect(runs).toHaveLength(1);
  return { doc, run: runs[0] };
}

/** The display text a run projects to (what the native host renders). */
function displayText(doc: ParsedDocument, run: RunSegment): string {
  return projectRun(run, doc).text;
}

/*
 * Every case below parses through the package default —
 * `parseDocument(source, options)` with no engine argument, the call
 * `SelectableMarkdown` itself makes. That default is the md4c engine, and
 * nothing links it in a Node worker on its own, so this does what a launched
 * app's `installNativeEngine()` does. Without a compiled addon there is no
 * parser at all and `describeNative` reports these blocks as skipped rather
 * than failing; see src/engine/native/__tests__/support.ts.
 */
linkNativeEngineAsDefault();

describeNative('handleSelectionAction', () => {
  test('copy-text on a full paragraph: plain is the display text, markdown the source slice', () => {
    const { doc, run } = docWithRun('Hello **bold** world.');
    const display = displayText(doc, run);
    expect(display).toBe('Hello bold world.');

    const payload = handleSelectionAction(doc, run, {
      start: 0,
      end: display.length,
      action: 'copy-text',
    });

    expect(payload).not.toBeNull();
    expect(payload?.action).toBe('copy-text');
    expect(payload?.plain).toBe('Hello bold world.');
    expect(payload?.markdown).toBe('Hello **bold** world.');
    expect(payload?.span).toEqual({ start: 0, end: doc.source.length });
  });

  test('partial selection across emphasis: markdown keeps the ** markers, plain does not', () => {
    const { doc, run } = docWithRun('Hello **bold** world.');
    // Display "Hello bold world." — select "lo bold wo".
    const payload = handleSelectionAction(doc, run, {
      start: 3,
      end: 13,
      action: 'copy-markdown',
    });

    expect(payload?.plain).toBe('lo bold wo');
    expect(payload?.markdown).toBe('lo **bold** wo');
    // The copied markdown re-parses to exactly the visible selection.
    const reparsed = parseDocument(payload!.markdown);
    const reparsedRuns = segmentRuns(reparsed);
    expect(displayText(reparsed, reparsedRuns[0])).toBe('lo bold wo');
  });

  test('markdown is always the exact source slice of the mapped span', () => {
    const { doc, run } = docWithRun('Some *styled* text with `code`.');
    const display = displayText(doc, run);
    const payload = handleSelectionAction(doc, run, {
      start: 2,
      end: display.length - 3,
      action: 'copy-markdown',
    });
    expect(payload).not.toBeNull();
    expect(payload!.markdown).toBe(
      doc.source.slice(payload!.span.start, payload!.span.end),
    );
  });

  test('list selection: plain includes the glyphs the user saw, markdown the exact source slice', () => {
    const { doc, run } = docWithRun('- one\n- two');
    const display = displayText(doc, run);
    expect(display).toBe('• one\n• two');

    const payload = handleSelectionAction(doc, run, {
      start: 0,
      end: display.length,
      action: 'copy-text',
    });

    // What the user visually selected — bullets and item separator included.
    expect(payload?.plain).toBe('• one\n• two');
    // Synthetic glyphs carry no source; the span covers "one" through "two".
    expect(payload?.markdown).toBe('one\n- two');
  });

  test('selecting only a synthetic bullet yields no payload', () => {
    const { doc, run } = docWithRun('- one\n- two');
    expect(
      handleSelectionAction(doc, run, { start: 0, end: 2, action: 'copy-text' }),
    ).toBeNull();
  });

  test('cross-block selection in a merged run keeps the separator the user saw', () => {
    const { doc, run } = docWithRun('# Title\n\nBody text');
    const display = displayText(doc, run);
    expect(display).toBe('Title\n\nBody text');

    const payload = handleSelectionAction(doc, run, {
      start: 0,
      end: display.length,
      action: 'copy-markdown',
    });

    expect(payload?.plain).toBe('Title\n\nBody text');
    // The heading's "# " prefix is outside the projected pieces, so the
    // span starts at the heading text itself.
    expect(payload?.markdown).toBe('Title\n\nBody text');
  });

  test('entity-decoded text pins to the whole diverged node, plain stays the visible slice', () => {
    const { doc, run } = docWithRun('a &hellip; b');
    const display = displayText(doc, run);
    expect(display).toBe('a … b');

    const payload = handleSelectionAction(doc, run, {
      start: 2,
      end: 3,
      action: 'copy-markdown',
    });

    // Display text diverges from the raw source (decoded entity), so the
    // projection maps the text node as an indivisible unit: the markdown
    // slice covers the whole node while plain is exactly what was selected.
    expect(payload?.plain).toBe('…');
    expect(payload?.markdown).toBe('a &hellip; b');
  });

  test('code-block runs map through the same pure path', () => {
    const doc = parseDocument('```js\nconst x = 1;\n```');
    const runs = segmentRuns(doc);
    expect(runs).toHaveLength(1);
    // Flowing now, not standalone — a code block projects text and marks like
    // any other block, which is what lets a selection cross one. The property
    // this test is really about is unchanged: the offsets map back to source
    // through the same pure path either way.
    expect(runs[0].standalone).toBe(false);
    expect(displayText(doc, runs[0])).toBe('const x = 1;\n');

    const payload = handleSelectionAction(doc, runs[0], {
      start: 0,
      end: 5,
      action: 'copy-text',
    });
    expect(payload?.plain).toBe('const');
    expect(payload?.markdown).toBe('const');
  });

  test('reversed offsets are normalized', () => {
    const { doc, run } = docWithRun('plain words here');
    const forward = handleSelectionAction(doc, run, {
      start: 6,
      end: 11,
      action: 'copy-text',
    });
    const reversed = handleSelectionAction(doc, run, {
      start: 11,
      end: 6,
      action: 'copy-text',
    });
    expect(forward?.plain).toBe('words');
    expect(reversed).toEqual(forward);
  });

  test('offsets clamp into the projected text', () => {
    const { doc, run } = docWithRun('short');
    const payload = handleSelectionAction(doc, run, {
      start: -10,
      end: 999,
      action: 'copy-text',
    });
    expect(payload?.plain).toBe('short');
    expect(payload?.markdown).toBe('short');
  });

  test('empty, out-of-range, and non-finite selections yield no payload', () => {
    const { doc, run } = docWithRun('short');
    const cases: Array<{ start: number; end: number }> = [
      { start: 2, end: 2 },
      { start: 9, end: 12 },
      { start: -4, end: -1 },
      // Non-finite offsets are rejected outright (the bridge can never
      // deliver them; anything producing them is a bug upstream).
      { start: Number.NaN, end: 3 },
      { start: 0, end: Number.POSITIVE_INFINITY },
    ];
    for (const sel of cases) {
      expect(
        handleSelectionAction(doc, run, { ...sel, action: 'copy-text' }),
      ).toBeNull();
    }
  });

  test("unknown or missing action normalizes to 'copy-markdown' (older native binaries)", () => {
    const { doc, run } = docWithRun('compat check');
    const missing = handleSelectionAction(doc, run, { start: 0, end: 6 });
    const unknown = handleSelectionAction(doc, run, {
      start: 0,
      end: 6,
      action: 'share-quote',
    });
    expect(missing?.action).toBe('copy-markdown');
    expect(unknown?.action).toBe('copy-markdown');
  });

  test('ctx.glyphs projects the fallback with the on-screen markers, so custom-glyph offsets map exactly', () => {
    const { doc, run } = docWithRun('- one\n- two');
    // A marker of a different length than the default '• ' shifts every
    // offset after the first item; the native event's offsets are into THIS
    // text, so a default-glyph fallback projection would slice wrong.
    const glyphs = { bullet: '→   ' };
    const display = projectRun(run, doc, { glyphs }).text;
    expect(display).toBe('→   one\n→   two');

    const start = display.indexOf('two');
    const payload = handleSelectionAction(
      doc,
      run,
      { start, end: start + 3, action: 'copy-text' },
      { glyphs },
    );
    expect(payload?.plain).toBe('two');
    expect(payload?.markdown).toBe('two');

    // And it matches the ctx.projected route exactly.
    const withProjected = handleSelectionAction(
      doc,
      run,
      { start, end: start + 3, action: 'copy-text' },
      { projected: projectRun(run, doc, { glyphs }), glyphs },
    );
    expect(withProjected).toEqual(payload);
  });

  test('ctx.projected reuses the caller-computed projection without changing the result', () => {
    const { doc, run } = docWithRun('reuse **the** projection');
    const projected = projectRun(run, doc);
    const withCtx = handleSelectionAction(
      doc,
      run,
      { start: 0, end: projected.text.length, action: 'copy-text' },
      { projected },
    );
    const withoutCtx = handleSelectionAction(doc, run, {
      start: 0,
      end: projected.text.length,
      action: 'copy-text',
    });
    expect(withCtx).toEqual(withoutCtx);
  });

  test('task-list glyphs are visually selected but never enter the markdown slice boundaries', () => {
    const source = '- [x] done\n- [ ] todo';
    const doc = parseDocument(source, { extensions: { tasklists: true } });
    const runs = segmentRuns(doc);
    expect(runs).toHaveLength(1);
    const display = displayText(doc, runs[0]);
    expect(display).toBe('☑ done\n☐ todo');

    const payload = handleSelectionAction(doc, runs[0], {
      start: 0,
      end: display.length,
      action: 'copy-text',
    });
    expect(payload?.plain).toBe('☑ done\n☐ todo');
    expect(payload?.markdown).toBe('done\n- [ ] todo');
  });
});

describeNative('DEFAULT_SELECTION_ACTIONS', () => {
  test('offers plain text first, markdown second', () => {
    expect([...DEFAULT_SELECTION_ACTIONS]).toEqual([
      'copy-text',
      'copy-markdown',
    ]);
  });

  test('is frozen — shared across renders as an immutable default', () => {
    expect(Object.isFrozen(DEFAULT_SELECTION_ACTIONS)).toBe(true);
  });
});

/*
 * Embeds in the copy path. The claimed link projects as one U+FFFC
 * placeholder; `markdown` maps through its indivisible piece to the node's
 * whole source, and `plain` substitutes the declared text (or removes the
 * placeholder when none was declared).
 */
describeNative('handleSelectionAction with embeds', () => {
  const claim: EmbedLookup = (node) =>
    node.kind === 'link' && node.href.startsWith('https://cite.example/')
      ? { width: 200, height: 80, text: '[1]' }
      : undefined;

  function docWithEmbedRun(source: string, embed: EmbedLookup = claim) {
    const doc = parseDocument(source);
    const runs = segmentRuns(doc, { embed });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    const projected = projectRun(run, doc, { embed });
    return { doc, run, projected };
  }

  test('copy-text substitutes the declared text for the placeholder', () => {
    const source = 'See [one](https://cite.example/a) here.';
    const { doc, run, projected } = docWithEmbedRun(source);
    expect(projected.text).toBe('See ￼ here.');

    const payload = handleSelectionAction(
      doc,
      run,
      { start: 0, end: projected.text.length, action: 'copy-text' },
      { projected, embed: claim },
    );

    expect(payload?.plain).toBe('See [1] here.');
    expect(payload?.markdown).toBe(source);
    expect(payload?.span).toEqual({ start: 0, end: source.length });
  });

  test('an embed without declared text is removed from plain', () => {
    const source = 'See [one](https://cite.example/a) here.';
    const noText: EmbedLookup = (node) =>
      node.kind === 'link' && node.href.startsWith('https://cite.example/')
        ? { width: 200, height: 80 }
        : undefined;
    const { doc, run, projected } = docWithEmbedRun(source, noText);

    const payload = handleSelectionAction(
      doc,
      run,
      { start: 0, end: projected.text.length, action: 'copy-text' },
      { projected, embed: noText },
    );

    expect(payload?.plain).toBe('See  here.');
    expect(payload?.markdown).toBe(source);
  });

  test('substitutes multiple embeds right-to-left, edges included', () => {
    const source =
      '[a](https://cite.example/a) mid [b](https://cite.example/b)';
    const numbered: EmbedLookup = (() => {
      let next = 0;
      const byHref = new Map<string, string>();
      return ((node) => {
        if (
          node.kind !== 'link' ||
          !node.href.startsWith('https://cite.example/')
        ) {
          return undefined;
        }
        if (!byHref.has(node.href)) {
          next += 1;
          byHref.set(node.href, `[${next}]`);
        }
        return { width: 100, height: 40, text: byHref.get(node.href) };
      }) as EmbedLookup;
    })();
    const { doc, run, projected } = docWithEmbedRun(source, numbered);
    expect(projected.text).toBe('￼ mid ￼');

    const payload = handleSelectionAction(
      doc,
      run,
      { start: 0, end: projected.text.length, action: 'copy-text' },
      { projected, embed: numbered },
    );

    expect(payload?.plain).toBe('[1] mid [2]');
    expect(payload?.markdown).toBe(source);
  });

  test('a selection excluding the placeholder substitutes nothing', () => {
    const source = 'See [one](https://cite.example/a) here.';
    const { doc, run, projected } = docWithEmbedRun(source);

    const payload = handleSelectionAction(
      doc,
      run,
      { start: 0, end: 4, action: 'copy-text' },
      { projected, embed: claim },
    );

    expect(payload?.plain).toBe('See ');
    expect(payload?.markdown).toBe('See ');
  });

  test('a placeholder-only selection copies the node’s whole markdown', () => {
    const source = 'See [one](https://cite.example/a) here.';
    const { doc, run, projected } = docWithEmbedRun(source);
    const placeholderAt = projected.text.indexOf('￼');

    const payload = handleSelectionAction(
      doc,
      run,
      { start: placeholderAt, end: placeholderAt + 1, action: 'copy-markdown' },
      { projected, embed: claim },
    );

    expect(payload?.plain).toBe('[1]');
    expect(payload?.markdown).toBe('[one](https://cite.example/a)');
  });

  test('the fallback projection with ctx.embed matches the precomputed one', () => {
    const source = 'See [one](https://cite.example/a) here.';
    const { doc, run, projected } = docWithEmbedRun(source);

    const withProjected = handleSelectionAction(
      doc,
      run,
      { start: 2, end: projected.text.length - 2, action: 'copy-markdown' },
      { projected, embed: claim },
    );
    const withFallback = handleSelectionAction(
      doc,
      run,
      { start: 2, end: projected.text.length - 2, action: 'copy-markdown' },
      { embed: claim },
    );

    expect(withFallback).toEqual(withProjected);
  });
});
