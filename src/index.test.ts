/**
 * THE PACKAGE ENTRY'S EXPORT SURFACE, pinned.
 *
 * `src/index.ts` is a list of names rather than a stack of `export *` lines,
 * and the whole value of that is that adding a name is a deliberate edit. A
 * star anywhere in the chain gives it back: one `export * from './helper'`
 * republishes every helper that module happens to export, today and forever
 * after, and nothing in a diff of `helper.ts` looks like an API change.
 *
 * So this file reads the barrel — and the two sub-barrels that feed it — as
 * SOURCE, with the TypeScript parser rather than a regex, and asserts three
 * things: no star re-exports, no `__`-prefixed internals, and that the
 * specific symbols the last audit found leaking are still gone. It runs
 * statically on purpose: importing the entry would pull `react-native` in at
 * module scope (see the barrel's own header), which is exactly the thing that
 * makes the surface hard to test any other way.
 *
 * The positive list is a spot check, not a copy of the barrel: every name in
 * it is one the README or `docs/` tells a consumer to import, so a removal
 * that silently breaks a documented snippet fails here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const REPO = join(__dirname, '..');

interface Surface {
  /** Named re-exports and local exports, by name. */
  names: Set<string>;
  /**
   * The ORIGINAL binding behind each export, i.e. what the module it came
   * from calls it: `export { decodeFlatBuffer as decode } from './x'` records
   * `decodeFlatBuffer`, not `decode`.
   *
   * `names` alone cannot police the absence list. It records the EXPORTED
   * name, so aliasing an internal republishes the value under a name nobody
   * thought to add to the list, and every absence assertion below still
   * passes. The rule this set enforces is about the value, not the spelling:
   * `decodeFlatBuffer` is not part of the root's contract however it is
   * spelled there.
   */
  bindings: Set<string>;
  /** `<module specifier>#<original name>` for each re-export, for a failure
   * message that says where the leak came in. Local exports are keyed on
   * `.` — this file, no specifier. */
  origins: Set<string>;
  /** `export * from '...'` module specifiers, which must be empty. */
  stars: string[];
}

function surfaceOf(relativePath: string): Surface {
  const fileName = join(REPO, relativePath);
  const source = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.ES2020,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const bindings = new Set<string>();
  const origins = new Set<string>();
  const stars: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : '<unknown>';
      if (statement.exportClause === undefined) {
        // `export * from '...'` — no clause is what makes it a star.
        stars.push(specifier);
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
          // `propertyName` is set only when the export renames: in
          // `{ a as b }` it is `a` and `name` is `b`. Unaliased, the two are
          // the same string.
          const binding = (element.propertyName ?? element.name).text;
          bindings.add(binding);
          origins.add(`${specifier}#${binding}`);
        }
      }
      continue;
    }
    // Locally declared exports (`export interface`, `export const`, ...).
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) !== true
    ) {
      continue;
    }
    const local = (name: string): void => {
      names.add(name);
      // A local declaration cannot be aliased: it is published under the name
      // it is declared with, so binding and export name are the same.
      bindings.add(name);
      origins.add(`.#${name}`);
    };
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) local(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      local(statement.name.text);
    }
  }
  return { names, bindings, origins, stars };
}

const entry = surfaceOf('src/index.ts');

describe('the package entry is an explicit list', () => {
  it('re-exports nothing with a star', () => {
    expect(entry.stars).toEqual([]);
  });

  it('publishes no `__`-prefixed internal', () => {
    // `__linkNativeEngine` is the one that was reaching the root: a test
    // harness lever whose own doc says apps never call it. It is still
    // exported from `engine/native`, which is the deep path a harness uses.
    // Both spellings are checked: renaming it on the way out would keep it
    // out of `names` while republishing the same function.
    expect([...entry.names].filter((n) => n.startsWith('__'))).toEqual([]);
    expect([...entry.bindings].filter((n) => n.startsWith('__'))).toEqual([]);
  });

  it.each([
    // Decoder and wire-protocol internals.
    'decodeFlatBuffer',
    'NativeProtocolError',
    'applySmartPunctuation',
    'PROTOCOL_VERSION',
    'findHostBinding',
    'NativeHostBinding',
    // The selection menu's wire codec: `RunHost` packs the prop, consumers
    // never see the packed form.
    'encodeSelectionActions',
    'decodeSelectionAction',
    'SELECTION_ACTION_SEPARATOR',
    'isBuiltInSelectionAction',
    'selectionActionId',
    'selectionActionTitle',
    // Helpers exported only so a unit test could reach logic that otherwise
    // needs a React renderer or a segmentation pass.
    'getOrCreateSession',
    'resolveSessionInit',
    'settleUnboundSession',
    'useDeferredUnmount',
    'embedContentFor',
    'isUriLikeLabel',
  ])('does not publish the internal %s', (name) => {
    expect(entry.names.has(name)).toBe(false);
    // And not under another name either. This list is matched against the
    // ORIGINAL binding, so `export { decodeFlatBuffer as decode }` fails here
    // rather than slipping past a list that only ever knew export names. The
    // origin set makes the failure say which module it came back through.
    expect(
      [...entry.origins].filter((origin) => origin.endsWith(`#${name}`)),
    ).toEqual([]);
  });

  it.each([
    // README quick starts.
    'SelectableMarkdown',
    'StreamSession',
    'presets',
    'parseDocument',
    'visit',
    'installNativeEngine',
    'createSmoother',
    'createAdaptiveSmoother',
    'useAgUiSession',
    'useAgUiRunSessions',
    'bindRunTextEvents',
    'defaultRenderers',
    'mergeTheme',
    // Types the README and docs/ tell a consumer to import by name.
    'ClassifyBlock',
    'EmbedRenderer',
    'PartialTheme',
    'MarkAttribute',
    'RendererOverrides',
    'EngineOptions',
    'Engine',
    'ParsedDocument',
    'SourceSpan',
    'TextMessageEvents',
    // The seams docs/SELECTION.md and docs/ARCHITECTURE.md document.
    'segmentRuns',
    'projectRun',
    'mapSelectionToSource',
    'buildCopyPayload',
    'handleSelectionAction',
    'repairTail',
    'RunHost',
  ])('still publishes the documented %s', (name) => {
    expect(entry.names.has(name)).toBe(true);
  });

  it('separates the block classifier from the prop that overrides it', () => {
    // Three spellings of one idea used to sit at the root: the `classifyBlock`
    // PROP, its `ClassifyBlock` type, and a `classifyBlock` FUNCTION. The
    // function is `classifyTopLevelBlock` now. The old spelling survives at
    // the root only as a deprecated ALIAS of the new one, so a 0.11 caller
    // keeps compiling — but no module may call the function `classifyBlock`
    // any more: re-exporting it from one that still did would leave the
    // collision in place one file down, and the binding set is what sees
    // through the alias to catch that.
    expect(entry.names.has('classifyTopLevelBlock')).toBe(true);
    expect(entry.names.has('ClassifyBlock')).toBe(true);
    expect(entry.names.has('classifyBlock')).toBe(true);
    expect(entry.bindings.has('classifyBlock')).toBe(false);
    expect(entry.origins.has('./selection/runs#classifyTopLevelBlock')).toBe(true);
  });
});

describe('the sub-barrels the entry feeds on are explicit too', () => {
  // A star in either of these is a star in the entry by another route: both
  // are re-exported from it, so whatever they publish, it publishes.
  it.each(['src/engine/native.ts', 'src/view/SelectableMarkdown.tsx'])(
    '%s re-exports nothing with a star',
    (path) => {
      expect(surfaceOf(path).stars).toEqual([]);
    },
  );

  it.each(['src/engine/native.ts', 'src/view/SelectableMarkdown.tsx'])(
    '%s renames nothing on the way out',
    (path) => {
      // What makes the entry's binding names trustworthy. The entry records
      // the name the module it imports from uses; if a sub-barrel itself
      // aliased an internal, the entry would faithfully record the alias and
      // the absence list would still miss it. No renaming anywhere in the
      // chain means the binding really is the original.
      const surface = surfaceOf(path);
      expect(
        [...surface.origins].filter(
          (origin) => !surface.names.has(origin.slice(origin.indexOf('#') + 1)),
        ),
      ).toEqual([]);
    },
  );

  it('keeps the harness lever on the engine/native deep path', () => {
    // Dropping it from the root must not make it unreachable: docs/NATIVE.md
    // sends a Node consumer here for it, and the conformance runner and the
    // benches link their addon through it.
    expect(surfaceOf('src/engine/native.ts').names.has('__linkNativeEngine')).toBe(
      true,
    );
  });
});

describe('the headless subpath entries are explicit too', () => {
  // `react-native-selectable-markdown/engine` and `/stream` exist so plain
  // Node — a consumer's jest, a server-side script — can reach the parser and
  // the streaming layer without the root, which imports `react-native` at
  // load. Same rules as the entry: no stars, no renaming. Plus one of their
  // own: nothing from the view layer or the root, or the subpath would drag
  // `react-native` back in by another route and stop loading headless.
  const SUBPATHS = ['src/engine.ts', 'src/stream.ts'];

  it.each(SUBPATHS)('%s re-exports nothing with a star', (path) => {
    expect(surfaceOf(path).stars).toEqual([]);
  });

  it.each(SUBPATHS)('%s renames nothing on the way out', (path) => {
    const surface = surfaceOf(path);
    expect(
      [...surface.origins].filter(
        (origin) => !surface.names.has(origin.slice(origin.indexOf('#') + 1)),
      ),
    ).toEqual([]);
  });

  it.each(SUBPATHS)('%s reaches neither the view layer nor the root', (path) => {
    const modules = [...surfaceOf(path).origins].map((origin) =>
      origin.slice(0, origin.indexOf('#')),
    );
    expect(modules.filter((m) => m === './index' || m.startsWith('./view'))).toEqual([]);
  });
});
