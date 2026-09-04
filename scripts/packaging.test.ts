/**
 * The packaging scripts and the workflow commands that call them.
 *
 * These are the checks nothing else can make: `npm run verify:pack` proves the
 * tarball is consumable but takes a full pack to say so, and a workflow step is
 * only ever exercised by pushing to CI. What is pinned here is the behaviour
 * each of them was fixed for — the shim's declaration file, the lockfile guard
 * that must not care about key order, the engine file list that must not be a
 * non-recursive glob, and the pipeline whose failure must not be swallowed by
 * `tee`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
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

  beforeAll(() => {
    const ran = runNode([path.join(scriptsDir, 'emit-dist-spec-shim.mjs')]);
    expect(ran.status).toBe(0);
  });

  it('writes both files', () => {
    // package.json's "./dist/*" export declares its types as "./dist/*.d.ts".
    // The .js alone left that promise unkept for this one path, and a
    // TypeScript consumer deep-importing it got "Could not find a declaration
    // file" — not an implicit any, an error they cannot fix from their side.
    expect(fs.existsSync(shim)).toBe(true);
    expect(fs.existsSync(declaration)).toBe(true);
  });

  it('re-exports the prop contract from the untranspiled spec rather than copying it', () => {
    const text = fs.readFileSync(declaration, 'utf8');
    const reference = text.match(/export type \{ NativeProps \} from '([^']+)'/);
    expect(reference).not.toBeNull();

    const resolved = path.resolve(path.dirname(declaration), `${reference![1]}.ts`);
    expect(fs.existsSync(resolved)).toBe(true);
    // And it is the real spec, not a second declaration that could drift.
    expect(fs.readFileSync(resolved, 'utf8')).toContain('export interface NativeProps');
  });

  it('declares no runtime value, because the module beside it exports none', () => {
    const text = fs.readFileSync(declaration, 'utf8');
    expect(fs.readFileSync(shim, 'utf8')).toContain('module.exports = {}');
    expect(text).not.toMatch(/export default/);

    // verify-pack tells the shim apart from a transpiled copy of the spec by
    // looking for this call in any dist file named after the spec. A
    // declaration that mentioned it would be reported as a codegen leak.
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
  });

  it('passes when the lock lists the same dependencies in a different order', () => {
    // The regression: the guard compared JSON.stringify output, so npm writing
    // a block alphabetically while a human appended to package.json failed the
    // release with a message showing two objects that read as identical.
    const lock = lockWith({
      // Everything npm writes into the root entry for this manifest, so what
      // the case varies is key order and nothing else.
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      peerDependencies: reversed(manifest.peerDependencies as Record<string, string>),
      devDependencies: reversed(manifest.devDependencies as Record<string, string>),
    });

    const ran = runNode([check, manifestPath, lock]);
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
  });

  it('fails on a drifted range and names the key that moved', () => {
    // The original defect: the lock claimed react-native >=0.73 through two
    // releases that had raised the floor to >=0.82, and `npm ci` never looked.
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
    // npm omits a block it has nothing to write; a human removing the last
    // entry from package.json leaves `{}` behind. Both mean "none", and the
    // guard used to fail that pair with `package.json {}, lock null` — a red
    // describing no drift at all.
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
  });

  it('compares the identity fields npm copies, not only the dependency blocks', () => {
    // The comment called FIELDS "the blocks npm copies into the lock's root",
    // while the list held four of them: a manifest renamed, relicensed, or
    // given an engines/bin block passed the guard against a lock that still
    // said something else.
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
  const findCommand = lines.find((line) => line.startsWith('files=$(find platform/cpp'));

  /** A workflow's runnable lines, i.e. everything that is not a YAML comment. */
  const commandsOf = (file: string): string =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

  it('uses find rather than a non-recursive shell glob, in both workflows', () => {
    // `platform/cpp/*.cpp` is expanded by the runner's shell and does not
    // descend, so an engine source added in a subdirectory would fall outside
    // the gate — reported as skipped by the default run, failing nothing.
    // (The string still appears in prose: the comments explain why it is not
    // what a gate rests on.)
    expect(findCommand).toBeDefined();
    for (const file of [ciWorkflow, releaseWorkflow]) {
      expect(commandsOf(file)).not.toContain('platform/cpp/*.cpp');
      expect(commandsOf(file)).toContain('find platform/cpp');
    }
  });

  it('finds sources in subdirectories and skips vendor/', () => {
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

    // The workflow's own command, run against the fixture tree.
    const ran = run('bash', ['-c', `${findCommand}\nprintf '%s\\n' "$files"`], dir);
    expect(ran.status).toBe(0);
    const listed = ran.stdout.trim().split('\n').sort();
    expect(listed).toEqual(['platform/cpp/FlatBuffer.cpp', 'platform/cpp/sub/Nested.cpp']);
  });

  it('fails the step when the enumeration comes back empty', () => {
    const dir = scratch('cpp-enumeration-empty');
    fs.mkdirSync(path.join(dir, 'platform', 'cpp'), { recursive: true });
    const start = lines.findIndex((line) => line.startsWith('files=$(find platform/cpp'));
    // Through the closing `fi`, so the slice is a complete shell fragment
    // rather than an unterminated `if` that fails for the wrong reason.
    const end = lines.indexOf('fi', start);
    expect(end).toBeGreaterThan(start);
    const script = lines.slice(start, end + 1).join('\n');

    const ran = run('bash', ['-c', script], dir);
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain('compiled nothing');
  });
});

describe('check-fabric-cpp names the command the gate actually runs', () => {
  const checker = path.join(scriptsDir, 'check-fabric-cpp.mjs');
  const source = fs.readFileSync(checker, 'utf8');

  it('tells a developer the spelling the workflows use, not one that would skip', () => {
    // Every default run prints this line once per platform/cpp source. It used
    // to name `npm run check:fabric-cpp -- --syntax-only platform/cpp/*.cpp` —
    // no --platform (which an explicit file list requires, because it narrows
    // the script to one pass) and the non-recursive glob that ci.yml, the
    // podspec and this suite all now declare unfit for a gate.
    const skip = source.slice(source.indexOf('the markdown engine, not the view layer'));
    const message = skip.slice(0, skip.indexOf('});'));

    expect(message).toContain('--syntax-only --platform <ios|android>');
    expect(message).toContain("find platform/cpp -path platform/cpp/vendor -prune -o -name '*.cpp' -print");
    expect(message).not.toContain('--syntax-only platform/cpp/*.cpp');
  });

  it('leaves that spelling nowhere else in the script either', () => {
    // The same stale command sat in a second comment, beside the include roots
    // it explains.
    expect(source).not.toContain('--syntax-only platform/cpp/*.cpp');
  });

  it('names the enumeration ci.yml really runs', () => {
    // Not just "some find command": the message and the workflow have to agree
    // on the prune, or the message sends a developer to a different file set
    // than the gate compiles.
    const findCommand = fs
      .readFileSync(ciWorkflow, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('files=$(find platform/cpp'));
    expect(findCommand).toBeDefined();

    const expression = findCommand!.slice(
      findCommand!.indexOf('find platform/cpp'),
      findCommand!.indexOf(' | sort'),
    );
    expect(source).toContain(expression);
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
    // --no-git so the fixture is judged against the tags it is given rather
    // than this repository's.
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
    // Run against the real CHANGELOG.md, package.json and git tags — the state
    // the audit left behind is a pending BREAKING under an unbumped 0.11.0, and
    // the guard has to be the one that says so rather than a fixture-only
    // check. Written as an equivalence so it keeps testing the wiring after the
    // maintainer bumps and moves the entries.
    const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('## [', changelog.indexOf('## [Unreleased]') + 1),
    );
    const version = (JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string }).version;
    const tags = run('git', ['tag', '--list', 'v*']).stdout.split('\n').map((t) => t.trim());
    const shouldFail = unreleased.includes('BREAKING') && tags.includes(`v${version}`);

    const ran = runNode([path.join(scriptsDir, 'check-unreleased-breaking.mjs')]);
    expect(ran.status).toBe(shouldFail ? 1 : 0);
  });

  it('runs in release.yml preflight and in scripts/release.mjs', () => {
    const workflow = fs
      .readFileSync(releaseWorkflow, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(workflow).toContain('node scripts/check-unreleased-breaking.mjs --tag "$GITHUB_REF_NAME"');

    // After the bump, inside the try that rolls it back: the guard judges the
    // bump, and a failed one must not leave a half-bumped tree.
    const release = fs.readFileSync(path.join(scriptsDir, 'release.mjs'), 'utf8');
    expect(release).toContain("'scripts/check-unreleased-breaking.mjs'");
    expect(release.indexOf("'scripts/check-unreleased-breaking.mjs'")).toBeGreaterThan(
      release.indexOf("run('npm', ['version', bumpArg"),
    );
  });
});

describe('the package ships an ES module build beside the CommonJS one', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    main: string;
    module: string;
    'react-native': string;
    exports: Record<string, Record<string, unknown>>;
  };
  const esmDir = path.join(repoRoot, 'dist', 'esm');
  // The suites below need `npm run build` to have run. CI has it (npm ci runs
  // `prepare`), and so does any machine that has built once; where it has not,
  // reporting the missing prerequisite beats compiling the package inside a
  // unit test.
  const describeBuilt = fs.existsSync(path.join(esmDir, 'index.js')) ? describe : describe.skip;

  it('declares both conditions on every dist entry, and keeps Metro on src/', () => {
    // A CommonJS barrel cannot be tree-shaken per export, which is what left
    // `sideEffects: false` doing almost nothing for webpack, Rollup and Vite.
    // The two conditions are what let those bundlers take the ESM tree while
    // `require` keeps the CommonJS one — and `react-native` must still win over
    // both, or Metro stops reading the untranspiled codegen spec.
    expect(manifest.exports['.']['react-native']).toBe(`./${manifest['react-native']}`);
    for (const key of ['.', './dist', './dist/*.js', './dist/*']) {
      const entry = manifest.exports[key] as Record<string, { default?: string }>;
      expect(`${key}: ${entry.require?.default}`).toBe(
        `${key}: ${key.includes('*') ? './dist/*.js' : `./${manifest.main}`}`,
      );
      expect(`${key}: ${entry.import?.default}`).toBe(
        `${key}: ${key.includes('*') ? './dist/esm/*.js' : `./${manifest.module}`}`,
      );
    }
  });

  it('resolves the bare directory path again', () => {
    // `require('react-native-selectable-markdown/dist')` reached dist/index.js
    // before the exports map existed and then stopped resolving, because the
    // `./dist/*` pattern needs at least one segment past `dist`. It is an
    // explicit entry now.
    expect(manifest.exports['./dist']).toBeDefined();
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
      // Node reads an untyped .js as CommonJS, and every import statement in
      // the tree is then a SyntaxError on the Node 20 both workflows pin (22.7+
      // detects module syntax, which is exactly why this is asserted on the
      // file rather than by importing something). `sideEffects` is repeated
      // because bundlers read it from the NEAREST package.json.
      const marker = JSON.parse(fs.readFileSync(path.join(esmDir, 'package.json'), 'utf8'));
      expect(marker.type).toBe('module');
      expect(marker.sideEffects).toBe(false);
    });

    it('gives every relative specifier the extension an ESM resolver needs', () => {
      // tsc does not rewrite specifiers in any module mode, so this is what
      // scripts/finish-esm-build.mjs exists for. One module missed is an
      // ERR_MODULE_NOT_FOUND in a consumer and nothing at all here.
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
    });

    it('serves each condition its own tree, by bare specifier', () => {
      // Resolved the way a consumer resolves: through a node_modules link. The
      // ESM half needs a child process, because createRequire can only ever
      // take the `require` condition.
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
  const workflow = fs.readFileSync(releaseWorkflow, 'utf8');

  it('sets pipefail before piping the changelog section into tee', () => {
    const step = workflow.slice(workflow.indexOf('Extract the release notes for this tag'));
    const body = step.slice(0, step.indexOf('- run: npm run typecheck'));
    expect(body).toContain('set -o pipefail');
    expect(body.indexOf('set -o pipefail')).toBeLessThan(body.indexOf('| tee'));
  });

  it('is the difference between a swallowed failure and a red step', () => {
    // GitHub's default shell is `bash -e {0}`, where a pipeline's status is
    // tee's — always 0. Without pipefail a failing changelog-section.mjs would
    // write an EMPTY notes file, pass the step, and publish a release with no
    // notes.
    const dir = scratch('pipefail');
    const notes = path.join(dir, 'notes.md');
    const pipeline = `node -e 'process.exit(1)' | tee ${JSON.stringify(notes)}`;

    expect(run('bash', ['-e', '-c', pipeline], dir).status).toBe(0);
    expect(run('bash', ['-e', '-c', `set -o pipefail\n${pipeline}`], dir).status).not.toBe(0);
  });

  it('really does fail that step when the changelog section is missing', () => {
    const dir = scratch('release-notes');
    const notes = path.join(dir, 'notes.md');
    const script =
      'set -o pipefail\n' +
      `node ${JSON.stringify(path.join(scriptsDir, 'changelog-section.mjs'))} v99.99.99 ` +
      `| tee ${JSON.stringify(notes)}`;

    const ran = run('bash', ['-e', '-c', script], repoRoot);
    expect(ran.status).not.toBe(0);
    expect(fs.readFileSync(notes, 'utf8')).toBe('');
  });
});
