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
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    // The ratchet's PR-scope fix (#9904) hangs off this env: without it the
    // gate has no base to compare against and silently degrades to the
    // pre-fix red-wall, so pin both event arms the script relies on.
    expect(step?.[0]).toContain('WORKFLOW_SIZE_BASE_SHA');
    expect(step?.[0]).toContain('github.event.pull_request.base.sha');
    expect(step?.[0]).toContain('github.event.merge_group.base_sha');
  });
});

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
    expect(baseline.has(workflowName(file))).toBe(true);
  });

  it.each(workflowFiles)('%s is within its baseline allowance', (file) => {
    const bytes = Buffer.byteLength(readFileSync(file));
    const recorded = baseline.get(workflowName(file));
    expect(bytes).toBeLessThanOrEqual(recorded + allowance);
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
// The stale-baseline fixtures commit their base with git; a runner without
// git cannot build them.
const gitAvailable =
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const canRunGate = bashSupportsAssocArrays && gitAvailable;

describe.skipIf(process.platform === 'win32' || !canRunGate)(
  'check-workflow-size.sh execution',
  () => {
    // The block above re-implements the gate's arithmetic in JS; only running
    // the real script pins its decision branches (growth, missing entry,
    // missing baseline, slack warning, malformed line).
    const gatePath = join(
      process.cwd(),
      '.github',
      'scripts',
      'check-workflow-size.sh',
    );
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
        const env = { ...process.env };
        // Keep fixtures hermetic: the gate reads three WORKFLOW_SIZE_* knobs,
        // and any of them leaking in from the developer's shell must not
        // change what the strict-path fixtures assert.
        delete env.WORKFLOW_SIZE_BASE_SHA;
        delete env.WORKFLOW_SIZE_GATE_BYTES;
        delete env.WORKFLOW_SIZE_GROWTH_ALLOWANCE;
        if (commitBase) {
          // Stand in for the PR's base commit: the caller may then dirty
          // files to simulate what the PR itself changed on top. Point git at
          // an empty global config and skip the system one — a developer's
          // global commit.gpgsign or hooksPath would otherwise break `git
          // commit` silently and flip the warning fixture to the strict path.
          const gitconfigPath = join(dir, 'fixture-gitconfig');
          writeFileSync(gitconfigPath, '');
          Object.assign(env, {
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: gitconfigPath,
          });
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
      expect(result.stdout).toContain('✅');
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

    // #9904: a workflow that grew on main without the same-PR baseline bump
    // used to red-wall every OTHER open PR. A PR whose copy of the file is
    // byte-identical to its base did not cause the drift and must only see a
    // warning; the hard failure belongs to the PR that changes the file.
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
      // strict failure — downgrading on an unverifiable base would fail the
      // ratchet open.
      const result = runGate({
        files: { 'small.yml': 5000 },
        baseline: '100 small.yml\n',
        commitBase: true,
        baseSha: '0'.repeat(40),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('grew to 5000 bytes');
    });

    it('fetches the base commit when it is not local (CI shallow-clone path)', () => {
      // The production path: ci.yml checks out at fetch-depth 1, so the PR's
      // base commit is never present locally and the gate must reach it via
      // `git fetch --depth=1 origin <sha>`. Re-implementing the fixture here
      // (rather than reusing runGate, which commits into the same repo) so
      // the base commit genuinely has to be fetched. Removing the fetch line
      // from the script must turn this test red.
      const dir = mkdtempSync(join(tmpdir(), 'workflow-size-gate-fetch-'));
      try {
        const env = { ...process.env };
        delete env.WORKFLOW_SIZE_BASE_SHA;
        delete env.WORKFLOW_SIZE_GATE_BYTES;
        delete env.WORKFLOW_SIZE_GROWTH_ALLOWANCE;
        const gitconfigPath = join(dir, 'fixture-gitconfig');
        writeFileSync(gitconfigPath, '');
        Object.assign(env, {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: gitconfigPath,
        });
        const bare = join(dir, 'origin.git');
        const seed = join(dir, 'seed');
        const gateCwd = join(dir, 'checkout');
        const git = (args, cwd) => {
          const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
          expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
          return r;
        };
        mkdirSync(seed, { recursive: true });
        git(['init', '--quiet', '--bare', bare], dir);
        // The bare repo's HEAD defaults to refs/heads/master; point it at the
        // branch the seed pushes so the clone checks files out at all.
        git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
        git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare);
        // Seed: a base commit with the grown workflow + a stale baseline,
        // then a second commit that changes only an unrelated file, so the
        // base sits behind the tip and a depth-1 clone does not contain it.
        git(['init', '--quiet'], seed);
        git(['config', 'user.email', 'gate-test@example.com'], seed);
        git(['config', 'user.name', 'gate-test'], seed);
        const seedWorkflows = join(seed, WORKFLOW_DIR);
        mkdirSync(seedWorkflows, { recursive: true });
        writeFileSync(join(seedWorkflows, 'small.yml'), 'a'.repeat(5000));
        writeFileSync(join(seedWorkflows, '.size-baseline'), '100 small.yml\n');
        git(['add', '.'], seed);
        git(['commit', '--quiet', '-m', 'base'], seed);
        const baseSha = git(['rev-parse', 'HEAD'], seed).stdout.trim();
        writeFileSync(join(seed, 'README.md'), 'unrelated tip change\n');
        git(['add', '.'], seed);
        git(['commit', '--quiet', '-m', 'unrelated tip'], seed);
        git(['remote', 'add', 'origin', bare], seed);
        git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
        // Depth-1 clone holds only the tip; the base commit needs a fetch.
        // The file:// URL matters: a plain local path ignores --depth and
        // copies full history, which would hide the fetch the gate must do.
        git(
          ['clone', '--quiet', '--depth', '1', `file://${bare}`, gateCwd],
          dir,
        );
        env.WORKFLOW_SIZE_BASE_SHA = baseSha;
        const result = spawnSync('bash', [gatePath], {
          cwd: gateCwd,
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
});
