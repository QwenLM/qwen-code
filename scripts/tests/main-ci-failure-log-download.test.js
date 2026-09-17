/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The step under test reads the failed job ids through `mapfile -t`, a
// bash >= 4.0 builtin, and pipes the jobs payload through the host's `jq`.
// The nightly macOS lane ships bash 3.2, where the step dies at the mapfile
// before the download loop runs; the production step only ever runs on
// ubuntu-latest, so skip instead of going red. Probe the capability, not the
// platform: a Mac with a newer bash fronting PATH keeps the coverage (the
// `mapfile -d ""` spelling the sibling probe in qwen-autofix-workflow.test.js
// uses needs bash >= 4.4 and would skip hosts this suite runs on).
const canRunStep =
  spawnSync('bash', ['-c', 'mapfile -t x <<< y'], { stdio: 'ignore' })
    .status === 0 &&
  spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

// Executes the failure watcher's log-download step under `bash -e` with `gh`
// stubbed, so the --allow-escape-sequences contract and the warn-and-drop
// fallback are witnessed by bash rather than by shape assertions alone. The
// stub models real gh >= 2.97.0 (GHSA-3m3g-3wcr-px46): a raw textual body
// carrying an ESC byte — which the colourised vitest/pytest logs always do —
// is refused deterministically, on every attempt and with nothing on stdout,
// unless --allow-escape-sequences is passed. A genuine HTTP failure keeps the
// older contract: error body on stdout, status on stderr, non-zero exit.
// Bash-driven, so it is excluded from the Windows lanes in vitest.config.ts.
describe.skipIf(!canRunStep)(
  'main CI failure issue log-download execution',
  () => {
    const stepRun = parse(
      readFileSync('.github/workflows/main-ci-failure-issue.yml', 'utf8'),
    ).jobs.analyze.steps.find(
      (step) => step.name === 'Download failed job logs',
    ).run;

    const ESCAPE_REFUSAL =
      'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway';

    function writeStub(dir) {
      const ghStub = join(dir, 'gh');
      writeFileSync(
        ghStub,
        [
          '#!/usr/bin/env bash',
          'allow_escapes=0',
          "endpoint=''",
          'for arg in "$@"; do',
          '  case "${arg}" in',
          '    --allow-escape-sequences) allow_escapes=1 ;;',
          '    repos/*) endpoint="${arg}" ;;',
          '  esac',
          'done',
          'if [[ "${endpoint}" == repos/*/actions/runs/*/jobs* ]]; then',
          '  printf \'%s\' \'{"jobs":[{"id":123,"conclusion":"failure","name":"macOS shard","steps":[]}]}\'',
          '  exit 0',
          'fi',
          'if [[ "${endpoint}" == repos/*/actions/jobs/*/logs ]]; then',
          '  call=$(( $(cat "${GH_LOG_CALL_COUNT_FILE}") + 1 ))',
          '  printf \'%s\' "${call}" > "${GH_LOG_CALL_COUNT_FILE}"',
          '  if [[ "${GH_LOG_HTTP_FAIL:-}" == \'1\' ]]; then',
          '    printf \'%s\' \'{"message":"transient blobstore error"}\'',
          "    echo 'gh: HTTP 502 (Response Body was not valid JSON)' >&2",
          '    exit 1',
          '  fi',
          '  if [[ "${allow_escapes}" != \'1\' ]]; then',
          `    echo '${ESCAPE_REFUSAL}' >&2`,
          '    exit 1',
          '  fi',
          "  printf '\\033[31mFAIL integration-tests/cli/example.test.ts > suite > case\\033[0m\\n'",
          '  exit 0',
          'fi',
          'echo "unexpected gh call: $*" >&2',
          'exit 1',
        ].join('\n'),
      );
      chmodSync(ghStub, 0o755);
      return ghStub;
    }

    function runDownloadStep({ httpFail = false } = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-main-ci-log-download-'));
      try {
        writeStub(dir);
        const callCountFile = join(dir, 'gh-log-call-count');
        writeFileSync(callCountFile, '0');
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
              GH_LOG_HTTP_FAIL: httpFail ? '1' : '',
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
          logContent: existsSync(logFile)
            ? readFileSync(logFile, 'utf8')
            : null,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('downloads the colourised log because the step passes --allow-escape-sequences', () => {
      const { exitCode, output, logCalls, logContent } = runDownloadStep();
      expect(exitCode).toBe(0);
      expect(logCalls).toBe(1);
      expect(logContent).toContain(
        'FAIL integration-tests/cli/example.test.ts',
      );
      // The stub's log carries the SGR escapes that make gh >= 2.97.0 refuse
      // the response, so this case goes red the moment the step drops the
      // flag — the refusal is deterministic, not a one-attempt flake.
      expect(logContent).toContain('\u001B[31m');
      expect(output).not.toContain('::warning::');
      expect(output).not.toContain(ESCAPE_REFUSAL);
    });

    it('warns and drops the log when the download genuinely fails', () => {
      const { exitCode, output, logCalls, logContent } = runDownloadStep({
        httpFail: true,
      });
      expect(exitCode).toBe(0);
      // One attempt: the refusal class this watcher hits is deterministic, so
      // the step retries nothing.
      expect(logCalls).toBe(1);
      expect(logContent).toBeNull();
      expect(output).toContain(
        '::warning::Could not download the log of job 123',
      );
    });

    it('models gh refusing the escape-carrying log on every attempt without the flag', () => {
      // The download witness above only separates the arms if the stub's
      // refusal is deterministic, so pin the stub contract itself: a stub
      // "simplified" into always succeeding must not silently disarm it.
      const dir = mkdtempSync(join(tmpdir(), 'qwen-main-ci-log-download-'));
      try {
        const ghStub = writeStub(dir);
        const callCountFile = join(dir, 'gh-log-call-count');
        writeFileSync(callCountFile, '0');
        const env = {
          ...process.env,
          GH_LOG_CALL_COUNT_FILE: callCountFile,
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refused = spawnSync(
            ghStub,
            ['api', 'repos/o/r/actions/jobs/123/logs'],
            { encoding: 'utf8', env },
          );
          expect(refused.status).toBe(1);
          expect(refused.stdout).toBe('');
          expect(refused.stderr).toContain(ESCAPE_REFUSAL);
        }
        expect(Number(readFileSync(callCountFile, 'utf8'))).toBe(2);
        const allowed = spawnSync(
          ghStub,
          [
            'api',
            '--allow-escape-sequences',
            'repos/o/r/actions/jobs/123/logs',
          ],
          { encoding: 'utf8', env },
        );
        expect(allowed.status).toBe(0);
        expect(allowed.stdout).toContain(
          'FAIL integration-tests/cli/example.test.ts',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

it('gates the bash-execution suite on the host capability probe', () => {
  // The suite above spawns the real step, which dies at its `mapfile` on a
  // bash 3.2 host (the nightly macOS lane) before any assertion runs. A
  // dropped gate turns that lane red on a script it cannot execute, so the
  // gate's presence is pinned here, on every host.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  expect(self).toMatch(/describe\.skipIf\(!canRunStep\)\(/);
});
