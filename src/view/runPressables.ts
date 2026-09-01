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
}

/**
 * The tappable ranges of a projected run, in mark order.
 *
 * Links cannot nest in CommonMark, so the returned ranges never overlap —
 * a property the native hosts' hit tests get to rely on (the first
 * containing range is the only containing range).
 */
export function resolveRunPressables(projected: ProjectedRun): RunPressable[] {
  const out: RunPressable[] = [];
  for (const mark of projected.marks) {
    if (mark.kind !== 'link' && mark.kind !== 'blockedLink') continue;
    if (mark.href === undefined) continue;
    const pressable: RunPressable = {
      start: mark.start,
      end: mark.end,
      href: mark.href,
    };
    if (mark.kind === 'blockedLink') pressable.blocked = true;
    out.push(pressable);
  }
  return out;
}
