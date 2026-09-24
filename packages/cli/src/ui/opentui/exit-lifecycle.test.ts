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

  it('signals the client before the drain so no work spawns mid-exit', async () => {
    const order: string[] = [];
    requestShutdown.mockImplementation(() => {
      order.push('shutdown');
    });
    registerCleanup(() => {
      order.push('cleanup');
    });

    await expect(exitSession(config, 0)).rejects.toThrow(ExitCalled);
    expect(order).toEqual(['shutdown', 'cleanup']);
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
