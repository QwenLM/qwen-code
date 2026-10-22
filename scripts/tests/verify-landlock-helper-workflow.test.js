/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync('.github/workflows/verify-landlock-helper.yml', 'utf8'),
);

describe('Windows PTY diagnostic dispatch isolation', () => {
  it('keeps the diagnostic explicitly opt in and the existing jobs default on', () => {
    expect(
      workflow.on.workflow_dispatch.inputs.windows_pty_probe,
    ).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(workflow.on.pull_request.paths).toContain('pnpm-lock.yaml');
    expect(workflow.on.push.branches).toEqual(['main']);
    for (const name of ['cli', 'windows', 'verify']) {
      expect(workflow.jobs[name].if).toBe(
        "${{ !(github.event_name == 'workflow_dispatch' && inputs.windows_pty_probe) }}",
      );
    }
    expect(workflow.jobs['windows-pty-probe'].if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.windows_pty_probe }}",
    );
  });

  it('isolates three real runtime probes without installing the workspace', () => {
    const job = workflow.jobs['windows-pty-probe'];
    expect(job['runs-on']).toBe('windows-2022');
    expect(job['timeout-minutes']).toBe(10);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.runtime).toEqual([
      'node22',
      'bun1.3.14',
      'bun1.4.3',
    ]);
    expect(
      job.steps.filter((step) => step.run).map((step) => step.run),
    ).toEqual([
      'node scripts/diagnostics/windows-pty-probe.mjs "${{ matrix.runtime }}"',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.steps.find((step) => step.run).env.GH_TOKEN).toBe(
      '${{ github.token }}',
    );
    const upload = job.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.if).toBe('always()');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['include-hidden-files']).toBe(true);
  });
});
