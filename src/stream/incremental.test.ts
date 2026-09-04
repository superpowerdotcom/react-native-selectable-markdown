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
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Block, ParagraphNode, ParsedDocument } from '../document/nodes';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import type { EngineOptions } from '../engine/options';
import {
  describeNative,
  linkNativeEngineAsDefault,
  requireNativeEngine,
} from '../engine/native/__tests__/support';
import { DEFAULT_LINK_PREFIXES, presets } from '../engine/options';
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

/** `count` distinct plain paragraphs, long enough for a stall to show up. */
function prose(count: number): string {
  const paragraphs: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    paragraphs.push(
      `Paragraph number ${i} keeps the stream going with plain steady words ` +
        'and nothing that could open a construct',
    );
  }
  return paragraphs.join('\n\n');
}

/**
 * The permissive-autolink schemes md4c actually recognises, read out of the
 * vendored parser's `scheme_map` so this file — not a comment — is what
 * fails if a bump adds one the session's stand-down guard does not know.
 * Falls back to the table as it stands today if the C source is not on disk
 * (a consumer running these tests from a packaged copy).
 */
function md4cAutolinkSchemes(): string[] {
  const file = path.resolve(
    __dirname, '..', '..', 'platform', 'cpp', 'vendor', 'md4c', 'md4c.c',
  );
  if (!fs.existsSync(file)) {
    return ['http', 'https', 'ftp'];
  }
  const table = /scheme_map\[\]\s*=\s*\{([\s\S]*?)\};/.exec(
    fs.readFileSync(file, 'utf8'),
  );
  if (table === null) {
    return ['http', 'https', 'ftp'];
  }
  const schemes: string[] = [];
  const entry = /_T\("([A-Za-z]+)"\)\s*,\s*\d+\s*,\s*_T\("\/\//g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(table[1])) !== null) {
    schemes.push(m[1]);
  }
  return schemes;
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

  test('every permissive-autolink scheme md4c knows stands the fast path down', () => {
    // md4c permissive-autolinks http, https AND ftp. A scheme the guard does
    // not know takes the fast path through the exact divergence the guard
    // exists to prevent: the trimmed '.' md4c left in its own text node is
    // extended by a construct-free delta and the autolink never re-forms.
    const schemes = md4cAutolinkSchemes();
    expect(schemes).toEqual(expect.arrayContaining(['http', 'https', 'ftp']));
    for (const scheme of schemes) {
      streamVerified(`see ${scheme}://example.com/path now`, presets.llmChat);
    }
  });

  test('a growing bare EMAIL autolink is never fast-pathed', () => {
    // The third half of GFM's autolink extension, and the one the scheme
    // guard cannot see: `mail foo@example.` is plain text (md4c wants a dot
    // in the host), and the delta that turns it into an autolink is the bare
    // letter `c` — no construct character, no `https:`/`www.` token, so the
    // fast path used to extend the text node and the mailto link never
    // appeared until a construct character or a trailing space came along.
    streamVerified('mail foo@example.com now', presets.llmChat);
    streamVerified('write to a.b+c@e.co, then stop', presets.llmChat);
  });

  test('a bare email autolink lands as a mailto link', () => {
    // The user-visible half of the guard above, spelled out: what a reader
    // sees mid-stream is a link, with the href md4c synthesizes.
    const session = new StreamSession({ options: presets.llmChat });
    for (const cp of 'mail foo@e.com now') {
      session.append(cp);
    }
    const inline = (session.snapshot().document.blocks[0] as ParagraphNode)
      .children;
    expect(inline[1]).toMatchObject({
      kind: 'autolink',
      href: 'mailto:foo@e.com',
    });
  });

  test('a bare ftp autolink survives the stream under an ftp link policy', () => {
    // The user-visible shape: with ftp:// allowlisted the fresh parse has an
    // autolink node where the fast-pathed snapshot had one flat text node,
    // so the link did not render until a construct character arrived.
    streamVerified('see ftp://example.com/pub/file.txt now', {
      ...presets.llmChat,
      urlPolicy: { linkPrefixes: [...DEFAULT_LINK_PREFIXES, 'ftp://'] },
    });
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

  test('a fence on a list-marker line does not stall the anchor', () => {
    // "- ```js" opens the fence at the item's content column and "  ```"
    // closes it. Reading each line raw missed that opener and then read the
    // indented CLOSER as an opener of its own, so the scan reported a fence
    // open for the rest of the stream and the anchor never moved again —
    // every append reparsing the whole document.
    const prefix = '- ```js\n  const a = 1;\n  ```\n\n';
    const full = `${prefix}${prose(6)}`;
    const inputs: number[] = [];
    const session = new StreamSession({ engine: recordingEngine(inputs) });
    for (const cp of full) {
      session.append(cp);
    }
    const settled = session.snapshot().settledUntil;
    expect(settled).toBeGreaterThan(prefix.length);
    // The stall's signature is a parse of the whole accumulated source on
    // every append; anchored, no streamed parse ever reads it all.
    expect(Math.max(...inputs)).toBeLessThan(full.length);
    session.finalize('end');
    expect(strip(session.snapshot().document.blocks)).toEqual(
      strip(parseDocument(full).blocks),
    );
  });

  test('an unclosed list-item fence still holds the anchor back', () => {
    const full = `- \`\`\`js\n  const a = 1;\n\n  still code\n\n${prose(2)}`;
    const { steps } = streamVerified(full);
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      expect(step.snap.settledUntil).toBe(0);
    }
  });

  test('a doubled currency sign does not stall the anchor with math on', () => {
    // md4c's $$…$$ spans are inline, so "It costs $$5 today" has no open
    // math region: carrying `inMath` past the blank line froze the anchor at
    // 0 for the rest of the stream on ordinary prose.
    const mathOn: EngineOptions = {
      ...presets.llmChat,
      extensions: { ...presets.llmChat.extensions, math: true },
    };
    const full = `It costs $$5 today\n\n${prose(6)}`;
    const inputs: number[] = [];
    const session = new StreamSession({
      options: mathOn,
      engine: recordingEngine(inputs),
    });
    for (const cp of full) {
      session.append(cp);
    }
    expect(session.snapshot().settledUntil).toBeGreaterThan(0);
    expect(Math.max(...inputs)).toBeLessThan(full.length);
    session.finalize('end');
    expect(strip(session.snapshot().document.blocks)).toEqual(
      strip(parseDocument(full, mathOn).blocks),
    );
  });

  test('an unclosed $$ paragraph anchors like any other paragraph', () => {
    // A math span cannot cross a blank line, so a paragraph left holding a
    // lone '$$' is finished prose — nothing appended later can reopen it —
    // and it anchors like any other. The snapshot check is the guard that
    // this leniency is real and not just faster.
    const mathOn: EngineOptions = {
      ...presets.llmChat,
      extensions: { ...presets.llmChat.extensions, math: true },
    };
    const full = '$$\nE = mc^2\n\nstill prose\n\nafter';
    const { steps, final } = streamVerified(full, mathOn);
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    const frozen = steps.filter(
      (s) => s.snap.phase === 'streaming' && s.snap.settledUntil > 0,
    );
    expect(frozen.length).toBeGreaterThan(0);
  });

  test('a raw HTML block that spans blank lines never anchors truncated', () => {
    // CommonMark HTML blocks of types 1-5 do not end at a blank line. The
    // anchor scan reads the PREVIOUS parse's block end against the grown
    // source, so a comment md4c had to cut at the old end-of-source looked
    // blank-line-terminated: it froze truncated and everything after the
    // blank line parsed as markdown for the rest of the stream.
    const full =
      'Intro.\n\n<!-- internal note\n\nstill inside the comment -->\n\nDone.\n';
    const { steps, final } = streamVerified(full, { html: 'raw' });
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'htmlBlock',
      'paragraph',
    ]);
    // Nothing inside the comment may settle while it is still the last
    // block: only the intro paragraph is ever allowed to freeze.
    const comment = full.indexOf('<!--');
    for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
      if (step.fed < full.indexOf('Done.')) {
        expect(step.snap.settledUntil).toBeLessThanOrEqual(comment);
      }
    }
  });

  test('a <script> block that spans blank lines never anchors truncated', () => {
    streamVerified(
      'Intro.\n\n<script>\nvar a = 1;\n\nvar b = 2;\n</script>\n\nDone.\n',
      { html: 'raw' },
    );
  });

  test('a CLOSED comment block anchors like any finished block', () => {
    // The guard used to key on the OPENER alone, so a comment that had
    // already reached its `-->` still refused to anchor — every raw-HTML
    // stream reparsed from offset 0 on every append, quadratic in the
    // document. A block holding its own end condition cannot grow.
    const full =
      '<!-- one -->\n\n<!-- two -->\n\n<!-- three -->\n\ntrailing prose';
    const { steps, final } = streamVerified(full, { html: 'raw' });
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'htmlBlock',
      'htmlBlock',
      'htmlBlock',
      'paragraph',
    ]);
    // Streaming steps only: finalize settles everything by definition.
    const streaming = steps.filter((s) => s.snap.phase === 'streaming');
    const settled = Math.max(...streaming.map((s) => s.snap.settledUntil));
    expect(settled).toBeGreaterThanOrEqual(full.indexOf('<!-- three -->'));
  });

  test('a closed script block anchors, an open one does not', () => {
    const streamingSettled = (source: string): number => {
      const { steps } = streamVerified(source, { html: 'raw' });
      return Math.max(
        ...steps
          .filter((s) => s.snap.phase === 'streaming')
          .map((s) => s.snap.settledUntil),
      );
    };
    expect(
      streamingSettled('<script>var a = 1;</script>\n\nprose after\n\nmore'),
    ).toBeGreaterThan(0);

    // …while one still waiting for its closing tag keeps the anchor at 0,
    // because everything after the blank line is still its content.
    expect(
      streamingSettled('<script>var a = 1;\n\nvar b = 2;\n\nvar c = 3;'),
    ).toBe(0);
  });

  test('a "<!" declaration with no letter after it still spans blank lines', () => {
    // md4c's type-4 start condition is `<!` followed by ANY ascii character
    // (md4c.c: `if(off + 1 < ctx->size && ISASCII(off+1)) return 4;`), so
    // `<!5`, `<!-`, `<! ` and a partial `<![CDATA` all open a block that runs
    // to the next `>`, not to the blank line. Matching only `<![A-Za-z]`
    // made those literals fall through to "closed", and the block froze
    // truncated with the rest of it rendered as markdown for the rest of the
    // stream.
    for (const opener of ['<!5', '<!-', '<! ', '<![CDATA']) {
      const full = `${opener} note\n\nSECRET LEAKS *here*\n\nmore\n`;
      const { steps, final } = streamVerified(full, { html: 'raw' });
      expect(final.document.blocks.map((b) => b.kind)).toEqual(['htmlBlock']);
      // Nothing may freeze while the declaration is still open: every
      // character streamed so far still belongs to the one block.
      for (const step of steps.filter((s) => s.snap.phase === 'streaming')) {
        expect(step.snap.settledUntil).toBe(0);
      }
    }
  });

  test('a "<!" declaration anchors again once its ">" lands', () => {
    // The type-4 row must not cost anchoring either: a declaration that has
    // reached its `>` is closed and freezes like any other finished block.
    const full = '<!5 note>\n\nplain prose here\n\nmore prose\n\ntail';
    const { steps } = streamVerified(full, { html: 'raw' });
    const settled = Math.max(
      ...steps
        .filter((s) => s.snap.phase === 'streaming')
        .map((s) => s.snap.settledUntil),
    );
    expect(settled).toBeGreaterThanOrEqual(full.indexOf('more prose'));
  });

  test('a blank-line-terminated HTML block still anchors', () => {
    // Types 6 and 7 DO end at a blank line, so they keep anchoring: the fix
    // for types 1-5 must not cost every raw-HTML stream its anchor.
    const full = '<div>one</div>\n\n<div>two</div>\n\ntrailing prose';
    const { steps, final } = streamVerified(full, { html: 'raw' });
    expect(final.document.blocks.map((b) => b.kind)).toEqual([
      'htmlBlock',
      'htmlBlock',
      'paragraph',
    ]);
    const frozen = steps.filter(
      (s) => s.snap.phase === 'streaming' && s.snap.settledUntil > 0,
    );
    expect(frozen.length).toBeGreaterThan(0);
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

  /*
   * The session carries `repairTail`'s inline scan forward across appends
   * (see `tailScan`), which is only sound while the tail keeps GROWING from
   * the same anchor. A cache kept past a mutation that REWRITES the tail is
   * not a crash and not a stale render — it is a repair computed against
   * text that is no longer there, and `verifySnapshot` cannot see it,
   * because a wrongly repaired source is still internally consistent with
   * the blocks parsed from it.
   *
   * So this case asserts the repaired SOURCE, on a pair chosen to slip
   * through every cheap guard `repairTail` applies on its own: same derived
   * region start, a cached length that is not longer than the new tail, and
   * the same character sitting at the cached end. All that is left to catch
   * it is the session dropping the record — and if it does not, the
   * unmatched '[' below is never stripped from the parse input.
   */
  test('a divergent replace drops the carried tail scan', () => {
    const session = new StreamSession();
    session.append('a *b* ccc');
    expect(session.snapshot().document.source).toBe('a *b* ccc');
    // Same length, same derived region start, and the same characters at
    // every position the repair's own fingerprint samples — chosen that way
    // on purpose, because the point of the case is that NONE of those cheap
    // checks is what makes the reuse sound. The session dropping the record
    // is.
    session.replace('a *b* [cc');
    // The '[' opened nothing, so handler 5 strips it from the parse input.
    // A stale scan resumes past it and it survives into the source instead.
    expect(session.snapshot().document.source).toBe('a *b* cc');
    verifySnapshot(session.snapshot());
  });

  /*
   * The rest of the mutations, driven with a growing unanchored paragraph
   * full of the constructs the scan actually tracks. These are consistency
   * sweeps rather than traps: `finalize` does not change the source (so a
   * carried scan of it stays true, and clearing it there is hygiene), and an
   * anchor advance is also caught by the anchor recorded alongside the
   * record. They are here so a future change to any of the three has to keep
   * every snapshot agreeing with a fresh parse of itself.
   */
  test('finalize, rewrite and an advancing anchor keep every snapshot honest', () => {
    const feed = (session: StreamSession, text: string): void => {
      for (let i = 0; i < text.length; i += 5) {
        session.append(text.slice(i, i + 5));
        verifySnapshot(session.snapshot());
      }
    };
    const OPENERS = 'a **bold** and *thin* and `code` and [a](http://e.co) ';

    // finalize, then keep streaming: the finalize reparsed the whole source
    // with no repairs at all, so nothing about the repaired tail survives it.
    const finalized = new StreamSession();
    feed(finalized, OPENERS);
    finalized.finalize('end');
    feed(finalized, OPENERS + 'tail *open');
    verifySnapshot(finalized.snapshot());

    // A divergent replace, streamed on afterwards.
    const replaced = new StreamSession();
    feed(replaced, OPENERS);
    replaced.replace('z **ZZZZ** znd *ZZZZ* znd `ZZZZ` znd [z](http://z.zz) ');
    verifySnapshot(replaced.snapshot());
    feed(replaced, 'more *text');

    // A rewrite that reaches into committed text falls back to `replace`.
    const rewritten = new StreamSession();
    feed(rewritten, OPENERS);
    rewritten.rewrite('a **bold** and *thin* and `code` REWRITTEN *x');
    verifySnapshot(rewritten.snapshot());
    rewritten.append('y* done');
    verifySnapshot(rewritten.snapshot());

    // An anchor that advances mid-stream renames every offset in the tail.
    const anchored = new StreamSession();
    feed(anchored, OPENERS + '\n\n' + OPENERS + '\n\n' + OPENERS + 'x *o');
    expect(anchored.snapshot().settledUntil).toBeGreaterThan(0);
    verifySnapshot(anchored.snapshot());
  });
});
