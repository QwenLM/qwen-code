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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(
  readFileSync('.github/workflows/managed-agent-loop.yml', 'utf8'),
);
const job = workflow.jobs['managed-loop'];

describe('Managed loop CI coverage', () => {
  it('runs both loop modes on PRs, main and nightly without depending on Java tier selection', () => {
    expect(workflow.on.pull_request.branches).toContain('main');
    expect(workflow.on.push.branches).toContain('main');
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    expect(job).not.toHaveProperty('needs');
    expect(job.strategy.matrix.loop).toEqual(['shared', 'kernel']);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'packages/core/**',
        'packages/cli/**',
        'integration-tests/managed-loop/**',
      ]),
    );
  });

  it('runs the dedicated no-retry suite and rejects skipped or missing path evidence', () => {
    const config = readFileSync(
      'integration-tests/vitest.managed-loop.config.ts',
      'utf8',
    );
    expect(config).toContain("include: ['managed-loop/*.test.ts']");
    expect(config).toContain('retry: 0');
    expect(
      readFileSync('integration-tests/vitest.config.ts', 'utf8'),
    ).toContain("'**/managed-loop/**'");
    const run = job.steps.find(
      (step) => step.name === 'Run both Managed paths without retries',
    );
    expect(run.run).toContain('--config vitest.managed-loop.config.ts');
    expect(run.run).not.toContain('passWithNoTests');
    const guard = job.steps.find(
      (step) => step.name === 'Require both paths to have passed',
    );
    expect(guard.run).toContain('report.numPassedTests, 2');
    expect(guard.run).toContain('report.numPendingTests, 0');
    expect(guard.run).toContain("['hosted-agent-core', 'daemon-acp']");
    const upload = job.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.if).toBe('${{ always() }}');
  });

  it('fails the actual completion guard when a path was skipped or its evidence is absent', () => {
    const guard = job.steps.find(
      (step) => step.name === 'Require both paths to have passed',
    );
    const script = guard.run.split("<<'NODE'\n")[1].replace(/\nNODE$/, '');
    const root = mkdtempSync(path.join(tmpdir(), 'managed-loop-gate-'));
    const dir = path.join(root, 'shared');
    mkdirSync(dir);
    const report = {
      numTotalTests: 2,
      numPassedTests: 2,
      numPendingTests: 0,
      success: true,
    };
    const save = () =>
      writeFileSync(path.join(dir, 'tests.json'), JSON.stringify(report));
    const run = () =>
      spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
          ...process.env,
          MANAGED_LOOP_MODE: 'shared',
          MANAGED_LOOP_REPORT_DIR: root,
        },
        encoding: 'utf8',
      }).status;
    try {
      save();
      for (const surface of ['hosted-agent-core', 'daemon-acp']) {
        writeFileSync(
          path.join(dir, `${surface}.json`),
          JSON.stringify({
            mode: 'shared',
            surface,
            evidence: { status: 'pass' },
          }),
        );
      }
      expect(run()).toBe(0);
      report.numPendingTests = 1;
      save();
      expect(run()).not.toBe(0);
      report.numPendingTests = 0;
      save();
      rmSync(path.join(dir, 'daemon-acp.json'));
      expect(run()).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
