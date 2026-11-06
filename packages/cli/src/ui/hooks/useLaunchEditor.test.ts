/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSpawnSync, mockRelease, mockRestore } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockRelease: vi.fn(),
  mockRestore: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: { ...actual, spawnSync: mockSpawnSync },
    spawnSync: mockSpawnSync,
  };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdin: () => ({ stdin: { isRaw: true }, setRawMode: vi.fn() }),
  };
});

vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: () => ({ merged: { general: {} } }),
}));

vi.mock('../../utils/program-status.js', () => ({
  releaseProgramStatus: mockRelease,
  restoreProgramStatus: mockRestore,
}));

import { useLaunchEditor } from './useLaunchEditor.js';

describe('useLaunchEditor', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockRelease.mockClear();
    mockRestore.mockClear();
  });

  it('releases the program status while the editor owns the terminal', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: null });
    const { result } = renderHook(() => useLaunchEditor());

    await result.current('/tmp/file.txt');

    const [released] = mockRelease.mock.invocationCallOrder;
    const [spawned] = mockSpawnSync.mock.invocationCallOrder;
    const [restored] = mockRestore.mock.invocationCallOrder;
    expect(released).toBeLessThan(spawned);
    expect(restored).toBeGreaterThan(spawned);
  });

  it('restores the program status when the editor fails', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: null });
    const { result } = renderHook(() => useLaunchEditor());

    await expect(result.current('/tmp/file.txt')).rejects.toThrow(
      'Editor exited with status 1',
    );
    expect(mockRestore).toHaveBeenCalledTimes(1);
  });
});
