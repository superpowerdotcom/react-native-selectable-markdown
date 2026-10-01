/** Bench failure paths, run as subprocesses because the exit code is what CI gates on. */
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
const giantTranscript = path.join(
  repoRoot,
  'conformance',
  'fixtures',
  'transcript-giant-list.json',
);

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
    timeout: 110_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
};

const pathological = path.join(benchDir, 'pathological.mjs');
const projection = path.join(benchDir, 'projection.mjs');
const streaming = path.join(benchDir, 'streaming-replay.mjs');

// Skipped without dist/ and the addon: support.mjs would otherwise run a full build in the test.
const distReady = fs.existsSync(path.join(repoRoot, 'dist', 'engine', 'Engine.js'));
const addonReady = fs.existsSync(
  path.join(repoRoot, 'build', `selectable-markdown.${process.platform}-${process.arch}.node`),
);
if (process.env.CI && (!distReady || !addonReady)) {
  throw new Error('Benchmark tests require the built library and native addon in CI.');
}
const describeBench = distReady && addonReady ? describe : describe.skip;
jest.setTimeout(120_000);

describeBench('bench:pathological as a gate', () => {
  it('reports rather than crashing when --runs asks for no samples', () => {
    const ran = runNode([pathological, '--quick', '--runs', '0']);

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
    const ran = runNode([pathological, '--quick', '--budget-segment', '0.0001']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/OVER\s+segment/);
    expect(ran.stdout).toContain('budget exceeded');

    // One override must not gate the other stages.
    expect(ran.stdout).toMatch(/ok\s+parse/);
  });
});

describe('--require-engine', () => {
  // Breaking the addon cannot reach this path (the harness rebuilds it), so the helper is probed.
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
    // This corpus never trips the limit, so a copy of the bench lowers it.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rnsm-growth-gate-'));
    const copy = path.join(scratch, 'projection.mjs');
    const source = fs.readFileSync(projection, 'utf8').replace(
      'const GROWTH_LIMIT = 1.25;',
      'const GROWTH_LIMIT = 0.5;',
    ).replace("'./support.mjs'", JSON.stringify(new URL(`file://${path.join(benchDir, 'support.mjs')}`).href));
    expect(source).toContain('const GROWTH_LIMIT = 0.5;');
    fs.writeFileSync(copy, source);
    try {
      const ran = runNode([copy, '--transcript', sprintTranscript]);
      expect(ran.status).toBe(1);
      expect(ran.stdout).toMatch(/growth {2}OVER/);
      expect(ran.stderr).toContain('cached amplification grew');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('has no gate to run under --quick, so it measures one size and prints no verdict', () => {
    const ran = runNode([projection, '--quick', '--transcript', sprintTranscript]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(/ 1x cached doc= {3}1,162 /);
    expect(ran.stdout).not.toMatch(/ 2x cached /);
    expect(ran.stdout).not.toMatch(/growth {2}cached=/);
  });
});

describeBench('bench:streaming reports matched statistics', () => {
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

    // --quick is one replay, and the transcript is 131 deltas.
    expect([streamed![2], streamed![3]]).toEqual(['1', '131']);
    expect([naive![2], naive![3]]).toEqual(['1', '131']);
  });

  it('prints a ratio that is the quotient of the two numbers beside it', () => {
    const out = ran().stdout;
    const ratio = Number(out.match(/incremental-vs-full reparse ratio: ([\d.]+)/)![1]);
    const streamedMs = Number(out.match(/streamed\s+([\d.]+) ms = median/)![1]);
    const naiveMs = Number(out.match(/naive\s+([\d.]+) ms = median/)![1]);

    // Relative, because both totals are printed rounded to two decimals.
    const recomputed = streamedMs / naiveMs;
    expect(Math.abs(ratio - recomputed) / recomputed).toBeLessThan(0.1);
  });
});

describeBench('bench:streaming as a gate', () => {
  const giant = (flags: readonly string[]): Ran =>
    runNode([streaming, '--transcript', giantTranscript, '--repeat', '1', ...flags]);

  it('exits 1 when a chunk p99 passes its budget', () => {
    const ran = giant(['--budget-chunk', '0.0001']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toMatch(/OVER\s+chunk p99/);
    expect(ran.stdout).toContain('budget exceeded');
  }, 120_000);

  it('leaves the number nobody budgeted ungated', () => {
    const ran = giant(['--budget-chunk', '0.0001']);
    expect(ran.stdout).toMatch(/off\s+finalize/);
  }, 120_000);

  it('fails a budgeted run that timed nothing, instead of passing over zero samples', () => {
    const ran = giant(['--max-chunks', '0', '--budget-chunk', '20']);

    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('a gate over nothing is a failure');
  }, 120_000);

  it('reports rather than failing when no budget is passed', () => {
    const ran = giant([]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('chunks:    2484 (21927 UTF-16 units), 1 replay(s)');
    expect(ran.stdout).not.toContain('budget exceeded');
  }, 120_000);
});
