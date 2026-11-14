/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { prepareFileWatchersForProcessExit } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import {
  registerCleanup,
  _resetCleanupFunctionsForTest,
} from '../../utils/cleanup.js';
import {
  exitSession,
  isExitInProgress,
  EXIT_CODE_INTERRUPT,
  EXIT_CODE_TERMINATED,
  _resetExitLifecycleForTest,
} from './exit-lifecycle.js';

vi.mock(
  '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js')
      >();
    return { ...actual, prepareFileWatchersForProcessExit: vi.fn() };
  },
);

class ExitCalled extends Error {
  readonly code: string | number | null | undefined;

  constructor(code: string | number | null | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

describe('exitSession', () => {
  let exitSpy: MockInstance<
    (code?: string | number | null | undefined) => never
  >;
  let requestShutdown: MockInstance<() => void>;
  let config: Config;

  beforeEach(() => {
    _resetExitLifecycleForTest();
    _resetCleanupFunctionsForTest();
    vi.mocked(prepareFileWatchersForProcessExit).mockReset();
    requestShutdown = vi.fn();
    config = {
      getLlmClient: () => ({ requestShutdown }),
    } as unknown as Config;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitCalled(code);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _resetCleanupFunctionsForTest();
    _resetExitLifecycleForTest();
  });

  it('drains registered cleanups before exiting with the given code', async () => {
    const order: string[] = [];
    registerCleanup(() => {
      order.push('first');
    });
    registerCleanup(async () => {
      order.push('second');
    });

    await expect(exitSession(config, EXIT_CODE_INTERRUPT)).rejects.toThrow(
      ExitCalled,
    );
    expect(order).toEqual(['first', 'second']);
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE_INTERRUPT);
  });

  it('prepares watchers before client shutdown, cleanup and exit', async () => {
    const order: string[] = [];
    vi.mocked(prepareFileWatchersForProcessExit).mockImplementation(() => {
      expect(isExitInProgress()).toBe(true);
      order.push('watchers');
    });
    requestShutdown.mockImplementation(() => {
      order.push('shutdown');
    });
    registerCleanup(() => {
      order.push('cleanup');
    });
    exitSpy.mockImplementation((code) => {
      order.push('exit');
      throw new ExitCalled(code);
    });

    await expect(exitSession(config, 0)).rejects.toThrow(ExitCalled);
    expect(order).toEqual(['watchers', 'shutdown', 'cleanup', 'exit']);
  });

  it('still exits when there is no client to signal', async () => {
    config = { getLlmClient: () => undefined } as unknown as Config;
    await expect(exitSession(config, 1)).rejects.toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('uses signal-style exit codes', () => {
    expect(EXIT_CODE_INTERRUPT).toBe(130);
    expect(EXIT_CODE_TERMINATED).toBe(143);
  });

  it('is idempotent: a second call never re-runs the drain', async () => {
    const cleanup = vi.fn();
    registerCleanup(cleanup);

    await expect(exitSession(config, 0)).rejects.toThrow(ExitCalled);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isExitInProgress()).toBe(true);

    // The second call returns a pending promise and must not re-run cleanup,
    // re-signal the client, or exit again.
    const second = exitSession(config, 0);
    await Promise.race([
      second,
      new Promise((resolve) => setTimeout(resolve, 20)),
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(prepareFileWatchersForProcessExit).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('still exits when a cleanup throws', async () => {
    registerCleanup(() => {
      throw new Error('boom');
    });
    await expect(exitSession(config, 1)).rejects.toThrow(ExitCalled);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
