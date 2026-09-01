/**
 * Incremental-parsing gates: once early blocks settle behind the safe
 * anchor, each append must parse only a tail-sized slice; construct-free
 * deltas must skip the engine entirely; and the splice must be invisible —
 * at every snapshot the committed blocks deep-equal what a fresh parse of
 * the same (repaired) source would display. Includes the safe-anchor
 * regression corpus: lists and indented code must never anchor, tables and
 * blockquotes must.
 *
 * Everything here runs against the real engine — md4c, the package default —
 * because the properties are about the interaction between the session's
 * bookkeeping and a parser's actual block boundaries. A toy engine would
 * settle wherever the toy said to. `recordingEngine` wraps that same engine to
 * count what it is asked to parse; the wrapper only observes, so a `expect(...)
 * .toBeLessThan(tailBound)` is a statement about the session, not about the
 * wrapper. On a machine that cannot build the addon there is no parser at all
 * and these blocks report as skipped — see
 * src/engine/native/__tests__/support.ts.
 */
import type { Block, ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
  requireNativeEngine,
} from '../engine/native/__tests__/support';
import { presets } from '../engine/options';
import { trimTrailingPlaceholders } from './placeholders';
import type { SessionSnapshot } from './StreamSession';
import { StreamSession } from './StreamSession';

linkNativeEngineAsDefault();

/**
 * The engine under test, wrapped so the length of every source it is handed is
 * recorded. That length is the whole point of the incremental path: "the
 * session reparses a tail, not the document" is not observable in the output —
 * a full reparse produces exactly the same snapshot, just slower — so it can
 * only be asserted by watching what the engine was asked to read.
 */
function recordingEngine(inputLengths: number[]): Engine {
  const inner = requireNativeEngine();
  return {
    name: `recording(${inner.name})`,
    parse(source, options) {
      inputLengths.push(source.length);
      return inner.parse(source, options);
    },
  };
}

/** Strips streaming-only flags so structures can be compared to a fresh parse. */
function strip(blocks: Block[]): unknown {
  return JSON.parse(
    JSON.stringify(blocks, (key, value) =>
      key === 'incomplete' || key === 'synthetic' ? undefined : value,
    ),
  );
}

/**
 * What a snapshot's blocks must equal: a fresh parse of the snapshot's own
 * (repair-applied) source, with placeholder trimming applied only past the
 * settled boundary — mirroring the session, which never trims frozen blocks.
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

function verifySnapshot(snap: SessionSnapshot, options?: EngineOptions): void {
  const fresh = parseDocument(snap.document.source, options);
  expect(strip(snap.document.blocks)).toEqual(
    strip(expectedDisplay(fresh, snap.settledUntil)),
  );
}

interface StreamedStep {
  snap: SessionSnapshot;
  fed: number;
}

/**
 * Streams `full` one code point at a time, verifying EVERY snapshot against
 * a fresh parse of its own source, then finalizes (also verified).
 */
function streamVerified(
  full: string,
  options?: EngineOptions,
): { steps: StreamedStep[]; final: SessionSnapshot } {
  const session = new StreamSession({ options });
  const steps: StreamedStep[] = [];
  const unsubscribe = session.subscribe((snap) => {
    verifySnapshot(snap, options);
    steps.push({ snap, fed: session.length });
  });
  for (const cp of full) {
    session.append(cp);
  }
  session.finalize('end');
  unsubscribe();
  const final = session.snapshot();
  expect(final.document.source).toBe(full);
  expect(strip(final.document.blocks)).toEqual(
    strip(parseDocument(full, options).blocks),
  );
  return { steps, final };
}

describeNative('tail-only reparse (recording engine)', () => {
  test('parse input stays tail-sized once early blocks settle', () => {
    const paragraphs: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      paragraphs.push(
        `Paragraph number ${i} flows along with plain steady words, ` +
          'nothing fancy at all in here',
      );
    }
    const full = paragraphs.join('\n\n');
    expect(full.length).toBeGreaterThan(900);

    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    for (let i = 0; i < full.length; i += 7) {
      session.append(full.slice(i, i + 7));
    }
    session.finalize('end');

    expect(session.snapshot().settledUntil).toBe(full.length);
    expect(strip(session.snapshot().document.blocks)).toEqual(
      strip(parseDocument(full).blocks),
    );

    // The last recorded call is finalize's one full clean parse — O(n) once.
    const finalizeInput = inputs[inputs.length - 1];
    expect(finalizeInput).toBe(full.length);

    // Every streamed parse reads at most roughly two paragraphs of tail —
    // never the accumulated document.
    const streamed = inputs.slice(0, -1);
    const maxParagraph = Math.max(...paragraphs.map((p) => p.length));
    const tailBound = maxParagraph * 2 + 16;
    expect(Math.max(...streamed)).toBeLessThan(tailBound);
    expect(Math.max(...streamed)).toBeLessThan(full.length / 3);
  });

  test('with no safe anchor the fallback is a correct full reparse', () => {
    // One list is a single block: nothing can anchor, so every parse sees
    // the whole source. Correctness over speed — documented worst case.
    const full = '- alpha\n- beta\n- gamma\n- delta';
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    for (const cp of full) {
      session.append(cp);
    }
    expect(session.snapshot().settledUntil).toBe(0);
    expect(inputs[inputs.length - 1]).toBe(full.length);
    session.finalize('end');
    expect(strip(session.snapshot().document.blocks)).toEqual(
      strip(parseDocument(full).blocks),
    );
  });
});

describeNative('construct-free fast path', () => {
  test('plain-prose deltas skip the engine and rebuild only the last block', () => {
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    session.append('Alpha opening words');
    expect(inputs).toHaveLength(1);
    const first = session.snapshot();
    verifySnapshot(first);

    session.append(' and more prose');
    expect(inputs).toHaveLength(1); // no engine call
    const second = session.snapshot();
    verifySnapshot(second);
    expect(second.document.source).toBe('Alpha opening words and more prose');
    const para = second.document.blocks[0];
    expect(para).not.toBe(first.document.blocks[0]); // immutable rebuild
    expect(para.span).toEqual({ start: 0, end: 34 });
    if (para.kind === 'paragraph' && para.children[0].kind === 'text') {
      expect(para.children[0].value).toBe(
        'Alpha opening words and more prose',
      );
    } else {
      throw new Error('expected a paragraph with a text child');
    }
  });

  test('settled blocks keep identity across fast-path appends', () => {
    const session = new StreamSession();
    session.append('Settled paragraph here\n\nTail start');
    session.append(' grows'); // creates the anchor state, then extends
    const a = session.snapshot();
    session.append(' further');
    const b = session.snapshot();
    expect(b.document.blocks[0]).toBe(a.document.blocks[0]);
    expect(b.document.blocks[1]).not.toBe(a.document.blocks[1]);
    verifySnapshot(b);
  });

  test('a construct character forces the engine', () => {
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    session.append('plain words');
    const before = inputs.length;
    session.append(' then **bold');
    expect(inputs.length).toBe(before + 1);
    verifySnapshot(session.snapshot());
  });

  test('an in-flight repair blocks the fast path until the tail is clean', () => {
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    session.append('open **strong');
    const afterRepair = inputs.length;
    session.append(' words'); // safe chars, but a repair is in flight
    expect(inputs.length).toBe(afterRepair + 1);
    verifySnapshot(session.snapshot());
  });

  test('a trailing space defers to the engine (right-trim divergence)', () => {
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    session.append('hello');
    const before = inputs.length;
    session.append(' world ');
    expect(inputs.length).toBe(before + 1);
    verifySnapshot(session.snapshot());
  });

  test('a delta ending in a lone high surrogate is never fast-pathed (split emoji)', () => {
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    session.append('Hello');
    const before = inputs.length;
    // A byte-chunked stream can split an emoji across deltas. The lone high
    // half must take the parse path so repairTail drops it — a fast-path
    // commit would hand invalid UTF-16 to subscribers and native measure.
    session.append(' wor\uD83D');
    expect(inputs.length).toBe(before + 1); // engine ran; no fast path
    const mid = session.snapshot();
    expect(mid.document.source).toBe('Hello wor'); // lone half withheld
    verifySnapshot(mid);
    session.append('\uDE00ld'); // low half rejoins its pair
    expect(session.snapshot().document.source).toBe('Hello wor\u{1F600}ld');
    session.finalize('end');
    expect(session.snapshot().document.source).toBe('Hello wor\u{1F600}ld');
  });

  test('entity completion via ";" is never fast-pathed', () => {
    streamVerified('Fish &amp; chips and then more of them');
  });

  test('a growing bare autolink is never fast-pathed', () => {
    streamVerified('see https://example.com/path now words', presets.llmChat);
  });

  test('a letter after a bare "<" line is never fast-pathed (html-block flip)', () => {
    // "<" alone parses as a paragraph; "<h" starts an HTML block (stripped
    // under the default policy). The letter must go through the engine.
    streamVerified('intro text\n\n<hr then more\n\nclosing words');
    streamVerified('first\n\n</div maybe\n\nlast', presets.llmChat);
  });
});

describeNative('safe-anchor regressions', () => {
  test('"- a\\n\\n- b" streams to ONE loose list — a list never anchors', () => {
    const { steps, final } = streamVerified('- a\n\n- b');
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      expect(step.snap.settledUntil).toBe(0);
    }
    expect(final.document.blocks).toHaveLength(1);
    const list = final.document.blocks[0];
    expect(list.kind).toBe('list');
    if (list.kind === 'list') {
      expect(list.tight).toBe(false);
      expect(list.items).toHaveLength(2);
    }
  });

  test('"    a\\n\\n    b" stays one indented code block', () => {
    const { steps, final } = streamVerified('    a\n\n    b');
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      expect(step.snap.settledUntil).toBe(0);
    }
    expect(final.document.blocks).toHaveLength(1);
    const code = final.document.blocks[0];
    expect(code.kind).toBe('codeBlock');
    if (code.kind === 'codeBlock') {
      expect(code.fenced).toBe(false);
      expect(code.literal).toBe('a\n\nb\n');
    }
  });

  test('a table grows row by row, then anchors once prose follows', () => {
    const table =
      '| a | b |\n| --- | --- |\n| one | two |\n| three | four |';
    const full = `${table}\n\nProse afterwards keeps growing`;
    const { steps, final } = streamVerified(full, presets.llmChat);

    // While the table is still the last block it must never settle.
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      if (step.fed <= table.length + 2) {
        expect(step.snap.settledUntil).toBe(0);
      }
    }
    // Once prose follows the blank line, the table freezes mid-stream...
    const frozenAt = steps.findIndex(
      (s) => s.snap.phase === 'streaming' && s.snap.settledUntil > 0,
    );
    expect(frozenAt).toBeGreaterThan(-1);
    expect(steps[frozenAt].snap.settledUntil).toBe(full.indexOf('Prose'));
    // ...and keeps referential identity in every later snapshot.
    const frozenTable = steps[frozenAt].snap.document.blocks[0];
    expect(frozenTable.kind).toBe('table');
    for (const step of steps.slice(frozenAt + 1)) {
      expect(step.snap.document.blocks[0]).toBe(frozenTable);
    }
    expect(final.document.blocks[0]).toBe(frozenTable);
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'table',
      'paragraph',
    ]);
  });

  test('a blockquote anchors once a new blockquote follows the blank line', () => {
    const full = '> first quote\n\n> second quote\n\ntrailing prose';
    const { steps, final } = streamVerified(full);
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'blockquote',
      'blockquote',
      'paragraph',
    ]);
    const firstEnd = '> first quote'.length;
    const frozenAt = steps.findIndex(
      (s) => s.snap.phase === 'streaming' && s.snap.settledUntil >= firstEnd,
    );
    expect(frozenAt).toBeGreaterThan(-1);
    const frozenQuote = steps[frozenAt].snap.document.blocks[0];
    expect(frozenQuote.kind).toBe('blockquote');
    for (const step of steps.slice(frozenAt + 1)) {
      expect(step.snap.document.blocks[0]).toBe(frozenQuote);
    }
    expect(final.document.blocks[0]).toBe(frozenQuote);
  });

  test('an unclosed fence holds the anchor back across blank lines', () => {
    const full = 'Intro paragraph\n\n```js\nlet a\n\nlet b\n```\n\nAfter code';
    const { steps, final } = streamVerified(full);
    // While the fence is open, nothing past the intro may settle.
    const intro = 'Intro paragraph'.length + 2;
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      expect(step.snap.settledUntil).toBeLessThanOrEqual(
        Math.max(intro, full.indexOf('After')),
      );
    }
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'codeBlock',
      'paragraph',
    ]);
  });
});

describeNative('session protocol under incremental parsing', () => {
  test('a diverging replace resets the frozen prefix', () => {
    const session = new StreamSession();
    session.append('First block here\n\nSecond block here\n\nThird');
    expect(session.snapshot().settledUntil).toBeGreaterThan(0);
    session.replace('Completely different text');
    const snap = session.snapshot();
    expect(snap.settledUntil).toBe(0);
    verifySnapshot(snap);
    session.append(' keeps going');
    verifySnapshot(session.snapshot());
    session.finalize('end');
    expect(strip(session.snapshot().document.blocks)).toEqual(
      strip(parseDocument('Completely different text keeps going').blocks),
    );
  });

  test('appending after finalize resumes from the frozen prefix', () => {
    const session = new StreamSession();
    session.append('Stable intro\n\nsecond part');
    session.finalize('end');
    const done = session.snapshot();
    session.append(' continues after a tool call');
    const resumed = session.snapshot();
    expect(resumed.phase).toBe('streaming');
    expect(resumed.document.blocks[0]).toBe(done.document.blocks[0]);
    verifySnapshot(resumed);
  });
});
