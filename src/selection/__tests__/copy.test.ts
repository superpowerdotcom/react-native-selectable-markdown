import type { AnyNode } from '../../document/nodes';
import type { Engine } from '../../engine/Engine';
import { parseDocument } from '../../engine/Engine';
import { presets } from '../../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../../engine/native/__tests__/support';
import { buildCopyPayload } from '../copy';
import { mapSelectionToSource, projectRun } from '../mapSelection';
import { segmentRuns } from '../runs';
import type { EmbedContent } from '../runs';
import { makeDoc, plainParagraph, plainTextEngine } from './fixtures';

/*
 * Most cases here pass an engine explicitly — a hand-built one whose output is
 * written down in ./fixtures, so a copy failure points at copy. The block at
 * the bottom covers the branch an app actually takes, `buildCopyPayload(doc,
 * span)` with no engine, which needs the package default to resolve; this is
 * what resolves it in a Node worker. Where the addon cannot be built the
 * default throws instead, and that block reports as skipped.
 */
linkNativeEngineAsDefault();

describe('buildCopyPayload', () => {
  const source = 'Alpha beta.\n\nGamma delta.\n\nOmega end.';
  const doc = makeDoc(source, [
    plainParagraph(source, 'Alpha beta.'),
    plainParagraph(source, 'Gamma delta.'),
    plainParagraph(source, 'Omega end.'),
  ]);

  it('returns the exact source slice as markdown', () => {
    const payload = buildCopyPayload(
      doc,
      { start: 13, end: 25 },
      { engine: plainTextEngine },
    );
    expect(payload.markdown).toBe('Gamma delta.');
    expect(payload.plain).toBe('Gamma delta.');
  });

  it('normalizes reversed spans and clamps out-of-range offsets', () => {
    expect(
      buildCopyPayload(doc, { start: 25, end: 13 }, { engine: plainTextEngine })
        .markdown,
    ).toBe('Gamma delta.');
    const whole = buildCopyPayload(
      doc,
      { start: -5, end: 999 },
      { engine: plainTextEngine },
    );
    expect(whole.markdown).toBe(source);
    expect(whole.plain).toBe(source);
  });

  it('returns empty strings for an empty span', () => {
    expect(
      buildCopyPayload(doc, { start: 5, end: 5 }, { engine: plainTextEngine }),
    ).toEqual({ plain: '', markdown: '' });
  });

  it('derives plain from the reparsed projection, not the raw slice', () => {
    const atxEngine: Engine = {
      name: 'fixture-atx',
      parse(src: string) {
        return {
          source: src,
          blocks: [
            {
              kind: 'heading',
              level: 1,
              span: { start: 0, end: src.length },
              children: [
                {
                  kind: 'text',
                  value: src.slice(2),
                  span: { start: 2, end: src.length },
                },
              ],
            },
          ],
        };
      },
    };
    const headingDoc = makeDoc('# Hi', []);
    const payload = buildCopyPayload(
      headingDoc,
      { start: 0, end: 4 },
      { engine: atxEngine },
    );
    expect(payload.markdown).toBe('# Hi');
    expect(payload.plain).toBe('Hi');
  });

  it('never throws when the engine cannot parse; plain degrades to the slice', () => {
    const brokenEngine: Engine = {
      name: 'fixture-broken',
      parse() {
        throw new Error('boom');
      },
    };
    const payload = buildCopyPayload(
      doc,
      { start: 0, end: 11 },
      { engine: brokenEngine },
    );
    expect(payload).toEqual({ plain: 'Alpha beta.', markdown: 'Alpha beta.' });
  });

  it('copies a plain-text slice with no engine argument, parsed or not', () => {
    // Deliberately the one assertion that holds down BOTH branches of the
    // default path, so it needs no gate: prose with no markup projects to
    // itself, so the answer is the same whether the slice was really parsed
    // or `parseDocument` threw for want of a native module and the catch
    // handed back the raw slice. Never throwing is the contract copy owes a
    // gesture in flight, and it must hold on an unequipped machine too.
    const tiny = makeDoc('hello world', [
      plainParagraph('hello world', 'hello world'),
    ]);
    const payload = buildCopyPayload(tiny, { start: 0, end: 11 });
    expect(payload.markdown).toBe('hello world');
    expect(payload.plain).toBe('hello world');
  });

  describe('copy fidelity property (pure-text document)', () => {
    const run = segmentRuns(doc)[0];
    const projected = projectRun(run, doc);
    const realSegments = projected.pieces
      .filter((p) => p.source !== null)
      .map((p) => [p.textStart, p.textEnd] as const);

    // In this fixture the projection is the identity (prose text is the
    // exact source slice and block separators equal the source gaps), so
    // the expected mapping is computable independently from real coverage.
    function expectedSpan(
      start: number,
      end: number,
    ): { start: number; end: number } | null {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const [a, b] of realSegments) {
        const s = Math.max(a, start);
        const e = Math.min(b, end);
        if (s < e) {
          lo = Math.min(lo, s);
          hi = Math.max(hi, e);
        }
      }
      return lo < hi ? { start: lo, end: hi } : null;
    }

    it('markdown of a mapped selection is exactly the selected visible text', () => {
      expect(projected.text).toBe(source);
      for (let start = 0; start < projected.text.length; start++) {
        for (let end = start + 1; end <= projected.text.length; end++) {
          const mapped = mapSelectionToSource(projected, { start, end });
          const expected = expectedSpan(start, end);
          expect(mapped).toEqual(expected);
          if (mapped === null || expected === null) {
            continue;
          }
          const payload = buildCopyPayload(doc, mapped, {
            engine: plainTextEngine,
          });
          // The markdown slice covers exactly the mapped visible range …
          expect(payload.markdown).toBe(
            projected.text.slice(expected.start, expected.end),
          );
          // … and reparsing it yields the same visible text.
          expect(payload.plain).toBe(payload.markdown);
          // For selections that start and end on real pieces the copied
          // markdown is exactly the visible text the user selected.
          const startOnReal = realSegments.some(
            ([a, b]) => start >= a && start < b,
          );
          const endOnReal = realSegments.some(([a, b]) => end > a && end <= b);
          if (startOnReal && endOnReal) {
            expect(payload.markdown).toBe(projected.text.slice(start, end));
          }
        }
      }
    });
  });
});

/**
 * The default engine path, taken for real.
 *
 * The case above is true either way by construction, which is what makes it
 * safe to run anywhere and also what makes it blind: it cannot tell a parse
 * apart from the catch that degrades to the raw slice. These can, because they
 * use a slice where `plain` and `markdown` are supposed to DIFFER.
 */
describeNative('buildCopyPayload through the package default engine', () => {
  const source = 'Copy **this** and `that`.';
  const doc = makeDoc(source, [plainParagraph(source, source)]);

  it('parses the slice, so plain is the display text and markdown the source', () => {
    const payload = buildCopyPayload(doc, { start: 0, end: source.length });
    expect(payload.markdown).toBe(source);
    // The delimiters are gone from `plain` — which is only possible if the
    // slice really was parsed. The degradation path would return the source.
    expect(payload.plain).toBe('Copy this and that.');
  });

  it('a mid-word slice still round-trips its markdown verbatim', () => {
    // `markdown` is a pure slice and never depends on the parse, including
    // when the slice cuts a construct in half and cannot parse to the same
    // thing at all.
    const payload = buildCopyPayload(doc, { start: 5, end: 11 });
    expect(payload.markdown).toBe('**this');
  });
});

/** The lookup sees nodes from the reparsed slice, so these claims key on node kind. */
describeNative('buildCopyPayload with an embed lookup', () => {
  const source = 'Chart: `series` here.';
  const doc = makeDoc(source, [plainParagraph(source, source)]);
  const whole = { start: 0, end: source.length };
  const claimCode = (node: AnyNode): EmbedContent | undefined =>
    node.kind === 'codeSpan'
      ? { width: 120, height: 40, text: '[chart]' }
      : undefined;

  it('stands a claimed node down to the text its claim declared', () => {
    const payload = buildCopyPayload(doc, whole, { embed: claimCode });

    expect(payload.markdown).toBe(source);
    expect(payload.plain).toBe('Chart: [chart] here.');
  });

  it('removes the placeholder when the claim declares no text', () => {
    const silent = (node: AnyNode): EmbedContent | undefined =>
      node.kind === 'codeSpan' ? { width: 120, height: 40 } : undefined;

    expect(buildCopyPayload(doc, whole, { embed: silent }).plain).toBe(
      'Chart:  here.',
    );
  });

  it('projects the node in full when no lookup is given', () => {
    expect(buildCopyPayload(doc, whole).plain).toBe('Chart: series here.');
  });
});

describeNative('buildCopyPayload with classifyBlock', () => {
  const source = 'One para.\n\nTwo para.\n\nThree para.\n';

  it('offers the reparsed slice\u2019s blocks to the callback', () => {
    const doc = parseDocument(source, presets.llmChat);
    const seen: string[] = [];
    const payload = buildCopyPayload(
      doc,
      { start: 0, end: source.length },
      {
        classifyBlock: (node) => {
          seen.push(node.kind);
          return undefined;
        },
      },
    );

    expect(seen).toEqual(['paragraph', 'text', 'paragraph', 'text', 'paragraph', 'text']);
    expect(payload.plain).toBe('One para.\n\nTwo para.\n\nThree para.');
  });

  it('does not disturb the classification the live document is memoized on', () => {
    // Copy reparses, so it never rewrites the live blocks' memo entries.
    const doc = parseDocument(source, presets.llmChat);
    let calls = 0;
    const classifyBlock = (): undefined => {
      calls += 1;
      return undefined;
    };

    segmentRuns(doc, { classifyBlock });
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    buildCopyPayload(doc, { start: 0, end: source.length }, { classifyBlock });

    calls = 0;
    segmentRuns(doc, { classifyBlock });
    expect(calls).toBe(0);
  });
});

describeNative('buildCopyPayload over character references', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['&copy;cat', '©cat'],
    ['&copy;copy', '©copy'],
    ['&#169;c', '©c'],
    ['&#xA9;c', '©c'],
    ['&amp;amp', '&amp'],
    ['ca&copy;t', 'ca©t'],
    ['Tom &amp; Jerry', 'Tom & Jerry'],
    ['a &alpha;alpha b', 'a αalpha b'],
    ['\\*not\\* emphasis', '*not* emphasis'],
    ['\\&copy; stays', '&copy; stays'],
  ];

  it.each(cases)('every selection of %j copies markdown that re-parses to it', (source, display) => {
    const doc = parseDocument(source);
    const projected = projectRun(segmentRuns(doc)[0], doc);
    expect(projected.text).toBe(display);

    for (let start = 0; start < display.length; start += 1) {
      for (let end = start + 1; end <= display.length; end += 1) {
        const selected = display.slice(start, end);
        if (selected.trim() === '') continue;
        const span = mapSelectionToSource(projected, { start, end });
        expect(span).not.toBeNull();
        const payload = buildCopyPayload(doc, span!);
        expect({ start, end, plain: payload.plain }).toEqual({
          start,
          end,
          plain: selected.trim(),
        });
      }
    }
  });

  it('copies the whole entity for its character and nothing of it for the next', () => {
    const source = '&copy;cat';
    const doc = parseDocument(source);
    const projected = projectRun(segmentRuns(doc)[0], doc);

    expect(mapSelectionToSource(projected, { start: 0, end: 1 })).toEqual({ start: 0, end: 6 });
    expect(mapSelectionToSource(projected, { start: 1, end: 2 })).toEqual({ start: 6, end: 7 });
    expect(mapSelectionToSource(projected, { start: 2, end: 4 })).toEqual({ start: 7, end: 9 });
    expect(buildCopyPayload(doc, { start: 6, end: 9 }).markdown).toBe('cat');
  });

  it('leaves a code span’s entity spelling linear, because it is not decoded there', () => {
    const source = 'see `&copy;` here';
    const doc = parseDocument(source);
    const projected = projectRun(segmentRuns(doc)[0], doc);
    const at = projected.text.indexOf('&copy;');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(mapSelectionToSource(projected, { start: at + 1, end: at + 2 })).toEqual({
      start: source.indexOf('&copy;') + 1,
      end: source.indexOf('&copy;') + 2,
    });
  });
});


describeNative('blocked link selection', () => {
  test.each(['plain', 'a &amp; b'])('copies the label without its blocked destination: %s', (label) => {
    const source = `[${label}](unsafe:destination)`;
    const doc = parseDocument(source);
    const run = projectRun(segmentRuns(doc)[0], doc);
    const span = mapSelectionToSource(run, { start: 0, end: run.text.length })!;
    const markdown = doc.source.slice(span.start, span.end);
    expect(markdown).toBe(label);
  });

  // Known bug: a blocked link flattens to one text node over `[...](...)`, so
  // the inner strong has no extent and a full sweep copies `bold** label`.
  test.failing('copies a formatted label that re-parses to what was displayed', () => {
    const source = '[**bold** label](unsafe:destination)';
    const doc = parseDocument(source);
    const run = projectRun(segmentRuns(doc)[0], doc);
    expect(run.text).toBe('bold label');
    const span = mapSelectionToSource(run, { start: 0, end: run.text.length })!;
    expect(buildCopyPayload(doc, span).plain).toBe('bold label');
  });
});
