import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const checkoutRoot = path.resolve(__dirname, '..');
const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-packaging-'));
for (const entry of ['src', 'scripts', '.github', 'native', 'platform', 'android', 'package.json',
  'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.esm.json', 'CHANGELOG.md']) {
  fs.cpSync(path.join(checkoutRoot, entry), path.join(repoRoot, entry), { recursive: true });
}
fs.symlinkSync(path.join(checkoutRoot, 'node_modules'), path.join(repoRoot, 'node_modules'), 'dir');
const built = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (built.status !== 0) throw new Error(built.stdout + built.stderr);
afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
const scriptsDir = path.join(repoRoot, 'scripts');
const ciWorkflow = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const releaseWorkflow = path.join(repoRoot, '.github', 'workflows', 'release.yml');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

const run = (command: string, args: readonly string[], cwd = repoRoot): Ran => {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const runNode = (args: readonly string[], cwd?: string): Ran => run(process.execPath, args, cwd);

const scratch = (label: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `rnsm-${label}-`));

describe('emit-dist-spec-shim emits a declaration beside the shim', () => {
  const shim = path.join(repoRoot, 'dist', 'view', 'SelectableRunHostNativeComponent.js');
  const declaration = shim.replace(/\.js$/, '.d.ts');

  let emitted: Ran;
  beforeAll(() => {
    // The build already ran the script; removing its output proves this run wrote it.
    for (const file of [shim, declaration]) fs.rmSync(file, { force: true });
    emitted = runNode([path.join(scriptsDir, 'emit-dist-spec-shim.mjs')]);
    expect(emitted.status).toBe(0);
  });

  it('writes both files', () => {
    expect(emitted.stdout).toBe(
      '[emit-dist-spec-shim] wrote dist/view/SelectableRunHostNativeComponent.js, ' +
        'dist/view/SelectableRunHostNativeComponent.d.ts, ' +
        'dist/esm/view/SelectableRunHostNativeComponent.js, ' +
        'dist/esm/view/SelectableRunHostNativeComponent.d.ts\n',
    );
    expect(fs.existsSync(shim)).toBe(true);
    expect(fs.readFileSync(declaration, 'utf8')).toContain(
      "export type { NativeProps } from '../../src/view/SelectableRunHostNativeComponent';",
    );
  });

  it('re-exports the prop contract from the untranspiled spec rather than copying it', () => {
    const text = fs.readFileSync(declaration, 'utf8');
    const reference = text.match(/export type \{ NativeProps \} from '([^']+)'/);
    expect(reference).not.toBeNull();

    const resolved = path.resolve(path.dirname(declaration), `${reference![1]}.ts`);
    expect(fs.existsSync(resolved)).toBe(true);
    expect(fs.readFileSync(resolved, 'utf8')).toContain('export interface NativeProps');
  });

  it('declares no runtime value, because the module beside it exports none', () => {
    const text = fs.readFileSync(declaration, 'utf8');
    expect(fs.readFileSync(shim, 'utf8')).toContain('module.exports = {}');
    expect(text).not.toMatch(/export default/);

    // verify-pack reports any spec-named dist file mentioning this call as a codegen leak.
    expect(text).not.toContain('codegenNativeComponent');
  });
});

describe('check-lock-sync compares content, not key order', () => {
  const manifestPath = path.join(repoRoot, 'package.json');
  const check = path.join(scriptsDir, 'check-lock-sync.mjs');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  const lockWith = (root: Record<string, unknown>): string => {
    const dir = scratch('lock-sync');
    const file = path.join(dir, 'package-lock.json');
    fs.writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: { '': root } }, null, 2));
    return file;
  };

  const reversed = (value: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(value).reverse());

  it('passes on this repository, which is what the release preflight runs', () => {
    const ran = runNode([check]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('[check-lock-sync] package-lock.json root entry matches package.json.\n');
  });

  it('passes when the lock lists the same dependencies in a different order', () => {
    const lock = lockWith({
      // Everything npm writes for this manifest, so only key order varies.
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      peerDependencies: reversed(manifest.peerDependencies as Record<string, string>),
      devDependencies: reversed(manifest.devDependencies as Record<string, string>),
    });

    const ran = runNode([check, manifestPath, lock]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('[check-lock-sync] package-lock.json root entry matches package.json.\n');
  });

  it('fails on a drifted range and names the key that moved', () => {
    const lock = lockWith({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      peerDependencies: {
        ...(manifest.peerDependencies as Record<string, string>),
        'react-native': '>=0.73',
      },
      devDependencies: manifest.devDependencies,
    });

    const ran = runNode([check, manifestPath, lock]);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('peerDependencies');
    expect(ran.stderr).toContain('react-native');
    expect(ran.stderr).toContain('npm install --package-lock-only');
  });

  it('treats an empty block and a missing one as the same statement', () => {
    const dir = scratch('lock-sync-empty-block');
    const manifestFile = path.join(dir, 'package.json');
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, dependencies: {}, peerDependenciesMeta: {} }, null, 2),
    );
    const lock = lockWith({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      peerDependencies: manifest.peerDependencies,
      devDependencies: manifest.devDependencies,
    });

    const ran = runNode([check, manifestFile, lock]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('[check-lock-sync] package-lock.json root entry matches package.json.\n');
  });

  it('compares the identity fields npm copies, not only the dependency blocks', () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['name', { ...manifest, name: 'renamed-package' }],
      ['license', { ...manifest, license: 'Apache-2.0' }],
      ['engines', { ...manifest, engines: { node: '>=20' } }],
      ['bin', { ...manifest, bin: { rnsm: './cli.js' } }],
      ['optionalDependencies', { ...manifest, optionalDependencies: { chalk: '^5' } }],
      [
        'peerDependenciesMeta',
        { ...manifest, peerDependenciesMeta: { react: { optional: true } } },
      ],
    ];

    const lock = lockWith({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      peerDependencies: manifest.peerDependencies,
      devDependencies: manifest.devDependencies,
    });

    for (const [field, drifted] of cases) {
      const dir = scratch(`lock-sync-${field}`);
      const manifestFile = path.join(dir, 'package.json');
      fs.writeFileSync(manifestFile, JSON.stringify(drifted, null, 2));

      const ran = runNode([check, manifestFile, lock]);
      expect(`${field}: ${ran.status}`).toBe(`${field}: 1`);
      expect(ran.stderr).toContain(field);
      expect(ran.stderr).toContain('npm install --package-lock-only');
    }
  });

  it('fails a lockfile with no root entry rather than comparing nothing', () => {
    const dir = scratch('lock-sync-empty');
    const file = path.join(dir, 'package-lock.json');
    fs.writeFileSync(file, JSON.stringify({ lockfileVersion: 1 }));

    const ran = runNode([check, manifestPath, file]);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('packages[""]');
  });
});

describe('the workflows enumerate every engine source', () => {
  const workflow = fs.readFileSync(ciWorkflow, 'utf8');
  const lines = workflow.split('\n').map((line) => line.trim());

  /** The shell of each `run: |` block that ends in `check:fabric-cpp --syntax-only`. */
  const engineStepsOf = (file: string): string[] => {
    const all = fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim());
    const steps: string[] = [];
    all.forEach((line, i) => {
      if (!line.startsWith('npm run check:fabric-cpp -- --syntax-only')) return;
      const open = all.lastIndexOf('run: |', i);
      steps.push(all.slice(open + 1, i + 1).filter((l) => !l.startsWith('#')).join('\n'));
    });
    return steps;
  };

  it('hands the checker sources in subdirectories and skips vendor/, in both workflows', () => {
    // Runs each step as written against a fixture tree, with `npm` stubbed to echo its arguments.
    const dir = scratch('cpp-enumeration');
    for (const relative of [
      'platform/cpp/FlatBuffer.cpp',
      'platform/cpp/sub/Nested.cpp',
      'platform/cpp/vendor/md4c/md4c.c',
      'platform/cpp/vendor/md4c/Vendored.cpp',
    ]) {
      fs.mkdirSync(path.join(dir, path.dirname(relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), '');
    }

    const invocations = [ciWorkflow, releaseWorkflow].map((file) =>
      engineStepsOf(file).map((step) => {
        const ran = run('bash', ['-e', '-c', `export RUNNER_OS=macOS\nnpm() { echo "npm $*"; }\n${step}`], dir);
        expect(ran.status).toBe(0);
        return ran.stdout.trim().split('\n').pop();
      }),
    );
    const files = 'platform/cpp/FlatBuffer.cpp platform/cpp/sub/Nested.cpp';
    expect(invocations).toEqual([
      [`npm run check:fabric-cpp -- --syntax-only --platform ios ${files}`],
      [
        `npm run check:fabric-cpp -- --syntax-only --platform ios ${files}`,
        `npm run check:fabric-cpp -- --syntax-only --platform android ${files}`,
      ],
    ]);
  });

  it('fails the step when the enumeration comes back empty', () => {
    const dir = scratch('cpp-enumeration-empty');
    fs.mkdirSync(path.join(dir, 'platform', 'cpp'), { recursive: true });
    const start = lines.findIndex((line) => line.startsWith('files=$(find platform/cpp'));
    // Through the closing `fi`, so the slice is a complete shell fragment.
    const end = lines.indexOf('fi', start);
    expect(end).toBeGreaterThan(start);
    const script = lines.slice(start, end + 1).join('\n');

    const ran = run('bash', ['-c', script], dir);
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain('compiled nothing');
  });
});

describe('the release guard refuses a BREAKING change under a tagged version', () => {
  const guard = path.join(scriptsDir, 'check-unreleased-breaking.mjs');

  const fixture = (unreleased: string, version: string): readonly string[] => {
    const dir = scratch('release-guard');
    const changelog = path.join(dir, 'CHANGELOG.md');
    const manifest = path.join(dir, 'package.json');
    fs.writeFileSync(
      changelog,
      `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n\n## [0.9.0] — 2026-01-01\n\n- first\n`,
    );
    fs.writeFileSync(manifest, JSON.stringify({ name: 'fixture', version }, null, 2));
    return [guard, '--no-git', '--changelog', changelog, '--manifest', manifest];
  };

  it('fails when the pending break would ship under the version already tagged', () => {
    const ran = runNode([...fixture('- **BREAKING — the root export list.**', '0.11.0'), '--tag', 'v0.11.0']);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('still 0.11.0');
    // Pre-1.0, this repository lands breaking changes in a minor.
    expect(ran.stderr).toContain('0.12.0');
  });

  it('passes once the version has moved past that tag', () => {
    const ran = runNode([...fixture('- **BREAKING — the root export list.**', '0.12.0'), '--tag', 'v0.11.0']);

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('past the latest tag v0.11.0');
  });

  it('says nothing about an Unreleased section with no break in it', () => {
    const ran = runNode([...fixture('- Streaming: a faster tail repair.', '0.11.0'), '--tag', 'v0.11.0']);

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('names no BREAKING change');
  });

  it('passes when nothing has been released yet', () => {
    const ran = runNode(fixture('- **BREAKING — everything.**', '0.11.0'));

    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('no v* tag exists');
  });

  it('reads the older tag correctly when several exist, in any order', () => {
    const flags = fixture('- **BREAKING — the root export list.**', '0.11.0');
    const ran = runNode([...flags, '--tag', 'v0.11.0', '--tag', 'v0.9.0', '--tag', 'v0.10.0']);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('v0.11.0');
  });

  it('is the verdict this repository actually gets, on its own files', () => {
    // An equivalence, so it holds as entries move; without a changelog the guard refuses.
    const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
    const version = (JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string }).version;
    const tags = run('git', ['tag', '--list', 'v*'], checkoutRoot).stdout.split('\n').map((t) => t.trim());

    let shouldFail = true;
    if (fs.existsSync(changelogPath)) {
      const changelog = fs.readFileSync(changelogPath, 'utf8');
      const start = changelog.indexOf('## [Unreleased]');
      const next = start === -1 ? -1 : changelog.indexOf('\n## ', start + 1);
      const unreleased = start === -1 ? '' : changelog.slice(start, next === -1 ? undefined : next);
      shouldFail = /^\s*[-*]\s+(?:\*\*)?BREAKING\b/im.test(unreleased) && tags.includes(`v${version}`);
    }

    const ran = runNode([path.join(checkoutRoot, 'scripts', 'check-unreleased-breaking.mjs')], checkoutRoot);
    expect(ran.status).toBe(shouldFail ? 1 : 0);
    if (!fs.existsSync(changelogPath)) expect(ran.stderr).toContain('does not exist');
  });
});

describe('the package ships an ES module build beside the CommonJS one', () => {
  const esmDir = path.join(repoRoot, 'dist', 'esm');
  const describeBuilt = fs.existsSync(path.join(esmDir, 'index.js')) ? describe : describe.skip;

  /** Resolves each specifier by self-reference through `exports`, relative to the package. */
  const resolvedBy = (
    via: 'require' | 'import',
    specifiers: readonly string[],
    conditions: readonly string[] = [],
  ): string[] => {
    const resolve =
      via === 'require'
        ? 'require.resolve(s)'
        : "require('node:url').fileURLToPath(import.meta.resolve(s))";
    const probe =
      "const { realpathSync } = require('node:fs'); const { relative } = require('node:path');" +
      `const root = realpathSync(process.cwd()); const specifiers = ${JSON.stringify(specifiers)};` +
      `console.log(JSON.stringify(specifiers.map((s) => relative(root, ${resolve}))));`;
    const flags = [
      ...conditions.map((c) => `--conditions=${c}`),
      ...(via === 'import'
        ? ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${probe}`]
        : ['-e', probe]),
    ];
    const ran = runNode(flags, repoRoot);
    expect(ran.stderr).toBe('');
    return JSON.parse(ran.stdout) as string[];
  };

  it('serves the root to both conditions, and keeps Metro on src/', () => {
    // `react-native` must win over both, or Metro stops reading the untranspiled codegen spec.
    const name = 'react-native-selectable-markdown';
    const specifiers = [name, `${name}/dist`, `${name}/dist/engine/Engine`, `${name}/dist/engine/Engine.js`];
    expect(resolvedBy('require', specifiers)).toEqual([
      'dist/index.js',
      'dist/index.js',
      'dist/engine/Engine.js',
      'dist/engine/Engine.js',
    ]);
    expect(resolvedBy('import', specifiers)).toEqual([
      'dist/esm/index.js',
      'dist/esm/index.js',
      'dist/esm/engine/Engine.js',
      'dist/esm/engine/Engine.js',
    ]);
    expect(resolvedBy('require', [name], ['react-native'])).toEqual(['src/index.ts']);
  });

  it('serves the headless subpaths with the same three conditions as the root', () => {
    const specifiers = ['react-native-selectable-markdown/engine', 'react-native-selectable-markdown/stream'];
    expect(resolvedBy('require', specifiers)).toEqual(['dist/engine.js', 'dist/stream.js']);
    expect(resolvedBy('import', specifiers)).toEqual(['dist/esm/engine.js', 'dist/esm/stream.js']);
    expect(resolvedBy('require', specifiers, ['react-native'])).toEqual(['src/engine.ts', 'src/stream.ts']);
  });

  it('ships the Node addon loader and what a consumer needs to build it', () => {
    expect(resolvedBy('import', ['react-native-selectable-markdown/node'])).toEqual([
      'native/node/index.mjs',
    ]);
    const packed = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
    expect(packed.status).toBe(0);
    // npm 10 runs `prepare` despite --ignore-scripts, so build logs can precede the JSON.
    const json = packed.stdout.slice(packed.stdout.search(/^\[\s*$/m));
    const shipped = (JSON.parse(json) as { files: { path: string }[] }[])[0].files.map(
      (file) => file.path,
    );
    expect(shipped).toEqual(expect.arrayContaining(['native/node/index.mjs', 'scripts/build-node-addon.mjs']));
  });

  describeBuilt('as built', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|d\.ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk(esmDir);

    it('scopes dist/esm to ES modules and repeats the sideEffects hint there', () => {
      // Asserted on the file: Node 22.7+ detects module syntax, so an import would pass anyway.
      const marker = JSON.parse(fs.readFileSync(path.join(esmDir, 'package.json'), 'utf8'));
      expect(marker.type).toBe('module');
      expect(marker.sideEffects).toBe(false);
    });

    it('gives every relative specifier the extension an ESM resolver needs', () => {
      const offenders: string[] = [];
      for (const file of files) {
        for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
          const match = /^\s*(?:import|export)\b[^\n]*?(?:\bfrom\s+)?(['"])(\.[^'"]*)\1\s*;?\s*$/.exec(
            line,
          );
          if (!match || match[2].endsWith('.js') || match[2].endsWith('.json')) continue;
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1} ${match[2]}`);
        }
      }
      expect(offenders).toEqual([]);
      // tsc emitted this line without `.js`, so the rewrite ran.
      expect(fs.readFileSync(path.join(esmDir, 'engine.js'), 'utf8')).toContain(
        "export { parseDocument } from './engine/Engine.js';",
      );
    });

    it('serves each condition its own tree, by bare specifier', () => {
      // Through a node_modules link, as a consumer resolves; ESM needs a child process.
      const consumer = scratch('dual-conditions');
      fs.mkdirSync(path.join(consumer, 'node_modules'), { recursive: true });
      fs.symlinkSync(repoRoot, path.join(consumer, 'node_modules', 'react-native-selectable-markdown'), 'dir');
      const probe = path.join(consumer, 'probe.mjs');
      fs.writeFileSync(
        probe,
        [
          "const name = 'react-native-selectable-markdown';",
          "const paths = [name, `${name}/dist`, `${name}/dist/engine/Engine`, `${name}/dist/selection/runs.js`];",
          'const out = {};',
          'for (const p of paths) out[p] = import.meta.resolve(p);',
          "await import(`${name}/dist/engine/Engine`);",
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n'),
      );

      const ran = runNode([probe], consumer);
      expect(ran.stderr).toBe('');
      const resolved = JSON.parse(ran.stdout) as Record<string, string>;
      for (const [specifier, target] of Object.entries(resolved)) {
        expect(`${specifier} -> ${target.includes('/dist/esm/')}`).toBe(`${specifier} -> true`);
      }

      const cjs = path.join(consumer, 'probe.cjs');
      fs.writeFileSync(
        cjs,
        [
          "const name = 'react-native-selectable-markdown';",
          "const paths = [name, `${name}/dist`, `${name}/dist/engine/Engine`, `${name}/dist/selection/runs.js`];",
          'const out = {};',
          'for (const p of paths) out[p] = require.resolve(p);',
          "if (typeof require(`${name}/dist/engine/Engine`).parseDocument !== 'function') throw new Error('no parseDocument');",
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n'),
      );

      const ranCjs = runNode([cjs], consumer);
      expect(ranCjs.stderr).toBe('');
      const required = JSON.parse(ranCjs.stdout) as Record<string, string>;
      for (const [specifier, target] of Object.entries(required)) {
        expect(`${specifier} -> ${target.includes('/dist/esm/')}`).toBe(`${specifier} -> false`);
      }
    });
  });
});

describe("release.yml's release-notes step cannot publish empty notes", () => {
  // Runs the step as release.yml spells it: without pipefail, tee's status hides a failed extract.
  const workflow = fs.readFileSync(releaseWorkflow, 'utf8').split('\n');
  const named = workflow.findIndex((line) => line.includes('Extract the release notes for this tag'));
  const body: string[] = [];
  for (const line of workflow.slice(named + 2)) {
    if (!line.startsWith('          ')) break;
    body.push(line.trim());
  }
  const step = body.join('\n');

  const runStep = (tag: string): { ran: Ran; notes: string } => {
    const dir = scratch('release-notes');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(
      path.join(scriptsDir, 'changelog-section.mjs'),
      path.join(dir, 'scripts', 'changelog-section.mjs'),
    );
    fs.writeFileSync(
      path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] — 2026-01-01\n\n- first\n',
    );
    const ran = run('bash', ['-e', '-c', `export GITHUB_REF_NAME=${tag} RUNNER_TEMP=${JSON.stringify(dir)}\n${step}`], dir);
    return { ran, notes: fs.readFileSync(path.join(dir, 'release-notes.md'), 'utf8') };
  };

  it('writes the tagged section and passes', () => {
    const { ran, notes } = runStep('v0.9.0');
    expect(ran.status).toBe(0);
    expect(notes).toBe('- first\n');
  });

  it('fails the step when the changelog section is missing', () => {
    const { ran, notes } = runStep('v99.99.99');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('CHANGELOG.md has no section for 99.99.99.');
    expect(notes).toBe('');
  });
});

describe('consumer resolution', () => {
  test.each([[[]], [['react-native']]])('type-checks strict consumers under conditions %j', (customConditions) => {
    const file = path.join(repoRoot, 'strict-consumer.ts');
    const entries = ['', '/engine', '/stream', '/dist/engine/native', '/dist/agui/useAgUiSession', '/dist/selection/runs', '/dist/stream/repair'];
    fs.writeFileSync(file, entries.map((suffix, i) =>
      `import * as api${i} from 'react-native-selectable-markdown${suffix}'; void api${i};`,
    ).join('\n'));
    const options: ts.CompilerOptions = {
      noEmit: true, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      customConditions,
    };
    for (const suffix of entries) {
      const resolved = ts.resolveModuleName('react-native-selectable-markdown' + suffix, file, options, ts.sys).resolvedModule;
      expect(resolved?.resolvedFileName).toContain('/dist/');
      expect(resolved?.resolvedFileName).toMatch(/\.d\.ts$/);
    }
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options));
    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    fs.rmSync(file);
  });

  test('RN deep entries share source modules with the root, including JSX files', () => {
    const entries = ['engine/native', 'selection/runs', 'agui/useAgUiSession', 'stream/repair', 'view/RunHost'];
    const probe = `for (const path of ${JSON.stringify(entries)}) {
      for (const prefix of ['dist/', 'dist/esm/', 'src/']) {
        console.log(require.resolve('react-native-selectable-markdown/' + prefix + path));
      }
    }`;
    const result = runNode(['--conditions=react-native', '-e', probe], repoRoot);
    expect(result.status).toBe(0);
    const paths = result.stdout.trim().split('\n');
    for (let i = 0; i < paths.length; i += 3) {
      expect(paths[i]).toContain('/src/');
      expect(paths[i + 1]).toBe(paths[i]);
      expect(paths[i + 2]).toBe(paths[i]);
    }
  });

  test('explicit ESM paths are not prefixed twice', () => {
    const result = runNode(['--input-type=module', '-e',
      "console.log(import.meta.resolve('react-native-selectable-markdown/dist/esm/engine/native'));"], repoRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/dist/esm/engine/native.js');
    expect(result.stdout).not.toContain('/esm/esm/');
  });
});
