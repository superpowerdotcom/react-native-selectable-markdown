import { IS_DEV } from '../dev';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NativeModules, ScrollView, Text, View } from 'react-native';
import type { AnyNode, CodeBlockNode } from '../document/nodes';
import type { SourceSpan } from '../document/span';
import type { EmbedClaimContext } from '../selection/runs';
import type { RenderContext } from './renderers';
import { codeTextStyle, scaling } from './renderers';
import type { EmbedRenderer, EmbedSpec } from './SelectableMarkdown';

/**
 * `SelectableMarkdown`'s `codeBlocks` prop. `'text'` (default) draws a code
 * block inside its run's text. `'card'` overlays a top-level closed block with
 * a card: language label, Copy button, and code that scrolls sideways
 * instead of wrapping. A sweep across the card still copies its fenced
 * source; the code inside is its own selection.
 */
export type CodeBlockMode = 'text' | 'card';

/** The object form of `codeBlocks`. */
export interface CodeBlockOptions {
  /** Default 'card'. */
  mode?: CodeBlockMode;
  /** Default 'Copy'. */
  copyLabel?: string;
  /** Shown for a moment after a copy. Default 'Copied'. */
  copiedLabel?: string;
}

/** What `onCodeCopy` hears when a card's Copy button is pressed. */
export interface CodeCopyEvent {
  /** The block's code, without its fences or trailing newline. */
  code: string;
  language?: string;
  /** The whole block in the source, fences included. */
  span: SourceSpan;
}

/** What a card reads off `RenderContext.codeCard`. */
export interface CodeCardContext {
  copyLabel: string;
  copiedLabel: string;
  onCodeCopy?: (event: CodeCopyEvent) => void;
}

const COPIED_MS = 1500;

/**
 * Claims each top-level closed code block as a full-width card, after any
 * claim `embed` makes. The width and height resolve in `SelectableMarkdown`.
 */
export function withCodeBlockCards(embed: EmbedRenderer | undefined): EmbedRenderer {
  return (node: AnyNode, context: EmbedClaimContext): EmbedSpec | undefined => {
    const claimed = embed?.(node, context);
    if (claimed !== undefined) return claimed;
    if (node.kind !== 'codeBlock' || !node.closed || !context.topLevel) return undefined;
    return { width: 'container', height: 'auto', estimatedHeight: estimateHeight(node), render: renderCodeCard, text: codeOf(node) };
  };
}

function codeOf(node: CodeBlockNode): string {
  return node.literal.endsWith('\n') ? node.literal.slice(0, -1) : node.literal;
}

/** Header plus one line per source line at 18pt, so the measured height rarely moves much. */
function estimateHeight(node: CodeBlockNode): number {
  const lines = codeOf(node).split('\n').length;
  return 40 + lines * 18;
}

function renderCodeCard(node: AnyNode, ctx: RenderContext): ReactNode {
  return node.kind === 'codeBlock' ? <CodeCard ctx={ctx} node={node} /> : null;
}

function CodeCard(props: { node: CodeBlockNode; ctx: RenderContext }): ReactNode {
  const { node, ctx } = props;
  const { theme } = ctx;
  const card = ctx.codeCard;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const code = codeOf(node);
  const onPress = (): void => {
    const event: CodeCopyEvent = { code, span: node.span };
    if (node.language !== undefined && node.language !== '') event.language = node.language;
    if (copyCode(event, card?.onCodeCopy)) setCopied(true);
  };
  const label = { color: theme.colors.muted, fontFamily: theme.fonts.body, fontSize: theme.code.fontSize - 1.5 };
  return (
    <View style={{ backgroundColor: theme.colors.codeBackground, borderRadius: theme.code.borderRadius }}>
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingHorizontal: theme.spacing.codePadding,
          paddingTop: theme.code.paddingVertical,
        }}
      >
        <Text {...scaling(ctx)} style={label}>
          {node.language ?? ''}
        </Text>
        <Text {...scaling(ctx)} accessibilityRole="button" onPress={onPress} style={label}>
          {copied ? (card?.copiedLabel ?? 'Copied') : (card?.copyLabel ?? 'Copy')}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing.codePadding, paddingVertical: theme.code.paddingVertical }}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <Text {...scaling(ctx)} selectable={ctx.selectable ?? true} style={codeTextStyle(theme)}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

let warnedNoClipboard = false;

/** The app's handler, else the native module's clipboard write. */
function copyCode(event: CodeCopyEvent, onCodeCopy?: (event: CodeCopyEvent) => void): boolean {
  if (onCodeCopy !== undefined) {
    onCodeCopy(event);
    return true;
  }
  const module = (NativeModules as Record<string, { copyText?: (text: string) => void } | undefined> | undefined)
    ?.SelectableMarkdown;
  if (typeof module?.copyText === 'function') {
    module.copyText(event.code);
    return true;
  }
  if (IS_DEV && !warnedNoClipboard) {
    warnedNoClipboard = true;
    console.warn(
      '[react-native-selectable-markdown] the code card cannot copy: this binary has no ' +
        'SelectableMarkdown.copyText (rebuild the app) and no onCodeCopy was given.',
    );
  }
  return false;
}
