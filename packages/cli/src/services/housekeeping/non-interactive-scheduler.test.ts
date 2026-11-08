/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionIdContext, type Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => ({
  cleanupOldOpenAILogs: vi.fn(),
  runThrottledOnce: vi.fn(),
}));

vi.mock('../../utils/housekeeping/cleanup.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../utils/housekeeping/cleanup.js')
    >();
  return {
    ...actual,
    cleanupOldOpenAILogs: mocks.cleanupOldOpenAILogs,
  };
});

vi.mock('../../utils/housekeeping/throttledOnce.js', () => ({
  runThrottledOnce: mocks.runThrottledOnce,
}));

import {
  _resetNonInteractiveForTesting,
  startNonInteractiveOpenAILogHousekeeping,
  stopNonInteractiveOpenAILogHousekeeping,
} from './scheduler.js';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function makeConfig(
  logDir: string,
  sessionId = 'housekeeping-session',
): Config {
  return {
    getContentGeneratorConfig: () => ({ openAILoggingDir: logDir }),
    getModelsConfig: () => ({ getGenerationConfig: () => ({}) }),
    getWorkingDir: () => process.cwd(),
    getSessionId: () => sessionId,
  } as unknown as Config;
}

function makeSettings(): LoadedSettings {
  return {
    merged: { model: { openAILogRetentionDays: 7 } },
    isTrusted: true,
    system: { settings: {} },
    systemDefaults: { settings: {} },
    user: { settings: { model: { openAILogRetentionDays: 7 } } },
    workspace: { settings: {} },
  } as unknown as LoadedSettings;
}

describe('non-interactive OpenAI log housekeeping', () => {
  let qwenHome: string;

  beforeEach(async () => {
    await _resetNonInteractiveForTesting();
    qwenHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-noninteractive-housekeeping-'),
    );
    vi.stubEnv('QWEN_HOME', qwenHome);
    mocks.cleanupOldOpenAILogs.mockReset();
    mocks.runThrottledOnce.mockReset();
    mocks.cleanupOldOpenAILogs.mockResolvedValue({
      removed: 0,
      errors: 0,
      completed: true,
    });
    mocks.runThrottledOnce.mockImplementation(
      async (_options, task: () => Promise<void | false>) =>
        (await task()) === false
          ? { status: 'incomplete' }
          : { status: 'completed' },
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await _resetNonInteractiveForTesting();
    vi.unstubAllEnvs();
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  it('deduplicates the same resolved log directory', async () => {
    const logDir = path.join(qwenHome, 'logs');

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(logDir),
      makeSettings(),
    );
    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(logDir),
      makeSettings(),
    );

    await vi.waitFor(() =>
      expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledOnce(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledOnce();
  });

  it('serializes different directories in FIFO order', async () => {
    const firstDir = path.join(qwenHome, 'first');
    const secondDir = path.join(qwenHome, 'second');
    let releaseFirst: ((value: unknown) => void) | undefined;
    mocks.cleanupOldOpenAILogs.mockImplementation(({ logDir, signal }) => {
      if (logDir === firstDir) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
          signal?.addEventListener('abort', () => {
            resolve({ removed: 0, errors: 0, completed: false });
          });
        });
      }
      return Promise.resolve({ removed: 0, errors: 0, completed: true });
    });

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(firstDir),
      makeSettings(),
    );
    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(secondDir),
      makeSettings(),
    );

    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledTimes(1);

    releaseFirst?.({ removed: 0, errors: 0, completed: true });
    await vi.waitFor(() =>
      expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledTimes(2),
    );
    expect(mocks.cleanupOldOpenAILogs.mock.calls[1]?.[0].logDir).toBe(
      secondDir,
    );
  });

  it('keeps process-scoped cleanup outside session contexts', async () => {
    const firstDir = path.join(qwenHome, 'first');
    const secondDir = path.join(qwenHome, 'second');
    const observedContexts: Array<string | undefined> = [];
    mocks.cleanupOldOpenAILogs.mockImplementation(async () => {
      observedContexts.push(sessionIdContext.getStore());
      return { removed: 0, errors: 0, completed: true };
    });

    sessionIdContext.run('session-a', () => {
      startNonInteractiveOpenAILogHousekeeping(
        makeConfig(firstDir, 'session-a'),
        makeSettings(),
      );
    });
    sessionIdContext.run('session-b', () => {
      startNonInteractiveOpenAILogHousekeeping(
        makeConfig(secondDir, 'session-b'),
        makeSettings(),
      );
    });

    await vi.waitFor(() => expect(observedContexts).toHaveLength(2));
    expect(observedContexts).toEqual([undefined, undefined]);
  });

  it('keeps a failing start outside the spawning session context', async () => {
    // Pins the START-side sessionIdContext.exit: production starts
    // housekeeping from inside a session's context, and a target-resolution
    // failure there logs through the module debugLogger — that error line
    // must not route into the spawning session's debug file.
    const observed: Array<string | undefined> = [];
    const throwingConfig = {
      getContentGeneratorConfig: () => {
        observed.push(sessionIdContext.getStore());
        throw new Error('target resolution failed');
      },
      getModelsConfig: () => ({ getGenerationConfig: () => ({}) }),
      getWorkingDir: () => process.cwd(),
      getSessionId: () => 'session-a',
    } as unknown as Config;

    sessionIdContext.run('session-a', () => {
      startNonInteractiveOpenAILogHousekeeping(throwingConfig, makeSettings());
    });

    expect(observed).toEqual([undefined]);
    expect(mocks.cleanupOldOpenAILogs).not.toHaveBeenCalled();
  });

  it('uses ModelsConfig as the fallback for the CLI logging directory', async () => {
    const modelLogDir = path.join(qwenHome, 'from-models-config');
    const settingsLogDir = path.join(qwenHome, 'from-settings');
    const config = {
      getContentGeneratorConfig: () => undefined,
      getModelsConfig: () => ({
        getGenerationConfig: () => ({ openAILoggingDir: modelLogDir }),
      }),
      getWorkingDir: () => process.cwd(),
    } as unknown as Config;
    const settings = makeSettings();
    settings.merged.model = {
      ...settings.merged.model,
      openAILoggingDir: settingsLogDir,
    };

    startNonInteractiveOpenAILogHousekeeping(config, settings);

    await vi.waitFor(() =>
      expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledOnce(),
    );
    expect(mocks.cleanupOldOpenAILogs.mock.calls[0]?.[0].logDir).toBe(
      modelLogDir,
    );
  });

  it('prefers the initialized content-generator logging directory', async () => {
    const contentGeneratorLogDir = path.join(
      qwenHome,
      'from-content-generator-config',
    );
    const modelLogDir = path.join(qwenHome, 'from-models-config');
    const config = {
      getContentGeneratorConfig: () => ({
        openAILoggingDir: contentGeneratorLogDir,
      }),
      getModelsConfig: () => ({
        getGenerationConfig: () => ({ openAILoggingDir: modelLogDir }),
      }),
      getWorkingDir: () => process.cwd(),
    } as unknown as Config;

    startNonInteractiveOpenAILogHousekeeping(config, makeSettings());

    await vi.waitFor(() =>
      expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledOnce(),
    );
    expect(mocks.cleanupOldOpenAILogs.mock.calls[0]?.[0].logDir).toBe(
      contentGeneratorLogDir,
    );
  });

  it('retries a held lock after one minute', async () => {
    vi.useFakeTimers();
    mocks.runThrottledOnce.mockResolvedValue({ status: 'locked' });

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() =>
      expect(mocks.runThrottledOnce).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(MS_PER_MINUTE - 1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(2);
  });

  it('retries a fresh marker after its remaining interval', async () => {
    vi.useFakeTimers();
    mocks.runThrottledOnce
      .mockResolvedValueOnce({
        status: 'fresh',
        retryAfterMs: 30 * MS_PER_MINUTE,
      })
      .mockResolvedValue({ status: 'completed' });

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() =>
      expect(mocks.runThrottledOnce).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(30 * MS_PER_MINUTE - 1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['minimum', 5_000, MS_PER_MINUTE],
    ['maximum', 25 * MS_PER_HOUR, 24 * MS_PER_HOUR],
  ])(
    'clamps a fresh marker retry to the %s delay',
    async (_name, retryAfterMs, expectedDelayMs) => {
      vi.useFakeTimers();
      mocks.runThrottledOnce
        .mockResolvedValueOnce({ status: 'fresh', retryAfterMs })
        .mockResolvedValue({ status: 'completed' });

      startNonInteractiveOpenAILogHousekeeping(
        makeConfig(path.join(qwenHome, 'logs')),
        makeSettings(),
      );
      await vi.waitFor(() =>
        expect(mocks.runThrottledOnce).toHaveBeenCalledOnce(),
      );

      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(2);
    },
  );

  it('retries a failed cleanup after ten minutes', async () => {
    vi.useFakeTimers();
    mocks.runThrottledOnce
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue({ status: 'completed' });

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() =>
      expect(mocks.runThrottledOnce).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(10 * MS_PER_MINUTE - 1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(2);
  });

  it('runs a completed cleanup again after twenty-four hours', async () => {
    vi.useFakeTimers();
    mocks.runThrottledOnce.mockResolvedValue({ status: 'completed' });

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() =>
      expect(mocks.runThrottledOnce).toHaveBeenCalledOnce(),
    );

    await vi.advanceTimersByTimeAsync(24 * 60 * MS_PER_MINUTE - 1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.runThrottledOnce).toHaveBeenCalledTimes(2);
  });

  it('aborts the active scan during stop', async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.cleanupOldOpenAILogs.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = signal;
          signal?.addEventListener('abort', () => {
            resolve({ removed: 0, errors: 0, completed: false });
          });
        }),
    );

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'queued')),
      makeSettings(),
    );

    await stopNonInteractiveOpenAILogHousekeeping();

    expect(observedSignal?.aborted).toBe(true);
    expect(mocks.cleanupOldOpenAILogs).toHaveBeenCalledOnce();
    mocks.runThrottledOnce.mockClear();
    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'after-stop')),
      makeSettings(),
    );
    await Promise.resolve();
    expect(mocks.runThrottledOnce).not.toHaveBeenCalled();
  });

  it('caps stop waiting at 250ms when a filesystem task does not settle', async () => {
    vi.useFakeTimers();
    let releaseWorker: ((value: unknown) => void) | undefined;
    mocks.runThrottledOnce.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWorker = resolve;
        }),
    );

    startNonInteractiveOpenAILogHousekeeping(
      makeConfig(path.join(qwenHome, 'logs')),
      makeSettings(),
    );
    await vi.waitFor(() => expect(releaseWorker).toBeDefined());

    let stopped = false;
    const firstStop = stopNonInteractiveOpenAILogHousekeeping();
    expect(stopNonInteractiveOpenAILogHousekeeping()).toBe(firstStop);
    const stopPromise = firstStop.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;
    expect(stopped).toBe(true);

    releaseWorker?.({ status: 'incomplete' });
  });
});
