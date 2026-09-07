/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Executes the e2e workflow's 'Run E2E tests' script under GitHub Actions'
// default Linux step shell — `bash -e {0}`: the step has no `shell:` override
// and e2e.yml no `defaults:` block (both absences pinned in
// e2e-workflow.test.js), so no pipefail — with npm stubbed and the
// clock pinned, so the retry's exit-code semantics and the budget gate's
// exact threshold are witnessed by bash rather than by shape assertions
// alone. A failure-swallowing mutation (a group-level `|| true`) or a missing
// budget gate turns these red. Bash-driven, so it is excluded from the
// Windows lanes in vitest.config.ts.
describe('e2e workflow sandbox:none shard retry execution', () => {
  const yml = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'));
  const steps = yml.jobs['e2e-test-linux'].steps;
  const runStep = steps.find((step) => step.name === 'Run E2E tests');
  const script = runStep.run
    .replaceAll('${{ matrix.sandbox }}', 'sandbox:none')
    .replaceAll('${{ matrix.shard }}', '1/3');

  function runStepScript({ failCalls, elapsedSeconds, timeoutExit }) {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-e2e-retry-'));
    try {
      const callCountFile = join(dir, 'npm-call-count');
      const npmStub = join(dir, 'npm');
      writeFileSync(callCountFile, '0');
      writeFileSync(
        npmStub,
        [
          '#!/usr/bin/env bash',
          'call=$(( $(cat "$NPM_CALL_COUNT_FILE") + 1 ))',
          'printf "%s" "$call" > "$NPM_CALL_COUNT_FILE"',
          'for bad in $NPM_FAIL_CALLS; do',
          '  [ "$call" = "$bad" ] && exit 1',
          'done',
          'exit 0',
        ].join('\n'),
      );
      chmodSync(npmStub, 0o755);
      // The clock is pinned so the budget-gate boundary cases are exact:
      // with the real clock, elapsed only ever grows between this process
      // and the script's `date +%s`, which would race the 2100s threshold.
      const now = Math.floor(Date.now() / 1000);
      const dateStub = join(dir, 'date');
      writeFileSync(
        dateStub,
        ['#!/usr/bin/env bash', `printf '%s' '${now}'`].join('\n'),
      );
      chmodSync(dateStub, 0o755);
      // GNU timeout stand-in for the first-attempt bound: macOS runners
      // carry no `timeout`, and a real one would race the pinned clock
      // anyway. It records each duration it is asked to enforce, honors
      // TIMEOUT_STUB_EXIT as the killed-attempt path (timeout's own 124),
      // and otherwise execs the wrapped command so the retry wiring stays
      // observable.
      const timeoutDurationsFile = join(dir, 'timeout-durations');
      writeFileSync(timeoutDurationsFile, '');
      const timeoutStub = join(dir, 'timeout');
      writeFileSync(
        timeoutStub,
        [
          '#!/usr/bin/env bash',
          'while [[ "$1" == -* ]]; do shift; done',
          'printf "%s\\n" "$1" >> "$TIMEOUT_DURATIONS_FILE"',
          'shift',
          'if [[ -n "${TIMEOUT_STUB_EXIT:-}" ]]; then exit "$TIMEOUT_STUB_EXIT"; fi',
          '"$@"',
        ].join('\n'),
      );
      chmodSync(timeoutStub, 0o755);
      const scriptFile = join(dir, 'run-e2e-tests.sh');
      writeFileSync(scriptFile, script);
      let exitCode = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-e', scriptFile], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            NPM_CALL_COUNT_FILE: callCountFile,
            NPM_FAIL_CALLS: failCalls,
            TIMEOUT_DURATIONS_FILE: timeoutDurationsFile,
            ...(timeoutExit === undefined
              ? {}
              : { TIMEOUT_STUB_EXIT: String(timeoutExit) }),
            E2E_JOB_START_EPOCH: String(now - elapsedSeconds),
          },
          encoding: 'utf8',
        });
      } catch (err) {
        exitCode = err.status;
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      return {
        exitCode,
        output,
        npmCalls: Number(readFileSync(callCountFile, 'utf8')),
        timeoutDurations: readFileSync(timeoutDurationsFile, 'utf8')
          .split('\n')
          .filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('runs a green shard straight through with no retry noise', () => {
    // The green first-attempt path needs its own witness: without one, an
    // unconditional pre-gate side effect (a spurious ::warning:: before
    // `run_shard || {`) ships with every other witness green.
    const { exitCode, npmCalls, output, timeoutDurations } = runStepScript({
      failCalls: '',
      elapsedSeconds: 1200,
    });
    expect(npmCalls).toBe(1);
    // The bound wraps the (only) attempt even when nothing fails.
    expect(timeoutDurations).toEqual(['1500']);
    expect(output).not.toContain('::warning::');
    expect(output).not.toContain('::error::');
    expect(exitCode).toBe(0);
  });

  it('retries a shard that dies once and passes on the second attempt', () => {
    // The transient class the retry exists for: first attempt dead, re-run
    // green (runs 33293739505, 33302550436, 33317457036).
    const { exitCode, npmCalls, output, timeoutDurations } = runStepScript({
      failCalls: '1',
      elapsedSeconds: 1200,
    });
    expect(npmCalls).toBe(2);
    // One bounded attempt, not two: the retry stays unbounded because the
    // budget gate has already reserved its shard-time.
    expect(timeoutDurations).toEqual(['1500']);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('keeps the step red when the shard fails both attempts', () => {
    // A deterministic failure must not be absorbed: appending `|| true` to
    // the brace group turns this red.
    const { exitCode, npmCalls } = runStepScript({
      failCalls: '1 2',
      elapsedSeconds: 1200,
    });
    expect(npmCalls).toBe(2);
    expect(exitCode).not.toBe(0);
  });

  it('retries at exactly the 2100s budget-gate threshold', () => {
    // The gate admits a retry at elapsed <= 2100. Threshold mutations in
    // either direction must not ship silently between the 1200/3000 probes.
    const { exitCode, npmCalls, output, timeoutDurations } = runStepScript({
      failCalls: '1',
      elapsedSeconds: 2100,
    });
    expect(npmCalls).toBe(2);
    expect(timeoutDurations).toEqual(['1500']);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('retries a first attempt killed by its own wall-clock bound', () => {
    // The run 34083672277 shape under the bound: timeout(1) kills the
    // degraded first attempt (exit 124, the shard never reporting) and that
    // exit must flow through the same budget gate as any other
    // first-attempt death.
    const { exitCode, npmCalls, output, timeoutDurations } = runStepScript({
      failCalls: '',
      elapsedSeconds: 1200,
      timeoutExit: 124,
    });
    expect(timeoutDurations).toEqual(['1500']);
    // Only the retried attempt ever reached the shard command.
    expect(npmCalls).toBe(1);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('refuses a retry one second past the 2100s budget-gate threshold', () => {
    const { exitCode, npmCalls, output } = runStepScript({
      failCalls: '1',
      elapsedSeconds: 2101,
    });
    expect(npmCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });

  it('fails fast when the remaining job budget cannot fit a retried shard', () => {
    // 3000s spent of the 3600s job budget leaves 10 minutes — the exact
    // shape of runs 33293739505 and 33302550436. An unconditional retry
    // would call npm again and be cancelled mid-flight by timeout-minutes.
    const { exitCode, npmCalls, output } = runStepScript({
      failCalls: '1',
      elapsedSeconds: 3000,
    });
    expect(npmCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });
});
