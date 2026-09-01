/**
 * The URL allowlist: the package's whole link and image safety story.
 *
 * `urlPolicy.ts` is two short pure functions, and it had no tests of its own —
 * it was covered incidentally through a second parser's inline suite, which is
 * gone. That is a bad place for a coverage gap, because this is the module
 * that decides whether `javascript:alert(1)` reaches a renderer, and because
 * both of its failure modes are silent: a policy that is too tight loses a
 * link nobody notices, and a policy that is too loose ships a live one.
 *
 * WHERE THE DECISION IS MADE, AND WHY IT IS NOT A RENDERER'S JOB. Both
 * functions run inside the engine, while the node is being built. By the time
 * `parseDocument` returns there is no unsafe `href` on any node to forget
 * about — a blocked link has already become text (or a node flagged
 * `blocked`), so a consumer who writes their own `link` renderer, or who reads
 * `href` to build a preview, cannot opt out of a policy they never knew
 * existed. The end-to-end cases below assert exactly that: not "the function
 * returned false", but "the document that came back contains no such href".
 *
 * WHY SANITIZE BEFORE MATCHING. `sanitizeUrl` strips C0 controls and DEL, and
 * it runs first and unconditionally. A destination written as `java`, a
 * newline, then `script:alert(1)` does not start with `javascript:` — so a
 * prefix check on the raw string passes it as an unrecognized scheme, and a
 * URL loader that strips control characters itself then runs it. Stripping
 * before the comparison means the string the allowlist judged is the exact
 * string stored on the node. That is the case with teeth here, and it has its
 * own end-to-end test with the control character smuggled in as an entity,
 * which is how it would actually arrive.
 */

import { isUrlAllowed, sanitizeUrl } from './urlPolicy';
import { parseDocument } from './Engine';
import type { EngineOptions } from './options';
import { DEFAULT_IMAGE_PREFIXES, DEFAULT_LINK_PREFIXES, presets } from './options';
import { describeNative, requireNativeEngine } from './native/__tests__/support';
import type { Inline, ParsedDocument } from '../document/nodes';

const CM: EngineOptions = presets.commonmark;
const KEEP_NODE: EngineOptions = { ...CM, urlPolicy: { blockedLinks: 'node' } };

function parse(source: string, options: EngineOptions = CM): ParsedDocument {
  return parseDocument(source, options, requireNativeEngine());
}

function inlines(doc: ParsedDocument): readonly Inline[] {
  return (doc.blocks[0] as { children: Inline[] }).children;
}

function sliceOf(doc: ParsedDocument, node: Inline): string {
  return doc.source.slice(node.span.start, node.span.end);
}

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------

describe('sanitizeUrl', () => {
  test('C0 controls and DEL are removed', () => {
    // The whole C0 range and DEL, not a hand-picked few: a newline is the
    // famous one, but a tab, a NUL or a vertical tab splits `javascript:` just
    // as well, and a WebView is just as willing to reassemble it.
    for (const control of ['\n', '\r', '\t', '\u0000', '\u000b', '\u001f', '\u007f']) {
      expect(sanitizeUrl(`java${control}script:alert(1)`)).toBe('javascript:alert(1)');
    }
    // The whole range rather than a sample, so the character class cannot be
    // narrowed to "the ones we thought of" without failing here.
    for (let cp = 0x00; cp <= 0x1f; cp += 1) {
      expect(sanitizeUrl(`a${String.fromCharCode(cp)}b`)).toBe('ab');
    }
  });

  test('an ordinary URL is returned unchanged', () => {
    // Stripping is not normalization: query strings, fragments, percent
    // escapes and non-ASCII all survive character for character, because the
    // sanitized string is what gets stored and later opened.
    const url = 'https://e.com/a%20b?x=1&y=2#frag';
    expect(sanitizeUrl(url)).toBe(url);
    expect(sanitizeUrl('https://e.com/日本語')).toBe('https://e.com/日本語');
  });

  test('a space is NOT stripped', () => {
    // Deliberate: U+0020 is not a control character, it cannot split a scheme
    // that a loader would rejoin, and stripping it would silently rewrite
    // destinations that legitimately contain one.
    expect(sanitizeUrl('https://e.com/a b')).toBe('https://e.com/a b');
  });
});

// ---------------------------------------------------------------------------
// isUrlAllowed
// ---------------------------------------------------------------------------

describe('isUrlAllowed', () => {
  test('matching is by prefix, not by scheme', () => {
    // Prefix rather than scheme parsing is what lets an app permit exactly
    // `myapp://checkout/` without permitting the rest of its own scheme.
    expect(isUrlAllowed('myapp://checkout/cart', ['myapp://checkout/'])).toBe(true);
    expect(isUrlAllowed('myapp://settings/wipe', ['myapp://checkout/'])).toBe(false);
  });

  test('case-insensitive on BOTH sides', () => {
    // Schemes are case-insensitive, so `JavaScript:` must not slip past a list
    // written in lowercase — and an app that writes `HTTPS://` in its own
    // allowlist must not thereby block every link it has.
    expect(isUrlAllowed('HTTPS://E.COM', ['https://'])).toBe(true);
    expect(isUrlAllowed('https://e.com', ['HTTPS://'])).toBe(true);
    expect(isUrlAllowed('JavaScript:alert(1)', ['https://', 'http://'])).toBe(false);
  });

  test('an empty prefix admits everything, and an empty list admits nothing', () => {
    // Both are used: `['']` is how the conformance runner widens the policy to
    // score spec examples, and `[]` is how a consumer turns links off wholesale.
    expect(isUrlAllowed('javascript:alert(1)', [''])).toBe(true);
    expect(isUrlAllowed('https://e.com', [])).toBe(false);
  });

  test('the shipped defaults admit web and mail, and nothing else', () => {
    for (const url of ['https://e.com', 'http://e.com', 'mailto:a@e.com']) {
      expect(isUrlAllowed(url, DEFAULT_LINK_PREFIXES)).toBe(true);
    }
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'ftp://e.com',
      'file:///etc/passwd',
    ]) {
      expect(isUrlAllowed(url, DEFAULT_LINK_PREFIXES)).toBe(false);
    }
  });

  test('images default to HTTPS only — a stricter list than links', () => {
    // The split is deliberate and easy to erase by accident. An image loads
    // WITHOUT a tap, so a plain-HTTP image is a silent request to an
    // attacker-chosen host on every render, while a plain-HTTP link at least
    // takes an interaction. `http://` is in one list and not the other.
    expect(isUrlAllowed('https://e.com/i.png', DEFAULT_IMAGE_PREFIXES)).toBe(true);
    expect(isUrlAllowed('http://e.com/i.png', DEFAULT_IMAGE_PREFIXES)).toBe(false);
    expect(isUrlAllowed('http://e.com/i.png', DEFAULT_LINK_PREFIXES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the document actually comes back holding
// ---------------------------------------------------------------------------

describeNative('the policy applied at parse time', () => {
  test('a blocked link degrades to its flattened text, spanning the whole construct', () => {
    // Not just "no link node": the characters on screen have to be the label,
    // and the span still has to cover `[a *b*](…)` so that copying the
    // selection reproduces the markdown the author wrote.
    const source = '[a *b*](ftp://e.com)\n';
    const doc = parse(source);
    expect(inlines(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: 20 }, value: 'a b' },
    ]);
    expect(sliceOf(doc, inlines(doc)[0])).toBe('[a *b*](ftp://e.com)');
    expect(JSON.stringify(doc.blocks)).not.toContain('ftp://');
  });

  test('a blocked image degrades to its alt text', () => {
    const doc = parse('![a *b*](http://e.com/i.png)\n');
    expect(inlines(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: 28 }, value: 'a b' },
    ]);
  });

  test('an allowed destination survives with its href intact', () => {
    const doc = parse('[a](http://e.com)\n');
    expect(inlines(doc)[0]).toMatchObject({ kind: 'link', href: 'http://e.com' });
  });

  test('a custom allowlist admits its own scheme and still blocks the rest', () => {
    const options: EngineOptions = {
      ...CM,
      urlPolicy: { linkPrefixes: ['app://'], imagePrefixes: ['app://'] },
    };
    expect(inlines(parse('[a](app://x)\n', options))[0]).toMatchObject({
      kind: 'link',
      href: 'app://x',
    });
    // Replacing the list replaces it: https is no longer implied.
    expect(inlines(parse('[a](https://e.com)\n', options))[0].kind).toBe('text');
  });
});

describeNative("blockedLinks: 'node'", () => {
  /**
   * The alternative to degrading: keep the link node, flag it `blocked`, and
   * let the view layer render it as inert. It exists because an LLM citation
   * like `[1](#answer-citation-1)` is worth styling even though nothing should
   * navigate to it. The flag is the entire safety mechanism in this mode, so
   * these cases assert the flag and not merely the node.
   */
  test('a blocked link keeps its node, its label structure, and a `blocked` flag', () => {
    const doc = parse('[a *b*](ftp://e.com)\n', KEEP_NODE);
    const [link] = inlines(doc);
    expect(link).toMatchObject({ kind: 'link', href: 'ftp://e.com', blocked: true });
    // The label keeps its inline structure — this mode is about presentation,
    // so the emphasis inside it must survive.
    expect((link as { children: Inline[] }).children.map((n) => n.kind)).toEqual([
      'text',
      'emphasis',
    ]);
  });

  test('an allowed link carries no flag at all', () => {
    // Absent rather than `false`: `runAttributes` and `runPressables` both
    // branch on the property's presence, and a document where every link
    // carried `blocked: false` would still be a document where the flag means
    // nothing.
    const [link] = inlines(parse('[a](https://e.com)\n', KEEP_NODE));
    expect(link).toMatchObject({ kind: 'link', href: 'https://e.com' });
    expect(link).not.toHaveProperty('blocked');
  });

  test('a blocked autolink degrades anyway — it has no label to keep', () => {
    // `<ftp://e.com>` renders its own URL, so keeping the node would put the
    // blocked destination on screen as its own link text. There is nothing to
    // preserve, so this mode does not apply to autolinks.
    const doc = parse('<ftp://e.com>\n', KEEP_NODE);
    expect(inlines(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: 13 }, value: 'ftp://e.com' },
    ]);
  });

  test('images ignore the mode and always degrade to their alt', () => {
    // An image node's whole behaviour is to fetch its `src`. There is no inert
    // rendering of one, so `blockedLinks` deliberately does not reach images.
    const doc = parse('![a](http://e.com/i.png)\n', KEEP_NODE);
    expect(inlines(doc)).toEqual([
      { kind: 'text', span: { start: 0, end: 24 }, value: 'a' },
    ]);
  });
});

describeNative('control characters cannot smuggle a scheme past the allowlist', () => {
  test('a newline written as an entity is stripped BEFORE the prefix check', () => {
    // The attack, end to end and in the form it would actually arrive: the
    // source says `java&#10;script:`, so nothing in the raw text spells the
    // scheme. `decodeRawString` turns the entity into a real newline,
    // `sanitizeUrl` removes it, and the prefix check then sees
    // `javascript:alert(1)` and refuses it. Order is everything — check first
    // and this link ships.
    const doc = parse('[a](java&#10;script:alert(1))\n', KEEP_NODE);
    const [link] = inlines(doc);
    expect(link).toMatchObject({ kind: 'link', blocked: true });
    // And the href stored on the node is the sanitized string, so a consumer
    // reading it back cannot reconstruct the split form either.
    expect((link as { href: string }).href).toBe('javascript:alert(1)');
  });

  test('under the default mode the same link leaves no href behind at all', () => {
    const doc = parse('[a](java&#10;script:alert(1))\n');
    expect(inlines(doc)[0].kind).toBe('text');
    expect(JSON.stringify(doc.blocks)).not.toContain('script:');
  });
});
