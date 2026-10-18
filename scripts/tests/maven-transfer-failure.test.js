/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isMavenTransferFailure } from '../../.github/scripts/ci/maven-transfer-failure.mjs';

const script = fileURLToPath(
  new URL(
    '../../.github/scripts/ci/maven-transfer-failure.mjs',
    import.meta.url,
  ),
);
const job = {
  name: 'Compile Java',
  steps: [
    { name: 'Checkout', conclusion: 'success' },
    { name: 'Compile SDK', conclusion: 'failure' },
  ],
};
const exit = '##[error]Process completed with exit code 1.';
const transfer = (reason) =>
  `Could not transfer artifact org.example:library:jar:1.0 from/to central (https://repo.maven.apache.org/maven2): ${reason}`;
const dependencyError = (reason) =>
  `[ERROR] Failed to execute goal on project qwencode: Could not resolve dependencies for project com.alibaba.qwen:qwencode:jar:0.1.0: ${transfer(reason)} -> [Help 1]`;
const compilationError =
  '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.0:compile (default-compile) on project qwencode: Compilation failure';
const testError =
  '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.3:test (default-test) on project qwencode: There are test failures.';

function mavenFailure(error, help = 'DependencyResolutionException') {
  return [
    '[INFO] Scanning for projects...',
    '[INFO] ------------------------------------------------------------------------',
    '[INFO] BUILD FAILURE',
    '[INFO] ------------------------------------------------------------------------',
    '[INFO] Total time:  2.703 s',
    '[INFO] Finished at: 2026-10-18T02:03:04Z',
    '[INFO] ------------------------------------------------------------------------',
    error,
    '[ERROR] ',
    '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.',
    '[ERROR] Re-run Maven using the -X switch to enable full debug logging.',
    '[ERROR] ',
    '[ERROR] For more information about the errors and possible solutions, please read the following articles:',
    `[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/${help}`,
  ];
}

function stepLog(lines, stepName = 'Compile SDK', jobName = job.name) {
  return lines
    .map(
      (line) => `${jobName}\t${stepName}\t2026-10-18T02:03:04.1234567Z ${line}`,
    )
    .join('\n');
}

const outage = mavenFailure(dependencyError('status code: 503'));

describe('Maven transfer failure classification', () => {
  it.each([
    'status code: 502, reason phrase: Bad Gateway (502)',
    'status code: 503, reason phrase: Service Unavailable (503)',
    'status code: 504, reason phrase: Gateway Timeout (504)',
    'Transfer failed for https://repo.maven.apache.org/maven2/library.pom 503 Service Unavailable',
    'Read timed out',
    'connect timed out',
    'Connection reset',
  ])('recognizes terminal dependency transfer failure: %s', (reason) => {
    expect(
      isMavenTransferFailure(
        job,
        stepLog([...mavenFailure(dependencyError(reason)), exit]),
      ),
    ).toBe(true);
  });

  it.each(['\u001b', '^['])(
    'recognizes plugin resolution with raw or gh-sanitized ANSI: %s',
    (escape) => {
      const lines = mavenFailure(
        `[ERROR] Plugin org.apache.maven.plugins:maven-compiler-plugin:3.14.0 or one of its dependencies could not be resolved: ${transfer('status code: 503')} -> [Help 1]`,
        'PluginResolutionException',
      );
      const colored = lines.map((line) => `${escape}[31m${line}${escape}[0m`);
      colored.push(`${escape}[0m${escape}[0m`);
      expect(isMavenTransferFailure(job, stepLog([...colored, exit]))).toBe(
        true,
      );
    },
  );

  it.each([
    'status code: 401',
    'status code: 403',
    'status code: 404',
    'Transfer failed for https://repo.maven.apache.org/maven2/library.pom 404 Not Found',
  ])('does not retry deterministic repository rejection: %s', (reason) => {
    expect(
      isMavenTransferFailure(
        job,
        stepLog([...mavenFailure(dependencyError(reason)), exit]),
      ),
    ).toBe(false);
  });

  it.each([
    compilationError,
    testError,
    '[ERROR] Could not find artifact org.example:missing:jar:1.0 in central (https://repo.maven.apache.org/maven2)',
    '[ERROR] java.net.SocketTimeoutException: Read timed out',
    '[ERROR] HTTP request failed: status code: 503',
  ])('does not classify an unrelated final error: %s', (error) => {
    expect(
      isMavenTransferFailure(job, stepLog([...mavenFailure(error), exit])),
    ).toBe(false);
  });

  it('does not let a network warning hide a compiler failure', () => {
    const lines = [
      `[WARNING] ${transfer('status code: 503')}`,
      ...mavenFailure(compilationError),
      exit,
    ];
    expect(isMavenTransferFailure(job, stepLog(lines))).toBe(false);
  });

  it.each([compilationError, testError])(
    'uses the final failure after a successful download retry: %s',
    (error) => {
      const lines = [
        ...outage,
        'Retrying Maven...',
        '[INFO] BUILD SUCCESS',
        ...mavenFailure(error),
        exit,
      ];
      expect(isMavenTransferFailure(job, stepLog(lines))).toBe(false);
    },
  );

  it('does not let an earlier Maven error hide a later non-Maven failure', () => {
    const lines = [
      ...outage,
      '[INFO] BUILD SUCCESS',
      'AssertionError: 1 != 2',
      exit,
    ];
    expect(isMavenTransferFailure(job, stepLog(lines))).toBe(false);
  });

  it('does not hide a compiler failure before a later transfer failure', () => {
    const lines = [
      ...mavenFailure(compilationError, 'MojoFailureException'),
      ...outage,
      exit,
    ];
    expect(isMavenTransferFailure(job, stepLog(lines))).toBe(false);
  });

  it('requires every failed step, including logs gh can silently omit', () => {
    const multiStepJob = {
      ...job,
      steps: [...job.steps, { name: 'Compile server', conclusion: 'failure' }],
    };
    const sdk = stepLog([...outage, exit]);
    const server = stepLog([...outage, exit], 'Compile server');
    expect(isMavenTransferFailure(multiStepJob, `${sdk}\n${server}`)).toBe(
      true,
    );
    expect(isMavenTransferFailure(multiStepJob, sdk)).toBe(false);
    expect(
      isMavenTransferFailure(
        multiStepJob,
        `${sdk}\n${stepLog([...mavenFailure(testError), exit], 'Compile server')}`,
      ),
    ).toBe(false);
  });

  it.each([
    ['UNKNOWN STEP', job.name],
    ['Checkout', job.name],
    ['Compile SDK', 'Another job'],
  ])('rejects logs attributed to %s / %s', (stepName, jobName) => {
    expect(
      isMavenTransferFailure(
        job,
        stepLog([...outage, exit], stepName, jobName),
      ),
    ).toBe(false);
  });

  it.each([
    { name: 'empty log', lines: [] },
    { name: 'missing exit marker', lines: outage },
    {
      name: 'successful exit',
      lines: [...outage, '##[error]Process completed with exit code 0.'],
    },
    {
      name: 'output after the exit marker',
      lines: [...outage, exit, '[ERROR] A later command failed'],
    },
    {
      name: 'missing Maven failure summary',
      lines: [dependencyError('status code: 503'), exit],
    },
  ])('rejects $name', ({ lines }) => {
    expect(isMavenTransferFailure(job, stepLog(lines))).toBe(false);
  });

  it('rejects unprefixed logs and missing failed-step metadata', () => {
    expect(isMavenTransferFailure(job, [...outage, exit].join('\n'))).toBe(
      false,
    );
    expect(isMavenTransferFailure({ ...job, steps: [] }, '')).toBe(false);
    expect(
      isMavenTransferFailure(
        { ...job, steps: [job.steps[1], job.steps[1]] },
        stepLog([...outage, exit]),
      ),
    ).toBe(false);
  });
});

describe('Maven transfer failure command', () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function run(metadata, lines = [...outage, exit]) {
    directory = mkdtempSync(join(tmpdir(), 'maven-transfer-failure-'));
    const log = join(directory, 'failed-steps.log');
    writeFileSync(log, stepLog(lines));
    return spawnSync(process.execPath, [script, metadata, log], {
      encoding: 'utf8',
    });
  }

  it('returns success only for a confirmed transfer failure', () => {
    expect(run(JSON.stringify(job)).status).toBe(0);
  });

  it('returns failure for ordinary Maven failures', () => {
    expect(
      run(JSON.stringify(job), [...mavenFailure(compilationError), exit])
        .status,
    ).toBe(1);
  });

  it.each(['{', 'null', '{}', '{"steps":"invalid"}'])(
    'fails closed on invalid metadata: %s',
    (metadata) => {
      expect(run(metadata).status).toBe(1);
    },
  );

  it('fails closed when the downloaded log is missing', () => {
    directory = mkdtempSync(join(tmpdir(), 'maven-transfer-failure-'));
    const result = spawnSync(
      process.execPath,
      [script, JSON.stringify(job), join(directory, 'missing.log')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
  });
});
