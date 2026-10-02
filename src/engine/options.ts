export interface ExtensionFlags {
  tables: boolean;
  strikethrough: boolean;
  tasklists: boolean;
  autolinks: boolean;
  /** `$...$` / `$$...$$` — off by default (currency hazard). */
  math: boolean;
  /**
   * `||...||` — false in every preset except `everything`: a stray `|` must
   * never change rendering unless the consumer opted in.
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
 *   In a flowing paragraph it is a `blockedLink` mark, not a rendered node:
 *   reach it with `attributeForMark`, `onLinkPress` or `embed`. A `link`
 *   renderer sees it only inside a standalone block.
 *
 * Autolinks are unaffected either way: an autolink's display text *is* its
 * destination, so there is no label for a renderer to keep, and a blocked one
 * always degrades to that text.
 */
export type BlockedLinkBehavior = 'text' | 'node';

export interface EngineOptions {
  /**
   * Replaces a preset's flags rather than extending them: every omitted flag
   * resolves to false. Use {@link withOptions} to override one and keep the rest.
   */
  extensions?: Partial<ExtensionFlags>;
  /**
   * Default 'strip'. The object form keeps an allow-list of tags as real
   * nodes (`a`, `br`, `strong`, `b`, `em`, `i`, `s`, `del`, `strike`, `u`,
   * `ins`, `code`) and treats every other tag as `other` (default 'strip').
   */
  html?: 'strip' | 'raw' | { allow: readonly string[]; other?: 'strip' | 'raw' };
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
  /** What the engine is asked for: 'raw' whenever an allow-list is set. */
  html: 'strip' | 'raw';
  /** Tags `parseDocument` turns into nodes after the engine; empty by default. */
  htmlAllow: readonly string[];
  /** The treatment of tags outside `htmlAllow` when it is set. */
  htmlOther: 'strip' | 'raw';
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
    html: typeof o?.html === 'object' ? 'raw' : (o?.html ?? 'strip'),
    htmlAllow: typeof o?.html === 'object' ? [...o.html.allow] : [],
    htmlOther: typeof o?.html === 'object' ? (o.html.other ?? 'strip') : 'strip',
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
 * Layers overrides on a preset. `extensions` and `urlPolicy` merge field by
 * field; everything else is last-writer-wins, and `undefined` never
 * overwrites. The prefix arrays replace rather than concatenate, so widening
 * an allowlist stays explicit. Always returns a fresh object.
 */
export function withOptions(
  base: EngineOptions,
  ...overrides: (EngineOptions | undefined)[]
): EngineOptions {
  const merged = overrides.reduce<EngineOptions>((acc, override) => {
    if (!override) return acc;
    const next = assignDefined(acc, override);
    if (acc.extensions ?? override.extensions) {
      next.extensions = assignDefined(acc.extensions ?? {}, override.extensions);
    }
    if (acc.urlPolicy ?? override.urlPolicy) {
      next.urlPolicy = assignDefined(acc.urlPolicy ?? {}, override.urlPolicy);
    }
    return next;
  }, base);
  return copyOptions(merged);
}

/**
 * Copies the nested groups and prefix arrays too, so the result never aliases
 * `base` (often a shared preset) or an override.
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
   * Every extension off. Not a spec-conformance mode: `html` is still
   * `'strip'` and destinations are still allowlisted; see
   * `conformance/run-commonmark.mjs` for a conformant setup.
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
