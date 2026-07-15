/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import path from 'node:path';

describe('getLinterTempDir', () => {
  const originalArgv = process.argv;
  const tempDirs = [];

  beforeEach(() => {
    process.argv = ['node', 'scripts/lint.js', '--test-import'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('isolates GitHub Actions linter installs by run and job', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834362',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'test',
      },
    });
    const second = getLinterTempDir({
      cwd: '/runner/_work/qwen-code/qwen-code',
      env: {
        RUNNER_TEMP: '/runner/_work/_temp',
        GITHUB_RUN_ID: '28501834363',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'integration_cli',
      },
    });

    expect(first).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834362-1-test',
    );
    expect(second).toBe(
      '/runner/_work/_temp/qwen-code-linters/28501834363-1-integration_cli',
    );
    expect(first).not.toBe(second);
  });

  it('isolates local linter installs by workspace', async () => {
    const { getLinterTempDir } = await import('../lint.js');

    const first = getLinterTempDir({
      cwd: '/tmp/qwen-code-a',
      env: {},
    });
    const second = getLinterTempDir({
      cwd: '/tmp/qwen-code-b',
      env: {},
    });

    expect(first).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(second).toMatch(/\/qwen-code-linters\/local-[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
  });

  it('uses the owned yamllint target without a version-specific user path', async () => {
    const { createLinterEnvironment } = await import('../lint.js');

    const environment = createLinterEnvironment({
      cwd: '/workspace',
      env: {
        HOME: '/caller/home',
        PATH: '/usr/bin',
        PIP_CONFIG_FILE: '/caller/pip.conf',
        PIP_REQUIRE_VIRTUALENV: 'true',
        PIP_USER: 'true',
        PYTHONPATH: '/caller/python',
      },
      tempDir: '/owned/linters',
    });

    expect(environment.PATH.split(path.delimiter)).toEqual([
      '/workspace/node_modules/.bin',
      '/owned/linters/actionlint',
      '/owned/linters/shellcheck',
      '/owned/linters/yamllint/bin',
      '/usr/bin',
    ]);
    expect(environment.PYTHONPATH).toBe(
      ['/owned/linters/yamllint', '/caller/python'].join(path.delimiter),
    );
    expect(environment).toMatchObject({
      PIP_CONFIG_FILE: '/dev/null',
      PIP_REQUIRE_VIRTUALENV: 'false',
      PIP_USER: 'false',
      PYTHONNOUSERSITE: '1',
    });
    expect(Object.values(environment).join(path.delimiter)).not.toContain(
      'Python/3.12',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'recognizes the pinned linter version output',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'lint-version-test-'));
      tempDirs.push(root);
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const log = path.join(root, 'versions.log');
      const executables = {
        actionlint:
          '#!/bin/sh\necho actionlint >> "$LINTER_VERSION_LOG"\necho 1.7.12\n',
        curl: '#!/bin/sh\nexit 99\n',
        python3: '#!/bin/sh\nexit 99\n',
        shellcheck:
          '#!/bin/sh\necho shellcheck >> "$LINTER_VERSION_LOG"\necho "ShellCheck - shell script analysis tool"\necho "version: 0.11.0"\n',
        tar: '#!/bin/sh\nexit 99\n',
        yamllint:
          '#!/bin/sh\necho yamllint >> "$LINTER_VERSION_LOG"\necho "yamllint 1.35.1"\n',
      };
      for (const [name, contents] of Object.entries(executables)) {
        const executable = path.join(bin, name);
        writeFileSync(executable, contents);
        chmodSync(executable, 0o755);
      }

      const result = spawnSync(
        process.execPath,
        ['scripts/lint.js', '--setup'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: {
            ...process.env,
            LINTER_VERSION_LOG: log,
            PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
            RUNNER_TEMP: path.join(root, 'runner'),
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('Installing ');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'actionlint',
        'shellcheck',
        'yamllint',
      ]);
    },
  );
});
