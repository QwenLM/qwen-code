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

  it('preheats ACP with the requested timeout', async () => {
    const workspaceAcpPreheat = vi.fn().mockResolvedValue({
      ready: true,
      channelLive: true,
      durationMs: 2,
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceAcpPreheat }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(actions.preheatAcp(5_000)).resolves.toMatchObject({
      ready: true,
      channelLive: true,
    });
    expect(workspaceAcpPreheat).toHaveBeenCalledWith(5_000);
  });

  it('allows the SDK archive timeout to run before the wrapper timeout', async () => {
    vi.useFakeTimers();
    const installExtensionArchive = vi.fn(() => new Promise<never>(() => {}));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ installExtensionArchive }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });
    const result = actions
      .installExtensionArchive({
        archive: new Blob(['archive']),
        filename: 'demo.zip',
        consent: true,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await vi.advanceTimersByTimeAsync(130_000);

    await expect(result).resolves.toMatchObject({
      message: 'Install extension timed out after 130000ms',
    });
  });

  it('leaves model-provider mutation timeouts to the SDK client', async () => {
    vi.useFakeTimers();
    let resolveInstall!: (value: {
      v: 1;
      providerId: string;
      providerLabel: string;
      authType: string;
      message: string;
    }) => void;
    let resolveDelete!: (value: {
      removed: true;
      clearedActiveModel: false;
      requiresRestart: false;
    }) => void;
    const installAuthProvider = vi.fn(
      () =>
        new Promise<{
          v: 1;
          providerId: string;
          providerLabel: string;
          authType: string;
          message: string;
        }>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const deleteModel = vi.fn(
      () =>
        new Promise<{
          removed: true;
          clearedActiveModel: false;
          requiresRestart: false;
        }>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ installAuthProvider, deleteModel }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });
    let installSettled = false;
    let deleteSettled = false;
    const install = actions
      .installAuthProvider({ providerId: 'openai', apiKey: 'key' })
      .finally(() => {
        installSettled = true;
      });
    const deletion = actions
      .deleteModel({ authType: 'openai', modelId: 'gpt-4o' })
      .finally(() => {
        deleteSettled = true;
      });

    await vi.advanceTimersByTimeAsync(50_000);
    expect(installSettled).toBe(false);
    expect(deleteSettled).toBe(false);

    resolveInstall({
      v: 1,
      providerId: 'openai',
      providerLabel: 'OpenAI',
      authType: 'openai',
      message: 'saved',
    });
    resolveDelete({
      removed: true,
      clearedActiveModel: false,
      requiresRestart: false,
    });
    await Promise.all([install, deletion]);
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

  it('does not preempt SDK timeouts for channel mutations', async () => {
    vi.useFakeTimers();
    let resolveUpsert!: () => void;
    let resolveApproval!: () => void;
    const upsertWorkspaceChannel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const approveWorkspaceChannelPairing = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: () => ({
            upsertWorkspaceChannel,
            approveWorkspaceChannelPairing,
          }),
        }) as never,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });
    let upsertStatus = 'pending';
    let approvalStatus = 'pending';
    const upsert = actions
      .upsertChannel('bot', {
        expectedRevision: '1',
        config: { type: 'dingtalk' },
      })
      .then(
        () => {
          upsertStatus = 'resolved';
        },
        () => {
          upsertStatus = 'rejected';
        },
      );
    const approval = actions.channelPairing.approve('bot', 'ABCDEFGH').then(
      () => {
        approvalStatus = 'resolved';
      },
      () => {
        approvalStatus = 'rejected';
      },
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(upsertStatus).toBe('pending');
    expect(approvalStatus).toBe('pending');

    resolveUpsert();
    resolveApproval();
    await Promise.all([upsert, approval]);
    expect(upsertStatus).toBe('resolved');
    expect(approvalStatus).toBe('resolved');
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

  it('reloads MCP through the selected workspace runtime client', async () => {
    const reloadRuntimeMcp = vi.fn().mockResolvedValue({ accepted: true });
    const workspaceByCwd = vi.fn(() => ({ reloadRuntimeMcp }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.reloadMcp()).resolves.toEqual({ accepted: true });
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace');
    expect(reloadRuntimeMcp).toHaveBeenCalledOnce();
  });

  it('loads MCP status from the selected workspace runtime', async () => {
    const runtimeMcp = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/secondary',
      initialized: false,
      servers: [],
    });
    const workspaceByCwd = vi.fn(() => ({ runtimeMcp }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadMcpStatus()).resolves.toMatchObject({
      workspaceCwd: '/secondary',
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
  });

  it('persists MCP configuration in the requested scope', async () => {
    const setUserMcpServer = vi
      .fn()
      .mockResolvedValue({ activation: 'reconciling' });
    const setMcpServer = vi
      .fn()
      .mockResolvedValue({ activation: 'reconciling' });
    const workspaceByCwd = vi.fn(() => ({ setMcpServer }));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ setUserMcpServer, workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/secondary',
      baseUrl: 'http://daemon',
    });

    await actions.setMcpServer('user-docs', 'user', { command: 'user' });
    await actions.setMcpServer('workspace-docs', 'workspace', {
      command: 'workspace',
    });

    expect(setUserMcpServer).toHaveBeenCalledWith('user-docs', {
      command: 'user',
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(setMcpServer).toHaveBeenCalledWith('workspace-docs', {
      command: 'workspace',
    });
  });

  it('enables an MCP server in every disabled scope', async () => {
    const setUserMcpServerEnabled = vi
      .fn()
      .mockResolvedValue({ changed: true, activation: 'reconciling' });
    const setMcpServerEnabled = vi
      .fn()
      .mockResolvedValue({ changed: true, activation: 'reconciling' });
    const workspaceByCwd = vi.fn(() => ({
      mcpConfig: vi.fn().mockResolvedValue({
        user: {},
        workspace: {},
      }),
      setMcpServerEnabled,
    }));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          setUserMcpServerEnabled,
          workspaceByCwd,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.manageMcpServer('docs', 'enable')).resolves.toEqual({
      serverName: 'docs',
      action: 'enable',
      ok: true,
      changed: true,
    });
    expect(setUserMcpServerEnabled).toHaveBeenCalledWith('docs', true);
    expect(setMcpServerEnabled).toHaveBeenCalledWith('docs', true);
    expect(setUserMcpServerEnabled.mock.invocationCallOrder[0]!).toBeLessThan(
      setMcpServerEnabled.mock.invocationCallOrder[0]!,
    );
  });

  it('disables a user MCP server in user scope', async () => {
    const setUserMcpServerEnabled = vi
      .fn()
      .mockResolvedValue({ changed: true, activation: 'reconciling' });
    const setMcpServerEnabled = vi.fn();
    const workspaceByCwd = vi.fn(() => ({
      mcpConfig: vi.fn().mockResolvedValue({
        user: { docs: { command: 'docs' } },
        workspace: {},
      }),
      setMcpServerEnabled,
    }));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          setUserMcpServerEnabled,
          workspaceByCwd,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/secondary',
      baseUrl: 'http://daemon',
    });

    await actions.manageMcpServer('docs', 'disable');

    expect(setUserMcpServerEnabled).toHaveBeenCalledWith('docs', false);
    expect(setMcpServerEnabled).not.toHaveBeenCalled();
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

  it('routes Channel management and pairing through the current workspace', async () => {
    let cwd = '/workspace-a';
    const catalog = [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
      },
    ];
    const snapshot = { revision: '1', instances: {} };
    const mutation = {
      snapshot,
      instance: {
        name: 'bot',
        config: { type: 'dingtalk' },
        secrets: {},
        startsWithServe: false,
        runtime: { state: 'stopped' as const },
      },
    };
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
    const pairingApprovals = { senderIds: ['sender-1', 'sender-2'] };
    const pairingRevocation = {
      revoked: 'sender-1',
      senderIds: ['sender-2'],
    };
    const workspace = {
      workspaceChannelTypes: vi.fn().mockResolvedValue(catalog),
      workspaceChannels: vi.fn().mockResolvedValue(snapshot),
      upsertWorkspaceChannel: vi.fn().mockResolvedValue(mutation),
      deleteWorkspaceChannel: vi.fn().mockResolvedValue(mutation),
      setWorkspaceChannelStartup: vi.fn().mockResolvedValue(mutation),
      startWorkspaceChannel: vi.fn().mockResolvedValue(mutation),
      stopWorkspaceChannel: vi.fn().mockResolvedValue(mutation),
      restartWorkspaceChannel: vi.fn().mockResolvedValue(mutation),
      workspaceChannelPairingRequests: vi.fn().mockResolvedValue(pairing),
      approveWorkspaceChannelPairing: vi.fn().mockResolvedValue(approval),
      workspaceChannelPairingApprovals: vi
        .fn()
        .mockResolvedValue(pairingApprovals),
      revokeWorkspaceChannelPairingApproval: vi
        .fn()
        .mockResolvedValue(pairingRevocation),
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
      config: { type: 'dingtalk' },
    });
    await actions.removeChannel('bot', { expectedRevision: '1' });
    await actions.setChannelStartup('bot', {
      expectedRevision: '1',
      enabled: true,
    });
    await actions.startChannel('bot');
    await actions.stopChannel('bot');
    await actions.restartChannel('bot');
    await expect(actions.channelPairing.list('bot')).resolves.toBe(pairing);
    await expect(
      actions.channelPairing.approve('bot', 'abcdefgh'),
    ).resolves.toBe(approval);
    await expect(actions.channelPairing.approvals('bot')).resolves.toBe(
      pairingApprovals,
    );
    await expect(
      actions.channelPairing.revoke('bot', { senderId: 'sender-1' }),
    ).resolves.toBe(pairingRevocation);
    await expect(
      actions.channelPairing.revoke('bot', { groupId: 'group-1' }),
    ).resolves.toBe(pairingRevocation);

    expect(workspaceByCwd).toHaveBeenNthCalledWith(1, '/workspace-a');
    expect(workspaceByCwd).toHaveBeenLastCalledWith('/workspace-b');
    expect(workspace.upsertWorkspaceChannel).toHaveBeenCalledWith('bot', {
      expectedRevision: '1',
      config: { type: 'dingtalk' },
    });
    expect(workspace.deleteWorkspaceChannel).toHaveBeenCalledWith('bot', {
      expectedRevision: '1',
    });
    expect(workspace.setWorkspaceChannelStartup).toHaveBeenCalledWith('bot', {
      expectedRevision: '1',
      enabled: true,
    });
    expect(workspace.startWorkspaceChannel).toHaveBeenCalledWith('bot');
    expect(workspace.stopWorkspaceChannel).toHaveBeenCalledWith('bot');
    expect(workspace.restartWorkspaceChannel).toHaveBeenCalledWith('bot');
    expect(workspace.approveWorkspaceChannelPairing).toHaveBeenCalledWith(
      'bot',
      { code: 'abcdefgh' },
    );
    expect(workspace.workspaceChannelPairingApprovals).toHaveBeenCalledWith(
      'bot',
    );
    expect(
      workspace.revokeWorkspaceChannelPairingApproval,
    ).toHaveBeenCalledWith('bot', { senderId: 'sender-1' });
    expect(
      workspace.revokeWorkspaceChannelPairingApproval,
    ).toHaveBeenCalledWith('bot', { groupId: 'group-1' });
  });

  it('rejects Channel management without a selected workspace', async () => {
    const workspaceByCwd = vi.fn();
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => undefined,
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadChannels()).rejects.toThrow(
      'Daemon workspace is not connected',
    );
    expect(workspaceByCwd).not.toHaveBeenCalled();
  });

  it('forwards the directory picker to the daemon client', async () => {
    const pickerResult = {
      kind: 'workspace-directory-picker',
      selected: true,
      path: '/Users/me/code',
    };
    const workspaceDirectoryPicker = vi.fn().mockResolvedValue(pickerResult);
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ workspaceDirectoryPicker }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(actions.pickWorkspaceDirectory()).resolves.toEqual(
      pickerResult,
    );
    expect(workspaceDirectoryPicker).toHaveBeenCalledOnce();
  });

  it('applies the 320s timeout to the directory picker', async () => {
    vi.useFakeTimers();
    const workspaceDirectoryPicker = vi.fn(() => new Promise<never>(() => {}));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({ workspaceDirectoryPicker }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    const result = actions.pickWorkspaceDirectory().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(320_000);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Open directory picker timed out after 320000ms',
    });
  });

  it('rejects the directory picker without a connected client', async () => {
    const actions = createDaemonWorkspaceActions({
      getClient: () => undefined,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(actions.pickWorkspaceDirectory()).rejects.toThrow(
      'Open directory picker failed: DaemonClient is not connected',
    );
  });
});
