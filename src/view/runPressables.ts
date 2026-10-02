import type { ProjectedRun } from '../selection/mapSelection';

/**
 * One tappable range of a projected run: the display range of a live link,
 * plus the URL it activates.
 *
 * WHY THIS EXISTS. The native selection host renders the whole run as one
 * platform text view, so the JS fallback's per-node `onPress` (the `link`
 * renderer in renderers.tsx) has nothing to attach to there — which is how
 * linking the native module used to turn every link into styled but inert
 * text. The host cannot own the press semantics itself: it never sees
 * markdown, only projected text (docs/SELECTION.md), and that boundary is
 * deliberate. So JS sends it the *ranges* that are tappable, the host
 * hit-tests taps against them, and the press comes back as an `onInlinePress`
 * event that JS resolves to this list — the URL never crosses the bridge.
 *
 * Derived from `ProjectedRun.marks` rather than re-walked from the AST so it
 * cannot disagree with what the run visibly styles: the ranges here are
 * exactly the 'link' and 'blockedLink' marks `runAttributes` styles, and a
 * still-streaming link is neither (the `link` case in mapSelection.ts leaves
 * it unmarked, so it gets no press either, by construction).
 *
 * Blocked links are included and flagged. They are not navigable — see
 * `blocked` below — but they must be reachable, because the alternative was
 * the one this library shipped with: a consumer whose blocked schemes carry
 * meaning had to keep every block containing one out of native runs, and paid
 * for it in selection.
 */
export interface RunPressable {
  /** UTF-16 offsets into `ProjectedRun.text`, end-exclusive. */
  start: number;
  end: number;
  /** The URL this range refers to. */
  href: string;
  /**
   * True when the URL policy rejected this href (mark kind 'blockedLink').
   *
   * The range is still reported, because a blocked scheme is very often an
   * identifier the consumer routes itself — a citation marker, a product
   * reference — and the alternative was the consumer refusing native runs
   * altogether to keep such things alive. But it is NOT navigable: the default
   * press behaviour skips it entirely, and only a consumer-supplied
   * `onLinkPress` ever sees it.
   */
  blocked?: true;
  /** Announced instead of the range's text. */
  accessibilityLabel?: string;
  /** Default 'link'. 'text' stays tappable but is read as part of the prose. */
  accessibilityRole?: 'link' | 'button' | 'text';
  /** Fill painted behind the range (or its chip) while a touch is down on it. */
  pressedColor?: string;
  pressedRadius?: number;
  /** Points added on every side of the tap target; selection is unaffected. */
  hitSlop?: number;
}

/**
 * The tappable ranges of a projected run, in mark order, non-overlapping: both
 * hosts' hit tests take the first containing range. A mark starting inside a
 * kept range is dropped, so on an identical range the inner autolink of
 * `[<https://a.com>](https://b.com)` wins, and with any outer text the outer link does.
 */
export function resolveRunPressables(projected: ProjectedRun): RunPressable[] {
  const out: RunPressable[] = [];
  let coveredUntil = -1;
  for (const mark of projected.marks) {
    if (mark.kind !== 'link' && mark.kind !== 'blockedLink') continue;
    if (mark.href === undefined) continue;
    if (mark.start < coveredUntil) continue;
    const pressable: RunPressable = {
      start: mark.start,
      end: mark.end,
      href: mark.href,
    };
    if (mark.kind === 'blockedLink') pressable.blocked = true;
    out.push(pressable);
    if (mark.end > coveredUntil) coveredUntil = mark.end;
  }
  return out;
}
