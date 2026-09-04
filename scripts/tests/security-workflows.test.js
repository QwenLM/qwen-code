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
    expect(workflow).not.toContain('pull_request');
    expect(workflow).toContain('publish_results: false');
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).toContain(
      'ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc',
    );
    expect(workflow).toContain(
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
    );
    expect(workflow).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain('persist-credentials: false');
  });

  it('runs the dependency gate on schedule or manual dispatch', () => {
    const workflow = readWorkflow('security-checks.yml');
    const dependencyJob = getWorkflowJob(workflow, 'dependency-cve');
    const dependencyCheckoutStep = getWorkflowStep(dependencyJob, 'Checkout');
    const installStep = getWorkflowStep(dependencyJob, 'Install dependencies');
    const auditStep = getWorkflowStep(
      dependencyJob,
      'Audit production dependencies',
    );
    const trackingJob = getWorkflowJob(workflow, 'track-dependency-cve');

    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('\n  push:');
    expect(workflow).toContain("- cron: '30 2 * * *'");
    expect(workflow).toContain('workflow_dispatch: {}');
    expect(dependencyJob).toContain('timeout-minutes: 60');
    expect(dependencyJob).not.toContain('continue-on-error');
    expect(trackingJob).toContain("needs: 'dependency-cve'");
    expect(trackingJob).toContain(
      "always() && (needs.dependency-cve.result == 'success' || needs.dependency-cve.result == 'failure')",
    );
    expect(trackingJob).toContain("issues: 'write'");
    expect(trackingJob).toContain("contents: 'read'");
    expect(trackingJob).toContain(
      'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
    );
    expect(trackingJob).toContain(
      "AUDIT_RESULT: '${{ needs.dependency-cve.result }}'",
    );
    expect(trackingJob).toContain(
      "require('./.github/scripts/update-dependency-audit-issue.cjs')",
    );
    expect(workflow).toContain(
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
    );
    expect(workflow).toContain(
      'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
    );
    expect(dependencyCheckoutStep).toContain('persist-credentials: false');
    expect(installStep).toContain(
      "run: 'npm ci --ignore-scripts --no-audit --progress=false'",
    );
    expect(auditStep).not.toContain('continue-on-error');
    expect(auditStep).toContain('status=0');
    expect(auditStep).toContain('exit "$status"');
    expect(auditStep).toContain('timeout 8m npm audit "$@"');
    // Streamed, not captured, so a run that now takes up to 16 minutes
    // reports progress instead of going silent and printing at the end.
    expect(auditStep).toContain('| tee "$log"');
    expect(auditStep).toContain('result="${PIPESTATUS[0]}"');
    expect(auditStep).not.toContain('output="$(timeout');
    expect(auditStep).toContain(
      'grep -q \'audit endpoint returned an error\' "$log"',
    );
    expect(auditStep).toContain('[ "$result" -ne 124 ]');
    expect(auditStep).toContain('[ "$attempt" -eq 2 ]');
    expect(auditStep).toContain('sleep 15');
    expect(auditStep).toContain(
      'run_npm_audit --omit=dev --audit-level=high || status=$?',
    );
    expect(auditStep).toContain(') || status=$?');
    expect(auditStep).toContain('for lockfile in packages/*/package-lock.json');
    expect(auditStep).toContain('[ -f "$lockfile" ] || continue');
    expect(auditStep).toContain(
      '[ "$lockfile" != "packages/mobile-mcp/package-lock.json" ] || continue',
    );
    expect(auditStep).toContain('cd "$package_dir"');
    expect(auditStep).toContain(
      'npm ci --ignore-scripts --no-audit --progress=false --workspaces=false &&',
    );
    expect(auditStep).toContain(
      'run_npm_audit --omit=dev --audit-level=high --workspaces=false',
    );
    expect(workflow).not.toContain('secret-scan:');
    expect(workflow).not.toContain('trufflesecurity/trufflehog');
  });
});
