// @vitest-environment jsdom

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLoopWakeups } from './useLoopWakeups';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdkMock = vi.hoisted(() => ({
  actions: {
    fetchScheduledTaskWakeups: vi.fn(),
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => sdkMock.actions,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let enabled = true;
let workspaceIds: Array<string | undefined> = [undefined];
let wakeups: Map<
  string,
  {
    sessionId: string;
    fireAtMs: number;
    createdAt: number;
    prompt: string;
    todoWorkChainId?: string;
  }
> = new Map();

function Harness() {
  wakeups = useLoopWakeups(enabled, workspaceIds);
  return null;
}

async function renderHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  enabled = true;
  workspaceIds = [undefined];
  wakeups = new Map();
  sdkMock.actions.fetchScheduledTaskWakeups.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('useLoopWakeups', () => {
  it('fetches immediately, then on the 30 s poll', async () => {
    sdkMock.actions.fetchScheduledTaskWakeups.mockResolvedValue([
      { sessionId: 'sess-1', fireAtMs: 2, createdAt: 1, prompt: 'p' },
    ]);
    await renderHarness();
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(1);
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledWith(
      undefined,
    );
    expect(wakeups.get('sess-1')?.prompt).toBe('p');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(2);
  });

  it('issues no requests while the gate is disabled', async () => {
    enabled = false;
    sdkMock.actions.fetchScheduledTaskWakeups.mockResolvedValue([]);
    await renderHarness();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(sdkMock.actions.fetchScheduledTaskWakeups).not.toHaveBeenCalled();
    expect(wakeups.size).toBe(0);
  });

  it('fans out over the registered workspaces and merges by session id', async () => {
    workspaceIds = [undefined, 'ws-b'];
    sdkMock.actions.fetchScheduledTaskWakeups.mockImplementation(async (id) =>
      id === undefined
        ? [{ sessionId: 'sess-1', fireAtMs: 2, createdAt: 1, prompt: 'p' }]
        : [
            {
              sessionId: 'sess-2',
              fireAtMs: 3,
              createdAt: 1,
              prompt: 'q',
            },
          ],
    );
    await renderHarness();
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(2);
    expect(
      sdkMock.actions.fetchScheduledTaskWakeups.mock.calls.map(
        ([id]) => id ?? '',
      ),
    ).toEqual(['', 'ws-b']);
    expect(wakeups.get('sess-1')?.prompt).toBe('p');
    expect(wakeups.get('sess-2')?.prompt).toBe('q');
  });

  it('keeps the other workspaces when one of them fails', async () => {
    workspaceIds = [undefined, 'ws-b'];
    sdkMock.actions.fetchScheduledTaskWakeups.mockImplementation(async (id) => {
      if (id === 'ws-b') throw new Error('workspace unavailable');
      return [{ sessionId: 'sess-1', fireAtMs: 2, createdAt: 1, prompt: 'p' }];
    });
    await renderHarness();
    expect(wakeups.get('sess-1')?.prompt).toBe('p');
    expect(wakeups.size).toBe(1);
  });

  it('debounces focus and visibility refreshes by 1 s', async () => {
    sdkMock.actions.fetchScheduledTaskWakeups.mockResolvedValue([]);
    await renderHarness();
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Still inside the 1 s debounce window.
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sdkMock.actions.fetchScheduledTaskWakeups).toHaveBeenCalledTimes(3);
  });

  it('reports an empty map when a poll fails and retries on the next tick', async () => {
    sdkMock.actions.fetchScheduledTaskWakeups
      .mockResolvedValueOnce([
        { sessionId: 'sess-1', fireAtMs: 2, createdAt: 1, prompt: 'p' },
      ])
      .mockRejectedValueOnce(new Error('daemon gone'))
      .mockResolvedValue([
        { sessionId: 'sess-2', fireAtMs: 3, createdAt: 1, prompt: 'q' },
      ]);
    await renderHarness();
    expect(wakeups.get('sess-1')?.prompt).toBe('p');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // The failed poll clears the map (a failed read contributes no wakeups),
    // and does not throw.
    expect(wakeups.size).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(wakeups.get('sess-2')?.prompt).toBe('q');
    expect(wakeups.has('sess-1')).toBe(false);
  });

  it('maps an empty (or field-less) response to an empty map', async () => {
    sdkMock.actions.fetchScheduledTaskWakeups.mockResolvedValue([]);
    await renderHarness();
    expect(wakeups.size).toBe(0);
    expect(wakeups instanceof Map).toBe(true);
  });
});
