/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// GitHub does not start runs for a workflow file over 500 KB (512,000 bytes)
// and reports nothing when it stops — see .github/scripts/check-workflow-size.sh
// and .github/workflows/qwen-autofix.md for the incident this encodes.
const GITHUB_LIMIT_BYTES = 512_000;
const WORKFLOW_DIR = '.github/workflows';
const gateScript = readFileSync(
  '.github/scripts/check-workflow-size.sh',
  'utf8',
);
const ciWorkflow = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8');

const gateBytes = Number(
  gateScript.match(/GATE_BYTES="\$\{WORKFLOW_SIZE_GATE_BYTES:-(\d+)\}"/)?.[1],
);

const workflowNames = readdirSync(WORKFLOW_DIR).filter(
  (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
);
const workflowFiles = workflowNames.map((name) => join(WORKFLOW_DIR, name));

describe('workflow file size', () => {
  it('keeps the gate below GitHub 500 KB start-runs limit', () => {
    expect(gateBytes).toBeGreaterThan(0);
    expect(gateBytes).toBeLessThan(GITHUB_LIMIT_BYTES);
  });

  it.each(workflowFiles)('%s stays under the gate', (file) => {
    const bytes = Buffer.byteLength(readFileSync(file));
    expect(bytes).toBeLessThan(gateBytes);
  });

  it('runs the gate on every CI profile, not just full', () => {
    // A .github-only PR classifies as `github_ci_only`; gating the check on the
    // `full` profile would skip it for exactly the changes that can trip it.
    const step = ciWorkflow.match(
      /- name: 'Check workflow file size'[\s\S]*?run: '(.+?)'/,
    );
    expect(step?.[1]).toBe('.github/scripts/check-workflow-size.sh');
    expect(step?.[0]).toContain(
      'if: "${{ needs.classify_pr.outputs.skip_ci != \'true\' }}"',
    );
    expect(step?.[0]).not.toContain('ci_profile');
  });

  it('wires the base SHA once at workflow level so every lane inherits it', () => {
    // The ratchet's PR-scope fix (#9904) hangs off this env: without it the
    // gate and its vitest mirror have no base to compare against and
    // silently degrade to the pre-fix red wall. Declared once at workflow
    // level, it reaches the gate step AND every `npm run test:ci` lane —
    // including the merge-queue lanes where the mirror is the only ratchet
    // enforcer — without each step hand-wiring a copy a future lane could
    // forget.
    const workflowEnv = ciWorkflow.match(/^env:[\s\S]*?\njobs:/m)?.[0];
    // Anchored to the whole line: substring checks still pass a `||` → `&&`
    // mutation (empty on both events — the #9904 red wall returns) and an
    // appended `|| github.sha` fallback (workflow_dispatch resolves the base
    // to the checked-out commit, failing the ratchet open on that lane).
    expect(workflowEnv).toMatch(
      /^\s*WORKFLOW_SIZE_BASE_SHA: '\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}'$/m,
    );
  });
});

// The shell gate receives the PR's base SHA so a stale baseline — growth that
// landed on main without the same-PR baseline bump — warns instead of
// red-walling unrelated PRs (#9904). This mirror is the ONLY enforcer on the
// merge-queue lanes that never run the bash script, so it applies the same
// leniency to both the over-allowance and the missing-entry arms: a file
// byte-identical to the base passes. An unset base fails closed, and an
// unresolvable base throws instead of returning false: like the gate's
// exit-2 arm, a transient fetch failure and genuine PR growth need opposite
// remedies, so the failure says which one it is instead of blaming the PR's
// growth.
const fileMatchesBase = (file) => {
  const baseSha = (process.env.WORKFLOW_SIZE_BASE_SHA ?? '').trim();
  if (!baseSha) return false;
  // node:path join emits backslashes on the merge-queue Windows lane; git
  // pathspecs want forward slashes, and normalizing once covers the
  // readFileSync below on every platform.
  const repoPath = file.split(/[\\/]/).join('/');
  let resolved =
    spawnSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`],
      { stdio: 'ignore' },
    ).status === 0;
  if (!resolved) {
    resolved =
      spawnSync('git', ['fetch', '--depth=1', '--quiet', 'origin', baseSha], {
        // stderr inherits so a fetch failure leaves its trace in the log.
        stdio: ['ignore', 'ignore', 'inherit'],
      }).status === 0;
  }
  if (!resolved) {
    throw new Error(
      `base ${baseSha} could not be resolved (transient git fetch failure? re-run the job)`,
    );
  }
  const baseCopy = spawnSync('git', ['show', `${baseSha}:${repoPath}`]);
  return (
    baseCopy.status === 0 &&
    Buffer.compare(baseCopy.stdout, readFileSync(repoPath)) === 0
  );
};

describe('workflow size growth ratchet', () => {
  // The absolute gate is a ceiling: it only objects once a file is nearly at
  // the wall, so growth accrues unremarked until one PR has to pay for
  // everyone. qwen-autofix.yml regained 78 KB when its prose moved out and
  // gave 25 KB back in one feature commit two days later. The ratchet turns
  // that drift into a reviewed line.
  const baselinePath = join(WORKFLOW_DIR, '.size-baseline');
  const baselineLines = readFileSync(baselinePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'));
  const baseline = new Map(
    baselineLines
      .map((l) => l.trim().split(/\s+/))
      .map(([bytes, name]) => [name, Number(bytes)]),
  );
  // node:path join emits backslashes on the merge-queue Windows lane, where
  // splitting on '/' alone finds no separator and hands back the whole path
  // as the key — every baseline lookup must accept both separators.
  const workflowName = (file) => file.split(/[\\/]/).pop();
  const allowance = Number(
    gateScript.match(
      /GROWTH_ALLOWANCE="\$\{WORKFLOW_SIZE_GROWTH_ALLOWANCE:-(\d+)\}"/,
    )?.[1],
  );

  it('reads a positive allowance from the gate script', () => {
    expect(allowance).toBeGreaterThan(0);
  });

  it('keys win32-style paths by the file name too (merge-queue Windows lane)', () => {
    for (const name of workflowNames) {
      expect(workflowName(win32.join(WORKFLOW_DIR, name))).toBe(name);
    }
  });

  it.each(workflowFiles)('%s has a baseline entry', (file) => {
    if (baseline.has(workflowName(file))) return;
    // Stale-baseline leniency (#9904), mirroring the shell gate's
    // missing-entry arm: a workflow that reached main without an entry
    // (bypass merge, misclassification, gate outage) is main-side drift, and
    // hard-failing every unrelated PR here relocates the exact red wall this
    // PR removes into `npm run test:ci`.
    expect(
      fileMatchesBase(file),
      `${file} has no entry in .size-baseline and differs from the PR's base — add its byte size to .size-baseline in this PR so its growth is tracked`,
    ).toBe(true);
  });

  it.each(workflowFiles)('%s is within its baseline allowance', (file) => {
    const bytes = Buffer.byteLength(readFileSync(file));
    const recorded = baseline.get(workflowName(file));
    // An entry-less file renders NaN/undefined below; the missing-entry test
    // above owns that state.
    if (recorded === undefined) return;
    if (bytes <= recorded + allowance) return;
    // Stale-baseline leniency (#9904), mirroring the shell gate: overage on
    // a file byte-identical to the PR's base is main-side drift, not this
    // PR's growth. Without this the gate warns but the mirror still fails
    // the run, relocating the red wall into `npm run test:ci`.
    expect(
      fileMatchesBase(file),
      `${file} is ${bytes - recorded} bytes over its recorded ${recorded} and differs from the PR's base — move prose into a sibling .md and long steps into .github/scripts/, or, if the growth is real, update .size-baseline in this PR and say why`,
    ).toBe(true);
  });

  it('records no file that no longer exists', () => {
    const present = new Set(workflowFiles.map((f) => workflowName(f)));
    expect([...baseline.keys()].filter((n) => !present.has(n))).toEqual([]);
  });

  it('keeps every baseline at or under the gate', () => {
    // A baseline above the gate would let the ratchet pass a file the ceiling
    // rejects, so the two gates can never disagree about what is allowed.
    expect([...baseline].filter(([, b]) => b > gateBytes)).toEqual([]);
  });

  it('keeps every baseline entry in the format the gate parses', () => {
    // The gate fails closed on lines that are not exactly '<bytes> <file>'
    // with a decimal byte count; this mirror must red on the same lines here
    // instead of keying on field 2 while CI keys on the rest of the line.
    for (const line of baselineLines) {
      const fields = line.trim().split(/\s+/);
      expect(fields, line).toHaveLength(2);
      expect(fields[0], line).toMatch(/^(0|[1-9][0-9]*)$/);
    }
  });
});

// The gate script's `declare -A baseline=()` needs bash 4+. The merge-queue
// macOS lane ships bash 3.2, where the assoc-array errors leave the ratchet
// failing open, so probe the capability rather than the platform: that lane
// must skip instead of reporting red on a script it cannot execute.
const bashSupportsAssocArrays =
  spawnSync('bash', ['-c', 'declare -A t=()'], { stdio: 'ignore' }).status ===
  0;
// The stale-baseline fixtures commit their base with git. Only the fixtures
// need it — the strict-path tests above run on a git-less runner too, so
// gate the git block separately instead of folding git into this skip.
const gitAvailable =
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const gatePath = join(
  process.cwd(),
  '.github',
  'scripts',
  'check-workflow-size.sh',
);
// The gate reads three WORKFLOW_SIZE_* knobs, and the git fixtures commit
// through the developer's git config — scrub both, because a leak from the
// surrounding shell must not change what the fixtures assert: a leaked
// WORKFLOW_SIZE_BASE_SHA flips the fail-closed fixtures to the warning path,
// a leaked WORKFLOW_SIZE_GROWTH_ALLOWANCE flips a one-byte-over failure
// green, and a global commit.gpgsign or hooksPath breaks `git commit`
// silently the same way.
const hermeticGateEnv = (dir) => {
  const env = { ...process.env };
  delete env.WORKFLOW_SIZE_BASE_SHA;
  delete env.WORKFLOW_SIZE_GATE_BYTES;
  delete env.WORKFLOW_SIZE_GROWTH_ALLOWANCE;
  const gitconfigPath = join(dir, 'fixture-gitconfig');
  writeFileSync(gitconfigPath, '');
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfigPath,
  });
};

// Both fetch-arm fixtures need the same shape: a bare origin whose base
// commit sits behind an unrelated tip, so a depth-1 clone of the tip lacks
// the base and any success must come from the runtime's own fetch. Building
// it once keeps the gate's fixture and the mirror's from drifting — the clone
// URL spelling already drifted between the two copies.
const seedShallowClone = ({ root, env, seedFiles }) => {
  const bare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const checkout = join(root, 'checkout');
  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
    return r;
  };
  mkdirSync(seed, { recursive: true });
  git(['init', '--quiet', '--bare', bare], root);
  // The bare repo's HEAD defaults to refs/heads/master; point it at the
  // branch the seed pushes so the clone checks files out at all.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare);
  git(['init', '--quiet'], seed);
  git(['config', 'user.email', 'gate-test@example.com'], seed);
  git(['config', 'user.name', 'gate-test'], seed);
  for (const [relPath, contents] of Object.entries(seedFiles)) {
    const filePath = join(seed, relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  git(['add', '.'], seed);
  git(['commit', '--quiet', '-m', 'base'], seed);
  const baseSha = git(['rev-parse', 'HEAD'], seed).stdout.trim();
  // A second commit touching only an unrelated file pushes the base behind
  // the tip, so a depth-1 clone does not contain it.
  writeFileSync(join(seed, 'README.md'), 'unrelated tip change\n');
  git(['add', '.'], seed);
  git(['commit', '--quiet', '-m', 'unrelated tip'], seed);
  git(['remote', 'add', 'origin', bare], seed);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
  // Depth-1 clone holds only the tip; the base commit needs a fetch. The
  // file:// URL matters: a plain local path ignores --depth and copies
  // full history, which would hide the fetch under test.
  git(
    ['clone', '--quiet', '--depth', '1', pathToFileURL(bare).href, checkout],
    root,
  );
  return { checkout, baseSha };
};

describe.skipIf(process.platform === 'win32' || !bashSupportsAssocArrays)(
  'check-workflow-size.sh execution',
  () => {
    // The block above re-implements the gate's arithmetic in JS; only running
    // the real script pins its decision branches (growth, missing entry,
    // missing baseline, slack warning, malformed line).
    const runGate = ({ files, baseline, commitBase, dirtyFiles, baseSha }) => {
      const dir = mkdtempSync(join(tmpdir(), 'workflow-size-gate-'));
      try {
        const fixtureDir = join(dir, WORKFLOW_DIR);
        mkdirSync(fixtureDir, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) {
          writeFileSync(join(fixtureDir, name), 'a'.repeat(bytes));
        }
        if (baseline !== undefined) {
          writeFileSync(join(fixtureDir, '.size-baseline'), baseline);
        }
        const env = hermeticGateEnv(dir);
        if (commitBase) {
          // Stand in for the PR's base commit: the caller may then dirty
          // files to simulate what the PR itself changed on top.
          const git = (args) =>
            spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
          expect(git(['init', '--quiet']).status, 'git init failed').toBe(0);
          git(['config', 'user.email', 'gate-test@example.com']);
          git(['config', 'user.name', 'gate-test']);
          git(['add', '.']);
          expect(
            git(['commit', '--quiet', '-m', 'base']).status,
            'git commit failed',
          ).toBe(0);
          env.WORKFLOW_SIZE_BASE_SHA =
            baseSha ?? git(['rev-parse', 'HEAD']).stdout.trim();
        }
        for (const [name, bytes] of Object.entries(dirtyFiles ?? {})) {
          writeFileSync(join(fixtureDir, name), 'a'.repeat(bytes));
        }
        return spawnSync('bash', [gatePath], {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('passes a workflow at its recorded size', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '100 small.yml\n',
      });
      expect(result.status).toBe(0);
      // The clean banner keeps its allowance claim; only a run that emitted a
      // stale-baseline warning qualifies it — a ✅ that contradicts a warning
      // in the same log is how the #9904 drift used to read.
      expect(result.stdout).toContain(
        'within 4096 bytes of its recorded baseline',
      );
    });

    it('passes a workflow grown within its allowance', () => {
      const result = runGate({
        files: { 'small.yml': 4000 },
        baseline: '100 small.yml\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('passes a workflow at exactly baseline plus allowance', () => {
      const result = runGate({
        files: { 'small.yml': 4196 },
        baseline: '100 small.yml\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('fails a workflow one byte past baseline plus allowance', () => {
      const result = runGate({
        files: { 'small.yml': 4197 },
        baseline: '100 small.yml\n',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('grew to 4197 bytes');
    });

    it('fails a workflow grown past its baseline plus allowance', () => {
      const result = runGate({
        files: { 'small.yml': 5000 },
        baseline: '100 small.yml\n',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('grew to 5000 bytes');
    });

    it('fails a workflow with no baseline entry', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '# header only\n',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('has no entry');
      expect(result.stdout).toContain("Add '100 small.yml'");
    });

    it('fails closed when the baseline file is missing', () => {
      const result = runGate({ files: { 'small.yml': 100 } });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing or unreadable');
    });

    it('fails closed on a value that is not a decimal byte count', () => {
      // Bash evaluates leading zeros as octal and errors on non-numeric
      // values at the arithmetic sites; either failure mode used to leave
      // the ratchet green.
      for (const bad of ['4l9995', '1e3', '09023', '0070142']) {
        const result = runGate({
          files: { 'small.yml': 100 },
          baseline: `${bad} small.yml\n`,
        });
        expect(result.status, bad).toBe(1);
        expect(result.stdout, bad).toContain('is malformed');
      }
    });

    it('fails closed on a line with extra fields', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '70142 small.yml # bumped for the build-cache job\n',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('is malformed');
    });

    it('keeps an unterminated final baseline line', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '100 small.yml',
      });
      expect(result.status).toBe(0);
    });

    it('warns when a file shrinks far below its baseline', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '30000 small.yml\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('::warning');
      expect(result.stdout).toContain('under its recorded 30000');
    });

    // SLACK_BYTES is 20000 in the gate script; these two fixtures pin the
    // boundary itself, not just the warning branch.
    it('warns when a file sits more than the slack under its baseline', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '20101 small.yml\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('::warning');
      expect(result.stdout).toContain('under its recorded 20101');
    });

    it('does not warn at exactly the slack under its baseline', () => {
      const result = runGate({
        files: { 'small.yml': 100 },
        baseline: '20100 small.yml\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('::warning');
    });

    it('fails a file past the absolute gate', () => {
      const result = runGate({
        files: { 'big.yml': 470_001 },
        baseline: '470001 big.yml\n',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("past this repo's");
    });

    // #9904: a workflow that grew on main without the same-PR baseline bump
    // used to red-wall every OTHER open PR. A PR whose copy of the file is
    // byte-identical to its base did not cause the drift and must only see
    // a warning; the hard failure belongs to the PR that changes the file.
    // These fixtures commit their base with git, hence their own skip gate.
    describe.skipIf(!gitAvailable)('#9904 PR-scope downgrade', () => {
      it('warns instead of failing when the PR did not touch the file', () => {
        const result = runGate({
          files: { 'small.yml': 5000 },
          baseline: '100 small.yml\n',
          commitBase: true,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('::warning');
        expect(result.stdout).toContain('the baseline went stale on main');
        expect(result.stdout).not.toContain('::error');
        // The success banner must not claim every file is within allowance
        // on the very run that warned it is not.
        expect(result.stdout).toContain('stale-baseline warnings above');
      });

      it('still fails when the PR changed the file past the allowance', () => {
        const result = runGate({
          files: { 'small.yml': 5000 },
          baseline: '100 small.yml\n',
          commitBase: true,
          dirtyFiles: { 'small.yml': 5001 },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('grew to 5001 bytes');
      });

      it('fails closed when the base commit cannot be resolved', () => {
        // A base sha that is neither present nor fetchable must keep the
        // strict failure — downgrading on an unverifiable base would fail
        // the ratchet open. The annotation must also say which case this
        // is: a transient fetch failure and genuine growth need opposite
        // remedies (re-run the job vs bump the baseline).
        const result = runGate({
          files: { 'small.yml': 5000 },
          baseline: '100 small.yml\n',
          commitBase: true,
          baseSha: '0'.repeat(40),
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('grew to 5000 bytes');
        expect(result.stdout).toContain('could not be resolved');
        expect(result.stdout).toContain('re-run the job');
      });

      it('warns on a missing entry when the PR did not touch the file', () => {
        // A workflow that reached main without a baseline entry (bypass
        // merge, misclassification, gate outage) has the same red-wall
        // shape as a stale size: every open PR fails on a bookkeeping fix
        // its author cannot perform. Unchanged from base → warning.
        const result = runGate({
          files: { 'small.yml': 100 },
          baseline: '# header only\n',
          commitBase: true,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('::warning');
        expect(result.stdout).toContain('has no entry');
        expect(result.stdout).not.toContain('::error');
      });

      it('fails on a missing entry when the PR changed the file', () => {
        const result = runGate({
          files: { 'small.yml': 100 },
          baseline: '# header only\n',
          commitBase: true,
          dirtyFiles: { 'small.yml': 200 },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('has no entry');
      });

      it('fails closed on a missing entry when the base cannot be resolved', () => {
        const result = runGate({
          files: { 'small.yml': 100 },
          baseline: '# header only\n',
          commitBase: true,
          baseSha: '0'.repeat(40),
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('has no entry');
        expect(result.stdout).toContain('could not be resolved');
      });

      it('still fails when the PR adds a brand-new file past the allowance', () => {
        // "Absent from the base commit" is a CHANGED file, not an unchanged
        // one: `git show` fails and pipes an empty copy into cmp, so the PR
        // that introduces a grown workflow owns it. A future simplification
        // treating a failed `git show` as "nothing to compare" would
        // downgrade exactly the PR the ratchet exists to catch.
        const result = runGate({
          files: { 'other.yml': 100 },
          baseline: '100 other.yml\n100 small2.yml\n',
          commitBase: true,
          dirtyFiles: { 'small2.yml': 5000 },
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('grew to 5000 bytes');
      });

      it('fetches the base commit when it is not local (CI shallow-clone path)', () => {
        // The production path: ci.yml checks out at fetch-depth 1, so the
        // PR's base commit is never present locally and the gate must reach
        // it via `git fetch --depth=1 origin <sha>` — runGate cannot stage
        // that, because it commits into the same repo the script inspects.
        // Removing the fetch line from the script must turn this test red.
        const dir = mkdtempSync(join(tmpdir(), 'workflow-size-gate-fetch-'));
        try {
          const env = hermeticGateEnv(dir);
          const { checkout, baseSha } = seedShallowClone({
            root: dir,
            env,
            seedFiles: {
              [join(WORKFLOW_DIR, 'small.yml')]: 'a'.repeat(5000),
              [join(WORKFLOW_DIR, '.size-baseline')]: '100 small.yml\n',
            },
          });
          env.WORKFLOW_SIZE_BASE_SHA = baseSha;
          const result = spawnSync('bash', [gatePath], {
            cwd: checkout,
            encoding: 'utf8',
            env,
          });
          expect(result.status).toBe(0);
          expect(result.stdout).toContain('::warning');
          expect(result.stdout).toContain('the baseline went stale on main');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  },
);

// The mirror spawns only git, so its fixtures gate on git alone — not on the
// bash assoc-array capability the SCRIPT needs. They must run on the
// merge-group Windows and macOS lanes, where the bash gate never runs and
// this mirror is the only ratchet enforcer.
describe.skipIf(!gitAvailable)(
  'fileMatchesBase — the vitest mirror of the leniency',
  () => {
    let dir;
    let baseSha;
    let restoreCwd;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'workflow-size-mirror-'));
      const env = hermeticGateEnv(dir);
      mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
      writeFileSync(join(dir, WORKFLOW_DIR, 'small.yml'), 'base content\n');
      const git = (args) => {
        const r = spawnSync('git', args, {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
        expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
        return r;
      };
      git(['init', '--quiet']);
      git(['config', 'user.email', 'gate-test@example.com']);
      git(['config', 'user.name', 'gate-test']);
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'base']);
      baseSha = git(['rev-parse', 'HEAD']).stdout.trim();
      restoreCwd = process.cwd();
      process.chdir(dir);
    });
    afterAll(() => {
      process.chdir(restoreCwd);
      delete process.env.WORKFLOW_SIZE_BASE_SHA;
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns false when no base SHA is set', () => {
      delete process.env.WORKFLOW_SIZE_BASE_SHA;
      expect(fileMatchesBase(join(WORKFLOW_DIR, 'small.yml'))).toBe(false);
    });

    it('returns true for a file byte-identical to the base', () => {
      process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
      expect(fileMatchesBase(join(WORKFLOW_DIR, 'small.yml'))).toBe(true);
    });

    it('returns false for a file the PR changed', () => {
      process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
      const path = join(WORKFLOW_DIR, 'small.yml');
      writeFileSync(path, 'changed by the PR\n');
      try {
        expect(fileMatchesBase(path)).toBe(false);
      } finally {
        writeFileSync(path, 'base content\n');
      }
    });

    it('returns false for a file absent from the base commit', () => {
      process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
      const path = join(WORKFLOW_DIR, 'brand-new.yml');
      writeFileSync(path, 'added by the PR\n');
      expect(fileMatchesBase(path)).toBe(false);
    });

    it('normalizes win32-style paths before asking git or the filesystem', () => {
      // On the merge-queue Windows lane join() emits backslashes, which git
      // pathspecs reject. Pin the normalization with a backslash path on
      // EVERY lane — on POSIX join() never emits one, so without this case
      // a mutation deleting the normalization survives every test that runs
      // and first fails during a real stale-baseline drift.
      process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
      expect(fileMatchesBase(win32.join(WORKFLOW_DIR, 'small.yml'))).toBe(true);
    });

    it('fails closed on an unresolvable base', () => {
      // Throws rather than returning false so the failure says "re-run the
      // job" instead of blaming the PR's growth — the gate's exit-2 arm
      // separates the same two cases for the same reason.
      process.env.WORKFLOW_SIZE_BASE_SHA = '0'.repeat(40);
      expect(() => fileMatchesBase(join(WORKFLOW_DIR, 'small.yml'))).toThrow(
        /could not be resolved/,
      );
    });

    it('fetches the base commit when it is not local (CI shallow-clone path)', () => {
      // Mirror of the gate's shallow-clone fixture: every production lane
      // checks out at depth 1, so the base commit is never present locally
      // and this fetch arm IS the production path for the mirror. Removing
      // the arm must turn this test red.
      const fetchDir = mkdtempSync(
        join(tmpdir(), 'workflow-size-mirror-fetch-'),
      );
      const fetchCwd = process.cwd();
      try {
        const env = hermeticGateEnv(fetchDir);
        const { checkout, baseSha } = seedShallowClone({
          root: fetchDir,
          env,
          seedFiles: {
            [join(WORKFLOW_DIR, 'small.yml')]: 'base content\n',
          },
        });
        process.chdir(checkout);
        process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
        // Pin the precondition: the base is absent locally, so any success
        // below must come from the fetch arm, not from local history.
        expect(
          spawnSync(
            'git',
            ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`],
            { stdio: 'ignore' },
          ).status,
        ).not.toBe(0);
        expect(fileMatchesBase(join(WORKFLOW_DIR, 'small.yml'))).toBe(true);
      } finally {
        process.chdir(fetchCwd);
        delete process.env.WORKFLOW_SIZE_BASE_SHA;
        rmSync(fetchDir, { recursive: true, force: true });
      }
    });
  },
);

// One predicate ships as two implementations: the bash gate on the PR lanes
// and this JS mirror on the merge-queue lanes. Nothing else runs both
// against the same repo state, so an edit to the leniency logic that lands
// in only one copy makes one lane warn while the other hard-fails — the
// #9904 red wall recreated on lanes that never show the bash diagnostic —
// and stays green here. One committed fixture, both runtimes, every verdict.
describe.skipIf(!gitAvailable || !bashSupportsAssocArrays)(
  'the gate and the mirror agree on the same repo state',
  () => {
    it('is lenient on main-side drift and strict on PR growth, in both runtimes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'workflow-size-parity-'));
      const restoreCwd = process.cwd();
      try {
        const env = hermeticGateEnv(dir);
        mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true });
        writeFileSync(join(dir, WORKFLOW_DIR, 'small.yml'), 'a'.repeat(5000));
        writeFileSync(
          join(dir, WORKFLOW_DIR, '.size-baseline'),
          '100 small.yml\n',
        );
        const git = (args) => {
          const r = spawnSync('git', args, {
            cwd: dir,
            encoding: 'utf8',
            env,
          });
          expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
          return r;
        };
        git(['init', '--quiet']);
        git(['config', 'user.email', 'gate-test@example.com']);
        git(['config', 'user.name', 'gate-test']);
        git(['add', '.']);
        git(['commit', '--quiet', '-m', 'base']);
        const baseSha = git(['rev-parse', 'HEAD']).stdout.trim();
        env.WORKFLOW_SIZE_BASE_SHA = baseSha;
        process.env.WORKFLOW_SIZE_BASE_SHA = baseSha;
        process.chdir(dir);
        const gate = () =>
          spawnSync('bash', [gatePath], { cwd: dir, encoding: 'utf8', env });
        const mirror = () => fileMatchesBase(join(WORKFLOW_DIR, 'small.yml'));

        // Over-allowance drift: 5000 bytes against a recorded 100, file
        // unchanged from the base — both runtimes lenient.
        const driftGate = gate();
        expect(driftGate.status).toBe(0);
        expect(driftGate.stdout).toContain('the baseline went stale on main');
        expect(mirror()).toBe(true);

        // The same drift with the PR changing the file — both strict.
        writeFileSync(join(dir, WORKFLOW_DIR, 'small.yml'), 'a'.repeat(5001));
        const growthGate = gate();
        expect(growthGate.status).toBe(1);
        expect(growthGate.stdout).toContain('grew to 5001 bytes');
        expect(mirror()).toBe(false);

        // Missing-entry drift: the gate's other lenient arm, with the file
        // back at its base content — both runtimes lenient.
        writeFileSync(join(dir, WORKFLOW_DIR, 'small.yml'), 'a'.repeat(5000));
        writeFileSync(
          join(dir, WORKFLOW_DIR, '.size-baseline'),
          '# header only\n',
        );
        const missingGate = gate();
        expect(missingGate.status).toBe(0);
        expect(missingGate.stdout).toContain('has no entry');
        expect(missingGate.stdout).toContain('unrelated PRs are not blocked');
        expect(mirror()).toBe(true);

        // Missing entry with the PR changing the file — both strict.
        writeFileSync(join(dir, WORKFLOW_DIR, 'small.yml'), 'a'.repeat(5001));
        const changedGate = gate();
        expect(changedGate.status).toBe(1);
        expect(changedGate.stdout).toContain('has no entry');
        expect(mirror()).toBe(false);
      } finally {
        process.chdir(restoreCwd);
        delete process.env.WORKFLOW_SIZE_BASE_SHA;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe('qwen-autofix.yml design-record pointers', () => {
  const workflow = readFileSync(join(WORKFLOW_DIR, 'qwen-autofix.yml'), 'utf8');
  const doc = readFileSync(join(WORKFLOW_DIR, 'qwen-autofix.md'), 'utf8');
  // Steps whose body outgrew the workflow file live in sibling scripts (the
  // file sits near GitHub's 500 KB start-runs limit). Their rationale pointers
  // moved with them, so scan those too — otherwise extracting a step orphans
  // every section it pointed at and this suite reads it as dead prose.
  const pointerSources = [
    workflow,
    readFileSync('.github/scripts/autofix-push-and-report.sh', 'utf8'),
  ].join('\n');

  const pointers = [
    ...pointerSources.matchAll(/qwen-autofix\.md#(af-\d+)/g),
  ].map((m) => m[1]);
  const anchors = [...doc.matchAll(/<a id="(af-\d+)"><\/a>/g)].map((m) => m[1]);

  it('every pointer resolves to a section', () => {
    expect(pointers.length).toBeGreaterThan(0);
    expect(
      [...new Set(pointers)].filter((id) => !anchors.includes(id)),
    ).toEqual([]);
  });

  it('every section is still pointed at from the workflow', () => {
    expect(anchors.filter((id) => !pointers.includes(id))).toEqual([]);
  });

  it('allocates each section id exactly once', () => {
    // A double allocation (two blocks minted with the same id, e.g. a branch
    // that numbered a new block before a same-numbered block landed on main)
    // passes every other check here: pointers resolve, anchors stay pointed
    // at, and the contents table mirrors the duplication. Browsers resolve
    // the anchor to the FIRST occurrence, so one feature's rationale pointer
    // silently shows the other's block.
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('lists every section in the contents table', () => {
    const listed = [...doc.matchAll(/^- \[\d+\..*?\]\(#(af-\d+)\)$/gm)].map(
      (m) => m[1],
    );
    expect(listed).toEqual(anchors);
  });

  it('keeps every section anchor outside any fenced code block', () => {
    // Headings and HTML anchors inside a fenced code block are literal
    // text on GitHub: a fence one entry leaves OPEN swallows the next
    // entry's anchor, its heading, and every pointer at it — the entry
    // renders as code inside its predecessor. Track fence parity line by
    // line (a closer needs at least the opener's length and nothing but
    // backticks, so a ``` block cannot close a ```` fence) and require
    // every anchor to sit outside.
    let openLen = 0;
    const fencedAnchors = [];
    for (const line of doc.split('\n')) {
      const m = /^ {0,3}(`{3,})/.exec(line);
      if (m) {
        if (openLen === 0) {
          openLen = m[1].length;
        } else if (m[1].length >= openLen && line.trim() === m[1]) {
          openLen = 0;
        }
      }
      if (openLen > 0 && line.includes('<a id="af-')) {
        fencedAnchors.push(line);
      }
    }
    expect(fencedAnchors).toEqual([]);
    expect(openLen).toBe(0);
  });
});
