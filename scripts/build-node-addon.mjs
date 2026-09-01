#!/usr/bin/env node
/**
 * build-node-addon.mjs — compiles native/node/addon.cpp and the C++ core into
 * build/selectable-markdown.<platform>-<arch>.node, using nothing but a C/C++
 * compiler.
 *
 * WHY NOT node-gyp. node-gyp is a dependency (plus Python, plus a downloaded
 * copy of the Node headers, plus a generated Makefile) for a build that is
 * five translation units and one link line. This repo has zero runtime
 * dependencies and the harness that proves the native engine works should
 * not be the thing that reintroduces a toolchain. Everything below is
 * `spawnSync(cc, args)`. (node-gyp is still the easiest way to *fetch the
 * headers* on a machine that has none — see resolveNodeIncludeDir — but that
 * is a one-off download, not a build dependency.)
 *
 * WHY THE OBJECT FILES LIVE IN build/obj. md4c.c is a quarter of a megabyte
 * of C; recompiling it on every `node --test` run would make the harness feel
 * like a build system. Objects are cached and reused whenever every input
 * they depend on is older than the object — see `isUpToDate`.
 *
 * WHY THERE IS A LOCK. Nothing calls this script once. `npx jest` runs five
 * suites that each load the addon, in five worker processes, and every one of
 * them shells out to this script when build/ is cold — as do the conformance
 * runner and the benches through native/node/index.mjs. Left alone they
 * compile the same translation units into the same object files and link over
 * the same output at the same time: `cc -o build/obj/md4c.o` truncates a file
 * another process is already reading, and a reader of the module itself can
 * catch it mid-link (measured, sampling the path during five concurrent
 * builds: missing 43 times, zero bytes 11 times — each one either a silently
 * skipped native suite or a dlopen error out of a test file). So the build
 * phase runs under a directory mutex, and the finished module is published
 * with a rename, which is atomic: a reader sees the old module or the new
 * one, never a partial one. Waiters do not give up — they block, then find
 * everything up to date and exit 0, so a cold checkout still runs every
 * native suite instead of skipping whichever ones lost the race.
 *
 * Usage:
 *   node scripts/build-node-addon.mjs                  # incremental build
 *   node scripts/build-node-addon.mjs --force          # recompile everything
 *   node scripts/build-node-addon.mjs --clean          # delete build/ and stop
 *   node scripts/build-node-addon.mjs --if-available   # exit 0 (explaining why)
 *                                                     # when this machine has
 *                                                     # no compiler/headers
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const cppDir = path.join(repoRoot, 'platform', 'cpp');
const md4cDir = path.join(cppDir, 'vendor', 'md4c');
const addonDir = path.join(repoRoot, 'native', 'node');
const buildDir = path.join(repoRoot, 'build');
/* Artifacts are keyed by the interpreter that will load them. One checkout is
 * routinely driven by two Nodes on the same machine — an arm64 Node and an
 * x86_64 Node under Rosetta — and with an arch-agnostic name the first one's
 * module blocks the second forever: every loader sees the file exists, skips
 * the build, and then dlopen refuses it with a mach-o architecture error.
 * One module per platform/arch (with an object cache each, since a .o is just
 * as arch-bound as the module linked from it) lets them coexist. Spelled with
 * `process.arch` (x64, arm64 — not clang's x86_64), so every loader can
 * compute the same name with no mapping; keep the three copies of this
 * expression in sync: here, native/node/index.mjs, and
 * src/engine/native/__tests__/support.ts. */
const target = `${process.platform}-${process.arch}`;
const objDir = path.join(buildDir, 'obj', target);
const addonPath = path.join(buildDir, `selectable-markdown.${target}.node`);
/* Linked here and renamed into place, so `addonPath` never names a file the
 * linker is still writing. Same directory, because rename is only atomic
 * within a filesystem; pid in the name so a crashed build cannot leave a
 * temp file a later build would mistake for its own. */
const tmpAddonPath = path.join(buildDir, `.selectable-markdown.${target}.node.${process.pid}.tmp`);
const lockDir = path.join(buildDir, '.build-lock');

const force = process.argv.includes('--force');
const clean = process.argv.includes('--clean');
/* --if-available turns "this machine cannot build the addon" from an error
 * into a no-op, so a runner without a toolchain does not go red for being
 * unequipped. It does NOT soften real failures: a compile error, a link error
 * or a symbol-guard violation still exits non-zero, because those mean the
 * code is broken rather than the machine being unequipped.
 *
 * Reach for it deliberately. This addon is the only parser Node can reach —
 * the package parses with md4c and ships no JavaScript engine — so a job that
 * skips the build is not running a reduced version of the markdown checks
 * downstream of it, it is running none of them. */
const ifAvailable = process.argv.includes('--if-available');

const log = (...parts) => console.log('[build-node-addon]', ...parts);

/** Non-zero exit with a message the reader can act on, not just a stack. */
function fail(message, hint) {
  console.error(`\n[build-node-addon] ERROR: ${message}`);
  if (hint) console.error(`[build-node-addon] ${hint}`);
  process.exit(1);
}

/**
 * "This machine is not equipped to build the addon" — a missing compiler or
 * missing Node headers. Distinct from `fail`, which means "the build broke".
 * Only this class of exit is downgraded by --if-available; see the flag's
 * comment for why the distinction is load-bearing.
 */
function unavailable(message, hint) {
  if (!ifAvailable) fail(message, hint);
  log('skipped   ', message);
  if (hint) console.log(`[build-node-addon] ${hint}`);
  log('skipped   ', '--if-available was passed, so this is not an error.');
  process.exit(0);
}

/* ------------------------------------------------------------------------ *
 * Build mutex
 *
 * See "WHY THERE IS A LOCK" in the file header for the failure it prevents.
 * A directory is the lock primitive because `mkdir` is atomic on every
 * filesystem this script runs on — no create-then-check window, and nothing
 * to install. The holder's pid goes inside it, so the answer to "is this lock
 * abandoned?" is a question about a process rather than about a clock: a
 * build killed with ^C or an OOM cannot wedge every later build the way a
 * bare timeout-free lock file would.
 * ------------------------------------------------------------------------ */

const LOCK_POLL_MS = 100;
/* Only ever reached when the holder still looks alive — a hung compiler, or a
 * pid the OS has since recycled onto some unrelated process. Generous enough
 * that a slow cold build on a loaded CI runner never trips it. */
const LOCK_MAX_WAIT_MS = 5 * 60 * 1000;

let holdingLock = false;

/** Synchronous sleep. The whole script is spawnSync; there is no event loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the process named inside the lock is still running.
 *
 * `process.kill(pid, 0)` sends no signal; it just asks the kernel. EPERM means
 * the process exists but belongs to someone else — alive, hands off. A pid
 * file that is missing or unreadable means the holder created the directory
 * microseconds ago and has not written it yet, which is "alive" too; the
 * wait timeout is the backstop for the vanishingly small window where the
 * holder died in between.
 */
function lockHolderIsAlive() {
  let pid;
  try {
    pid = Number.parseInt(readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10);
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Block until this process owns the build directory, then own it.
 *
 * Waiters do not skip the build when they wake up: they run the ordinary
 * incremental path, which finds the objects and the module the previous
 * holder just produced and reports "up to date". That is what keeps a cold
 * checkout from turning a lost race into a skipped native suite.
 */
function acquireBuildLock() {
  const startedWaiting = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      holdingLock = true;
      writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
      if (announced) {
        log('lock      ', `acquired after ${Math.round((Date.now() - startedWaiting) / 1000)}s`);
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        fail(
          `could not take the build lock at ${path.relative(repoRoot, lockDir)}: ${error.message}`,
          'That directory is this script\'s mutex; the build cannot be made ' +
            'safe against concurrent runs without it.',
        );
      }
    }
    if (!lockHolderIsAlive()) {
      log('lock      ', 'clearing a lock left behind by a build that did not finish');
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - startedWaiting > LOCK_MAX_WAIT_MS) {
      fail(
        `timed out after ${LOCK_MAX_WAIT_MS / 1000}s waiting for the build lock`,
        `Another build still holds ${path.relative(repoRoot, lockDir)}. If no ` +
          'build is running, delete that directory (or run --clean) and retry.',
      );
    }
    if (!announced) {
      announced = true;
      log('lock      ', 'another build is running — waiting for it to finish');
    }
    sleepSync(LOCK_POLL_MS);
  }
}

/* Releasing on `exit` covers every way this script stops on purpose —
 * `fail`, `unavailable`, the up-to-date early exit, an uncaught throw — since
 * all of them run exit listeners. A SIGKILL does not, which is exactly the
 * case `lockHolderIsAlive` exists to clean up on the next run. The temp
 * module goes with it: a failed link or a symbol-guard violation must not
 * leave a stray .tmp in build/. */
process.on('exit', () => {
  if (existsSync(tmpAddonPath)) rmSync(tmpAddonPath, { force: true });
  if (holdingLock) rmSync(lockDir, { recursive: true, force: true });
});

/**
 * Where node-gyp parks downloaded headers. node-gyp derives this from
 * `env-paths('node-gyp')`, which is a different shape on every platform, and
 * the directory is keyed by the exact Node version — which is what makes it
 * safe to use: headers from v20.11.0 are never handed to a v22 interpreter.
 *
 * All shapes are probed on all platforms rather than only the current one:
 * XDG_CACHE_HOME is honoured on macOS by some setups, and a Linux container
 * that inherited a macOS-shaped cache costs one `existsSync` to rule out.
 */
function nodeGypIncludeDirs() {
  const home = os.homedir();
  const version = process.version.replace(/^v/, '');
  const roots = [];
  /* node-gyp's own overrides, in the order node-gyp itself honours them. */
  if (process.env.npm_config_devdir) roots.push(process.env.npm_config_devdir);
  if (process.env.XDG_CACHE_HOME) {
    roots.push(path.join(process.env.XDG_CACHE_HOME, 'node-gyp'));
  }
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  roots.push(path.join(localAppData, 'node-gyp', 'Cache')); // Windows
  roots.push(path.join(home, 'Library', 'Caches', 'node-gyp')); // macOS
  roots.push(path.join(home, '.cache', 'node-gyp')); // Linux / XDG default
  return roots.map((root) => path.join(root, version, 'include', 'node'));
}

/**
 * The Node headers are not on any default include path. Candidates are tried
 * in the order that is most likely to be *this* interpreter's own headers
 * first — mixing headers from one Node version with a binary loaded by
 * another is exactly the kind of ABI mismatch N-API exists to prevent, so we
 * prefer the ones sitting next to process.execPath, then the version-keyed
 * node-gyp caches, then a system prefix.
 *
 * npm_config_nodedir (the knob node-gyp and npm already expose) is treated as
 * AUTHORITATIVE: when it is set, it is the only candidate. Falling back from
 * a mistyped override to some other Node's headers would produce a module
 * that links and then misbehaves at dlopen time, which is precisely the
 * failure mode this ordering exists to prevent — a typo must be an error.
 */
function resolveNodeIncludeDir() {
  const override = process.env.npm_config_nodedir;
  /* Official Node builds report node_prefix as "/" (or ""), which would
   * expand to a nonsense "/include/node" candidate; treat that as "unset". */
  const prefix = process.config?.variables?.node_prefix;
  const candidates = override
    ? [path.join(override, 'include', 'node'), override]
    : [
        ...new Set([
          path.resolve(process.execPath, '..', '..', 'include', 'node'),
          ...nodeGypIncludeDirs(),
          path.join(
            prefix && prefix !== '/' ? prefix : '/usr/local',
            'include',
            'node',
          ),
        ]),
      ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'node_api.h'))) return dir;
  }
  unavailable(
    `could not find the Node C headers (node_api.h) for ${process.version}`,
    `Looked in:\n  ${candidates.join('\n  ')}\n` +
      '[build-node-addon] Fetch them for this exact interpreter with:\n' +
      '[build-node-addon]     npx node-gyp install\n' +
      '[build-node-addon] (that downloads nothing but headers, into the ' +
      'version-keyed cache this script probes;\n' +
      '[build-node-addon] it does not add a build dependency).\n' +
      '[build-node-addon] Distro packages work too — `nodejs-dev` on Debian/' +
      'Ubuntu, `brew install node` on macOS —\n' +
      '[build-node-addon] as does pointing npm_config_nodedir at an unpacked ' +
      'Node source/header tree.',
  );
  return '';
}

/**
 * `-arch` must match the interpreter that will dlopen the result, not the
 * compiler's default target. On an Apple-silicon machine running an x64 Node
 * under Rosetta, clang defaults to arm64 and the module would build cleanly
 * and then fail to load with a mach-o architecture error — this mapping is
 * what prevents that.
 */
function resolveArch() {
  const map = { x64: 'x86_64', arm64: 'arm64' };
  const arch = map[process.arch];
  if (!arch) {
    fail(
      `unsupported process.arch "${process.arch}"`,
      'This script maps x64 -> x86_64 and arm64 -> arm64; add a mapping ' +
        'for your platform if you need one.',
    );
  }
  return arch;
}

const isDarwin = process.platform === 'darwin';

function mtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * An object is reusable when it exists and every input is older than it.
 * Headers are part of `deps` deliberately: Protocol.h is the wire-format
 * contract, and a stale object built against an older copy of it would
 * produce a buffer the JS decoder silently misreads. Cheap over-invalidation
 * beats a debugging session.
 */
function isUpToDate(object, deps) {
  if (force) return false;
  const objectTime = mtime(object);
  if (objectTime === null) return false;
  for (const dep of deps) {
    const depTime = mtime(dep);
    if (depTime === null || depTime > objectTime) return false;
  }
  return true;
}

function run(command, args, what) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  /* resolveCompiler already proved this command exists, so an ENOENT here
   * means it vanished mid-build (a PATH change, an interrupted install) —
   * a hard failure, not an unequipped machine. */
  if (result.error && result.error.code === 'ENOENT') {
    fail(
      `compiler "${command}" not found`,
      'Install the Xcode command line tools (`xcode-select --install`) or ' +
        'set CC/CXX to a compiler on PATH.',
    );
  }
  if (result.error) fail(`${what} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${what} failed (exit ${result.status})`,
      `Command: ${command} ${args.join(' ')}`,
    );
  }
}

const COMPILER_HINT =
  'macOS: xcode-select --install\n' +
  '[build-node-addon] Debian/Ubuntu: apt-get install -y build-essential ' +
  '(or clang)\n' +
  '[build-node-addon] Or set CC/CXX to a compiler that is installed.';

/** Only ENOENT means "not installed"; a non-zero `--version` is still a compiler. */
function commandExists(command) {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !(probe.error && probe.error.code === 'ENOENT');
}

/**
 * A compiler that is not installed is an "unavailable machine", not a broken
 * build, so it has to be detected BEFORE the first compile — once we are
 * inside `run` the only honest thing left to do is fail.
 *
 * The fallback chain matters more than it looks: hard-coding `clang` made the
 * script report "no compiler" on any Linux image that ships only gcc, and
 * under --if-available that turns the build into a permanent no-op — a green
 * job that quietly stopped exercising the parser, because the parser is the
 * thing this addon is. An explicit CC/CXX is never second-guessed: a typo
 * there is reported rather than silently replaced with a different compiler,
 * because the objects in build/obj must all come from the same one.
 */
function resolveCompiler(envVar, candidates) {
  const override = process.env[envVar];
  if (override) {
    if (commandExists(override)) return override;
    unavailable(`${envVar}="${override}" is not on PATH`, COMPILER_HINT);
  }
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  unavailable(
    `no compiler on PATH (tried ${candidates.join(', ')})`,
    COMPILER_HINT,
  );
  return '';
}

/* ------------------------------------------------------------------------ *
 * Undefined-symbol guard
 *
 * INCIDENT — DO NOT REMOVE THIS GUARD AS "UNNECESSARY".
 *
 * md4c's entity.h declares `const ENTITY* entity_lookup(const char*, size_t)`
 * with no `extern "C"` wrapper. OffsetParser.cpp includes it to decode HTML
 * entities, so the C++ front end mangled the call site into
 * `_Z13entity_lookupPKcm` while entity.c (compiled as C) defined the plain
 * `entity_lookup`. The two never met.
 *
 * That mismatch should have been a link error, and on ELF it very nearly is.
 * On macOS it is not: a Node addon is a Mach-O bundle linked with
 * `-undefined dynamic_lookup` (see linkFlags) precisely so the napi_* symbols
 * can be resolved out of the host process at dlopen time. That flag is not
 * selective — it leaves EVERY unresolved symbol to be looked up later, so the
 * link "succeeded", `require()` succeeded, and the process took a SIGSEGV on
 * the first markdown source containing an entity.
 *
 * So the link line cannot be made strict without losing the napi_* lookup.
 * Instead we inspect the finished module and assert that every symbol it
 * still expects the host to provide is one we can name: Node-API, or the
 * platform C/C++ runtime. Anything else — in particular anything mangled that
 * is not standard-library — is a symbol from OUR sources that failed to
 * resolve, and is a runtime crash waiting for the right input.
 *
 * The cost is one `nm` invocation per link. The bug it catches costs an
 * afternoon and presents as a segfault with no stack.
 * ------------------------------------------------------------------------ */

/**
 * Plain C runtime entry points. Enumerated rather than pattern-matched
 * because an unprefixed lowercase identifier is exactly the shape our own C
 * code has, so a wildcard here would blind the guard to the C half of the
 * very mismatch it exists to catch. Extend it when a new platform's libc
 * spells something differently; do not widen it into a pattern.
 */
const KNOWN_C_RUNTIME = new Set([
  // string.h / strings.h
  'memchr', 'memcmp', 'memcpy', 'memmove', 'memset', 'bzero',
  'strchr', 'strrchr', 'strcmp', 'strncmp', 'strcpy', 'strncpy',
  'strlen', 'strnlen', 'strstr', 'strdup',
  // stdlib.h
  'abort', 'atoi', 'bsearch', 'calloc', 'exit', 'free', 'malloc', 'qsort',
  'realloc', 'strtod', 'strtol', 'strtoul',
  // stdio.h (md4c's MD_LOG path and our error strings)
  'fprintf', 'fputs', 'fwrite', 'printf', 'putchar', 'puts', 'snprintf',
  'sprintf', 'vfprintf', 'vsnprintf', 'stderr', 'stdout',
  // ctype.h, when the libc exports it as functions rather than macros
  'isalnum', 'isalpha', 'isdigit', 'islower', 'isspace', 'isupper',
  'isxdigit', 'tolower', 'toupper',
  // Mach-O only: the lazy-binding helper every dylib references.
  'dyld_stub_binder',
]);

/**
 * Mangled (Itanium ABI) names that are legitimately someone else's. `St` is
 * the standard abbreviation for `std::` and `10__cxxabiv1` is the C++ ABI
 * runtime, so these three patterns admit libc++/libstdc++ and libc++abi
 * while still rejecting a mangled name from our own translation units —
 * which is the entity_lookup case above.
 */
const KNOWN_CXX_MANGLED = [
  /^_Z(?:T[A-Za-z]|G[A-Za-z])?N?[KVRO]*St/, // std::…, typeinfo/vtable/guard for std::…
  /^_Z(?:T[A-Za-z])?N?[KVRO]*10__cxxabiv1/, // __cxxabiv1::… (typeinfo bases)
  /^_Z(?:nw|na|dl|da)/, // operator new / new[] / delete / delete[]
];

/**
 * Escape hatch for a libc symbol a platform spells in a way this script has
 * never seen: SELECTABLE_MARKDOWN_ALLOW_UNDEFINED=foo,bar. Intended for
 * platform runtime names only — adding one of our own symbols here reinstates
 * the crash the guard exists to prevent.
 */
const EXTRA_ALLOWED = new Set(
  (process.env.SELECTABLE_MARKDOWN_ALLOW_UNDEFINED || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Mach-O prefixes every C symbol with an underscore; ELF does not. Removing
 * exactly one on Darwin puts both platforms in the same namespace, so
 * `___cxa_throw` and `__cxa_throw` are one rule, and `__ZNSt…` and `_ZNSt…`
 * are one rule. Removing more than one would turn the mangled `_Z…` prefix
 * into `Z…` and silently defeat every C++ pattern below.
 */
function normalizeSymbol(name) {
  return isDarwin && name.startsWith('_') ? name.slice(1) : name;
}

function isKnownGoodSymbol(rawName) {
  const name = normalizeSymbol(rawName);
  if (EXTRA_ALLOWED.has(rawName) || EXTRA_ALLOWED.has(name)) return true;
  // Node-API: resolved out of the host process at dlopen time, by design.
  if (/^(?:napi_|node_api_)/.test(name)) return true;
  // C++ mangling — allowed only when it names the standard library / ABI.
  if (name.startsWith('_Z')) {
    return KNOWN_CXX_MANGLED.some((pattern) => pattern.test(name));
  }
  // Double-underscore identifiers are reserved for the implementation:
  // __cxa_*, __gxx_personality_v0, __stack_chk_fail/guard, __bzero,
  // __memcpy_chk, __errno_location, __gmon_start__, __ctype_b_loc, …
  if (name.startsWith('__')) return true;
  // The unwinder (_Unwind_Resume et al) and the GCC transactional-memory
  // weak refs (_ITM_*) sit in the single-underscore reserved space, as does
  // the ELF GOT anchor.
  if (/^(?:_Unwind_|_ITM_)/.test(name)) return true;
  if (name === '_GLOBAL_OFFSET_TABLE_') return true;
  return KNOWN_C_RUNTIME.has(name);
}

/**
 * nm's two dialects, normalized. BSD nm (`-u`) prints bare names, one per
 * line; GNU nm (`-D --undefined-only`) prints "<addr> U name" and tags glibc
 * symbols with an @VERSION suffix that is not part of the identity.
 */
function parseUndefinedSymbols(stdout) {
  const names = new Set();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.endsWith(':')) continue; // nm's "<file>:" banner
    const fields = line.split(/\s+/);
    const name = fields[fields.length - 1].split('@')[0];
    if (name) names.add(name);
  }
  return [...names];
}

/** Best-effort demangling for the error message; raw names if c++filt is absent. */
function demangle(names) {
  const result = spawnSync('c++filt', [], {
    input: names.join('\n'),
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return names;
  const lines = result.stdout.split('\n');
  return names.map((name, i) => {
    const pretty = (lines[i] || '').trim();
    return pretty && pretty !== name ? `${name}  (${pretty})` : name;
  });
}

function assertOnlyKnownUndefinedSymbols(modulePath, displayPath = modulePath) {
  const args = isDarwin
    ? ['-u', modulePath]
    : ['-D', '--undefined-only', modulePath];
  const result = spawnSync('nm', args, { encoding: 'utf8' });
  /* A missing or unhappy nm is a gap in the check, not a broken build — and
   * failing here would make the guard the reason a working toolchain cannot
   * build. Say so loudly instead, so a silent skip never reads as a pass. */
  if (result.error || result.status !== 0) {
    log(
      'WARNING   ',
      `could not run \`nm ${args.slice(0, -1).join(' ')}\` — the ` +
        'undefined-symbol guard did NOT run for this build.',
    );
    return;
  }
  const symbols = parseUndefinedSymbols(result.stdout);
  const offenders = symbols.filter((name) => !isKnownGoodSymbol(name)).sort();
  if (offenders.length === 0) {
    log('symbols   ', `${symbols.length} undefined, all known-good`);
    return;
  }
  console.error(
    `\n[build-node-addon] ${offenders.length} unresolved symbol(s) in ` +
      `${path.relative(repoRoot, displayPath)} that nothing will provide:`,
  );
  for (const line of demangle(offenders)) console.error(`    ${line}`);
  fail(
    'the linked module expects symbols nobody defines',
    'This links anyway on macOS (-undefined dynamic_lookup) and CRASHES at\n' +
      '[build-node-addon] run time on the first call. Usual causes:\n' +
      '[build-node-addon]   - a C header included from C++ without an ' +
      '`extern "C"` block (the\n' +
      '[build-node-addon]     name above will be mangled — this is exactly ' +
      'how md4c\'s entity.h\n' +
      '[build-node-addon]     once shipped a segfault);\n' +
      '[build-node-addon]   - a translation unit missing from `units` in ' +
      'this script;\n' +
      '[build-node-addon]   - a declaration with no definition anywhere.\n' +
      '[build-node-addon] If the symbol really is platform runtime this ' +
      'script has not seen,\n' +
      '[build-node-addon] add it to KNOWN_C_RUNTIME (preferred) or set ' +
      'SELECTABLE_MARKDOWN_ALLOW_UNDEFINED.',
  );
}

if (clean) {
  rmSync(buildDir, { recursive: true, force: true });
  log('clean      removed', path.relative(repoRoot, buildDir) + '/');
  process.exit(0);
}

const arch = resolveArch();
/* Both prerequisites are resolved before anything is written, so an
 * unequipped machine exits without leaving a half-populated build/obj
 * behind. clang first because it is the system compiler on macOS and the one
 * the -arch/dynamic_lookup flags below are spelled for; gcc is the Linux
 * default and `cc`/`c++` are the POSIX last resort. */
const cc = resolveCompiler('CC', ['clang', 'gcc', 'cc']);
const cxx = resolveCompiler('CXX', ['clang++', 'g++', 'c++']);
const nodeInclude = resolveNodeIncludeDir();

/* Darwin-only flags. `-arch` is an Apple driver spelling, and
 * `-undefined dynamic_lookup` is how a Mach-O bundle leaves the napi_*
 * symbols to be resolved by the host process at dlopen time. ELF shared
 * objects already allow undefined symbols, so on Linux both are omitted
 * rather than translated. Either way the result is a module whose undefined
 * symbols nobody checked — which is what assertOnlyKnownUndefinedSymbols is
 * for. */
const archFlags = isDarwin ? ['-arch', arch] : [];
const linkFlags = isDarwin
  ? ['-shared', '-undefined', 'dynamic_lookup']
  : ['-shared'];

const commonFlags = [
  ...archFlags,
  '-O2',
  '-fPIC',
  '-fvisibility=hidden',
  '-DNAPI_VERSION=8',
  `-I${md4cDir}`,
  `-I${cppDir}`,
  `-I${nodeInclude}`,
];

/* md4c.h is a dep of every unit here: the C sources include it directly and
 * OffsetParser.cpp pulls it in through <md4c.h>. */
const md4cHeaders = [
  path.join(md4cDir, 'md4c.h'),
  path.join(md4cDir, 'entity.h'),
];
const cppHeaders = [
  path.join(cppDir, 'OffsetParser.h'),
  path.join(cppDir, 'Protocol.h'),
];

/* md4c is compiled as C11, not C99: upstream repeats a `typedef struct
 * MD_FOOTNOTE_DEF_tag MD_FOOTNOTE_DEF;` and only C11 permits a duplicate
 * typedef. The vendored sources are never edited in place (see
 * vendor/md4c/UPSTREAM.md), so the dialect moves instead of the code. */
const units = [
  {
    source: path.join(md4cDir, 'md4c.c'),
    object: path.join(objDir, 'md4c.o'),
    compiler: cc,
    flags: ['-std=c11', '-c'],
    deps: md4cHeaders,
  },
  {
    source: path.join(md4cDir, 'entity.c'),
    object: path.join(objDir, 'entity.o'),
    compiler: cc,
    flags: ['-std=c11', '-c'],
    deps: md4cHeaders,
  },
  {
    source: path.join(cppDir, 'OffsetParser.cpp'),
    object: path.join(objDir, 'OffsetParser.o'),
    compiler: cxx,
    flags: ['-std=c++17', '-c'],
    deps: [...md4cHeaders, ...cppHeaders],
  },
  {
    source: path.join(cppDir, 'FlatBuffer.cpp'),
    object: path.join(objDir, 'FlatBuffer.o'),
    compiler: cxx,
    flags: ['-std=c++17', '-c'],
    deps: [...md4cHeaders, ...cppHeaders],
  },
  {
    source: path.join(addonDir, 'addon.cpp'),
    object: path.join(objDir, 'addon.o'),
    compiler: cxx,
    flags: ['-std=c++17', '-c'],
    deps: [...cppHeaders, path.join(nodeInclude, 'node_api.h')],
  },
];

for (const unit of units) {
  if (!existsSync(unit.source)) {
    fail(
      `missing source ${path.relative(repoRoot, unit.source)}`,
      'The native core is incomplete — this file is part of the parser, not ' +
        'of the harness.',
    );
  }
}

/* Everything above can still exit — no compiler, no headers, a missing
 * source — and none of it writes anything, so the lock is taken only once
 * this process knows it can really build. An unequipped machine must not
 * make five workers queue behind a directory nobody is ever going to build
 * in. From here down, build/ belongs to this process. */
mkdirSync(buildDir, { recursive: true });
acquireBuildLock();
mkdirSync(objDir, { recursive: true });

log('platform  ', `${process.platform}/${arch} (process.arch=${process.arch})`);
log('node      ', `${process.version} (${process.execPath})`);
log('headers   ', nodeInclude);
log('compilers ', `${cc} / ${cxx}`);

let relinkNeeded = force || !existsSync(addonPath);

for (const unit of units) {
  const rel = path.relative(repoRoot, unit.source);
  if (isUpToDate(unit.object, [unit.source, ...unit.deps])) {
    log('up to date', rel);
    continue;
  }
  log('compile   ', rel);
  run(
    unit.compiler,
    [...unit.flags, ...commonFlags, unit.source, '-o', unit.object],
    `compiling ${rel}`,
  );
  relinkNeeded = true;
}

const objects = units.map((unit) => unit.object);

if (!relinkNeeded && isUpToDate(addonPath, objects)) {
  /* Still verify: the module on disk may predate this guard, or have been
   * produced by a build that skipped it (see the WARNING path in
   * assertOnlyKnownUndefinedSymbols). `nm` costs milliseconds. */
  assertOnlyKnownUndefinedSymbols(addonPath);
  log('up to date', path.relative(repoRoot, addonPath));
  process.exit(0);
}

log('link      ', path.relative(repoRoot, addonPath));
run(
  cxx,
  [...archFlags, ...linkFlags, ...objects, '-o', tmpAddonPath],
  'linking the addon',
);

if (!existsSync(tmpAddonPath)) {
  fail('the linker reported success but produced no output file');
}

/* Before it is published, not after: a module that fails the guard is a
 * crash waiting for the right input, and the one thing worse than failing
 * the build is failing it with that module sitting at the path every test
 * and bench loads. */
assertOnlyKnownUndefinedSymbols(tmpAddonPath, addonPath);

const size = statSync(tmpAddonPath).size;
/* The publish. Atomic on POSIX, and readers holding the previous module keep
 * a valid mapping of it because the old inode outlives the name. (Windows
 * refuses to rename over a DLL some process still has loaded — but it also
 * refuses to let a linker overwrite one, so this is not a new constraint.) */
renameSync(tmpAddonPath, addonPath);
log('done      ', `${path.relative(repoRoot, addonPath)} (${size} bytes)`);
