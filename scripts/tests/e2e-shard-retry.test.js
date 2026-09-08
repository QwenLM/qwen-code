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

// Executes the e2e workflow's 'Run E2E tests' scripts under GitHub Actions'
// default step shell — `bash -e {0}`: the steps have no `shell:` override
// and e2e.yml no `defaults:` block (both absences pinned in
// e2e-workflow.test.js), so no pipefail — with the leg's shard runner
// stubbed (npm for the Linux sandbox:none leg, npx for the macOS leg) and
// the clock pinned, so each retry's exit-code semantics and budget-gate
// threshold are witnessed by bash rather than by shape assertions alone. A
// failure-swallowing mutation (a group-level `|| true`) or a missing budget
// gate turns these red. Bash-driven, so the file is excluded from the
// Windows lanes in vitest.config.ts.
const yml = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'));

function runStepScript(script, stubName, { failCalls, elapsedSeconds }) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-e2e-retry-'));
  try {
    const callCountFile = join(dir, 'shard-call-count');
    const runnerStub = join(dir, stubName);
    writeFileSync(callCountFile, '0');
    writeFileSync(
      runnerStub,
      [
        '#!/usr/bin/env bash',
        'call=$(( $(cat "$SHARD_CALL_COUNT_FILE") + 1 ))',
        'printf "%s" "$call" > "$SHARD_CALL_COUNT_FILE"',
        'for bad in $SHARD_FAIL_CALLS; do',
        '  [ "$call" = "$bad" ] && exit 1',
        'done',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(runnerStub, 0o755);
    // The clock is pinned so the budget-gate boundary cases are exact: with
    // the real clock, elapsed only ever grows between this process and the
    // script's `date +%s`, which would race the thresholds.
    const now = Math.floor(Date.now() / 1000);
    const dateStub = join(dir, 'date');
    writeFileSync(
      dateStub,
      ['#!/usr/bin/env bash', `printf '%s' '${now}'`].join('\n'),
    );
    chmodSync(dateStub, 0o755);
    const scriptFile = join(dir, 'run-e2e-tests.sh');
    writeFileSync(scriptFile, script);
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync('bash', ['-e', scriptFile], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          SHARD_CALL_COUNT_FILE: callCountFile,
          SHARD_FAIL_CALLS: failCalls,
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
      shardCalls: Number(readFileSync(callCountFile, 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('e2e workflow sandbox:none shard retry execution', () => {
  const steps = yml.jobs['e2e-test-linux'].steps;
  const runStep = steps.find((step) => step.name === 'Run E2E tests');
  const script = runStep.run
    .replaceAll('${{ matrix.sandbox }}', 'sandbox:none')
    .replaceAll('${{ matrix.shard }}', '1/3');
  const runLinux = (options) => runStepScript(script, 'npm', options);

  it('runs a green shard straight through with no retry noise', () => {
    // The green first-attempt path needs its own witness: without one, an
    // unconditional pre-gate side effect (a spurious ::warning:: before
    // `run_shard || {`) ships with every other witness green.
    const { exitCode, shardCalls, output } = runLinux({
      failCalls: '',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(1);
    expect(output).not.toContain('::warning::');
    expect(output).not.toContain('::error::');
    expect(exitCode).toBe(0);
  });

  it('retries a shard that dies once and passes on the second attempt', () => {
    // The transient class the retry exists for: first attempt dead, re-run
    // green (runs 33293739505, 33302550436, 33317457036).
    const { exitCode, shardCalls, output } = runLinux({
      failCalls: '1',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(2);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('keeps the step red when the shard fails both attempts', () => {
    // A deterministic failure must not be absorbed: appending `|| true` to
    // the brace group turns this red.
    const { exitCode, shardCalls } = runLinux({
      failCalls: '1 2',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(2);
    expect(exitCode).not.toBe(0);
  });

  it('retries at exactly the 2100s budget-gate threshold', () => {
    // The gate admits a retry at elapsed <= 2100. Threshold mutations in
    // either direction must not ship silently between the 1200/3000 probes.
    const { exitCode, shardCalls, output } = runLinux({
      failCalls: '1',
      elapsedSeconds: 2100,
    });
    expect(shardCalls).toBe(2);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('refuses a retry one second past the 2100s budget-gate threshold', () => {
    const { exitCode, shardCalls, output } = runLinux({
      failCalls: '1',
      elapsedSeconds: 2101,
    });
    expect(shardCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });

  it('fails fast when the remaining job budget cannot fit a retried shard', () => {
    // 3000s spent of the 3600s job budget leaves 10 minutes — the exact
    // shape of runs 33293739505 and 33302550436. An unconditional retry
    // would call npm again and be cancelled mid-flight by timeout-minutes.
    const { exitCode, shardCalls, output } = runLinux({
      failCalls: '1',
      elapsedSeconds: 3000,
    });
    expect(shardCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });
});

describe('e2e workflow macOS shard retry execution', () => {
  const steps = yml.jobs['e2e-test-macos'].steps;
  const runStep = steps.find((step) => step.name === 'Run E2E tests');
  const script = runStep.run.replaceAll('${{ matrix.shard }}', '1/2');
  const runMacos = (options) => runStepScript(script, 'npx', options);

  it('runs a green shard straight through with no retry noise', () => {
    const { exitCode, shardCalls, output } = runMacos({
      failCalls: '',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(1);
    expect(output).not.toContain('::warning::');
    expect(output).not.toContain('::error::');
    expect(exitCode).toBe(0);
  });

  it('retries a shard that dies once and passes on the second attempt', () => {
    // The transient class the retry exists for: run 33982750226 died this
    // way on shard 1/2 — red with no vitest FAIL line while shard 2/2 of
    // the same run passed.
    const { exitCode, shardCalls, output } = runMacos({
      failCalls: '1',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(2);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('keeps the step red when the shard fails both attempts', () => {
    // A deterministic failure must not be absorbed by the retry.
    const { exitCode, shardCalls } = runMacos({
      failCalls: '1 2',
      elapsedSeconds: 1200,
    });
    expect(shardCalls).toBe(2);
    expect(exitCode).not.toBe(0);
  });

  it('retries at exactly the 18000s budget-gate threshold', () => {
    // The gate admits a retry at elapsed <= 18000: 21600s of job budget
    // minus the 60-minute reserve for one shard-time. Threshold mutations
    // in either direction must not ship silently between the probes.
    const { exitCode, shardCalls, output } = runMacos({
      failCalls: '1',
      elapsedSeconds: 18000,
    });
    expect(shardCalls).toBe(2);
    expect(output).toContain('::warning::');
    expect(exitCode).toBe(0);
  });

  it('refuses a retry one second past the 18000s budget-gate threshold', () => {
    const { exitCode, shardCalls, output } = runMacos({
      failCalls: '1',
      elapsedSeconds: 18001,
    });
    expect(shardCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });

  it('fails fast when the remaining job budget cannot fit a retried shard', () => {
    // 20000s spent of the 21600s job budget leaves under 27 minutes — less
    // than one macOS shard-time. An unconditional retry would call npx
    // again and be cancelled mid-flight by timeout-minutes.
    const { exitCode, shardCalls, output } = runMacos({
      failCalls: '1',
      elapsedSeconds: 20000,
    });
    expect(shardCalls).toBe(1);
    expect(output).toContain('::error::');
    expect(exitCode).not.toBe(0);
  });
});
