/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFleetViewSessions } from './use-fleet-view-sessions.js';
import { useConfig } from '../contexts/ConfigContext.js';

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}));
const mockedUseConfig = vi.mocked(useConfig);

const mockListSessions = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  mockedUseConfig.mockReturnValue({
    getSessionService: () => ({
      listSessions: mockListSessions,
    }),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const makeSessionItem = (id: string) => ({
  sessionId: id,
  cwd: '/home/user/project',
  startTime: '2026-01-01T00:00:00Z',
  mtime: Date.now(),
  prompt: `Prompt for ${id}`,
  filePath: `/home/user/.qwen/sessions/${id}.jsonl`,
});

async function flushPromises() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useFleetViewSessions', () => {
  it('fetches sessions when opened', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].sessionId).toBe('sess-1');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not fetch when closed', () => {
    renderHook(() =>
      useFleetViewSessions({ isOpen: false, currentSessionId: null }),
    );

    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('polls at the configured interval', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });

  it('stops polling when closed', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    const { rerender } = renderHook(
      ({ isOpen }) => useFleetViewSessions({ isOpen, currentSessionId: null }),
      { initialProps: { isOpen: true } },
    );

    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    rerender({ isOpen: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('sets error on fetch failure', async () => {
    mockListSessions.mockRejectedValue(new Error('disk error'));

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();

    expect(result.current.error).toBe('disk error');
  });

  it('marks current session correctly', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1'), makeSessionItem('sess-2')],
    });

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: 'sess-1' }),
    );

    await flushPromises();

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].status).toBe('current');
    expect(result.current.sessions[1].status).toBe('idle');
  });

  it('only shows loading on initial fetch', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.loading).toBe(false);
  });

  it('does not flash loading on retry after initial failure', async () => {
    mockListSessions.mockRejectedValueOnce(new Error('disk error'));

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();
    expect(result.current.error).toBe('disk error');
    expect(result.current.loading).toBe(false);

    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('refresh triggers a new fetch', async () => {
    mockListSessions.mockResolvedValue({
      items: [makeSessionItem('sess-1')],
    });

    const { result } = renderHook(() =>
      useFleetViewSessions({ isOpen: true, currentSessionId: null }),
    );

    await flushPromises();
    expect(mockListSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });
});
