/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Executes the Security Checks audit step under the shell GitHub actually gives
// it — security-checks.yml sets `defaults.run.shell: bash`, which on Linux is
// `bash --noprofile --norc -e -o pipefail {0}` — with `npm`, `timeout` and
// `sleep` stubbed. Three properties of this gate cannot be witnessed by the
// shape assertions in security-workflows.test.js:
//
//   1. a registry-side failure is retried instead of being reported as a CVE;
//   2. a real high-severity finding is never retried away or swallowed;
//   3. the verdict does not depend on `-o pipefail` staying in the step shell —
//      a wrapper that read npm's status out of a pipeline would exit 0 on a real
//      finding the moment that flag went away.
//
// Bash-driven, so it is excluded from the Windows lanes in vitest.config.ts.
describe('security-checks audit step endpoint-error retry', () => {
  const yml = parse(
    readFileSync('.github/workflows/security-checks.yml', 'utf8'),
  );
  const steps = yml.jobs['dependency-cve'].steps;
  const auditStep = steps.find(
    (step) => step.name === 'Audit production dependencies',
  );
  const script = auditStep.run;

  const ENDPOINT_ERROR = 'npm error audit endpoint returned an error';
  const NO_VERDICT = '::error::npm audit returned no verdict after 2 attempts';

  // One vendored lockfile, so a full pass audits twice: once at the root and
  // once inside the per-package loop. The loop keeps going after a root failure
  // (`|| status=$?` accumulates rather than aborts), so a persistent failure is
  // audited and retried at both sites.
  function runAuditStep({ auditMode, pipefail = true }) {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-cve-audit-'));
    try {
      mkdirSync(join(dir, 'packages/live-host'), { recursive: true });
      writeFileSync(join(dir, 'packages/live-host/package-lock.json'), '{}');

      const counters = {
        audit: join(dir, 'audit-calls'),
        timeout: join(dir, 'timeout-calls'),
        sleep: join(dir, 'sleeps'),
      };
      for (const file of Object.values(counters)) writeFileSync(file, '0');

      // Bumps a counter file and leaves the running total in `$n`.
      const bump = (varName) =>
        [
          `n=$(( $(cat "$${varName}") + 1 ))`,
          `printf "%s" "$n" > "$${varName}"`,
        ].join('\n');

      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, 'npm'),
        [
          '#!/usr/bin/env bash',
          '# `npm ci` always succeeds; only the audit is under test.',
          '[ "$1" = "audit" ] || exit 0',
          bump('AUDIT_CALLS_FILE'),
          'case "$AUDIT_MODE" in',
          '  clean) exit 0 ;;',
          '  endpoint-error-then-clean)',
          '    if [ "$n" -lt 2 ]; then',
          `      printf '%s\\n' '${ENDPOINT_ERROR}'`,
          '      exit 1',
          '    fi',
          '    ;;',
          '  endpoint-error-always)',
          `    printf '%s\\n' '${ENDPOINT_ERROR}'`,
          '    exit 1',
          '    ;;',
          '  cve-found)',
          "    printf '%s\\n' '# npm audit report' 'pkg  1.0.0' 'Severity: high'",
          "    printf '%s\\n' '1 vulnerability (1 high)'",
          '    exit 1',
          '    ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      );
      // Stands in for coreutils `timeout`, absent on macOS: it either simulates
      // the 124 a killed attempt returns, or drops the duration and execs the
      // command so npm's own status survives.
      writeFileSync(
        join(binDir, 'timeout'),
        [
          '#!/usr/bin/env bash',
          bump('TIMEOUT_CALLS_FILE'),
          'case "$AUDIT_MODE" in',
          '  timeout-always) exit 124 ;;',
          '  timeout-then-clean)',
          '    if [ "$n" -lt 2 ]; then',
          '      exit 124',
          '    fi',
          '    ;;',
          'esac',
          'shift',
          'exec "$@"',
        ].join('\n'),
      );
      writeFileSync(
        join(binDir, 'sleep'),
        ['#!/usr/bin/env bash', bump('SLEEPS_FILE'), 'exit 0'].join('\n'),
      );
      for (const stub of ['npm', 'timeout', 'sleep']) {
        chmodSync(join(binDir, stub), 0o755);
      }

      const scriptFile = join(dir, 'step.sh');
      writeFileSync(scriptFile, script);

      const run = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-e',
          ...(pipefail ? ['-o', 'pipefail'] : []),
          scriptFile,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            AUDIT_MODE: auditMode,
            AUDIT_CALLS_FILE: counters.audit,
            TIMEOUT_CALLS_FILE: counters.timeout,
            SLEEPS_FILE: counters.sleep,
          },
        },
      );
      const count = (file) => Number(readFileSync(file, 'utf8'));
      return {
        status: run.status,
        // Read both streams, as an Actions log does: the wrapper echoes npm's
        // report to stdout, and a bash error would land on stderr.
        output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
        auditCalls: count(counters.audit),
        timeoutCalls: count(counters.timeout),
        sleeps: count(counters.sleep),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes a clean audit through unchanged, without retrying', () => {
    const { status, auditCalls, sleeps } = runAuditStep({ auditMode: 'clean' });
    expect(status).toBe(0);
    expect(auditCalls).toBe(2);
    expect(sleeps).toBe(0);
  });

  it('retries a registry endpoint error and passes once the registry recovers', () => {
    const { status, output, auditCalls, sleeps } = runAuditStep({
      auditMode: 'endpoint-error-then-clean',
    });
    expect(status).toBe(0);
    // Root audit fails once and is retried; the vendored lockfile then audits
    // clean on its first attempt.
    expect(auditCalls).toBe(3);
    expect(sleeps).toBe(1);
    expect(output).toContain(
      '::warning::npm audit returned no verdict (attempt 1/2), retrying',
    );
  });

  it('retries an audit that stalled until `timeout` killed it', () => {
    const { status, auditCalls, timeoutCalls, sleeps } = runAuditStep({
      auditMode: 'timeout-then-clean',
    });
    expect(status).toBe(0);
    // The killed attempt never reached npm; the retry and the vendored lockfile
    // both did.
    expect(timeoutCalls).toBe(3);
    expect(auditCalls).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('still fails the gate when the endpoint never recovers, and says it is not a CVE', () => {
    const { status, output, auditCalls, sleeps } = runAuditStep({
      auditMode: 'endpoint-error-always',
    });
    expect(status).not.toBe(0);
    // Two attempts at each of the two audit sites, sleeping between them.
    expect(auditCalls).toBe(4);
    expect(sleeps).toBe(2);
    expect(output).toContain(NO_VERDICT);
    expect(output).toContain('not a CVE finding');
  });

  it('still fails the gate when every attempt stalls, rather than waiting on npm forever', () => {
    const { status, output, auditCalls, timeoutCalls, sleeps } = runAuditStep({
      auditMode: 'timeout-always',
    });
    expect(status).not.toBe(0);
    expect(timeoutCalls).toBe(4);
    expect(auditCalls).toBe(0);
    expect(sleeps).toBe(2);
    expect(output).toContain(NO_VERDICT);
    expect(output).toContain('not a CVE finding');
  });

  it('reports a real high-severity finding as-is, with no retry', () => {
    const { status, output, auditCalls, sleeps } = runAuditStep({
      auditMode: 'cve-found',
    });
    expect(status).not.toBe(0);
    // Both audit sites report the finding once each; neither is retried, and
    // the loop still runs after the root failure.
    expect(auditCalls).toBe(2);
    expect(sleeps).toBe(0);
    expect(output).toContain('1 vulnerability (1 high)');
    expect(output).not.toContain('retrying');
    expect(output).not.toContain('not a CVE finding');
  });

  it('reaches the same verdict without pipefail, so the gate cannot fail open on a shell change', () => {
    // A wrapper that read npm's status out of a pipeline would report exit 0
    // for both of these under plain `bash -e` — silently passing a real
    // high-severity finding, and silently passing an unreachable registry.
    for (const auditMode of ['cve-found', 'endpoint-error-always']) {
      const withPipefail = runAuditStep({ auditMode });
      const withoutPipefail = runAuditStep({ auditMode, pipefail: false });
      expect(withoutPipefail.status, auditMode).not.toBe(0);
      expect(withoutPipefail.status, auditMode).toBe(withPipefail.status);
      expect(withoutPipefail.auditCalls, auditMode).toBe(
        withPipefail.auditCalls,
      );
    }
  });
});
