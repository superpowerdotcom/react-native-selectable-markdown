import {
  DEFAULT_IMAGE_PREFIXES,
  DEFAULT_LINK_PREFIXES,
  presets,
  resolveOptions,
} from './options';

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
    expect(r.urlPolicy.linkPrefixes).toEqual([
      ...DEFAULT_LINK_PREFIXES,
    ]);
    expect(r.urlPolicy.imagePrefixes).toEqual([
      ...DEFAULT_IMAGE_PREFIXES,
    ]);
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
    expect(r.urlPolicy.imagePrefixes).toEqual([
      ...DEFAULT_IMAGE_PREFIXES,
    ]);
  });
});

describe('presets', () => {
  it('spoilers are off in commonmark and llmChat, on only in everything', () => {
    expect(resolveOptions(presets.commonmark).extensions.spoilers).toBe(false);
    expect(resolveOptions(presets.llmChat).extensions.spoilers).toBe(false);
    expect(resolveOptions(presets.everything).extensions.spoilers).toBe(true);
  });

  it('commonmark keeps every extension off', () => {
    const r = resolveOptions(presets.commonmark);
    expect(Object.values(r.extensions).every((v) => v === false)).toBe(true);
  });

  it('llmChat enables the GFM set but not math/spoilers/underline', () => {
    const r = resolveOptions(presets.llmChat);
    expect(r.extensions.tables).toBe(true);
    expect(r.extensions.strikethrough).toBe(true);
    expect(r.extensions.tasklists).toBe(true);
    expect(r.extensions.autolinks).toBe(true);
    expect(r.extensions.math).toBe(false);
    expect(r.extensions.spoilers).toBe(false);
    expect(r.extensions.underline).toBe(false);
    expect(r.html).toBe('strip');
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
