/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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
    expect(auditStep).toContain('audit || status=$?');
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
    expect(auditStep).toContain('audit --workspaces=false');
    // The retry may only ever swallow npm's own transport failure. Dropping
    // this marker, or the `return 1` that everything else falls through to,
    // would let a real high-severity finding be retried instead of reported.
    expect(auditStep).toContain("*'audit endpoint returned an error'*) ;;");
    expect(auditStep).toContain('*) return 1 ;;');
    // npm's own 5xx backoff is what made a failing attempt cost 302-422s during
    // the 2026-09-03 incident, so the step disables it and spaces its retries
    // itself. The budget then has to outlast one attempt measured WITHOUT that
    // flag, or the loop returns before ever retrying — which is what a 300s
    // budget did. Both are pinned by execution below; these name the cause.
    expect(auditStep).toContain('--fetch-retries=0');
    expect(auditStep).toContain('audit_deadline=$(( $(date +%s) + 600 ))');
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

// The audit step is a hard security gate, so the retry it gained is pinned by
// EXECUTING the step's own shell against a stubbed npm rather than only by
// matching strings: the invariant that matters is that a real high-severity
// finding still fails on the first attempt, and a string pin cannot prove a
// `case` arm does not swallow it.
const auditRunBlock = parse(
  readFileSync(
    path.join(repoRoot, '.github/workflows/security-checks.yml'),
    'utf8',
  ),
).jobs['dependency-cve'].steps.find(
  (step) => step.name === 'Audit production dependencies',
).run;

// AUDIT_ENDPOINT_FAILURES makes the first N audit calls fail the way the
// registry did on 2026-09-03 (npm prints the marker the step retries on);
// AUDIT_FINDING makes every audit call report a high-severity CVE instead.
// AUDIT_LATENCY_SECONDS charges the clock for the call itself, defaulting to
// the 302s a failing attempt actually cost in that incident: a clock that only
// advanced on `sleep` modelled the retry spacing and omitted the dominant
// term, which is how a budget below one attempt stayed green.
const NPM_STUB = [
  '#!/usr/bin/env bash',
  'echo "$*" >> "${CALLS_LOG}"',
  'case "$1" in',
  '  ci) exit 0 ;;',
  '  audit)',
  '    calls=$(( $(cat "${COUNTER_DIR}/audit") + 1 ))',
  '    echo "${calls}" > "${COUNTER_DIR}/audit"',
  '    now=$(( $(cat "${COUNTER_DIR}/clock") + ${AUDIT_LATENCY_SECONDS:-302} ))',
  '    echo "${now}" > "${COUNTER_DIR}/clock"',
  '    if [ -n "${AUDIT_FINDING:-}" ]; then',
  "      printf '%s\\n' '# npm audit report' 'Severity: high' '1 high severity vulnerability'",
  '      exit 1',
  '    fi',
  '    if [ "${calls}" -le "${AUDIT_ENDPOINT_FAILURES:-0}" ]; then',
  "      printf '%s\\n' 'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick' 'npm error audit endpoint returned an error' >&2",
  '      exit 1',
  '    fi',
  "    printf '%s\\n' 'found 0 vulnerabilities'",
  '    exit 0 ;;',
  'esac',
  'exit 0',
].join('\n');

// The fake clock moves on each backoff too, so the shared deadline bounds the
// loop even under a mutation that retries findings — which would otherwise
// spin to the test timeout, since AUDIT_FINDING has no failure budget to
// exhaust. The assertion then fails on the attempt COUNT, which says what
// went wrong.
const SLEEP_STUB = [
  '#!/usr/bin/env bash',
  'now=$(( $(cat "${COUNTER_DIR}/clock") + 30 ))',
  'echo "${now}" > "${COUNTER_DIR}/clock"',
  'exit 0',
].join('\n');

const DATE_STUB = [
  '#!/usr/bin/env bash',
  'echo $(( 1000000000 + $(cat "${COUNTER_DIR}/clock") ))',
].join('\n');

// Bash-driven: extensionless stubs on a colon-joined PATH, which is the shape
// scripts/tests/vitest.config.ts excludes wholesale on Windows. Skipping only
// this block keeps the YAML-parse assertions above running there.
describe.skipIf(process.platform === 'win32')(
  'Dependency CVE audit step',
  () => {
    const runAuditStep = ({
      endpointFailures = 0,
      finding = false,
      attemptLatency = 302,
    } = {}) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cve-audit-'));
      const bin = path.join(dir, 'bin');
      const counters = path.join(dir, 'counters');
      mkdirSync(bin);
      mkdirSync(counters);
      for (const [name, body] of [
        ['npm', NPM_STUB],
        ['sleep', SLEEP_STUB],
        ['date', DATE_STUB],
      ]) {
        writeFileSync(path.join(bin, name), body);
        chmodSync(path.join(bin, name), 0o755);
      }
      writeFileSync(path.join(counters, 'audit'), '0');
      writeFileSync(path.join(counters, 'clock'), '0');
      // Two vendored locks: one the step audits, one it deliberately skips.
      for (const pkg of ['alpha', 'mobile-mcp']) {
        mkdirSync(path.join(dir, 'packages', pkg), { recursive: true });
        writeFileSync(
          path.join(dir, 'packages', pkg, 'package-lock.json'),
          '{}',
        );
      }
      const callsLog = path.join(dir, 'calls.log');
      writeFileSync(callsLog, '');
      const result = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', auditRunBlock],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CALLS_LOG: callsLog,
            COUNTER_DIR: counters,
            AUDIT_ENDPOINT_FAILURES: String(endpointFailures),
            AUDIT_FINDING: finding ? '1' : '',
            AUDIT_LATENCY_SECONDS: String(attemptLatency),
          },
        },
      );
      const calls = readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      rmSync(dir, { recursive: true, force: true });
      return {
        status: result.status,
        audits: calls.filter((line) => line.startsWith('audit')).length,
        installs: calls.filter((line) => line.startsWith('ci ')).length,
        retried: result.stdout.includes(
          '::notice::npm audit endpoint unavailable; retrying.',
        ),
        stdout: result.stdout,
      };
    };

    it('passes a clean tree and audits every non-skipped lockfile', () => {
      expect(runAuditStep()).toMatchObject({
        status: 0,
        // Root workspace audit plus packages/alpha; mobile-mcp is skipped.
        audits: 2,
        installs: 1,
        retried: false,
      });
    });

    it('retries an attempt that cost what the incident measured', () => {
      // 422s is the slowest failing attempt observed on 2026-09-03, against a
      // 600s budget. This is the pin that keeps the budget above one real
      // attempt: at 300s the check reads 422 -lt 300, the loop returns having
      // never retried, and this test goes red on the attempt count.
      const result = runAuditStep({ endpointFailures: 1, attemptLatency: 422 });
      expect(result).toMatchObject({
        status: 0,
        audits: 3,
        installs: 1,
        retried: true,
      });
      // The report from the successful attempt still reaches the log.
      expect(result.stdout).toContain('found 0 vulnerabilities');
    });

    it('fails a high-severity finding on the first attempt, without retrying', () => {
      expect(runAuditStep({ finding: true })).toMatchObject({
        status: 1,
        // One attempt per audit site: a finding is not a transport error, so
        // retrying it would only delay the same red.
        audits: 2,
        installs: 1,
        retried: false,
      });
    });

    it('spends the shared budget once and does not top it up per audit', () => {
      // At the incident's 302s an attempt, the root audit gets one retry and
      // the second attempt lands past 600s; the vendored audit then inherits an
      // already-expired budget and gets none. That is what keeps a dead
      // endpoint inside the job timeout instead of multiplying by audit site.
      expect(runAuditStep({ endpointFailures: 99 })).toMatchObject({
        status: 1,
        audits: 3,
        installs: 1,
        retried: true,
      });
    });

    it('does not retry an attempt that outlasted the budget', () => {
      // The shape the 300s budget produced in production: one attempt costs
      // more than the whole budget, so there is nothing left to retry with.
      // The step must still fail loudly rather than loop or pass.
      expect(
        runAuditStep({ endpointFailures: 99, attemptLatency: 700 }),
      ).toMatchObject({ status: 1, audits: 2, installs: 1, retried: false });
    });
  },
);
