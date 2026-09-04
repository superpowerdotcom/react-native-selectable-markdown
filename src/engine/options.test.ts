import type { EngineOptions } from './options';
import {
  DEFAULT_IMAGE_PREFIXES,
  DEFAULT_LINK_PREFIXES,
  presets,
  resolveOptions,
  withOptions,
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

describe('withOptions', () => {
  /**
   * The composition trap this helper exists for: `extensions` REPLACES, so a
   * literal that names one field turns every other flag off, and a shallow
   * preset spread cannot fix it because the spread copies the whole
   * `extensions` object and then the override replaces it wholesale. Both
   * shapes below resolve to seven false flags without the helper, which is
   * why each case asserts the resolved flags rather than the literal.
   */
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
    // The shape the README used to hand a reader, for contrast.
    const bare: EngineOptions = { urlPolicy: { blockedLinks: 'node' } };
    expect(Object.values(resolveOptions(bare).extensions).every((v) => v === false)).toBe(true);
  });

  it('overrides one extension flag and leaves the rest of the preset alone', () => {
    const r = resolveOptions(withOptions(presets.everything, { extensions: { math: false } }));
    expect(r.extensions.math).toBe(false);
    expect(r.extensions.tables).toBe(true);
    expect(r.extensions.spoilers).toBe(true);
    expect(r.smartPunctuation).toBe(true);
    // Spreading instead of composing is the bug: same intent, all off.
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
    expect(r.urlPolicy.imagePrefixes).toEqual([...DEFAULT_IMAGE_PREFIXES]);
  });

  it('replaces prefix arrays rather than concatenating them', () => {
    // Deliberate: an allowlist that grew because two layers each added to it
    // is a security bug that reads as a convenience.
    const r = resolveOptions(
      withOptions(
        { urlPolicy: { linkPrefixes: ['app://'] } },
        { urlPolicy: { linkPrefixes: ['other://'] } },
      ),
    );
    expect(r.urlPolicy.linkPrefixes).toEqual(['other://']);
  });

  it('an undefined value never overwrites', () => {
    // Overrides are often built from optional props; a hole in one must not
    // clear what the preset set.
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
    withOptions(presets.llmChat, { extensions: { math: true }, html: 'raw' });
    expect(JSON.stringify(presets.llmChat)).toBe(before);
  });

  it('with no overrides it returns a COPY, equivalent but not the preset', () => {
    // It used to return `base` itself (a `reduce` over no elements returns
    // its seed), so `withOptions(presets.llmChat)` handed back the shared
    // preset object and a caller who wrote to what looked like their own
    // options rewrote the preset for every other consumer in the process.
    const copy = withOptions(presets.llmChat);
    expect(copy).not.toBe(presets.llmChat);
    expect(resolveOptions(copy)).toEqual(resolveOptions(presets.llmChat));
    expect(resolveOptions(withOptions(presets.llmChat, undefined))).toEqual(
      resolveOptions(presets.llmChat),
    );
  });

  it('the copy is deep enough to be written to', () => {
    // A top-level spread alone would still share `extensions` and the prefix
    // arrays with the preset, which is where a caller is most likely to poke.
    const before = JSON.stringify(presets.everything);
    const copy = withOptions(presets.everything);
    expect(copy.extensions).not.toBe(presets.everything.extensions);
    (copy.extensions as { math: boolean }).math = false;
    copy.urlPolicy?.linkPrefixes?.push('app://');
    expect(JSON.stringify(presets.everything)).toBe(before);
    expect(resolveOptions(presets.everything).extensions.math).toBe(true);
  });
});
