/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

  it.skipIf(process.platform === 'win32')(
    'executes the standalone shim and preserves trusted tokenless mode',
    async () => {
      const launcher = join(directory, 'qwen');
      await writeFile(launcher, '#!/usr/bin/env sh\nprintf "0.24.6\\n"\n');
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
    },
  );

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

  it.skipIf(process.platform === 'win32').each([
    ['missing shebang', 'printf "0.24.6\\n"\n'],
    ['failed startup', '#!/usr/bin/env sh\nexit 3\n'],
    ['invalid version', '#!/usr/bin/env sh\nprintf "invalid\\n"\n'],
  ])('does not close the daemon for %s', async (_reason, content) => {
    const launcher = join(directory, 'qwen');
    await writeFile(launcher, content);
    await chmod(launcher, 0o755);
    const close = vi.fn();
    const restart = createDaemonUpdateRestarter({
      argv: ['serve'],
      env: { PATH: '/usr/bin:/bin' },
      getPort: () => 4170,
      close,
    });
    await expect(restart!(launcher)).rejects.toThrow();
    expect(close).not.toHaveBeenCalled();
    expect(execve).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'checks the launcher with the environment used for restart',
    async () => {
      const launcher = join(directory, 'qwen');
      await writeFile(launcher, '#!/usr/bin/env sh\nprintf "0.24.6\\n"\n');
      await chmod(launcher, 0o755);
      const close = vi.fn();
      const restart = createDaemonUpdateRestarter({
        argv: ['serve'],
        env: { PATH: directory },
        getPort: () => 4170,
        close,
      });
      await expect(restart!(launcher)).rejects.toThrow();
      expect(close).not.toHaveBeenCalled();
      expect(execve).not.toHaveBeenCalled();
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

it.skipIf(!process.execve || ['win32', 'os400'].includes(process.platform))(
  'keeps the listener alive when a real executable has a missing interpreter',
  async () => {
    const directory = await mkdtemp(join(os.tmpdir(), 'qwen-update-native-'));
    try {
      const launcher = join(directory, 'qwen');
      await writeFile(
        launcher,
        `#!${join(directory, 'missing-interpreter')}\n`,
      );
      await chmod(launcher, 0o755);
      const source = `
        import assert from 'node:assert/strict';
        import { createServer } from 'node:http';
        import { createDaemonUpdateRestarter } from ${JSON.stringify(new URL('./daemon-update-restart.ts', import.meta.url).href)};
        const server = createServer((_req, res) => res.end('alive'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        let closed = false;
        const restart = createDaemonUpdateRestarter({
          argv: ['serve'], env: process.env, getPort: () => port,
          close: async () => {
            closed = true;
            await new Promise(resolve => server.close(resolve));
          },
        });
        try {
          await assert.rejects(restart(${JSON.stringify(launcher)}));
          const response = await fetch('http://127.0.0.1:' + port);
          console.log(JSON.stringify({ closed, status: response.status, body: await response.text() }));
        } finally {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
      `;
      const { stdout } = await promisify(execFile)(
        '/bin/sh',
        [
          '-c',
          'ulimit -c 0; exec "$@"',
          'qwen-update-test',
          process.execPath,
          '--import',
          createRequire(import.meta.url).resolve('tsx'),
          '--input-type=module',
          '--eval',
          source,
        ],
        { timeout: 15_000 },
      );
      expect(JSON.parse(stdout)).toEqual({
        closed: false,
        status: 200,
        body: 'alive',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
