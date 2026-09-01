/**
 * The URL allowlist, applied at parse time.
 *
 * These two functions are the whole of the package's link/image safety story,
 * and they live at the engine root because the decision has to be made once,
 * inside the engine, before a `link` or `image` node exists. The alternative —
 * letting a renderer check the scheme on the way to `Linking.openURL` — is the
 * failure this module prevents: a consumer who writes their own `link`
 * renderer, or who reads `href` off a node to build a preview, would be
 * opting out of the policy without knowing there was one. By the time
 * `parseDocument` returns, a blocked destination has already degraded to text
 * (or to a node flagged `blocked`), so there is no unsafe `href` to forget.
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
 * exactly `myapp://checkout/` without also permitting the rest of its own
 * custom scheme. Case-insensitive on both sides because schemes are, and
 * `JavaScript:` must not slip past a list written in lowercase.
 */
export function isUrlAllowed(url: string, prefixes: readonly string[]): boolean {
  const low = url.toLowerCase();
  return prefixes.some((p) => low.startsWith(p.toLowerCase()));
}
