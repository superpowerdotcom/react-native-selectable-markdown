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

/**
 * The only one-for-one substitutions a linear piece may make, keyed by source
 * character.
 */
const PROJECTED_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  // A soft break renders as a space: docs/FABRIC-PLAN.md §6.1(a).
  ['\n', ' '],
  ['\r', ' '],
  // Smart quotes: which one depends on the preceding character.
  ['"', '“”'],
  ["'", '‘’'],
  ['\u0000', '\ufffd'],
  // md4c emits an indented code block's leftover indent columns as spaces
  // (md4c.c `indent_chunk_str`), one-for-one only when columns equal tabs.
  ['\t', ' '],
]);

function selectionOffsets(length: number): number[] {
  if (length <= EXHAUSTIVE_LENGTH_LIMIT) {
    return Array.from({ length: length + 1 }, (_, i) => i);
  }
  const offsets: number[] = [];
  for (let i = 0; i <= length; i += STRIDE) offsets.push(i);
  if (offsets[offsets.length - 1] !== length) offsets.push(length);
  return offsets;
}

/**
 * Screen and copy legitimately differ on punctuation and whitespace, never on
 * letters.
 */
function lettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * The slice minus synthetic glyphs (`piece.source === null`), which have no
 * source to copy.
 */
function sourceBackedSlice(
  projected: ProjectedRun,
  start: number,
  end: number,
): string {
  let shown = '';
  for (const piece of projected.pieces) {
    if (piece.source === null) continue;
    const from = Math.max(piece.textStart, start);
    const to = Math.min(piece.textEnd, end);
    if (to > from) shown += projected.text.slice(from, to);
  }
  return shown;
}

/**
 * Verbatim text (`&ouml;` is six characters on screen) re-parses differently
 * once copied out.
 */
function verbatimRanges(doc: ParsedDocument): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  visit(doc, (node) => {
    if (
      node.kind === 'codeSpan' ||
      node.kind === 'codeBlock' ||
      node.kind === 'htmlSpan' ||
      node.kind === 'htmlBlock'
    ) {
      ranges.push({ start: node.span.start, end: node.span.end });
    }
    return undefined;
  });
  return ranges;
}

/**
 * HTML blocks, fences, and link reference definitions mean something else in a
 * slice parsed alone.
 */
const OPENS_AN_UNFINISHABLE_BLOCK = /^ {0,3}(?:<|`{3,}|~{3,}|\[[^\]\n]*\]:)/m;

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

  /**
   * An empty flowing run draws nothing; this also guards `emitsOwnText` in
   * runs.ts, which mirrors the projector by hand.
   */
  it('every flowing run projects non-empty text', () => {
    let runs = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { run, projected } of proseRuns(doc)) {
        runs++;
        if (projected.text.length === 0) {
          const kinds = run.blocks.map((block) => block.kind).join(', ');
          throw new Error(
            `${label}: a flowing run over [${kinds}] projects the empty ` +
              'string, so it would draw nothing at all',
          );
        }
      }
    }
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

  /**
   * Subsequence, not equality: copy may add markers and respell punctuation,
   * but never drop a swept letter.
   */
  it('copy returns exactly the mapped source slice, and loses nothing swept', () => {
    let copies = 0;
    let checked = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      const verbatim = verbatimRanges(doc);
      for (const { projected } of proseRuns(doc)) {
        const offsets = selectionOffsets(projected.text.length);
        for (const start of offsets) {
          for (const end of offsets) {
            if (end <= start) continue;
            const span = mapSelectionToSource(projected, { start, end });
            if (span === null) continue;
            const payload = buildCopyPayload(doc, span, { options });
            copies++;
            if (payload.markdown !== doc.source.slice(span.start, span.end)) {
              throw new Error(
                `${label}: copy payload markdown is not the source slice for ` +
                  `${JSON.stringify(span)}`,
              );
            }
            if (typeof payload.plain !== 'string') {
              throw new Error(`${label}: copy payload has no plain text`);
            }
            if (
              verbatim.some((r) => r.start < span.end && r.end > span.start) ||
              OPENS_AN_UNFINISHABLE_BLOCK.test(payload.markdown)
            ) {
              continue;
            }
            checked++;
            const swept = lettersAndDigits(
              sourceBackedSlice(projected, start, end),
            );
            if (!isSubsequence(swept, lettersAndDigits(payload.plain))) {
              throw new Error(
                `${label}: selecting [${start},${end}) showed ` +
                  `${JSON.stringify(projected.text.slice(start, end))} but the ` +
                  `copy of ${JSON.stringify(span)} reads ` +
                  `${JSON.stringify(payload.plain)}, which does not carry every ` +
                  'letter that was swept',
              );
            }
          }
        }
      }
    }
    expect(copies).toBeGreaterThan(100_000);
    // The exclusions must not be what carries the test.
    expect(checked).toBeGreaterThan(80_000);
  });

  /**
   * Offsets map through a linear piece code unit for code unit, so one pinned
   * to the wrong source shifts them all.
   */
  it('every linear piece displays the source it is pinned to', () => {
    let linear = 0;
    let nonLinear = 0;
    let indivisibleSource = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { projected } of proseRuns(doc)) {
        for (const piece of projected.pieces) {
          if (piece.source === null) continue;
          const text = projected.text.slice(piece.textStart, piece.textEnd);
          const src = doc.source.slice(piece.source.start, piece.source.end);
          // A non-linear piece (decoded entity, alt text, embed) is indivisible
          // by design.
          if (text.length !== src.length) {
            nonLinear++;
            indivisibleSource += src.length;
            continue;
          }
          linear++;
          for (let i = 0; i < src.length; i++) {
            if (src[i] === text[i]) continue;
            const allowed = PROJECTED_SUBSTITUTIONS.get(src[i]);
            if (allowed !== undefined && allowed.includes(text[i])) continue;
            throw new Error(
              `${label}: linear piece ${JSON.stringify(piece)} shows ` +
                `${JSON.stringify(text)} for source ${JSON.stringify(src)}`,
            );
          }
        }
      }
    }
    expect(linear).toBeGreaterThan(1_000);
    // Gate indivisible source characters, never the piece count: splitting a
    // piece raises the count and is an improvement.
    if (indivisibleSource >= 850) {
      throw new Error(
        `${indivisibleSource} source characters are pinned indivisibly, over ` +
          `${nonLinear} non-linear pieces — the ceiling is 850 characters, and ` +
          'there is none on the piece count',
      );
    }
  });

  /**
   * Block syntax projects no text, so `ProjectedExtent` must restore it;
   * containment, since a wider hull loses nothing.
   */
  it('a whole-block selection maps to a span covering that block', () => {
    const syntaxBearing = new Set([
      'heading',
      'blockquote',
      'list',
      'codeBlock',
      'table',
    ]);
    let checked = 0;
    for (const { label, source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { run } of proseRuns(doc)) {
        for (const block of run.blocks) {
          if (!syntaxBearing.has(block.kind)) continue;
          const projected = projectRun({ ...run, blocks: [block] }, doc);
          if (projected.text.length === 0) continue;
          const span = mapSelectionToSource(projected, {
            start: 0,
            end: projected.text.length,
          });
          if (span === null) continue;
          checked++;
          if (span.start > block.span.start || span.end < block.span.end) {
            throw new Error(
              `${label}: selecting the whole of a ${block.kind} mapped to ` +
                `${JSON.stringify(span)}, which does not cover the block's own ` +
                `span ${JSON.stringify(block.span)} — its markers would be ` +
                'lost from the copy',
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  /**
   * A census, not an assertion: re-parse equality is still false for whole
   * classes of block; the floor catches lossier copy.
   */
  it('records how many whole-block copies come back as themselves', () => {
    let blocks = 0;
    let roundTrips = 0;
    for (const { source } of corpus) {
      const doc = parseDocument(source, options);
      for (const { run } of proseRuns(doc)) {
        for (const block of run.blocks) {
          const projected = projectRun({ ...run, blocks: [block] }, doc);
          if (projected.text.length === 0) continue;
          const span = mapSelectionToSource(projected, {
            start: 0,
            end: projected.text.length,
          });
          if (span === null) continue;
          blocks++;
          if (buildCopyPayload(doc, span, { options }).plain === projected.text) {
            roundTrips++;
          }
        }
      }
    }
    expect(blocks).toBeGreaterThan(700);
    expect(roundTrips).toBeGreaterThan(680);
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
            const payload = buildCopyPayload(doc, span, {
              options,
              // `plain` must show placeholders where the screen does; the
              // lookup sees nodes reparsed from the slice, so it claims by
              // shape.
              embed: claimLinks,
            });
            if (payload.markdown !== doc.source.slice(span.start, span.end)) {
              throw new Error(
                `${label}: embed copy payload is not the source slice for ` +
                  JSON.stringify(span),
              );
            }
            if (payload.plain.includes('\ufffc')) {
              throw new Error(
                `${label}: embed copy payload left a raw placeholder in plain: ` +
                  JSON.stringify(payload.plain),
              );
            }
          }
        }
      }
    }
    expect(mapped).toBeGreaterThan(5_000);
  });
});
