import { IS_DEV } from '../dev';
import { Platform } from 'react-native';
import type { HeadingLevel } from '../document/nodes';

/**
 * Font-weight token. The string subset of React Native's
 * `TextStyle['fontWeight']`, so every value is assignable to a text style on
 * both render paths. The native host resolves numeric weights to the nearest
 * face the family carries (pre-API-28 Android is the one surface that still
 * collapses them to regular/bold at the CSS 600 cut).
 */
export type ThemeFontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900';

/** Vertical margins around one block, in points. */
export interface BlockSpacing {
  before?: number;
  after?: number;
}

/** One heading level's typography; every field overrides the group-wide token. */
export interface HeadingLevelStyle extends BlockSpacing {
  fontSize?: number;
  /** Absolute, in points. */
  lineHeight?: number;
  fontFamily?: string;
  color?: string;
  weight?: ThemeFontWeight;
  letterSpacing?: number;
}

/** Typography for one kind of table cell (header or body). */
export interface TableCellTextStyle {
  fontFamily?: string;
  fontSize?: number;
  /** Absolute, in points. */
  lineHeight?: number;
  color?: string;
  weight?: ThemeFontWeight;
  letterSpacing?: number;
}

/**
 * How a bullet is drawn. Ordered numbers and task boxes always render as
 * text; only the bullet glyph becomes a dot.
 */
export type ListMarkerStyle =
  | {
      kind: 'dot';
      /** Diameter, in points. */
      size: number;
      /** Space between the dot and the item's text. */
      gap: number;
      /** Unset: `colors.listMarker`, else the text colour. */
      color?: string;
    }
  | {
      kind: 'glyph';
      /** Replaces `glyphs.bullet`. */
      glyph?: string;
      color?: string;
      fontFamily?: string;
      fontSize?: number;
      weight?: ThemeFontWeight;
    };

export type UnderlineStyle = 'solid' | 'double' | 'dotted' | 'dashed' | 'none';

/**
 * Flat token object; consumer overrides are deep-merged over the defaults
 * one group deep (`colors`, `fonts`, `spacing`, `code`, `quote`, `table`,
 * `headings`, `rule`, `glyphs`, `blocks`, `list`, `html`, `link`).
 *
 * One group deep is not the whole rule: four tokens also feed a token in
 * another group when that one is not itself overridden. See `mergeTheme`.
 */
/** A `theme.blocks` margin kind, as `blocks.firstBlockLead` lists them. */
export type BlockSpacingKind = 'paragraph' | 'heading' | 'list' | 'listItem' | 'quote' | 'code' | 'table' | 'rule';

export interface MarkdownTheme {
  colors: {
    text: string;
    heading: string;
    link: string;
    /**
     * Colour for a link the URL policy rejected (`urlPolicy.blockedLinks:
     * 'node'`, mark kind 'blockedLink').
     *
     * OPTIONAL, AND UNSET BY DEFAULT, DELIBERATELY. These ranges carried no
     * mark at all until 'blockedLink' existed, so they rendered as the text
     * around them; defaulting a colour here would silently restyle every
     * consumer's blocked schemes, and — because marks apply outermost-first
     * with the inner winning — would also override the heading colour of a
     * blocked link inside a heading. Unset means "look like the surrounding
     * text", which is the pre-existing behaviour.
     *
     * Set it when your blocked schemes are meaningful identifiers the reader
     * should be able to see — citation markers, entity references — rather
     * than URLs you happen not to allow.
     */
    blockedLink?: string;
    /**
     * Colour for list bullets, ordered-list numbers and task glyphs.
     * Unset (the default) means the markers inherit the surrounding text
     * colour, which is the pre-existing behaviour.
     */
    listMarker?: string;
    /**
     * Colour for strong (bold) inline text. Unset (the default) means strong
     * inherits the surrounding text colour, which is the pre-existing
     * behaviour. Pairs with `fonts.strongFamily` for designs whose bold is a
     * distinct face in a distinct shade rather than a weight bump.
     */
    strong?: string;
    /** Colour for emphasis (italic) text; unset inherits, like `strong`. */
    emphasis?: string;
    muted: string;
    codeText: string;
    codeBackground: string;
    quoteText: string;
    /** @deprecated Use `quote.barColor`. Still accepted as an INPUT: when
     * set without an explicit `quote.barColor` override, `quote.barColor`
     * inherits it. Absent from the default themes, since nothing reads it. */
    quoteBar?: string;
    border: string;
    tableHeaderBackground: string;
    spoilerMask: string;
    spoilerRevealedBackground: string;
    /** Background of a `highlights` match. */
    highlight: string;
    /** Text colour of a `highlights` match; unset keeps the text's own. */
    highlightText?: string;
  };
  fonts: {
    body: string;
    mono: string;
    /** Base body font size; heading sizes scale from it. */
    baseSize: number;
    /** Line-height multiplier applied to font sizes. */
    lineHeight: number;
    /** Weight applied to strong (bold) inline text. */
    strongWeight: ThemeFontWeight;
    /**
     * Font family for strong (bold) inline text. OPTIONAL AND UNSET BY
     * DEFAULT: unset, strong stays in the body family and bolds by
     * `strongWeight` alone.
     *
     * Exists because a weight token cannot express every design. An app that
     * ships one font FILE per family gets nothing from `fontWeight: '700'`
     * on iOS — the weight resolves within the single-face family and
     * silently renders regular — so bold there is a FAMILY swap (e.g.
     * `MyFont-Regular` body, `MyFont-Medium` strong, with `strongWeight`
     * pinned back to '400'). Before this token that swap needed an
     * `attributeForMark` override plus a `strong` renderer override, kept in
     * step by hand.
     */
    strongFamily?: string;
  };
  spacing: {
    blockGap: number;
    /** Indent per list nesting level. Read by the native run path, where it
     * is a real hanging indent (wrapped lines align under the item's text).
     * The STANDALONE-BLOCK renderer in `renderers.tsx` does not read it: it
     * approximates depth with literal spaces inside one `<Text>`, a
     * structural limit of nesting text rather than a themed choice. Note
     * that path is not a degraded tier — every standalone block renders
     * through it, and a consumer whose `classifyBlock` returns 'standalone'
     * for everything renders its whole document that way. */
    listIndent: number;
    /** @deprecated Use `quote.indent`. Still accepted as an INPUT: when set
     * without an explicit `quote.indent` override, `quote.indent` inherits
     * it. Optional and absent from `defaultTheme` — it used to ship as 10
     * while the indent that actually renders, `quote.indent`, is 12. */
    quoteIndent?: number;
    codePadding: number;
    /** @deprecated Use `table.cellPaddingH` / `table.cellPaddingV`. Still
     * accepted as an INPUT: when set, it feeds whichever of the two is not
     * explicitly overridden. Optional and absent from `defaultTheme` — it
     * used to ship as 8 while the vertical padding that actually renders,
     * `table.cellPaddingV`, is 6. */
    tableCellPadding?: number;
    /** Height of the built-in `image` renderer's box on both paths, standalone
     * and embedded, so the reservation and the picture drawn over it agree. */
    imageHeight: number;
    /** Width in points an image embed reserves (`images: 'embed'` only).
     * Defaults narrow (280) because the hosts do not clamp it against list or
     * cell margins; set it to your column width when the document is full-bleed. */
    imageWidth: number;
    /** Padding around the whole rendered document. */
    containerPadding: number;
  };
  code: {
    fontSize: number;
    borderRadius: number;
    /** Vertical padding inside a code block (horizontal is `spacing.codePadding`). */
    paddingVertical: number;
  };
  quote: {
    /**
     * Fill behind a blockquote. Set `'transparent'` for the bar-only look;
     * unset falls back to no fill.
     */
    background?: string;
    /** Colour of the vertical bar. When only the deprecated `colors.quoteBar`
     * is overridden, `mergeTheme` feeds it in here, so pre-`quote`-group
     * themes keep recolouring the bar. */
    barColor: string;
    barWidth: number;
    borderRadius: number;
    /** Horizontal inset of the quote body from the bar. */
    indent: number;
    paddingVertical: number;
  };
  table: {
    borderWidth: number;
    /** Corner radius of the border box. Tables used to round with
     * `code.borderRadius`, so an explicit override of that token still feeds
     * this when `table.borderRadius` itself is not overridden. */
    borderRadius: number;
    cellPaddingH: number;
    /** Vertical cell padding on both paths. The fallback pads every cell;
     * the native path pads the table's outer band via the border box and
     * every interior row boundary via the 'columns' decoration's
     * `rowPaddingV` (each boundary opens by twice this, its rule centred),
     * so rows on both paths carry this much space above and below their
     * text. */
    cellPaddingV: number;
    rowRuleThickness: number;
    headerWeight: ThemeFontWeight;
    /** Draw the outer border. Default true; false keeps only the row rules. */
    frame: boolean;
    /** Outer border colour; unset: `colors.border`. */
    frameColor?: string;
    /** Row rule colour; unset: `colors.border`. */
    ruleColor?: string;
    /** Header-row typography; `weight` here beats `headerWeight`. */
    header?: TableCellTextStyle;
    /** Body-row typography. */
    body?: TableCellTextStyle;
    /** Collapse a header row whose cells are all empty, with its band and rule. */
    hideEmptyHeader: boolean;
  };
  headings: {
    /** Multipliers over `fonts.baseSize` for h1..h6. */
    scale: number[];
    weight: ThemeFontWeight;
    /**
     * ABSOLUTE line height in points, applied to every heading level.
     * OPTIONAL AND UNSET BY DEFAULT: unset, each heading takes
     * `fontSize × fonts.lineHeight`, the pre-existing behaviour.
     *
     * Exists because the multiplier cannot express a pinned leading. A chat
     * design that lays every line — body and heading alike — on one 24pt
     * grid has no multiplier that produces it (h1 at 24pt × 1.5 = 36), so
     * pinning it needed a complete `attributeForMark` heading override that
     * then had to restate size, colour and weight the theme already knew.
     */
    lineHeight?: number;
    /** Family for every level; unset: `fonts.body`. */
    fontFamily?: string;
    letterSpacing?: number;
    /**
     * Per-level overrides, index 0 = h1. A level's `fontSize` replaces its
     * `scale`; its `before` / `after` replace `blocks.heading`.
     */
    levels?: readonly (HeadingLevelStyle | undefined)[];
  };
  /** Thematic break (horizontal rule). */
  rule: {
    thickness: number;
    /** Horizontal inset from each edge. */
    inset: number;
    /** Unset: `colors.border`, which tables share. */
    color?: string;
  };
  /**
   * Marker strings prepended to list items. The defaults match the
   * projection defaults in `src/selection/mapSelection.ts`; the view threads
   * these into `projectRun`, so an override re-projects and selection
   * offsets stay exact. A glyph containing `\n` is rejected by `projectRun`
   * (DEV warning; the default stands in) — decorations treat newlines as
   * line boundaries.
   */
  glyphs: {
    bullet: string;
    taskChecked: string;
    taskUnchecked: string;
  };
  /**
   * Per-kind vertical margins, collapsed web-style: two adjacent blocks sit
   * `max(first.after, second.before)` apart, measured from the edge of any
   * box (code, table, quote) rather than its text. EMPTY BY DEFAULT, which
   * keeps the old spacing: one blank line inside a run, `spacing.blockGap`
   * between a run and a standalone block. Setting any key switches the whole
   * document to these margins, an unset side counting as 0.
   */
  blocks: {
    paragraph?: BlockSpacing;
    /** All levels; `headings.levels[n].before/after` override per level. */
    heading?: BlockSpacing;
    list?: BlockSpacing;
    /** Between the items of one list, and between blocks inside an item. */
    listItem?: BlockSpacing;
    quote?: BlockSpacing;
    code?: BlockSpacing;
    table?: BlockSpacing;
    rule?: BlockSpacing;
    /**
     * Apply the first block's `before` above it. Default false: it collapses
     * into the container. A list of kinds applies it only when the first
     * block is one of them: `['heading']` keeps an opening heading's margin
     * and lets an opening paragraph sit flush.
     */
    firstBlockLead?: boolean | readonly BlockSpacingKind[];
    /** Apply the last block's `after` below it. Default false. */
    lastBlockTrail?: boolean;
  };
  list: {
    marker?: ListMarkerStyle;
    /** Shorthand for the gap between items; beats `blocks.listItem`. */
    itemGap?: number;
    /**
     * Width of the marker column. Set (or implied by a dot marker's
     * `size + gap`), the marker is pinned to it so first-line text starts
     * exactly where wrapped lines hang. Unset: wrapped lines hang
     * `spacing.listIndent` deep and the marker keeps its natural width.
     */
    hangingIndent?: number;
  };
  /** Raw HTML that reaches the screen (`html: 'raw'`). */
  html: {
    /** 'code' (default): muted mono. 'text': body text. */
    display: 'code' | 'text';
  };
  link: {
    /** Default 'solid'. */
    underline: UnderlineStyle;
    /** Unset: the link colour. */
    underlineColor?: string;
  };
}

export type PartialTheme = {
  [K in keyof MarkdownTheme]?: Partial<MarkdownTheme[K]>;
};

const quoteMetrics = {
  barWidth: 3,
  borderRadius: 4,
  indent: 12,
  paddingVertical: 4,
};

/** Non-colour groups shared by the light and dark themes. */
const baseTokens = {
  fonts: {
    body: Platform.select({ ios: 'System', default: 'sans-serif' }),
    mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    baseSize: 16,
    lineHeight: 1.4,
    strongWeight: '700',
  },
  spacing: {
    blockGap: 12,
    listIndent: 18,
    codePadding: 12,
    imageHeight: 200,
    imageWidth: 280,
    containerPadding: 0,
  },
  code: {
    fontSize: 13.5,
    borderRadius: 6,
    paddingVertical: 6,
  },
  table: {
    borderWidth: 1,
    borderRadius: 6,
    cellPaddingH: 8,
    cellPaddingV: 6,
    rowRuleThickness: 1,
    headerWeight: '700',
    frame: true,
    hideEmptyHeader: false,
  },
  headings: {
    scale: [1.6, 1.4, 1.25, 1.1, 1.0, 0.9],
    weight: '700',
  },
  blocks: {},
  list: {},
  html: {
    display: 'code',
  },
  link: {
    underline: 'solid',
  },
  rule: {
    thickness: 1,
    inset: 0,
  },
  glyphs: {
    bullet: '• ',
    taskChecked: '☑ ',
    taskUnchecked: '☐ ',
  },
} satisfies Omit<MarkdownTheme, 'colors' | 'quote'>;

export const defaultTheme: MarkdownTheme = {
  ...baseTokens,
  colors: {
    text: '#1f2328',
    heading: '#14171a',
    link: '#0b62d0',
    muted: '#69707a',
    codeText: '#24292f',
    codeBackground: '#f4f5f7',
    quoteText: '#57606a',
    border: '#d8dde3',
    tableHeaderBackground: '#f0f2f5',
    spoilerMask: '#40454c',
    spoilerRevealedBackground: '#e9ebee',
    highlight: '#fff3a3',
  },
  quote: {
    background: '#6e77810d',
    barColor: '#c9ced6',
    ...quoteMetrics,
  },
};

/**
 * Dark counterpart of `defaultTheme`: light text over a transparent (dark)
 * host background. Pass it as the `base` of `mergeTheme` to layer consumer
 * overrides on top.
 */
export const defaultDarkTheme: MarkdownTheme = {
  ...baseTokens,
  colors: {
    text: '#e6edf3',
    heading: '#f0f6fc',
    link: '#58a6ff',
    muted: '#8b949e',
    codeText: '#e6edf3',
    codeBackground: '#161b22',
    quoteText: '#8b949e',
    border: '#30363d',
    tableHeaderBackground: '#161b22',
    spoilerMask: '#484f58',
    spoilerRevealedBackground: '#21262d',
    highlight: '#6e5a0f',
  },
  quote: {
    background: '#ffffff0d',
    barColor: '#3d444d',
    ...quoteMetrics,
  },
};

export function headingFontSize(
  theme: MarkdownTheme,
  level: HeadingLevel,
): number {
  const pinned = theme.headings.levels?.[level - 1]?.fontSize;
  if (pinned !== undefined) return pinned;
  return Math.round(theme.fonts.baseSize * (theme.headings.scale[level - 1] ?? 1));
}

/** The glyph unordered items project with: `list.marker.glyph`, else `glyphs.bullet`. */
export function bulletGlyph(theme: MarkdownTheme): string {
  const marker = theme.list.marker;
  return marker?.kind === 'glyph' && marker.glyph !== undefined ? marker.glyph : theme.glyphs.bullet;
}

/** A heading level's resolved typography, shared by both render paths. */
export interface ResolvedHeadingStyle {
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  color: string;
  fontWeight: ThemeFontWeight;
  letterSpacing?: number;
}

export function headingStyle(
  theme: MarkdownTheme,
  level: HeadingLevel,
): ResolvedHeadingStyle {
  const { headings } = theme;
  const own = headings.levels?.[level - 1];
  const fontSize = headingFontSize(theme, level);
  const style: ResolvedHeadingStyle = {
    fontSize,
    lineHeight: own?.lineHeight ?? headings.lineHeight ?? fontSize * theme.fonts.lineHeight,
    fontFamily: own?.fontFamily ?? headings.fontFamily ?? theme.fonts.body,
    color: own?.color ?? theme.colors.heading,
    fontWeight: own?.weight ?? headings.weight,
  };
  const letterSpacing = own?.letterSpacing ?? headings.letterSpacing;
  if (letterSpacing !== undefined) style.letterSpacing = letterSpacing;
  return style;
}



/** The DEV check's runtime key table; `UnlistedThemeKey` fails the typecheck when it misses a token. */
const THEME_KEYS = {
  colors: [
    'text',
    'heading',
    'link',
    'blockedLink',
    'listMarker',
    'strong',
    'emphasis',
    'muted',
    'codeText',
    'codeBackground',
    'quoteText',
    'quoteBar',
    'border',
    'tableHeaderBackground',
    'spoilerMask',
    'spoilerRevealedBackground',
    'highlight',
    'highlightText',
  ],
  fonts: ['body', 'mono', 'baseSize', 'lineHeight', 'strongWeight', 'strongFamily'],
  spacing: [
    'blockGap',
    'listIndent',
    'quoteIndent',
    'codePadding',
    'tableCellPadding',
    'imageHeight',
    'imageWidth',
    'containerPadding',
  ],
  code: ['fontSize', 'borderRadius', 'paddingVertical'],
  quote: [
    'background',
    'barColor',
    'barWidth',
    'borderRadius',
    'indent',
    'paddingVertical',
  ],
  table: [
    'borderWidth',
    'borderRadius',
    'cellPaddingH',
    'cellPaddingV',
    'rowRuleThickness',
    'headerWeight',
    'frame',
    'frameColor',
    'ruleColor',
    'header',
    'body',
    'hideEmptyHeader',
  ],
  headings: ['scale', 'weight', 'lineHeight', 'fontFamily', 'letterSpacing', 'levels'],
  rule: ['thickness', 'inset', 'color'],
  glyphs: ['bullet', 'taskChecked', 'taskUnchecked'],
  blocks: [
    'paragraph',
    'heading',
    'list',
    'listItem',
    'quote',
    'code',
    'table',
    'rule',
    'firstBlockLead',
    'lastBlockTrail',
  ],
  list: ['marker', 'itemGap', 'hangingIndent'],
  html: ['display'],
  link: ['underline', 'underlineColor'],
} as const satisfies {
  [K in keyof MarkdownTheme]: readonly (keyof MarkdownTheme[K])[];
};

type UnlistedThemeKey = {
  [K in keyof MarkdownTheme]: Exclude<
    keyof MarkdownTheme[K],
    (typeof THEME_KEYS)[K][number]
  >;
}[keyof MarkdownTheme];

type AssertNever<T extends never> = T;

type _ThemeKeysAreExhaustive = AssertNever<UnlistedThemeKey>;

const warnedThemeKeys = new Set<string>();

function warnThemeKeyOnce(label: string, message: string): void {
  if (warnedThemeKeys.has(label)) {
    return;
  }
  warnedThemeKeys.add(label);
  console.warn(`[react-native-selectable-markdown] ${message}`);
}

/**
 * DEV, warn-once per token: `mergeGroup` copies an unknown key through, where
 * nothing reads it, and an untyped JS theme gets no other signal.
 */
function warnUnknownThemeKeys(overrides: PartialTheme): void {
  for (const group of Object.keys(overrides) as (keyof MarkdownTheme)[]) {
    const known = THEME_KEYS[group] as readonly string[] | undefined;
    if (!known) {
      warnThemeKeyOnce(
        String(group),
        `Unknown theme group "${String(group)}"; it is ignored. ` +
          `Groups: ${Object.keys(THEME_KEYS).join(', ')}.`,
      );
      continue;
    }
    const groupOverrides = overrides[group] as Record<string, unknown> | undefined;
    if (!groupOverrides) {
      continue;
    }
    for (const key of Object.keys(groupOverrides)) {
      if (known.includes(key)) {
        continue;
      }
      warnThemeKeyOnce(
        `${group}.${key}`,
        `Unknown theme token "${group}.${key}"; it is ignored. ` +
          `Known ${group} tokens: ${known.join(', ')}.`,
      );
    }
  }
}

function mergeGroup<T extends object>(base: T, overrides?: Partial<T>): T {
  if (!overrides) {
    return base;
  }
  const merged: T = { ...base };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      merged[key] = value as T[keyof T];
    }
  }
  return merged;
}

/**
 * Layers `overrides` over `base`, one group deep — every group of `base` is
 * copied and each supplied key replaces its counterpart.
 *
 * Four tokens also feed another group, each only when the token it feeds is
 * not itself overridden:
 *
 * - `code.borderRadius` → `table.borderRadius`.
 * - `spacing.quoteIndent` → `quote.indent` (deprecated input).
 * - `spacing.tableCellPadding` → `table.cellPaddingH` and `cellPaddingV`
 *   (deprecated input; feeds whichever of the two is not overridden).
 * - `colors.quoteBar` → `quote.barColor` (deprecated input).
 *
 * Only `overrides` feeds them: a base theme's own `code.borderRadius` does not
 * re-link its table radius.
 */
export function mergeTheme(
  overrides?: PartialTheme,
  base: MarkdownTheme = defaultTheme,
): MarkdownTheme {
  if (!overrides) {
    return base;
  }
  if (IS_DEV) {
    warnUnknownThemeKeys(overrides);
  }
  let quote = mergeGroup(base.quote, overrides.quote);
  const quoteIndent = overrides.spacing?.quoteIndent;
  if (quoteIndent !== undefined && overrides.quote?.indent === undefined) {
    quote = { ...quote, indent: quoteIndent };
  }
  const quoteBar = overrides.colors?.quoteBar;
  if (IS_DEV && quoteBar !== undefined) {
    warnThemeKeyOnce('colors.quoteBar', 'colors.quoteBar is deprecated; use quote.barColor.');
  }
  if (quoteBar !== undefined && overrides.quote?.barColor === undefined) {
    quote = { ...quote, barColor: quoteBar };
  }
  let table = mergeGroup(base.table, overrides.table);
  const cellPadding = overrides.spacing?.tableCellPadding;
  if (cellPadding !== undefined) {
    table = {
      ...table,
      cellPaddingH: overrides.table?.cellPaddingH ?? cellPadding,
      cellPaddingV: overrides.table?.cellPaddingV ?? cellPadding,
    };
  }
  const codeRadius = overrides.code?.borderRadius;
  if (codeRadius !== undefined && overrides.table?.borderRadius === undefined) {
    table = { ...table, borderRadius: codeRadius };
  }
  return {
    colors: mergeGroup(base.colors, overrides.colors),
    fonts: mergeGroup(base.fonts, overrides.fonts),
    spacing: mergeGroup(base.spacing, overrides.spacing),
    code: mergeGroup(base.code, overrides.code),
    quote,
    table,
    headings: mergeGroup(base.headings, overrides.headings),
    rule: mergeGroup(base.rule, overrides.rule),
    glyphs: mergeGroup(base.glyphs, overrides.glyphs),
    blocks: mergeGroup(base.blocks, overrides.blocks),
    list: mergeGroup(base.list, overrides.list),
    html: mergeGroup(base.html, overrides.html),
    link: mergeGroup(base.link, overrides.link),
  };
}
