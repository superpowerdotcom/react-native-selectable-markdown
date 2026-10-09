/**
 * `parseDocument`'s engine argument, and its default.
 *
 * Two separate properties are pinned here, and the history of this file is
 * why both are.
 *
 * THE SEAM. `parseDocument(source, options, engine)` is the supported way to
 * substitute a parser, and it went untested for a long time. The cost was not
 * a broken function — it was that nothing noticed the argument had NO CALLER.
 * `SelectableMarkdown` called `parseDocument(source, options)` with two
 * arguments while apps that dutifully called `installNativeEngine()` at
 * startup installed a JSI binding nothing consumed, so every document in every
 * consuming app was parsed by a different engine than its author believed.
 *
 * THE DEFAULT. That bug was invisible to a test of the seam alone: a spy
 * engine passed explicitly proves the argument is honoured and says nothing
 * about what happens when it is omitted. So the default gets its own
 * assertions, and they check *which engine ran*, not merely that the output
 * looks like parsed markdown — any competent parser produces a heading for
 * `# x`, so asserting on the shape of the result would have passed happily
 * throughout the period the default was wrong.
 */

import type { ParsedDocument } from '../document/nodes';
import { parseDocument } from './Engine';
import type { Engine } from './Engine';
import { __linkNativeEngine } from './native/index';
import type { ParseToBuffer } from './native/protocol';
import { describeNative, nativeAddonOrNull } from './native/__tests__/support';
import type { ResolvedEngineOptions } from './options';

/** An engine that records its calls and returns a recognizable document. */
function spyEngine(): Engine & {
  calls: { source: string; options: ResolvedEngineOptions }[];
} {
  const calls: { source: string; options: ResolvedEngineOptions }[] = [];
  return {
    name: 'spy',
    calls,
    parse(source, options): ParsedDocument {
      calls.push({ source, options });
      return {
        source,
        blocks: [
          {
            kind: 'paragraph',
            span: { start: 0, end: source.length },
            children: [
              { kind: 'text', value: 'SPY', span: { start: 0, end: source.length } },
            ],
          },
        ],
      };
    },
  };
}

/**
 * An engine that "parses" the source into one paragraph of literal text.
 *
 * Needed because `spyEngine` deliberately returns a text node whose value
 * (`SPY`) diverges from its source slice, and the spoiler transform skips
 * exactly those nodes — offsets have to map 1:1 for it to place spans. This
 * one keeps the source verbatim, so a post-parse extension has something it is
 * willing to touch.
 */
function literalEngine(): Engine {
  return {
    name: 'literal',
    parse(source): ParsedDocument {
      const span = { start: 0, end: source.length };
      return {
        source,
        blocks: [{ kind: 'paragraph', span, children: [{ kind: 'text', value: source, span }] }],
      };
    },
  };
}

describe('parseDocument', () => {
  test('parses with the engine it is given', () => {
    const spy = spyEngine();
    const doc = parseDocument('# Real markdown', undefined, spy);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].source).toBe('# Real markdown');
    // The spy's document, not a parsed heading — proof the argument is honoured
    // rather than merely accepted.
    expect(doc.blocks[0].kind).toBe('paragraph');
  });

  test('hands the engine RESOLVED options, not the caller partial', () => {
    // The engine contract takes `ResolvedEngineOptions`; every default has to be
    // filled in before the crossing, because the native side reads the option
    // bits positionally and an absent flag is not the same as a false one.
    const spy = spyEngine();
    parseDocument('x', { smartPunctuation: true }, spy);

    expect(spy.calls[0].options).toEqual({
      extensions: {
        tables: false,
        strikethrough: false,
        tasklists: false,
        autolinks: false,
        math: false,
        spoilers: false,
        underline: false,
      },
      html: 'strip',
      htmlAllow: [],
      htmlOther: 'strip',
      smartPunctuation: true,
      maxSourceLength: 1048576,
      urlPolicy: {
        linkPrefixes: ['https://', 'http://', 'mailto:'],
        imagePrefixes: ['https://'],
        blockedLinks: 'text',
      },
    });
  });

  test('applies the spoiler transform on top of a custom engine', () => {
    // Extensions run AFTER `.parse`, so they must apply to whatever engine
    // produced the document — otherwise a consumer who brought their own
    // parser would silently lose them.
    const withSpoilers = parseDocument(
      'a ||secret|| b',
      { extensions: { spoilers: true } },
      literalEngine(),
    );
    expect(withSpoilers.blocks).toEqual([
      {
        kind: 'paragraph',
        span: { start: 0, end: 14 },
        children: [
          { kind: 'text', value: 'a ', span: { start: 0, end: 2 } },
          {
            kind: 'spoiler',
            span: { start: 2, end: 12 },
            children: [{ kind: 'text', value: 'secret', span: { start: 4, end: 10 } }],
          },
          { kind: 'text', value: ' b', span: { start: 12, end: 14 } },
        ],
      },
    ]);
  });

  test('an engine that returns a document is not second-guessed', () => {
    // No validation pass, no normalization: whatever the engine returns is the
    // document. That is what makes the native decoder's output authoritative,
    // and why the decoder's own suite (src/engine/native/__tests__) is where
    // correctness is proven.
    const spy = spyEngine();
    const doc = parseDocument('anything at all', undefined, spy);
    expect(doc).toEqual({
      source: 'anything at all',
      blocks: [
        {
          kind: 'paragraph',
          span: { start: 0, end: 15 },
          children: [{ kind: 'text', value: 'SPY', span: { start: 0, end: 15 } }],
        },
      ],
    });
  });
});

/**
 * The default, pinned two ways.
 *
 * `__linkNativeEngine` is the lever both use: it hands `nativeEngine` the
 * host parse function it would otherwise go looking for on the global, and it
 * invalidates the memoized engine so the next parse re-resolves. Since it
 * feeds the ONE thing that is specific to `nativeEngine` — the wire-buffer
 * producer — a parse that reaches it could not have come from any other
 * engine. That is what makes this an assertion about identity and not about
 * output.
 *
 * It also runs on any machine, with or without a compiler: the first test
 * links a function that never returns a buffer at all.
 */
describe('parseDocument with no engine argument', () => {
  test('routes to the native engine', () => {
    // A host parse function that cannot possibly be mistaken for a parser.
    // If the sentinel escapes `parseDocument`, the default asked THIS for a
    // buffer — i.e. the default is `nativeEngine`, whatever it produces.
    const sentinel = new Error('__native_host_reached__');
    const reached: string[] = [];
    const explode: ParseToBuffer = (source) => {
      reached.push(source);
      throw sentinel;
    };
    __linkNativeEngine(explode);

    expect(() => parseDocument('# Real markdown')).toThrow(sentinel);
    expect(reached).toEqual(['# Real markdown']);
  });

  test('an empty source is answered without a host binding at all', () => {
    /**
     * The ordering half of the default, and it needs a module registry with
     * NOTHING linked to be worth anything. `nativeEngine.parse` short-circuits
     * an empty source ahead of resolution; `createNativeEngine` short-circuits
     * it again after. Only the first of those runs in a JS context with no
     * native module, and only the first is what keeps `<SelectableMarkdown />`
     * with no `source` — and every empty-selection copy reparse — from
     * throwing on mount in Expo Go, on web, or in an app whose binary predates
     * the package. Linking a host function here would let the *second*
     * short-circuit satisfy the assertion and the regression would walk
     * straight back in, which is why this reaches for a fresh `Engine` module
     * with the global cleared instead.
     */
    const globals = globalThis as typeof globalThis & { __selectableMarkdown?: unknown };
    const saved = globals.__selectableMarkdown;
    delete globals.__selectableMarkdown;
    try {
      let doc!: ParsedDocument;
      jest.isolateModules(() => {
        const fresh = require('./Engine') as typeof import('./Engine');
        doc = fresh.parseDocument('');
      });
      expect(doc).toEqual({ source: '', blocks: [] });
    } finally {
      if (saved !== undefined) globals.__selectableMarkdown = saved;
      jest.resetModules();
    }
  });

  test('a non-empty source in the same unlinked context throws', () => {
    // The other half of the pair: the short-circuit above must be about the
    // empty string and not about the native module having become optional
    // again. Same fresh registry, same cleared global, one character of
    // source — and the error has to be the one that names the build step.
    const globals = globalThis as typeof globalThis & { __selectableMarkdown?: unknown };
    const saved = globals.__selectableMarkdown;
    delete globals.__selectableMarkdown;
    try {
      jest.isolateModules(() => {
        const fresh = require('./Engine') as typeof import('./Engine');
        expect(() => fresh.parseDocument('x')).toThrow(/native engine not usable/);
      });
    } finally {
      if (saved !== undefined) globals.__selectableMarkdown = saved;
      jest.resetModules();
    }
  });

  describeNative('against the real md4c module', () => {
    // The test above proves the default is `nativeEngine`; this one proves
    // `nativeEngine` with a real binding actually parses, so the pair cannot
    // both pass while the shipped default is unusable.
    test('parses through md4c and yields a real document', () => {
      const addon = nativeAddonOrNull();
      if (!addon) throw new Error('native addon unavailable inside a describeNative block');
      const seen: string[] = [];
      __linkNativeEngine((source, extensions, htmlPolicy) => {
        seen.push(source);
        return addon.parse(source, extensions, htmlPolicy);
      });

      const doc = parseDocument('# Real markdown');

      expect(seen).toEqual(['# Real markdown']);
      expect(doc.blocks[0].kind).toBe('heading');
      // Spans are the reason any of this matters: the heading has to point
      // back at the exact source the caller handed in.
      expect(doc.source.slice(doc.blocks[0].span.start, doc.blocks[0].span.end)).toBe(
        '# Real markdown',
      );
    });
  });
});
