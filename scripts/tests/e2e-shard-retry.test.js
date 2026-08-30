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

// Executes the e2e workflow's 'Run E2E tests' script under the same
// `bash -eo pipefail` GitHub Actions uses, with npm stubbed, so the retry's
// exit-code semantics are witnessed by bash rather than by shape assertions
// alone. A failure-swallowing mutation (a group-level `|| true`) or a
// missing budget gate turns these red. Bash-driven, so it is excluded from
// the Windows lanes in vitest.config.ts.
describe('e2e workflow sandbox:none shard retry execution', () => {
  const yml = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'));
  const steps = yml.jobs['e2e-test-linux'].steps;
  const runStep = steps.find((step) => step.name === 'Run E2E tests');
  const script = runStep.run
    .replaceAll('${{ matrix.sandbox }}', 'sandbox:none')
    .replaceAll('${{ matrix.shard }}', '1/3');

  function runStepScript({ failCalls, elapsedSeconds }) {
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
      const scriptFile = join(dir, 'run-e2e-tests.sh');
      writeFileSync(scriptFile, script);
      let exitCode = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-e', '-o', 'pipefail', scriptFile], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            NPM_CALL_COUNT_FILE: callCountFile,
            NPM_FAIL_CALLS: failCalls,
            E2E_JOB_START_EPOCH: String(
              Math.floor(Date.now() / 1000) - elapsedSeconds,
            ),
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
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('retries a shard that dies once and passes on the second attempt', () => {
    // The transient class the retry exists for: first attempt dead, re-run
    // green (runs 33293739505, 33302550436, 33317457036).
    const { exitCode, npmCalls, output } = runStepScript({
      failCalls: '1',
      elapsedSeconds: 1200,
    });
    expect(npmCalls).toBe(2);
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
