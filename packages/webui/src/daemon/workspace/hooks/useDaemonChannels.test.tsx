/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { actions, context } = vi.hoisted(() => ({
  actions: {
    loadChannels: vi.fn(),
    upsertChannel: vi.fn(),
    removeChannel: vi.fn(),
    setChannelStartup: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    restartChannel: vi.fn(),
    channelPairing: {
      list: vi.fn(),
      approve: vi.fn(),
      approvals: vi.fn(),
      revoke: vi.fn(),
    },
  },
  context: {
    current: {
      workspaceCwd: '/workspace-a' as string | undefined,
    },
  },
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => ({
    ...context.current,
    actions,
  }),
}));

const { useDaemonChannels } = await import('./useDaemonChannels.js');

function channelData(name: string) {
  return {
    catalog: [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
    ],
    snapshot: {
      revision: '1',
      instances: {
        [name]: {
          name,
          config: { type: 'dingtalk' },
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'stopped' as const },
        },
      },
    },
  };
}

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
    context.current = { workspaceCwd: '/workspace-a' };
    for (const action of [
      actions.loadChannels,
      actions.upsertChannel,
      actions.removeChannel,
      actions.setChannelStartup,
      actions.startChannel,
      actions.stopChannel,
      actions.restartChannel,
      actions.channelPairing.list,
      actions.channelPairing.approve,
      actions.channelPairing.approvals,
      actions.channelPairing.revoke,
    ]) {
      action.mockReset();
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('auto-loads the selected workspace and exposes normalized data', async () => {
    actions.loadChannels.mockResolvedValue(channelData('bot-a'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(actions.loadChannels).toHaveBeenCalledOnce();
    expect(result?.catalog.map((item) => item.type)).toEqual(['dingtalk']);
    expect(Object.keys(result?.channels ?? {})).toEqual(['bot-a']);
    expect(result?.snapshot?.revision).toBe('1');
  });

  it('reports errors when loading Channel data fails', async () => {
    actions.loadChannels.mockRejectedValue(new Error('network down'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(result?.error?.message).toBe('network down');
    expect(result?.loading).toBe(false);
  });

  it('stays idle with safe defaults until explicitly loaded', async () => {
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(actions.loadChannels).not.toHaveBeenCalled();
    expect(result?.catalog).toEqual([]);
    expect(result?.channels).toEqual({});
    expect(result?.snapshot).toBeUndefined();
  });

  it('reloads after configuration and lifecycle mutations', async () => {
    const data = channelData('bot');
    actions.loadChannels.mockResolvedValue(data);
    actions.upsertChannel.mockResolvedValue({
      snapshot: data.snapshot,
      instance: data.snapshot.instances.bot,
    });
    actions.setChannelStartup.mockResolvedValue({
      snapshot: data.snapshot,
      instance: data.snapshot.instances.bot,
    });
    actions.restartChannel.mockResolvedValue({
      snapshot: data.snapshot,
      instance: data.snapshot.instances.bot,
    });
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    await act(async () => {
      await result?.createOrUpdate('bot', {
        expectedRevision: '1',
        config: { type: 'dingtalk' },
      });
      await result?.setStartup('bot', {
        expectedRevision: '1',
        enabled: true,
      });
      await result?.remove('bot', { expectedRevision: '1' });
      await result?.start('bot');
      await result?.stop('bot');
      await result?.restart('bot');
    });

    expect(actions.upsertChannel).toHaveBeenCalledOnce();
    expect(actions.setChannelStartup).toHaveBeenCalledOnce();
    expect(actions.removeChannel).toHaveBeenCalledOnce();
    expect(actions.startChannel).toHaveBeenCalledOnce();
    expect(actions.stopChannel).toHaveBeenCalledOnce();
    expect(actions.restartChannel).toHaveBeenCalledOnce();
    expect(actions.loadChannels).toHaveBeenCalledTimes(7);
  });

  it('propagates mutation errors without reloading', async () => {
    actions.loadChannels.mockResolvedValue(channelData('bot'));
    actions.upsertChannel.mockRejectedValue(new Error('conflict'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));

    await expect(
      result?.createOrUpdate('bot', {
        expectedRevision: '1',
        config: { type: 'dingtalk' },
      }),
    ).rejects.toThrow('conflict');
    expect(actions.loadChannels).toHaveBeenCalledOnce();
  });

  it('does not expose stale Channel data while the workspace changes', async () => {
    let resolveWorkspaceB!: (value: ReturnType<typeof channelData>) => void;
    actions.loadChannels
      .mockResolvedValueOnce(channelData('bot-a'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveWorkspaceB = resolve;
          }),
      );
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ autoLoad: true });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    expect(Object.keys(result?.channels ?? {})).toEqual(['bot-a']);

    context.current = { workspaceCwd: '/workspace-b' };
    await act(async () => root.render((<TestComponent />) as ReactNode));
    expect(result?.channels).toEqual({});

    await act(async () => {
      resolveWorkspaceB(channelData('bot-b'));
    });
    expect(Object.keys(result?.channels ?? {})).toEqual(['bot-b']);
  });

  it('reloads a new workspace after a manual load', async () => {
    actions.loadChannels
      .mockResolvedValueOnce(channelData('bot-a'))
      .mockResolvedValueOnce(channelData('bot-b'));
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    await act(async () => {
      await result?.reload();
    });

    context.current = { workspaceCwd: '/workspace-b' };
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(actions.loadChannels).toHaveBeenCalledTimes(2);
    expect(Object.keys(result?.channels ?? {})).toEqual(['bot-b']);
  });

  it('reloads a workspace changed while the hook was disabled', async () => {
    actions.loadChannels
      .mockResolvedValueOnce(channelData('bot-a'))
      .mockResolvedValueOnce(channelData('bot-b'));
    let enabled = true;
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels({ enabled });
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));
    await act(async () => {
      await result?.reload();
    });

    enabled = false;
    context.current = { workspaceCwd: '/workspace-b' };
    await act(async () => root.render((<TestComponent />) as ReactNode));
    enabled = true;
    await act(async () => root.render((<TestComponent />) as ReactNode));

    expect(actions.loadChannels).toHaveBeenCalledTimes(2);
    expect(Object.keys(result?.channels ?? {})).toEqual(['bot-b']);
  });

  it('exposes pairing operations without reloading Channel settings', async () => {
    const pairing = { requests: [] };
    const approval = {
      ...pairing,
      approved: {
        senderId: 'sender-1',
        senderName: 'Alice',
        code: 'ABCDEFGH',
        createdAt: 1,
      },
    };
    actions.channelPairing.list.mockResolvedValue(pairing);
    actions.channelPairing.approve.mockResolvedValue(approval);
    let result: ReturnType<typeof useDaemonChannels> | undefined;

    function TestComponent() {
      result = useDaemonChannels();
      return null;
    }

    await act(async () => root.render((<TestComponent />) as ReactNode));

    await expect(result?.pairing.list('bot')).resolves.toBe(pairing);
    await expect(result?.pairing.approve('bot', 'ABCDEFGH')).resolves.toBe(
      approval,
    );
    expect(actions.loadChannels).not.toHaveBeenCalled();
  });
});
