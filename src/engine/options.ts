export interface ExtensionFlags {
  tables: boolean;
  strikethrough: boolean;
  tasklists: boolean;
  autolinks: boolean;
  /** `$...$` / `$$...$$` — off by default (currency hazard). */
  math: boolean;
  /**
   * `||...||` — MUST default false in EVERY preset. A stray '|' in prose
   * must never change rendering unless the consumer opted in.
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
 *   label's inline structure intact. The node is still never navigable: the
 *   default renderer draws its label unstyled and inert, so the rendering is
 *   the same as under `'text'` until a renderer claims it. Choose this to
 *   render custom-scheme destinations yourself — citation markers, record
 *   pills, in-app actions — without opening the navigation allowlist to
 *   those schemes.
 *
 * Autolinks are unaffected either way: an autolink's display text *is* its
 * destination, so there is no label for a renderer to keep, and a blocked one
 * always degrades to that text.
 */
export type BlockedLinkBehavior = 'text' | 'node';

export interface EngineOptions {
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

export const presets: {
  /** Pure CommonMark: all extensions off. */
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
