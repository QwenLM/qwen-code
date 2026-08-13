/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const readWorkflow = (name) =>
  readFileSync(path.join(repoRoot, `.github/workflows/${name}`), 'utf8');

describe('security workflows', () => {
  it('keeps Scorecard monthly and reporting-only', () => {
    const workflow = readWorkflow('scorecard-monthly.yml');

    expect(workflow).toContain("- cron: '0 2 1 * *'");
    expect(workflow).toContain('workflow_dispatch: {}');
    expect(workflow).toContain('publish_results: false');
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).toContain(
      'ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc',
    );
  });

  it('keeps Security Checks reporting-only and audits package locks', () => {
    const workflow = readWorkflow('security-checks.yml');
    const dependencyJob = getWorkflowJob(workflow, 'dependency-cve');
    const auditStep = getWorkflowStep(
      dependencyJob,
      'Audit production dependencies',
    );
    const secretScanJob = getWorkflowJob(workflow, 'secret-scan');
    const checkoutStep = getWorkflowStep(secretScanJob, 'Checkout');
    const trufflehogStep = getWorkflowStep(
      secretScanJob,
      'Scan for verified secrets',
    );

    expect(auditStep).toContain('continue-on-error: true');
    expect(auditStep).toContain('status=0');
    expect(auditStep).toContain('exit "$status"');
    expect(auditStep).toContain('npm audit --omit=dev --audit-level=high');
    expect(auditStep).toContain('for lockfile in packages/*/package-lock.json');
    expect(auditStep).toContain(
      'npm ci --ignore-scripts --no-audit --progress=false &&',
    );
    expect(trufflehogStep).toContain('continue-on-error: true');
    expect(trufflehogStep).toContain("version: '3.96.0'");
    expect(trufflehogStep).toContain("extra_args: '--only-verified'");
    expect(checkoutStep).toContain('fetch-depth: 0');
  });
});
