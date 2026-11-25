/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellProvider } from './shell/shellProvider.js';

const mocks = vi.hoisted(() => ({
  createBashShellProvider: vi.fn(),
}));

vi.mock('./shell/bashProvider.js', () => ({
  createBashShellProvider: mocks.createBashShellProvider,
}));

vi.mock('./platform.js', () => ({
  getPlatform: () => 'darwin',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(async () => undefined),
  };
});

import {
  exec,
  prewarmShellProvider,
  resetForTest,
} from './Shell.js';

function createProvider(): ShellProvider {
  return {
    type: 'bash',
    shellPath: '/bin/bash',
    detached: true,
    buildExecCommand: vi.fn(),
    getSpawnArgs: vi.fn(),
    getEnvironmentOverrides: vi.fn(),
  };
}

describe('Shell provider prewarming', () => {
  beforeEach(() => {
    vi.stubEnv('SHELL', '/bin/bash');
    mocks.createBashShellProvider.mockReset();
    resetForTest();
  });

  afterEach(() => {
    resetForTest();
    vi.unstubAllEnvs();
  });

  it('shares one in-flight provider across concurrent callers', async () => {
    let resolveProvider!: (provider: ShellProvider) => void;
    const providerPromise = new Promise<ShellProvider>((resolve) => {
      resolveProvider = resolve;
    });
    mocks.createBashShellProvider.mockReturnValue(providerPromise);

    const first = prewarmShellProvider();
    const second = prewarmShellProvider();
    const third = prewarmShellProvider();

    await vi.waitFor(() => {
      expect(mocks.createBashShellProvider).toHaveBeenCalledOnce();
    });

    resolveProvider(createProvider());
    await Promise.all([first, second, third]);
    await prewarmShellProvider();

    expect(mocks.createBashShellProvider).toHaveBeenCalledOnce();
  });

  it('forwards the prewarm abort signal to snapshot creation', async () => {
    const abortController = new AbortController();
    mocks.createBashShellProvider.mockResolvedValue(createProvider());

    await prewarmShellProvider('bash', {
      signal: abortController.signal,
    });

    expect(mocks.createBashShellProvider).toHaveBeenCalledWith(
      '/bin/bash',
      expect.objectContaining({
        signal: abortController.signal,
      }),
    );
  });

  it.each(['prewarm', 'command'] as const)(
    'cancels one command wait while preserving initialization started by %s',
    async (firstCaller) => {
      let finish!: (provider: ShellProvider) => void;
      const provider = createProvider();
      vi.mocked(provider.buildExecCommand).mockResolvedValue({
        commandString: '',
        cwdFilePath: '',
      });
      mocks.createBashShellProvider.mockReturnValue(
        new Promise<ShellProvider>((resolve) => {
          finish = resolve;
        }),
      );
      const lifecycle = new AbortController();
      const commandAbort = new AbortController();
      const prewarm =
        firstCaller === 'prewarm'
          ? prewarmShellProvider('bash', { signal: lifecycle.signal })
          : undefined;
      const pending = exec('must not execute', commandAbort.signal);
      const shared = prewarm ?? prewarmShellProvider();
      let commandSettled = false;
      void pending.then(
        () => {
          commandSettled = true;
        },
        () => {},
      );
      let sharedSettled = false;
      void shared.then(() => {
        sharedSettled = true;
      });
      try {
        await vi.waitFor(() =>
          expect(mocks.createBashShellProvider).toHaveBeenCalledOnce(),
        );
        commandAbort.abort();
        await vi.waitFor(() => expect(commandSettled).toBe(true), {
          timeout: 500,
        });
        expect(await (await pending).result).toMatchObject({ interrupted: true });
        expect(sharedSettled).toBe(false);
        expect(lifecycle.signal.aborted).toBe(false);
        expect(provider.buildExecCommand).not.toHaveBeenCalled();
        finish(provider);
        await shared;
        await prewarmShellProvider();
        expect(mocks.createBashShellProvider).toHaveBeenCalledOnce();
      } finally {
        finish(provider);
        await shared;
        await pending.catch(() => {});
      }
    },
  );

  it('allows a later retry when provider creation rejects', async () => {
    mocks.createBashShellProvider
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce(createProvider());

    await expect(prewarmShellProvider()).rejects.toThrow('provider failed');
    await expect(prewarmShellProvider()).resolves.toBeUndefined();

    expect(mocks.createBashShellProvider).toHaveBeenCalledTimes(2);
  });
});
