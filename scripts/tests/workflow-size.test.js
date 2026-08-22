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

describe.skipIf(process.platform === 'win32' || !bashSupportsAssocArrays)(
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
    const runGate = ({ files, baseline }) => {
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
        return spawnSync('bash', [gatePath], { cwd: dir, encoding: 'utf8' });
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
