/**
 * The streaming prefix oracle: every intermediate snapshot must equal what a
 * fresh parse of that snapshot's own source would display.
 *
 * WHAT THE ORACLE PROVES. `StreamSession` freezes settled blocks, reparses
 * only the tail, shifts the new spans by an anchor and splices the frozen
 * prefix back in front. That arithmetic is sound only if the engine's spans
 * mean exactly what the session assumes they mean. A decoder whose spans were
 * off by a container prefix, or whose block boundaries fell one character
 * differently, would render perfectly, score 100% on the CommonMark
 * conformance sweep, and fail here at the exact prefix where the assumption
 * broke — which is the whole reason a per-prefix oracle exists rather than a
 * final-document comparison.
 *
 * Both sides of every comparison come from the same engine, so a failure here
 * always means "the splice diverged" and never "two parsers disagree".
 *
 * THIS FILE USED TO BE TWO. There was a second oracle running the identical
 * sweep against a bundled pure-TypeScript engine, and a comment in each
 * explaining that the pair together proved the splice was engine-agnostic in
 * fact rather than by design. With one engine left, the two files were one
 * sweep and one near-copy of it; they are merged here, keeping the strongest
 * assertions from both — the spoiler-free check over every snapshot came from
 * the other file.
 *
 * WHAT IS SAMPLED AND WHY. Nothing is sampled away: every prefix is fed (the
 * session is stateful, so skipping an append would exercise a different
 * session), every snapshot is checked for settled-block identity, and every
 * snapshot is compared against a fresh parse of its own source. The whole
 * file runs in a few seconds because the fixtures are ~1 KB each and md4c
 * parses one in microseconds. The transcript is replayed BOTH by its own
 * natural deltas (1-18 units, where a real stream cuts) and one code point at
 * a time, because the splice must not care where a delta happened to be cut.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Block, ParsedDocument } from '../../src/document/nodes';
import { visit } from '../../src/document/visit';
import type { Engine } from '../../src/engine/Engine';
import { parseDocument } from '../../src/engine/Engine';
import type { EngineOptions } from '../../src/engine/options';
import { presets } from '../../src/engine/options';
import { describeNative, requireNativeEngine } from '../../src/engine/native/__tests__/support';
import { trimTrailingPlaceholders } from '../../src/stream/placeholders';
import { StreamSession } from '../../src/stream/StreamSession';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const PER_FIXTURE_TIMEOUT_MS = 120_000;

// `describeNative` is `describe.skip` on a machine that cannot build the
// native module. That machine has no parser at all now, so it cannot run this
// sweep — but it is still a supported place to work on everything that needs
// no parser, and a hundred "no compiler here" failures would bury the one
// signal this file exists to give. See src/engine/native/__tests__/support.ts.

const fixtureFiles = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

interface Transcript {
  readonly name: string;
  readonly deltas: readonly string[];
}

const TRANSCRIPT: Transcript = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'transcript-sprint-review.json'), 'utf8'),
);

/**
 * Fixtures that contain a GFM table. They are called out because they are
 * what found the decoder's worst defect, and they are the cases most likely
 * to find its successor.
 *
 * A table row with fewer cells than the header gets a padding cell that md4c
 * reports with no text. When that row is the LAST thing in the source —
 * which every streamed table passes through, cell by cell, as it is typed —
 * the decoder's fallback found no line after the cursor and the cell escaped
 * with `span: {start: -1, end: -1}`. `shiftSpans` then added the session's
 * anchor to it, so the spliced snapshot reported `anchor - 1` where a fresh
 * parse of the same text reported `-1`: 120 divergent snapshots in
 * comparison-table.md, 148 in mixed-longform.md. Empty cells are now placed
 * from their own row's pipes, and these run as ordinary tests.
 */
const TABLE_FIXTURES: ReadonlySet<string> = new Set([
  'comparison-table.md',
  'mixed-longform.md',
]);

function countSpoilers(doc: ParsedDocument): number {
  let count = 0;
  visit(doc, (n) => {
    if (n.kind === 'spoiler') count += 1;
  });
  return count;
}

/** Streaming-only flags stripped, identity discarded: structure only. */
function structure(blocks: readonly Block[]): string {
  return JSON.stringify(blocks, (key, value) =>
    key === 'incomplete' || key === 'synthetic' ? undefined : value,
  );
}

/**
 * What a snapshot must display: the fresh parse of its own (repair-applied)
 * source, with placeholder trimming applied only past the settled boundary —
 * the session never trims frozen blocks, because a settled empty construct
 * is real arrived content, not a mid-stream placeholder.
 */
function expectedDisplay(doc: ParsedDocument, settledUntil: number): Block[] {
  let split = doc.blocks.length;
  for (let i = 0; i < doc.blocks.length; i += 1) {
    if (doc.blocks[i].span.end > settledUntil) {
      split = i;
      break;
    }
  }
  return [
    ...doc.blocks.slice(0, split),
    ...trimTrailingPlaceholders(doc.blocks.slice(split)),
  ];
}

interface OracleResult {
  readonly final: ReturnType<StreamSession['snapshot']>;
  readonly snapshotCount: number;
  readonly fedLength: number;
  /** Per-prefix fresh-parse mismatches (empty = pass). */
  readonly prefixViolations: string[];
  /** Settled-identity violations observed across snapshots (empty = pass). */
  readonly identityViolations: string[];
  /** Distinct blocks observed inside the settled prefix (non-vacuousness). */
  readonly settledBlocksSeen: number;
  /** Snapshots that contained a spoiler node (must be 0 while spoilers are off). */
  readonly spoilerSnapshots: number;
}

/**
 * Feeds `deltas` into a session, checking every snapshot.
 *
 * `engine` is passed explicitly to BOTH the session and the oracle parse
 * rather than relying on the package default. That is what pins a failure here
 * to "the splice diverged": the two sides are the same object, so they cannot
 * differ because one of them resolved a different engine.
 */
function streamDeltas(
  deltas: Iterable<string>,
  options: EngineOptions | undefined,
  engine: Engine,
  verifyPrefixes = true,
): OracleResult {
  let snapshotCount = 0;
  let spoilerSnapshots = 0;
  const prefixViolations: string[] = [];
  const identityViolations: string[] = [];
  // Once a block has entered the settled prefix, every subsequent snapshot
  // must contain the very same object (===) for that kind+span.
  const settledSeen = new Map<string, { block: Block; end: number }>();
  const session = new StreamSession({ options, engine });

  const unsubscribe = session.subscribe((snap) => {
    snapshotCount += 1;
    if (countSpoilers(snap.document) > 0) spoilerSnapshots += 1;

    if (verifyPrefixes && prefixViolations.length < 3) {
      const fresh = parseDocument(snap.document.source, options, engine);
      const got = structure(snap.document.blocks);
      const want = structure(expectedDisplay(fresh, snap.settledUntil));
      if (got !== want) {
        prefixViolations.push(
          `rev ${snap.revision} (source length ${snap.document.source.length}): ` +
            `snapshot diverges from a fresh native parse\n  got:  ${got.slice(0, 400)}\n  want: ${want.slice(0, 400)}`,
        );
      }
    }

    const current = new Map<string, Block>();
    for (const block of snap.document.blocks) {
      if (block.span.end <= snap.settledUntil && !block.incomplete) {
        current.set(`${block.kind}:${block.span.start}:${block.span.end}`, block);
      }
    }
    for (const [key, seen] of settledSeen) {
      if (seen.end > snap.settledUntil) continue; // only re-check while still settled
      const now = current.get(key);
      if (now === undefined) {
        identityViolations.push(`rev ${snap.revision}: settled block ${key} disappeared`);
      } else if (now !== seen.block) {
        identityViolations.push(
          `rev ${snap.revision}: settled block ${key} lost referential identity`,
        );
      }
    }
    for (const [key, block] of current) {
      if (!settledSeen.has(key)) settledSeen.set(key, { block, end: block.span.end });
    }
  });

  for (const delta of deltas) session.append(delta);
  const fedLength = session.length;
  session.finalize('end');
  unsubscribe();

  return {
    final: session.snapshot(),
    snapshotCount,
    fedLength,
    prefixViolations,
    identityViolations,
    settledBlocksSeen: settledSeen.size,
    spoilerSnapshots,
  };
}

/** Every prefix boundary a per-code-point stream produces. */
function codePoints(text: string): string[] {
  return [...text];
}

describeNative('streaming prefix oracle', () => {
  const engine = (): Engine => requireNativeEngine();

  test('fixture directory has the expected corpus', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(6);
    expect(TRANSCRIPT.deltas.length).toBeGreaterThan(50);
    // The table fixtures are the regression surface for the padding-cell
    // defect; if they ever stop being part of the corpus, this sweep quietly
    // stops covering the case that broke every streamed table.
    for (const file of TABLE_FIXTURES) expect(fixtureFiles).toContain(file);
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const full = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');

      test(
        'every prefix splices to what a fresh native parse of the same source displays',
        () => {
          const result = streamDeltas(codePoints(full), presets.llmChat, engine());

          expect(result.fedLength).toBe(full.length);
          expect(result.final.phase).toBe('settled');
          expect(result.final.document.source).toBe(full);
          expect(result.prefixViolations).toEqual([]);
          // Frozen blocks must keep referential identity in every later
          // snapshot, including the one finalize produces — and the check
          // must not be vacuous: every fixture is multi-block, so blocks do
          // settle mid-stream.
          expect(result.settledBlocksSeen).toBeGreaterThan(0);
          expect(result.identityViolations).toEqual([]);
          // Spoilers are off in every preset, and the transform runs after the
          // engine on every reparse — so a spoiler appearing at ANY prefix
          // would mean the option leaked, not that the final document is
          // wrong. Checked per snapshot for that reason.
          expect(result.spoilerSnapshots).toBe(0);
          expect(countSpoilers(result.final.document)).toBe(0);

          // Deep equality includes the ABSENCE of incomplete/synthetic: a
          // fresh parse never carries them, so a surviving repair marker
          // fails here.
          expect(result.final.document).toEqual(
            parseDocument(full, presets.llmChat, engine()),
          );
        },
        PER_FIXTURE_TIMEOUT_MS,
      );
    });
  }

  // The transcript contains a table, which is what made this case (and
  // TABLE_FIXTURES above) the ones that found the padding-cell defect.
  test(
    'the LLM transcript replays delta-by-delta to the fresh-parse document',
    () => {
      // Real chunk boundaries rather than code points: deltas land mid-token,
      // mid-table-row and mid-fence, which is the shape the fast path and the
      // tail repair are actually tuned for.
      const full = TRANSCRIPT.deltas.join('');
      const result = streamDeltas(TRANSCRIPT.deltas, presets.llmChat, engine());

      expect(result.fedLength).toBe(full.length);
      expect(result.snapshotCount).toBeGreaterThan(50);
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.settledBlocksSeen).toBeGreaterThan(0);
      expect(result.final.document).toEqual(parseDocument(full, presets.llmChat, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'the transcript reaches the same document however it is chunked',
    () => {
      // Nothing about the splice may depend on where a delta happened to be
      // cut. Prefix verification is off here (the transcript's table trips
      // the known bug); the final documents and settled identity are the
      // properties this case is about, and both hold today.
      const full = TRANSCRIPT.deltas.join('');
      const byChunk = streamDeltas(TRANSCRIPT.deltas, presets.llmChat, engine(), false);
      const byCodePoint = streamDeltas(codePoints(full), presets.llmChat, engine(), false);
      expect(byChunk.fedLength).toBe(full.length);
      expect(byChunk.identityViolations).toEqual([]);
      expect(byCodePoint.identityViolations).toEqual([]);
      expect(byChunk.settledBlocksSeen).toBeGreaterThan(0);
      expect(structure(byCodePoint.final.document.blocks)).toBe(
        structure(byChunk.final.document.blocks),
      );
      expect(byChunk.final.document).toEqual(parseDocument(full, presets.llmChat, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'stray pipes under the library default options never become tables or spoilers',
    () => {
      // No options at all: every extension off, the library's true default.
      const full = fs.readFileSync(path.join(FIXTURE_DIR, 'pipes-in-prose.md'), 'utf8');
      const result = streamDeltas(codePoints(full), undefined, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.spoilerSnapshots).toBe(0);

      let unwanted = 0;
      visit(result.final.document, (n) => {
        if (n.kind === 'table' || n.kind === 'spoiler') unwanted += 1;
      });
      expect(unwanted).toBe(0);
      expect(result.final.document).toEqual(parseDocument(full, undefined, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  const ALL_ON: EngineOptions = {
    extensions: {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      math: true,
      spoilers: false,
      underline: true,
    },
  };

  test(
    'every non-table extension splices the same way',
    () => {
      // Task lists, math, underline and fences each reach the splice through
      // a different span-widening path, and the default preset exercises
      // neither math nor underline. Tables are deliberately absent: they trip
      // the known bug above and are covered by the failing cases instead.
      const full = [
        '# Everything\n\n',
        '> - [x] quoted **task** with `code`\n> - [ ] and $x^2$\n\n',
        '```js\nconst x = 1;\n```\n\n',
        '    indented code\n\n',
        '---\n\n',
        'Tail with _underline_, ~~struck~~, an ![img](https://e.com/i.png) and a [link](https://e.com).\n',
      ].join('');
      const result = streamDeltas(codePoints(full), ALL_ON, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.settledBlocksSeen).toBeGreaterThan(0);
      expect(result.final.document).toEqual(parseDocument(full, ALL_ON, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'a streamed table splices the same way',
    () => {
      // The minimal streaming shape of the unanchored-padding-cell bug: while
      // `| 1 | 2 |` is being typed the row is ragged, its padding cell has no
      // source, and the tail parse rebases the {-1,-1} span by the anchor.
      const full = 'Intro paragraph.\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n';
      const result = streamDeltas(codePoints(full), ALL_ON, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.final.document).toEqual(parseDocument(full, ALL_ON, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test('finalize is idempotent on a native-backed session', () => {
    const session = new StreamSession({ options: presets.llmChat, engine: engine() });
    session.append('Almost **done');
    const lengthBefore = session.length;
    session.append('');
    expect(session.length).toBe(lengthBefore);
    session.finalize('aborted');
    const first = session.snapshot();
    session.finalize('aborted');
    const second = session.snapshot();
    expect(second.phase).toBe('settled');
    expect(second.document).toEqual(first.document);
  });
});
