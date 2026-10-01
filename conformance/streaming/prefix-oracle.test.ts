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

/*
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
 * `'buffered'` commits at holdback and smoothing cuts, prefixes the
 * per-code-point sweep never produces.
 */
type FeedMode = 'append' | 'buffered';

function manualScheduler() {
  let next: (() => void) | null = null;
  return {
    schedule(flush: () => void): () => void {
      next = flush;
      return () => {
        next = null;
      };
    },
    /**
     * Clears before firing, so a re-schedule from inside the flush survives.
     */
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
  // 1200cps over 16ms frames releases ~19 units a flush, so most flushes
  // commit a partial construct.
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
    // Drain at frame cadence rather than through finalize: those flushes are
    // prefixes too.
    for (let guard = 0; session.pendingLength > 0 && guard < 20_000; guard += 1) {
      clock += 16;
      if (!frame.fire() && !idle.fire()) break;
    }
  }
  // `length`, not `+ pendingLength`: text a holdback or smoother stranded must
  // fail here, not be drained by finalize.
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
   * `smartPunctuation` and `html: 'raw'` decouple a text node's value from its
   * source, the condition `StreamSession.tryFastPath` stands down on.
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
            // Non-vacuous: every fixture is multi-block, so blocks settle
            // mid-stream.
            expect(result.settledBlocksSeen).toBeGreaterThan(0);
            expect(result.identityViolations).toEqual([]);
            // Spoilers are off in every set, so one at any prefix means the
            // option leaked.
            expect(result.spoilerSnapshots).toBe(0);
            expect(countSpoilers(result.final.document)).toBe(0);

            // Deep equality also fails on a surviving incomplete/synthetic
            // repair marker.
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
          // Without coalescing, buffering exercises nothing append does not.
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
  // the table fixtures above) the ones that found the padding-cell defect.
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
      // cut. Final documents and settled identity are the
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
      // Without the tail repair closing an unpaired '||', the body renders in
      // the clear until the closer arrives.
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
      // Non-vacuous: the secret was on screen for most of the stream.
      expect(covered).toBeGreaterThan(5);
      expect(countSpoilers(session.snapshot().document)).toBe(1);

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
      // A line opening with a pipe is a table row only under a header with a
      // delimiter row, as the parse decides it.
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
      // neither math nor underline.
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
      // HTML blocks of types 1-5 (`<!--`, `<script>`, `<pre>`) run past blank
      // lines to their own end condition; type 6 (`<div>`) ends at the blank
      // line.
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
      // md4c autolinks bare ftp too (allowlisted, or it degrades to text and
      // hides the divergence); a fence on a list-marker line is an opener.
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
      // Spoilers are the one post-engine transform, so the one the splice
      // could disagree with; ALL_ON pins them off.
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
      // A definition acts at a distance: it turns `[foo]` in a paragraph the
      // anchor froze long before into a link.
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
      // Only the first paragraph's parse changed, so only it loses identity:
      // the session drops the anchor, not the identity cache.
      expect(
        result.identityViolations.map((v) => v.replace(/^rev \d+: /, '')),
      ).toEqual(['settled block paragraph:0:15 lost referential identity']);
      let links = 0;
      visit(result.final.document, (n) => {
        if (n.kind === 'link') links += 1;
      });
      expect(links).toBe(2);
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
      // md4c honours a definition at a list item's content column; the scan
      // must not read those four spaces as indented code, at any granularity.
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
    session.append('');
    expect(session.length).toBe(13);
    session.finalize('aborted');
    const first = session.snapshot();
    const notified: number[] = [];
    const unsubscribe = session.subscribe((snap) => notified.push(snap.revision));
    session.finalize('aborted');
    unsubscribe();
    const second = session.snapshot();
    expect(notified).toEqual([]);
    expect(second.phase).toBe('settled');
    expect(second.revision).toBe(first.revision);
    expect(second.document).toEqual(parseDocument('Almost **done', presets.llmChat, engine()));
    expect(JSON.stringify(second.document.blocks.map((b) => b.kind))).toBe('["paragraph"]');
  });
});
