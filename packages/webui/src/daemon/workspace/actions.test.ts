/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions.js';

describe('workspace actions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards workspace updates to the daemon client', async () => {
    const workspace = {
      id: 'secondary',
      cwd: '/ws/secondary',
      displayName: 'Payments',
      primary: false,
      trusted: true,
    };
    const updateWorkspace = vi.fn().mockResolvedValue(workspace);
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ updateWorkspace }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(
      actions.updateWorkspace('secondary', { displayName: 'Payments' }),
    ).resolves.toEqual(workspace);
    expect(updateWorkspace).toHaveBeenCalledWith('secondary', {
      displayName: 'Payments',
    });
  });

  it('applies the action timeout to workspace removal', async () => {
    vi.useFakeTimers();
    const remove = vi.fn(() => new Promise<never>(() => {}));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById: () => ({ remove }) }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    const result = actions
      .removeWorkspace('secondary', { force: true, timeoutMs: 10 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(10);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Remove workspace timed out after 10ms',
    });
    expect(remove).toHaveBeenCalledWith({ force: true, timeoutMs: 10 });
  });

  it('forwards successful workspace removal results', async () => {
    const removal = {
      removed: true as const,
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      forced: false,
      persistedRegistrationRemoved: true,
      activity: {
        sessions: 0,
        activePrompts: 0,
        pendingSessionStarts: 0,
        acpConnections: 0,
        memoryTasks: 0,
        channelWorkers: 0,
      },
    };
    const remove = vi.fn().mockResolvedValue(removal);
    const workspaceById = vi.fn(() => ({ remove }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(
      actions.removeWorkspace('secondary', { force: false }),
    ).resolves.toEqual(removal);
    expect(workspaceById).toHaveBeenCalledWith('secondary');
    expect(remove).toHaveBeenCalledWith({ force: false });
  });

  it('rejects workspace removal without a connected client', async () => {
    const actions = createDaemonWorkspaceActions({
      getClient: () => undefined,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(actions.removeWorkspace('secondary')).rejects.toThrow(
      'Remove workspace failed: DaemonClient is not connected',
    );
  });

  it('preserves zero as the disabled timeout sentinel', async () => {
    vi.useFakeTimers();
    const removal = {
      removed: true as const,
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      forced: false,
      persistedRegistrationRemoved: false,
      activity: {
        sessions: 0,
        activePrompts: 0,
        pendingSessionStarts: 0,
        acpConnections: 0,
        memoryTasks: 0,
        channelWorkers: 0,
      },
    };
    const remove = vi.fn().mockResolvedValue(removal);
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById: () => ({ remove }) }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(
      actions.removeWorkspace('secondary', { timeoutMs: 0 }),
    ).resolves.toEqual(removal);
    expect(remove).toHaveBeenCalledWith({ timeoutMs: 0 });
  });

  it('loads active extension operations from the daemon client', async () => {
    const activeExtensionOperations = vi
      .fn()
      .mockResolvedValue({ v: 1, operations: [] });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ activeExtensionOperations }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.activeExtensionOperations()).resolves.toEqual({
      v: 1,
      operations: [],
    });
    expect(activeExtensionOperations).toHaveBeenCalledOnce();
  });

  it('reloads MCP settings through the daemon client', async () => {
    const reloadWorkspaceMcp = vi.fn().mockResolvedValue({ accepted: true });
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ reloadWorkspaceMcp }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.reloadMcp()).resolves.toEqual({ accepted: true });
    expect(reloadWorkspaceMcp).toHaveBeenCalledOnce();
  });

  it('forwards an extension interaction response to the daemon client', async () => {
    const respondToExtensionInteraction = vi
      .fn()
      .mockResolvedValue({ accepted: true });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ respondToExtensionInteraction }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.respondToExtensionInteraction(
        'op-1',
        'interaction-1',
        { value: 'answer' },
        'client-1',
      ),
    ).resolves.toEqual({ accepted: true });
    expect(respondToExtensionInteraction).toHaveBeenCalledWith(
      'op-1',
      'interaction-1',
      { value: 'answer' },
      'client-1',
    );
  });

  it('rejects when no daemon client is connected', async () => {
    const actions = createDaemonWorkspaceActions({
      getClient: () => undefined,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.respondToExtensionInteraction('op-1', 'interaction-1', {
        cancelled: true,
      }),
    ).rejects.toThrow('Respond to extension interaction failed');
  });

  it('routes channel management and auth actions through the current workspace', async () => {
    let cwd = '/workspace-a';
    const catalog = [{ type: 'qq', displayName: 'QQ', manageable: true }];
    const snapshot = { revision: '1', instances: {} };
    const qr = new Blob(['qr'], { type: 'image/png' });
    const workspace = {
      workspaceChannelTypes: vi.fn().mockResolvedValue(catalog),
      workspaceChannels: vi.fn().mockResolvedValue(snapshot),
      upsertWorkspaceChannel: vi.fn().mockResolvedValue({ snapshot }),
      deleteWorkspaceChannel: vi.fn().mockResolvedValue({ snapshot }),
      setWorkspaceChannelStartup: vi.fn().mockResolvedValue({ snapshot }),
      startWorkspaceChannel: vi.fn().mockResolvedValue({ snapshot }),
      stopWorkspaceChannel: vi.fn().mockResolvedValue({ snapshot }),
      restartWorkspaceChannel: vi.fn().mockResolvedValue({ snapshot }),
      beginWorkspaceChannelAuth: vi.fn().mockResolvedValue({ id: 'auth-1' }),
      workspaceChannelAuth: vi.fn().mockResolvedValue({ id: 'auth-1' }),
      workspaceChannelAuthQr: vi.fn().mockResolvedValue(qr),
      cancelWorkspaceChannelAuth: vi.fn().mockResolvedValue({
        cancelled: true,
      }),
      commitWorkspaceChannelAuth: vi.fn().mockResolvedValue({ snapshot }),
    };
    const workspaceByCwd = vi.fn(() => workspace);
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => cwd,
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadChannels()).resolves.toEqual({
      catalog,
      snapshot,
    });
    cwd = '/workspace-b';
    await actions.upsertChannel('bot', {
      expectedRevision: '1',
      config: { type: 'qq' },
    });
    await actions.removeChannel('bot', { expectedRevision: '1' });
    await actions.setChannelStartup('bot', {
      expectedRevision: '1',
      enabled: true,
    });
    await actions.startChannel('bot');
    await actions.stopChannel('bot');
    await actions.restartChannel('bot');
    await actions.channelAuth.begin('bot', { channelType: 'qq' });
    await actions.channelAuth.status('bot', 'auth-1');
    await expect(actions.channelAuth.qr('bot', 'auth-1')).resolves.toBe(qr);
    await actions.channelAuth.cancel('bot', 'auth-1');
    await actions.channelAuth.commit('bot', 'auth-1', {
      channelType: 'qq',
    });

    expect(workspaceByCwd).toHaveBeenNthCalledWith(1, '/workspace-a');
    expect(workspaceByCwd).toHaveBeenLastCalledWith('/workspace-b');
    expect(workspace.upsertWorkspaceChannel).toHaveBeenCalledWith('bot', {
      expectedRevision: '1',
      config: { type: 'qq' },
    });
    expect(workspace.workspaceChannelAuthQr).toHaveBeenCalledWith(
      'bot',
      'auth-1',
    );
  });
});
