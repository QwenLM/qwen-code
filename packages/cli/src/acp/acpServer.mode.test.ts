/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { getVersion, type Config } from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import type { ThreadManager } from '../thread-manager/threadManager.js';
import { AcpServer } from './acpServer.js';
import { buildAvailableModes } from './acpSupport.js';
import type { AcpSessionState } from './acpSessionHost.js';

vi.mock('../core/startupLifecycle.js', () => ({
  runAfterAuthAttemptStartup: vi.fn(),
}));

function makeState(overrides: Partial<AcpSessionState> = {}): AcpSessionState {
  return {
    sessionId: 'session-1',
    cwd: '/workspace',
    clientCapabilities: undefined,
    mcpServers: [],
    additionalDirectories: [],
    abortController: new AbortController(),
    modelAdapter: { buildReasoningEffortOption: () => null },
    host: {},
    callContext: { signal: new AbortController().signal, host: {} },
    updateChain: Promise.resolve(),
    eventChain: Promise.resolve(),
    pendingCommands: new Map(),
    activeCommandUuid: undefined,
    toolPublisher: undefined,
    toolCallNames: new Map(),
    permissionToolCallIds: new Set(),
    modes: { availableModes: buildAvailableModes(), currentModeId: 'default' },
    models: { availableModels: [], currentModelId: 'auto' },
    configOptions: [],
    disposed: false,
    active: false,
    ...overrides,
  } as unknown as AcpSessionState;
}

function fixture(state: AcpSessionState) {
  const setPermissionMode = vi.fn(async () => {});
  const config = { getPermissionMode: () => 'default' } as unknown as Config;
  const manager = {
    provideHost: vi.fn(),
    subscribe: vi.fn(),
    requireSession: () => ({ requireConfig: () => config }),
    setPermissionMode,
  } as unknown as ThreadManager;
  const connection = {
    sessionUpdate: vi.fn(async () => ({})),
  } as unknown as acp.AgentSideConnection;
  const server = new AcpServer({
    argv: {} as CliArgs,
    manager,
    managerReady: Promise.resolve(),
    connection,
  });
  (
    server as unknown as { sessions: Map<string, AcpSessionState> }
  ).sessions.set(state.sessionId, state);
  return { server, setPermissionMode, connection };
}

describe('ACP session mode switching', () => {
  it.each(['yolo', 'bypassPermissions'])(
    'translates the advertised mode %s to the SDK wire value',
    async (modeId) => {
      const state = makeState();
      const { server, setPermissionMode, connection } = fixture(state);

      await server.setSessionMode({ sessionId: state.sessionId, modeId });

      expect(setPermissionMode).toHaveBeenCalledExactlyOnceWith(
        state.callContext,
        state.sessionId,
        { mode: 'bypassPermissions' },
      );
      expect(state.modes.currentModeId).toBe('yolo');
      expect(connection.sessionUpdate).toHaveBeenCalledWith({
        sessionId: state.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' },
      });
    },
  );

  it('translates yolo when switching through the mode config option', async () => {
    const state = makeState({
      configOptions: [
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'default',
          options: [
            {
              value: 'yolo',
              name: 'Bypass Permissions',
              description: 'Auto-approves all tools',
            },
          ],
        },
      ],
    });
    const { server, setPermissionMode } = fixture(state);

    await server.setSessionConfigOption({
      sessionId: state.sessionId,
      configId: 'mode',
      value: 'yolo',
    });

    expect(setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      state.callContext,
      state.sessionId,
      { mode: 'bypassPermissions' },
    );
    expect(state.modes.currentModeId).toBe('yolo');
  });

  it('keeps the no-op fast path when the session already uses yolo', async () => {
    const state = makeState({
      modes: { availableModes: buildAvailableModes(), currentModeId: 'yolo' },
    });
    const { server, setPermissionMode } = fixture(state);

    await server.setSessionMode({
      sessionId: state.sessionId,
      modeId: 'bypassPermissions',
    });

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(state.modes.currentModeId).toBe('yolo');
  });
});

it('preserves the ACP initialization version without a stream-json version field', async () => {
  const { server } = fixture(makeState());
  const response = await server.initialize({ protocolVersion: 1 });
  expect(response.agentInfo?.version).toBe(await getVersion());
  expect(response).not.toHaveProperty('qodercli_version');
  expect(response.agentInfo).not.toHaveProperty('qodercli_version');
});
