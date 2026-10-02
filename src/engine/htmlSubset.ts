import type { Block, Inline, ParsedDocument } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { ResolvedEngineOptions } from './options';
import { isUrlAllowed, sanitizeUrl } from './urlPolicy';

/**
 * `html: { allow }`: the allowed tags become real nodes — `<a href>` a link
 * (through the URL policy), `<br>` a hard break, `<strong>`/`<b>`,
 * `<em>`/`<i>`, `<s>`/`<del>`, `<u>`/`<ins>` and `<code>` their marks — and
 * every other tag follows `other`. Runs after a raw parse, so it holds for
 * any engine. Pairing is within one sibling list; an unpaired allowed tag is
 * dropped. A raw HTML block that opens with an allowed tag (a line starting
 * `<br>`) becomes a paragraph of its text rather than vanishing.
 */
export function applyHtmlSubset(doc: ParsedDocument, options: ResolvedEngineOptions): ParsedDocument {
  const allow = new Set(options.htmlAllow.map((tag) => tag.toLowerCase()));
  if (allow.size === 0) return doc;
  const ctx: SubsetContext = { source: doc.source, allow, options };
  const blocks = convertBlocks(doc.blocks, ctx);
  return blocks === doc.blocks ? doc : { source: doc.source, blocks };
}

interface SubsetContext {
  source: string;
  allow: ReadonlySet<string>;
  options: ResolvedEngineOptions;
}

type Container = 'link' | 'strong' | 'emphasis' | 'strikethrough' | 'underline';

const PAIRED: Record<string, Container | 'code'> = {
  a: 'link',
  strong: 'strong',
  b: 'strong',
  em: 'emphasis',
  i: 'emphasis',
  s: 'strikethrough',
  del: 'strikethrough',
  strike: 'strikethrough',
  u: 'underline',
  ins: 'underline',
  code: 'code',
};

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  href?: string;
}

const TAG = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)\s*>$/;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function parseTag(literal: string): Tag | null {
  const match = literal.trim().match(TAG);
  if (match === null) return null;
  const tag: Tag = {
    name: match[2].toLowerCase(),
    closing: match[1] === '/',
    selfClosing: match[4] === '/',
  };
  const href = match[3].match(HREF);
  if (href !== null) tag.href = decodeAttribute(href[1] ?? href[2] ?? href[3] ?? '');
  return tag;
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function convertBlock(block: Block, ctx: SubsetContext): Block | null {
  switch (block.kind) {
    case 'paragraph':
    case 'heading': {
      const children = convertInlines(block.children, ctx);
      return children === block.children ? block : { ...block, children };
    }
    case 'blockquote':
    case 'listItem': {
      const children = convertBlocks(block.children, ctx);
      return children === block.children ? block : { ...block, children };
    }
    case 'list': {
      let changed = false;
      const items = block.items.map((item) => {
        const next = convertBlock(item, ctx);
        if (next !== item) changed = true;
        return (next ?? { ...item, children: [] }) as typeof item;
      });
      return changed ? { ...block, items } : block;
    }
    case 'table': {
      const header = convertRow(block.header, ctx);
      let changed = header !== block.header;
      const rows = block.rows.map((row) => {
        const next = convertRow(row, ctx);
        if (next !== row) changed = true;
        return next;
      });
      return changed ? { ...block, header, rows } : block;
    }
    case 'htmlBlock':
      return convertHtmlBlock(block, ctx);
    default:
      return block;
  }
}

function convertBlocks(blocks: Block[], ctx: SubsetContext): Block[] {
  let changed = false;
  const out: Block[] = [];
  for (const block of blocks) {
    const next = convertBlock(block, ctx);
    if (next !== block) changed = true;
    if (next !== null) out.push(next);
  }
  return changed ? out : blocks;
}

function convertRow<T extends Extract<Block, { kind: 'tableRow' }>>(row: T, ctx: SubsetContext): T {
  let changed = false;
  const cells = row.cells.map((cell) => {
    const children = convertInlines(cell.children, ctx);
    if (children === cell.children) return cell;
    changed = true;
    return { ...cell, children };
  });
  return changed ? { ...row, cells } : row;
}

/** A raw block that opens with an allowed tag becomes a paragraph; others follow `other`. */
function convertHtmlBlock(block: Extract<Block, { kind: 'htmlBlock' }>, ctx: SubsetContext): Block | null {
  const raw = ctx.source.slice(block.span.start, block.span.end);
  const first = raw.match(/^\s*(<[^>]*>)/);
  const tag = first ? parseTag(first[1]) : null;
  if (tag === null || !ctx.allow.has(tag.name)) {
    return ctx.options.htmlOther === 'raw' ? block : null;
  }
  const converted = convertInlines(tokenize(raw, block.span.start), ctx);
  // The tag's own line ending is not a second break, and a paragraph does not open on one.
  const children: Inline[] = [];
  for (const child of converted) {
    const isBreak = child.kind === 'softBreak' || child.kind === 'hardBreak';
    if (isBreak && children.length === 0) continue;
    if (child.kind === 'softBreak' && children[children.length - 1]?.kind === 'hardBreak') continue;
    children.push(child);
  }
  if (!children.some((child) => child.kind !== 'softBreak' && child.kind !== 'hardBreak')) return null;
  return { kind: 'paragraph', span: block.span, children };
}

/** Raw HTML into text, soft-break and htmlSpan nodes with exact spans. */
function tokenize(raw: string, offset: number): Inline[] {
  const out: Inline[] = [];
  const end = raw.replace(/\s+$/, '').length;
  const pushText = (from: number, to: number): void => {
    let at = from;
    raw
      .slice(from, to)
      .split('\n')
      .forEach((line, index) => {
        if (index > 0) {
          out.push({ kind: 'softBreak', span: span(offset + at, offset + at + 1) });
          at += 1;
        }
        if (line.length > 0) {
          out.push({ kind: 'text', span: span(offset + at, offset + at + line.length), value: line });
        }
        at += line.length;
      });
  };
  let cursor = 0;
  for (const match of raw.matchAll(/<[^>]*>/g)) {
    const at = match.index ?? 0;
    if (at >= end) break;
    if (at > cursor) pushText(cursor, at);
    out.push({ kind: 'htmlSpan', span: span(offset + at, offset + at + match[0].length), literal: match[0] });
    cursor = at + match[0].length;
  }
  if (cursor < end) pushText(cursor, end);
  return out;
}

function span(start: number, end: number): SourceSpan {
  return { start, end };
}

interface Open {
  tag: Tag;
  start: number;
  index: number;
}

function convertInlines(children: Inline[], ctx: SubsetContext): Inline[] {
  let changed = false;
  // Grandchildren first, so pairing sees them converted.
  const nested = children.map((child) => {
    if (!('children' in child) || !Array.isArray(child.children)) return child;
    const inner = convertInlines(child.children as Inline[], ctx);
    if (inner === child.children) return child;
    changed = true;
    return { ...child, children: inner } as Inline;
  });
  if (!nested.some((child) => child.kind === 'htmlSpan')) return changed ? nested : children;

  const out: Inline[] = [];
  const stack: Open[] = [];
  for (const child of nested) {
    if (child.kind !== 'htmlSpan') {
      out.push(child);
      continue;
    }
    const tag = parseTag(child.literal);
    if (tag === null || !ctx.allow.has(tag.name)) {
      if (ctx.options.htmlOther === 'raw') out.push(child);
      continue;
    }
    if (tag.name === 'br') {
      out.push({ kind: 'hardBreak', span: child.span });
      continue;
    }
    if (!(tag.name in PAIRED)) continue;
    if (!tag.closing) {
      if (!tag.selfClosing) stack.push({ tag, start: child.span.start, index: out.length });
      continue;
    }
    // The nearest open tag of the same name closes; anything opened after it was unpaired.
    let at = stack.length - 1;
    while (at >= 0 && stack[at].tag.name !== tag.name) at -= 1;
    if (at < 0) continue;
    const open = stack[at];
    stack.length = at;
    const inner = out.splice(open.index);
    out.push(wrap(open.tag, inner, span(open.start, child.span.end), ctx));
  }
  return out;
}

function wrap(tag: Tag, children: Inline[], whole: SourceSpan, ctx: SubsetContext): Inline {
  const kind = PAIRED[tag.name];
  if (kind === 'code') {
    return { kind: 'codeSpan', span: whole, value: children.map(plain).join('') };
  }
  if (kind !== 'link') return { kind, span: whole, children };
  const href = sanitizeUrl(tag.href ?? '');
  if (href !== '' && isUrlAllowed(href, ctx.options.urlPolicy.linkPrefixes)) {
    return { kind: 'link', span: whole, href, children };
  }
  if (href !== '' && ctx.options.urlPolicy.blockedLinks === 'node') {
    return { kind: 'link', span: whole, href, children, blocked: true };
  }
  // Refused or missing: its text, like a blocked markdown link.
  return { kind: 'text', span: whole, value: children.map(plain).join('') };
}

function plain(node: Inline): string {
  switch (node.kind) {
    case 'text':
    case 'codeSpan':
    case 'math':
      return node.value;
    case 'softBreak':
      return ' ';
    case 'hardBreak':
      return '\n';
    default:
      return 'children' in node ? (node.children as Inline[]).map(plain).join('') : '';
  }
}
