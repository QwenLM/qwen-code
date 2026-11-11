/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerExitCancellation } from './cleanup.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const threadHost = vi.hoisted(() => ({ isMainThread: true }));
vi.mock('node:worker_threads', () => threadHost);

vi.mock('@qwen-code/core', () => ({
  stopDetachedProcessGuard: vi.fn(),
  drainDetachedProcessGuard: vi.fn(),
  runLogger: { warn: vi.fn() },
  ExitCodes: { SUCCESS: 0, FATAL_CANCELLATION_ERROR: 130 },
  SessionEndReason: { Clear: 'clear', Other: 'other' },
  sessionLogger: { setExitContext: vi.fn(), event: vi.fn() },
  ExecutionLifecycleService: {
    terminateAll: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  registerApplicationLifecycle,
  registerCleanup,
  registerSessionEndCleanup,
  registerExitConfig,
  unregisterExitConfig,
  runExitCleanup,
  gracefulExit,
  runExitCleanupWithTimeout,
  registerSyncCleanup,
  runSyncCleanup,
  resetCleanupForTesting,
  setupSignalHandlers,
  setupTtyCheck,
  SESSION_DRAIN_TIMEOUT_MS,
  getExitCleanupTimeoutMs,
} from './cleanup.js';
import {
  ExecutionLifecycleService,
  SessionEndReason,
  sessionLogger,
  stopDetachedProcessGuard,
  drainDetachedProcessGuard,
  runLogger,
} from '@qwen-code/core';

describe('cleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    threadHost.isMainThread = true;
    vi.mocked(stopDetachedProcessGuard).mockReturnValue(undefined);
    vi.mocked(drainDetachedProcessGuard).mockResolvedValue(undefined);
    vi.mocked(ExecutionLifecycleService.terminateAll).mockResolvedValue(
      undefined,
    );
    resetCleanupForTesting();
  });

  // Any test below that arms fake timers must not leak them into the next
  // one: a failed assertion skips the test-local restore, which would turn a
  // single failure into a cascade of timeouts.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('awaits guard reaping only in a Worker', async () => {
    threadHost.isMainThread = false;
    let guardExited!: () => void;
    vi.mocked(drainDetachedProcessGuard).mockReturnValue(
      new Promise<void>((resolve) => {
        guardExited = resolve;
      }),
    );
    let finished = false;
    const closing = runExitCleanup().then(() => {
      finished = true;
    });
    await vi.waitFor(() =>
      expect(drainDetachedProcessGuard).toHaveBeenCalledOnce(),
    );
    expect(finished).toBe(false);
    guardExited();
    await closing;
    expect(finished).toBe(true);
  });

  it.each([0, 130])(
    'preserves exit code %i when Worker reaping fails',
    async (code) => {
      threadHost.isMainThread = false;
      const oldExitCode = process.exitCode;
      vi.mocked(drainDetachedProcessGuard).mockRejectedValue(
        new Error('guard did not exit'),
      );
      const stopped = new Error('process exited');
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw stopped;
      });
      try {
        const closing = gracefulExit(code).catch((error: unknown) => error);
        expect(await closing).toBe(stopped);
        // A Worker retries process.exit twice when a reaping failure leaves the
        // first attempt unmet, so the exit code is preserved across attempts.
        expect(exit).toHaveBeenCalledTimes(3);
        expect(exit).toHaveBeenCalledWith(code);
        expect(runLogger.warn).toHaveBeenCalledWith(
          '[cleanup] child reaping failed',
          expect.objectContaining({ child: 'guard' }),
        );
      } finally {
        exit.mockRestore();
        process.exitCode = oldExitCode;
      }
    },
  );

  it('does not start child draining in main-thread CLI, ACP or Daemon cleanup', async () => {
    vi.mocked(drainDetachedProcessGuard).mockReturnValue(Promise.resolve());
    await runExitCleanup();
    expect(stopDetachedProcessGuard).toHaveBeenCalledOnce();
    expect(drainDetachedProcessGuard).not.toHaveBeenCalled();
  });

  it('先取消初始化，保留共享服务供 SessionEnd 使用，最后只释放一次', async () => {
    const order: string[] = [];
    const abort = new AbortController();
    let sharedAlive = true;
    const dispose = vi.fn(async () => {
      order.push('framework');
      sharedAlive = false;
    });
    registerApplicationLifecycle({
      cancelInitialization: () => {
        order.push('cancel');
        abort.abort();
      },
      dispose,
    });
    registerSessionEndCleanup(async () => {
      expect(abort.signal.aborted).toBe(true);
      expect(sharedAlive).toBe(true);
      order.push('SessionEnd');
    });
    registerExitConfig({
      dispose: async () => {
        expect(sharedAlive).toBe(true);
        order.push('Config');
      },
    } as never);
    const closing = runExitCleanup();
    expect(runExitCleanup()).toBe(closing);
    await closing;
    expect(order).toEqual(['cancel', 'SessionEnd', 'Config', 'framework']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('should run a registered synchronous function', async () => {
    const cleanupFn = vi.fn();
    registerCleanup(cleanupFn);

    await runExitCleanup();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('does not retain cleanup for a project that has already been replaced', async () => {
    const previousProject = vi.fn();
    const currentProject = vi.fn();
    const unregister = registerCleanup(previousProject);
    unregister();
    registerCleanup(currentProject);
    await runExitCleanup();
    expect(previousProject).not.toHaveBeenCalled();
    expect(currentProject).toHaveBeenCalled();
  });

  it('should run a registered asynchronous function', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    registerCleanup(cleanupFn);

    await runExitCleanup();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('should run multiple registered functions', async () => {
    const syncFn = vi.fn();
    const asyncFn = vi.fn().mockResolvedValue(undefined);

    registerCleanup(syncFn);
    registerCleanup(asyncFn);

    await runExitCleanup();

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(asyncFn).toHaveBeenCalledTimes(1);
  });

  it('starts SessionEnd without waiting for a slow general cleanup', async () => {
    let finishGeneralCleanup!: () => void;
    const generalCleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishGeneralCleanup = resolve;
        }),
    );
    const sessionEndCleanup = vi.fn().mockResolvedValue(undefined);
    registerCleanup(generalCleanup);
    registerSessionEndCleanup(sessionEndCleanup);

    const cleanup = runExitCleanup();

    await vi.waitFor(() => {
      expect(generalCleanup).toHaveBeenCalledTimes(1);
      expect(sessionEndCleanup).toHaveBeenCalledTimes(1);
      expect(sessionEndCleanup).toHaveBeenCalledWith('other');
    });

    finishGeneralCleanup();
    await cleanup;
  });

  it('passes the requested reason to SessionEnd cleanup', async () => {
    const sessionEndCleanup = vi.fn().mockResolvedValue(undefined);
    registerSessionEndCleanup(sessionEndCleanup);

    await runExitCleanup({ sessionEndReason: SessionEndReason.Clear });

    expect(sessionEndCleanup).toHaveBeenCalledWith(SessionEndReason.Clear);
  });

  it('should share one in-flight cleanup across concurrent callers', async () => {
    let finishCleanup!: () => void;
    const cleanupFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    registerCleanup(cleanupFn);

    const firstCleanup = runExitCleanup({
      exitCode: 0,
      exitReason: 'natural_end',
    });
    await vi.waitFor(() => {
      expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    const secondCleanup = runExitCleanup({
      exitCode: 143,
      exitReason: 'signal_term',
    });

    expect(secondCleanup).toBe(firstCleanup);
    expect(cleanupFn).toHaveBeenCalledTimes(1);

    finishCleanup();
    await Promise.all([firstCleanup, secondCleanup]);
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('waits for active executions to terminate before registered cleanup', async () => {
    let finishTermination!: () => void;
    vi.mocked(ExecutionLifecycleService.terminateAll).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTermination = resolve;
        }),
    );
    const cleanupFn = vi.fn();
    registerCleanup(cleanupFn);

    const cleanupPromise = runExitCleanup();
    await vi.waitFor(() => {
      expect(ExecutionLifecycleService.terminateAll).toHaveBeenCalledTimes(1);
    });
    expect(cleanupFn).not.toHaveBeenCalled();

    finishTermination();
    await cleanupPromise;
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('starts SessionEnd after the execution termination grace period', async () => {
    vi.useFakeTimers();
    vi.mocked(ExecutionLifecycleService.terminateAll).mockImplementation(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    const sessionEndCleanup = vi.fn().mockResolvedValue(undefined);
    registerSessionEndCleanup(sessionEndCleanup);

    const cleanup = runExitCleanup();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sessionEndCleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(sessionEndCleanup).toHaveBeenCalledTimes(1);
  });

  it('should terminate executions after draining stdin and before other cleanup', async () => {
    const callOrder: string[] = [];

    // Cleanup function
    registerCleanup(() => {
      callOrder.push('cleanup');
    });

    // Sync cleanup function (e.g. setRawMode(false))
    registerSyncCleanup(() => {
      callOrder.push('sync');
    });
    vi.mocked(ExecutionLifecycleService.terminateAll).mockImplementation(
      async () => {
        callOrder.push('terminateAll');
      },
    );

    // Mock stdin.resume to track drainStdin
    const originalResume = process.stdin.resume;
    process.stdin.resume = vi.fn().mockImplementation(() => {
      callOrder.push('drain');
      return process.stdin;
    });

    // Mock stdin properties for drainStdin
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      await runExitCleanup();
    } finally {
      process.stdin.resume = originalResume;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    expect(callOrder).toEqual([
      'drain',
      'drain',
      'terminateAll',
      'sync',
      'cleanup',
    ]);
  });

  it('should continue running cleanup functions even if one throws an error', async () => {
    const errorFn = vi.fn().mockImplementation(() => {
      throw new Error('test error');
    });
    const successFn = vi.fn();
    registerCleanup(errorFn);
    registerCleanup(successFn);

    await expect(runExitCleanup()).resolves.not.toThrow();

    expect(errorFn).toHaveBeenCalledTimes(1);
    expect(successFn).toHaveBeenCalledTimes(1);
  });

  it('disposes borrowed resources before disposing the config', async () => {
    const callOrder: string[] = [];
    const config = {
      permission: {
        dispose: vi.fn(async () => {
          callOrder.push('drainShadow');
        }),
      },
      dispose: vi.fn(async () => {
        callOrder.push('dispose');
      }),
    };

    registerExitConfig(config as never);
    await runExitCleanup({ exitCode: 0, exitReason: 'natural_end' });

    expect(callOrder).toEqual(['drainShadow', 'dispose']);
  });

  it('disposes every registered session config on exit', async () => {
    const firstConfig = { dispose: vi.fn().mockResolvedValue(undefined) };
    const secondConfig = { dispose: vi.fn().mockResolvedValue(undefined) };
    registerExitConfig(firstConfig as never);
    registerExitConfig(secondConfig as never);

    await runExitCleanup({ exitCode: 0, exitReason: 'natural_end' });

    expect(firstConfig.dispose).toHaveBeenCalledTimes(1);
    expect(secondConfig.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a config unregistered before exit', async () => {
    const endedSession = { dispose: vi.fn().mockResolvedValue(undefined) };
    const liveSession = { dispose: vi.fn().mockResolvedValue(undefined) };
    registerExitConfig(endedSession as never);
    registerExitConfig(liveSession as never);
    unregisterExitConfig(endedSession as never);

    await runExitCleanup({ exitCode: 0, exitReason: 'natural_end' });

    expect(endedSession.dispose).not.toHaveBeenCalled();
    expect(liveSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('bounds a stuck finalizer, preserves notification budget and never disposes borrowed resources', async () => {
    vi.useFakeTimers();
    const hook = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); });
    const dispose = vi.fn();
    const general = vi.fn();
    registerExitCancellation(() => new Promise<void>(() => {}));
    registerSessionEndCleanup(hook);
    registerCleanup(general);
    registerApplicationLifecycle({ cancelInitialization: vi.fn(), dispose });
    const config = { dispose, getHookSystem: () => ({ getSessionEndTimeoutMs: () => 3_000 }) };
    registerExitConfig(config as never);
    expect(getExitCleanupTimeoutMs()).toBe(SESSION_DRAIN_TIMEOUT_MS + 2_000 + 5_000 + 3_000);
    const result = runExitCleanup().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SESSION_DRAIN_TIMEOUT_MS);
    expect(hook).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBeInstanceOf(Error);
    expect(general).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(stopDetachedProcessGuard).toHaveBeenCalledOnce();
    expect(sessionLogger.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'cli.exit.drain_timeout' }));
  });

  it('preserves a failure discovered during a successful host close', async () => {
    const oldExitCode = process.exitCode;
    const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
    registerExitCancellation(async () => { process.exitCode = 1; });
    try {
      await gracefulExit(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally { exit.mockRestore(); process.exitCode = oldExitCode; }
  });

  it('forcibly exits with failure after a stuck finalizer instead of reporting success', async () => {
    vi.useFakeTimers();
    const oldExitCode = process.exitCode;
    const stopped = new Error('process exited');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    registerExitCancellation(() => new Promise<void>(() => {}));
    try {
      const closing = gracefulExit(0).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(SESSION_DRAIN_TIMEOUT_MS);
      expect(await closing).toBe(stopped);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally { exit.mockRestore(); process.exitCode = oldExitCode; }
  });

  it('should report completed when bounded cleanup finishes before timeout', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    registerCleanup(cleanupFn);

    await expect(runExitCleanupWithTimeout({ timeoutMs: 1000 })).resolves.toBe(
      true,
    );

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('should report timeout when bounded cleanup does not finish', async () => {
    vi.useFakeTimers();
    const cleanupFn = vi.fn(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    registerCleanup(cleanupFn);

    const resultPromise = runExitCleanupWithTimeout({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toBe(false);
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('does not let a stuck config dispose block a bounded exit', async () => {
    vi.useFakeTimers();
    let finishDispose!: () => void;
    const config = {
      dispose: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDispose = resolve;
          }),
      ),
    };
    registerExitConfig(config as never);

    const boundedCleanup = runExitCleanupWithTimeout({ timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(boundedCleanup).resolves.toBe(false);
    expect(config.dispose).toHaveBeenCalledTimes(1);

    // Losing the race abandons the wait, not the pipeline. Rejoin the in-flight
    // promise and let the dispose settle so the pass cannot outlive this test.
    const inFlightCleanup = runExitCleanup();
    finishDispose();
    await inFlightCleanup;
  });

  describe.each(['bounded', 'graceful'] as const)(
    '%s drain budget',
    (entrypoint) => {
      let previousExitCode: typeof process.exitCode;
      let restoreExit: () => void;
      const exited = new Error('process exited');

      beforeEach(() => {
        vi.useFakeTimers();
        previousExitCode = process.exitCode;
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw exited;
        });
        restoreExit = () => exit.mockRestore();
      });

      afterEach(() => {
        restoreExit();
        process.exitCode = previousExitCode;
      });

      function start(timeoutMs?: number): Promise<unknown> {
        const options = timeoutMs === undefined ? {} : { timeoutMs };
        return entrypoint === 'bounded'
          ? runExitCleanupWithTimeout(options)
          : gracefulExit(0, options).catch((error: unknown) => {
              if (error !== exited) throw error;
            });
      }

      function holdConfigExit(hookBudget = 0) {
        let finish!: () => void;
        const permissionDispose = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
        const config = {
          permission: { dispose: permissionDispose },
          dispose: vi.fn().mockResolvedValue(undefined),
          getHookSystem: () => ({ getSessionEndTimeoutMs: () => hookBudget }),
        };
        registerExitConfig(config as never);
        return { config, finish: () => finish() };
      }

      it.each([0, 100, 9_900])(
        'discards unused drain time after a %ims finalizer',
        async (drainMs) => {
          const session = holdConfigExit(3_000);
          if (drainMs > 0) {
            registerExitCancellation(
              () =>
                new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
            );
          }
          let settled = false;
          const result = start().then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(drainMs);
          expect(session.config.permission.dispose).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(9_999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await result;
          expect(settled).toBe(true);
          expect(session.config.dispose).not.toHaveBeenCalled();
          if (entrypoint === 'graceful')
            expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
          session.finish();
          await runExitCleanup();
          expect(vi.getTimerCount()).toBe(0);
        },
      );

      it.each([false, true])(
        'preserves hook time after drain (stuck=%s)',
        async (stuck) => {
          registerExitCancellation(
            () =>
              new Promise<void>((resolve) => {
                if (!stuck) setTimeout(resolve, 9_900);
              }),
          );
          const hook = vi.fn(
            () => new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
          );
          registerSessionEndCleanup(hook);
          const dispose = vi.fn();
          registerExitConfig({
            dispose,
            getHookSystem: () => ({ getSessionEndTimeoutMs: () => 3_000 }),
          } as never);
          let settled = false;
          const result = start()
            .catch(() => undefined)
            .then(() => {
              settled = true;
            });
          const drainMs = stuck ? SESSION_DRAIN_TIMEOUT_MS : 9_900;
          await vi.advanceTimersByTimeAsync(drainMs - 1);
          expect(hook).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(hook).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(2_999);
          expect(settled).toBe(false);
          expect(process.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await result;
          if (stuck) {
            expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(dispose).not.toHaveBeenCalled();
            expect(sessionLogger.event).toHaveBeenCalledWith(
              expect.objectContaining({ type: 'cli.exit.drain_timeout' }),
            );
          } else {
            expect(dispose).toHaveBeenCalledOnce();
          }
          expect(vi.getTimerCount()).toBe(0);
        },
      );

      it('does not renew the cleanup budget when joining after drain has finished', async () => {
        const session = holdConfigExit();
        const inFlight = runExitCleanup();
        await vi.advanceTimersByTimeAsync(4_000);
        let settled = false;
        const result = start().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await result;
        expect(settled).toBe(true);
        session.finish();
        await inFlight;
        expect(vi.getTimerCount()).toBe(0);
      });

      it.each([500, 20_000])(
        'preserves an explicit %ims timeout across the drain boundary',
        async (timeoutMs) => {
          const session = holdConfigExit();
          registerExitCancellation(
            () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
          );
          let settled = false;
          const result = start(timeoutMs).then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(timeoutMs - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await result;
          expect(settled).toBe(true);
          session.finish();
          await runExitCleanup();
          expect(vi.getTimerCount()).toBe(0);
        },
      );
    },
  );

  it('preserves the execution and cleanup allowance when hook planning fails', async () => {
    vi.useFakeTimers();
    const config = {
      getHookSystem: () => ({
        getSessionEndTimeoutMs: () => {
          throw new Error('invalid hook plan');
        },
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    registerExitConfig(config as never);
    registerCleanup(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 6_000);
        }),
    );

    let result: boolean | undefined;
    const cleanup = runExitCleanupWithTimeout().then((value) => {
      result = value;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    await cleanup;
    expect(result).toBe(true);
  });

  it('extends the default timeout by the largest SessionEnd budget across sessions', async () => {
    vi.useFakeTimers();
    const shortBudgetConfig = {
      getHookSystem: () => ({
        getSessionEndTimeoutMs: () => 10_000,
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const longBudgetConfig = {
      getHookSystem: () => ({
        getSessionEndTimeoutMs: () => 60_000,
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    registerExitConfig(shortBudgetConfig as never);
    registerExitConfig(longBudgetConfig as never);
    registerCleanup(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 60_000);
        }),
    );

    let result: boolean | undefined;
    const cleanup = runExitCleanupWithTimeout().then((value) => {
      result = value;
    });

    // Past the short-budget default (2s + 5s + 10s) but within the largest.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(45_000);
    await cleanup;
    expect(result).toBe(true);
  });

  it('should keep running cleanup functions after the timeout fires', async () => {
    let resolveSlow!: () => void;
    const slowFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    const laterFn = vi.fn();
    registerCleanup(slowFn);
    registerCleanup(laterFn);

    const result = await runExitCleanupWithTimeout({ timeoutMs: 10 });
    expect(result).toBe(false);
    expect(slowFn).toHaveBeenCalledTimes(1);
    expect(laterFn).not.toHaveBeenCalled();

    resolveSlow();
    // Yield so the for-await loop in runExitCleanup can pick up laterFn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(laterFn).toHaveBeenCalledTimes(1);
  });

  describe('sync cleanup', () => {
    it('should run registered sync functions', async () => {
      const syncFn = vi.fn();
      registerSyncCleanup(syncFn);
      runSyncCleanup();
      expect(syncFn).toHaveBeenCalledTimes(1);
    });

    it('should continue running sync cleanup functions even if one throws', async () => {
      const errorFn = vi.fn().mockImplementation(() => {
        throw new Error('test error');
      });
      const successFn = vi.fn();
      registerSyncCleanup(errorFn);
      registerSyncCleanup(successFn);

      expect(() => runSyncCleanup()).not.toThrow();
      expect(errorFn).toHaveBeenCalledTimes(1);
      expect(successFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('signal and TTY handling', () => {
  let processOnHandlers: Map<
    string,
    Array<(...args: unknown[]) => void | Promise<void>>
  >;

  beforeEach(() => {
    process.exitCode = undefined;
    processOnHandlers = new Map();
    resetCleanupForTesting();
    vi.mocked(ExecutionLifecycleService.terminateAll).mockResolvedValue(
      undefined,
    );

    vi.spyOn(process, 'on').mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (typeof event === 'string') {
          const handlers = processOnHandlers.get(event) || [];
          handlers.push(handler);
          processOnHandlers.set(event, handlers);
        }
        return process;
      },
    );

    vi.spyOn(process, 'exit').mockImplementation((() => {
      // Don't actually exit
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    processOnHandlers.clear();
  });

  describe('setupSignalHandlers', () => {
    it('should register handlers for SIGHUP, SIGTERM, and SIGINT', () => {
      setupSignalHandlers();

      expect(processOnHandlers.has('SIGHUP')).toBe(true);
      expect(processOnHandlers.has('SIGTERM')).toBe(true);
      expect(processOnHandlers.has('SIGINT')).toBe(true);
    });

    it('should gracefully shutdown when SIGHUP is received', async () => {
      setupSignalHandlers();

      const sighupHandlers = processOnHandlers.get('SIGHUP') || [];
      expect(sighupHandlers.length).toBeGreaterThan(0);

      await sighupHandlers[0]?.();

      expect(process.exit).toHaveBeenCalledWith(129);
    });

    it('should register SIGTERM handler that can trigger shutdown', () => {
      setupSignalHandlers();

      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      expect(sigtermHandlers.length).toBeGreaterThan(0);
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      expect(typeof sigtermHandlers[0]).toBe('function');
    });

    it('lets a signal own final exit while non-terminal cleanup is running', async () => {
      let finishCleanup!: () => void;
      const cleanupFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      registerCleanup(cleanupFn);

      const naturalCleanup = runExitCleanup();
      await vi.waitFor(() => {
        expect(cleanupFn).toHaveBeenCalledTimes(1);
      });

      setupSignalHandlers();
      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      const signalShutdown = sigtermHandlers.at(-1)?.();

      expect(cleanupFn).toHaveBeenCalledTimes(1);
      expect(process.exit).not.toHaveBeenCalled();

      finishCleanup();
      await Promise.all([naturalCleanup, signalShutdown]);

      expect(process.exit).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(143);
    });

    it('keeps the signal exit code when signal shutdown starts first', async () => {
      let finishCleanup!: () => void;
      const cleanupFn = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      registerCleanup(cleanupFn);
      setupSignalHandlers();

      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      const signalShutdown = sigtermHandlers.at(-1)?.();
      await vi.waitFor(() => {
        expect(cleanupFn).toHaveBeenCalledTimes(1);
      });

      const naturalShutdown = gracefulExit(0, {
        exitReason: 'natural_end',
      });
      finishCleanup();
      await Promise.all([signalShutdown, naturalShutdown]);

      expect(process.exit).toHaveBeenCalledWith(143);
      expect(process.exit).not.toHaveBeenCalledWith(0);
    });

    it('pins the exit code and forces exit when cleanup has no active handles', async () => {
      vi.useFakeTimers();
      registerCleanup(
        () =>
          new Promise<void>(() => {
            // Deliberately unresolved and creates no event-loop handle.
          }),
      );

      const shutdown = gracefulExit(42, { timeoutMs: 1_000 });
      expect(process.exitCode).toBe(42);

      await vi.advanceTimersByTimeAsync(1_000);
      await shutdown;

      expect(process.exit).toHaveBeenCalledWith(42);
      vi.useRealTimers();
    });

    it('should allow a configured SessionEnd budget beyond five seconds', async () => {
      vi.useFakeTimers();
      const config = {
        getHookSystem: () => ({
          getSessionEndTimeoutMs: () => 60_000,
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      registerExitConfig(config as never);
      registerSessionEndCleanup(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 8_000);
          }),
      );
      setupSignalHandlers();

      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      const shutdown = sigtermHandlers.at(-1)?.();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(process.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      await shutdown;
      expect(process.exit).toHaveBeenCalledWith(143);
      vi.useRealTimers();
    });

    it('does not let a stuck general cleanup prevent SessionEnd from completing', async () => {
      vi.useFakeTimers();
      const config = {
        getHookSystem: () => ({
          getSessionEndTimeoutMs: () => 60_000,
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      let sessionEndCompleted = false;
      registerExitConfig(config as never);
      registerCleanup(
        () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
      );
      registerSessionEndCleanup(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              sessionEndCompleted = true;
              resolve();
            }, 8_000);
          }),
      );
      setupSignalHandlers();

      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      const shutdown = sigtermHandlers.at(-1)?.();

      await vi.advanceTimersByTimeAsync(8_000);
      expect(sessionEndCompleted).toBe(true);
      expect(process.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(57_000);
      expect(process.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SESSION_DRAIN_TIMEOUT_MS + 2_000);
      await shutdown;
      expect(process.exit).toHaveBeenCalledWith(143);
      vi.useRealTimers();
    });

    it('runs SessionEnd once when shutdown receives repeated signals', async () => {
      let finishSessionEnd!: () => void;
      const sessionEndCleanup = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSessionEnd = resolve;
          }),
      );
      registerSessionEndCleanup(sessionEndCleanup);
      setupSignalHandlers();

      const sigtermHandlers = processOnHandlers.get('SIGTERM') || [];
      const firstShutdown = sigtermHandlers.at(-1)?.();
      const secondShutdown = sigtermHandlers.at(-1)?.();

      await vi.waitFor(() => {
        expect(sessionEndCleanup).toHaveBeenCalledTimes(1);
      });
      finishSessionEnd();
      await Promise.all([firstShutdown, secondShutdown]);

      expect(sessionEndCleanup).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledTimes(1);
    });
  });

  describe('setupTtyCheck', () => {
    let originalStdinReadable: boolean | undefined;
    let originalStdoutWritable: boolean | undefined;

    beforeEach(() => {
      originalStdinReadable = process.stdin.readable;
      originalStdoutWritable = process.stdout.writable;
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(process.stdin, 'readable', {
        value: originalStdinReadable,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'writable', {
        value: originalStdoutWritable,
        writable: true,
        configurable: true,
      });
    });

    it('should return a cleanup function', () => {
      const cleanup = setupTtyCheck();
      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('should not exit when stdin and stdout streams are healthy', async () => {
      Object.defineProperty(process.stdin, 'readable', {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'writable', {
        value: true,
        writable: true,
        configurable: true,
      });

      const cleanup = setupTtyCheck();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(process.exit).not.toHaveBeenCalled();
      cleanup();
    });

    it('should exit with 129 when stdout becomes unwritable (orphan TTY)', async () => {
      Object.defineProperty(process.stdin, 'readable', {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'writable', {
        value: false,
        writable: true,
        configurable: true,
      });

      const cleanup = setupTtyCheck();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(process.exit).toHaveBeenCalledWith(129);
      cleanup();
    });

    it('should exit with 129 when stdin becomes unreadable', async () => {
      Object.defineProperty(process.stdin, 'readable', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'writable', {
        value: true,
        writable: true,
        configurable: true,
      });

      const cleanup = setupTtyCheck();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(process.exit).toHaveBeenCalledWith(129);
      cleanup();
    });

    it('should not fire before the 30s interval elapses', async () => {
      Object.defineProperty(process.stdin, 'readable', {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'writable', {
        value: false,
        writable: true,
        configurable: true,
      });

      const cleanup = setupTtyCheck();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(process.exit).not.toHaveBeenCalled();
      cleanup();
    });

    it('cleanup function should stop the interval', () => {
      const cleanup = setupTtyCheck();
      cleanup();
      vi.advanceTimersByTime(60_000);
      expect(process.exit).not.toHaveBeenCalled();
    });
  });

  describe('signal exit codes', () => {
    it('should exit 130 (FATAL_CANCELLATION_ERROR) on SIGINT', async () => {
      setupSignalHandlers();
      const handlers = processOnHandlers.get('SIGINT') || [];
      void handlers.at(-1)?.();
      await vi.waitFor(() => {
        expect(process.exit).toHaveBeenCalledWith(130);
      });
    });

    it('should exit 143 on SIGTERM (POSIX 128+15)', async () => {
      setupSignalHandlers();
      const handlers = processOnHandlers.get('SIGTERM') || [];
      await handlers.at(-1)?.();
      expect(process.exit).toHaveBeenCalledWith(143);
    });

    it('should exit 129 on SIGHUP (POSIX 128+1)', async () => {
      setupSignalHandlers();
      const handlers = processOnHandlers.get('SIGHUP') || [];
      await handlers.at(-1)?.();
      expect(process.exit).toHaveBeenCalledWith(129);
    });
  });
});

describe('early exit cancellation', () => {
  it('cancels in-flight work before cleanup waits for it, and only once', async () => {
    const { resetCleanupForTesting, registerCleanup, runExitCleanup } = await import('./cleanup.js');
    resetCleanupForTesting();
    const { ExecutionLifecycleService } = await import('@qwen-code/core');
    vi.mocked(ExecutionLifecycleService.terminateAll).mockResolvedValue(undefined);
    const events: string[] = [];
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const removed = registerExitCancellation(() => { events.push('removed'); });
    removed();
    registerExitCancellation(() => { events.push('cancel'); resolve(); });
    registerCleanup(async () => { await pending; events.push('cleanup'); });
    await Promise.all([runExitCleanup(), runExitCleanup()]);
    expect(events).toEqual(['cancel', 'cleanup']);
    resetCleanupForTesting();
  });
});

it('waits for cancelled session finalizers before disposing shared resources', async () => {
  const { resetCleanupForTesting, registerCleanup, runExitCleanup } = await import('./cleanup.js');
  const { ExecutionLifecycleService } = await import('@qwen-code/core');
  resetCleanupForTesting();
  vi.mocked(ExecutionLifecycleService.terminateAll).mockResolvedValue(undefined);
  let finish!: () => void;
  const drained = new Promise<void>((resolve) => { finish = resolve; });
  const dispose = vi.fn();
  registerExitCancellation(() => drained);
  registerCleanup(dispose);
  const closing = runExitCleanup();
  await Promise.resolve();
  expect(dispose).not.toHaveBeenCalled();
  finish();
  await closing;
  expect(dispose).toHaveBeenCalledOnce();
  resetCleanupForTesting();
});
