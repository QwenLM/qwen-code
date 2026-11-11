/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRAND_FIXED_ENV_PREFIX,
  ENV_GIT_BASH_PATH,
  ENV_CONFIG_DIR,
  ENV_SHELL_PREFIX,
  ENV_SHELL_PREFIX_COMPAT,
} from '../../config/brand.js';
import { createBashShellProvider } from './bashProvider.js';
import type { ShellProvider, ShellSessionContext } from './shellProvider.js';
import { windowsPathToPosixPath } from '../windowsPaths.js';

const shell =
  process.platform === 'win32'
    ? (process.env[ENV_GIT_BASH_PATH] ??
      'C:\\Program Files\\Git\\bin\\bash.exe')
    : '/bin/bash';
const execFileAsync = promisify(execFile);

/** ShellSessionContext 的成员都是必填的，而多数用例只关心其中一个。 */
function sessionContext(
  overrides: Partial<ShellSessionContext> = {},
): ShellSessionContext {
  return {
    getPluginBinPaths: () => [],
    getSessionEnvScript: async () => null,
    ...overrides,
  };
}

// Intentionally runs on Windows too. CI needs Git for Windows installed (or
// the branded Git Bash path override); a missing shell must not silently skip the regression.
describe('Bash wrapper execution', () => {
  let directory: string;
  const cwdFiles: string[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'test-bash-regression-'));
    vi.stubEnv(ENV_CONFIG_DIR, '');

    vi.stubEnv(ENV_SHELL_PREFIX, '');
    vi.stubEnv(ENV_SHELL_PREFIX_COMPAT, '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      cwdFiles.splice(0).map((file) => rm(file, { force: true })),
    );
    await rm(directory, { recursive: true, force: true });
  });

  async function run(
    built: Awaited<ReturnType<ShellProvider['buildExecCommand']>>,
  ) {
    cwdFiles.push(built.cwdFilePath);
    return execFileAsync(
      shell,
      ['--noprofile', '--norc', '-c', built.commandString],
      {
        cwd: directory,
        env: {
          ...process.env,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          ...built.env,
        },
        timeout: 5000,
        windowsHide: true,
      },
    );
  }

  it('preserves CJK heredoc, quotes and backslashes with a long special-character PATH', async () => {
    const specialPath = path.join(directory, '中文 插件\'"$HOME`x`', 'bin');
    const paths = [
      specialPath,
      ...Array.from({ length: 250 }, (_, i) =>
        path.join(directory, `plugin-${i}`, 'bin'),
      ),
    ];
    const provider = await createBashShellProvider(shell, {
      skipSnapshot: true,
    });
    const body = String.raw`中文 日本語 한국어 ' " $HOME \\`;
    const command = `while IFS= read -r line; do printf '%s\\n' "$line"; done <<'PAYLOAD'\n${body}\nPAYLOAD\nprintf '%s\\n' "$PATH"`;
    const built = await provider.buildExecCommand(command, {
      id: path.basename(directory),
      sessionContext: sessionContext({ getPluginBinPaths: () => paths }),
    });
    expect(built.commandString).not.toContain('plugin-249');
    expect(provider.getSpawnArgs(built.commandString)).toContain('-l');
    const { stdout, stderr } = await run(built);
    const prefix =
      process.platform === 'win32'
        ? windowsPathToPosixPath(specialPath)
        : specialPath;
    expect(stdout.split('\n')[0]).toBe(body);
    expect(stdout.split('\n')[1]).toMatch(
      new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'),
    );
    expect(stderr).toBe('');
  });

  it('keeps per-command PATH values isolated across sessions and concurrent execution', async () => {
    const provider = await createBashShellProvider(shell, {
      skipSnapshot: true,
    });
    const first = await provider.buildExecCommand('printf "%s" "$PATH"', {
      id: `${path.basename(directory)}-1`,
      sessionContext: sessionContext({
        getPluginBinPaths: () => [path.join(directory, 'first')],
      }),
    });
    const second = await provider.buildExecCommand('printf "%s" "$PATH"', {
      id: `${path.basename(directory)}-2`,
      sessionContext: sessionContext({
        getPluginBinPaths: () => [path.join(directory, 'second')],
      }),
    });
    const results = await Promise.all([run(first), run(second)]);
    expect(results[0].stdout.split(':')[0]).toContain('/first');
    expect(results[1].stdout.split(':')[0]).toContain('/second');
  });

  it.each(['false', 'readonly PATH'])(
    'does not run user code after setup fails: %s',
    async (setup) => {
      const provider = await createBashShellProvider(shell, {
        skipSnapshot: true,
      });
      const built = await provider.buildExecCommand('printf SHOULD_NOT_RUN', {
        id: path.basename(directory),
        sessionContext: sessionContext({
          getPluginBinPaths: () => [path.join(directory, 'plugin')],
          getSessionEnvScript: async () => setup,
        }),
      });
      await expect(run(built)).rejects.toMatchObject({ code: 1, stdout: '' });
    },
  );

  it('retains aliases defined by session setup before eval', async () => {
    const provider = await createBashShellProvider(shell, {
      skipSnapshot: true,
    });
    const built = await provider.buildExecCommand('fixture_alias', {
      id: path.basename(directory),
      sessionContext: sessionContext({
        getSessionEnvScript: async () =>
          `shopt -s expand_aliases; alias fixture_alias='printf alias-ok'`,
      }),
    });
    expect((await run(built)).stdout).toBe('alias-ok');
  });

  it('preserves native PATH without adding the current directory when the prefix is filtered', async () => {
    const provider = await createBashShellProvider(shell, {
      skipSnapshot: true,
    });
    const built = await provider.buildExecCommand('printf "%s" "$PATH"', {
      id: path.basename(directory),
      sessionContext: sessionContext({
        getPluginBinPaths: () => [path.join(directory, 'plugin')],
        getSessionEnvScript: async () => 'export PATH=/usr/bin:/bin',
      }),
    });
    expect(
      (
        await run({
          ...built,
          env: { [`__${BRAND_FIXED_ENV_PREFIX}BASH_PATH_PREFIX`]: '' },
        })
      ).stdout,
    ).toBe('/usr/bin:/bin');
  });

  it('preserves plugin PATH through a configured prefix that clears inherited environment', async () => {
    const wrapper = path.join(directory, 'clean-shell');
    await writeFile(
      wrapper,
      '#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash -c "$1"\n',
      { mode: 0o700 },
    );
    vi.stubEnv(
      ENV_SHELL_PREFIX,
      process.platform === 'win32' ? windowsPathToPosixPath(wrapper) : wrapper,
    );
    const provider = await createBashShellProvider(shell, {
      skipSnapshot: true,
    });
    const built = await provider.buildExecCommand('printf "%s" "$PATH"', {
      id: path.basename(directory),
      sessionContext: sessionContext({
        getPluginBinPaths: () => [path.join(directory, 'plugin')],
      }),
    });
    expect((await run(built)).stdout.split(':')[0]).toContain('/plugin');
  });
});
