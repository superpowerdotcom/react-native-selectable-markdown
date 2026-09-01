import type {
  Block,
  CodeBlockNode,
  HeadingLevel,
  Inline,
  ParsedDocument,
  ParagraphNode,
} from '../document/nodes';
import type { Engine } from '../engine/Engine';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import type { SessionSnapshot } from './StreamSession';
import { StreamSession } from './StreamSession';

// ---------------------------------------------------------------------------
// A deliberately small engine implementing the Engine contract with exact
// spans: blank-line-separated paragraphs, ATX headings, thematic breaks and
// fenced code.
//
// It is here so the session's mechanics — settling, referential identity,
// repairs, finalize — are pinned against an engine whose every output is
// written down in this file. Those cases are about the SESSION, and running
// them through md4c would mean a change in the parser could turn them red for
// reasons that have nothing to do with the session; it would also make them
// unrunnable on a machine with no compiler, for no gain. The integration block
// at the bottom is where the real engine comes in, and it is what stops this
// toy from quietly becoming the only thing the session is ever proven against.
// ---------------------------------------------------------------------------

interface Line {
  start: number;
  end: number;
  text: string;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = source.indexOf('\n', start);
    if (nl === -1) {
      lines.push({ start, end: source.length, text: source.slice(start) });
      return lines;
    }
    lines.push({ start, end: nl, text: source.slice(start, nl) });
    start = nl + 1;
  }
}

const fakeEngine: Engine = {
  name: 'fake',
  parse(source: string): ParsedDocument {
    const lines = splitLines(source);
    const blocks: Block[] = [];
    let i = 0;
    while (i < lines.length) {
      const L = lines[i];
      if (/^[ \t]*$/.test(L.text)) {
        i++;
        continue;
      }
      const fence = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(L.text);
      if (fence) {
        const marker = fence[1][0];
        const len = fence[1].length;
        let j = i + 1;
        let closed = false;
        while (j < lines.length) {
          const close = /^(`{3,}|~{3,})[ \t]*$/.exec(lines[j].text);
          if (close && close[1][0] === marker && close[1].length >= len) {
            closed = true;
            break;
          }
          j++;
        }
        const content = lines.slice(i + 1, j);
        const endLine = closed ? lines[j] : lines[j - 1] ?? L;
        const node: CodeBlockNode = {
          kind: 'codeBlock',
          span: { start: L.start, end: endLine.end },
          literal: content.map((l) => l.text).join('\n'),
          fenced: true,
          closed,
        };
        if (fence[2]) {
          node.language = fence[2];
        }
        blocks.push(node);
        i = closed ? j + 1 : lines.length;
        continue;
      }
      if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(L.text)) {
        blocks.push({ kind: 'thematicBreak', span: { start: L.start, end: L.end } });
        i++;
        continue;
      }
      const h = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(L.text);
      if (h) {
        const content = (h[2] ?? '').trim();
        const children: Inline[] = [];
        if (content) {
          const offset = L.text.indexOf(content);
          children.push({
            kind: 'text',
            span: { start: L.start + offset, end: L.start + offset + content.length },
            value: content,
          });
        }
        blocks.push({
          kind: 'heading',
          span: { start: L.start, end: L.end },
          level: h[1].length as HeadingLevel,
          children,
        });
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && !/^[ \t]*$/.test(lines[j].text)) {
        j++;
      }
      const span = { start: L.start, end: lines[j - 1].end };
      const node: ParagraphNode = {
        kind: 'paragraph',
        span,
        children: [{ kind: 'text', span, value: source.slice(span.start, span.end) }],
      };
      blocks.push(node);
      i = j;
    }
    return { source, blocks };
  },
};

const paragraphText = (b: Block): string =>
  b.kind === 'paragraph' && b.children[0]?.kind === 'text'
    ? b.children[0].value
    : '';

describe('StreamSession (fake engine)', () => {
  const make = (options?: ConstructorParameters<typeof StreamSession>[0]) =>
    new StreamSession({ engine: fakeEngine, ...options });

  test('fresh session snapshot is empty without touching the engine', () => {
    const s = new StreamSession(); // default engine on purpose: must not parse
    const snap = s.snapshot();
    expect(snap.document.blocks).toEqual([]);
    expect(snap.document.source).toBe('');
    expect(snap.settledUntil).toBe(0);
    expect(snap.phase).toBe('streaming');
    expect(snap.revision).toBe(0);
    expect(s.length).toBe(0);
  });

  test('append parses and reports length', () => {
    const s = make();
    s.append('Hello');
    expect(s.length).toBe(5);
    const snap = s.snapshot();
    expect(snap.phase).toBe('streaming');
    expect(snap.document.blocks).toHaveLength(1);
    expect(paragraphText(snap.document.blocks[0])).toBe('Hello');
  });

  test('empty append is a complete no-op', () => {
    const s = make();
    const seen: SessionSnapshot[] = [];
    s.subscribe((snap) => seen.push(snap));
    s.append('Hello');
    const before = s.snapshot();
    s.append('');
    expect(s.snapshot()).toBe(before);
    expect(seen).toHaveLength(1);
  });

  test('settledUntil advances at blank-line boundaries', () => {
    const s = make();
    s.append('First para.');
    expect(s.snapshot().settledUntil).toBe(0);
    s.append('\n\nSecond');
    expect(s.snapshot().settledUntil).toBe(13);
  });

  test('settled blocks keep referential identity across snapshots', () => {
    const s = make();
    s.append('First para.\n\nSecond');
    const a = s.snapshot();
    s.append(' grows and grows');
    const b = s.snapshot();
    expect(b.document.blocks[0]).toBe(a.document.blocks[0]);
    expect(b.document.blocks[1]).not.toBe(a.document.blocks[1]);
  });

  test('unclosed strong is repaired and flagged incomplete', () => {
    const s = make();
    s.append('Hello **wor');
    const snap = s.snapshot();
    expect(snap.document.source).toBe('Hello **wor**');
    expect(snap.document.blocks[0].incomplete).toBe(true);
  });

  test('settled blocks are never flagged incomplete', () => {
    const s = make();
    s.append('Done para.\n\nnow **open');
    const snap = s.snapshot();
    expect(snap.document.blocks[0].incomplete).toBeUndefined();
    expect(snap.document.blocks[1].incomplete).toBe(true);
  });

  test('unclosed fence renders as code mid-stream, honest closed:false after finalize', () => {
    const s = make();
    s.append('```js\nconst a = 1');
    const mid = s.snapshot().document.blocks[0];
    expect(mid.kind).toBe('codeBlock');
    expect((mid as CodeBlockNode).literal).toBe('const a = 1');
    expect(mid.incomplete).toBe(true);
    s.finalize();
    const done = s.snapshot();
    expect(done.document.source).toBe('```js\nconst a = 1');
    const block = done.document.blocks[0] as CodeBlockNode;
    expect(block.closed).toBe(false);
    expect(block.incomplete).toBeUndefined();
  });

  test('structure flip: a bare dash line never flashes into the document', () => {
    const s = make();
    s.append('para\n\nnext\n-');
    const snap = s.snapshot();
    expect(snap.document.source).toBe('para\n\nnext');
    expect(snap.document.blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    expect(paragraphText(snap.document.blocks[1])).toBe('next');
  });

  test('trailing empty heading trimmed while streaming, restored by finalize', () => {
    const s = make();
    s.append('para\n\n# \n');
    expect(s.snapshot().document.blocks).toHaveLength(1);
    s.finalize();
    const done = s.snapshot();
    expect(done.document.blocks).toHaveLength(2);
    expect(done.document.blocks[1].kind).toBe('heading');
  });

  test('an open fence blocks settlement across blank lines', () => {
    const s = make();
    s.append('```\ncode\n\nmore');
    expect(s.snapshot().settledUntil).toBe(0);
  });

  test('open display math blocks settlement only when math is enabled', () => {
    const withMath = make({ options: { extensions: { math: true } } });
    withMath.append('$$\nx\n\ny');
    expect(withMath.snapshot().settledUntil).toBe(0);

    const withoutMath = make();
    withoutMath.append('$$\nx\n\ny');
    expect(withoutMath.snapshot().settledUntil).toBe(6);
  });

  test('finalize drops all repairs, settles, and is idempotent', () => {
    const s = make();
    const seen: SessionSnapshot[] = [];
    s.subscribe((snap) => seen.push(snap));
    s.append('tail **open');
    s.finalize();
    const done = s.snapshot();
    expect(done.phase).toBe('settled');
    expect(done.settledUntil).toBe(s.length);
    expect(done.document.source).toBe('tail **open');
    expect(done.document.blocks[0].incomplete).toBeUndefined();
    const emitted = seen.length;
    s.finalize();
    s.finalize('end');
    expect(seen).toHaveLength(emitted);
    expect(s.snapshot()).toBe(done);
  });

  test('finalize on an aborted stream settles the partial text', () => {
    const s = make();
    s.append('cut off mid **sen');
    s.finalize('aborted');
    const snap = s.snapshot();
    expect(snap.phase).toBe('settled');
    expect(snap.document.source).toBe('cut off mid **sen');
  });

  test('finalize on failed run with no text works', () => {
    const s = make();
    s.finalize('failed');
    expect(s.snapshot().phase).toBe('settled');
    expect(s.snapshot().document.blocks).toEqual([]);
  });

  test('finalize preserves settled-block identity', () => {
    const s = make();
    s.append('A para.\n\nSecond one');
    const mid = s.snapshot();
    s.finalize();
    expect(s.snapshot().document.blocks[0]).toBe(mid.document.blocks[0]);
  });

  test('replace with an extending prefix appends the remainder', () => {
    const s = make();
    s.append('First.\n\nHello');
    const before = s.snapshot();
    s.replace('First.\n\nHello world');
    const after = s.snapshot();
    expect(s.length).toBe(19);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.document.blocks[0]).toBe(before.document.blocks[0]);
    s.replace('First.\n\nHello world');
    expect(s.snapshot()).toBe(after);
  });

  test('replace with diverging text resets the session', () => {
    const s = make();
    s.append('Old content here');
    s.replace('Brand new');
    const snap = s.snapshot();
    expect(s.length).toBe(9);
    expect(snap.document.source).toBe('Brand new');
    expect(snap.phase).toBe('streaming');
    expect(paragraphText(snap.document.blocks[0])).toBe('Brand new');
  });

  test('subscribe delivers snapshots; unsubscribe stops them', () => {
    const s = make();
    const seen: number[] = [];
    const stop = s.subscribe((snap) => seen.push(snap.revision));
    s.append('a');
    s.append('b');
    stop();
    s.append('c');
    expect(seen).toEqual([1, 2]);
  });

  test('a subscriber receives every snapshot', () => {
    const seen: SessionSnapshot[] = [];
    const s = new StreamSession({ engine: fakeEngine });
    s.subscribe((snap) => seen.push(snap));
    s.append('hello');
    s.finalize();
    expect(seen).toHaveLength(2);
    expect(seen[1].phase).toBe('settled');
  });

  test('appending after finalize resumes streaming', () => {
    const s = make();
    s.append('done.');
    s.finalize();
    s.append(' more **open');
    const snap = s.snapshot();
    expect(snap.phase).toBe('streaming');
    expect(snap.document.source).toBe('done. more **open**');
  });
});

// ---------------------------------------------------------------------------
// Display-repair options (`init.repair`) threaded into the streaming tail
// repair. Asserted on `document.source` — the repaired parse input, which is
// exactly what a hide removes. `finalize` reparses repair-free by design, so
// the settled document must always show the raw text.
// ---------------------------------------------------------------------------

describe('StreamSession repair options', () => {
  const make = (init?: ConstructorParameters<typeof StreamSession>[0]) =>
    new StreamSession({ engine: fakeEngine, ...init });

  test('hideUriLikeLabels: an unfinished URI-labeled link never paints', () => {
    const s = make({ repair: { hideUriLikeLabels: true } });
    s.append('see [fhir://Observation/abc](fhir://Ob');
    expect(s.snapshot().document.source).toBe('see ');
  });

  test('off by default: the same tail keeps the virtual close and the label paints', () => {
    const s = make();
    s.append('see [fhir://Observation/abc](fhir://Ob');
    expect(s.snapshot().document.source).toBe(
      'see [fhir://Observation/abc](fhir://Ob)',
    );
  });

  test('hideBareUriSchemes: a growing listed-scheme URI hides until its token completes', () => {
    const s = make({ repair: { hideBareUriSchemes: ['message'] } });
    s.append('open message://5f3a-');
    expect(s.snapshot().document.source).toBe('open ');
    s.append('99');
    expect(s.snapshot().document.source).toBe('open ');
    // Trailing whitespace ends the token: it is no longer growing, so it
    // paints in full.
    s.append(' done');
    expect(s.snapshot().document.source).toBe('open message://5f3a-99 done');
  });

  test('hideBareUriSchemes: a construct-free delta cannot sneak the token past the fast path', () => {
    // '/' is not a construct character, so without the scheme-tail guard
    // this second append would extend the paragraph parse-free and paint
    // the raw URI until the next construct character happened to arrive.
    const s = make({ repair: { hideBareUriSchemes: ['message'] } });
    s.append('open message:');
    // Prose ending in the bare word `message:` is never blanked.
    expect(s.snapshot().document.source).toBe('open message:');
    s.append('//5f3a');
    expect(s.snapshot().document.source).toBe('open ');
  });

  test('finalize stays repair-free: hidden text settles verbatim', () => {
    const s = make({
      repair: { hideUriLikeLabels: true, hideBareUriSchemes: ['message'] },
    });
    s.append('see [fhir://Observation/abc](fhir://Ob');
    s.finalize('aborted');
    const snap = s.snapshot();
    expect(snap.phase).toBe('settled');
    expect(snap.document.source).toBe('see [fhir://Observation/abc](fhir://Ob');
  });
});

// ---------------------------------------------------------------------------
// Integration against the real engine.
//
// Everything above runs on the toy engine, which means everything above would
// still pass if the session's assumptions about spans were true only of the
// toy. These cases run the same mechanics through the package default — md4c —
// with no engine argument, exactly as `SelectableMarkdown` does: a
// character-by-character stream must finalize to the same document a fresh
// parse produces, settled blocks must keep identity, and the virtual closers
// the repair layer inserts must survive contact with a real parser and then
// vanish.
//
// `linkNativeEngineAsDefault` is what makes the default resolve inside a Node
// worker; where the addon cannot be built there is no parser at all and the
// block reports as skipped rather than failing. The exhaustive version of this
// property — every prefix, over a corpus — lives in
// conformance/streaming/prefix-oracle.test.ts.
// ---------------------------------------------------------------------------

linkNativeEngineAsDefault();

describeNative('StreamSession + the md4c engine (integration)', () => {
  test('char-by-char stream finalizes to the same document as a fresh parse', () => {
    const source = '# Title\n\nHello **world** and `code`.\n\n- one\n- two\n';
    const session = new StreamSession();
    for (const ch of source) {
      session.append(ch);
    }
    session.finalize();
    const snap = session.snapshot();
    expect(snap.document.source).toBe(source);
    const fresh = parseDocument(source);
    expect(JSON.parse(JSON.stringify(snap.document.blocks))).toEqual(
      JSON.parse(JSON.stringify(fresh.blocks)),
    );
  });

  test("a streaming custom-scheme link under blockedLinks:'node' repairs like any link", () => {
    const options = { urlPolicy: { blockedLinks: 'node' as const } };
    const session = new StreamSession({ options });
    session.append('See [1](#answer-citat');
    const mid = session.snapshot();
    const midLink = (mid.document.blocks[0] as ParagraphNode).children[1];
    // The virtual closer applies before the URL policy, so the half-written
    // destination reaches the renderer as a blocked link, not as a text node
    // that becomes one a tick later.
    expect(midLink).toMatchObject({ kind: 'link', blocked: true, incomplete: true });

    session.append('ion-1)');
    session.finalize();
    const done = session.snapshot();
    expect(JSON.parse(JSON.stringify(done.document.blocks))).toEqual(
      JSON.parse(
        JSON.stringify(parseDocument('See [1](#answer-citation-1)', options).blocks),
      ),
    );
  });

  test('settled blocks keep identity with the real engine', () => {
    const session = new StreamSession();
    session.append('First paragraph.\n\nSecond');
    const a = session.snapshot();
    session.append(' continues');
    const b = session.snapshot();
    expect(b.document.blocks[0]).toBe(a.document.blocks[0]);
  });

  test('mid-stream repairs are flagged and vanish on finalize', () => {
    const session = new StreamSession();
    session.append('streaming **bol');
    const mid = session.snapshot();
    expect(mid.document.blocks[0]?.incomplete).toBe(true);
    session.finalize('aborted');
    const done = session.snapshot();
    expect(done.document.source).toBe('streaming **bol');
    expect(done.document.blocks[0]?.incomplete).toBeUndefined();
  });
});
