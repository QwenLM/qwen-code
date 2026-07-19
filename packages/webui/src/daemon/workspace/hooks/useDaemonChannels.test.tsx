/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { context, actions } = vi.hoisted(() => {
  const actions = {
    loadChannels: vi.fn(),
    upsertChannel: vi.fn(),
    removeChannel: vi.fn(),
    setChannelStartup: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    restartChannel: vi.fn(),
    channelAuth: {
      begin: vi.fn(),
      status: vi.fn(),
      qr: vi.fn(),
      cancel: vi.fn(),
      commit: vi.fn(),
    },
  };
  return {
    actions,
    context: {
      current: {
        client: {},
        workspaceCwd: '/workspace-a',
        actions,
      },
    },
  };
});

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => context.current,
  useDaemonWorkspaceActions: () => actions,
}));

const { useDaemonChannels } = await import('./useDaemonChannels.js');

const channelData = (cwd: string, revision = '1') => ({
  catalog: [
    {
      type: 'qq',
      displayName: 'QQ',
      manageable: true,
      fields: [],
      auth: ['qr'],
    },
  ],
  snapshot: {
    revision,
    instances: {
      bot: {
        name: 'bot',
        config: { type: 'qq', cwd },
        secrets: {},
        startsWithServe: false,
        runtime: { state: 'stopped' },
      },
    },
  },
});

describe('useDaemonChannels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    context.current = {
      client: {},
      workspaceCwd: '/workspace-a',
      actions,
    };
    for (const mock of [
      actions.loadChannels,
      actions.upsertChannel,
      actions.removeChannel,
      actions.setChannelStartup,
      actions.startChannel,
      actions.stopChannel,
      actions.restartChannel,
      actions.channelAuth.begin,
      actions.channelAuth.status,
      actions.channelAuth.qr,
      actions.channelAuth.cancel,
      actions.channelAuth.commit,
    ]) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads catalog and snapshot and reloads after successful mutations', async () => {
    actions.loadChannels.mockResolvedValue(channelData('/workspace-a'));
    actions.startChannel.mockResolvedValue({});
    actions.setChannelStartup.mockResolvedValue({});
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    expect(result?.catalog).toEqual(channelData('/workspace-a').catalog);
    expect(result?.snapshot).toEqual(channelData('/workspace-a').snapshot);
    expect(result?.channels.bot.name).toBe('bot');

    await act(async () => {
      await result?.start('bot');
      await result?.setStartup('bot', {
        expectedRevision: '1',
        enabled: true,
      });
    });

    expect(actions.loadChannels).toHaveBeenCalledTimes(3);
  });

  it('does not reload after a failed mutation', async () => {
    actions.loadChannels.mockResolvedValue(channelData('/workspace-a'));
    actions.removeChannel.mockRejectedValue(new Error('revision conflict'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    await expect(
      act(async () => result?.remove('bot', { expectedRevision: 'stale' })),
    ).rejects.toThrow('revision conflict');
    expect(actions.loadChannels).toHaveBeenCalledOnce();
  });

  it('resets, reloads, and ignores an in-flight response after a workspace switch', async () => {
    const workspaceA = deferred<ReturnType<typeof channelData>>();
    actions.loadChannels.mockImplementation(() => {
      const cwd = context.current.workspaceCwd;
      return cwd === '/workspace-a'
        ? workspaceA.promise
        : Promise.resolve(channelData('/workspace-b', '2'));
    });
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    context.current = {
      ...context.current,
      client: {},
      workspaceCwd: '/workspace-b',
    };
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(result?.snapshot?.revision).toBe('2');
    workspaceA.resolve(channelData('/workspace-a'));
    await act(async () => {
      await workspaceA.promise;
    });
    expect(result?.snapshot?.revision).toBe('2');
    expect(result?.channels.bot.config.cwd).toBe('/workspace-b');
  });

  it('reloads a manually loaded resource when the workspace changes', async () => {
    actions.loadChannels.mockImplementation(() =>
      Promise.resolve(channelData(context.current.workspaceCwd)),
    );
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    expect(actions.loadChannels).not.toHaveBeenCalled();
    await act(async () => {
      await result?.reload();
    });
    context.current = { ...context.current, workspaceCwd: '/workspace-b' };
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(actions.loadChannels).toHaveBeenCalledTimes(2);
    expect(result?.channels.bot.config.cwd).toBe('/workspace-b');
  });

  it('does not reload when autoLoad is disabled for the same workspace', async () => {
    actions.loadChannels.mockResolvedValue(channelData('/workspace-a'));

    function TestComponent({ autoLoad }: { autoLoad: boolean }) {
      useDaemonChannels({ autoLoad });
      return null;
    }

    await act(async () =>
      root.render((<TestComponent autoLoad={true} />) as ReactNode),
    );
    await act(async () =>
      root.render((<TestComponent autoLoad={false} />) as ReactNode),
    );

    expect(actions.loadChannels).toHaveBeenCalledOnce();
  });

  it('exposes stable auth actions and returns QR responses as Blob', async () => {
    const qr = new Blob(['png'], { type: 'image/png' });
    actions.channelAuth.qr.mockResolvedValue(qr);
    actions.channelAuth.commit.mockResolvedValue({});
    actions.loadChannels.mockResolvedValue(channelData('/workspace-a'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    const auth = result?.auth;
    await expect(result?.auth.qr('bot', 'auth-1')).resolves.toBe(qr);
    await act(async () => {
      await result?.auth.commit('bot', 'auth-1', { channelType: 'qq' });
    });
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(result?.auth).toBe(auth);
    expect(actions.loadChannels).toHaveBeenCalledOnce();
  });
});
