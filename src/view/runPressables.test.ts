/**
 * The native host's tappable ranges, and the link marks they are built from.
 *
 * The property held hardest here is agreement between the three faces of a
 * link: what `runAttributes` paints in the link colour, what the JS
 * fallback's renderer makes pressable, and what `resolveRunPressables` tells
 * the native host to intercept must all be the same ranges. A link that is
 * styled but not pressable (or pressable but not styled) is the disagreement
 * the native host shipped with — links rendered as styled, inert text — and
 * the one this module exists to close.
 */

import type { ParsedDocument } from '../document/nodes';
import { parseDocument } from '../engine/Engine';
import { presets } from '../engine/options';
import type { EngineOptions } from '../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import { projectRun } from '../selection/mapSelection';
import type { ProjectedRun } from '../selection/mapSelection';
import { segmentRuns } from '../selection/runs';
import { resolveRunPressables } from './runPressables';

const EVERYTHING: EngineOptions = presets.everything;

/** Project the first non-standalone run of `source`. */
function project(source: string, options: EngineOptions = EVERYTHING): ProjectedRun {
  const doc = parseDocument(source, options);
  const run = segmentRuns(doc, {}).find((r) => !r.standalone);
  if (!run) throw new Error(`no prose run in ${JSON.stringify(source)}`);
  return projectRun(run, doc);
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

describeNative('resolveRunPressables', () => {
  test('a plain paragraph has no pressables', () => {
    expect(resolveRunPressables(project('just prose, nothing tappable'))).toEqual([]);
    expect(resolveRunPressables(project('just prose, [one](https://a.example) tappable'))).toEqual([
      { start: 12, end: 15, href: 'https://a.example' },
    ]);
  });

  test('an inline link yields its display range and href', () => {
    const projected = project('see [the docs](https://example.com/docs) here');
    const pressables = resolveRunPressables(projected);
    expect(pressables).toHaveLength(1);
    const [link] = pressables;
    expect(projected.text.slice(link.start, link.end)).toBe('the docs');
    expect(link.href).toBe('https://example.com/docs');
  });

  test('an autolink yields its href as both text and target', () => {
    const projected = project('go to <https://example.com> now');
    const pressables = resolveRunPressables(projected);
    expect(pressables).toHaveLength(1);
    const [link] = pressables;
    expect(projected.text.slice(link.start, link.end)).toBe('https://example.com');
    expect(link.href).toBe('https://example.com');
  });

  test('multiple links stay in order and never overlap', () => {
    const projected = project(
      '[one](https://a.example) and [two](https://b.example) and [three](https://c.example)',
    );
    const pressables = resolveRunPressables(projected);
    expect(pressables.map((p) => p.href)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    for (let i = 1; i < pressables.length; i += 1) {
      expect(pressables[i].start).toBeGreaterThanOrEqual(pressables[i - 1].end);
    }
  });

  test('an autolink inside link text yields ONE range, not two over the same text', () => {
    const projected = project('[<https://a.example>](https://b.example)');
    const linkMarks = projected.marks.filter((m) => m.kind === 'link');
    expect(linkMarks).toHaveLength(2);
    expect(linkMarks[0].start).toBe(linkMarks[1].start);
    expect(linkMarks[0].end).toBe(linkMarks[1].end);

    const pressables = resolveRunPressables(projected);
    expect(pressables).toHaveLength(1);
    // Identical ranges keep push order, innermost first.
    expect(pressables[0].href).toBe('https://a.example');
  });

  test('an autolink with text beside it loses to the OUTER link, not the inner', () => {
    const projected = project('[<https://a.example> tail](https://b.example)');
    const linkMarks = projected.marks.filter((m) => m.kind === 'link');
    expect(linkMarks).toHaveLength(2);

    const pressables = resolveRunPressables(projected);
    expect(pressables).toHaveLength(1);
    expect(projected.text.slice(pressables[0].start, pressables[0].end)).toBe(
      'https://a.example tail',
    );
    expect(pressables[0].href).toBe('https://b.example');
  });

  test('a link inside emphasis keeps exactly the link range', () => {
    const projected = project('*emphasised [label](https://example.com) tail*');
    const pressables = resolveRunPressables(projected);
    expect(pressables).toHaveLength(1);
    expect(projected.text.slice(pressables[0].start, pressables[0].end)).toBe('label');
  });

  test('pressables agree range-for-range with the link marks', () => {
    const projected = project(
      'a [x](https://a.example), <https://b.example>, and **[y](https://c.example)**',
    );
    const linkMarks = projected.marks.filter((m) => m.kind === 'link');
    expect(resolveRunPressables(projected)).toEqual(
      linkMarks.map((m) => ({ start: m.start, end: m.end, href: m.href })),
    );
  });

  test('an incomplete (still-streaming) link is not pressable', () => {
    // `incomplete` is stamped by streaming repair, never by a static parse
    // (a static parse of the same text yields literal text plus a GFM
    // autolink instead), so the node is built by hand: a `[label](https://…`
    // whose closing paren has not arrived. It must not act tappable until it
    // does — the same rule that keeps it unstyled and unmarked.
    const source = 'tail [label](https://exam';
    const doc: ParsedDocument = {
      source,
      blocks: [
        {
          kind: 'paragraph',
          span: { start: 0, end: source.length },
          incomplete: true,
          children: [
            { kind: 'text', value: 'tail ', span: { start: 0, end: 5 } },
            {
              kind: 'link',
              href: 'https://exam',
              incomplete: true,
              span: { start: 5, end: source.length },
              children: [
                { kind: 'text', value: 'label', span: { start: 6, end: 11 } },
              ],
            },
          ],
        },
      ],
    };
    const run = segmentRuns(doc, {}).find((r) => !r.standalone);
    if (!run) throw new Error('expected a prose run');
    const projected = projectRun(run, doc);
    expect(projected.text).toBe('tail label');
    expect(resolveRunPressables(projected)).toEqual([]);

    // The same link once its paren arrives is pressable.
    const settledSource = 'tail [label](https://exam)';
    const settled: ParsedDocument = {
      source: settledSource,
      blocks: [
        {
          kind: 'paragraph',
          span: { start: 0, end: settledSource.length },
          children: [
            { kind: 'text', value: 'tail ', span: { start: 0, end: 5 } },
            {
              kind: 'link',
              href: 'https://exam',
              span: { start: 5, end: settledSource.length },
              children: [
                { kind: 'text', value: 'label', span: { start: 6, end: 11 } },
              ],
            },
          ],
        },
      ],
    };
    const settledRun = segmentRuns(settled, {}).find((r) => !r.standalone);
    if (!settledRun) throw new Error('expected a prose run');
    expect(resolveRunPressables(projectRun(settledRun, settled))).toEqual([
      { start: 5, end: 10, href: 'https://exam' },
    ]);
  });

  test("a blocked href is not pressable under the default 'text' policy", () => {
    // javascript: fails the default URL policy, and `blockedLinks` defaults to
    // 'text' (options.ts) — so the whole link node collapses at parse time and
    // there is nothing left to press. This test says nothing about 'node',
    // which is the mode the block below covers; keeping the distinction
    // explicit is the point, because for a while this test was read as proving
    // "blocked links are never pressable" when it only ever exercised the mode
    // where the node does not survive at all.
    const projected = project(
      'bad [click](javascript:alert(1)) link [ok](https://ok.example)',
    );
    expect(
      resolveRunPressables(projected).map((p) => [
        projected.text.slice(p.start, p.end),
        p.href,
      ]),
    ).toEqual([['ok', 'https://ok.example']]);
  });

  describe("blockedLinks: 'node'", () => {
    // The mode where a rejected href keeps its node, which is what consumers
    // use when their blocked schemes are IDENTIFIERS rather than URLs they
    // distrust — citation markers, entity references, an app's own deep links.
    //
    // These ranges must be reported. Reporting nothing is what this library
    // used to do, and the consequence was not a dead link: it was that such a
    // consumer had to classify every block containing one as `standalone` to
    // keep the construct visible at all, and thereby gave up cross-block
    // selection over most of a document. That is the bug these tests pin shut.
    const KEEP_BLOCKED: EngineOptions = {
      ...EVERYTHING,
      urlPolicy: { linkPrefixes: ['https://'], blockedLinks: 'node' },
    };

    test('a blocked link is pressable and flagged blocked', () => {
      const projected = project('see [3](#src-citation-3) here', KEEP_BLOCKED);
      const pressables = resolveRunPressables(projected);
      expect(pressables).toHaveLength(1);
      const [citation] = pressables;
      expect(projected.text.slice(citation.start, citation.end)).toBe('3');
      expect(citation.href).toBe('#src-citation-3');
      expect(citation.blocked).toBe(true);
    });

    test('a live link carries no blocked flag', () => {
      const [live, blocked] = resolveRunPressables(
        project('see [the docs](https://example.com/docs) [3](#src-citation-3)', KEEP_BLOCKED),
      );
      // Absent rather than `false`: the field is optional so a live pressable
      // serializes to exactly what it did before blocked ranges existed.
      expect('blocked' in live).toBe(false);
      expect(live.href).toBe('https://example.com/docs');
      expect(blocked.blocked).toBe(true);
    });

    test('live and blocked ranges coexist, in order, each correctly flagged', () => {
      const projected = project(
        'a [live](https://a.example) then [2](#src-citation-2) then [more](https://b.example)',
        KEEP_BLOCKED,
      );
      const pressables = resolveRunPressables(projected);
      expect(pressables.map((p) => p.blocked === true)).toEqual([false, true, false]);
      expect(pressables.map((p) => projected.text.slice(p.start, p.end))).toEqual([
        'live',
        '2',
        'more',
      ]);
      for (let i = 1; i < pressables.length; i += 1) {
        expect(pressables[i].start).toBeGreaterThanOrEqual(pressables[i - 1].end);
      }
    });

    test('pressables still agree range-for-range with the link-shaped marks', () => {
      // The invariant in this file's header, extended to both kinds: what
      // `runAttributes` can style and what the host intercepts stay the same
      // ranges. A blocked link that were styled but not pressable (or the
      // reverse) is the disagreement the whole module exists to prevent.
      const projected = project(
        'x [a](https://a.example) y [1](#src-citation-1) z',
        KEEP_BLOCKED,
      );
      const linkish = projected.marks.filter(
        (m) => m.kind === 'link' || m.kind === 'blockedLink',
      );
      expect(resolveRunPressables(projected).map((p) => [p.start, p.end])).toEqual(
        linkish.map((m) => [m.start, m.end]),
      );
    });
  });

  test('every pressable range is in bounds of the projected text', () => {
    const projected = project(
      '# Heading with [a link](https://example.com)\n\n- item <https://example.com/two>\n- plain',
    );
    const pressables = resolveRunPressables(projected);
    for (const pressable of pressables) {
      expect(pressable.start).toBeGreaterThanOrEqual(0);
      expect(pressable.end).toBeGreaterThan(pressable.start);
      expect(pressable.end).toBeLessThanOrEqual(projected.text.length);
    }
    expect(pressables.map((p) => projected.text.slice(p.start, p.end))).toEqual([
      'a link',
      'https://example.com/two',
    ]);
  });
});
