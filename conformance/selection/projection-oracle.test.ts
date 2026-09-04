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
 * Every one-for-one character substitution the projection is allowed to make
 * inside a LINEAR piece, keyed by the source character. Anything else that
 * changes a character changes its length too (`--` → `–`, `&amp;` → `&`) and
 * so cannot appear in a linear piece at all.
 */
const PROJECTED_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  // A soft break renders as a space — docs/FABRIC-PLAN.md §6.1(a), and the
  // guard below this block.
  ['\n', ' '],
  ['\r', ' '],
  // Smart punctuation, under the presets that enable it. Which curly quote
  // depends on what preceded it, so both are allowed here.
  ['"', '“”'],
  ["'", '‘’'],
  // A NUL is replaced at decode time (`appendText`, decode.ts).
  ['\u0000', '\ufffd'],
  // An indented code block's leftover indent. md4c consumes four columns of
  // indent to make the block and emits the remainder as SPACES
  // (md4c.c:5355-5357, `indent_chunk_str`), so `- foo\n\n\t\tbar` shows two
  // spaces for two source tabs — eight columns, six eaten by the item indent
  // plus the code indent, two left. The expansion is one-for-one only when
  // the leftover column count happens to equal the source character count;
  // every other ratio changes the length and so cannot be a linear piece at
  // all. Where it IS one-for-one the mapping is honest — display offset i is
  // source offset i, both inside the indent — which is exactly the property
  // this list exists to enumerate.
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
 * Letters and digits, everything else dropped.
 *
 * The sub-block sweep compares what was on screen against what the copy shows,
 * and the two legitimately disagree about punctuation and whitespace: a soft
 * break is a space on screen and a newline in the slice, a smart quote is one
 * character on screen and two in the source, a list the selection covered
 * whole comes back with markers the screen drew as glyphs. None of that is
 * loss. Losing a LETTER is.
 */
function lettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whether every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * The part of a display slice that came from the SOURCE — the selection minus
 * every synthetic glyph in it.
 *
 * A marker glyph (`• `, `1. `) is projected from no source at all
 * (`piece.source === null`), so a selection that sweeps one and stops short of
 * the construct it belongs to copies characters the glyph is not among. That
 * is the projection working as designed, not the copy losing text, so the
 * glyphs are removed from the side being compared rather than excused
 * afterwards.
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
 * Source ranges whose text is shown VERBATIM: code spans, code blocks and raw
 * HTML.
 *
 * Inside one of these the screen shows the characters as they are written, so
 * `&ouml;` is six characters on screen. Copy hands back that slice, and
 * `buildCopyPayload` re-parses it — as markdown, where `&ouml;` is one
 * character. The copy did not lose the text; the text stopped being verbatim
 * the moment it left the block it was written in. That is exactly the "a slice
 * can mean something else standing alone" caveat in `copy.ts`, and it is why
 * the sweep skips selections that touch one.
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
 * A line that OPENS a block whose visible output depends on text the slice
 * does not carry: an HTML block, a code fence, or a link reference definition.
 *
 * All three render as nothing (or as their own contents, which the slice cut
 * off) when the slice is parsed on its own, however ordinary the characters
 * looked on screen. `[bar]: /baz` is body text in the middle of a paragraph
 * and a definition at the start of one; ```` ```foo ```` is an unterminated
 * fence whose body is empty. Same family as `verbatimRanges` — the slice means
 * something else standing alone — but detectable only in the SLICE, since in
 * the document these lines were nothing of the kind.
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
   * THE INVARIANT `segmentRuns` EXISTS TO ENFORCE, held over the corpus
   * instead of over a handful of hand-built blank documents.
   *
   * A run that projects nothing draws nothing. `resolveRunAttributes` returns
   * no attributed string for empty text, both native hosts measure it to a
   * 0×0 box, and both skip decoration drawing at zero length — so a FLOWING
   * run with no characters is a hole where a block should be. Segmentation
   * demotes any group whose blocks all project nothing to standalone runs,
   * where the built-in renderers draw the rule, the code box or the quote bar
   * instead.
   *
   * The corpus has 18 such groups under `llmChat` and they are not exotic:
   * `## ` (example 79), an unterminated ``` fence (126), `>` (239), a link
   * with empty text (484). The first two are what a stream looks like one
   * chunk before its content arrives.
   *
   * This is also the guard on `emitsOwnText` in runs.ts, which mirrors the
   * projector's emission rules by hand: a kind that stops projecting text but
   * stays on that list starts failing here.
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
   * WHAT THIS PROVES, AND WHAT IT DOES NOT.
   *
   * It proves that copy SURVIVES the corpus: `buildCopyPayload` re-parses and
   * re-projects every slice, and a slice that cuts a construct in half — the
   * majority of the selections swept here — is exactly the input that could
   * throw or hang. It also pins `markdown` as a pure slice, which is the one
   * thing about it a future change could quietly alter.
   *
   * IT ALSO PROVES THAT NOTHING SWEPT IS LOST. For every one of those
   * selections it takes the characters the run actually showed for real source
   * (`sourceBackedSlice`), reduces both sides to letters and digits, and
   * requires the swept ones to appear in `payload.plain` IN ORDER. Copy is
   * allowed to give back more than was swept — a selection that covers a
   * construct whole gets its markers and syntax back, and reparsing renders
   * them — and it is allowed to spell punctuation and whitespace differently.
   * It is not allowed to drop a letter. That is what a paste has to be worth,
   * and it is the assertion an offset regression fails: shifting every mapped
   * span by ONE character (the shape of the bug the linear-piece test above
   * exists for) turns 0 violations into 63,388.
   *
   * Three enumerated exclusions, each of them "the slice means something else
   * standing alone" rather than a hole in the property: synthetic glyphs are
   * removed from the swept side rather than looked for in the copy
   * (`sourceBackedSlice`); a selection touching verbatim text is skipped
   * (`verbatimRanges`); and so is a slice that opens a block it does not
   * finish (`OPENS_AN_UNFINISHABLE_BLOCK`). What is left is ~89,000 selections
   * under llmChat and ~85,000 under everything, all of them clean.
   *
   * It does NOT prove the reparse property that copy once claimed ("markdown
   * re-parses to the same visible text as the selection") — subsequence is
   * weaker than equality, and today only 57,333 of the 136,365 selections
   * swept under `llmChat` come back character-identical (54,343 of 129,861
   * under `everything`). Under the bounds the test above establishes, the
   * `markdown` equality here restates `doc.source.slice(...)` back at itself
   * and cannot fail. And the equality property itself is false for PARTIAL
   * selections: a block's own syntax — a heading's
   * `# `, a quote's `> `, a list marker, a fence — projects no text, so it
   * belongs to no piece, and only a selection that covers the whole construct
   * gets it back (`mapSelectionToSource` unions the covering
   * `ProjectedExtent`s into the hull). So selecting the whole of
   * `1. first\n2. second` does copy `1. first\n2. second` and re-parses to
   * the same list — while a selection that starts one character into the
   * first item copies `first\n2. second`, which re-parses to one paragraph.
   * That loss is measured rather than asserted away — see the round-trip
   * census below, which counts whole-block copies precisely because those are
   * the ones the extents can save.
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
    // The exclusions must not be what carries the test: the great majority of
    // the sweep is still subject to the subsequence property.
    expect(checked).toBeGreaterThan(80_000);
  });

  /**
   * A LINEAR PIECE SHOWS ITS OWN SOURCE — the invariant every offset in the
   * library rests on, and the one the fixtures cannot check.
   *
   * `mapSelectionToSource` maps a piece whose display length equals its source
   * length code-unit for code-unit. That arithmetic is only meaningful if the
   * piece is pinned to the source the display actually came from, and a piece
   * can be linear and WRONG: a fenced block whose body also occurs inside its
   * info string (```` ```js\njs\n``` ````) used to pin to the fence line —
   * same length, so every offset in the block mapped one construct to the
   * left and nothing downstream noticed. The check is character-level and the
   * exceptions are enumerated: the projection is allowed the one-for-one
   * substitutions in `PROJECTED_SUBSTITUTIONS` — soft breaks, both smart
   * quotes, NUL, and an indented block's leftover indent — and no others.
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
          // A non-linear piece is indivisible by design (decoded entity, alt
          // text, an embed placeholder) — nothing claims its text is its
          // source.
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
    // A CEILING ON WHAT IS PINNED INDIVISIBLY, because "correct" is not the
    // only thing that matters here: a piece whose display length differs from
    // its source length cannot be subdivided, so every selection touching it
    // copies the whole thing. The measure is SOURCE CHARACTERS, not pieces,
    // and there is deliberately NO ceiling on the piece count — splitting one
    // 96-character indivisible piece into three small ones raises the count
    // and is exactly the improvement wanted, so a count gates the wrong
    // direction. (One stood here for a while at `nonLinear < 110`, eleven
    // above the 99 the corpus produces, contradicting this paragraph directly
    // above it: the next split would have turned the suite red for getting
    // better. `nonLinear` is still counted, because it is what makes the
    // character total legible in a failure.)
    //
    // `alignLiteral` covers a diverged literal with linear runs wherever the
    // source still spells the display (an escaped `\*`, an `&amp;`) and pins
    // only the respelled stretch itself (`&hellip;`, `--`, an image's alt
    // text) — where a one-for-one respelling like a smart quote even stays
    // linear. Today that is 603 source characters over 90 pieces under
    // llmChat and 628 over 99 under everything; before the literal was
    // covered piecewise, a single escape made the enclosing PARAGRAPH one
    // indivisible piece, and before `nextResync` learned to hold the source
    // cursor still (mapSelection.ts) it was roughly twice this — a literal
    // whose display carries characters the slice never had, an indented code
    // block's synthesized indent above all, fell back to a whole-span pin.
    if (indivisibleSource >= 700) {
      throw new Error(
        `${indivisibleSource} source characters are pinned indivisibly, over ` +
          `${nonLinear} non-linear pieces — the ceiling is 700 characters, and ` +
          'there is none on the piece count',
      );
    }
  });

  /**
   * A WHOLE-CONSTRUCT SELECTION COPIES THE WHOLE CONSTRUCT — the property
   * `ProjectedExtent` exists for, held over every syntax-bearing block in the
   * corpus.
   *
   * A block's own syntax projects no text: a heading's `# `, a quote's `> `, a
   * list item's marker, a fence, a table's pipes. It therefore belongs to no
   * piece, and the hull of the pieces a selection touched used to be the whole
   * answer — so selecting a whole list and copying it yielded `one\n- two`,
   * which re-parses as a paragraph followed by a one-item list. The mapped
   * span must now CONTAIN the block's own source span whenever the selection
   * covers the block's whole projected range.
   *
   * Containment rather than equality, because the property under test is that
   * nothing is LOST: a hull wider than the block copies more context than the
   * user swept, which is at worst untidy, while a narrower one drops the
   * markers and changes what the paste means. Every block in the corpus in
   * fact lands on equality today (checked by tightening this to `!==` and
   * running it), so containment is headroom rather than slack — the case that
   * used to need it, an indented code block whose literal fell back to a
   * whole-span pin, is gone with `nextResync`'s held candidate in
   * src/selection/mapSelection.ts.
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
    // The corpus really is full of headings, lists, quotes, fences and
    // tables, so a regression cannot pass by having nothing left to check.
    expect(checked).toBeGreaterThan(200);
  });

  /**
   * THE ROUND-TRIP CENSUS: the reparse property, measured.
   *
   * "Copy this block and paste it somewhere else" is the gesture copy exists
   * for, so this walks every block of every prose run in the corpus, selects
   * all of its projected text, and asks whether the copied markdown shows the
   * same characters again. It cannot be an assertion — the property is still
   * false for whole classes of block, and the counts below say by how much:
   *
   *   - a slice can mean something else on its own: CommonMark example 65's
   *     paragraph text is literally `## foo`, which re-parses as a heading;
   *   - a REFERENCE link or image points at a definition somewhere else in the
   *     document, which no slice of one block can carry;
   *   - an indented fence loses its relative indent, because the slice starts
   *     at the fence rather than at the line;
   *   - a trailing newline or trailing spaces do not survive a re-parse.
   *
   * What is no longer on that list is the big one: a block's own syntax used
   * to fall outside the hull, so a list copied without its markers, a quote
   * without its `> ` and a fenced block without its fences. `ProjectedExtent`
   * put those back (see the test above), and the count went from 493 of 761 to
   * 696 — the floor below is what holds it there. A change that makes copy
   * lossier — a piece pinned to the wrong source, a hull that stops covering
   * what the user swept — drops the count and fails here.
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
              // The lookup belongs in the copy context for the same reason it
              // belongs in the projection: without it, `plain` would project
              // every claimed node's own text where the screen shows one
              // placeholder. It is offered nodes from the reparse of this
              // slice, so it has to claim by shape — which is what makes
              // `node.kind === 'link'` the right kind of claim to sweep with.
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
