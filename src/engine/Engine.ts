import type { ParsedDocument } from '../document/nodes';
import { applySpoilers } from './extensions/spoilers';
// Type-only, and that is load-bearing: `native/index.ts` imports `Engine` from
// this file, so the two modules form an import cycle. It is benign in exactly
// one direction — native/index.ts's import is `import type`, which the
// compiler erases, so at runtime only this file's edge exists and there is no
// order in which `nativeEngine` is read before it is initialized. Turning that
// import into a value import (say, to reach `parseDocument` from there) would
// make the cycle real and the failure would be a `undefined is not an object`
// at module-evaluation time, in whichever module the bundler happened to load
// second.
import { nativeEngine } from './native/index';
import type { EngineOptions, ResolvedEngineOptions } from './options';
import { resolveOptions } from './options';

/**
 * The parser seam.
 *
 * An engine is a pure function from source text to a span-carrying
 * `ParsedDocument`: every node it returns must carry a `SourceSpan` whose
 * `[start, end)` are UTF-16 offsets into the exact `source` string it was
 * handed. That single requirement is what the rest of the package is built
 * on — streaming splices shift spans, selection maps device coordinates back
 * through them, and copy reconstructs markdown by slicing the source with
 * them — so an engine that returns plausible-looking nodes with wrong spans
 * breaks selection rather than rendering.
 *
 * Implement this to bring your own parser. The default is the md4c-backed
 * native engine, but nothing in the package reaches for it except through
 * this interface.
 */
export interface Engine {
  readonly name: string;
  parse(source: string, options: ResolvedEngineOptions): ParsedDocument;
}

/**
 * Parse markdown into a span-carrying document.
 *
 * With no `engine` argument this uses `nativeEngine`, the md4c-backed parser,
 * which requires the package's native module to be linked into the JS context
 * (a rebuilt app on device; `node scripts/build-node-addon.mjs` in Node). When
 * it is not, the engine throws an actionable error rather than degrading — the
 * package has no JavaScript parser to fall back to, and a silent empty
 * document would be worse than a message naming the missing build step.
 *
 * The `engine` argument is the supported way to substitute a different parser:
 * pass anything satisfying `Engine` and it is used verbatim, with no
 * validation or normalization pass over what it returns. Whatever the engine
 * produces IS the document.
 *
 * That includes `options.urlPolicy`, which is not re-applied here: only the
 * view re-checks an href, at press time. `sanitizeUrl` and `isUrlAllowed` let
 * a substituted engine apply the same rule.
 *
 * Extensions run *after* the engine, on whichever document came back, so an
 * opt-in transform behaves the same no matter who parsed. Right now that is
 * the spoiler transform, and it runs only when the consumer set
 * `extensions.spoilers`.
 */
export function parseDocument(
  source: string,
  options?: EngineOptions,
  engine?: Engine,
): ParsedDocument {
  const resolved = resolveOptions(options);
  const doc = (engine ?? nativeEngine).parse(source, resolved);
  return resolved.extensions.spoilers ? applySpoilers(doc) : doc;
}
