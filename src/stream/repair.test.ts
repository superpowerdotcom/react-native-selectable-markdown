import type { ResolvedEngineOptions } from '../engine/options';
import { presets, resolveOptions } from '../engine/options';
import type { RepairOptions, RepairSeed } from './repair';
import { isUriLikeLabel, repairTail, seedFromSettled } from './repair';

const SEED: RepairSeed = { openFence: null, inMath: false };
const base = resolveOptions(presets.llmChat);
const withMath = resolveOptions({
  ...presets.llmChat,
  extensions: { ...presets.llmChat.extensions, math: true },
});
const commonmark = resolveOptions(presets.commonmark);

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
  { name: 'hide: task box unaffected', tail: '- [x]', repair: hideAll, text: '- x', appended: '' },
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
];

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

  test(`corpus holds at least 65 cases (${cases.length})`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(65);
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
});

describe('repairTail hide options', () => {
  test('absent, empty, and all-off options are identical to the default', () => {
    const off: RepairOptions = {
      hideUriLikeLabels: false,
      hideBareUriSchemes: [],
    };
    for (const c of cases) {
      const bare = repairTail(c.tail, c.seed ?? SEED, c.options ?? base);
      for (const r of [undefined, {}, off]) {
        expect(repairTail(c.tail, c.seed ?? SEED, c.options ?? base, r)).toEqual(bare);
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
      const bare = repairTail(c.tail, c.seed ?? SEED, c.options ?? base);
      expect(
        repairTail(c.tail, c.seed ?? SEED, c.options ?? base, hideAll),
      ).toEqual(bare);
    }
  });

  test('hide paths are pure (regex cache is invisible)', () => {
    for (const tail of ['see [fhir://Obs](fhir://O', 'see message://5f']) {
      const a = repairTail(tail, SEED, base, hideAll);
      const b = repairTail(tail, SEED, base, hideAll);
      expect(a).toEqual(b);
    }
    // Alternating scheme lists across calls must not leak between them.
    const copy = repairTail('go copy://1', SEED, base, { hideBareUriSchemes: ['copy'] });
    repairTail('go copy://1', SEED, base, hideMessage);
    expect(repairTail('go copy://1', SEED, base, { hideBareUriSchemes: ['copy'] })).toEqual(copy);
    expect(copy.text).toBe('go ');
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
    for (const label of ['fhir:', 'fhir://Obs', 'https://x', ' fhir://Obs ', 'MESSAGE://5F']) {
      expect(isUriLikeLabel(label)).toBe(true);
    }
  });

  test('rejects prose, task boxes, and space-broken URIs', () => {
    for (const label of ['Vitamin D', 'x', ' ', '', 'fhir://a b', '1abc:x', '**fhir://x']) {
      expect(isUriLikeLabel(label)).toBe(false);
    }
  });
});

describe('repairTail purity', () => {
  test('same input produces the same output, twice', () => {
    const seed: RepairSeed = { openFence: null, inMath: false };
    const a = repairTail('**bold [link](https://exa', seed, base);
    const b = repairTail('**bold [link](https://exa', seed, base);
    expect(a).toEqual(b);
  });

  test('does not mutate the seed', () => {
    const seed: RepairSeed = { openFence: { marker: '`', length: 3 }, inMath: false };
    repairTail('code **x', seed, base);
    expect(seed).toEqual({ openFence: { marker: '`', length: 3 }, inMath: false });
  });

  test('untouched tails report no repairs', () => {
    const result = repairTail('plain prose sentence.', SEED, base);
    expect(result.text).toBe('plain prose sentence.');
    expect(result.appended).toBe('');
    expect(result.touched).toHaveLength(0);
  });

  test('cut-position handlers are pure too', () => {
    for (const tail of ['a [b]', 'x ![y]', 'go <https://e', 'hi \uD83D']) {
      const a = repairTail(tail, SEED, base);
      const b = repairTail(tail, SEED, base);
      expect(a).toEqual(b);
    }
  });
});

describe('seedFromSettled', () => {
  test('detects an open backtick fence', () => {
    expect(seedFromSettled('```js\ncode\n')).toEqual({
      openFence: { marker: '`', length: 3 },
      inMath: false,
    });
  });

  test('detects an open tilde fence with run length', () => {
    expect(seedFromSettled('~~~~\ncode\n')).toEqual({
      openFence: { marker: '~', length: 4 },
      inMath: false,
    });
  });

  test('closed fence leaves no seed', () => {
    expect(seedFromSettled('```\nc\n```\n')).toEqual({ openFence: null, inMath: false });
  });

  test('plain paragraphs leave no seed', () => {
    expect(seedFromSettled('a\n\nb\n')).toEqual({ openFence: null, inMath: false });
  });

  test('unbalanced display math sets inMath', () => {
    expect(seedFromSettled('$$\nx\n')).toEqual({ openFence: null, inMath: true });
  });

  test('balanced display math clears inMath', () => {
    expect(seedFromSettled('$$\nx\n$$\n')).toEqual({ openFence: null, inMath: false });
  });

  test('inline code and single dollars do not seed math', () => {
    expect(seedFromSettled('closed `code` and $5\n')).toEqual({
      openFence: null,
      inMath: false,
    });
  });

  test('empty settled prefix', () => {
    expect(seedFromSettled('')).toEqual({ openFence: null, inMath: false });
  });
});
