import type { AnyNode } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import { visit } from '../document/visit';
import { parseDocument } from './Engine';
import type { Engine } from './Engine';
import type { EngineOptions } from './options';

/** One link as the renderer sees it. */
export interface ExtractedLink {
  kind: 'link' | 'autolink';
  href: string;
  /** True for a link the URL policy refused (`blockedLinks: 'node'` only). */
  blocked: boolean;
  /** The label's plain text, or an autolink's address as written. */
  text: string;
  span: SourceSpan;
}

/**
 * Every link in `source`, in document order, from the same parse the view
 * renders — same engine, same options, same URL policy — so a list built
 * from it cannot disagree with what is on screen. Blocked links appear only
 * under `urlPolicy.blockedLinks: 'node'`, as in rendering.
 */
export function extractLinks(
  source: string,
  options?: EngineOptions,
  engine?: Engine,
): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  visit(parseDocument(source, options, engine), (node) => {
    if (node.kind === 'link') {
      if (node.incomplete) return undefined;
      out.push({
        kind: 'link',
        href: node.href,
        blocked: node.blocked === true,
        text: plainText(node.children),
        span: node.span,
      });
      return false;
    }
    if (node.kind === 'autolink') {
      out.push({
        kind: 'autolink',
        href: node.href,
        blocked: false,
        text: node.text ?? node.href,
        span: node.span,
      });
    }
    return undefined;
  });
  return out;
}

function plainText(nodes: readonly AnyNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'codeSpan':
      case 'math':
        out += node.value;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'autolink':
        out += node.text ?? node.href;
        break;
      case 'softBreak':
        out += ' ';
        break;
      case 'hardBreak':
        out += '\n';
        break;
      default:
        if ('children' in node) out += plainText(node.children as AnyNode[]);
    }
  }
  return out;
}
