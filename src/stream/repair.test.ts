import { visit } from '../document/visit';
import { parseDocument } from '../engine/Engine';
import {
  describeNative,
  linkNativeEngineAsDefault,
} from '../engine/native/__tests__/support';
import type { ResolvedEngineOptions } from '../engine/options';
import { presets, resolveOptions } from '../engine/options';
import type { RepairOptions, RepairResult, RepairSeed } from './repair';
import { continueSeed, isUriLikeLabel, repairTail, seedFromSettled } from './repair';

// Only the property test at the bottom parses its repaired tails.
linkNativeEngineAsDefault();

const SEED: RepairSeed = { openFence: null, inMath: false };
const base = resolveOptions(presets.llmChat);
const withMath = resolveOptions({
  ...presets.llmChat,
  extensions: { ...presets.llmChat.extensions, math: true },
});
const commonmark = resolveOptions(presets.commonmark);
const withSpoilers = resolveOptions({
  ...presets.llmChat,
  extensions: { ...presets.llmChat.extensions, spoilers: true },
});

interface Case {
  name: string;
  tail: string;
  seed?: RepairSeed;
  options?: ResolvedEngineOptions;
  repair?: RepairOptions;
  /** Expected parse-input text. */
  text: string;
  /** Expected pure appended suffix. */
  appended?: string;
  /** Expected number of touched spans. */
  touched?: number;
}

const openBacktickFence: RepairSeed = {
  openFence: { marker: '`', length: 3 },
  inMath: false,
};
const openTildeFence: RepairSeed = {
  openFence: { marker: '~', length: 4 },
  inMath: false,
};
const inMathSeed: RepairSeed = { openFence: null, inMath: true };

const hideLabels: RepairOptions = { hideUriLikeLabels: true };
const hideMessage: RepairOptions = { hideBareUriSchemes: ['message'] };
const hideAll: RepairOptions = {
  hideUriLikeLabels: true,
  hideBareUriSchemes: ['message'],
};

const cases: Case[] = [
  // --- emphasis / strong / strike tails -----------------------------------
  { name: 'unclosed strong closes', tail: '**x', text: '**x**', appended: '**' },
  { name: 'unclosed emphasis closes', tail: '*x', text: '*x*', appended: '*' },
  { name: 'unclosed strong underscore closes', tail: '__x', text: '__x__', appended: '__' },
  { name: 'unclosed emphasis underscore closes', tail: '_x', text: '_x_', appended: '_' },
  { name: 'half-complete strong closer completed', tail: '**x*', text: '**x**', appended: '*' },
  { name: 'half-complete underscore closer completed', tail: '__x_', text: '__x__', appended: '_' },
  { name: 'unclosed strike closes', tail: '~~x', text: '~~x~~', appended: '~~' },
  { name: 'half-complete strike closer completed', tail: '~~x~', text: '~~x~~', appended: '~' },
  {
    name: 'strike untouched when extension off',
    tail: '~~x',
    options: commonmark,
    text: '~~x',
    appended: '',
    touched: 0,
  },
  { name: 'intraword star never opens', tail: 'hello*world', text: 'hello*world', appended: '' },
  { name: 'snake_case untouched', tail: 'snake_case_name', text: 'snake_case_name', appended: '' },
  { name: 'balanced emphasis untouched', tail: 'a _b_ done', text: 'a _b_ done', appended: '' },
  { name: 'bare ** suppressed, never closed', tail: '**', text: '', appended: '', touched: 1 },
  { name: 'trailing content-empty opener suppressed', tail: 'abc **', text: 'abc ', appended: '' },
  { name: 'whitespace-flanked star is a list marker, not emphasis', tail: '* item', text: '* item', appended: '' },
  {
    name: 'nested emphasis closes innermost-first',
    tail: '**bold *nested',
    text: '**bold *nested***',
    appended: '***',
  },
  { name: 'escaped star inert', tail: '\\*literal star', text: '\\*literal star', appended: '' },
  { name: 'mixed strong then emphasis', tail: '**a _b', text: '**a _b_**', appended: '_**' },
  { name: 'trailing space after lone star untouched', tail: 'a * ', text: 'a * ', appended: '' },
  {
    name: 'opener after space with dangling partial closer',
    tail: '**x *',
    text: '**x**',
    appended: '**',
  },

  // --- inline code ---------------------------------------------------------
  { name: 'open code span balanced', tail: '`code', text: '`code`', appended: '`' },
  { name: 'open double-backtick span balanced', tail: '``code', text: '``code``', appended: '``' },
  { name: 'closed code span untouched', tail: '`a` done', text: '`a` done', appended: '' },
  { name: 'link syntax inert inside code span', tail: '`](https://x', text: '`](https://x`', appended: '`' },
  {
    name: 'math and emphasis inert inside code span',
    tail: '`$$ **',
    options: withMath,
    text: '`$$ **`',
    appended: '`',
  },
  { name: 'content-empty backtick opener suppressed', tail: 'a `', text: 'a ', appended: '', touched: 1 },
  {
    name: 'shorter backtick run does not close a longer opener',
    tail: '``a`b',
    text: '``a`b``',
    appended: '``',
  },
  // A trailing run too short to close is the closer still arriving: append
  // only what is missing.
  {
    name: 'partial closing backtick completed, not doubled',
    tail: 'x ``y`',
    text: 'x ``y``',
    appended: '`',
  },
  {
    name: 'partial closer of a triple run appends the two still missing',
    tail: 'a ```x`',
    text: 'a ```x```',
    appended: '``',
  },
  {
    name: 'two-thirds of a triple closer appends the last backtick',
    tail: 'a ```x``',
    text: 'a ```x```',
    appended: '`',
  },

  // --- fences ---------------------------------------------------------------
  {
    name: 'tail-opened fence virtually closed',
    tail: '```js\nconst a = 1',
    text: '```js\nconst a = 1\n```',
    appended: '\n```',
    touched: 1,
  },
  {
    name: 'seeded open fence: close only, no inline repairs',
    tail: 'still code **x',
    seed: openBacktickFence,
    text: 'still code **x\n```',
    appended: '\n```',
    touched: 1,
  },
  {
    name: 'fence closing inside tail re-enables inline repairs after it',
    tail: 'code\n```\nafter **x',
    seed: openBacktickFence,
    text: 'code\n```\nafter **x**',
    appended: '**',
  },
  { name: 'fence just opened, no content yet', tail: '```\n', text: '```\n```', appended: '```' },
  { name: 'tilde fence virtually closed', tail: '~~~\ncode', text: '~~~\ncode\n~~~', appended: '\n~~~' },
  {
    name: 'language token still arriving on fence line',
    tail: '```python',
    text: '```python\n```',
    appended: '\n```',
  },
  {
    name: 'seeded tilde fence closes with matching run length',
    tail: 'x',
    seed: openTildeFence,
    text: 'x\n~~~~',
    appended: '\n~~~~',
  },
  {
    name: 'bare structural line inside open fence is code, not suppressed',
    tail: '```\n-\n',
    text: '```\n-\n```',
    appended: '```',
  },
  {
    name: 'closed fence in tail protects its content, repairs continue after',
    tail: '```\ncode\n```\ndone **x',
    text: '```\ncode\n```\ndone **x**',
    appended: '**',
  },

  // --- math ------------------------------------------------------------------
  { name: 'unclosed display math closes when enabled', tail: '$$x+y', options: withMath, text: '$$x+y$$', appended: '$$' },
  { name: 'closed display math untouched', tail: '$$x$$ done', options: withMath, text: '$$x$$ done', appended: '' },
  {
    name: 'currency dollars untouched even with math on',
    tail: 'costs $5 and $10 total',
    options: withMath,
    text: 'costs $5 and $10 total',
    appended: '',
    touched: 0,
  },
  { name: 'dollars untouched when math off', tail: '$$x', text: '$$x', appended: '', touched: 0 },
  {
    name: 'seeded open math closes when enabled',
    tail: 'e=mc^2',
    seed: inMathSeed,
    options: withMath,
    text: 'e=mc^2$$',
    appended: '$$',
    touched: 1,
  },
  {
    name: 'seeded math ignored when math off',
    tail: 'plain text',
    seed: inMathSeed,
    text: 'plain text',
    appended: '',
  },
  {
    name: 'content-empty math opener suppressed',
    tail: 'tail $$',
    options: withMath,
    text: 'tail ',
    appended: '',
  },

  // --- links and images --------------------------------------------------------
  {
    name: 'partial link destination virtually closed',
    tail: '[text](https://exa',
    text: '[text](https://exa)',
    appended: ')',
  },
  { name: 'empty link destination virtually closed', tail: '[text](', text: '[text]()', appended: ')' },
  { name: 'lone open bracket stripped for display', tail: '[text', text: 'text', appended: '', touched: 1 },
  {
    name: 'incomplete image dropped entirely',
    tail: '![alt](https://x',
    text: '',
    appended: '',
    touched: 1,
  },
  { name: 'unmatched image opener dropped entirely', tail: '![alt', text: '', appended: '' },
  {
    name: 'incomplete image dropped, preceding prose kept',
    tail: 'photo ![alt](https://img',
    text: 'photo ',
    appended: '',
  },
  {
    name: 'complete link untouched',
    tail: '[done](https://ok) rest',
    text: '[done](https://ok) rest',
    appended: '',
  },
  {
    name: 'stripped bracket still closes emphasis inside it',
    tail: 'see [**bold',
    text: 'see **bold**',
    appended: '**',
    touched: 2,
  },
  {
    name: 'unterminated title quote closed before paren',
    tail: '[t](url "titl',
    text: '[t](url "titl")',
    appended: '")',
  },
  {
    name: 'image cut also removes outer bracket content after it',
    tail: '[out ![in](https://u',
    text: 'out ',
    appended: '',
    touched: 2,
  },
  // The content-empty-opener suppression is not hide-specific: any
  // delete-to-end cut (image, partial tag) or strip that empties an
  // adjacent opener must take the opener with it — closer included.
  {
    name: 'emphasis opener adjacent to an image cut suppressed, not closed',
    tail: 'text *![alt](https://i',
    text: 'text ',
    appended: '',
  },
  {
    name: 'emphasis opener adjacent to a stripped bracket suppressed',
    tail: 'end *[',
    text: 'end ',
    appended: '',
  },
  {
    name: 'emphasis opener adjacent to a content-empty code opener suppressed',
    tail: 'a *`',
    text: 'a ',
    appended: '',
  },
  {
    name: 'emphasis opened in link text not closed across destination',
    tail: '[a **b](https://u',
    text: '[a **b](https://u)',
    appended: ')',
  },
  { name: 'plain bracketed label untouched', tail: '[label] plain ref', text: '[label] plain ref', appended: '' },
  {
    name: 'balanced parens inside destination closed with matching depth',
    tail: '[a](https://x/(v',
    text: '[a](https://x/(v))',
    appended: '))',
  },
  // A destination cannot hold a line break, so a '](' unbalanced on its own
  // line can never become a link.
  {
    name: 'destination running into a line break stays literal',
    tail: '[text](https://ex\nmore prose on the next line',
    text: '[text](https://ex\nmore prose on the next line',
    appended: '',
    touched: 0,
  },
  {
    name: 'emphasis after a dead destination still closes',
    tail: '[text](https://ex\nmore *prose',
    text: '[text](https://ex\nmore *prose*',
    appended: '*',
  },
  {
    // A line break inside a quoted TITLE is legal, so the scan runs on and
    // the construct is still an open link.
    name: 'title spanning a line break still closes',
    tail: '[a](/u "ti\ntle',
    text: '[a](/u "ti\ntle")',
    appended: '")',
  },
  {
    // The whitespace before ')' may hold a line break too.
    name: 'closing paren on its own line is a complete link',
    tail: '[a](/u "t"\n) rest',
    text: '[a](/u "t"\n) rest',
    appended: '',
    touched: 0,
  },
  {
    name: 'a link whose paren has not arrived yet still closes',
    tail: '[a](/u "t"\n',
    text: '[a](/u "t"\n)',
    appended: ')',
  },

  // --- html tails -----------------------------------------------------------
  { name: 'trailing partial tag trimmed', tail: '<div cla', text: '', appended: '', touched: 1 },
  { name: 'less-than comparison untouched', tail: '5 < 10', text: '5 < 10', appended: '', touched: 0 },
  { name: 'trailing partial tag after prose trimmed', tail: 'text <b', text: 'text ', appended: '' },
  {
    name: 'complete autolink untouched',
    tail: '<https://example.com> ok',
    text: '<https://example.com> ok',
    appended: '',
  },
  { name: 'trailing partial closing tag trimmed', tail: 'a <b>bold</b tag', text: 'a <b>bold', appended: '' },
  {
    name: 'unterminated html comment trimmed',
    tail: 'note <!-- hidden',
    text: 'note ',
    appended: '',
    touched: 1,
  },
  {
    name: 'terminated html comment untouched',
    tail: 'note <!-- hidden --> ok',
    text: 'note <!-- hidden --> ok',
    appended: '',
    touched: 0,
  },
  {
    name: 'a > inside a comment body does not end it',
    tail: 'note <!-- a > b',
    text: 'note ',
    appended: '',
    touched: 1,
  },
  { name: 'unterminated processing instruction trimmed', tail: 'note <?php x', text: 'note ', appended: '' },
  { name: 'terminated processing instruction untouched', tail: 'note <?php x?> ok', text: 'note <?php x?> ok', appended: '', touched: 0 },
  { name: 'unterminated declaration trimmed', tail: 'x <!DOCTYPE htm', text: 'x ', appended: '' },
  { name: 'unterminated CDATA section trimmed', tail: 'x <![CDATA[ y', text: 'x ', appended: '' },
  { name: 'terminated CDATA section untouched', tail: 'x <![CDATA[ y]]> z', text: 'x <![CDATA[ y]]> z', appended: '', touched: 0 },
  // Half-arrived openers: every md4c continuation is one of the four above.
  { name: 'half-arrived comment opener trimmed', tail: 'x <!', text: 'x ', appended: '' },
  { name: 'one dash short of a comment opener trimmed', tail: 'x <!-', text: 'x ', appended: '' },
  { name: 'half-arrived CDATA opener trimmed', tail: 'x <![CDA', text: 'x ', appended: '' },
  { name: 'a bare <! that opens nothing stays prose', tail: 'a <! b', text: 'a <! b', appended: '', touched: 0 },
  { name: 'a digit after <! stays prose', tail: 'a <!5 b', text: 'a <!5 b', appended: '', touched: 0 },
  { name: 'a single dash after <! stays prose', tail: 'a <!-x b', text: 'a <!-x b', appended: '', touched: 0 },

  // --- structure-flip guards ---------------------------------------------------
  { name: 'lone dash line suppressed', tail: 'para\n-', text: 'para', appended: '', touched: 1 },
  { name: 'two-dash line suppressed (setext flash)', tail: 'para\n--', text: 'para', appended: '' },
  { name: 'lone equals line suppressed', tail: 'para\n=', text: 'para', appended: '' },
  { name: 'double equals line suppressed', tail: 'para\n==', text: 'para', appended: '' },
  { name: 'empty heading marker suppressed', tail: 'para\n# ', text: 'para', appended: '' },
  { name: 'lone blockquote marker suppressed', tail: 'para\n>', text: 'para', appended: '' },
  { name: 'bare ordered-list marker suppressed', tail: 'para\n1.', text: 'para', appended: '' },
  { name: 'year at line start is not a list marker', tail: 'para\n2026.', text: 'para\n2026.', appended: '' },
  { name: 'trailing empty list item marker suppressed', tail: '- item\n- ', text: '- item', appended: '' },
  { name: 'lone hash suppressed', tail: '#', text: '', appended: '' },
  { name: 'ambiguous hr/setext dashes suppressed until line completes', tail: 'para\n---', text: 'para', appended: '' },
  { name: 'newline-terminated line is complete, not suppressed', tail: 'done\n', text: 'done\n', appended: '' },
  { name: 'bare star run line suppressed', tail: 'para\n***', text: 'para\n', appended: '' },
  { name: 'bare digits stay (not yet a marker)', tail: 'para\n12', text: 'para\n12', appended: '' },
  // md4c already reads "para\n= " as an h1.
  { name: 'setext equals line with trailing space suppressed', tail: 'para\n= ', text: 'para', appended: '' },
  { name: 'setext dashes with trailing space suppressed', tail: 'para\n-- ', text: 'para', appended: '' },
  { name: 'delimiter-run line with trailing space suppressed', tail: 'para\n*** ', text: 'para', appended: '' },
  // md4c makes the paragraph above a table once '| -' arrives.
  { name: 'bare pipe line under a header row suppressed', tail: '| a | b |\n|', text: '| a | b |', appended: '', touched: 1 },
  { name: 'pipe line with trailing space suppressed', tail: '| a | b |\n| ', text: '| a | b |', appended: '' },
  { name: 'partial delimiter row suppressed', tail: '| a | b |\n| -', text: '| a | b |', appended: '' },
  { name: 'unterminated delimiter row suppressed', tail: '| a | b |\n| --- | --- |', text: '| a | b |', appended: '' },
  { name: 'headerless delimiter row suppressed', tail: 'para\n---|', text: 'para', appended: '' },
  {
    name: 'terminated delimiter row is left to become a table',
    tail: '| a | b |\n| --- | --- |\n',
    text: '| a | b |\n| --- | --- |\n',
    appended: '',
    touched: 0,
  },
  {
    // The table above it already exists, so md4c paints the row.
    name: 'a body row of pure table punctuation is content, not a flip',
    tail: '| a | b |\n| --- | --- |\n| - | - |',
    text: '| a | b |\n| --- | --- |\n| - | - |',
    appended: '',
    touched: 0,
  },
  {
    name: 'the aligned form of the same row',
    tail: '| a | b |\n| --- | --- |\n| :- | -: |',
    text: '| a | b |\n| --- | --- |\n| :- | -: |',
    appended: '',
    touched: 0,
  },
  {
    // With nothing above it no table can form.
    name: 'a lone pipe at document start is prose, not table punctuation',
    tail: '|',
    text: '|',
    appended: '',
    touched: 0,
  },
  {
    name: 'the same with a trailing space',
    tail: '| ',
    text: '| ',
    appended: '',
    touched: 0,
  },
  {
    name: 'a lone pipe under a blank line is prose too',
    tail: 'Intro\n\n|',
    text: 'Intro\n\n|',
    appended: '',
    touched: 0,
  },
  {
    name: 'a body row is not a bare table line',
    tail: '| a | b |\n| --- | --- |\n| c | d',
    text: '| a | b |\n| --- | --- |\n| c | d',
    appended: '',
    touched: 0,
  },
  {
    name: 'pipe tail line untouched with tables off',
    tail: '| a | b |\n|',
    options: commonmark,
    text: '| a | b |\n|',
    appended: '',
    touched: 0,
  },

  // `applySpoilers` builds nothing until it sees a closing run, so without a
  // virtual closer the body renders in the clear.
  {
    name: 'unclosed spoiler closes',
    tail: 'secret is ||hunter2',
    options: withSpoilers,
    text: 'secret is ||hunter2||',
    appended: '||',
  },
  {
    // '||' on top of the pipe already here would make three, never a marker.
    name: 'partial spoiler closer completed, not tripled',
    tail: 'secret is ||hunter2|',
    options: withSpoilers,
    text: 'secret is ||hunter2||',
    appended: '|',
  },
  {
    name: 'balanced spoiler untouched',
    tail: 'a ||b|| c',
    options: withSpoilers,
    text: 'a ||b|| c',
    appended: '',
    touched: 0,
  },
  {
    name: 'a third marker opens a new pair',
    tail: 'a ||b|| c ||d',
    options: withSpoilers,
    text: 'a ||b|| c ||d||',
    appended: '||',
  },
  {
    // Closing it would fuse into '||||', a run of four that pairs nothing.
    name: 'content-empty spoiler opener suppressed',
    tail: 'answer: ||',
    options: withSpoilers,
    text: 'answer: ',
    appended: '',
    touched: 1,
  },
  {
    name: 'spoiler untouched when the extension is off',
    tail: 'secret is ||hunter2',
    text: 'secret is ||hunter2',
    appended: '',
    touched: 0,
  },
  { name: 'a single pipe is not a marker', tail: 'a | b', options: withSpoilers, text: 'a | b', appended: '', touched: 0 },
  { name: 'a run of three pipes is prose', tail: 'a |||b', options: withSpoilers, text: 'a |||b', appended: '', touched: 0 },
  {
    name: 'escaped pipes are not markers',
    tail: 'a \\|\\|b',
    options: withSpoilers,
    text: 'a \\|\\|b',
    appended: '',
    touched: 0,
  },
  {
    name: 'spoiler pipes inert inside a code span',
    tail: '`a ||b',
    options: withSpoilers,
    text: '`a ||b`',
    appended: '`',
  },
  {
    name: 'spoiler closes outside emphasis opened inside it',
    tail: 'a ||b *c',
    options: withSpoilers,
    text: 'a ||b *c*||',
    appended: '*||',
  },
  {
    // A closer here would grow the row a phantom cell.
    name: 'pipes in a table row are cell syntax, not spoiler markers',
    tail: '| a | b |\n| --- | --- |\n| c || d',
    options: withSpoilers,
    text: '| a | b |\n| --- | --- |\n| c || d',
    appended: '',
    touched: 0,
  },
  {
    name: 'suppressed bare line does not orphan earlier emphasis repair',
    tail: '**a\n-',
    text: '**a**',
    appended: '**',
  },
  {
    name: 'unclosed emphasis in an earlier paragraph is left alone',
    tail: 'text\n\n**open stays literal\n\nnew',
    text: 'text\n\n**open stays literal\n\nnew',
    appended: '',
    touched: 0,
  },

  // --- unicode ---------------------------------------------------------------
  { name: 'emoji before repair point survives', tail: 'wave \u{1F44B} **hi', text: 'wave \u{1F44B} **hi**', appended: '**' },
  { name: 'non-ascii letters close normally', tail: '**héllo', text: '**héllo**', appended: '**' },
  {
    name: 'cut between surrogate halves drops the lone high half',
    tail: 'wave \uD83D',
    text: 'wave ',
    appended: '',
    touched: 1,
  },
  {
    name: 'lone high surrogate dropped before emphasis repair',
    tail: '**hi \uD83D',
    text: '**hi**',
    appended: '**',
    touched: 3,
  },

  // --- remend-style corpus: inline code --------------------------------------
  { name: 'code span open mid-prose closes', tail: 'run `npm ins', text: 'run `npm ins`', appended: '`', touched: 1 },
  {
    name: 'double-backtick span with inner backtick stays one span',
    tail: 'a ``x `y',
    text: 'a ``x `y``',
    appended: '``',
    touched: 1,
  },
  {
    name: 'emphasis inside unclosed code span is not emphasis',
    tail: '`a ** b',
    text: '`a ** b`',
    appended: '`',
    touched: 1,
  },
  {
    name: 'emphasis inside unclosed double-backtick span inert',
    tail: '``a **b',
    text: '``a **b``',
    appended: '``',
    touched: 1,
  },

  // --- remend-style corpus: fences and strike --------------------------------
  {
    name: 'fence opener with partial info string closes',
    tail: 'intro\n```rust,no_ru',
    text: 'intro\n```rust,no_ru\n```',
    appended: '\n```',
    touched: 1,
  },
  { name: 'strike opened mid-prose closes', tail: 'note ~~wip', text: 'note ~~wip~~', appended: '~~', touched: 1 },
  { name: 'bare ~~ suppressed, never closed', tail: '~~', text: '', appended: '', touched: 1 },

  // --- remend-style corpus: math and currency --------------------------------
  {
    name: 'display math spanning a newline closes',
    tail: '$$\nE=mc^2',
    options: withMath,
    text: '$$\nE=mc^2$$',
    appended: '$$',
    touched: 1,
  },
  {
    // Single-dollar math is deliberately NOT repaired: a lone '$' is
    // indistinguishable from currency ("$5", "$ 100"), and md4c keeps an
    // unclosed "$x" literal, so leaving it alone never flashes broken math.
    name: 'single-dollar math tail left literal (currency ambiguity)',
    tail: '$x+y',
    options: withMath,
    text: '$x+y',
    appended: '',
    touched: 0,
  },
  {
    name: 'trailing bare dollar is currency, untouched',
    tail: 'total: $',
    options: withMath,
    text: 'total: $',
    appended: '',
    touched: 0,
  },

  // --- remend-style corpus: link/image cut points ----------------------------
  { name: 'link cut inside label stripped', tail: '[te', text: 'te', appended: '', touched: 1 },
  {
    // ']' as the very last char: '(' may be the next chunk's first byte, so
    // both brackets are held back rather than flashed in and possibly kept.
    name: 'link cut right after label strips both brackets',
    tail: '[text]',
    text: 'text',
    appended: '',
    touched: 2,
  },
  {
    name: 'link cut inside destination closed',
    tail: '[text](http://ex',
    text: '[text](http://ex)',
    appended: ')',
    touched: 1,
  },
  {
    // Reference-link tails only strip the lone '['; the ref-name fragment
    // stays visible as prose. Pinned: no handler understands "[label][ref".
    name: 'partial reference link strips only the open ref bracket',
    tail: '[text][r',
    text: '[text]r',
    appended: '',
    touched: 1,
  },
  { name: 'image cut inside alt dropped, prose kept', tail: 'see ![al', text: 'see ', appended: '', touched: 1 },
  {
    name: 'image cut right after alt bracket dropped',
    tail: '![alt]',
    text: '',
    appended: '',
    touched: 1,
  },
  {
    name: 'image cut at destination open paren dropped',
    tail: 'img ![alt](',
    text: 'img ',
    appended: '',
    touched: 1,
  },

  // --- remend-style corpus: autolinks ----------------------------------------
  { name: 'partial autolink trimmed', tail: '<http://ex', text: '', appended: '', touched: 1 },
  {
    name: 'partial autolink after prose trimmed',
    tail: 'visit <https://ex',
    text: 'visit ',
    appended: '',
    touched: 1,
  },
  {
    // A 1-character scheme can never become an autolink (the spec requires
    // 2-32), and ':' is invalid in a tag name, so '<b:cdef' is guaranteed
    // literal — trimming it would withhold prose for an unbounded number of
    // chunks.
    name: 'one-char scheme is not a partial autolink',
    tail: 'x <b:cdef',
    text: 'x <b:cdef',
    appended: '',
  },

  // --- remend-style corpus: line endings at the cut --------------------------
  {
    // The blank line ends the paragraph, so the '**' opened before it can
    // never bind across it — appending a closer would render literal
    // asterisks after 'c'. The LF spelling has always been left untouched;
    // this pins the CRLF spelling to the same answer (the region splitter is
    // line-ending agnostic).
    name: 'CRLF blank line starts a fresh inline region',
    tail: 'a **b\r\n\r\nc',
    text: 'a **b\r\n\r\nc',
    appended: '',
  },
  {
    name: 'CRLF before a bare structural line still suppresses it',
    tail: 'para\r\n--',
    text: 'para\r',
    appended: '',
    touched: 1,
  },
  {
    name: 'bare-CR line ending guards the structure flip too',
    tail: 'para\r-',
    text: 'para',
    appended: '',
    touched: 1,
  },
  {
    // A CRLF split exactly at the cut: the '\r' is whitespace, so a closer
    // appended after it would not bind; it is trimmed like a space.
    name: 'split CRLF trimmed before an emphasis closer',
    tail: '**x\r',
    text: '**x**',
    appended: '**',
    touched: 2,
  },

  // --- remend-style corpus: list and nested emphasis tails -------------------
  {
    name: 'list item ending in unclosed strong closes',
    tail: '- item **bo',
    text: '- item **bo**',
    appended: '**',
    touched: 1,
  },
  { name: 'triple-star tail closes as one run', tail: '***a', text: '***a***', appended: '***', touched: 1 },
  {
    name: 'strong then nested emphasis closes innermost-first',
    tail: '**a *b',
    text: '**a *b***',
    appended: '***',
    touched: 2,
  },

  // An opener on an earlier line cannot be closed once another block starts.
  {
    name: 'emphasis opener in an earlier list item is not closed in the next',
    tail: '- item one *emph\n- item two',
    text: '- item one *emph\n- item two',
    appended: '',
    touched: 0,
  },
  {
    // Item 1's '_' stays literal rather than eating the '_' of '_rev'.
    name: 'list item closes only its own opener',
    tail: '- The _id field is required\n- The _rev field too',
    text: '- The _id field is required\n- The _rev field too_',
    appended: '_',
  },
  {
    name: 'heading opener is not closed in the paragraph after it',
    tail: '# Heading *emph\nplain paragraph line',
    text: '# Heading *emph\nplain paragraph line',
    appended: '',
    touched: 0,
  },
  {
    name: 'ATX heading closes its own opener',
    tail: '## Heading *emph',
    text: '## Heading *emph*',
    appended: '*',
  },
  {
    // Consecutive '>' lines are one paragraph inside the quote.
    name: 'emphasis binds across soft line breaks inside a blockquote',
    tail: '> quoted *emph\n> continues here',
    text: '> quoted *emph\n> continues here*',
    appended: '*',
  },
  {
    name: 'a blockquote after prose starts a fresh inline region',
    tail: 'prose *open\n> quoted line',
    text: 'prose *open\n> quoted line',
    appended: '',
    touched: 0,
  },
  {
    name: 'table rows do not share an inline region',
    tail: '| a | *b |\n| c | d |',
    text: '| a | *b |\n| c | d |',
    appended: '',
    touched: 0,
  },
  {
    name: 'thematic break ends the paragraph before it',
    tail: 'prose *open\n---\nafter the break',
    text: 'prose *open\n---\nafter the break',
    appended: '',
    touched: 0,
  },

  {
    name: 'fence on a list-marker line closes at the item content column',
    tail: '- ```js\nconst a = 1',
    text: '- ```js\nconst a = 1\n  ```',
    appended: '\n  ```',
    touched: 1,
  },
  {
    name: 'ordered list-item fence closes at its own column',
    tail: '1. ```py\nx = 1',
    text: '1. ```py\nx = 1\n   ```',
    appended: '\n   ```',
    touched: 1,
  },
  {
    name: 'closed list-item fence re-enables inline repairs after it',
    tail: '- ```js\n  code\n  ```\n\ndone **x',
    text: '- ```js\n  code\n  ```\n\ndone **x**',
    appended: '**',
  },
  {
    name: 'a list-marker fence line inside a fence is content',
    tail: '```md\n- ```\nstill code',
    text: '```md\n- ```\nstill code\n```',
    appended: '\n```',
    touched: 1,
  },

  // --- hide options: URI-like labels (app-mask doc-comment corpus) -----------
  // Non-URI labels keep the default treatment in each of the three
  // unfinished-link states: strip, hold, virtual close.
  { name: 'hide: prose open label still strips', tail: 'see [Vitamin D', repair: hideAll, text: 'see Vitamin D', appended: '', touched: 1 },
  { name: 'hide: prose label closed at EOT still held', tail: 'see [Vitamin D]', repair: hideAll, text: 'see Vitamin D', appended: '', touched: 2 },
  { name: 'hide: prose label with empty destination still closes', tail: 'see [Vitamin D](', repair: hideAll, text: 'see [Vitamin D]()', appended: ')' },
  {
    name: 'hide: prose label with growing destination still closes',
    tail: 'see [Vitamin D](fhir://Observ',
    repair: hideAll,
    text: 'see [Vitamin D](fhir://Observ)',
    appended: ')',
  },
  // URI-like labels hide the whole construct, '[' to EOT.
  {
    name: 'hide: URI label with open destination hidden entirely',
    tail: 'see [fhir://Observation/abc](fhir://Ob',
    repair: hideLabels,
    text: 'see ',
    appended: '',
    touched: 1,
  },
  {
    name: 'hide: URI label closed at EOT hidden entirely',
    tail: 'see [fhir://Observation/abc]',
    repair: hideLabels,
    text: 'see ',
    appended: '',
    touched: 1,
  },
  {
    name: 'hide: URI open label hidden entirely',
    tail: 'see [fhir://Observation',
    repair: hideLabels,
    text: 'see ',
    appended: '',
    touched: 1,
  },
  {
    name: 'hide: URI label untouched with hideUriLikeLabels off',
    tail: 'see [fhir://Obs](fhir://Ob',
    repair: hideMessage,
    text: 'see [fhir://Obs](fhir://Ob)',
    appended: ')',
  },
  {
    name: 'hide: emphasis before hidden link still closes',
    tail: '**see [fhir://Obs](fhir://O',
    repair: hideLabels,
    text: '**see**',
    appended: '**',
    touched: 3,
  },
  { name: 'hide: URI label after closed code span hidden', tail: '`code` [fhir://Obs', repair: hideLabels, text: '`code` ', appended: '' },
  {
    name: 'hide: bracket inside closed code span inert',
    tail: '`[fhir://Obs] x`',
    repair: hideAll,
    text: '`[fhir://Obs] x`',
    appended: '',
    touched: 0,
  },
  {
    name: 'hide: bracket inside open code span inert',
    tail: '`see [fhir://Obs',
    repair: hideLabels,
    text: '`see [fhir://Obs`',
    appended: '`',
  },
  { name: 'hide: escaped bracket never a link', tail: 'see \\[fhir://Obs', repair: hideAll, text: 'see \\[fhir://Obs', appended: '', touched: 0 },
  { name: 'hide: task box unaffected', tail: '- [x]', repair: hideAll, text: '', appended: '' },
  {
    name: 'hide: URI label after CRLF line break hidden',
    tail: 'line one\r\nsee [fhir://Obs](fhir://O',
    repair: hideLabels,
    text: 'line one\r\nsee ',
    appended: '',
    touched: 1,
  },
  {
    name: 'hide: incomplete image with URI label already dropped',
    tail: 'see ![fhir://Obs](fhir://O',
    repair: hideAll,
    text: 'see ',
    appended: '',
    touched: 1,
  },
  // An emphasis opener ADJACENT to the hidden construct is left
  // content-empty by the cut: it must be suppressed with it (no virtual
  // closer), or every streaming snapshot while the construct grows paints a
  // stray literal '*'/'**' at the end of the visible text.
  {
    name: 'hide: emphasis opener adjacent to hidden open label suppressed',
    tail: 'text *[fhir://Observation/x',
    repair: hideLabels,
    text: 'text ',
    appended: '',
  },
  {
    name: 'hide: strong opener adjacent to hidden link suppressed',
    tail: 'note **[fhir://Obs](fhir://Ob',
    repair: hideLabels,
    text: 'note ',
    appended: '',
  },
  {
    name: 'hide: stacked openers emptied by the same hide all suppress',
    tail: 'a *_[fhir://Obs',
    repair: hideLabels,
    text: 'a ',
    appended: '',
  },

  // --- hide options: bare URI tails of listed schemes ------------------------
  { name: 'hide: bare message tail blanked', tail: 'message://5f3a-', repair: hideMessage, text: '', appended: '', touched: 1 },
  { name: 'hide: paren before bare message stays', tail: '(message://5f3a-', repair: hideMessage, text: '(', appended: '', touched: 1 },
  { name: 'hide: bare message tail after prose blanked', tail: 'see message://5f3a', repair: hideMessage, text: 'see ', appended: '', touched: 1 },
  { name: 'hide: scheme matches case-insensitively', tail: 'see MESSAGE://5F', repair: hideMessage, text: 'see ', appended: '' },
  { name: 'hide: minimum arrival is scheme:/', tail: 'see message:/', repair: hideMessage, text: 'see ', appended: '', touched: 1 },
  {
    // Anchored past `scheme:/` so a sentence ending in the bare word
    // "message:" never blanks for a chunk.
    name: 'hide: prose ending in the word message: stays',
    tail: 'see the message:',
    repair: hideMessage,
    text: 'see the message:',
    appended: '',
    touched: 0,
  },
  { name: 'hide: unlisted scheme tail stays', tail: 'see fhir://Obs/5f', repair: hideMessage, text: 'see fhir://Obs/5f', appended: '', touched: 0 },
  {
    name: 'hide: https tail stays when only message listed',
    tail: 'see https://example.com/pa',
    repair: hideMessage,
    text: 'see https://example.com/pa',
    appended: '',
    touched: 0,
  },
  { name: 'hide: word-embedded scheme stays', tail: 'see mymessage://x', repair: hideMessage, text: 'see mymessage://x', appended: '', touched: 0 },
  { name: 'hide: bare tail after CRLF line break blanked', tail: 'a\r\nmessage://5f', repair: hideMessage, text: 'a\r\n', appended: '', touched: 1 },
  { name: 'hide: emphasis before bare tail still closes', tail: '**see message://5f', repair: hideMessage, text: '**see**', appended: '**', touched: 3 },
  {
    name: 'hide: emphasis opener adjacent to hidden bare URI suppressed',
    tail: 'goto *message://abc',
    repair: hideMessage,
    text: 'goto ',
    appended: '',
  },
  {
    name: 'hide: bare token inside closed code span stays',
    tail: '`message://x`',
    repair: hideMessage,
    text: '`message://x`',
    appended: '',
    touched: 0,
  },
  {
    name: 'hide: bare token inside open code span stays, span closes',
    tail: '`message://x',
    repair: hideMessage,
    text: '`message://x`',
    appended: '`',
    touched: 1,
  },
  { name: 'hide: bare token after closed code span blanked', tail: '`x` message://5f', repair: hideMessage, text: '`x` ', appended: '', touched: 1 },
  {
    // The destination belongs to the link repair (virtual close keeps the
    // label painting); the bare-URI hide must not blank inside it.
    name: 'hide: listed scheme inside open link destination left to link repair',
    tail: '[a](message://5f',
    repair: hideMessage,
    text: '[a](message://5f)',
    appended: ')',
  },
  {
    name: 'hide: label and bare hides compose',
    tail: 'see [message://5f3a](message://5f',
    repair: hideAll,
    text: 'see ',
    appended: '',
    touched: 1,
  },

  // Every virtual closer lands in a row's last cell, so an opener in an
  // earlier cell gets none.
  {
    name: 'an opener in an earlier cell of a table row gets no closer',
    tail: '| a | b |\n| --- | --- |\n| *x | y',
    text: '| a | b |\n| --- | --- |\n| *x | y',
    appended: '',
    touched: 0,
  },
  {
    name: 'an opener in the last cell still closes',
    tail: '| a | b |\n| --- | --- |\n| c | *d',
    text: '| a | b |\n| --- | --- |\n| c | *d*',
    appended: '*',
  },
  {
    name: 'only the last cell of a row keeps its opener',
    tail: '| a | b |\n| --- | --- |\n| a _b | c _d',
    text: '| a | b |\n| --- | --- |\n| a _b | c _d_',
    appended: '_',
    touched: 1,
  },
  {
    name: 'a pipe line with no delimiter row under it is still a paragraph',
    tail: '| a _b | c _d |',
    text: '| a _b | c _d |__',
    appended: '__',
  },

  {
    name: 'an HTML block start ends the paragraph above it',
    tail: 'para *emph\n<div>',
    text: 'para *emph\n<div>',
    appended: '',
    touched: 0,
  },
  {
    name: 'a raw-text HTML block start ends it too',
    tail: 'para *emph\n<script>',
    text: 'para *emph\n<script>',
    appended: '',
    touched: 0,
  },
  {
    // Not on CommonMark's block-tag list, so it is inline HTML.
    name: 'an unknown tag is inline, not a block boundary',
    tail: 'para *emph\n<notatag>',
    text: 'para *emph\n<notatag>*',
    appended: '*',
  },

  {
    name: 'a spoiler opening its line closes',
    tail: '||hunter2',
    options: withSpoilers,
    text: '||hunter2||',
    appended: '||',
  },
  {
    name: 'a spoiler opening a list item closes',
    tail: '- ||hunter2',
    options: withSpoilers,
    text: '- ||hunter2||',
    appended: '||',
  },
  {
    name: 'a spoiler under an indent closes',
    tail: '  ||secret',
    options: withSpoilers,
    text: '  ||secret||',
    appended: '||',
  },
  {
    name: 'a spoiler opening the second line closes',
    tail: 'ok\n||secret',
    options: withSpoilers,
    text: 'ok\n||secret||',
    appended: '||',
  },
  {
    name: 'a third marker on a line that opens with one closes',
    tail: '||a|| and ||b',
    options: withSpoilers,
    text: '||a|| and ||b||',
    appended: '||',
  },
  {
    name: 'pipes in a CRLF table row are still cell syntax',
    tail: '| a | b |\r\n| --- | --- |\r\n| c || d',
    options: withSpoilers,
    text: '| a | b |\r\n| --- | --- |\r\n| c || d',
    appended: '',
    touched: 0,
  },
  {
    // `applySpoilers` gives up on a text node holding an escaped pipe.
    name: 'an escaped pipe in the region suppresses the close',
    tail: 'a \\||b ||c',
    options: withSpoilers,
    text: 'a \\||b ||c',
    appended: '',
    touched: 0,
  },
  {
    // md4c reads '<x||y>' as text, not a tag, so its pipes pair.
    name: 'pipes inside a region that is not a tag are still markers',
    tail: 'a <x||y> then ||z',
    options: withSpoilers,
    text: 'a <x||y> then ||z',
    appended: '',
    touched: 0,
  },
  {
    name: 'a real tag is still opaque',
    tail: 'a <b class="x">bold ||s',
    options: withSpoilers,
    text: 'a <b class="x">bold ||s||',
    appended: '||',
  },
  {
    name: 'an autolink is still opaque',
    tail: 'a <http://ex.com> then ||z',
    options: withSpoilers,
    text: 'a <http://ex.com> then ||z||',
    appended: '||',
  },
  {
    name: 'emphasis binds across a "<" that opens no tag',
    tail: 'a < b > c *emph',
    text: 'a < b > c *emph*',
    appended: '*',
  },
  {
    // …but only within the closer's text node: a code span is a separate
    // node, which `applySpoilers` judges on its own.
    name: 'an escaped pipe inside a code span does not suppress the close',
    tail: 'a `x \\| y` and ||secret',
    options: withSpoilers,
    text: 'a `x \\| y` and ||secret||',
    appended: '||',
  },
  {
    name: 'an escaped pipe after the opener still suppresses the close',
    tail: 'a `x` and ||sec \\| ret',
    options: withSpoilers,
    text: 'a `x` and ||sec \\| ret',
    appended: '',
    touched: 0,
  },
  {
    name: 'an empty cell in a header row still arriving is not a spoiler',
    tail: '| a || c |',
    options: withSpoilers,
    text: '| a || c |',
    appended: '',
    touched: 0,
  },
  {
    name: 'the same header row after prose',
    tail: 'Intro\n\n| a || c |',
    options: withSpoilers,
    text: 'Intro\n\n| a || c |',
    appended: '',
    touched: 0,
  },
  {
    name: 'a spoiler opening a line is not a header row',
    tail: '||secret',
    options: withSpoilers,
    text: '||secret||',
    appended: '||',
  },
  {
    name: 'a long run of pipe-bearing prose lines is still not a table',
    tail: `${'x | y\n'.repeat(70)}||secret`,
    options: withSpoilers,
    text: `${'x | y\n'.repeat(70)}||secret||`,
    appended: '||',
  },
  {
    // Handler 7 runs after the pairing, so suppressing this line would drop
    // a completed spoiler's closer.
    name: 'a spoiler closer alone on its line is not table punctuation',
    tail: 'hint: ||one\n||',
    options: withSpoilers,
    text: 'hint: ||one\n||',
    appended: '',
    touched: 0,
  },
  {
    name: 'the bare pipe under a header row is still suppressed with spoilers on',
    tail: '| a | b |\n|',
    options: withSpoilers,
    text: '| a | b |',
    appended: '',
    touched: 1,
  },

  {
    // The terminator overlaps the opener in '<!-->' and '<!--->'.
    name: 'an empty comment terminates',
    tail: 'note <!--> x more text here',
    text: 'note <!--> x more text here',
    appended: '',
    touched: 0,
  },
  {
    name: 'the three-dash empty comment terminates too',
    tail: 'note <!---> x more',
    text: 'note <!---> x more',
    appended: '',
    touched: 0,
  },
  {
    name: 'a declaration running into prose is withheld to the end of its line',
    tail: 'use <!important rules here',
    text: 'use ',
    appended: '',
    touched: 1,
  },
  {
    name: 'a declaration whose line ended without a ">" paints as prose',
    tail: 'use <!important rules here\nand more prose',
    text: 'use <!important rules here\nand more prose',
    appended: '',
    touched: 0,
  },
  {
    name: 'a multi-word processing instruction never paints before its "?>"',
    tail: 'note <?php echo the thing',
    text: 'note ',
    appended: '',
    touched: 1,
  },
  {
    name: 'the same PI, terminated, paints its surroundings',
    tail: 'note <?php echo the thing?> end',
    text: 'note <?php echo the thing?> end',
    appended: '',
    touched: 0,
  },
  {
    name: 'a multi-word declaration never paints before its ">"',
    tail: 'note <!ENTITY nbsp "&#160;"',
    text: 'note ',
    appended: '',
    touched: 1,
  },
  {
    name: 'a processing instruction whose line ended paints as prose',
    tail: 'note <?php echo the thing\nnext line',
    text: 'note <?php echo the thing\nnext line',
    appended: '',
    touched: 0,
  },
  {
    name: 'a real declaration is still withheld while it arrives',
    tail: 'note <!DOCTYPE htm',
    text: 'note ',
    appended: '',
    touched: 1,
  },

  {
    name: 'a backslash before the line ending does not escape it',
    tail: 'a [x](/u\\\nmore prose here',
    text: 'a [x](/u\\\nmore prose here',
    appended: '',
    touched: 0,
  },
  {
    name: 'the same with CRLF',
    tail: 'a [x](/u\\\r\nmore prose here',
    text: 'a [x](/u\\\r\nmore prose here',
    appended: '',
    touched: 0,
  },
  {
    // CommonMark needs whitespace before a title quote, so the line-break
    // stop still applies.
    name: "an apostrophe in the destination does not open a title",
    tail: "See [the post](https://ex.com/don't-panic\nand more prose here",
    text: "See [the post](https://ex.com/don't-panic\nand more prose here",
    appended: '',
    touched: 0,
  },
  {
    name: 'a double quote glued to the destination does not open a title',
    tail: 'a [x](/u"ti\nmore prose here',
    text: 'a [x](/u"ti\nmore prose here',
    appended: '',
    touched: 0,
  },
  {
    name: 'nor does one inside a parenthesised destination',
    tail: 'a [x](/u(v"z\nmore prose here',
    text: 'a [x](/u(v"z\nmore prose here',
    appended: '',
    touched: 0,
  },
  {
    name: 'a REAL title opener still consumes the break inside it',
    tail: 'a [x](/u "ti\ntle',
    text: 'a [x](/u "ti\ntle")',
    appended: '")',
  },
  {
    name: 'an apostrophe in a destination still closes on one line',
    tail: "a [x](/don't-panic",
    text: "a [x](/don't-panic)",
    appended: ')',
  },
];

describe('RepairResult', () => {
  test('a wrapper can build one without a carry', () => {
    // Compile-time assertion: `scan` stays optional for wrappers and stubs.
    const wrapped: RepairResult = { text: 'a *b', appended: '*', touched: [] };
    // …and `repairTail` itself always fills it in, for the tail it saw.
    expect(repairTail(wrapped.text, SEED, base).scan).toMatchObject({
      tailLength: 4,
      regionStart: 0,
    });
  });
});

describe('repairTail corpus', () => {
  test.each(cases)('$name', (c) => {
    const result = repairTail(c.tail, c.seed ?? SEED, c.options ?? base, c.repair);
    expect(result.text).toBe(c.text);
    if (c.appended !== undefined) {
      expect(result.appended).toBe(c.appended);
    }
    if (c.touched !== undefined) {
      expect(result.touched).toHaveLength(c.touched);
    }
    expect(result.text.endsWith(result.appended)).toBe(true);
  });

  test('a task box arriving char by char never flashes as item text', () => {
    for (const tail of ['- [', '- [x', '- [X', '- [ ]', '- [x]', '- [x] ', '1. [x', '* [ ]']) {
      expect(repairTail(tail, SEED, base).text).toBe('');
    }
    expect(repairTail('- a\n- [x', SEED, base).text).toBe('- a');
    expect(repairTail('- [x] do', SEED, base).text).toBe('- [x] do');
    // A link label is not a task box.
    expect(repairTail('- [ab', SEED, base).text).toBe('- ab');
  });

  test('a long quote-marker line is scanned in linear time', () => {
    const started = Date.now();
    repairTail('> '.repeat(5000) + 'x', SEED, base);
    repairTail('> '.repeat(5000) + '- [x', SEED, base);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('setext/hr underline arriving char by char never flashes', () => {
    // "---" under a paragraph is ambiguous until its line terminates: hr,
    // setext flip, or prose. Every dash-count is suppressed; the moment the
    // line stops being bare (or terminates) the suppression must lift.
    for (const tail of ['para\n-', 'para\n--', 'para\n---', 'para\n----']) {
      expect(repairTail(tail, SEED, base).text).toBe('para');
    }
    for (const tail of ['para\n=', 'para\n==', 'para\n===']) {
      expect(repairTail(tail, SEED, base).text).toBe('para');
    }
    expect(repairTail('para\n--- x', SEED, base).text).toBe('para\n--- x');
    expect(repairTail('para\n---\n', SEED, base).text).toBe('para\n---\n');
  });

  test('a single-line PI or declaration never paints before it terminates', () => {
    for (const src of [
      'note <?php echo the thing?> end',
      'note <!ENTITY nbsp "&#160;"> end',
    ]) {
      const open = src.indexOf('<');
      const closed = src.indexOf('>', open) + 1;
      for (let i = open + 2; i < closed; i += 1) {
        expect(repairTail(src.slice(0, i), SEED, base).text).toBe(
          src.slice(0, open),
        );
      }
      expect(repairTail(src.slice(0, closed), SEED, base).text).toBe(
        src.slice(0, closed),
      );
    }
  });

  test('a stray opener blanks at most its own line', () => {
    expect(repairTail('use <!important rules', SEED, base).text).toBe('use ');
    expect(repairTail('use <!important rules\n', SEED, base).text).toBe(
      'use <!important rules\n',
    );
    expect(repairTail('use <!important rules\r\nmore', SEED, base).text).toBe(
      'use <!important rules\r\nmore',
    );
  });

  test('a spoiler arriving char by char is closed at every prefix', () => {
    // An unpaired '||' builds no spoiler node, so the body would paint.
    const src = 'the password is ||hunter2|| ok';
    const open = src.indexOf('||');
    const close = src.indexOf('||', open + 2);
    for (let i = 1; i <= src.length; i += 1) {
      const prefix = src.slice(0, i);
      const { text } = repairTail(prefix, SEED, withSpoilers);
      // Between the opener and the real closer the input holds one balanced
      // pair.
      const pairs = (text.match(/(?<!\|)\|\|(?!\|)/g) ?? []).length;
      if (i > open + 2 && i <= close + 2) {
        expect(pairs).toBe(2);
      }
      expect(pairs % 2).toBe(0);
    }
  });

  test('a spoiler opened before a soft line break still closes', () => {
    // The markers of one pair may sit in different text nodes of a paragraph.
    const r = repairTail('hint: ||one\nstill hidden', SEED, withSpoilers);
    expect(r.text).toBe('hint: ||one\nstill hidden||');
    expect(r.appended).toBe('||');
    // A blank line ends the paragraph, and `applySpoilers` never pairs
    // across containers: appending there would paint literal pipes.
    const across = repairTail('hint: ||one\n\nnew para', SEED, withSpoilers);
    expect(across.text).toBe('hint: ||one\n\nnew para');
    expect(across.touched).toHaveLength(0);
  });
});

describe('repairTail hide options', () => {
  test('absent, empty, and all-off options are identical to the default', () => {
    const off: RepairOptions = {
      hideUriLikeLabels: false,
      hideBareUriSchemes: [],
    };
    for (const c of cases) {
      if (c.repair !== undefined) {
        continue;
      }
      for (const r of [{}, off]) {
        const result = repairTail(c.tail, c.seed ?? SEED, c.options ?? base, r);
        expect(result.text).toBe(c.text);
        if (c.appended !== undefined) {
          expect(result.appended).toBe(c.appended);
        }
        if (c.touched !== undefined) {
          expect(result.touched).toHaveLength(c.touched);
        }
      }
    }
  });

  test('hide options leave every non-matching corpus case untouched', () => {
    // No default-corpus tail contains a URI-like label or a listed-scheme
    // bare tail, so full hide options must reproduce each result exactly.
    for (const c of cases) {
      if (c.repair !== undefined) {
        continue;
      }
      const result = repairTail(c.tail, c.seed ?? SEED, c.options ?? base, hideAll);
      expect(result.text).toBe(c.text);
      if (c.appended !== undefined) {
        expect(result.appended).toBe(c.appended);
      }
      if (c.touched !== undefined) {
        expect(result.touched).toHaveLength(c.touched);
      }
    }
  });

  test('hide paths are pure (regex cache is invisible)', () => {
    for (const tail of ['see [fhir://Obs](fhir://O', 'see message://5f']) {
      expect(repairTail(tail, SEED, base, hideAll).text).toBe('see ');
      expect(repairTail(tail, SEED, base, hideAll).text).toBe('see ');
    }
    // Alternating scheme lists across calls must not leak between them.
    const copyOnly: RepairOptions = { hideBareUriSchemes: ['copy'] };
    expect(repairTail('go copy://1', SEED, base, copyOnly).text).toBe('go ');
    expect(repairTail('go copy://1', SEED, base, hideMessage).text).toBe('go copy://1');
    expect(repairTail('go copy://1', SEED, base, copyOnly).text).toBe('go ');
  });

  test('a hide cut is a touched text edit, never an append', () => {
    // The session's clean-repair fast path gates on touched/appended; a
    // hide must disable it, and `appended` must stay a pure suffix.
    const r = repairTail('see [fhir://Obs](fhir://O', SEED, base, hideLabels);
    expect(r.text).toBe('see ');
    expect(r.appended).toBe('');
    expect(r.touched).toEqual([{ start: 4, end: 25 }]);
    const b = repairTail('see message://5f', SEED, base, hideMessage);
    expect(b.text).toBe('see ');
    expect(b.appended).toBe('');
    expect(b.touched).toEqual([{ start: 4, end: 16 }]);
  });

  test('every unfinished-link state hides a growing URI label', () => {
    // The label grows char by char through all three states; no snapshot
    // may paint any of it.
    const states = [
      'see [fhir:',
      'see [fhir://Obs',
      'see [fhir://Obs]',
      'see [fhir://Obs](',
      'see [fhir://Obs](fhir://Ob',
    ];
    for (const tail of states) {
      expect(repairTail(tail, SEED, base, hideLabels).text).toBe('see ');
    }
  });

  test('a prose label holding a colon keeps the default treatment', () => {
    // Only the unmatched '[' is stripped.
    for (const [tail, text] of [
      ['note [Bug:123', 'note Bug:123'],
      ['ratio [a:b', 'ratio a:b'],
      ['see [C:\\Users\\me', 'see C:\\Users\\me'],
    ]) {
      expect(repairTail(tail, SEED, base, hideLabels).text).toBe(text);
      expect(repairTail(tail, SEED, base).text).toBe(text);
    }
  });

  test('bare URI arriving char by char never flashes past scheme:/', () => {
    for (const tail of ['see message:/', 'see message://', 'see message://5f3a-']) {
      expect(repairTail(tail, SEED, base, hideMessage).text).toBe('see ');
    }
    // Before the '/' commits it, the token is still prose.
    for (const tail of ['see message', 'see message:']) {
      expect(repairTail(tail, SEED, base, hideMessage).text).toBe(tail);
    }
  });
});

describe('isUriLikeLabel', () => {
  test('matches scheme-prefixed whitespace-free labels, trimmed', () => {
    for (const label of ['fhir:', 'fhir:/', 'fhir://Obs', 'https://x', ' fhir://Obs ', 'MESSAGE://5F']) {
      expect(isUriLikeLabel(label)).toBe(true);
    }
  });

  test('rejects prose, task boxes, and space-broken URIs', () => {
    for (const label of ['Vitamin D', 'x', ' ', '', 'fhir://a b', '1abc:x', '**fhir://x']) {
      expect(isUriLikeLabel(label)).toBe(false);
    }
  });

  test('rejects prose labels that merely hold a colon', () => {
    for (const label of ['Bug:123', 'a:b', 'C:\\Users\\me', 'TODO:fixthis', 'mailto:me@example.com']) {
      expect(isUriLikeLabel(label)).toBe(false);
    }
  });
});

describe('repairTail bracket strips', () => {
  // The cost is benchmarked in bench/pathological.mjs.
  test('thousands of unmatched brackets all strip, in order', () => {
    const n = 2000;
    const tail = 'x [ '.repeat(n);
    const r = repairTail(tail, SEED, base);
    expect(r.text).toBe('x  '.repeat(n));
    expect(r.appended).toBe('');
    expect(r.touched).toHaveLength(n);
    for (let i = 0; i < n; i += 1) {
      expect(r.touched[i]).toEqual({ start: i * 4 + 2, end: i * 4 + 3 });
    }
  });

  test('a strip between an opener and the tail still shifts correctly', () => {
    // '[' strips shift every later offset, so the content-empty check on the
    // '*' has to compare through the same shift.
    expect(repairTail('a [b [c *d', SEED, base).text).toBe('a b c *d*');
    expect(repairTail('end *[', SEED, base).text).toBe('end ');
  });
});

describe('repairTail purity', () => {
  test('same input produces the same output, twice', () => {
    const seed: RepairSeed = { openFence: null, inMath: false };
    for (let i = 0; i < 2; i += 1) {
      const r = repairTail('**bold [link](https://exa', seed, base);
      expect(r.text).toBe('**bold [link](https://exa)**');
      expect(r.appended).toBe(')**');
      expect(r.touched).toEqual([
        { start: 7, end: 25 },
        { start: 0, end: 25 },
      ]);
    }
  });

  test('does not mutate the seed', () => {
    const seed: RepairSeed = { openFence: { marker: '`', length: 3 }, inMath: false };
    expect(repairTail('code **x', seed, base).text).toBe('code **x\n```');
    expect(seed).toEqual({ openFence: { marker: '`', length: 3 }, inMath: false });
  });

  test('untouched tails report no repairs', () => {
    const result = repairTail('plain prose sentence.', SEED, base);
    expect(result.text).toBe('plain prose sentence.');
    expect(result.appended).toBe('');
    expect(result.touched).toHaveLength(0);
  });

  test('cut-position handlers are pure too', () => {
    for (const [tail, text] of [
      ['a [b]', 'a b'],
      ['x ![y]', 'x '],
      ['go <https://e', 'go '],
      ['hi \uD83D', 'hi '],
    ]) {
      expect(repairTail(tail, SEED, base).text).toBe(text);
      expect(repairTail(tail, SEED, base).text).toBe(text);
    }
  });
});

/**
 * Every state this reports open holds the streaming anchor, so a false one
 * costs a full reparse on every later append.
 */
describe('continueSeed', () => {
  test('a fence opened on a list-marker line is closed by its indented run', () => {
    // Without the marker strip the indented closer reads as an opener.
    expect(continueSeed(SEED, '- ```js\n  code\n  ```\n\n')).toEqual(SEED);
    expect(continueSeed(SEED, '1. ```py\n   code\n   ```\n\n')).toEqual(SEED);
    expect(continueSeed(SEED, '- - ```sh\n    code\n    ```\n\n')).toEqual(SEED);
    expect(continueSeed(SEED, '- ```js\n  code\n').openFence).toEqual({
      marker: '`',
      length: 3,
      indent: 2,
    });
  });

  test('an unclosed list-item fence still seeds, with its column', () => {
    expect(continueSeed(SEED, '- ```js\n  code\n')).toEqual({
      openFence: { marker: '`', length: 3, indent: 2 },
      inMath: false,
    });
  });

  test('a fence indent survives the seed boundary', () => {
    const half = continueSeed(SEED, '- ```js\n  code\n');
    expect(continueSeed(half, '  ```\n\n')).toEqual(SEED);
  });

  test('a quoted fence stays invisible to the scan, symmetrically', () => {
    expect(continueSeed(SEED, '> ```js\n> code\n> ```\n\n')).toEqual(SEED);
    expect(continueSeed(SEED, '> ```js\n> code\n')).toEqual(SEED);
    expect(continueSeed(SEED, '```js\ncode\n')).toEqual({
      openFence: { marker: '`', length: 3, indent: 0 },
      inMath: false,
    });
  });

  test('$$ in prose does not survive a blank line', () => {
    // md4c's math spans are inline, so the carry clears at a blank line.
    expect(continueSeed(SEED, 'costs $$5\n')).toEqual({ openFence: null, inMath: true });
    expect(continueSeed(SEED, 'costs $$5\n\n')).toEqual(SEED);
    expect(continueSeed(SEED, 'It costs $$5 today\n\nnext paragraph\n\n')).toEqual(SEED);
  });

  test('open display math still carries across lines of one block', () => {
    expect(continueSeed(SEED, '$$\nE = mc^2\n')).toEqual({
      openFence: null,
      inMath: true,
    });
    expect(continueSeed(SEED, '$$\nE = mc^2\n$$\n')).toEqual(SEED);
  });

  test('is incremental: splitting the text does not change the state', () => {
    const parts = ['- ```js\n', '  code\n', '  ```\n\n', 'costs $$5\n\n', '$$\nx\n'];
    let state = SEED;
    for (const part of parts) {
      state = continueSeed(state, part);
    }
    expect(state).toEqual({ openFence: null, inMath: true });
    expect(continueSeed(SEED, parts.join(''))).toEqual(state);
  });
});

describe('seedFromSettled', () => {
  test('detects an open backtick fence', () => {
    expect(seedFromSettled('```js\ncode\n')).toEqual({
      openFence: { marker: '`', length: 3, indent: 0 },
      inMath: false,
    });
  });

  test('detects an open tilde fence with run length', () => {
    expect(seedFromSettled('~~~~\ncode\n')).toEqual({
      openFence: { marker: '~', length: 4, indent: 0 },
      inMath: false,
    });
  });

  test('closed fence leaves no seed', () => {
    expect(seedFromSettled('```\nc\n```\n')).toEqual({ openFence: null, inMath: false });
    expect(seedFromSettled('```\nc\n').openFence).toEqual({ marker: '`', length: 3, indent: 0 });
  });

  test('plain paragraphs leave no seed', () => {
    expect(seedFromSettled('a\n\nb\n')).toEqual({ openFence: null, inMath: false });
    expect(seedFromSettled('a\n\nb\n\n~~~\n').openFence).toEqual({ marker: '~', length: 3, indent: 0 });
  });

  test('unbalanced display math sets inMath', () => {
    expect(seedFromSettled('$$\nx\n')).toEqual({ openFence: null, inMath: true });
  });

  test('balanced display math clears inMath', () => {
    expect(seedFromSettled('$$\nx\n$$\n')).toEqual({ openFence: null, inMath: false });
    expect(seedFromSettled('$$\nx\n$$\n$$\n').inMath).toBe(true);
  });

  test('inline code and single dollars do not seed math', () => {
    expect(seedFromSettled('closed `code` and $5\n')).toEqual({
      openFence: null,
      inMath: false,
    });
    expect(seedFromSettled('closed `code` and $$5\n').inMath).toBe(true);
  });

  test('empty settled prefix', () => {
    expect(seedFromSettled('')).toEqual({ openFence: null, inMath: false });
    expect(seedFromSettled('$$\n').inMath).toBe(true);
  });
});

// The carried inline scan must change nothing: every case streams a tail one
// delta at a time and demands the carried run match a cold call exactly.

describe('carried inline scan', () => {
  function stream(
    text: string,
    step: number,
    opts: ResolvedEngineOptions = base,
    repair?: RepairOptions,
  ): { agreed: number; resumed: number } {
    let carry: ReturnType<typeof repairTail>['scan'] = null;
    let agreed = 0;
    let resumed = 0;
    for (let end = step; ; end = Math.min(end + step, text.length)) {
      const tail = text.slice(0, end);
      const cold = repairTail(tail, SEED, opts, repair);
      const warm = repairTail(tail, SEED, opts, repair, carry);
      expect(warm.text).toBe(cold.text);
      expect(warm.appended).toBe(cold.appended);
      expect(warm.touched).toEqual(cold.touched);
      agreed += 1;
      // How often the carry was actually usable — a test that never resumed
      // would pass while measuring nothing.
      if (
        carry != null &&
        carry.regionStart === (warm.scan?.regionStart ?? -1) &&
        carry.inline.pos > 0
      ) {
        resumed += 1;
      }
      carry = warm.scan ?? null;
      if (end === text.length) {
        break;
      }
    }
    return { agreed, resumed };
  }

  const PROSE =
    'the **quick** brown fox *jumps* over a `lazy` dog while the stream ' +
    'keeps arriving token by token and the __paragraph__ never reaches a ' +
    'blank line, so the tail stays ~~settled~~ unanchored for its whole ' +
    'life. it holds a [link](https://example.com) and a <b>tag</b> too. ';

  test('a streamed paragraph repairs identically with and without it', () => {
    const out = stream(PROSE.repeat(4), 7);
    expect(out.resumed).toBeGreaterThan(out.agreed / 2);
  });

  test.each([1, 2, 3, 5, 11, 18])(
    'agrees at a delta size of %i characters',
    (step) => {
      expect(stream(PROSE, step).resumed).toBeGreaterThan(0);
    },
  );

  test.each([
    ['emphasis that grows a run', 'a *b* c ** d *** e ****f'],
    ['a code span that spans deltas', 'x `code` y ``two`` z ``a`b`` w `open'],
    ['brackets that never close', 'a [b c [d e ] f [g'],
    ['an image that completes', 'see ![alt](https://ex.com/i.png) done'],
    ['a link destination arriving', 'see [a](https://ex.com/x) and [b](htt'],
    ['a tag that is completed later', 'a <b>x</b> y <i c d'],
    ['a comment that terminates', 'a <!-- c --> b <!-- open'],
    ['an escape at the boundary', 'a \\*b\\* c \\'],
    ['a dollar that becomes display math', 'cost $5 and $$x = 1$$ then $'],
    ['a blank line splitting the region', 'a *b*\n\nc *d* e'],
    ['a list item taking over the region', 'intro *x*\n- item *y*\n- item *z'],
    ['a fence opening mid-stream', 'text *a*\n```js\ncode *b*\n'],
    ['a table row', 'a *b*\n| x | y |\n| --- | --- |\n| 1 | 2 |\n'],
    ['CRLF paragraphs', 'a *b*\r\n\r\nc *d'],
    ['a setext-shaped tail line', 'Title *x*\n===='],
    ['an autolink still arriving', 'go <https://exa'],
    ['a URI-ish label', 'see [fhir://Obs](fhir://Ob'],
  ])('agrees on %s', (_name, text) => {
    for (const step of [1, 3, 7]) {
      stream(text, step);
    }
  });

  test('agrees with math, spoilers and strikethrough on', () => {
    const opts = resolveOptions({
      ...presets.llmChat,
      extensions: {
        ...presets.llmChat.extensions,
        math: true,
        spoilers: true,
      },
    });
    stream('a $$x$$ b ||secret|| c ~~gone~~ d ||open $$y', 3, opts);
    stream('||a|| ||b|| ||c', 1, opts);
  });

  test('agrees under the display-repair options', () => {
    stream('see [fhir://Obs](fhir://Ob', 3, base, {
      hideUriLikeLabels: true,
      hideBareUriSchemes: ['message'],
    });
    stream('ref message://5f3a-99 done', 3, base, {
      hideBareUriSchemes: ['message'],
    });
  });

  test('refuses a carry whose tail is not a prefix of this one', () => {
    const first = repairTail('hello world', SEED, base);
    // The prefix differs at a sampled character, where a '*' now opens
    // emphasis; the fingerprint must catch the swap.
    const swapped = repairTail('hell *world x', SEED, base, undefined, first.scan);
    expect(swapped.text).toBe('hell *world x*');
  });

  test('refuses a carry made under different extensions', () => {
    const strikeOff = resolveOptions({
      ...presets.llmChat,
      extensions: { ...presets.llmChat.extensions, strikethrough: false },
    });
    const cold = repairTail('a ~~b', SEED, strikeOff);
    const warm = repairTail('a ~~b c', SEED, base, undefined, cold.scan);
    expect(warm.text).toBe('a ~~b c~~');
  });
});

/*
 * Random markdown soup streamed in 1-4 character deltas under random options
 * must give the carried and cold runs the same text, appended suffix and
 * touched spans at every prefix. Seeded, so a failure is reproducible.
 */
describe('carried inline scan, fuzzed', () => {
  const FRAGMENTS = [
    'a', 'b', ' ', ' ', 'x ', '\n', '\n\n', '*', '**', '_', '~~', '`', '``',
    '[', ']', '(', ')', '!', '<', '>', '|', '||', '$', '$$', '\\', '\r\n',
    '- ', '# ', '```', 'http://e.co', '<!--', '-->', 'word ', '.', ':', '"',
  ];
  const OPTION_SETS = [
    resolveOptions({
      ...presets.llmChat,
      extensions: { ...presets.llmChat.extensions, math: true, spoilers: true },
    }),
    base,
    commonmark,
    resolveOptions({
      ...presets.llmChat,
      extensions: {
        ...presets.llmChat.extensions,
        strikethrough: false,
        tables: false,
      },
    }),
  ];
  const REPAIRS: (RepairOptions | undefined)[] = [
    undefined,
    hideLabels,
    hideMessage,
    hideAll,
  ];

  test('agrees with a cold scan on 2000 random streamed documents', () => {
    const rand = lcg(20260902);
    for (let trial = 0; trial < 2000; trial += 1) {
      const options = OPTION_SETS[Math.floor(rand() * OPTION_SETS.length)];
      const repair = REPAIRS[Math.floor(rand() * REPAIRS.length)];
      const pieces: string[] = [];
      const length = 3 + Math.floor(rand() * 60);
      for (let i = 0; i < length; i += 1) {
        pieces.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
      }
      const text = pieces.join('');
      const step = 1 + Math.floor(rand() * 4);
      let carry: ReturnType<typeof repairTail>['scan'] = null;
      for (let end = step; end < text.length + step; end += step) {
        const tail = text.slice(0, Math.min(end, text.length));
        const cold = repairTail(tail, SEED, options, repair);
        const warm = repairTail(tail, SEED, options, repair, carry);
        // Reported as one assertion with the input in it: a bare toBe() on a
        // random document says nothing about which document.
        const same =
          warm.text === cold.text &&
          warm.appended === cold.appended &&
          JSON.stringify(warm.touched) === JSON.stringify(cold.touched);
        if (!same) {
          throw new Error(
            `carried scan diverged at ${tail.length} chars of ` +
              `${JSON.stringify(text)}\n  cold ${JSON.stringify(cold.text)}\n` +
              `  warm ${JSON.stringify(warm.text)}`,
          );
        }
        carry = warm.scan;
      }
    }
  });
});


/*
 * A virtual closer must be consumed as syntax: no text node may reach
 * `realEnd`, where the appended suffix begins. The residue is pinned, not
 * zero: each class is a shape where no append could work and the repair
 * should have withheld its closer. Raising the count is a regression;
 * lowering it is a fix.
 */
describeNative('repaired tails never paint an appended character', () => {
  const FRAGMENTS = [
    'a', 'b', ' ', ' ', 'x ', '\n', '\n\n', '*', '**', '_', '~~', '`', '``',
    '[', ']', '(', ')', '!', '<', '>', '|', '||', '$', '$$', '\\', '\r\n',
    '- ', '# ', '```', 'http://e.co', '<!--', '-->', 'word ', '.', ':', '"',
    '|||', '\\|', '| - | - |', '<b>', '</b>', "'", '<?', '<!', '~',
  ];
  const everything = resolveOptions(presets.everything);



  /** Text nodes that reach into the appended suffix, as source slices. */
  function paintedBeyond(text: string, realEnd: number): string[] {
    const doc = parseDocument(text, presets.everything);
    const painted: string[] = [];
    visit(doc, (node) => {
      if (node.kind === 'text' && node.span.end > realEnd) {
        painted.push(
          text.slice(Math.max(node.span.start, realEnd), node.span.end),
        );
      }
    });
    return painted;
  }

  test('2000 random tails, spoilers on', () => {
    const rand = lcg(20260903);
    const shapes: string[] = [];
    const examples = new Map<string, string>();
    for (let trial = 0; trial < 2000; trial += 1) {
      const pieces: string[] = [];
      const length = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < length; i += 1) {
        pieces.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
      }
      const tail = pieces.join('');
      const r = repairTail(tail, SEED, everything);
      if (r.appended === '') {
        continue;
      }
      const realEnd = r.text.length - r.appended.length;
      if (paintedBeyond(r.text, realEnd).length === 0) {
        continue;
      }
      const before = r.text.slice(0, realEnd);
      const shape = /\\$/.test(before)
        ? 'trailing backslash escapes the closer'
        : /`$/.test(before) && r.appended.includes('`')
          ? 'backtick run fuses past the opener length'
          : /\s$/.test(before)
            ? 'closer lands after whitespace'
            : r.appended.startsWith('$$')
              ? 'math closer that does not bind'
              : 'spoiler closer or emphasis run that does not pair';
      shapes.push(shape);
      if (!examples.has(shape)) {
        examples.set(
          shape,
          `${JSON.stringify(tail)} -> ${JSON.stringify(r.text)}`,
        );
      }
    }
    // Named so a NEW class of paint fails loudly even if the total happens
    // to match; `examples` carries one tail per class into the diff.
    expect([...new Set(shapes)].sort()).toEqual([
      'backtick run fuses past the opener length',
      'closer lands after whitespace',
      'math closer that does not bind',
      'spoiler closer or emphasis run that does not pair',
      'trailing backslash escapes the closer',
    ]);
    expect(examples.size).toBe(5);
    expect(shapes.length).toBe(57);
  });
});

describe('repair boundaries', () => {
  test('opener indentation does not permit a four-space closing fence', () => {
    const source = ' ```\nx\n    ```\n*hi';
    const repaired = repairTail(source, SEED, base);
    expect(repaired.appended).toBe('\n```');
    expect(repaired.text).toBe(source + '\n```');
  });

  test('backslashes do not escape code-span closing backticks', () => {
    for (const source of ['`a\\`', '``a\\``']) {
      expect(repairTail(source, SEED, base).text).toBe(source);
    }
  });
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
