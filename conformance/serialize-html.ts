/**
 * AST -> HTML serializer for the CommonMark spec oracle.
 *
 * Produces CommonMark-reference-shaped output (p, h1-h6, pre>code with a
 * language-* class, ul/ol/li, blockquote, hr, em, strong, del, code, a, img,
 * br) so a parsed document can be compared against the expected HTML in
 * conformance/vendor/spec.json. GFM tables and the library's extension nodes
 * (math, spoiler, underline as `<u>` — matching md4c's rendering of
 * MD_SPAN_U) are also covered so the same serializer can back future
 * extension suites.
 *
 * Uses only type imports on purpose: the conformance runner transpiles this
 * file standalone at run time, so it must have no runtime dependencies.
 */
import type {
  Block,
  Inline,
  ListItemNode,
  ListNode,
  ParsedDocument,
  TableNode,
  TableRowNode,
} from '../src/document/nodes';

export function serializeDocumentToHtml(doc: ParsedDocument): string {
  return serializeBlocksToHtml(doc.blocks);
}

export function serializeBlocksToHtml(blocks: readonly Block[]): string {
  const w = new HtmlWriter();
  for (const block of blocks) {
    renderBlock(w, block, false);
  }
  w.cr();
  return w.toString();
}

/**
 * Buffer with reference-renderer newline semantics: `cr()` emits a newline
 * only when the buffer is non-empty and does not already end with one, which
 * yields `<li>foo</li>` for tight items but `<li>\n<p>foo</p>\n</li>` for
 * loose ones without special-casing every parent/child pair.
 */
class HtmlWriter {
  private readonly parts: string[] = [];
  /**
   * The last character written, tracked separately rather than read back off
   * the accumulated string. `out.endsWith('\n')` on a growing rope forces the
   * engine to flatten it on every call, which made serializing quadratic —
   * 2.6 s for a 290 kB corpus that parses in 40 ms. Correct either way, but
   * this module is also the head-to-head benchmark's HTML writer, and a
   * quadratic oracle cannot measure a linear parser.
   */
  private last = '';

  lit(s: string): void {
    if (s === '') return;
    this.parts.push(s);
    this.last = s[s.length - 1];
  }

  cr(): void {
    // `last === ''` is exactly "nothing written yet", since empty writes are
    // dropped above — the same condition the string version tested.
    if (this.last !== '' && this.last !== '\n') this.lit('\n');
  }

  toString(): string {
    return this.parts.join('');
  }
}

function renderBlock(w: HtmlWriter, block: Block, tight: boolean): void {
  switch (block.kind) {
    case 'paragraph':
      if (tight) {
        w.lit(renderInlines(block.children));
      } else {
        w.cr();
        w.lit(`<p>${renderInlines(block.children)}</p>`);
        w.cr();
      }
      return;
    case 'heading':
      w.cr();
      w.lit(`<h${block.level}>${renderInlines(block.children)}</h${block.level}>`);
      w.cr();
      return;
    case 'codeBlock': {
      w.cr();
      const language = (block.language ?? '').split(/\s+/)[0];
      const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
      let literal = block.literal;
      if (literal !== '' && !literal.endsWith('\n')) {
        literal += '\n';
      }
      w.lit(`<pre><code${cls}>${escapeHtml(literal)}</code></pre>`);
      w.cr();
      return;
    }
    case 'blockquote':
      w.cr();
      w.lit('<blockquote>');
      w.cr();
      for (const child of block.children) {
        renderBlock(w, child, false);
      }
      w.cr();
      w.lit('</blockquote>');
      w.cr();
      return;
    case 'list':
      renderList(w, block);
      return;
    case 'listItem':
      // Occurs only inside a list; reaching here means a malformed tree.
      renderListItem(w, block, tight);
      return;
    case 'table':
      renderTable(w, block);
      return;
    case 'tableRow':
      renderTableRow(w, block, 'td', []);
      return;
    case 'tableCell':
      w.lit(`<td>${renderInlines(block.children)}</td>`);
      w.cr();
      return;
    case 'thematicBreak':
      w.cr();
      w.lit('<hr />');
      w.cr();
      return;
    case 'htmlBlock':
      if (block.literal !== '') {
        w.cr();
        w.lit(block.literal);
        w.cr();
      }
      return;
  }
}

function renderList(w: HtmlWriter, list: ListNode): void {
  w.cr();
  if (list.ordered) {
    const start = list.start ?? 1;
    w.lit(start !== 1 ? `<ol start="${start}">` : '<ol>');
  } else {
    w.lit('<ul>');
  }
  w.cr();
  for (const item of list.items) {
    renderListItem(w, item, list.tight);
  }
  w.lit(list.ordered ? '</ol>' : '</ul>');
  w.cr();
}

function renderListItem(w: HtmlWriter, item: ListItemNode, tight: boolean): void {
  w.lit('<li>');
  if (item.task !== undefined) {
    const checked = item.task === 'checked' ? ' checked=""' : '';
    w.lit(`<input type="checkbox"${checked} disabled="" /> `);
  }
  for (const child of item.children) {
    renderBlock(w, child, tight);
  }
  w.lit('</li>');
  w.cr();
}

function renderTable(w: HtmlWriter, table: TableNode): void {
  w.cr();
  w.lit('<table>');
  w.cr();
  w.lit('<thead>');
  w.cr();
  renderTableRow(w, table.header, 'th', table.align);
  w.lit('</thead>');
  w.cr();
  if (table.rows.length > 0) {
    w.lit('<tbody>');
    w.cr();
    for (const row of table.rows) {
      renderTableRow(w, row, 'td', table.align);
    }
    w.lit('</tbody>');
    w.cr();
  }
  w.lit('</table>');
  w.cr();
}

function renderTableRow(
  w: HtmlWriter,
  row: TableRowNode,
  tag: 'th' | 'td',
  align: TableNode['align'],
): void {
  w.lit('<tr>');
  w.cr();
  row.cells.forEach((cell, i) => {
    const alignment = align[i] ?? null;
    const attr = alignment ? ` align="${alignment}"` : '';
    w.lit(`<${tag}${attr}>${renderInlines(cell.children)}</${tag}>`);
    w.cr();
  });
  w.lit('</tr>');
  w.cr();
}

function renderInlines(inlines: readonly Inline[]): string {
  let out = '';
  for (const inline of inlines) {
    out += renderInline(inline);
  }
  return out;
}

function renderInline(inline: Inline): string {
  switch (inline.kind) {
    case 'text':
      return escapeHtml(inline.value);
    case 'softBreak':
      return '\n';
    case 'hardBreak':
      return '<br />\n';
    case 'codeSpan':
      return `<code>${escapeHtml(inline.value)}</code>`;
    case 'emphasis':
      return `<em>${renderInlines(inline.children)}</em>`;
    case 'strong':
      return `<strong>${renderInlines(inline.children)}</strong>`;
    case 'strikethrough':
      return `<del>${renderInlines(inline.children)}</del>`;
    case 'underline':
      return `<u>${renderInlines(inline.children)}</u>`;
    case 'link': {
      const title = inline.title ? ` title="${escapeHtml(inline.title)}"` : '';
      return `<a href="${escapeHref(inline.href)}"${title}>${renderInlines(inline.children)}</a>`;
    }
    case 'image': {
      const title = inline.title ? ` title="${escapeHtml(inline.title)}"` : '';
      return `<img src="${escapeHref(inline.src)}" alt="${escapeHtml(inline.alt)}"${title} />`;
    }
    case 'autolink': {
      const label = inline.href.startsWith('mailto:')
        ? inline.href.slice('mailto:'.length)
        : inline.href;
      return `<a href="${escapeHref(inline.href)}">${escapeHtml(label)}</a>`;
    }
    case 'math':
      return inline.display
        ? `<span class="math math-display">${escapeHtml(inline.value)}</span>`
        : `<span class="math math-inline">${escapeHtml(inline.value)}</span>`;
    case 'spoiler':
      return `<span class="spoiler">${renderInlines(inline.children)}</span>`;
    case 'htmlSpan':
      return inline.literal;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Reference-renderer href escaping: a safe set of ASCII passes through,
 * `&` and `'` become HTML entities, everything else (including all
 * non-ASCII) is percent-encoded as UTF-8 bytes. Existing `%XX` escapes are
 * preserved because `%` itself is in the safe set.
 *
 * The safe set matches cmark's `houdini_escape_href`, which notably does
 * NOT include square brackets — `[`/`]` in a destination come out as
 * `%5B`/`%5D`, and the spec's expected HTML relies on it.
 */
const HREF_SAFE = /[A-Za-z0-9!#$%()*+,\-./:;=?@_~]/;

function escapeHref(url: string): string {
  let out = '';
  for (const ch of url) {
    if (ch === '&') {
      out += '&amp;';
    } else if (ch === "'") {
      out += '&#x27;';
    } else if (ch.length === 1 && HREF_SAFE.test(ch)) {
      out += ch;
    } else {
      out += percentEncode(ch);
    }
  }
  return out;
}

function percentEncode(ch: string): string {
  let out = '';
  // TextEncoder is avoided to keep this module dependency-free across
  // runtimes; encodeURIComponent yields the same UTF-8 byte escapes for the
  // characters that reach here, except for its own unreserved set.
  const encoded = encodeURIComponent(ch);
  if (encoded.startsWith('%')) {
    return encoded;
  }
  // Characters encodeURIComponent leaves bare (e.g. `!`, `*`, `'`, `(`, `)`)
  // are all in HREF_SAFE or handled above, so this fallback encodes the
  // remaining ASCII directly.
  for (let i = 0; i < ch.length; i++) {
    out += '%' + ch.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
