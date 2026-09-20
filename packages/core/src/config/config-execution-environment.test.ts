/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Config,
  ApprovalMode,
  deriveConfig,
  deriveApprovalModeConfig,
  deriveWorktreeConfig,
} from './config.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolMode } from '../tools/code-mode.js';
import type { DebugLogger } from '../utils/debugLogger.js';
import {
  ExecutionCleanupError,
  type ExecutionEnvironment,
} from '../services/execution-environment.js';

const params = {
  targetDir: '/tmp',
  cwd: '/tmp',
  debugMode: false,
  model: 'test',
};
const shutdownOptions = {
  shutdownTelemetry: false,
  skipSessionWriter: true,
  strictResourceCleanup: true,
};

describe('execution environment ownership', () => {
  it('aborts startup before other shutdown work and refuses new factory lookups', async () => {
    let startupSignal!: AbortSignal;
    const factory = vi.fn((_config: Config, signal: AbortSignal) => {
      startupSignal = signal;
      return new Promise<ExecutionEnvironment>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const config = new Config({
      ...params,
      executionEnvironmentFactory: factory,
    });
    const caller = new AbortController();
    const pending = config.getExecutionEnvironmentFactory()!(
      config,
      caller.signal,
    );
    config.registerExecutionEnvironment(pending);
    const rejected = pending.catch((error: unknown) => error);
    const shutdown = config.shutdown(shutdownOptions);
    expect(startupSignal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(config.getExecutionEnvironmentFactory()).toBeUndefined();
    expect(await rejected).toBeInstanceOf(Error);
    await shutdown;
  });

  it.each([false, true])(
    'bounds stalled startup and visibly retains cleanup ownership (strict=%s)',
    async (strictResourceCleanup) => {
      vi.useFakeTimers();
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const config = new Config(params);
      let finishStartup!: (environment: ExecutionEnvironment) => void;
      const dispose = vi.fn().mockResolvedValue(undefined);
      config.registerExecutionEnvironment(
        new Promise((resolve) => {
          finishStartup = resolve;
        }),
      );
      const shutdown = config
        .shutdown({
          ...shutdownOptions,
          strictResourceCleanup,
        })
        .catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await shutdown;
        if (strictResourceCleanup) {
          expect(result).toMatchObject({
            message: expect.stringContaining(
              'Container execution cleanup failed',
            ),
          });
        } else {
          expect(result).toBeUndefined();
        }
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('workspace /tmp'),
        );
        expect(dispose).not.toHaveBeenCalled();
        finishStartup({ dispose } as unknown as ExecutionEnvironment);
        await vi.advanceTimersByTimeAsync(0);
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        warning.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('does not wait for unrelated session resources before starting container disposal', async () => {
    const config = new Config(params);
    (config as unknown as { initialized: boolean }).initialized = true;
    let finishRegistry!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRegistry = resolve;
        }),
    );
    (
      config as unknown as { toolRegistry: { stop: typeof stop } }
    ).toolRegistry = { stop };
    const dispose = vi.fn().mockResolvedValue(undefined);
    config.registerExecutionEnvironment(
      Promise.resolve({ dispose } as unknown as ExecutionEnvironment),
    );
    const shutdown = config.shutdown(shutdownOptions);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledOnce();
    finishRegistry();
    await shutdown;
  });

  it('preserves the operator requirement through derivation and shutdown without a factory', async () => {
    const config = new Config({
      ...params,
      agentExecutionBackend: 'container',
      executionEnvironmentFactory: vi.fn(),
    });
    const worktree = deriveWorktreeConfig(config, '/tmp/child');
    const { config: approval, cleanup } = deriveApprovalModeConfig(
      worktree,
      ApprovalMode.PLAN,
    );
    const child = deriveConfig(approval, {
      getExecutionEnvironmentFactory: () => undefined,
    });
    for (const context of [config, worktree, approval, child]) {
      expect(context.getAgentExecutionBackend()).toBe('container');
    }
    await config.shutdown(shutdownOptions);
    expect(config.getExecutionEnvironmentFactory()).toBeUndefined();
    expect(child.getExecutionEnvironmentFactory()).toBeUndefined();
    expect(child.getAgentExecutionBackend()).toBe('container');
    expect(new Config(params).getAgentExecutionBackend()).toBeUndefined();
    cleanup();
  });

  it.each([false, true])(
    'respects the LS tool opt-in with a container registry: %s',
    async (enabled) => {
      const parent = new Config({ ...params, lsToolEnabled: enabled });
      const child = deriveConfig(parent, {
        getExecutionEnvironment: () => ({}) as ExecutionEnvironment,
      });
      const registry = await child.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      const names = registry.getAllToolNames();
      expect(names.includes(ToolNames.LS)).toBe(enabled);
      expect(names).toContain(ToolNames.READ_FILE);
    },
  );

  it.each(['cleanupArenaRuntime', 'cleanupTeamRuntime'] as const)(
    'logs %s failures during non-strict shutdown',
    async (method) => {
      const config = new Config(params);
      (config as unknown as { initialized: boolean }).initialized = true;
      const failure = new Error('runtime cleanup failed');
      const log = vi
        .spyOn(
          (config as unknown as { debugLogger: DebugLogger }).debugLogger,
          'error',
        )
        .mockImplementation(() => undefined);
      vi.spyOn(config, 'cleanupArenaRuntime').mockResolvedValue(undefined);
      vi.spyOn(config, 'cleanupTeamRuntime').mockResolvedValue(undefined);
      vi.spyOn(config, method).mockRejectedValue(failure);
      try {
        await expect(
          config.shutdown({ ...shutdownOptions, strictResourceCleanup: false }),
        ).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith(
          'Error during session runtime cleanup:',
          failure,
        );
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('rejects a code-mode-only container registry for direct derived Config callers', async () => {
    const parent = new Config({
      ...params,
      toolMode: ToolMode.CodeModeOnly,
    });
    const child = deriveConfig(parent, {
      getExecutionEnvironment: () => ({}) as ExecutionEnvironment,
    });
    await expect(
      child.createToolRegistry(undefined, { skipDiscovery: true }),
    ).rejects.toThrow('tools.mode = "code_mode_only"');
    expect(parent.getCodeModeOnly()).toBe(true);
    expect(parent.getExecutionEnvironment()).toBeUndefined();
  });

  it('warns when a hybrid container registry falls back to direct tools', async () => {
    const parent = new Config({ ...params, toolMode: ToolMode.CodeMode });
    const child = deriveConfig(parent, {
      getExecutionEnvironment: () => ({}) as ExecutionEnvironment,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registry = await child.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      expect(registry.getAllToolNames()).toContain(ToolNames.READ_FILE);
      expect(registry.getAllToolNames()).not.toContain(ToolNames.EXEC);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('continuing with direct tools'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['ready', 'starting'])(
    'waits for %s environments during session shutdown',
    async (state) => {
      let releaseDisposal!: () => void;
      const disposal = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
      const environment = {
        dispose: vi.fn().mockReturnValue(disposal),
      } as unknown as ExecutionEnvironment;
      const factory = vi.fn().mockResolvedValue(environment);
      const config = new Config({
        ...params,
        executionEnvironmentFactory: factory,
      });
      (config as unknown as { initialized: boolean }).initialized = true;
      const arenaCleanup = vi
        .spyOn(config, 'cleanupArenaRuntime')
        .mockResolvedValue(undefined);
      const teamCleanup = vi
        .spyOn(config, 'cleanupTeamRuntime')
        .mockResolvedValue(undefined);
      let finishStartup!: (environment: ExecutionEnvironment) => void;
      const startup =
        state === 'ready'
          ? Promise.resolve(environment)
          : new Promise<ExecutionEnvironment>((resolve) => {
              finishStartup = resolve;
            });
      deriveConfig(config).registerExecutionEnvironment(startup);
      let closed = false;
      const shutdown = config.shutdown(shutdownOptions).then(() => {
        closed = true;
      });
      expect(config.getExecutionEnvironmentFactory()).toBeUndefined();
      if (state === 'starting') {
        await Promise.resolve();
        expect(environment.dispose).not.toHaveBeenCalled();
        expect(closed).toBe(false);
        finishStartup(environment);
      }
      await vi.waitFor(() =>
        expect(environment.dispose).toHaveBeenCalledOnce(),
      );
      expect(closed).toBe(false);
      expect(arenaCleanup).not.toHaveBeenCalled();
      expect(teamCleanup).not.toHaveBeenCalled();
      releaseDisposal();
      await shutdown;
      expect(closed).toBe(true);
      expect(arenaCleanup).toHaveBeenCalledOnce();
      expect(teamCleanup).toHaveBeenCalledOnce();
    },
  );

  it('forgets an environment whose owner finished cleanup', async () => {
    const config = new Config(params);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const unregister = config.registerExecutionEnvironment(
      Promise.resolve({ dispose } as unknown as ExecutionEnvironment),
    );
    unregister();
    await config.shutdown(shutdownOptions);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('accepts an ordinary startup failure that already cleaned up', async () => {
    const config = new Config(params);
    config.registerExecutionEnvironment(
      Promise.reject(new Error('Image unavailable')),
    );
    await expect(config.shutdown(shutdownOptions)).resolves.toBeUndefined();
  });

  it('reports a startup cleanup failure', async () => {
    const config = new Config(params);
    const error = new ExecutionCleanupError('Container is still running');
    config.registerExecutionEnvironment(Promise.reject(error));
    await expect(config.shutdown(shutdownOptions)).rejects.toMatchObject({
      errors: [error],
    });
  });

  it('shares timed-out startup recovery until cleanup actually finishes', async () => {
    vi.useFakeTimers();
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    let finish!: () => void;
    const retryCleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const config = new Config(params);
    config.registerExecutionEnvironment(
      Promise.reject(
        new ExecutionCleanupError('startup cleanup failed', { retryCleanup }),
      ),
    );
    try {
      const first = config.shutdownExecutionEnvironments();
      const rejected = first.catch((error: unknown) => error);
      expect(config.shutdownExecutionEnvironments()).toBe(first);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await rejected).toMatchObject({
        message: expect.stringContaining('cleanup is still pending'),
      });
      expect(config.shutdownExecutionEnvironments()).toBe(first);
      expect(retryCleanup).toHaveBeenCalledOnce();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        config.shutdownExecutionEnvironments(),
      ).resolves.toBeUndefined();
      expect(retryCleanup).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves workspace runtimes when container cleanup fails', async () => {
    const config = new Config(params);
    (config as unknown as { initialized: boolean }).initialized = true;
    const arenaCleanup = vi.spyOn(config, 'cleanupArenaRuntime');
    const teamCleanup = vi.spyOn(config, 'cleanupTeamRuntime');
    config.registerExecutionEnvironment(
      Promise.resolve({
        dispose: vi
          .fn()
          .mockRejectedValue(
            new ExecutionCleanupError('Container still running'),
          ),
      } as unknown as ExecutionEnvironment),
    );
    await expect(config.shutdown(shutdownOptions)).rejects.toThrow(
      'Container execution cleanup failed',
    );
    expect(arenaCleanup).not.toHaveBeenCalled();
    expect(teamCleanup).not.toHaveBeenCalled();
  });

  it('preserves an earlier shutdown failure when container cleanup also fails', async () => {
    const config = new Config(params);
    const resourceError = new Error('Resource shutdown failed');
    const cleanupError = new ExecutionCleanupError('Container removal failed');
    vi.spyOn(
      config as unknown as { clearSessionRestoreProjection(): void },
      'clearSessionRestoreProjection',
    ).mockImplementation(() => {
      throw resourceError;
    });
    config.registerExecutionEnvironment(
      Promise.resolve({
        dispose: vi.fn().mockRejectedValue(cleanupError),
      } as unknown as ExecutionEnvironment),
    );
    await expect(config.shutdown(shutdownOptions)).rejects.toMatchObject({
      errors: [resourceError, cleanupError],
    });
  });
});
