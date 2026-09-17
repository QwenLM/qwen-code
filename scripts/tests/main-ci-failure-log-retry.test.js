/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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

// Executes the failure watcher's log-download step under `bash -e` with `gh`
// stubbed, so the retry's attempt-count and fallback semantics are witnessed
// by bash rather than by shape assertions alone. The stub models real `gh`'s
// error contract — error body on stdout, then a non-zero exit — because the
// step redirects stdout into the log file it later reaps. Bash-driven, so it
// is excluded from the Windows lanes in vitest.config.ts.
describe('main CI failure issue log-download retry execution', () => {
  const stepRun = parse(
    readFileSync('.github/workflows/main-ci-failure-issue.yml', 'utf8'),
  ).jobs.analyze.steps.find(
    (step) => step.name === 'Download failed job logs',
  ).run;

  function runDownloadStep({ failCalls }) {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-main-ci-log-retry-'));
    try {
      const callCountFile = join(dir, 'gh-log-call-count');
      writeFileSync(callCountFile, '0');
      const ghStub = join(dir, 'gh');
      writeFileSync(
        ghStub,
        [
          '#!/usr/bin/env bash',
          'endpoint="$2"',
          'if [[ "${endpoint}" == repos/*/actions/runs/*/jobs* ]]; then',
          '  printf \'%s\' \'{"jobs":[{"id":123,"conclusion":"failure","name":"macOS shard","steps":[]}]}\'',
          '  exit 0',
          'fi',
          'if [[ "${endpoint}" == repos/*/actions/jobs/*/logs ]]; then',
          '  call=$(( $(cat "${GH_LOG_CALL_COUNT_FILE}") + 1 ))',
          '  printf \'%s\' "${call}" > "${GH_LOG_CALL_COUNT_FILE}"',
          '  for bad in ${GH_LOG_FAIL_CALLS}; do',
          '    if [[ "${call}" == "${bad}" ]]; then',
          '      printf \'%s\' \'{"message":"transient blobstore error"}\'',
          '      exit 1',
          '    fi',
          '  done',
          "  printf 'FAIL integration-tests/cli/example.test.ts > suite > case\\n'",
          '  exit 0',
          'fi',
          'echo "unexpected gh call: $*" >&2',
          'exit 1',
        ].join('\n'),
      );
      chmodSync(ghStub, 0o755);
      const stepFile = join(dir, 'step.sh');
      writeFileSync(stepFile, stepRun);
      const runnerTemp = join(dir, 'rt');
      mkdirSync(runnerTemp, { recursive: true });

      let exitCode = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-e', stepFile], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GH_LOG_CALL_COUNT_FILE: callCountFile,
            GH_LOG_FAIL_CALLS: failCalls,
            RUNNER_TEMP: runnerTemp,
            REPO: 'o/r',
            WORKFLOW_RUN_ID: '999',
          },
          encoding: 'utf8',
        });
      } catch (err) {
        exitCode = err.status;
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      const logFile = join(runnerTemp, 'failed-logs', '123.log');
      return {
        exitCode,
        output,
        logCalls: Number(readFileSync(callCountFile, 'utf8')),
        logContent: existsSync(logFile) ? readFileSync(logFile, 'utf8') : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('downloads a log on the first attempt without a retry or warning', () => {
    const { exitCode, output, logCalls, logContent } = runDownloadStep({
      failCalls: '',
    });
    expect(exitCode).toBe(0);
    expect(logCalls).toBe(1);
    expect(logContent).toContain('FAIL integration-tests/cli/example.test.ts');
    expect(output).not.toContain('::warning::');
  });

  it('retries a transient download failure once and keeps the log', () => {
    const { exitCode, output, logCalls, logContent } = runDownloadStep({
      failCalls: '1',
    });
    expect(exitCode).toBe(0);
    expect(logCalls).toBe(2);
    // The second attempt's `>` truncation replaces the first attempt's parked
    // error body, so the recovered file holds the real log.
    expect(logContent).toContain('FAIL integration-tests/cli/example.test.ts');
    expect(logContent).not.toContain('transient blobstore error');
    expect(output).not.toContain('::warning::');
  });

  it('warns and drops the log only after both attempts fail', () => {
    const { exitCode, output, logCalls, logContent } = runDownloadStep({
      failCalls: '1 2',
    });
    expect(exitCode).toBe(0);
    // Exactly two attempts: a missing retry stops at one, a runaway one
    // downloads a third time.
    expect(logCalls).toBe(2);
    expect(logContent).toBeNull();
    expect(output).toContain(
      '::warning::Could not download the log of job 123',
    );
  });
});
