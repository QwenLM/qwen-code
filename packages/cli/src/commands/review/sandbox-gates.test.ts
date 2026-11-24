/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateOperatorReviewSettings } from './lib/test-utils.js';
import { runDrive } from './drive.js';
import { runAbDrive } from './ab-drive.js';
import { runCaptureTui } from './capture-tui.js';
import { runBuildTest } from './build-test.js';
import { runTestDelta } from './test-delta.js';

describe('host-execution bypass gates (drive, ab-drive, capture-tui)', () => {
  let settingsGuard: { dispose: () => void };
  let dir: string;

  beforeEach(() => {
    settingsGuard = isolateOperatorReviewSettings();
    dir = mkdtempSync(join(tmpdir(), 'review-sandbox-gates-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    settingsGuard.dispose();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it.each([
    { QWEN_REVIEW_SANDBOX: 'required' },
    { QWEN_REVIEW_SANDBOX: 'tiered' },
    { QWEN_REVIEW_FORCE_HARDWARE: '1' },
  ])('refuses runDrive before touching tmux under %j', (envVars) => {
    for (const [k, v] of Object.entries(envVars)) vi.stubEnv(k, v);
    const exec = vi.fn();
    const report = runDrive({
      script: 'echo hi',
      cwd: dir,
      readyTimeout: 5,
      timeout: 5,
      server: 'gate-test-drive',
      exec,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(report.outcome).toBe('unavailable');
    expect(report.observed).toBe(false);
    expect(report.executionBoundary?.backend).toBe('refused');
    expect(report.note).toContain('refusing');
  });

  it.each([
    { QWEN_REVIEW_SANDBOX: 'required' },
    { QWEN_REVIEW_SANDBOX: 'tiered' },
    { QWEN_REVIEW_FORCE_HARDWARE: '1' },
  ])('refuses runAbDrive before touching tmux under %j', (envVars) => {
    for (const [k, v] of Object.entries(envVars)) vi.stubEnv(k, v);
    const armA = mkdtempSync(join(dir, 'arm-a-'));
    const armB = mkdtempSync(join(dir, 'arm-b-'));
    const exec = vi.fn();
    const report = runAbDrive({
      script: 'echo hi',
      armA,
      armB,
      readyTimeout: 5,
      timeout: 5,
      sharedReadyTimeout: 5,
      sharedOnce: false,
      server: 'gate-test-ab',
      exec,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(report.observed).toBe(false);
    expect(report.executionBoundary?.backend).toBe('refused');
    expect(report.note).toContain('refusing');
  });

  it.each([
    { QWEN_REVIEW_SANDBOX: 'required' },
    { QWEN_REVIEW_SANDBOX: 'tiered' },
    { QWEN_REVIEW_FORCE_HARDWARE: '1' },
  ])(
    'refuses runCaptureTui with exitCode 3 before starting tmux under %j',
    async (envVars) => {
      for (const [k, v] of Object.entries(envVars)) vi.stubEnv(k, v);
      const out = join(dir, 'cap');
      await runCaptureTui({
        command: 'echo hi',
        out,
        cols: 80,
        rows: 24,
        settleMs: 100,
        until: undefined,
        ready: undefined,
        keys: undefined,
        timeoutMs: 1000,
        cwd: dir,
      });
      expect(process.exitCode).toBe(3);
    },
  );

  it('refuses runBuildTest fail-closed under tiered mode for external fork PRs and emits executionBoundary', () => {
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        prNumber: '42',
        isCrossRepository: true,
        authorAssociation: 'NONE',
        files: [{ path: 'packages/cli/src/foo.ts' }],
      }),
    );
    const report = runBuildTest({
      plan: planPath,
      worktree: dir,
      out: join(dir, 'build-test.json'),
      timeout: 30,
      install: false,
      buildOnly: false,
    });
    expect(report.toolchain).toBe('refused');
    expect(report.ok).toBe(false);
    expect(report.executionBoundary).toMatchObject({
      policy: 'tiered',
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      backend: 'refused',
    });
    expect(report.executionBoundary?.escalationReasons).toContain(
      'cross-repository-pr',
    );
  });

  it('reports direct (not container) in executionBoundary under auto when the tree is not mountable', () => {
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'auto');
    const planPath = join(dir, 'local-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        files: [{ path: 'src/a.java' }],
      }),
    );
    const report = runBuildTest({
      plan: planPath,
      worktree: dir,
      timeout: 30,
      install: false,
      buildOnly: false,
    });
    expect(report.executionBoundary?.backend).toBe('direct');
    expect(report.executionBoundary?.prTrust).toBe('local-owner');
  });

  it('refuses runTestDelta fail-closed under tiered mode when plan indicates an external fork PR', () => {
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
    const planPath = join(dir, 'fork-plan.json');
    const buildReportPath = join(dir, 'build-test.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        prNumber: '99',
        isCrossRepository: true,
        authorAssociation: 'NONE',
        files: [{ path: 'packages/cli/src/foo.ts' }],
      }),
    );
    writeFileSync(
      buildReportPath,
      JSON.stringify({
        toolchain: 'npm',
        affected: ['packages/cli'],
        buildSet: ['packages/cli'],
        widenedWith: [],
        install: null,
        build: [],
        test: [
          {
            command: 'npm test --workspace="packages/cli"',
            exitCode: 1,
            seconds: 1,
            timedOut: false,
            output: 'FAIL src/a.test.ts',
            failingFiles: ['src/a.test.ts'],
          },
        ],
        timedOut: [],
        ok: false,
        note: 'failed',
      }),
    );
    const exec = vi.fn();
    const delta = runTestDelta({
      report: buildReportPath,
      baseline: dir,
      plan: planPath,
      timeout: 30,
      exec,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(delta.executionBoundary).toMatchObject({
      policy: 'tiered',
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      backend: 'refused',
    });
    expect(delta.note).toContain('cross-repository-pr');
  });

  it('tells the operator to pass --plan when tiered test-delta has no plan, and refuses without one', () => {
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
    const buildReportPath = join(dir, 'build-test.json');
    writeFileSync(
      buildReportPath,
      JSON.stringify({
        toolchain: 'npm',
        affected: ['packages/cli'],
        buildSet: ['packages/cli'],
        widenedWith: [],
        install: null,
        build: [],
        test: [
          {
            command: 'npm test',
            exitCode: 1,
            seconds: 1,
            timedOut: false,
            output: 'FAIL src/a.test.ts',
            failingFiles: ['src/a.test.ts'],
          },
        ],
        timedOut: [],
        ok: false,
        note: 'failed',
      }),
    );
    const exec = vi.fn();
    const delta = runTestDelta({
      report: buildReportPath,
      baseline: dir,
      timeout: 30,
      exec,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(delta.entries).toEqual([]);
    expect(delta.executionBoundary?.backend).toBe('refused');
    expect(delta.executionBoundary?.executionClass).toBe('unclassified');
    expect(delta.note).toContain('pass --plan <the Step 1 fetch plan>');
  });
});
