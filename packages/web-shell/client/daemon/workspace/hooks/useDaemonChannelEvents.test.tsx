/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelEventList } from '../types.js';

const { actions, client, context, qualifiedWorkspace } = vi.hoisted(() => {
  const qualifiedWorkspace = { workspaceChannelEvents: vi.fn() };
  const client = { workspaceByCwd: vi.fn(() => qualifiedWorkspace) };
  return {
    actions: { listChannelEvents: vi.fn() },
    client,
    context: {
      current: { workspaceCwd: '/workspace-a' as string | undefined },
    },
    qualifiedWorkspace,
  };
});

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => ({
    ...context.current,
    client,
    actions,
  }),
}));

const { useDaemonChannelEvents } = await import('./useDaemonChannelEvents.js');

function journal(channel: string): DaemonChannelEventList {
  return {
    events: [
      {
        at: '2026-11-02T00:00:00.000Z',
        channel,
        type: 'poll',
        outcome: 'ok',
      },
    ],
    truncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useDaemonChannelEvents', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    context.current = { workspaceCwd: '/workspace-a' };
    actions.listChannelEvents.mockReset();
    qualifiedWorkspace.workspaceChannelEvents.mockReset();
    client.workspaceByCwd.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hides the previous workspace events while the next request is pending', async () => {
    actions.listChannelEvents.mockResolvedValue(journal('alpha-bot'));
    const pending = deferred<DaemonChannelEventList>();
    qualifiedWorkspace.workspaceChannelEvents.mockReturnValue(pending.promise);
    let result: ReturnType<typeof useDaemonChannelEvents> | undefined;

    function TestComponent({ cwd }: { cwd: string }) {
      result = useDaemonChannelEvents({ workspaceCwd: cwd });
      return null;
    }

    await act(async () =>
      root.render((<TestComponent cwd="/workspace-a" />) as ReactNode),
    );
    expect(result?.data?.events.map((event) => event.channel)).toEqual([
      'alpha-bot',
    ]);

    await act(async () =>
      root.render((<TestComponent cwd="/workspace-b" />) as ReactNode),
    );
    expect(client.workspaceByCwd).toHaveBeenCalledWith('/workspace-b');
    expect(result?.data).toBeUndefined();
    expect(result?.loading).toBe(true);

    await act(async () => {
      pending.resolve(journal('beta-bot'));
    });
    expect(result?.data?.events.map((event) => event.channel)).toEqual([
      'beta-bot',
    ]);
  });

  it('hides the previous workspace events when the next request fails', async () => {
    actions.listChannelEvents.mockResolvedValue(journal('alpha-bot'));
    const failing = deferred<DaemonChannelEventList>();
    qualifiedWorkspace.workspaceChannelEvents.mockReturnValue(failing.promise);
    let result: ReturnType<typeof useDaemonChannelEvents> | undefined;

    function TestComponent({ cwd }: { cwd: string }) {
      result = useDaemonChannelEvents({ workspaceCwd: cwd });
      return null;
    }

    await act(async () =>
      root.render((<TestComponent cwd="/workspace-a" />) as ReactNode),
    );
    expect(result?.data?.events).toHaveLength(1);

    await act(async () =>
      root.render((<TestComponent cwd="/workspace-b" />) as ReactNode),
    );
    await act(async () => {
      failing.reject(new Error('workspace-b unavailable'));
    });

    expect(result?.data).toBeUndefined();
    expect(result?.error?.message).toBe('workspace-b unavailable');
  });

  it('does not poll while the tab is hidden and resumes when it is visible', async () => {
    const setVisibility = (value: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
    };
    actions.listChannelEvents.mockResolvedValue(journal('alpha-bot'));

    function TestComponent() {
      useDaemonChannelEvents({ workspaceCwd: '/workspace-a' });
      return null;
    }

    vi.useFakeTimers();
    setVisibility('hidden');
    try {
      await act(async () => root.render((<TestComponent />) as ReactNode));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(actions.listChannelEvents).not.toHaveBeenCalled();

      setVisibility('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions.listChannelEvents).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(actions.listChannelEvents).toHaveBeenCalledTimes(2);

      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(actions.listChannelEvents).toHaveBeenCalledTimes(2);
    } finally {
      setVisibility('visible');
      vi.useRealTimers();
    }
  });

  it('keeps one polling loop when visibility is restored mid-request', async () => {
    const setVisibility = (value: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
    };
    // Every request stays pending until the test releases it, so a visibility
    // restore lands in the middle of an in-flight cycle.
    const pending: Array<{ resolve: (value: DaemonChannelEventList) => void }> =
      [];
    actions.listChannelEvents.mockImplementation(() => {
      const d = deferred<DaemonChannelEventList>();
      pending.push(d);
      return d.promise;
    });

    function TestComponent() {
      useDaemonChannelEvents({ workspaceCwd: '/workspace-a' });
      return null;
    }
    const release = async () => {
      const d = pending.shift();
      expect(d).toBeDefined();
      await act(async () => {
        d!.resolve(journal('alpha-bot'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };

    vi.useFakeTimers();
    setVisibility('visible');
    try {
      await act(async () => root.render((<TestComponent />) as ReactNode));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(actions.listChannelEvents).toHaveBeenCalledTimes(1);

      // Three overlapping hide/show cycles while that request is pending. Each
      // one used to start another run, and every run schedules its own timer.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        setVisibility('hidden');
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        setVisibility('visible');
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(actions.listChannelEvents).toHaveBeenCalledTimes(1);

      await release();
      // One request per interval, not one per overlapping cycle.
      for (let interval = 0; interval < 3; interval += 1) {
        const before = actions.listChannelEvents.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(actions.listChannelEvents.mock.calls.length - before).toBe(1);
        await release();
      }
      expect(pending).toHaveLength(0);
    } finally {
      setVisibility('visible');
      vi.useRealTimers();
    }
  });
});
