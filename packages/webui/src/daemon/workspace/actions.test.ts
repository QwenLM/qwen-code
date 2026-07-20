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
    const activePrimaryExtensionOperations = vi
      .fn()
      .mockResolvedValue({ v: 1, operations: [] });
    const activeWorkspaceExtensionOperations = vi
      .fn()
      .mockResolvedValue({ v: 1, operations: [] });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          activeWorkspaceConfigExtensionOperations:
            activePrimaryExtensionOperations,
          workspaceByCwd: vi.fn(() => ({
            activeWorkspaceConfigExtensionOperations:
              activeWorkspaceExtensionOperations,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.activeExtensionOperations()).resolves.toEqual({
      v: 1,
      operations: [],
    });
    expect(activePrimaryExtensionOperations).toHaveBeenCalledOnce();
    expect(activeWorkspaceExtensionOperations).toHaveBeenCalledOnce();
  });

  it('loads extension configuration without reading or starting the runtime', async () => {
    const ensureWorkspaceRuntime = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const workspaceConfigExtensions = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      extensions: [],
    });
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue({
      runtimeEpoch: 7,
      capabilities: {
        extensions: {
          state: 'starting',
          desiredGeneration: 4,
          appliedGeneration: 3,
          runtimeEpoch: 7,
          appliedEpoch: 7,
        },
      },
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            ensureWorkspaceRuntime,
            workspaceConfigExtensions,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadExtensionsStatus()).resolves.toMatchObject({
      extensions: [],
    });
    expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
    expect(workspaceRuntimeStatus).not.toHaveBeenCalled();
    expect(workspaceConfigExtensions).toHaveBeenCalledOnce();
  });

  it('ensures the selected workspace runtime without capability parameters', async () => {
    const ensured = {
      v: 1 as const,
      workspaceCwd: '/workspace/secondary',
      state: 'idle' as const,
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        extensions: { state: 'ready' },
        mcp: { state: 'ready' },
        skills: { state: 'ready' },
        tools: { state: 'ready' },
      },
    };
    const ensureWorkspaceRuntime = vi.fn().mockResolvedValue(ensured);
    const workspaceByCwd = vi.fn(() => ({ ensureWorkspaceRuntime }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.ensureRuntime()).resolves.toEqual(ensured);
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace/secondary');
    expect(ensureWorkspaceRuntime).toHaveBeenCalledWith();
  });

  it('polls the unified runtime status when ensure is still starting', async () => {
    vi.useFakeTimers();
    const starting = {
      v: 1 as const,
      workspaceCwd: '/workspace',
      state: 'starting' as const,
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        extensions: { state: 'ready' as const },
        mcp: { state: 'starting' as const },
        skills: { state: 'ready' as const },
        tools: { state: 'ready' as const },
      },
    };
    const ready = {
      ...starting,
      state: 'idle' as const,
      capabilities: {
        ...starting.capabilities,
        mcp: { state: 'ready' as const },
      },
    };
    const ensureWorkspaceRuntime = vi.fn().mockResolvedValue(starting);
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue(ready);
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: () => ({
            ensureWorkspaceRuntime,
            workspaceRuntimeStatus,
          }),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    const result = actions.ensureRuntime();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({
      state: 'idle',
    });
    expect(ensureWorkspaceRuntime).toHaveBeenCalledWith();
    expect(workspaceRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('loads extension activation from the original configuration inventory', async () => {
    const entry = {
      kind: 'extension' as const,
      id: 'extension-id',
      name: 'demo',
      version: '1.0.0',
      isActive: false,
      defaultActivation: 'enabled' as const,
      workspaceActivation: 'disabled' as const,
      path: '/extensions/demo',
      capabilities: {
        mcpServerCount: 0,
        skillCount: 0,
        agentCount: 0,
        hookCount: 0,
        commandCount: 0,
        contextFileCount: 0,
        channelCount: 0,
        hasSettings: false,
      },
    };
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            workspaceConfigExtensions: vi.fn().mockResolvedValue({
              v: 1,
              workspaceCwd: '/workspace',
              initialized: true,
              extensions: [entry],
            }),
            workspaceRuntimeStatus: vi
              .fn()
              .mockRejectedValue(new Error('runtime unavailable')),
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadExtensionsStatus()).resolves.toMatchObject({
      extensions: [entry],
    });
  });

  it('uses the original scoped extension enable and disable routes', async () => {
    const enableWorkspaceConfigExtension = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'enable-operation',
    });
    const disableWorkspaceConfigExtension = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'disable-operation',
    });
    const workspaceEnable = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'workspace-enable-operation',
    });
    const workspaceDisable = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'workspace-disable-operation',
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          enableWorkspaceConfigExtension,
          disableWorkspaceConfigExtension,
          workspaceByCwd: vi.fn(() => ({
            enableWorkspaceConfigExtension: workspaceEnable,
            disableWorkspaceConfigExtension: workspaceDisable,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.enableExtension('demo', { scope: 'user' }),
    ).resolves.toMatchObject({ operationId: 'enable-operation' });
    await expect(
      actions.disableExtension('demo', { scope: 'workspace' }),
    ).resolves.toMatchObject({ operationId: 'workspace-disable-operation' });

    expect(enableWorkspaceConfigExtension).toHaveBeenCalledWith('demo', {
      scope: 'user',
    });
    expect(workspaceDisable).toHaveBeenCalledWith('demo', {
      scope: 'workspace',
    });
    expect(disableWorkspaceConfigExtension).not.toHaveBeenCalled();
    expect(workspaceEnable).not.toHaveBeenCalled();
  });

  it('updates global and workspace extension activation independently', async () => {
    const setExtensionDefaultActivation = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'default-operation',
    });
    const setExtensionActivation = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'workspace-operation',
    });
    const clearExtensionActivation = vi.fn().mockResolvedValue({
      accepted: true,
      operationId: 'inherit-operation',
    });
    const extensionOperation = vi.fn().mockResolvedValue({
      operationId: 'workspace-operation',
      status: 'succeeded',
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          setExtensionDefaultActivation,
          extensionOperation,
          workspaceByCwd: vi.fn(() => ({
            setExtensionActivation,
            clearExtensionActivation,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await actions.setExtensionActivation('extension-id', {
      scope: 'user',
      state: 'disabled',
    });
    await actions.setExtensionActivation('extension-id', {
      scope: 'workspace',
      state: 'enabled',
    });
    await actions.extensionOperationStatus('workspace-operation');
    await actions.setExtensionActivation('extension-id', {
      scope: 'workspace',
      state: 'inherit',
    });

    expect(setExtensionDefaultActivation).toHaveBeenCalledWith(
      'extension-id',
      'disabled',
    );
    expect(setExtensionActivation).toHaveBeenCalledWith(
      'extension-id',
      'enabled',
    );
    expect(extensionOperation).toHaveBeenCalledWith('workspace-operation');
    expect(clearExtensionActivation).toHaveBeenCalledWith('extension-id');
  });

  it('returns extension configuration without depending on runtime status', async () => {
    const workspaceConfigExtensions = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      desiredGeneration: 4,
      appliedGeneration: 3,
      extensions: [],
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            workspaceConfigExtensions,
            workspaceRuntimeStatus: vi
              .fn()
              .mockRejectedValue(new Error('runtime unavailable')),
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadExtensionsStatus()).resolves.toEqual({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      desiredGeneration: 4,
      appliedGeneration: 3,
      extensions: [],
    });
  });

  it('reads the Skills runtime snapshot without starting the runtime', async () => {
    const ensureWorkspaceRuntime = vi
      .fn()
      .mockRejectedValue(new Error('ACP unavailable'));
    const workspaceRuntimeSkills = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      source: 'config',
      skills: [{ name: 'review', status: 'ok' }],
    });
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      state: 'cold',
      runtimeLive: false,
      runtimeEpoch: 3,
      capabilities: {
        skills: {
          state: 'stale',
          runtimeEpoch: 2,
        },
      },
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            ensureWorkspaceRuntime,
            workspaceRuntimeSkills,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadSkillsStatus()).resolves.toMatchObject({
      source: 'config',
      skills: [{ name: 'review' }],
      runtimeState: 'stale',
      coordinatorRuntimeEpoch: 3,
      capabilityRuntimeEpoch: 2,
      runtimeCatalogInitialized: false,
      runtimeCatalogSource: 'config',
    });
    expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
    expect(workspaceRuntimeSkills).toHaveBeenCalledOnce();
  });

  it('reuses a prepared runtime status when loading Skills', async () => {
    const workspaceRuntimeSkills = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: 4,
      source: 'live',
      skills: [{ name: 'review', status: 'ok' }],
    });
    const workspaceRuntimeStatus = vi.fn();
    const preparedStatus = {
      v: 1 as const,
      workspaceCwd: '/workspace',
      state: 'idle' as const,
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        skills: { state: 'ready' as const, runtimeEpoch: 4 },
      },
    };
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            workspaceRuntimeSkills,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.loadSkillsStatus(preparedStatus),
    ).resolves.toMatchObject({
      runtimeState: 'ready',
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
      runtimeCatalogSource: 'live',
    });
    expect(workspaceRuntimeSkills).toHaveBeenCalledOnce();
    expect(workspaceRuntimeStatus).not.toHaveBeenCalled();
  });

  it('loads the Skills config inventory without preparing the runtime', async () => {
    const ensureWorkspaceRuntime = vi.fn();
    const workspaceConfigSkills = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'config',
      skills: [{ name: 'review', status: 'disabled' }],
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            ensureWorkspaceRuntime,
            workspaceConfigSkills,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadSkillsConfigStatus()).resolves.toMatchObject({
      source: 'config',
      skills: [{ name: 'review', status: 'disabled' }],
    });
    expect(workspaceConfigSkills).toHaveBeenCalledOnce();
    expect(ensureWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('loads Tools from the selected workspace runtime', async () => {
    const ensureWorkspaceRuntime = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/secondary',
      state: 'active',
      runtimeLive: true,
      runtimeEpoch: 9,
      capabilities: {
        tools: { state: 'ready', runtimeEpoch: 9 },
      },
    });
    const workspaceRuntimeTools = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace/secondary',
      initialized: true,
      runtimeEpoch: 9,
      acpChannelLive: true,
      tools: [],
    });
    const workspaceByCwd = vi.fn(() => ({
      ensureWorkspaceRuntime,
      workspaceRuntimeTools,
    }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadToolsStatus()).resolves.toMatchObject({
      workspaceCwd: '/workspace/secondary',
      runtimeEpoch: 9,
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace/secondary');
    expect(ensureWorkspaceRuntime).toHaveBeenCalledWith();
    expect(workspaceRuntimeTools).toHaveBeenCalledOnce();
  });

  it('reloads MCP settings through the daemon client', async () => {
    const reloadWorkspaceRuntimeMcp = vi.fn().mockResolvedValue({
      capabilities: { mcp: { state: 'ready' } },
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({ reloadWorkspaceRuntimeMcp })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.reloadMcp()).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(reloadWorkspaceRuntimeMcp).toHaveBeenCalledWith(65_000);
  });

  it('polls runtime status until a starting MCP capability is ready', async () => {
    vi.useFakeTimers();
    const ensureWorkspaceRuntime = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      state: 'starting',
      runtimeLive: true,
      capabilities: { mcp: { state: 'starting' } },
    });
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      state: 'active',
      runtimeLive: true,
      capabilities: { mcp: { state: 'ready' } },
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            ensureWorkspaceRuntime,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    const result = actions.initializeMcp();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(ensureWorkspaceRuntime).toHaveBeenCalledWith();
    expect(workspaceRuntimeStatus).toHaveBeenCalledWith(64_500);
  });

  it('uses one deadline across the prepare request and status polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ensureWorkspaceRuntime = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                v: 1,
                workspaceCwd: '/workspace',
                state: 'starting',
                runtimeLive: true,
                capabilities: {
                  mcp: { state: 'starting' },
                },
              }),
            64_000,
          ),
        ),
    );
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      state: 'active',
      runtimeLive: true,
      capabilities: { mcp: { state: 'ready' } },
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            ensureWorkspaceRuntime,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    const result = actions.initializeMcp();
    await vi.advanceTimersByTimeAsync(64_500);

    await expect(result).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(ensureWorkspaceRuntime).toHaveBeenCalledWith();
    expect(workspaceRuntimeStatus).toHaveBeenCalledWith(500);
  });

  it('waits for selected workspace MCP reconciliation', async () => {
    vi.useFakeTimers();
    const workspaceRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce({
        capabilities: { mcp: { state: 'starting' } },
      })
      .mockResolvedValueOnce({
        capabilities: { mcp: { state: 'ready' } },
      });
    const workspaceByCwd = vi.fn(() => ({ workspaceRuntimeStatus }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceByCwd }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    const result = actions.waitForMcpRuntime();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace/secondary');
    expect(workspaceRuntimeStatus).toHaveBeenNthCalledWith(1, 65_000);
    expect(workspaceRuntimeStatus).toHaveBeenNthCalledWith(2, 64_500);
  });

  it('writes workspace MCP config through the selected workspace client', async () => {
    const setWorkspaceMcpConfig = vi.fn().mockResolvedValue({
      name: 'docs',
      scope: 'workspace',
      activation: 'reconciling',
    });
    const setPrimaryMcpConfig = vi.fn();
    const workspaceByCwd = vi.fn(() => ({ setWorkspaceMcpConfig }));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd,
          setWorkspaceMcpConfig: setPrimaryMcpConfig,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.setMcpConfig('docs', 'workspace', { command: 'node' }),
    ).resolves.toMatchObject({ activation: 'reconciling' });
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace/secondary');
    expect(setWorkspaceMcpConfig).toHaveBeenCalledWith('docs', {
      command: 'node',
    });
    expect(setPrimaryMcpConfig).not.toHaveBeenCalled();
  });

  it('keeps global skill installation in the daemon control plane', async () => {
    const installWorkspaceConfigSkill = vi.fn().mockResolvedValue({
      skillName: 'review',
      scope: 'global',
      activation: 'reconciling',
    });
    const installQualifiedSkill = vi.fn();
    const workspaceByCwd = vi.fn(() => ({
      installWorkspaceConfigSkill: installQualifiedSkill,
    }));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd,
          installWorkspaceConfigSkill,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });
    const request = {
      name: 'review',
      scope: 'global' as const,
      source: { type: 'github' as const, url: 'owner/repo' },
    };

    await expect(actions.installWorkspaceSkill(request)).resolves.toMatchObject(
      { activation: 'reconciling' },
    );
    expect(installWorkspaceConfigSkill).toHaveBeenCalledWith(request);
    expect(workspaceByCwd).not.toHaveBeenCalled();
    expect(installQualifiedSkill).not.toHaveBeenCalled();
  });

  it('routes runtime management through the selected workspace client', async () => {
    const workspaceRuntimeMcp = vi.fn().mockResolvedValue({
      servers: [],
      runtimeEpoch: 4,
      source: 'live',
      initialized: true,
      discoveryState: 'completed',
    });
    const workspaceRuntimeStatus = vi.fn().mockResolvedValue({
      runtimeEpoch: 4,
      capabilities: {
        mcp: { state: 'ready', runtimeEpoch: 4 },
      },
    });
    const workspaceByCwd = vi.fn(() => ({
      workspaceRuntimeMcp,
      workspaceRuntimeStatus,
    }));
    const singularWorkspaceRuntimeMcp = vi.fn();
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd,
          workspaceRuntimeMcp: singularWorkspaceRuntimeMcp,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadMcpStatus()).resolves.toMatchObject({
      servers: [],
      runtimeEpoch: 4,
      runtimeState: 'ready',
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
    });
    expect(workspaceByCwd).toHaveBeenCalledWith('/workspace/secondary');
    expect(workspaceRuntimeMcp).toHaveBeenCalledWith(undefined);
    expect(workspaceRuntimeStatus).toHaveBeenCalledWith(undefined);
    expect(singularWorkspaceRuntimeMcp).not.toHaveBeenCalled();
  });

  it('does not claim current MCP state when coordinator status is unavailable', async () => {
    const workspaceRuntimeMcp = vi.fn().mockResolvedValue({
      servers: [],
      runtimeEpoch: 4,
      source: 'live',
      initialized: true,
      discoveryState: 'completed',
    });
    const workspaceRuntimeStatus = vi
      .fn()
      .mockRejectedValue(new Error('runtime unavailable'));
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            workspaceRuntimeMcp,
            workspaceRuntimeStatus,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace/secondary',
      baseUrl: 'http://daemon',
    });

    await expect(actions.loadMcpStatus()).resolves.toMatchObject({
      servers: [],
      runtimeEpoch: 4,
      runtimeState: undefined,
      coordinatorRuntimeEpoch: undefined,
      capabilityRuntimeEpoch: undefined,
    });
  });

  it('loads MCP operation status from the selected workspace runtime', async () => {
    const workspaceRuntimeOperation = vi.fn().mockResolvedValue({
      operationId: 'op-1',
      state: 'waiting_for_input',
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({ workspaceRuntimeOperation })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.mcpOperationStatus('op-1')).resolves.toMatchObject({
      state: 'waiting_for_input',
    });
    expect(workspaceRuntimeOperation).toHaveBeenCalledWith('op-1', undefined);
  });

  it('loads active MCP operations from the selected workspace runtime', async () => {
    const activeWorkspaceRuntimeOperations = vi.fn().mockResolvedValue({
      v: 1,
      operations: [{ operationId: 'op-1', state: 'waiting_for_input' }],
    });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            activeWorkspaceRuntimeOperations,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(actions.activeMcpOperations()).resolves.toMatchObject({
      operations: [{ operationId: 'op-1' }],
    });
    expect(activeWorkspaceRuntimeOperations).toHaveBeenCalledWith(undefined);
  });

  it('persists MCP enablement through the configuration client', async () => {
    const setWorkspaceConfigMcpServerEnabled = vi.fn().mockResolvedValue({
      serverName: 'docs',
      action: 'disable',
      ok: true,
      activation: 'deferred',
    });
    const manageWorkspaceRuntimeMcpServer = vi.fn();
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          workspaceByCwd: vi.fn(() => ({
            setWorkspaceConfigMcpServerEnabled,
            manageWorkspaceRuntimeMcpServer,
          })),
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.manageMcpServer('docs', 'disable', 'workspace'),
    ).resolves.toMatchObject({ activation: 'deferred' });
    expect(setWorkspaceConfigMcpServerEnabled).toHaveBeenCalledWith(
      'docs',
      false,
    );
    expect(manageWorkspaceRuntimeMcpServer).not.toHaveBeenCalled();
  });

  it('persists user MCP enablement through the primary config route', async () => {
    const setUserConfigMcpServerEnabled = vi.fn().mockResolvedValue({
      serverName: 'docs',
      action: 'enable',
      ok: true,
      activation: 'deferred',
    });
    const workspaceByCwd = vi.fn();
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          setUserConfigMcpServerEnabled,
          workspaceByCwd,
        }) as unknown as DaemonClient,
      getWorkspaceCwd: () => '/workspace',
      baseUrl: 'http://daemon',
    });

    await expect(
      actions.manageMcpServer('docs', 'enable', 'user'),
    ).resolves.toMatchObject({ activation: 'deferred' });
    expect(setUserConfigMcpServerEnabled).toHaveBeenCalledWith('docs', true);
    expect(workspaceByCwd).not.toHaveBeenCalled();
  });

  it('forwards an extension interaction response to the daemon client', async () => {
    const respondToWorkspaceConfigExtensionInteraction = vi
      .fn()
      .mockResolvedValue({ accepted: true });
    const actions = createDaemonWorkspaceActions({
      getClient: () =>
        ({
          respondToWorkspaceConfigExtensionInteraction,
          workspaceByCwd: vi.fn(() => ({
            respondToWorkspaceConfigExtensionInteraction: vi.fn(),
          })),
        }) as unknown as DaemonClient,
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
    expect(respondToWorkspaceConfigExtensionInteraction).toHaveBeenCalledWith(
      'op-1',
      'interaction-1',
      { value: 'answer' },
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
});
