/**
 * The URL allowlist, applied at parse time.
 *
 * These two functions are the whole of the package's link/image safety story,
 * applied by `nativeEngine` as it builds each node. A substituted engine may
 * skip them, so `openUrl` in `view/renderers.tsx` re-applies them at
 * navigation; any other reader of `href` sees what the engine returned.
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
 * Scheme and authority match case-insensitively; the path does not.
 *
 * A prefix that reaches into a path names a scope root: the URL's path
 * segments past it are counted (one layer of percent-decoding, `\` as a
 * separator, query and fragment ignored) and a URL that climbs above the
 * prefix is refused. This is best-effort, not RFC 3986 normalization: a
 * doubly-encoded `%252e%252e` can still escape.
 */
export function isUrlAllowed(url: string, prefixes: readonly string[]): boolean {
  const folded = foldUrlCase(url);
  return prefixes.some((prefix) => {
    const foldedPrefix = foldUrlCase(prefix);
    if (!folded.startsWith(foldedPrefix)) return false;
    if (/^[^:]+:\/\/[^/?#]+$/.test(prefix)) {
      const next = folded[foldedPrefix.length];
      if (next !== undefined && !'/?#'.includes(next)) return false;
    }
    const remainder = url.slice(url.length - (folded.length - foldedPrefix.length));
    if (scopesPath(prefix) && !prefix.endsWith('/') && remainder !== '' && !'/#?'.includes(remainder[0])) {
      return false;
    }
    return !scopesPath(prefix) || !escapesScope(remainder);
  });
}

/**
 * Lowercases the scheme and any `//authority`, nothing after: RFC 3986 makes
 * only those case-insensitive.
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
 * `https://` and `mailto:` name no scope root; `https://cdn.e.com/` does,
 * the root of that authority.
 */
function scopesPath(prefix: string): boolean {
  const colon = prefix.indexOf(':');
  if (colon === -1) return prefix.includes('/');
  const rest = prefix.slice(colon + 1);
  return (rest.startsWith('//') ? rest.slice(2) : rest).includes('/');
}

/**
 * Refuses only on a negative depth: `a/../b` is a round trip inside the scope.
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
