/**
 * `openUrl`: the navigation boundary, and the URL allowlist re-checked there.
 *
 * WHY THE CHECK IS HERE AT ALL. The allowlist runs inside the md4c decoder as
 * it builds each node, which is what makes `nativeEngine` incapable of
 * returning a rejected `href` — but it is a property of that engine and not of
 * `parseDocument`: a substituted engine is told that honouring
 * `options.urlPolicy` is optional, and nothing between it and `Linking.openURL`
 * looked at the string. So the press path checks too, against the same
 * prefixes the document was parsed with.
 *
 * `react-native` is stubbed rather than pulled in through a preset, the way
 * `theme.test.ts` does it: the module under test needs `Linking.openURL` and a
 * `Platform.select` for the theme's font families, and nothing here renders.
 */

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
    // The case a custom engine makes reachable: a `javascript:` href that no
    // decoder ever filtered, one `Linking.openURL` away from running.
    openUrl('javascript:alert(1)', DEFAULT_LINK_PREFIXES);

    expect(openURL).not.toHaveBeenCalled();
  });

  it('strips control characters before judging the scheme', () => {
    // `java\nscript:` does not start with `javascript:`, but a URL loader
    // that strips control characters itself would run it — the reason
    // `sanitizeUrl` comes first here as well as in the decoder.
    openUrl('java\nscript:alert(1)', DEFAULT_LINK_PREFIXES);

    expect(openURL).not.toHaveBeenCalled();
  });

  it('opens the sanitized string, not the raw one', () => {
    openUrl('https://example.com/ok', DEFAULT_LINK_PREFIXES);

    expect(openURL).toHaveBeenCalledWith('https://example.com/ok');
  });

  it('honours a consumer-configured prefix', () => {
    // The other half of the policy: an app that allowed its own scheme in
    // `urlPolicy.linkPrefixes` must still be able to open it, so the check
    // reads the resolved list rather than a hardcoded one.
    openUrl('myapp://checkout/1', [...DEFAULT_LINK_PREFIXES, 'myapp://']);

    expect(openURL).toHaveBeenCalledWith('myapp://checkout/1');
  });

  it('falls back to the shipped prefixes when none are given', () => {
    // A `RenderContext` built by hand carries no prefixes. Defaulting to the
    // shipped allowlist rather than to "allow anything" is what keeps that
    // path from being a way around the policy.
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
    // Let the rejection settle: an unhandled one would fail the run.
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Nesting depth.
//
// Model output is untrusted and markdown nesting is unbounded: 3 kB of '> ' is
// a 1500-level blockquote, and without a cap each level becomes another <View>
// around another <Text>. Nothing in JS overflows on that any more — every tree
// walk between the decoder and here drains an explicit stack — but the element
// tree crosses the bridge into a native hierarchy laid out by recursive C++,
// so the depth has to be a property of this library rather than of the input.
// See `MAX_RENDER_DEPTH` for which walks those are.
//
// These cases evaluate the element tree the way React would, with a loop
// instead of a stack: a function element is called with its props and its
// result pushed back. That is enough to see how deep the renderers actually
// nest, and (deliberately) it would not overflow even if they nested 1500
// deep — what is asserted is the CAP and the flattened text, not the absence
// of a crash in the test harness.
// ---------------------------------------------------------------------------

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

/**
 * Renders one element tree to (a) the strings it would paint, in order, and
 * (b) the deepest `ctx.depth` any renderer was invoked with.
 */
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

/** Every `selectable` prop set anywhere in a rendered tree, in visit order. */
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

/**
 * ELEMENT POSITION, AND WHOSE COMPONENT IT IS.
 *
 * A renderer is placed rather than called, so its hooks are its own. That is
 * only half the rule: while every renderer shared ONE wrapper component type,
 * React saw the same component at a stable position when the renderer under
 * it changed — `renderers={editing ? draft : read}` — and handed the new
 * function the old function's hook list, which is the same
 * "Rendered more hooks than during the previous render" the wrapper exists to
 * prevent, one level in. A per-renderer wrapper type makes that a remount.
 *
 * The context handed down is the other half: it is derived once per level,
 * not once per node, so a renderer memoized on it is not defeated by a fresh
 * object every commit.
 */
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
    // The probe from the audit: one renderer holds state, the other does not.
    // Reconciling these in place is the hook-order mismatch.
    const stateful = (): null => null;
    const stateless = (): null => null;

    const a = renderNode(paragraph, withParagraph(stateful)) as Element;
    const b = renderNode(paragraph, withParagraph(stateless)) as Element;

    expect(typeof a.type).toBe('function');
    expect(a.type).not.toBe(b.type);
    // Both still name the renderer they wrap, so invoking the element is what
    // calls it — the seam is placed, never called during `renderNode`.
    expect(a.props.render).toBe(stateful);
    expect(b.props.render).toBe(stateless);
  });

  it('keeps one component type per renderer, so an unchanged one never remounts', () => {
    const render = (): null => null;
    const ctx = withParagraph(render);

    // Two nodes, and a second render pass with a freshly built context: the
    // wrapper is cached on the renderer FUNCTION, not on the context or the
    // node, so nothing here may change identity.
    expect((renderNode(paragraph, ctx) as Element).type).toBe(
      (renderNode(other, ctx) as Element).type,
    );
    expect((renderNode(paragraph, withParagraph(render)) as Element).type).toBe(
      (renderNode(paragraph, ctx) as Element).type,
    );
  });

  it('derives the child context once per level, not once per node', () => {
    // `{ ...ctx, depth }` per node made every child context `===` to nothing,
    // so a consumer renderer wrapped in `React.memo` re-rendered on every
    // commit however stable its inputs were.
    const ctx = context('hello world');
    const a = renderNode(paragraph, ctx) as Element;
    const b = renderNode(other, ctx) as Element;

    expect(a.props.ctx).toBe(b.props.ctx);
    expect((a.props.ctx as RenderContext).depth).toBe(1);
    // And it is still a copy: the caller's context keeps its own depth.
    expect(a.props.ctx).not.toBe(ctx);
    expect(ctx.depth).toBeUndefined();
  });
});

/**
 * `RenderContext.selectable` — the standalone half of the per-platform tail
 * policy, and the field a hand-built context is allowed to omit.
 */
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
    // The field is optional on the exported `RenderContext`: requiring it
    // broke every consumer who builds one to call `renderNode`/`renderBlocks`,
    // and in untyped JS an omitted field rendered `selectable={undefined}` —
    // silently turning the library's headline feature off.
    const { selectable: _omitted, ...withoutFlag } = context('hello');
    const flags = selectableFlags(renderNode(paragraph, withoutFlag));

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag === true)).toBe(true);
  });

  it('reaches the unknown-kind fallback too', () => {
    // The one renderer that used to set no `selectable` at all, so an
    // unrecognised kind inside a standalone block could never be selected.
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
  // 3 kB of '> ' — the finding's input, and the shape an LLM produces when it
  // loses the plot mid-quote.
  const LEVELS = 1500;
  const source = '> '.repeat(LEVELS) + 'echo\n';

  it('stops nesting at the cap, flattens the rest, and says so once', () => {
    const out = evaluate(renderNode(nestedQuote(LEVELS), context(source)));
    // Twice: the DEV warning is warn-once for the whole process, like the
    // unknown-renderer one, so a 1500-level document does not print 1436
    // lines and a second one prints none.
    evaluate(renderNode(nestedQuote(LEVELS), context(source)));

    expect(out.maxDepth).toBe(MAX_RENDER_DEPTH);
    // Every character still paints: the innermost paragraph's text survives
    // as the flattened content of the deepest node that was rendered.
    expect(out.text).toContain('echo');
    const depthWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes('nesting deeper than'),
    );
    expect(depthWarnings).toHaveLength(1);
  });

  it('renders a shallow quote structurally, marker bars and all', () => {
    // The cap must not change anything a real document does: three levels
    // still nest three levels deep and still reach the paragraph renderer.
    const out = evaluate(renderNode(nestedQuote(3), context('> > > echo\n')));

    // Three quotes, the paragraph inside them, and its text node: five
    // renderer invocations deep, nowhere near the cap.
    expect(out.maxDepth).toBe(5);
    expect(out.text).toBe('echo');
  });

  it('flattens a 20000-deep subtree without overflowing the stack', () => {
    // `textContentOf` is what the cap lands on, so it is called with exactly
    // the subtrees that were too deep to render. A recursive version of it
    // would overflow on the input the cap exists to survive.
    expect(textContentOf(nestedQuote(20_000) as AnyNode, '')).toBe('echo');
  });
});
