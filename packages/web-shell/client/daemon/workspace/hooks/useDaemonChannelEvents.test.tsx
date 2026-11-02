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
});
