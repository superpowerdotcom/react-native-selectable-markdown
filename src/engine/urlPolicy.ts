/**
 * The URL allowlist, applied at parse time.
 *
 * These two functions are the whole of the package's link/image safety story,
 * and they live at the engine root because the decision is best made once,
 * inside the engine, before a `link` or `image` node exists. That is where
 * `nativeEngine` applies them — the decoder calls them as it builds each node
 * — which is what makes the shipped engine incapable of returning a rejected
 * `href`: by the time `parseDocument` returns, a blocked destination has
 * already degraded to text (or to a node flagged `blocked`), so a consumer
 * who writes their own `link` renderer, or who reads `href` off a node to
 * build a preview, cannot opt out of a policy they did not know was there.
 *
 * THAT IS A PROPERTY OF `nativeEngine`, NOT OF `parseDocument`. A substituted
 * engine is told that honouring `options.urlPolicy` is optional (see
 * `Engine.parse`), and nothing re-checks what it returns. So the view applies
 * these same two functions AGAIN at the navigation boundary — `openUrl` in
 * `view/renderers.tsx`, against the prefixes the document was parsed with —
 * not as an alternative to the parse-time pass but as the backstop for an
 * engine that skipped it. Everything else that reads a node's `href` (a
 * preview card, a link sheet, your own navigation) sees exactly what the
 * engine put there, which is why this module is re-exported from the package
 * entry: an engine author reuses it rather than reimplementing it.
 *
 * `sanitizeUrl` runs first and unconditionally, because the prefix check is
 * only as trustworthy as the string it sees: `java\nscript:alert(1)` does not
 * start with `javascript:`, but a URL loader that strips control characters
 * itself will happily run it. Removing them before the comparison means the
 * string the allowlist judged is the string that gets stored on the node.
 */

/** Remove C0 control characters and DEL before any prefix check. */
export function sanitizeUrl(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * True when `url` starts with one of the caller's allowed prefixes.
 *
 * Prefix matching rather than scheme parsing is deliberate: the allowed set is
 * consumer-configurable (`options.urlPolicy`), and prefixes let an app permit
 * `myapp://checkout/` without also permitting the rest of its own custom
 * scheme.
 *
 * CASE FOLDING STOPS AT THE PATH. Schemes and hosts are case-insensitive, so
 * `HTTPS://E.COM` must match a lowercase `https://` and an app that writes
 * `HTTPS://` in its own list must not thereby block every link it has — and
 * `JavaScript:` must not slip past a list written in lowercase. Paths are
 * *not* case-insensitive, on any server or in any deep-link router, so
 * lowercasing them too would make a prefix of `myapp://checkout/` admit
 * `myapp://checkout/../` variants spelled in whatever case defeats the check
 * below, and would silently widen every path-scoped prefix a consumer wrote.
 *
 * PATH SCOPING IS BEST-EFFORT, NOT A RESOLVER. A prefix that reaches past the
 * scheme into a hierarchical part (`myapp://checkout/`, `https://cdn.e.com/`)
 * is naming a *scope root*, and a bare `startsWith` gives none:
 * `myapp://checkout/../settings/wipe` starts with the prefix and walks
 * straight back out of it, and the un-normalized string is what reaches the
 * consumer's router, which will resolve the `..` even though this check did
 * not. So the remainder's segments are counted: each ordinary segment is a
 * level down, each `..` is a level up, and the URL is refused the moment the
 * count would go ABOVE the prefix. `myapp://checkout/../settings/wipe` is
 * refused; `https://cdn.e.com/a/../b.png` is not, because it comes back down
 * to a destination the prefix still covers. One layer of percent-decoding is
 * applied, and a backslash counts as a separator, because deep-link routers
 * on both platforms split on one. Only the PATH is counted — a `..` inside a
 * query string or a fragment is a parameter, not a segment, and refusing
 * those would silently kill deep links that carry a relative redirect.
 *
 * This is a guard, not RFC 3986 normalization: a doubly-encoded `%252e%252e`
 * or a router with its own idea of what a segment is can still escape a
 * scope, so treat a path-scoped prefix as narrowing the attack surface rather
 * than as a sandbox. Prefixes that stop at the scheme or authority
 * (`https://`, `mailto:`, the shipped defaults) name no scope root at all, so
 * they skip the count entirely and ordinary web links keep every `..` they
 * have, however many.
 */
export function isUrlAllowed(url: string, prefixes: readonly string[]): boolean {
  const folded = foldUrlCase(url);
  return prefixes.some((prefix) => {
    if (!folded.startsWith(foldUrlCase(prefix))) return false;
    return !scopesPath(prefix) || !escapesScope(url.slice(prefix.length));
  });
}

/**
 * Lowercase the scheme and, when present, the `//authority` — and nothing
 * after. The authority ends at the first `/`, `?` or `#`; a URL with no `//`
 * (`mailto:a@E.com`) has only its scheme folded, which is all RFC 3986 makes
 * case-insensitive there.
 */
function foldUrlCase(url: string): string {
  const colon = url.indexOf(':');
  if (colon === -1) return url.toLowerCase();
  if (url.slice(colon + 1, colon + 3) !== '//') {
    return url.slice(0, colon + 1).toLowerCase() + url.slice(colon + 1);
  }
  let end = colon + 3;
  while (end < url.length && !'/?#'.includes(url[end])) end += 1;
  return url.slice(0, end).toLowerCase() + url.slice(end);
}

/**
 * True when the prefix names a scope root — i.e. it reaches past `scheme:`
 * (and past a `//` authority, when there is one) into the hierarchical part.
 * `https://` and `mailto:` do not; `myapp://checkout/` and
 * `https://cdn.e.com/photos/` do. A prefix that merely ends in the
 * authority's delimiting slash (`https://cdn.e.com/`) DOES name a root — it
 * is the root of that authority — which is why `escapesScope` counts levels
 * instead of refusing every `..`: nothing under such a prefix should be
 * refused for descending and coming back.
 */
function scopesPath(prefix: string): boolean {
  const colon = prefix.indexOf(':');
  if (colon === -1) return prefix.includes('/');
  const rest = prefix.slice(colon + 1);
  return (rest.startsWith('//') ? rest.slice(2) : rest).includes('/');
}

/**
 * True when the remainder of a path-scoped URL climbs ABOVE its prefix.
 *
 * The remainder is cut at the first `?` or `#` — a query or a fragment is
 * not a path, and `myapp://checkout/x?next=/../y` names a destination inside
 * the scope whatever the parameter says — then percent-decoded one layer for
 * `.`, `/` and `\\` only, then walked segment by segment with a depth
 * counter. `..` pops a level, `.` and an empty segment are no-ops, anything
 * else pushes one. Refusing only on a NEGATIVE depth is the whole point:
 * `a/../b` is a round trip inside the scope and must stay allowed, while a
 * leading `../` is the escape the scope exists to refuse.
 */
function escapesScope(remainder: string): boolean {
  const cut = remainder.search(/[?#]/);
  const path = cut === -1 ? remainder : remainder.slice(0, cut);
  const decoded = path
    .replace(/%2e/gi, '.')
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '\\');
  let depth = 0;
  for (const segment of decoded.split(/[/\\]/)) {
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return true;
    } else if (segment !== '' && segment !== '.') {
      depth += 1;
    }
  }
  return false;
}
