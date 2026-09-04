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

  it('keeps Security Checks a hard gate and audits package locks', () => {
    const workflow = readWorkflow('security-checks.yml');
    const dependencyJob = getWorkflowJob(workflow, 'dependency-cve');
    const dependencyCheckoutStep = getWorkflowStep(dependencyJob, 'Checkout');
    const installStep = getWorkflowStep(dependencyJob, 'Install dependencies');
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

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain(
      "group: '${{ github.workflow }}-${{ github.event.pull_request.head.repo.full_name || github.repository }}-${{ github.head_ref || github.ref }}'",
    );
    expect(workflow).toContain(
      'cancel-in-progress: "${{ github.event_name == \'pull_request\' }}"',
    );
    expect(workflow).toContain(
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
    );
    expect(workflow).toContain(
      'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
    );
    expect(dependencyCheckoutStep).toContain('persist-credentials: false');
    expect(checkoutStep).toContain('persist-credentials: false');
    expect(installStep).toContain(
      "run: 'npm ci --ignore-scripts --no-audit --progress=false'",
    );
    expect(auditStep).not.toContain('continue-on-error');
    expect(auditStep).toContain('status=0');
    expect(auditStep).toContain('exit "$status"');
    expect(auditStep).toContain('npm audit --omit=dev --audit-level=high');
    expect(auditStep).toContain(
      'npm audit --omit=dev --audit-level=high || status=$?',
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
      'npm audit --omit=dev --audit-level=high --workspaces=false',
    );
    // A registry-side audit failure is retried and then reported as its own
    // error, never swallowed: an endpoint outage must not read as a CVE
    // finding, and must not pass the gate either. Witnessed by bash in
    // security-checks-audit-retry.test.js.
    expect(auditStep).toContain('audit endpoint returned an error');
    expect(auditStep).toContain(
      'audit npm audit --omit=dev --audit-level=high || status=$?',
    );
    expect(auditStep).toContain(
      'audit npm audit --omit=dev --audit-level=high --workspaces=false',
    );
    expect(auditStep).not.toContain('|| true');
    // Every factor of the worst-case arithmetic is pinned, because the job
    // ceiling is only safe while none of them drifts: the per-attempt cap, the
    // backoff between attempts, and the ceiling itself — three audit sites
    // (root plus the two vendored lockfiles the loop does not skip), two
    // attempts each, 300s + 15s + 300s per site = 1845s of audit work. The
    // attempt count is pinned behaviourally by the call counters in
    // security-checks-audit-retry.test.js. Loosen any of these and a registry
    // outage turns a reported verdict into a bare job cancel.
    expect(auditStep).toContain('timeout 300 "$@"');
    expect(auditStep).toContain('sleep 15');
    expect(dependencyJob).toContain('timeout-minutes: 40');
    expect(trufflehogStep).not.toContain('continue-on-error');
    const trufflehogPin = trufflehogStep.match(
      /trufflesecurity\/trufflehog@[0-9a-f]{40}' # v([\d.]+)/,
    );
    expect(trufflehogPin).not.toBeNull();
    expect(trufflehogStep).toContain(`version: '${trufflehogPin?.[1]}'`);
    expect(trufflehogStep).toContain(
      "if: \"github.event_name == 'pull_request' || github.event.before != '0000000000000000000000000000000000000000'\"",
    );
    expect(trufflehogStep).toContain("extra_args: '--only-verified'");
    expect(trufflehogStep).toContain(
      'trufflesecurity/trufflehog@6f3c981e7b77f235fd2702dd74af25fc4b72bf11',
    );
    expect(checkoutStep).toContain('fetch-depth: 0');
  });
});
