/**
 * The bench harness as a GATE, not as a report.
 *
 * Three of these benches are wired into .github/workflows/ci.yml, where their
 * exit codes decide whether a pull request is red. That makes their failure
 * paths product behaviour: a gate that exits 0 on an empty run, or dies with a
 * TypeError on a flag combination, is worse than no gate at all — it is a
 * green check over nothing. So the cases below are the ones nobody exercises
 * by hand: no samples, no engine, a budget that must trip, a growth limit that
 * must trip.
 *
 * Everything is a subprocess. The benches are ESM scripts with top-level
 * `await` and `process.exit`, and the exit code IS the thing under test.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const benchDir = path.join(repoRoot, 'bench');
const sprintTranscript = path.join(
  repoRoot,
  'conformance',
  'fixtures',
  'transcript-sprint-review.json',
);
// The never-anchoring shape: one 420-item bullet list, which no blank line
// closes, so every append re-reads the whole accumulated text. It is the
// transcript the workflows gate.
const giantTranscript = path.join(
  repoRoot,
  'conformance',
  'fixtures',
  'transcript-giant-list.json',
);
const ciWorkflow = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const releaseWorkflow = path.join(repoRoot, '.github', 'workflows', 'release.yml');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

const runNode = (args: readonly string[], env?: NodeJS.ProcessEnv): Ran => {
  const result = spawnSync(process.execPath, [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
};

const pathological = path.join(benchDir, 'pathological.mjs');
const projection = path.join(benchDir, 'projection.mjs');
const streaming = path.join(benchDir, 'streaming-replay.mjs');

// The benches need dist/ and the compiled addon. Both exist in CI (npm ci runs
// `prepare`, and the addon build is a hard gate before `npm test`) and on any
// machine that has run `npm run build`. Where they do not, `bench/support.mjs`
// would spawn a full `npm run build` inside a test — so the suite reports the
// missing prerequisite instead of timing out on it.
const distReady = fs.existsSync(path.join(repoRoot, 'dist', 'engine', 'Engine.js'));
const addonReady = fs.existsSync(
  path.join(repoRoot, 'build', `selectable-markdown.${process.platform}-${process.arch}.node`),
);
const describeBench = distReady && addonReady ? describe : describe.skip;

describeBench('bench:pathological as a gate', () => {
  it('reports rather than crashing when --runs asks for no samples', () => {
    const ran = runNode([pathological, '--quick', '--runs', '0']);

    // The regression: the no-samples branch dereferenced `crash.stage` with no
    // null check, so this exact command died with
    // `TypeError: Cannot read properties of null (reading 'stage')`.
    expect(ran.stderr).not.toContain('TypeError');
    expect(ran.stderr).not.toContain("reading 'stage'");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('no samples');
  });

  it('fails a --budget run that produced no samples, instead of passing over nothing', () => {
    const ran = runNode([pathological, '--quick', '--runs', '0', '--budget', '1000']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('a gate over nothing is a failure');
  });

  it('gates each stage at its own budget', () => {
    // `segment` is tens of microseconds on these inputs, so under one global
    // budget loose enough for the parse it could get a hundred times slower
    // and still pass. A per-stage budget is the only thing that sees it.
    const ran = runNode([pathological, '--quick', '--budget-segment', '0.0001']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/OVER\s+segment/);
    expect(ran.stdout).toContain('budget exceeded');

    // The other stages are ungated in that run: passing one override must not
    // silently apply it everywhere.
    expect(ran.stdout).toMatch(/ok\s+parse/);
  });

  it('passes the workflow invocation on this machine', () => {
    // Exactly what .github/workflows/ci.yml runs, so a budget tightened below
    // what the library actually costs turns this suite red before it turns
    // every pull request red.
    const ran = runNode([
      pathological,
      '--require-engine',
      '--budget-parse',
      '750',
      '--budget-repair',
      '750',
      '--budget-segment',
      '200',
      '--budget-project',
      '750',
    ]);

    expect(ran.output).not.toContain('measured nothing');
    expect(ran.status).toBe(0);
  });
});

describe('--require-engine', () => {
  // The failure path cannot be reached by breaking the addon (the harness
  // rebuilds it), so it is exercised where it is implemented: the helper every
  // gated bench calls when its engine came back null.
  const probe = (flags: readonly string[]): Ran => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-require-engine-'));
    const file = path.join(dir, 'probe.mjs');
    const support = new URL(`file://${path.join(benchDir, 'support.mjs')}`).href;
    fs.writeFileSync(
      file,
      `import { exitWithoutEngine } from ${JSON.stringify(support)};\n` +
        "exitWithoutEngine('[probe]');\n",
    );
    try {
      return runNode([file, ...flags]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 without the flag — a laptop with no toolchain is not a regression', () => {
    const ran = probe([]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('pass --require-engine');
  });

  it('exits 1 with the flag, so a CI gate cannot pass having measured nothing', () => {
    const ran = probe(['--require-engine']);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('measured nothing');
  });
});

describeBench('bench:projection as a gate', () => {
  it('passes on the anchoring transcript and prints the threshold it gated on', () => {
    const ran = runNode([projection, '--transcript', sprintTranscript, '--require-engine']);

    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(/gate: cached <= 1\.25x/);
    expect(ran.stdout).toMatch(/growth {2}cached=/);
  });

  it('exits 1 when cached growth passes the limit', () => {
    // The gate fires on a number this corpus does not produce (cached growth
    // measures ~1.00), so the limit is lowered in a copy of the bench rather
    // than the corpus being bent to produce a regression. The copy lives in
    // bench/ because it imports ./support.mjs relatively.
    const copy = path.join(benchDir, `.growth-gate-probe.${process.pid}.mjs`);
    const source = fs.readFileSync(projection, 'utf8').replace(
      'const GROWTH_LIMIT = 1.25;',
      'const GROWTH_LIMIT = 0.5;',
    );
    expect(source).toContain('const GROWTH_LIMIT = 0.5;');
    fs.writeFileSync(copy, source);
    try {
      const ran = runNode([copy, '--transcript', sprintTranscript]);
      expect(ran.status).toBe(1);
      expect(ran.stdout).toMatch(/growth {2}OVER/);
      expect(ran.stderr).toContain('cached amplification grew');
    } finally {
      fs.rmSync(copy, { force: true });
    }
  });

  it('has no gate to run under --quick, and says so rather than passing quietly', () => {
    // One document size means no growth ratio: the run must not print a gate
    // verdict it did not compute.
    const ran = runNode([projection, '--quick', '--transcript', sprintTranscript]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).not.toMatch(/growth {2}cached=/);
  });
});

describeBench('bench:streaming reports matched statistics', () => {
  // The ratio used to divide a SUM of every append time by a MEDIAN full parse
  // times the chunk count — a statistic mismatch that made the printed figure
  // move with this machine's noise, and let two docs quote it in opposite
  // directions. Both sides are now the median of per-replay totals.
  const ran = (): Ran => runNode([streaming, '--quick', '--transcript', sprintTranscript]);

  it('prints both sides of the ratio as the same statistic over the same count', () => {
    const out = ran().stdout;

    const streamed = out.match(
      /streamed\s+([\d.]+) ms = median of (\d+) replay\(s\), each the SUM of its (\d+) append times/,
    );
    const naive = out.match(
      /naive\s+([\d.]+) ms = median of (\d+) replay\(s\), each the SUM of (\d+) full reparses/,
    );
    expect(streamed).not.toBeNull();
    expect(naive).not.toBeNull();

    // Same estimator (median of per-replay sums), same number of replays, same
    // chunk count on both sides. Any of the three differing is the defect.
    expect(naive![2]).toBe(streamed![2]);
    expect(naive![3]).toBe(streamed![3]);
  });

  it('prints a ratio that is the quotient of the two numbers beside it', () => {
    const out = ran().stdout;
    const ratio = Number(out.match(/incremental-vs-full reparse ratio: ([\d.]+)/)![1]);
    const streamedMs = Number(out.match(/streamed\s+([\d.]+) ms = median/)![1]);
    const naiveMs = Number(out.match(/naive\s+([\d.]+) ms = median/)![1]);

    // Both totals are printed to two decimals, so the quotient can only be
    // recomputed to within their rounding — compared relatively for that
    // reason. What this pins is that the ratio is those two terms and not some
    // third quantity the reader cannot see (the defect it replaces was off by
    // the ratio of a sum to a median, which is not a few percent).
    const recomputed = streamedMs / naiveMs;
    expect(Math.abs(ratio - recomputed) / recomputed).toBeLessThan(0.1);
  });
});

describeBench('bench:streaming as a gate', () => {
  // Until --budget existed this bench had no threshold, no non-zero exit and no
  // workflow: the adversarial STREAMING shape was reported and never gated,
  // while bench/pathological.mjs's header claimed `bench:streaming` owned the
  // question. These are the paths that make the claim true.
  const giant = (flags: readonly string[]): Ran =>
    runNode([streaming, '--transcript', giantTranscript, '--repeat', '1', ...flags]);

  it('exits 1 when a chunk p99 passes its budget', () => {
    // The budget is set below what any machine can hit rather than the corpus
    // being bent into a regression.
    const ran = giant(['--budget-chunk', '0.0001']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/OVER\s+chunk p99/);
    expect(ran.stdout).toContain('budget exceeded');
  }, 120_000);

  it('leaves the number nobody budgeted ungated', () => {
    // Passing one override must not silently gate everything, the same rule
    // bench:pathological's per-stage budgets follow.
    const ran = giant(['--budget-chunk', '0.0001']);
    expect(ran.stdout).toMatch(/off\s+finalize/);
  }, 120_000);

  it('fails a budgeted run that timed nothing, instead of passing over zero samples', () => {
    const ran = giant(['--max-chunks', '0', '--budget-chunk', '20']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('a gate over nothing is a failure');
  }, 120_000);

  it('reports rather than failing when no budget is passed', () => {
    // `npm run bench:streaming` on a laptop is a report: the absolute
    // milliseconds belong to the machine.
    const ran = giant([]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).not.toContain('budget exceeded');
  }, 120_000);

  it('passes the workflow invocation on this machine', () => {
    // Exactly what both workflows run, so a budget tightened below what the
    // library actually costs turns this suite red before it turns every pull
    // request red.
    const ran = giant(['--require-engine', '--budget-chunk', '20', '--budget-finalize', '50']);

    expect(ran.output).not.toContain('measured nothing');
    expect(ran.stdout).toMatch(/ok\s+chunk p99/);
    expect(ran.stdout).toMatch(/ok\s+finalize/);
    expect(ran.status).toBe(0);
  }, 120_000);
});

describe('bench:streaming is wired in as a gate, not only implemented as one', () => {
  const source = fs.readFileSync(streaming, 'utf8');

  it('exits through exitWithoutEngine rather than a bare process.exit(0)', () => {
    // A step that exits 0 having measured nothing is a green gate over zero
    // samples — the exact hole --require-engine closed for the other benches.
    // This file kept two bare `process.exit(0)` calls (unresolvable engine,
    // unusable StreamSession), so wiring it into CI as it stood would have
    // reintroduced it.
    expect(source).not.toContain('process.exit(0)');
    expect(source).toContain('exitWithoutEngine');
  });

  it('runs in ci.yml and release.yml with a budget and --require-engine', () => {
    for (const file of [ciWorkflow, releaseWorkflow]) {
      const runnable = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');

      expect(runnable).toContain('npm run bench:streaming');
      const step = runnable.slice(runnable.indexOf('npm run bench:streaming'));
      const flags = step.slice(0, step.indexOf('- run:'));
      expect(flags).toContain('conformance/fixtures/transcript-giant-list.json');
      expect(flags).toContain('--require-engine');
      expect(flags).toMatch(/--budget-chunk \d/);
      expect(flags).toMatch(/--budget-finalize \d/);
    }
  });

  it("no longer claims bench:streaming gates nothing", () => {
    // bench/pathological.mjs justifies having no streaming stage by pointing at
    // this bench. That sentence was true about the harness and false about the
    // gate until the budget existed.
    const pathologicalSource = fs.readFileSync(pathological, 'utf8');
    expect(pathologicalSource).toContain('`bench:streaming` owns that');
    expect(pathologicalSource).toMatch(/gates it/);
  });
});
