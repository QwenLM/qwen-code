/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_FIXED_ENV_PREFIX } from '../../../core/src/config/brand.js';
import type { FrameworkFixture as AppFramework } from '../test-utils/frameworkFixture.js';

const ENV_RUNTIME_PACKAGING = `${BRAND_FIXED_ENV_PREFIX}CLI_RUNTIME_PACKAGING`;

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  writeSync: vi.fn(),
  main: vi.fn(async (options: import('./runCli.js').CliOptions) => {
    await options.createFramework?.(
      new AbortController().signal,
      {} as import('@qwen-code/resource').SettingsService,
      'tui',
      {} as import('../framework/appFramework.js').FrameworkInitInput,
    );
    mocks.order.push('main');
  }),
  workerData: { workerRuntime: { cwd: '/workspace' } },
  installCwd: vi.fn(() => {
    mocks.order.push('cwd');
  }),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: mocks.writeSync,
}));
vi.mock('../config/configDirFlag.js', () => ({
  applyConfigDirFlagFromArgv: () => {
    mocks.order.push('config-dir');
  },
}));
vi.mock('./sessionConfigHome.js', () => ({
  initializeSessionConfigHome: async () => {
    mocks.order.push('session-home');
  },
}));
vi.mock('node:worker_threads', () => ({
  workerData: mocks.workerData,
  parentPort: { on: vi.fn(), unref: vi.fn(), postMessage: vi.fn() },
}));
vi.mock('../../../core/src/services/detachedProcessGuard.js', () => ({
  DETACHED_PROCESS_GUARD_SOURCE:
    'process.env.CLI_PROCESS_GUARD_TEST = "started";',
  enableDetachedProcessGuard: vi.fn(),
  stopDetachedProcessGuard: vi.fn(),
}));
vi.mock('../worker/workerCwdShim.js', () => ({
  installWorkerCwdShim: mocks.installCwd,
}));

describe('CLI library bootstrap', () => {
  let argv: string[];
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    argv = process.argv;
    exitCode = process.exitCode;
    vi.resetModules();
    vi.doMock('../qwen.js', () => {
      mocks.order.push('main-module');
      return { main: mocks.main };
    });
    vi.clearAllMocks();
    mocks.order.length = 0;
    vi.stubEnv(ENV_RUNTIME_PACKAGING, 'node_bundle');
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('can be imported without starting the CLI or changing its environment', async () => {
    await import('@qwen-code/qwen-code');
    expect(mocks.order).toEqual([]);
    expect(process.env[ENV_RUNTIME_PACKAGING]).toBe('node_bundle');
  });

  it('applies config-dir before loading the main module or product contributions', async () => {
    const { runCli } = await import('@qwen-code/qwen-code');
    const dependencies = {} as AppFramework;
    const options = {
      createFramework: () => {
        mocks.order.push('product');
        return dependencies;
      },
    };
    await runCli(options);
    expect(mocks.order).toEqual([
      'config-dir',
      'session-home',
      'main-module',
      'product',
      'main',
    ]);
    expect(mocks.main).toHaveBeenCalledExactlyOnceWith(options);
    expect(mocks.installCwd).not.toHaveBeenCalled();
  });

  it('does not reuse product dependencies in a later public invocation', async () => {
    const { runCli } = await import('@qwen-code/qwen-code');
    const createFramework = vi.fn(() => ({}) as AppFramework);
    const options = { createFramework };
    await runCli(options);
    await runCli();
    expect(createFramework).toHaveBeenCalledOnce();
    expect(mocks.main).toHaveBeenNthCalledWith(1, options);
    expect(mocks.main).toHaveBeenNthCalledWith(2, {});
  });

  it.each(['EPERM', 'EACCES', 'ENOENT'])(
    'reports an inaccessible cwd (%s) before config or runtime modules load',
    async (code) => {
      const { runCli } = await import('@qwen-code/qwen-code');
      process.argv = ['node', 'qwen', '--config-dir', './config'];
      const translateFatalError = vi.fn();
      vi.spyOn(process, 'cwd').mockImplementationOnce(() => {
        throw Object.assign(new Error('process.cwd failed'), { code });
      });

      await runCli({ translateFatalError });

      expect(process.exitCode).toBe(1);
      expect(mocks.writeSync).toHaveBeenCalledOnce();
      const [fd, message] = mocks.writeSync.mock.calls[0];
      expect(fd).toBe(2);
      expect(message).toContain(
        `Error: Cannot access the current working directory (${code}).\n`,
      );
      expect(message).toContain('change to an existing, accessible directory');
      expect(message.includes('System Settings')).toBe(
        process.platform === 'darwin' && code !== 'ENOENT',
      );
      expect(mocks.order).toEqual([]);
      expect(mocks.main).not.toHaveBeenCalled();
      expect(translateFatalError).not.toHaveBeenCalled();
    },
  );

  it('reports a cwd failure without an error code', async () => {
    const { runCli } = await import('@qwen-code/qwen-code');
    vi.spyOn(process, 'cwd').mockImplementationOnce(() => {
      throw new Error('cwd unavailable');
    });

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(mocks.writeSync).toHaveBeenCalledWith(
      2,
      'Error: Cannot access the current working directory.\n' +
        'Check directory permissions, or change to an existing, accessible directory and try again.\n',
    );
    expect(mocks.order).toEqual([]);
  });

  it('runs the process guard before config/main even when normal flags follow', async () => {
    vi.stubEnv('CLI_PROCESS_GUARD_TEST', '');
    process.argv = ['node', 'qwen', '--internal-process-guard', '--help'];
    const { runCli } = await import('@qwen-code/qwen-code');
    const factory = vi.fn();
    const options = { createFramework: factory };
    await runCli(options);
    expect(process.env['CLI_PROCESS_GUARD_TEST']).toBe('started');
    expect(mocks.order).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('prepares the worker cwd before loading the shared product assembly', async () => {
    const { runWorkerCli } = await import('@qwen-code/qwen-code');
    const dependencies = {} as AppFramework;
    const options = {
      createFramework: () => {
        mocks.order.push('product');
        return dependencies;
      },
    };
    await runWorkerCli(options);
    expect(mocks.order).toEqual([
      'config-dir',
      'cwd',
      'session-home',
      'main-module',
      'product',
      'main',
    ]);
    expect(mocks.installCwd).toHaveBeenCalledExactlyOnceWith({
      workerData: mocks.workerData,
    });
    expect(mocks.main).toHaveBeenCalledExactlyOnceWith(options);
    expect(process.env[ENV_RUNTIME_PACKAGING]).toBe('node_bundle');
  });
});
