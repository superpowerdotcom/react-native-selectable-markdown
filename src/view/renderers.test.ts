const openURL = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('react-native', () => ({
  Image: 'Image',
  Linking: { openURL: (url: string) => openURL(url) },
  Text: 'Text',
  View: 'View',
  Platform: {
    OS: 'ios',
    select: (options: Record<string, unknown>) =>
      options.ios !== undefined ? options.ios : options.default,
  },
}));

import { DEFAULT_LINK_PREFIXES } from '../engine/options';
import { openUrl } from './renderers';

let warn: jest.SpyInstance;

beforeEach(() => {
  openURL.mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('openUrl', () => {
  it('opens a URL the policy allows', () => {
    openUrl('https://example.com/a', DEFAULT_LINK_PREFIXES);

    expect(openURL).toHaveBeenCalledWith('https://example.com/a');
  });

  it('refuses a scheme outside the allowlist', () => {
    openUrl('javascript:alert(1)', DEFAULT_LINK_PREFIXES);
    expect(openURL).not.toHaveBeenCalled();

    openUrl('https://example.com/b', DEFAULT_LINK_PREFIXES);
    expect(openURL.mock.calls).toEqual([['https://example.com/b']]);
  });

  it('strips control characters before judging the scheme', () => {
    // A URL loader that strips control characters itself would run `java\nscript:`.
    openUrl('java\nscript:alert(1)', DEFAULT_LINK_PREFIXES);
    expect(openURL).not.toHaveBeenCalled();

    openUrl('ht\ttps://example.com/c', DEFAULT_LINK_PREFIXES);
    expect(openURL.mock.calls).toEqual([['https://example.com/c']]);
  });

  it('opens the sanitized string, not the raw one', () => {
    openUrl('https://example.com/ok', DEFAULT_LINK_PREFIXES);

    expect(openURL).toHaveBeenCalledWith('https://example.com/ok');
  });

  it('honours a consumer-configured prefix', () => {
    openUrl('myapp://checkout/1', [...DEFAULT_LINK_PREFIXES, 'myapp://']);

    expect(openURL).toHaveBeenCalledWith('myapp://checkout/1');
  });

  it('falls back to the shipped prefixes when none are given', () => {
    openUrl('tel:+15551234');
    expect(openURL).not.toHaveBeenCalled();

    openUrl('mailto:a@example.com');
    expect(openURL).toHaveBeenCalledWith('mailto:a@example.com');
  });

  it('names a refused scheme once in DEV', () => {
    openUrl('file:///etc/passwd', DEFAULT_LINK_PREFIXES);
    openUrl('file:///etc/hosts', DEFAULT_LINK_PREFIXES);

    expect(openURL).not.toHaveBeenCalled();
    const refusals = warn.mock.calls.filter((call) =>
      String(call[0]).includes('"file:"'),
    );
    expect(refusals).toHaveLength(1);
  });

  it('swallows a rejected openURL', async () => {
    openURL.mockImplementationOnce(() => Promise.reject(new Error('no handler')));

    expect(() => openUrl('https://example.com', DEFAULT_LINK_PREFIXES)).not.toThrow();
    expect(openURL.mock.calls).toEqual([['https://example.com']]);
    // Let the rejection settle: an unhandled one would fail the run.
    await Promise.resolve();
  });
});

import type { AnyNode, Block } from '../document/nodes';
import { defaultTheme } from './theme';
import type { RenderContext } from './renderers';
import {
  MAX_RENDER_DEPTH,
  defaultRenderers,
  renderNode,
  textContentOf,
} from './renderers';

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'props' in value
  );
}

/** Evaluates elements with a loop, so these cases assert the cap and the flat text, not a crash. */
function evaluate(root: unknown): { text: string; maxDepth: number } {
  const parts: string[] = [];
  let maxDepth = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || item === undefined || typeof item === 'boolean') {
      continue;
    }
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i -= 1) {
        stack.push(item[i]);
      }
      continue;
    }
    if (!isElement(item)) {
      continue;
    }
    if (typeof item.type === 'function') {
      const ctx = item.props.ctx as RenderContext | undefined;
      if (ctx !== undefined) {
        maxDepth = Math.max(maxDepth, ctx.depth ?? 0);
      }
      stack.push((item.type as (props: unknown) => unknown)(item.props));
      continue;
    }
    stack.push(item.props.children);
  }
  return { text: parts.join(''), maxDepth };
}

function nestedQuote(levels: number): Block {
  let node: Block = {
    kind: 'paragraph',
    span: { start: levels * 2, end: levels * 2 + 4 },
    children: [
      {
        kind: 'text',
        span: { start: levels * 2, end: levels * 2 + 4 },
        value: 'echo',
      },
    ],
  };
  for (let i = levels - 1; i >= 0; i -= 1) {
    node = {
      kind: 'blockquote',
      span: { start: i * 2, end: levels * 2 + 4 },
      children: [node],
    };
  }
  return node;
}

function context(source: string): RenderContext {
  return {
    theme: defaultTheme,
    renderers: defaultRenderers,
    source,
    listDepth: 0,
    selectable: true,
  };
}

function selectableFlags(root: unknown): unknown[] {
  const flags: unknown[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || item === undefined || typeof item !== 'object') {
      continue;
    }
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i -= 1) stack.push(item[i]);
      continue;
    }
    if (!isElement(item)) continue;
    if ('selectable' in item.props) {
      flags.push((item.props as { selectable: unknown }).selectable);
    }
    if (typeof item.type === 'function') {
      stack.push((item.type as (props: unknown) => unknown)(item.props));
      continue;
    }
    stack.push(item.props.children);
  }
  return flags;
}

describe('renderers are placed as their own component type', () => {
  const paragraph: Block = {
    kind: 'paragraph',
    span: { start: 0, end: 5 },
    children: [{ kind: 'text', span: { start: 0, end: 5 }, value: 'hello' }],
  };
  const other: Block = {
    kind: 'paragraph',
    span: { start: 6, end: 11 },
    children: [{ kind: 'text', span: { start: 6, end: 11 }, value: 'world' }],
  };

  function withParagraph(render: unknown): RenderContext {
    const base = context('hello world');
    return {
      ...base,
      renderers: { ...base.renderers, paragraph: render } as RenderContext['renderers'],
    };
  }

  it('gives two different renderers two different component types', () => {
    // Stand-ins for a stateful and a stateless renderer; reconciling one into the other mismatches hooks.
    const stateful = (): null => null;
    const stateless = (): null => null;

    const a = renderNode(paragraph, withParagraph(stateful)) as Element;
    const b = renderNode(paragraph, withParagraph(stateless)) as Element;

    expect(typeof a.type).toBe('function');
    expect(a.type).not.toBe(b.type);
    expect(a.props.render).toBe(stateful);
    expect(b.props.render).toBe(stateless);
  });

  it('keeps one component type per renderer, so an unchanged one never remounts', () => {
    const render = (): null => null;
    const ctx = withParagraph(render);

    expect((renderNode(paragraph, ctx) as Element).type).toBe(
      (renderNode(other, ctx) as Element).type,
    );
    expect((renderNode(paragraph, withParagraph(render)) as Element).type).toBe(
      (renderNode(paragraph, ctx) as Element).type,
    );
  });

  it('derives the child context once per level, not once per node', () => {
    const ctx = context('hello world');
    const a = renderNode(paragraph, ctx) as Element;
    const b = renderNode(other, ctx) as Element;

    expect(a.props.ctx).toBe(b.props.ctx);
    expect((a.props.ctx as RenderContext).depth).toBe(1);
    expect(a.props.ctx).not.toBe(ctx);
    expect(ctx.depth).toBeUndefined();
  });
});

describe('ctx.selectable', () => {
  const paragraph: Block = {
    kind: 'paragraph',
    span: { start: 0, end: 5 },
    children: [{ kind: 'text', span: { start: 0, end: 5 }, value: 'hello' }],
  };

  it('is honoured by the renderers, so an unsettled block cannot be selected', () => {
    const ctx = { ...context('hello'), selectable: false };
    const flags = selectableFlags(renderNode(paragraph, ctx));

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag === false)).toBe(true);
  });

  it('defaults to true when a hand-built context omits it', () => {
    const { selectable: _omitted, ...withoutFlag } = context('hello');
    const flags = selectableFlags(renderNode(paragraph, withoutFlag));

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag === true)).toBe(true);
  });

  it('reaches the unknown-kind fallback too', () => {
    const unknown = {
      kind: 'nonesuch',
      span: { start: 0, end: 5 },
    } as unknown as Block;

    expect(selectableFlags(renderNode(unknown, context('hello')))).toEqual([
      true,
    ]);
    expect(
      selectableFlags(
        renderNode(unknown, { ...context('hello'), selectable: false }),
      ),
    ).toEqual([false]);
  });
});

describe('render nesting depth', () => {
  const LEVELS = 1500;
  const source = '> '.repeat(LEVELS) + 'echo\n';

  it('stops nesting at the cap, flattens the rest, and says so once', () => {
    const out = evaluate(renderNode(nestedQuote(LEVELS), context(source)));
    // Rendered twice: the depth warning is warn-once per process.
    evaluate(renderNode(nestedQuote(LEVELS), context(source)));

    expect(out.maxDepth).toBe(MAX_RENDER_DEPTH);
    expect(out.text).toContain('echo');
    const depthWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('nesting deeper than'),
    );
    expect(depthWarnings).toHaveLength(1);
  });

  it('renders a shallow quote structurally, marker bars and all', () => {
    const out = evaluate(renderNode(nestedQuote(3), context('> > > echo\n')));

    // Three quotes, the paragraph, and its text node.
    expect(out.maxDepth).toBe(5);
    expect(out.text).toBe('echo');
  });

  it('flattens a 20000-deep subtree without overflowing the stack', () => {
    expect(textContentOf(nestedQuote(20_000) as AnyNode, '')).toBe('echo');
  });
});
