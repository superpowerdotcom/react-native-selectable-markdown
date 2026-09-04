export interface ExtensionFlags {
  tables: boolean;
  strikethrough: boolean;
  tasklists: boolean;
  autolinks: boolean;
  /** `$...$` / `$$...$$` — off by default (currency hazard). */
  math: boolean;
  /**
   * `||...||` — false in every preset except `everything`, which exists to
   * turn everything on and says so. A stray '|' in prose must never change
   * rendering unless the consumer opted in, so no preset meant for text you
   * did not write may enable this.
   */
  spoilers: boolean;
  underline: boolean;
}

/**
 * What `[label](dest)` becomes when `dest` fails `urlPolicy.linkPrefixes`.
 *
 * - `'text'` (default) — the construct collapses into a plain text node
 *   carrying the label. The `link` renderer never runs, so a renderer cannot
 *   distinguish it from prose the author typed.
 * - `'node'` — the `link` node survives, flagged `blocked: true`, with its
 *   label's inline structure intact. It is still never navigable.
 *
 *   THE `link` RENDERER IS NOT HOW YOU REACH IT, for ordinary prose. A
 *   paragraph holding a blocked link is a FLOWING block — `VIEW_KINDS` in
 *   `selection/runs.ts` holds only `image` and `spoiler` — so it is projected
 *   into a selection run, where the blocked link is a `blockedLink` MARK over
 *   a character range and not a node anyone renders. `renderBlocks` runs only
 *   for standalone blocks (`SelectableMarkdown.tsx`, `if (run.standalone)`),
 *   which a paragraph becomes only when something else in it forces the issue
 *   — an image or a spoiler in its subtree, or a `classifyBlock` claim. So a
 *   `link` renderer override sees a blocked link that happens to share a
 *   paragraph with an image, and never one in a plain sentence.
 *
 *   The channels that do reach it: `attributeForMark` to style the range (the
 *   mark carries `href`), `onLinkPress` to hear a press on it — the only
 *   channel that does — `embed` to draw a real element inside the sweep, or
 *   `classifyBlock` returning `'standalone'` to put the whole containing
 *   block back on the renderer path. Choose `'node'` to surface
 *   custom-scheme destinations yourself — citation markers, record pills,
 *   in-app actions — without opening the navigation allowlist to those
 *   schemes.
 *
 * Autolinks are unaffected either way: an autolink's display text *is* its
 * destination, so there is no label for a renderer to keep, and a blocked one
 * always degrades to that text.
 */
export type BlockedLinkBehavior = 'text' | 'node';

export interface EngineOptions {
  /**
   * REPLACES a preset's flags, it does not extend them. Every flag this
   * object omits resolves to false, whatever preset the rest of the literal
   * came from — `{ ...presets.llmChat, extensions: { math: true } }` turns
   * tables, strikethrough, tasklists and autolinks OFF while turning math on.
   * Use {@link withOptions} to override one field and keep the rest.
   */
  extensions?: Partial<ExtensionFlags>;
  /** Default 'strip'. */
  html?: 'strip' | 'raw';
  /** Default false. */
  smartPunctuation?: boolean;
  urlPolicy?: {
    /**
     * REPLACES the defaults, it does not extend them — spread
     * `DEFAULT_LINK_PREFIXES` in to keep them.
     */
    linkPrefixes?: string[];
    /** Replaces `DEFAULT_IMAGE_PREFIXES`; see `linkPrefixes`. */
    imagePrefixes?: string[];
    /** Default 'text'. */
    blockedLinks?: BlockedLinkBehavior;
  };
}

export interface ResolvedEngineOptions {
  extensions: ExtensionFlags;
  html: 'strip' | 'raw';
  smartPunctuation: boolean;
  urlPolicy: {
    linkPrefixes: string[];
    imagePrefixes: string[];
    blockedLinks: BlockedLinkBehavior;
  };
}

const NO_EXTENSIONS: ExtensionFlags = {
  tables: false,
  strikethrough: false,
  tasklists: false,
  autolinks: false,
  math: false,
  spoilers: false,
  underline: false,
};

/**
 * Blocked links render as plain text (not stripped, not a dead link);
 * blocked images degrade to their alt text.
 */
export const DEFAULT_LINK_PREFIXES: readonly string[] = [
  'https://',
  'http://',
  'mailto:',
];
export const DEFAULT_IMAGE_PREFIXES: readonly string[] = ['https://'];

export function resolveOptions(o?: EngineOptions): ResolvedEngineOptions {
  return {
    extensions: { ...NO_EXTENSIONS, ...o?.extensions },
    html: o?.html ?? 'strip',
    smartPunctuation: o?.smartPunctuation ?? false,
    urlPolicy: {
      linkPrefixes: [
        ...(o?.urlPolicy?.linkPrefixes ?? DEFAULT_LINK_PREFIXES),
      ],
      imagePrefixes: [
        ...(o?.urlPolicy?.imagePrefixes ?? DEFAULT_IMAGE_PREFIXES),
      ],
      blockedLinks: o?.urlPolicy?.blockedLinks ?? 'text',
    },
  };
}

/**
 * Compose options on top of a preset without losing what the preset set.
 *
 * `EngineOptions` is a replace-everything literal: `resolveOptions` merges
 * `extensions` over an all-false base, so a partial one turns every flag it
 * omits OFF. Spreading a preset does not help, because the spread is shallow —
 * `{ ...presets.everything, extensions: { math: false } }` keeps
 * `smartPunctuation: true` and resolves every extension to false, which is
 * silent, plausible-looking, and exactly backwards from what it reads like.
 * The same trap costs `{ urlPolicy: { blockedLinks: 'node' } }` alone its
 * tables, strikethrough, tasklists and autolinks when the app meant
 * `llmChat`.
 *
 * So: start from a preset and layer overrides.
 *
 * ```ts
 * const options = withOptions(presets.llmChat, {
 *   urlPolicy: { blockedLinks: 'node' },   // GFM extensions survive
 * });
 * const withMath = withOptions(presets.llmChat, { extensions: { math: true } });
 * ```
 *
 * `extensions` and `urlPolicy` merge field by field; everything else, scalars
 * included, is last-writer-wins. The two prefix ARRAYS still replace rather
 * than concatenate — an allowlist that grew by accident is a security bug, so
 * widening one stays explicit (spread `DEFAULT_LINK_PREFIXES` yourself).
 * An `undefined` value never overwrites, so an override built from optional
 * props does not have to strip its own holes.
 *
 * The result is always a fresh object — nested groups and prefix arrays
 * included — even when no override is passed at all, so `base` (usually a
 * shared `presets` object) is never handed back for a caller to mutate.
 */
export function withOptions(
  base: EngineOptions,
  ...overrides: (EngineOptions | undefined)[]
): EngineOptions {
  return overrides.reduce<EngineOptions>((acc, override) => {
    if (!override) return acc;
    const merged = assignDefined(acc, override);
    if (acc.extensions ?? override.extensions) {
      merged.extensions = assignDefined(acc.extensions ?? {}, override.extensions);
    }
    if (acc.urlPolicy ?? override.urlPolicy) {
      merged.urlPolicy = assignDefined(acc.urlPolicy ?? {}, override.urlPolicy);
    }
    return merged;
  }, copyOptions(base));
}

/**
 * A structural copy of an options literal: the object, its two nested groups
 * and the two prefix arrays.
 *
 * `withOptions` seeds its merge with this so that the result is ALWAYS the
 * caller's own object. `reduce` over an empty override list returns its seed
 * untouched, so seeding with `base` made `withOptions(presets.llmChat)`
 * return the shared preset itself — and a caller who then set
 * `options.extensions.math = true` on what looks like a private copy would
 * have switched math on for every other consumer in the process. The nested
 * copies matter for the same reason: a top-level spread alone would still
 * hand back the preset's own `extensions` object and prefix arrays.
 */
function copyOptions(o: EngineOptions): EngineOptions {
  const out: EngineOptions = { ...o };
  if (o.extensions) out.extensions = { ...o.extensions };
  if (o.urlPolicy) {
    out.urlPolicy = { ...o.urlPolicy };
    if (o.urlPolicy.linkPrefixes) out.urlPolicy.linkPrefixes = [...o.urlPolicy.linkPrefixes];
    if (o.urlPolicy.imagePrefixes) out.urlPolicy.imagePrefixes = [...o.urlPolicy.imagePrefixes];
  }
  return out;
}

/** Shallow copy of `target` with the DEFINED own properties of `source` over it. */
function assignDefined<T extends object>(target: T, source: T | undefined): T {
  const out: T = { ...target };
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export const presets: {
  /**
   * Every extension off — CommonMark's syntax and nothing beyond it.
   *
   * NOT a spec-conformance mode. The two non-extension defaults still apply:
   * `html` is `'strip'`, so a CommonMark-conformant HTML block or inline span
   * contributes nothing to the document (`<br>` excepted — it becomes a hard
   * break), and destinations are still allowlisted, so a conformant
   * `[a](ftp://e.com)` degrades to text. Scoring the spec needs
   * `html: 'raw'` and an open `urlPolicy`; `conformance/run-commonmark.mjs`
   * is the reference for what that looks like.
   */
  commonmark: EngineOptions;
  /**
   * Safe defaults for LLM output: tables, strikethrough, tasklists and
   * autolinks on; math, spoilers and underline off; HTML stripped.
   */
  llmChat: EngineOptions;
  /**
   * Every extension on, plus smart punctuation — the ONLY preset that
   * enables spoilers. Warning: with spoilers enabled, balanced `||...||`
   * in prose becomes hidden spoiler content. Do not feed untrusted or
   * LLM-generated text through this preset unless that is what you want.
   */
  everything: EngineOptions;
} = {
  commonmark: {
    extensions: {
      tables: false,
      strikethrough: false,
      tasklists: false,
      autolinks: false,
      math: false,
      spoilers: false,
      underline: false,
    },
  },
  llmChat: {
    extensions: {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      math: false,
      spoilers: false,
      underline: false,
    },
    html: 'strip',
  },
  everything: {
    extensions: {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      math: true,
      spoilers: true,
      underline: true,
    },
    smartPunctuation: true,
  },
};
