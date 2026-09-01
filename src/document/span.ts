/**
 * A half-open range of UTF-16 code-unit offsets into the original markdown
 * source (`end` is exclusive). Every AST node carries one; selection, copy,
 * memoization identity, and incremental re-render all derive from spans.
 */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export function spanLength(s: SourceSpan): number {
  return s.end - s.start;
}

export function spanContains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function spanIntersects(a: SourceSpan, b: SourceSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

export function sliceSpan(source: string, s: SourceSpan): string {
  return source.slice(s.start, s.end);
}
