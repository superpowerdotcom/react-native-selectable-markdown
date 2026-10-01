// Reads the barrels as source: importing the entry would load `react-native` at module scope.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const REPO = join(__dirname, '..');

interface Surface {
  names: Set<string>;
  /** The original name behind each export: `export { a as b }` records `a`. */
  bindings: Set<string>;
  /** `<module specifier>#<original name>`; local exports use `.` as the specifier. */
  origins: Set<string>;
  stars: string[];
}

function surfaceOf(relativePath: string): Surface {
  const fileName = join(REPO, relativePath);
  return surfaceOfText(fileName, readFileSync(fileName, 'utf8'));
}

function surfaceOfText(fileName: string, text: string): Surface {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2020,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
      if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) {
        stars.push(specifier);
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
          // `propertyName` is set only for `{ a as b }`, where it is `a`.
          const binding = (element.propertyName ?? element.name).text;
          bindings.add(binding);
          origins.add(`${specifier}#${binding}`);
        }
      }
      continue;
    }
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

describe('the surface reader sees each shape it polices', () => {
  it('records stars, aliases and local exports by their original binding', () => {
    const surface = surfaceOfText(
      'probe.ts',
      [
        "export * from './a';",
        "export * as ns from './b';",
        "export { internal as published, plain } from './c';",
        'export const local = 1;',
        'export interface Shape {}',
        'const hidden = 2;',
      ].join('\n'),
    );
    expect(surface.stars).toEqual(['./a', './b']);
    expect([...surface.names]).toEqual(['published', 'plain', 'local', 'Shape']);
    expect([...surface.bindings]).toEqual(['internal', 'plain', 'local', 'Shape']);
    expect([...surface.origins]).toEqual(['./c#internal', './c#plain', '.#local', '.#Shape']);
  });
});

describe('the package entry is an explicit list', () => {
  it('re-exports nothing with a star', () => {
    expect(entry.stars).toEqual([]);
  });

  it('publishes no `__`-prefixed internal', () => {
    expect([...entry.names].filter((n) => n.startsWith('__'))).toEqual([]);
    expect([...entry.bindings].filter((n) => n.startsWith('__'))).toEqual([]);
  });

  it.each([
    'decodeFlatBuffer',
    'NativeProtocolError',
    'applySmartPunctuation',
    'PROTOCOL_VERSION',
    'findHostBinding',
    'NativeHostBinding',
    'encodeSelectionActions',
    'decodeSelectionAction',
    'SELECTION_ACTION_SEPARATOR',
    'isBuiltInSelectionAction',
    'selectionActionId',
    'selectionActionTitle',
    'getOrCreateSession',
    'resolveSessionInit',
    'settleUnboundSession',
    'useSessionActivity',
    'embedContentFor',
    'isUriLikeLabel',
  ])('does not publish the internal %s', (name) => {
    expect(entry.names.has(name)).toBe(false);
    expect(
      [...entry.origins].filter((origin) => origin.endsWith(`#${name}`)),
    ).toEqual([]);
  });

  it.each([
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
    // `classifyBlock` is published as an alias, but no module may bind a function by that name.
    expect(entry.names.has('classifyTopLevelBlock')).toBe(true);
    expect(entry.names.has('ClassifyBlock')).toBe(true);
    expect(entry.names.has('classifyBlock')).toBe(true);
    expect(entry.bindings.has('classifyBlock')).toBe(false);
    expect(entry.origins.has('./selection/runs#classifyTopLevelBlock')).toBe(true);
  });
});

describe('the sub-barrels the entry feeds on are explicit too', () => {
  // The entry re-exports both, so a star in either is a star in the entry.
  it.each(['src/engine/native.ts', 'src/view/SelectableMarkdown.tsx'])(
    '%s re-exports nothing with a star',
    (path) => {
      expect(surfaceOf(path).stars).toEqual([]);
    },
  );

  it.each(['src/engine/native.ts', 'src/view/SelectableMarkdown.tsx'])(
    '%s renames nothing on the way out',
    (path) => {
      // A sub-barrel alias would reach the entry as its binding, hiding the original from the absence list.
      const surface = surfaceOf(path);
      expect(
        [...surface.origins].filter(
          (origin) => !surface.names.has(origin.slice(origin.indexOf('#') + 1)),
        ),
      ).toEqual([]);
    },
  );

  it('keeps the harness lever on the engine/native deep path', () => {
    // docs/NATIVE.md, the conformance runner and the benches import it from here.
    expect(surfaceOf('src/engine/native.ts').names.has('__linkNativeEngine')).toBe(
      true,
    );
  });
});

describe('the headless subpath entries are explicit too', () => {
  // These subpaths must load in plain Node, so they may not reach `react-native` through the view layer or the root.
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

  it.each([
    ['src/engine.ts', './engine/Engine'],
    ['src/stream.ts', './stream/StreamSession'],
  ])('%s reaches neither the view layer nor the root', (path, headless) => {
    const modules = [...surfaceOf(path).origins].map((origin) =>
      origin.slice(0, origin.indexOf('#')),
    );
    expect(modules).toContain(headless);
    expect(modules.filter((m) => m === './index' || m.startsWith('./view'))).toEqual([]);
  });
});
