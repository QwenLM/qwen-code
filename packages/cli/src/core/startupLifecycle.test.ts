/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import { runAfterConfigInitializedStartup } from './startupLifecycle.js';
import {
  AuthType,
  getSystemContext,
  createConfigStartupRuntime,
  prewarmShellProvider,
  runLogger,
} from '@qwen-code/core';
import { registerCleanup } from '../utils/cleanup.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getSystemContext: vi.fn(async () => ({ gitStatus: 'on branch main' })),
    prewarmShellProvider: vi.fn(async () => {}),
    runLogger: {
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock('../utils/cleanup.js', () => ({
  registerCleanup: vi.fn(),
}));

describe('startupLifecycle', () => {
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prewarmShellProvider).mockResolvedValue(undefined);
    const startupRuntime = createConfigStartupRuntime();
    startupRuntime.markReady('base');
    config = {
      permission: { getRules: () => ({ allow: {}, deny: {}, ask: {} }) },
      getBuiltinPluginContributions: () => undefined,
      fakeResponses: false,
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.QODER_BROWSER,
      })),
      getStartupRuntime: vi.fn(() => startupRuntime),
      getToolRegistry: vi.fn(() => ({
        tools: [],
        getTool: vi.fn((name: string) =>
          name === 'Bash' ? { name: 'Bash' } : undefined,
        ),
      })),
      getSessionId: vi.fn(() => 'session-1'),
      getWorkingDir: vi.fn(() => '/repo'),
      isTrustedFolder: vi.fn(() => true),
      isInitialized: vi.fn(() => true),
    } as unknown as Config;
  });

  it('skips startup work while config is not initialized', async () => {
    vi.mocked(config.isInitialized).mockReturnValueOnce(false);

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(false);
    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);
  });

  it('prewarms Bash and aborts unfinished work during cleanup', async () => {
    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(prewarmShellProvider).toHaveBeenCalledExactlyOnceWith(
      'bash',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(registerCleanup).toHaveBeenCalledTimes(2);

    const signal = vi.mocked(prewarmShellProvider).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    for (const [cleanup] of vi.mocked(registerCleanup).mock.calls) {
      await cleanup();
    }

    expect(signal?.aborted).toBe(true);
  });

  it('does not prewarm when the Bash tool is unavailable', async () => {
    vi.mocked(config.getToolRegistry).mockReturnValueOnce({
      getTool: vi.fn(() => undefined),
    } as unknown as ReturnType<Config['getToolRegistry']>);

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(prewarmShellProvider).not.toHaveBeenCalled();
    expect(registerCleanup).toHaveBeenCalledOnce();
  });

  it('does not wait for shell prewarming to complete', async () => {
    vi.mocked(prewarmShellProvider).mockReturnValueOnce(
      new Promise<void>(() => {}),
    );

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(prewarmShellProvider).toHaveBeenCalledOnce();
  });

  it('prewarms the git system context for the session working directory', async () => {
    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(getSystemContext).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      '/repo',
      {
        signal: expect.any(AbortSignal),
      },
    );
    await vi.waitFor(() => {
      expect(runLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('[system-context] git prewarm scheduled'),
      );
      expect(runLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('[system-context] git prewarm completed'),
      );
    });
  });

  it('cancels the git system context prewarm during cleanup', async () => {
    vi.mocked(getSystemContext).mockImplementationOnce(
      (_sessionId, _cwd, options) => {
        const signal = options?.signal;
        return new Promise<Record<string, string>>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    const gitSignal = vi.mocked(getSystemContext).mock.calls[0]?.[2]?.signal;
    expect(gitSignal?.aborted).toBe(false);

    for (const [cleanup] of vi.mocked(registerCleanup).mock.calls) {
      await cleanup();
    }

    expect(gitSignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(runLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('[system-context] git prewarm cancelled'),
      );
    });
  });

  it('does not prewarm the git system context in an untrusted folder', async () => {
    vi.mocked(config.isTrustedFolder).mockReturnValue(false);

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(getSystemContext).not.toHaveBeenCalled();
  });

  it('does not wait for the git system context prewarm to complete', async () => {
    vi.mocked(getSystemContext).mockReturnValueOnce(
      new Promise<Record<string, string>>(() => {}),
    );

    await expect(runAfterConfigInitializedStartup(config)).resolves.toBe(true);

    expect(getSystemContext).toHaveBeenCalledOnce();
  });
});
