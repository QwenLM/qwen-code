/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dir } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDirHandleQuietly } from './dirHandle.js';
import { runLogger } from './runLogger.js';

vi.mock('./runLogger.js', () => ({
  runLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

function dirHandle(close: () => unknown): Dir {
  return { path: '/tmp/example', close } as unknown as Dir;
}

describe('closeDirHandleQuietly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits a promise-returning close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(closeDirHandleQuietly(dirHandle(close))).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(runLogger.debug).not.toHaveBeenCalled();
  });

  it('tolerates a non-thenable close return (bun runtime)', async () => {
    // Bun returns a non-thenable value when the handle is already closed by
    // async iteration, which is why callers must never chain `.catch()` on it.
    const close = vi.fn().mockReturnValue(undefined);

    await expect(closeDirHandleQuietly(dirHandle(close))).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(runLogger.debug).not.toHaveBeenCalled();
  });

  it('stays quiet when the handle is already closed', async () => {
    const alreadyClosed = Object.assign(new Error('Directory handle was closed'), {
      code: 'ERR_DIR_CLOSED',
    });

    await expect(
      closeDirHandleQuietly(dirHandle(() => Promise.reject(alreadyClosed))),
    ).resolves.toBeUndefined();

    expect(runLogger.debug).not.toHaveBeenCalled();
  });

  it('logs other close failures instead of throwing', async () => {
    const failure = Object.assign(new Error('disk on fire'), { code: 'EIO' });

    await expect(
      closeDirHandleQuietly(dirHandle(() => Promise.reject(failure))),
    ).resolves.toBeUndefined();

    expect(runLogger.debug).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runLogger.debug).mock.calls[0][0]).toContain('disk on fire');
  });

  it('does not rethrow a synchronous close failure', async () => {
    const close = vi.fn(() => {
      throw new Error('sync boom');
    });

    await expect(closeDirHandleQuietly(dirHandle(close))).resolves.toBeUndefined();

    expect(runLogger.debug).toHaveBeenCalledTimes(1);
  });
});
