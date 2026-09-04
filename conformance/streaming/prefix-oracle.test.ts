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
import { DEFAULT_LINK_PREFIXES, presets } from '../../src/engine/options';
import { describeNative, requireNativeEngine } from '../../src/engine/native/__tests__/support';
import { trimTrailingPlaceholders } from '../../src/stream/placeholders';
import type { BufferScheduler, IdleScheduler } from '../../src/stream/StreamSession';
import { StreamSession } from '../../src/stream/StreamSession';
import { createSmoother } from '../../src/stream/smoothing';

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

/**
 * How the deltas reach the session.
 *
 * `'append'` is the direct entry point. `'buffered'` is the one an app
 * actually uses for a token stream — `appendBuffered` with a frame
 * scheduler, an idle scheduler, a `holdBackChars` tail and a `smoother`
 * metering the release — and until this existed, the whole coalescing path
 * had only ever run against a toy paragraph engine over bare prose (see
 * `src/stream/buffering.test.ts`). It matters here because holdback and
 * smoothing cut the stream at offsets nothing else picks: a flush commits
 * "everything up to 19 characters into the middle of a table row", which is a
 * prefix the per-code-point sweep never produces, and every one of those
 * commits faces the same fresh-parse oracle.
 */
type FeedMode = 'append' | 'buffered';

/** Manual stand-in for a frame/idle scheduler: fires only when told to. */
function manualScheduler() {
  let next: (() => void) | null = null;
  return {
    schedule(flush: () => void): () => void {
      next = flush;
      return () => {
        next = null;
      };
    },
    /** Fires the pending callback (clearing it first, so a re-schedule from
     * inside the flush survives). Returns false when nothing was armed. */
    fire(): boolean {
      const f = next;
      next = null;
      f?.();
      return f !== null;
    },
  };
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
  mode: FeedMode = 'append',
): OracleResult {
  let snapshotCount = 0;
  let spoilerSnapshots = 0;
  const prefixViolations: string[] = [];
  const identityViolations: string[] = [];
  // Once a block has entered the settled prefix, every subsequent snapshot
  // must contain the very same object (===) for that kind+span.
  const settledSeen = new Map<string, { block: Block; end: number }>();
  const frame = manualScheduler();
  const idle = manualScheduler();
  // One frame per delta at 1200cps releases ~19 units a flush: fast enough
  // that the buffer tracks the stream rather than pooling the whole fixture,
  // slow enough that most flushes commit a partial construct.
  let clock = 0;
  const bufferScheduler: BufferScheduler = (flush) => frame.schedule(flush);
  const idleScheduler: IdleScheduler = (flush) => idle.schedule(flush);
  const session =
    mode === 'append'
      ? new StreamSession({ options, engine })
      : new StreamSession({
          options,
          engine,
          bufferScheduler,
          idleScheduler,
          holdBackChars: 4,
          now: () => clock,
          smoother: createSmoother({ charsPerSecond: 1200, now: () => clock }),
        });

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

  if (mode === 'append') {
    for (const delta of deltas) session.append(delta);
  } else {
    for (const delta of deltas) {
      session.appendBuffered(delta);
      clock += 16;
      frame.fire();
    }
    // Play the metered tail out at the same cadence instead of letting
    // finalize dump it: the drain's own flushes are prefixes too, and the
    // last few characters come back through the idle drain past the
    // holdback.
    for (let guard = 0; session.pendingLength > 0 && guard < 20_000; guard += 1) {
      clock += 16;
      if (!frame.fire() && !idle.fire()) break;
    }
  }
  // Deliberately `length`, not `length + pendingLength`: in buffered mode the
  // loop above must have played the whole buffer out through real flushes, so
  // a holdback or a smoother that stranded text fails here rather than being
  // covered up by finalize's drain.
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

  /**
   * Option sets the whole fixture corpus is swept under.
   *
   * `presets.llmChat` is what the package ships. The other two are the
   * options that DECOUPLE a text node's value from its source slice, which is
   * precisely the condition the parse-free fast path stands down on
   * (`if (text.value !== raw) return false`, `StreamSession.tryFastPath`):
   * `smartPunctuation` turns `"` into curly quotes and `--` into an en dash,
   * so value and source differ in length as well as content, and
   * `html: 'raw'` is the only mode that emits htmlBlock/htmlInline nodes at
   * all — nodes carrying source literals the splice has to rebase. Neither
   * had a single prefix case before, which left the guard that exists for
   * them ungated.
   */
  const FIXTURE_OPTION_SETS: ReadonlyArray<{
    name: string;
    options: EngineOptions;
  }> = [
    { name: 'llmChat', options: presets.llmChat },
    {
      name: 'smartPunctuation',
      options: { ...presets.llmChat, smartPunctuation: true },
    },
    { name: "html:'raw'", options: { ...presets.llmChat, html: 'raw' } },
  ];

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

      for (const { name, options } of FIXTURE_OPTION_SETS) {
        test(
          `every prefix splices to what a fresh native parse of the same source displays (${name})`,
          () => {
            const result = streamDeltas(codePoints(full), options, engine());

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
            // Spoilers are off in all three option sets, and the transform
            // runs after the engine on every reparse — so a spoiler appearing
            // at ANY prefix would mean the option leaked, not that the final
            // document is wrong. Checked per snapshot for that reason.
            expect(result.spoilerSnapshots).toBe(0);
            expect(countSpoilers(result.final.document)).toBe(0);

            // Deep equality includes the ABSENCE of incomplete/synthetic: a
            // fresh parse never carries them, so a surviving repair marker
            // fails here.
            expect(result.final.document).toEqual(
              parseDocument(full, options, engine()),
            );
          },
          PER_FIXTURE_TIMEOUT_MS,
        );
      }

      test(
        'the buffered entry point splices the same way, holdback and smoothing included',
        () => {
          // Same corpus, same oracle, fed the way an app feeds a token
          // stream: appendBuffered, a 4-character holdback, a metered
          // release and an idle drain for the tail. The commits land on
          // different prefixes than the per-code-point sweep produces, and
          // the run has to end with every character appended — a holdback
          // that stranded its tail, or a smoother that lost a cut, shows up
          // as a short `fedLength` here rather than in production.
          const result = streamDeltas(
            codePoints(full),
            presets.llmChat,
            engine(),
            true,
            'buffered',
          );

          expect(result.fedLength).toBe(full.length);
          expect(result.final.document.source).toBe(full);
          expect(result.prefixViolations).toEqual([]);
          expect(result.identityViolations).toEqual([]);
          expect(result.settledBlocksSeen).toBeGreaterThan(0);
          // Coalescing means fewer commits than characters — otherwise the
          // buffered path would be exercising nothing the append path does
          // not.
          expect(result.snapshotCount).toBeLessThan(full.length);
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

  test(
    'a streamed spoiler never paints its body in the clear',
    () => {
      // The tail repair closes an unpaired '||' so `applySpoilers` has a
      // pair to work with. Without it the transform sees one marker, returns
      // the paragraph untouched, and the hidden text renders as ordinary
      // prose in every snapshot from the second pipe until the closing run
      // arrives — the one construct whose whole job is to not be read.
      const src = 'The answer is ||hunter2|| and nothing else.\n';
      const secretStart = src.indexOf('hunter2');
      const secretEnd = secretStart + 'hunter2'.length;
      const options: EngineOptions = {
        extensions: { ...ALL_ON.extensions, spoilers: true },
      };

      const leaks: string[] = [];
      let covered = 0;
      const session = new StreamSession({ options, engine: engine() });
      const unsubscribe = session.subscribe((snap) => {
        const hidden: { start: number; end: number }[] = [];
        visit(snap.document, (n) => {
          if (n.kind === 'spoiler') hidden.push(n.span);
        });
        let sawSecret = false;
        visit(snap.document, (n) => {
          if (n.kind !== 'text') return;
          if (n.span.start >= secretEnd || n.span.end <= secretStart) return;
          sawSecret = true;
          const inside = hidden.some(
            (h) => h.start <= n.span.start && h.end >= n.span.end,
          );
          if (!inside) {
            leaks.push(`rev ${snap.revision}: ${JSON.stringify(n.value)} outside every spoiler`);
          }
        });
        if (sawSecret) covered += 1;
      });
      for (const cp of codePoints(src)) session.append(cp);
      session.finalize('end');
      unsubscribe();

      expect(leaks).toEqual([]);
      // Non-vacuous: the secret really was in the document for most of the
      // stream, and it ends up hidden.
      expect(covered).toBeGreaterThan(5);
      expect(countSpoilers(session.snapshot().document)).toBe(1);

      // And the splice still agrees with a fresh parse at every prefix.
      const result = streamDeltas(codePoints(src), options, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.spoilerSnapshots).toBeGreaterThan(0);
      expect(result.final.document).toEqual(parseDocument(src, options, engine()));
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test.each([
    [
      'a paragraph',
      'The answer is:\n\n||42 is the answer|| and nothing else.\n',
      '42 is the answer',
    ],
    [
      'a list item',
      'Answers:\n\n- ||hunter2|| first\n- plain second\n',
      'hunter2',
    ],
  ])(
    'a spoiler opening its line never paints its body in the clear (%s)',
    (_shape, src, secret) => {
      // The repair used to stand down on any line whose first character is a
      // pipe, on the theory that it might be a table row — which is exactly
      // what a spoiler opening its own line looks like, so the body leaked
      // for the whole stream in the commonest shape there is. Table
      // membership is now decided the way the parse decides it: a delimiter
      // row under a header line.
      const secretStart = src.indexOf(secret);
      const secretEnd = secretStart + secret.length;
      const options: EngineOptions = {
        extensions: { ...ALL_ON.extensions, spoilers: true },
      };

      const leaks: string[] = [];
      let covered = 0;
      const session = new StreamSession({ options, engine: engine() });
      const unsubscribe = session.subscribe((snap) => {
        const hidden: { start: number; end: number }[] = [];
        visit(snap.document, (n) => {
          if (n.kind === 'spoiler') hidden.push(n.span);
        });
        let sawSecret = false;
        visit(snap.document, (n) => {
          if (n.kind !== 'text') return;
          if (n.span.start >= secretEnd || n.span.end <= secretStart) return;
          sawSecret = true;
          const inside = hidden.some(
            (h) => h.start <= n.span.start && h.end >= n.span.end,
          );
          if (!inside) {
            leaks.push(
              `rev ${snap.revision}: ${JSON.stringify(n.value)} outside every spoiler`,
            );
          }
        });
        if (sawSecret) covered += 1;
      });
      for (const cp of codePoints(src)) session.append(cp);
      session.finalize('end');
      unsubscribe();

      expect(leaks).toEqual([]);
      expect(covered).toBeGreaterThan(5);
      expect(countSpoilers(session.snapshot().document)).toBe(1);

      // …and the splice still agrees with a fresh parse at every prefix.
      const result = streamDeltas(codePoints(src), options, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.final.document).toEqual(parseDocument(src, options, engine()));
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
    'raw HTML blocks splice the same way, blank lines and all',
    () => {
      // `html: 'raw'` is the only mode that produces htmlBlock nodes at all,
      // and nothing else in this sweep exercises it. CommonMark HTML blocks
      // of types 1-5 (`<!--`, `<script>`, `<pre>`) run PAST blank lines to
      // their own end condition, so anchoring one on the previous parse's
      // block end froze it truncated and parsed the rest of the block as
      // ordinary markdown for the rest of the stream. Type 6 (`<div>`) does
      // end at the blank line and must keep anchoring.
      const options: EngineOptions = { ...presets.llmChat, html: 'raw' };
      const full = [
        'Intro paragraph.\n\n',
        '<!-- a note\n\nstill inside the comment -->\n\n',
        '<div>\n  <span>type 6 ends at the blank line</span>\n</div>\n\n',
        '<script>\nvar a = 1;\n\nvar b = 2;\n</script>\n\n',
        'Closing prose.\n',
      ].join('');
      const result = streamDeltas(codePoints(full), options, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.settledBlocksSeen).toBeGreaterThan(0);
      expect(result.final.document).toEqual(
        parseDocument(full, options, engine()),
      );
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'bare ftp autolinks and list-item fences splice the same way',
    () => {
      // Two shapes no fixture contains. md4c permissive-autolinks ftp as
      // well as http/https, so an ftp tail must stand the fast path down
      // (allowlisted here, or the autolink would degrade to text and hide
      // the divergence); and a fence opened on a list-marker line must be
      // read as an opener, or its indented closer looks like one and the
      // anchor never advances again.
      const options: EngineOptions = {
        ...presets.llmChat,
        urlPolicy: { linkPrefixes: [...DEFAULT_LINK_PREFIXES, 'ftp://'] },
      };
      const full = [
        'Mirrors live at ftp://example.com/pub and https://example.com/pub.\n\n',
        '- ```sh\n  curl ftp://example.com/pub/file.txt\n  ```\n',
        '- and a second item with a _partial word\n\n',
        'Closing prose after the list.\n',
      ].join('');
      const result = streamDeltas(codePoints(full), options, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.settledBlocksSeen).toBeGreaterThan(0);
      expect(result.final.document).toEqual(
        parseDocument(full, options, engine()),
      );
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'a spoiler-enabled sweep splices the same way at every prefix',
    () => {
      // ALL_ON pins spoilers OFF so the corpus can assert their absence.
      // Spoilers are the one extension applied as a post-engine transform
      // over the decoded tree, so they are also the one whose result the
      // splice could disagree with — this runs the same sweep with them on,
      // over text that has both a real spoiler and a `||` that must stay
      // literal because its partner never arrives.
      const options: EngineOptions = {
        extensions: { ...ALL_ON.extensions, spoilers: true },
      };
      const full = [
        'Intro paragraph before anything hidden.\n\n',
        'The answer is ||hunter2|| and the runner-up is ||nobody||.\n\n',
        '- a list item with ||a hidden phrase|| inside\n',
        '- and one with a lone || that never closes\n\n',
        '| col | value |\n| :- | -: |\n| a | ||secret|| |\n\n',
        'Closing prose.\n',
      ].join('');
      const result = streamDeltas(codePoints(full), options, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.identityViolations).toEqual([]);
      expect(result.settledBlocksSeen).toBeGreaterThan(0);
      // Non-vacuous: spoilers really were in the streamed snapshots.
      expect(result.spoilerSnapshots).toBeGreaterThan(0);
      const fresh = parseDocument(full, options, engine());
      expect(countSpoilers(result.final.document)).toBe(countSpoilers(fresh));
      expect(countSpoilers(fresh)).toBeGreaterThan(0);
      expect(result.final.document).toEqual(fresh);
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'a link reference definition arriving after a settled paragraph splices the same way',
    () => {
      // The one construct that acts at a distance: the definition at the end
      // turns the `[foo]` in the FIRST paragraph — frozen by the anchor long
      // before it arrives — into a resolved reference link, and the `[bar]`
      // typed after it must resolve against a definition that sits below the
      // anchor. Nothing in the corpus contains one, and both directions used
      // to leave the snapshot (and the finalized document) showing literal
      // text where a fresh parse shows a link.
      const full = [
        'See [foo] here.\n\n',
        'A middle paragraph that settles.\n\n',
        '[foo]: https://example.com/foo\n',
        '[bar]: https://example.com/bar "titled"\n\n',
        'And [bar] afterwards.\n',
      ].join('');
      const result = streamDeltas(codePoints(full), presets.llmChat, engine());
      expect(result.prefixViolations).toEqual([]);
      expect(result.final.document).toEqual(
        parseDocument(full, presets.llmChat, engine()),
      );
      // Identity is the one thing a definition genuinely costs, and only
      // where it has to: the first paragraph's parse CHANGED, so it cannot
      // be the same object any more. Every other settled block keeps its
      // identity — the session drops the anchor, not the identity cache,
      // and `remember` re-checks structure before reusing an entry.
      expect(
        result.identityViolations.map((v) => v.replace(/^rev \d+: /, '')),
      ).toEqual(['settled block paragraph:0:15 lost referential identity']);
      // Non-vacuous: both references really did resolve.
      let links = 0;
      visit(result.final.document, (n) => {
        if (n.kind === 'link') links += 1;
      });
      expect(links).toBe(2);
      // And the buffered path reaches the same place.
      const buffered = streamDeltas(
        codePoints(full),
        presets.llmChat,
        engine(),
        true,
        'buffered',
      );
      expect(buffered.prefixViolations).toEqual([]);
      expect(buffered.final.document).toEqual(result.final.document);
    },
    PER_FIXTURE_TIMEOUT_MS,
  );

  test(
    'a definition behind a list item content indent splices the same way',
    () => {
      // The same construct written where md4c also honours it: at the
      // content column of a list item, with no marker of its own. A scan
      // that only stripped container MARKERS read those four spaces as
      // indented code, kept the first paragraph frozen as literal text, and
      // handed back a prefix a fresh parse disagrees with — and it did so
      // only for some delta granularities, since a line first seen as '    '
      // took a different path through the scan.
      const full = [
        'See [foo] here.\n\n',
        '- outer\n  - inner\n\n',
        '    [foo]: https://example.com/foo\n\n',
        'And more prose afterwards.\n',
      ].join('');
      for (const deltas of [
        codePoints(full),
        full.split(/(?<=\n)/),
        [full],
      ]) {
        const result = streamDeltas(deltas, presets.llmChat, engine());
        expect(result.prefixViolations).toEqual([]);
        expect(result.final.document).toEqual(
          parseDocument(full, presets.llmChat, engine()),
        );
      }
      // Non-vacuous: the reference really did resolve.
      let links = 0;
      visit(parseDocument(full, presets.llmChat, engine()), (n) => {
        if (n.kind === 'link') links += 1;
      });
      expect(links).toBe(1);
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
