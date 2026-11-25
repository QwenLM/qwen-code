/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runLoggerMocks = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importActual) => {
  const actual =
    await importActual<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    runLogger: runLoggerMocks,
  };
});

import { runStartupPhase } from './startupPhase.js';

describe('runStartupPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the start before waiting and logs completion with duration', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(135);
    let resolvePhase!: (value: string) => void;
    const phasePromise = new Promise<string>((resolve) => {
      resolvePhase = resolve;
    });

    const resultPromise = runStartupPhase(
      'config.initialize',
      'session-1',
      () => phasePromise,
    );

    expect(runLoggerMocks.log).toHaveBeenCalledOnce();
    expect(runLoggerMocks.log).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '[startup.phase] started phase=config.initialize',
      ),
    );
    expect(runLoggerMocks.log).toHaveBeenLastCalledWith(
      expect.stringContaining('session_id=session-1'),
    );

    resolvePhase('done');

    await expect(resultPromise).resolves.toBe('done');
    expect(runLoggerMocks.log).toHaveBeenCalledTimes(2);
    expect(runLoggerMocks.log).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '[startup.phase] finished phase=config.initialize',
      ),
    );
    expect(runLoggerMocks.log).toHaveBeenLastCalledWith(
      expect.stringContaining('duration_ms=35 success=true'),
    );
  });

  it('logs failed completion and rethrows the original error', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(215);
    const error = new Error('startup failed');

    await expect(
      runStartupPhase('startHeadlessConfigService', 'session-2', async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(runLoggerMocks.warn).toHaveBeenCalledOnce();
    expect(runLoggerMocks.warn).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '[startup.phase] finished phase=startHeadlessConfigService',
      ),
    );
    expect(runLoggerMocks.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('duration_ms=15 success=false'),
    );
    expect(runLoggerMocks.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('error="startup failed"'),
    );
  });
});
