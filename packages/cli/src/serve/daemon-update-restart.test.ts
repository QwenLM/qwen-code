/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { createDaemonUpdateRestarter } from './daemon-update-restart.js';

const execve = vi.fn<NonNullable<typeof process.execve>>();

describe('daemon update restart', () => {
  let directory: string;
  beforeEach(async () => {
    execve.mockReset();
    vi.stubGlobal('process', { ...process, execve });
    directory = await mkdtemp(join(os.tmpdir(), 'qwen-update-restart-'));
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves the CLI configuration and effective port/token while clearing version pins', async () => {
    const launcher = join(directory, 'cli-entry.js');
    await writeFile(launcher, '');
    const events: string[] = [];
    execve.mockImplementation(() => {
      events.push('exec');
      return undefined as never;
    });
    const close = vi.fn(async () => {
      events.push('close');
    });
    const env = {
      QWEN_SERVER_TOKEN: 'stale',
      QWEN_CODE_MANAGED_NPM_PIN: 'old',
      QWEN_CODE_STARTUP_VERSION: '1.0.0',
      QWEN_CODE_RELAUNCH_ARGS: '[]',
      CLI_VERSION: '1.0.0',
      QWEN_HOME: '/home/qwen',
    };
    let port = 0;
    const restart = createDaemonUpdateRestarter({
      argv: [
        'serve',
        '--workspace',
        '/project one',
        '--workspace=/project-two',
        '--port=0',
        '--hostname',
        '0.0.0.0',
        '--token',
        'argv-secret',
        '--open-with-auth',
        '--allow-origin',
        'https://host',
        '--require-auth',
        '--tls-cert=/cert.pem',
        '--tls-key=/key.pem',
      ],
      env,
      token: 'effective-secret',
      externalToolGuardToken: 'guard-secret',
      getPort: () => port,
      close,
    });
    port = 48123;
    expect(restart).toBeTypeOf('function');
    await restart!(launcher);
    expect(events).toEqual(['close', 'exec']);
    expect(execve).toHaveBeenCalledWith(
      process.execPath,
      [
        process.execPath,
        ...process.execArgv,
        launcher,
        'serve',
        '--workspace',
        '/project one',
        '--workspace=/project-two',
        '--hostname',
        '0.0.0.0',
        '--allow-origin',
        'https://host',
        '--require-auth',
        '--tls-cert=/cert.pem',
        '--tls-key=/key.pem',
        '--port',
        '48123',
      ],
      {
        QWEN_HOME: '/home/qwen',
        QWEN_SERVER_TOKEN: 'effective-secret',
        QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN: 'guard-secret',
      },
    );
    expect(env.QWEN_CODE_MANAGED_NPM_PIN).toBe('old');
  });

  it('executes the standalone shim and preserves trusted tokenless mode', async () => {
    const launcher = join(directory, 'qwen');
    await writeFile(launcher, '#!/bin/sh\nexit 0\n');
    await chmod(launcher, 0o755);
    execve.mockReturnValue(undefined as never);
    const restart = createDaemonUpdateRestarter({
      argv: [
        'serve',
        '--port',
        '0',
        '--open',
        'true',
        '--open-with-auth=false',
        '--no-open',
      ],
      env: { QWEN_SERVER_TOKEN: 'unused' },
      getPort: () => 4170,
      close: async () => {},
    });
    await restart!(launcher);
    expect(execve).toHaveBeenCalledWith(
      launcher,
      [launcher, 'serve', '--port', '4170'],
      {},
    );
  });

  it.each(['win32', 'os400'] as const)(
    'does not provide a restart callback on %s',
    (platform) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform as NodeJS.Platform);
      expect(
        createDaemonUpdateRestarter({
          argv: ['serve'],
          env: {},
          getPort: () => 4170,
          close: async () => {},
        }),
      ).toBeUndefined();
    },
  );

  it('requires execve and an unambiguous serve entrypoint', () => {
    const options = { env: {}, getPort: () => 4170, close: async () => {} };
    expect(
      createDaemonUpdateRestarter({ ...options, argv: ['other-app'] }),
    ).toBeUndefined();
    expect(
      createDaemonUpdateRestarter({
        ...options,
        argv: ['serve', '--', '--port', '0'],
      }),
    ).toBeUndefined();
    vi.stubGlobal('process', { ...process, execve: undefined });
    expect(
      createDaemonUpdateRestarter({ ...options, argv: ['serve'] }),
    ).toBeUndefined();
  });

  it('does not close the daemon for a missing launcher or execute after failed drain', async () => {
    execve.mockReturnValue(undefined as never);
    const close = vi.fn().mockRejectedValue(new Error('Drain failed'));
    const restart = createDaemonUpdateRestarter({
      argv: ['serve'],
      env: {},
      getPort: () => 4170,
      close,
    });
    await expect(restart!(join(directory, 'missing'))).rejects.toThrow();
    expect(close).not.toHaveBeenCalled();
    const launcher = join(directory, 'cli-entry.js');
    await writeFile(launcher, '');
    await expect(restart!(launcher)).rejects.toThrow('Drain failed');
    expect(execve).not.toHaveBeenCalled();
  });
});
