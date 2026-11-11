/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { coreEvents, type Config } from '@qwen-code/core';
import { useMemoryStatus } from './useMemoryStatus.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal();
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    ...(actual as Record<string, unknown>),
    coreEvents: {
      ...((actual as Record<string, unknown>)['coreEvents'] as Record<
        string,
        unknown
      >),
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
      _trigger: (event: string, payload: unknown) => {
        handlers.get(event)?.(payload);
      },
    },
  };
});

function makeConfig(initialFileCount: number): Config {
  return {
    getMemoryMdFileCount: () => initialFileCount,
  } as unknown as Config;
}

describe('useMemoryStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes from config.getMemoryMdFileCount and starts with no warnings', async () => {
    const { result } = await renderHook(() => useMemoryStatus(makeConfig(3)));
    expect(result.current.memoryMdFileCount).toBe(3);
    expect(result.current.memoryWarnings).toEqual([]);
  });

  it('updates fileCount when MemoryChanged fires', async () => {
    const { result } = await renderHook(() => useMemoryStatus(makeConfig(0)));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('memory-changed', { fileCount: 7 });
    });

    expect(result.current.memoryMdFileCount).toBe(7);
  });

  it('emits a high-priority warning for each large file', async () => {
    const { result } = await renderHook(() => useMemoryStatus(makeConfig(1)));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('memory-changed', {
        fileCount: 1,
        largeFiles: [{ path: '/proj/AGENTS.md', characterCount: 999_999 }],
      });
    });

    expect(result.current.memoryWarnings).toHaveLength(1);
    expect(result.current.memoryWarnings[0].id).toBe(
      'large-memory-/proj/AGENTS.md',
    );
    expect(result.current.memoryWarnings[0].message).toContain('Large');
    expect(result.current.memoryWarnings[0].message).toContain('999,999');
  });

  it('emits a warning per failed file, with the load error', async () => {
    const { result } = await renderHook(() => useMemoryStatus(makeConfig(1)));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('memory-changed', {
        fileCount: 1,
        failedFiles: [{ path: '/proj/AGENTS.md', error: 'EACCES' }],
      });
    });

    expect(result.current.memoryWarnings).toHaveLength(1);
    expect(result.current.memoryWarnings[0].id).toBe(
      'failed-memory-/proj/AGENTS.md',
    );
    expect(result.current.memoryWarnings[0].message).toContain('EACCES');
  });

  it('replaces (not appends) warnings on each MemoryChanged', async () => {
    const { result } = await renderHook(() => useMemoryStatus(makeConfig(1)));

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('memory-changed', {
        fileCount: 1,
        largeFiles: [{ path: '/proj/A.md', characterCount: 1 }],
      });
    });
    expect(result.current.memoryWarnings).toHaveLength(1);

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('memory-changed', { fileCount: 1 });
    });
    expect(result.current.memoryWarnings).toEqual([]);
  });
});
