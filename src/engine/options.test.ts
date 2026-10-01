import type { Block, Inline } from '../document/nodes';
import { parseDocument } from './Engine';
import { describeNative, requireNativeEngine } from './native/__tests__/support';
import type { EngineOptions } from './options';
import { presets, resolveOptions, withOptions } from './options';

describe('resolveOptions', () => {
  it('defaults every extension off, html strip, plain punctuation', () => {
    const r = resolveOptions();
    expect(r.extensions).toEqual({
      tables: false,
      strikethrough: false,
      tasklists: false,
      autolinks: false,
      math: false,
      spoilers: false,
      underline: false,
    });
    expect(r.html).toBe('strip');
    expect(r.smartPunctuation).toBe(false);
    expect(r.urlPolicy.linkPrefixes).toEqual(['https://', 'http://', 'mailto:']);
    expect(r.urlPolicy.imagePrefixes).toEqual(['https://']);
    expect(r.urlPolicy.blockedLinks).toBe('text');
  });

  it('keeps blocked links as nodes only when asked', () => {
    expect(
      resolveOptions({ urlPolicy: { blockedLinks: 'node' } }).urlPolicy
        .blockedLinks,
    ).toBe('node');
    expect(
      resolveOptions({ urlPolicy: { linkPrefixes: ['app://'] } }).urlPolicy
        .blockedLinks,
    ).toBe('text');
  });

  it('merges partial extension flags over defaults', () => {
    const r = resolveOptions({ extensions: { tables: true } });
    expect(r.extensions.tables).toBe(true);
    expect(r.extensions.spoilers).toBe(false);
    expect(r.extensions.math).toBe(false);
  });

  it('honors a partial urlPolicy override without touching the other list', () => {
    const r = resolveOptions({
      urlPolicy: { linkPrefixes: ['https://'] },
    });
    expect(r.urlPolicy.linkPrefixes).toEqual(['https://']);
    expect(r.urlPolicy.imagePrefixes).toEqual(['https://']);
  });
});

describe('presets', () => {
  it('spoilers are off in commonmark and llmChat, on only in everything', () => {
    expect(resolveOptions(presets.commonmark).extensions.spoilers).toBe(false);
    expect(resolveOptions(presets.llmChat).extensions.spoilers).toBe(false);
    expect(resolveOptions(presets.everything).extensions.spoilers).toBe(true);
  });

  it('everything enables all extensions', () => {
    const r = resolveOptions(presets.everything);
    expect(Object.values(r.extensions).every((v) => v === true)).toBe(true);
  });

  it('smartPunctuation is off in commonmark and llmChat, on only in everything', () => {
    expect(resolveOptions(presets.commonmark).smartPunctuation).toBe(false);
    expect(resolveOptions(presets.llmChat).smartPunctuation).toBe(false);
    expect(resolveOptions(presets.everything).smartPunctuation).toBe(true);
  });
});

describeNative('what the commonmark and llmChat presets parse', () => {
  // `$m$` stays literal (math off) and `_u_` is emphasis (underline off).
  const source = '- [x] ~~s~~ $m$ _u_ www.e.com\n\n| a |\n| - |\n';
  const shape = (options: EngineOptions): unknown => {
    const [list, second] = parseDocument(source, options, requireNativeEngine()).blocks;
    const item = (list as { items: Block[] }).items[0] as { task?: string; children: Block[] };
    const inlines = (item.children[0] as { children: Inline[] }).children;
    return {
      task: item.task,
      inlines: inlines.map((n) => ('value' in n ? `${n.kind}:${n.value}` : n.kind)),
      second: second.kind,
    };
  };

  it('llmChat turns on tables, strikethrough, tasklists and autolinks only', () => {
    expect(shape(presets.llmChat)).toEqual({
      task: 'checked',
      inlines: ['strikethrough', 'text: $m$ ', 'emphasis', 'text: ', 'autolink'],
      second: 'table',
    });
  });

  it('commonmark leaves every one of them literal', () => {
    expect(shape(presets.commonmark)).toEqual({
      task: undefined,
      inlines: ['text:[x] ~~s~~ $m$ ', 'emphasis', 'text: www.e.com'],
      second: 'paragraph',
    });
  });
});

describe('withOptions', () => {
  it('keeps a preset\'s extensions when the override touches something else', () => {
    const composed = withOptions(presets.llmChat, {
      urlPolicy: { blockedLinks: 'node' },
    });
    const r = resolveOptions(composed);
    expect(r.extensions.tables).toBe(true);
    expect(r.extensions.strikethrough).toBe(true);
    expect(r.extensions.tasklists).toBe(true);
    expect(r.extensions.autolinks).toBe(true);
    expect(r.urlPolicy.blockedLinks).toBe('node');
    expect(r.html).toBe('strip');
    const bare: EngineOptions = { urlPolicy: { blockedLinks: 'node' } };
    expect(Object.values(resolveOptions(bare).extensions).every((v) => v === false)).toBe(true);
  });

  it('overrides one extension flag and leaves the rest of the preset alone', () => {
    const r = resolveOptions(withOptions(presets.everything, { extensions: { math: false } }));
    expect(r.extensions.math).toBe(false);
    expect(r.extensions.tables).toBe(true);
    expect(r.extensions.spoilers).toBe(true);
    expect(r.smartPunctuation).toBe(true);
    const spread = resolveOptions({ ...presets.everything, extensions: { math: false } });
    expect(Object.values(spread.extensions).every((v) => v === false)).toBe(true);
  });

  it('merges urlPolicy field by field instead of replacing the object', () => {
    const r = resolveOptions(
      withOptions(
        presets.llmChat,
        { urlPolicy: { linkPrefixes: ['app://'] } },
        { urlPolicy: { blockedLinks: 'node' } },
      ),
    );
    expect(r.urlPolicy.linkPrefixes).toEqual(['app://']);
    expect(r.urlPolicy.blockedLinks).toBe('node');
    expect(r.urlPolicy.imagePrefixes).toEqual(['https://']);
  });

  it('replaces prefix arrays rather than concatenating them', () => {
    // An allowlist that grew because two layers each added to it is a security
    // bug.
    const r = resolveOptions(
      withOptions(
        { urlPolicy: { linkPrefixes: ['app://'] } },
        { urlPolicy: { linkPrefixes: ['other://'] } },
      ),
    );
    expect(r.urlPolicy.linkPrefixes).toEqual(['other://']);
  });

  it('an undefined value never overwrites', () => {
    const r = resolveOptions(
      withOptions(presets.everything, {
        html: undefined,
        smartPunctuation: undefined,
        urlPolicy: { blockedLinks: undefined },
      }),
    );
    expect(r.smartPunctuation).toBe(true);
    expect(r.extensions.tables).toBe(true);
    expect(r.urlPolicy.blockedLinks).toBe('text');
  });

  it('never mutates the preset it composed from', () => {
    const before = JSON.stringify(presets.llmChat);
    const r = resolveOptions(
      withOptions(presets.llmChat, { extensions: { math: true }, html: 'raw' }),
    );
    expect(JSON.stringify(presets.llmChat)).toBe(before);
    expect(r.extensions.math).toBe(true);
    expect(r.extensions.tables).toBe(true);
    expect(r.html).toBe('raw');
  });

  it('with no overrides it returns a COPY, equivalent but not the preset', () => {
    const copy = withOptions(presets.llmChat);
    expect(copy).not.toBe(presets.llmChat);
    expect(resolveOptions(copy)).toEqual(resolveOptions(presets.llmChat));
    expect(resolveOptions(withOptions(presets.llmChat, undefined))).toEqual(
      resolveOptions(presets.llmChat),
    );
  });

  it('the copy is deep enough to be written to', () => {
    // A top-level spread alone would still share `extensions` and the prefix
    // arrays.
    const before = JSON.stringify(presets.everything);
    const copy = withOptions(presets.everything);
    expect(copy.extensions).not.toBe(presets.everything.extensions);
    (copy.extensions as { math: boolean }).math = false;
    copy.urlPolicy?.linkPrefixes?.push('app://');
    expect(JSON.stringify(presets.everything)).toBe(before);
    expect(resolveOptions(presets.everything).extensions.math).toBe(true);
  });
  it('never shares override arrays or groups with the result', () => {
    const override: EngineOptions = {
      extensions: { math: true },
      urlPolicy: { linkPrefixes: ['https://'], imagePrefixes: ['https://'] },
    };
    const before = JSON.stringify(override);
    const a = withOptions(presets.llmChat, override);
    const b = withOptions(presets.everything, override);
    const c = withOptions(presets.llmChat, override, { html: 'raw' });

    for (const r of [a, b, c]) {
      expect(r.urlPolicy).not.toBe(override.urlPolicy);
      expect(r.urlPolicy?.linkPrefixes).not.toBe(override.urlPolicy?.linkPrefixes);
      expect(r.urlPolicy?.imagePrefixes).not.toBe(override.urlPolicy?.imagePrefixes);
      expect(r.extensions).not.toBe(override.extensions);
    }

    a.urlPolicy?.linkPrefixes?.push('javascript:');
    a.urlPolicy?.imagePrefixes?.push('data:');
    (a.extensions as { spoilers: boolean }).spoilers = true;
    expect(JSON.stringify(override)).toBe(before);
    expect(resolveOptions(b).urlPolicy.linkPrefixes).toEqual(['https://']);
    expect(resolveOptions(b).urlPolicy.imagePrefixes).toEqual(['https://']);
    expect(resolveOptions(c).urlPolicy.linkPrefixes).toEqual(['https://']);
  });
});
