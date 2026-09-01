/**
 * Projection oracle: the selection contract, held over the whole corpus.
 *
 * WHY THIS FILE EXISTS. Every other corpus-scale gate in this repository
 * checks the *document*. `conformance/streaming/prefix-oracle.test.ts` asserts
 * AST deep-equality, settled-block referential identity and the absence of
 * spoilers; `conformance/run-commonmark.mjs` scores HTML. Not one of them
 * calls `projectRun` or `mapSelectionToSource`. So the layer this library is
 * named for — the projection from source to the characters on screen, and the
 * mapping back — was verified only by hand-built fixtures over documents
 * nobody would write.
 *
 * That gap had teeth. `docs/FABRIC-PLAN.md` §8 listed `npm run conformance` as
 * the proof that "the streaming prefix oracle still holds after the softBreak
 * change" — but the prefix oracle compares ASTs, and the softBreak change
 * touches no AST. It would have passed unchanged if `softBreak` had been made
 * to emit `'\n\n'`, or `''`, or the letter `q`.
 *
 * The corpus is the full CommonMark 0.31.2 suite plus every shipped fixture,
 * parsed by the package default with no engine argument — md4c, the same call
 * an app makes — under both the preset apps actually use and the maximal one.
 * Hand-built documents would defeat the purpose twice over: they would exclude
 * exactly the constructs nobody thought to write down, and they would let the
 * projection agree with a parse that no parser produces.
 *
 * `linkNativeEngineAsDefault` puts a Node worker in the state a launched app is
 * already in, since nothing installs the native binding here on its own. Where
 * the addon cannot be built there is no parser and `describeNative` reports
 * these blocks as skipped rather than failing — see
 * src/engine/native/__tests__/support.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ParsedDocument } from '../../src/document/nodes';
import { visit } from '../../src/document/visit';
import { parseDocument } from '../../src/engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../../src/engine/native/__tests__/support';
import { presets } from '../../src/engine/options';
import type { EngineOptions } from '../../src/engine/options';
import { buildCopyPayload } from '../../src/selection/copy';
import { mapSelectionToSource, projectRun } from '../../src/selection/mapSelection';
import type { ProjectedRun } from '../../src/selection/mapSelection';
import { segmentRuns } from '../../src/selection/runs';
import type { EmbedLookup, RunSegment } from '../../src/selection/runs';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const SPEC_PATH = path.resolve(__dirname, '..', 'vendor', 'spec.json');

/**
 * Exhaustive `(start, end)` sweeps are quadratic in the run length, so runs
 * longer than this get a strided sweep instead. 120 covers every CommonMark
 * example — the spec's prose is short — and the strided pass is what carries
 * the multi-paragraph fixtures.
 */
const EXHAUSTIVE_LENGTH_LIMIT = 120;
const STRIDE = 7;

interface Case {
  readonly label: string;
  readonly source: string;
}

function loadCorpus(): Case[] {
  const cases: Case[] = [];

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as {
    markdown: string;
    example: number;
  }[];
  for (const entry of spec) {
    cases.push({ label: `spec example ${entry.example}`, source: entry.markdown });
  }

  for (const file of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.md'))) {
    cases.push({
      label: `fixture ${file}`,
      source: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    });
  }

  return cases;
}

const corpus = loadCorpus();

linkNativeEngineAsDefault();

/** Every non-standalone run of one document — the ones that reach `RunHost`. */
function proseRuns(doc: ParsedDocument): { run: RunSegment; projected: ProjectedRun }[] {
  return segmentRuns(doc)
    .filter((run) => !run.standalone)
    .map((run) => ({ run, projected: projectRun(run, doc) }));
}

function selectionOffsets(length: number): number[] {
  if (length <= EXHAUSTIVE_LENGTH_LIMIT) {
    return Array.from({ length: length + 1 }, (_, i) => i);
  }
  const offsets: number[] = [];
  for (let i = 0; i <= length; i += STRIDE) offsets.push(i);
  if (offsets[offsets.length - 1] !== length) offsets.push(length);
  return offsets;
}

describeNative.each([
  ['llmChat', presets.llmChat],
  ['everything', presets.everything],
] as [string, EngineOptions][])('projection oracle (%s)', (_name, options) => {
  it('pieces tile the projected text exactly, with no gap and no overlap', () => {
    let runs = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of proseRuns(doc)) {
        runs++;
        let cursor = 0;
        for (const piece of projected.pieces) {
          if (piece.textStart !== cursor || piece.textEnd <= piece.textStart) {
            throw new Error(
              `${label}: piece table does not tile — expected the next piece to start ` +
                `at ${cursor}, got ${JSON.stringify(piece)}`,
            );
          }
          cursor = piece.textEnd;
        }
        if (cursor !== projected.text.length) {
          throw new Error(
            `${label}: piece table covers ${cursor} of ${projected.text.length} characters`,
          );
        }
      }
    }
    // A tiling assertion over an empty set is vacuously true, which is the
    // shape of a corpus loader that silently found nothing.
    expect(runs).toBeGreaterThan(400);
  });

  it('every mapped selection is an in-bounds, ordered source span', () => {
    let mapped = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of proseRuns(doc)) {
        const offsets = selectionOffsets(projected.text.length);
        for (const start of offsets) {
          for (const end of offsets) {
            if (end <= start) continue;
            const span = mapSelectionToSource(projected, { start, end });
            if (span === null) continue;
            mapped++;
            if (
              span.start < 0 ||
              span.end > doc.source.length ||
              span.start >= span.end
            ) {
              throw new Error(
                `${label}: selection [${start},${end}) mapped to ${JSON.stringify(span)}, ` +
                  `which is not an ordered span inside a ${doc.source.length}-character source`,
              );
            }
          }
        }
      }
    }
    expect(mapped).toBeGreaterThan(100_000);
  });

  it('the copied markdown is exactly the source slice the selection mapped to', () => {
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of proseRuns(doc)) {
        const offsets = selectionOffsets(projected.text.length);
        for (const start of offsets) {
          for (const end of offsets) {
            if (end <= start) continue;
            const span = mapSelectionToSource(projected, { start, end });
            if (span === null) continue;
            const payload = buildCopyPayload(doc, span, { options });
            if (payload.markdown !== doc.source.slice(span.start, span.end)) {
              throw new Error(
                `${label}: copy payload markdown is not the source slice for ` +
                  `${JSON.stringify(span)}`,
              );
            }
          }
        }
      }
    }
  });
});

/**
 * THE SOFT-BREAK GUARD, and the reason it is a separate test rather than a
 * clause in the ones above.
 *
 * `docs/FABRIC-PLAN.md` §6.1(a) changed `softBreak` to project `' '` instead
 * of `'\n'`, because the JS `<Text>` fallback renders `softBreak: () => ' '`
 * and every other CommonMark renderer agrees — hard-wrapped LLM prose was
 * coming out of the native host as forced mid-sentence line breaks while the
 * fallback showed one flowing paragraph. The two render paths must not
 * disagree about which characters are on screen.
 *
 * Nothing structural changes when that regresses. The AST is identical, the
 * piece table tiles identically (a soft break is one code unit either way
 * against the same source span), and the streaming prefix oracle is blind to
 * it. The only observable is the character itself, so that is what this
 * asserts, and it asserts it at the node rather than by pattern-matching
 * newlines in the output. An earlier form of this test walked every `'\n'` in
 * the projected text and demanded it trace back to a structural separator or a
 * hard break; CommonMark example 39 is `foo&#10;&#10;bar`, where the entity
 * decodes to a real newline inside a text node, and that is content rather
 * than a break. Working backwards from the character cannot tell those apart.
 * Working forwards from the `softBreak` node can.
 *
 * THE OFFSET ARITHMETIC IS EXACT, NOT APPROXIMATE. A soft break always lands
 * inside a *linear* piece — one whose text length equals its source length —
 * either because it merged with the text around it (`emit`'s merge condition
 * requires linearity on both sides) or because it stands alone as a
 * one-character piece over a one-character span. Inside a linear piece the
 * mapping is offset for offset, so the projected character for a source
 * newline is at a computable position.
 */
describeNative('projection oracle: no soft break projects a newline', () => {
  it.each([
    ['llmChat', presets.llmChat],
    ['everything', presets.everything],
  ] as [string, EngineOptions][])(
    'every softBreak projects a space (%s)',
    (_name, options) => {
      let checked = 0;
      for (const { label, source } of corpus) {
        const doc = parseDocument(source, options);

        const softBreakStarts = new Set<number>();
        visit(doc, (node) => {
          if (node.kind === 'softBreak' && !node.synthetic) {
            softBreakStarts.add(node.span.start);
          }
        });
        if (softBreakStarts.size === 0) continue;

        for (const { projected } of proseRuns(doc)) {
          for (const piece of projected.pieces) {
            if (piece.source === null) continue;
            const textLength = piece.textEnd - piece.textStart;
            const sourceLength = piece.source.end - piece.source.start;
            // Non-linear pieces (a code span's fence stripped, an entity
            // decoded, a link's text standing in for its markup) have no
            // offset-for-offset mapping, and a soft break never lands in one.
            if (textLength !== sourceLength) continue;
            for (const start of softBreakStarts) {
              if (start < piece.source.start || start >= piece.source.end) continue;
              const at = piece.textStart + (start - piece.source.start);
              checked++;
              if (projected.text[at] !== ' ') {
                throw new Error(
                  `${label}: the softBreak at source offset ${start} projected ` +
                    `${JSON.stringify(projected.text[at])} at text offset ${at}, not a space. ` +
                    'Soft breaks render as a space in CommonMark and in the <Text> ' +
                    'fallback — see docs/FABRIC-PLAN.md §6.1(a).',
                );
              }
            }
          }
        }
      }
      // The corpus really does contain soft breaks inside prose runs, so a
      // regression that stopped producing them fails here rather than passing
      // by having nothing left to check.
      expect(checked).toBeGreaterThan(100);
    },
  );
});

/**
 * THE EMBED SWEEP: the same three invariants the main oracle holds — piece
 * tiling, in-bounds mapping, copy-slice identity — re-asserted over the
 * corpus reprojected with a synthetic embed claim on every link. An embed
 * replaces a whole subtree's projection with one U+FFFC placeholder mapped
 * non-linearly to the node's span, which is exactly the kind of change the
 * hand-built fixtures cannot stress: the corpus holds links inside emphasis,
 * headings, list items, tables, blockquotes — the nestings nobody thinks to
 * write down, and the ones where a mis-tiled placeholder piece or a hull that
 * leaks past the node's span would actually hide.
 *
 * Links are the claim target because they are the construct the feature
 * exists for (citation cards) and the corpus is full of them in every
 * position. The oracle's own three tests keep running with NO claim, so this
 * block is purely additive.
 */
describeNative.each([
  ['llmChat', presets.llmChat],
  ['everything', presets.everything],
] as [string, EngineOptions][])('projection oracle: embeds (%s)', (_name, baseOptions) => {
  // `blockedLinks: 'node'` is the configuration the feature exists for (the
  // README's citation story), and it is also what makes this sweep dense:
  // most corpus links carry relative or exotic hrefs the default URL policy
  // strips at parse time — under the plain presets only a handful of link
  // NODES exist to claim. Keeping them as blocked nodes turns nearly every
  // corpus link into an embed.
  const options: EngineOptions = {
    ...baseOptions,
    urlPolicy: { ...baseOptions.urlPolicy, blockedLinks: 'node' },
  };
  const claimLinks: EmbedLookup = (node) =>
    node.kind === 'link' ? { width: 160, height: 48, text: '[ref]' } : undefined;

  function embedRuns(
    doc: ParsedDocument,
  ): { run: RunSegment; projected: ProjectedRun }[] {
    return segmentRuns(doc, { embed: claimLinks })
      .filter((run) => !run.standalone)
      .map((run) => ({ run, projected: projectRun(run, doc, { embed: claimLinks }) }));
  }

  it('embed-bearing runs keep tiling, and every embed owns one placeholder piece', () => {
    let embeds = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of embedRuns(doc)) {
        let cursor = 0;
        for (const piece of projected.pieces) {
          if (piece.textStart !== cursor || piece.textEnd <= piece.textStart) {
            throw new Error(
              `${label}: embed piece table does not tile — expected the next piece ` +
                `to start at ${cursor}, got ${JSON.stringify(piece)}`,
            );
          }
          cursor = piece.textEnd;
        }
        if (cursor !== projected.text.length) {
          throw new Error(
            `${label}: embed piece table covers ${cursor} of ${projected.text.length}`,
          );
        }
        for (const embed of projected.embeds ?? []) {
          embeds++;
          if (embed.end !== embed.start + 1) {
            throw new Error(`${label}: embed range is not one character`);
          }
          if (projected.text[embed.start] !== '￼') {
            throw new Error(
              `${label}: embed placeholder at ${embed.start} is ` +
                `${JSON.stringify(projected.text[embed.start])}, not U+FFFC`,
            );
          }
          const piece = projected.pieces.find(
            (candidate) => candidate.textStart === embed.start,
          );
          if (
            !piece ||
            piece.textEnd !== embed.end ||
            piece.source === null ||
            piece.source.start !== embed.node.span.start ||
            piece.source.end > doc.source.length
          ) {
            throw new Error(
              `${label}: embed at ${embed.start} does not own one piece over its ` +
                `node span — got ${JSON.stringify(piece)}`,
            );
          }
          const mark = projected.marks.find(
            (candidate) =>
              candidate.kind === 'embed' && candidate.start === embed.start,
          );
          if (!mark || mark.embedId !== embed.embedId) {
            throw new Error(`${label}: embed at ${embed.start} has no matching mark`);
          }
        }
      }
    }
    // Vacuity guard: the corpus really does hold links in prose runs.
    expect(embeds).toBeGreaterThan(100);
  });

  it('selections over embed-bearing runs map in bounds and copy the exact slice', () => {
    let mapped = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of embedRuns(doc)) {
        if (!projected.embeds) continue;
        const offsets = selectionOffsets(projected.text.length);
        for (const start of offsets) {
          for (const end of offsets) {
            if (end <= start) continue;
            const span = mapSelectionToSource(projected, { start, end });
            if (span === null) continue;
            mapped++;
            if (span.start < 0 || span.end > doc.source.length || span.start >= span.end) {
              throw new Error(
                `${label}: embed selection [${start},${end}) mapped out of bounds: ` +
                  JSON.stringify(span),
              );
            }
            const payload = buildCopyPayload(doc, span, { options });
            if (payload.markdown !== doc.source.slice(span.start, span.end)) {
              throw new Error(
                `${label}: embed copy payload is not the source slice for ` +
                  JSON.stringify(span),
              );
            }
          }
        }
      }
    }
    expect(mapped).toBeGreaterThan(5_000);
  });
});
