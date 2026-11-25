/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage, runLogger } from '@qwen-code/core';
import { lockSync } from 'proper-lockfile';
import { PersistentState } from './persistentState.js';

vi.mock('node:fs');
vi.mock('proper-lockfile', () => ({
  lockSync: vi.fn(),
}));
vi.mock('@qwen-code/core', () => ({
  Storage: {
    getGlobalConfigDir: vi.fn(),
  },
  runLogger: {
    warn: vi.fn(),
  },
}));

describe('PersistentState', () => {
  let persistentState: PersistentState;
  const mockDir = '/mock/dir';
  const mockFilePath = path.join(mockDir, 'state.json');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(Storage.getGlobalConfigDir).mockReturnValue(mockDir);
    vi.mocked(lockSync).mockReturnValue(vi.fn());
    persistentState = new PersistentState();
  });

  it('should load state from file if it exists', () => {
    const mockData = { startupWarningCounts: { banner1: 1 } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockData));

    const value = persistentState.get('startupWarningCounts');
    expect(value).toEqual(mockData.startupWarningCounts);
    expect(fs.readFileSync).toHaveBeenCalledWith(mockFilePath, 'utf-8');
  });

  it('should return undefined if key does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const value = persistentState.get('startupWarningCounts');
    expect(value).toBeUndefined();
  });

  it('should save state to file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    persistentState.set('startupWarningCounts', { banner1: 1 });

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.normalize(mockDir), {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      mockFilePath,
      JSON.stringify({ startupWarningCounts: { banner1: 1 } }, null, 2),
    );
  });

  it('should handle load errors and start fresh', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Read error');
    });

    const value = persistentState.get('startupWarningCounts');
    expect(value).toBeUndefined();
    expect(runLogger.warn).toHaveBeenCalled();
  });

  it('should handle save errors', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('Write error');
    });

    persistentState.set('startupWarningCounts', { banner1: 1 });
    expect(runLogger.warn).toHaveBeenCalled();
  });

  it('should update against the latest disk state instead of its cache', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(
        JSON.stringify({ startupWarningCounts: { alpha: 9 } }),
      )
      .mockReturnValueOnce(
        JSON.stringify({ startupWarningCounts: { alpha: 10 } }),
      );

    expect(persistentState.get('startupWarningCounts')).toEqual({ alpha: 9 });
    const reserved = persistentState.update(
      'startupWarningCounts',
      (counts) => {
        if ((counts?.['alpha'] ?? 0) >= 10) return undefined;
        return {
          value: { ...counts, alpha: (counts?.['alpha'] ?? 0) + 1 },
          result: true,
        };
      },
    );

    expect(reserved).toBeUndefined();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(persistentState.get('startupWarningCounts')).toEqual({ alpha: 10 });
  });

  it('should preserve other process state and retired keys during an atomic update', () => {
    const retiredState = { retiredStateKey: { legacy: 5 } };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        ...retiredState,
        tipsShown: 4,
        startupWarningCounts: { alpha: 9 },
      }),
    );

    const reserved = persistentState.update(
      'startupWarningCounts',
      (counts) => ({
        value: { ...counts, alpha: (counts?.['alpha'] ?? 0) + 1 },
        result: 'alpha',
      }),
    );

    expect(reserved).toBe('alpha');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      mockFilePath,
      JSON.stringify(
        {
          ...retiredState,
          tipsShown: 4,
          startupWarningCounts: { alpha: 10 },
        },
        null,
        2,
      ),
    );
  });

  it('should fail closed when another process holds the state lock', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(lockSync).mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'ELOCKED' });
    });

    const reserved = persistentState.update(
      'startupWarningCounts',
      () => ({ value: { alpha: 1 }, result: true }),
    );

    expect(reserved).toBeUndefined();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(runLogger.warn).toHaveBeenCalledWith(
      'Failed to lock persistent state:',
      expect.objectContaining({ code: 'ELOCKED' }),
    );
  });
});
