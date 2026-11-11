/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lockState = vi.hoisted(() => ({
  onCompromised: undefined as ((error: Error) => void) | undefined,
  release: vi.fn(async () => {}),
  acquisitionError: undefined as Error | undefined,
}));

vi.mock('proper-lockfile', () => ({
  lock: async (
    _file: string,
    options: { onCompromised: (error: Error) => void },
  ) => {
    if (lockState.acquisitionError) throw lockState.acquisitionError;
    lockState.onCompromised = options.onCompromised;
    return lockState.release;
  },
}));

import { withFileLock } from './fileLock.js';
import { withMcpOAuthCredentialLock } from '../mcp/oauthFileLock.js';

const file = join(tmpdir(), 'file-lock-compromised', 'tokens.json');

beforeEach(() => {
  lockState.acquisitionError = undefined;
  lockState.onCompromised = undefined;
  lockState.release.mockClear();
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withFileLock when the lock is taken over', () => {
  it('does not let the operation commit what it read under the lost lock', async () => {
    const committed: string[] = [];

    await expect(
      withFileLock(file, async (assertHeld) => {
        committed.push('read');
        lockState.onCompromised?.(new Error('taken over'));
        assertHeld();
        committed.push('write');
      }),
    ).rejects.toThrow(/took it over/);

    expect(committed).toEqual(['read']);
  });

  it('commits while the lock is still held', async () => {
    await expect(
      withFileLock(file, async (assertHeld) => {
        assertHeld();
        return 'written';
      }),
    ).resolves.toBe('written');
  });
});

describe.each([
  ['physical file', (action: () => Promise<void>) => withFileLock(file, action)],
  ['OAuth credential', (action: () => Promise<void>) =>
    withMcpOAuthCredentialLock('write', 'server', action)],
] as const)('%s lock acquisition errors', (_name, withLock) => {
  it.each(['EACCES', 'ENOSPC'])('preserves directory creation error %s', async (code) => {
    const error = Object.assign(new Error('cannot create directory'), { code });
    vi.mocked(fs.mkdir).mockRejectedValueOnce(error);
    const action = vi.fn(async () => {});

    await expect(withLock(action)).rejects.toBe(error);

    expect(action).not.toHaveBeenCalled();
    expect(lockState.release).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ENOSPC'])('preserves lockfile error %s', async (code) => {
    const error = Object.assign(new Error('cannot create lockfile'), { code });
    lockState.acquisitionError = error;
    const action = vi.fn(async () => {});

    await expect(withLock(action)).rejects.toBe(error);

    expect(action).not.toHaveBeenCalled();
    expect(lockState.release).not.toHaveBeenCalled();
  });

  it('keeps the contention message for ELOCKED', async () => {
    const error = Object.assign(new Error('already locked'), { code: 'ELOCKED' });
    lockState.acquisitionError = error;
    const action = vi.fn(async () => {});

    await expect(withLock(action)).rejects.toMatchObject({
      message: expect.stringContaining('another process'),
      cause: error,
    });

    expect(action).not.toHaveBeenCalled();
    expect(lockState.release).not.toHaveBeenCalled();
  });
});
