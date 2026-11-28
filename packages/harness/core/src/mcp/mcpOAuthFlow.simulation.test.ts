/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simulates the daemon-side MCP authorization path with the real pool and
 * session managers: startup prewarm → first-session attach → prepare → host
 * authorization → reconnect. Only the network boundary is mocked.
 */

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceService } from '@qwen-code/resource';
import type { MCPServerConfig } from './mcpServerConfig.js';
import {
  McpAuthorizationRequiredError,
  type McpAuthorizationAction,
} from './authorization.js';
import { Storage } from '../config/storage.js';
import type { McpConnectorMap } from './connector/types.js';
import type { McpServerRegistration } from './mcpManager.js';
import { McpManager } from './mcpManager.js';
import { McpSettingsGate } from './gate.js';
import { fileMcpSourceId, mcpServerKey } from './server-key.js';
import { SessionMcpManager } from './sessionMcpManager/sessionMcpManager.js';
import type { McpSessionContext } from './sessionMcpManager/types.js';

const mocks = vi.hoisted(() => ({
  connectToMcpServer: vi.fn(),
  discoverTools: vi.fn(),
  discoverPrompts: vi.fn(),
  discoverResources: vi.fn(),
}));

vi.mock('./connector/connectMcpServer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, connectToMcpServer: mocks.connectToMcpServer };
});
vi.mock('./tools/mcp-tool.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverTools: mocks.discoverTools };
});
vi.mock('./tools/mcp-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverPrompts: mocks.discoverPrompts };
});
vi.mock('./tools/mcp-resource.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverResources: mocks.discoverResources };
});

const { MCPServerStatus } = await import('./client/mcpClient.js');

const ACTION: McpAuthorizationAction = {
  type: 'open_url',
  serverId: 'user:apphub',
  connectionId: 'conn-1',
  authorizationRequestId: 'auth-1',
  url: new URL('https://auth.example.test/start'),
  expiresAtMs: Date.now() + 60_000,
};

class TestAuthorizationCoordinator {
  action: McpAuthorizationAction | undefined;
  state: 'awaiting_confirmation' | undefined;
  private onSucceeded: (() => Promise<void> | void) | undefined;

  canHandle(): boolean {
    return true;
  }
  getAction(): McpAuthorizationAction | undefined {
    return this.action;
  }
  getState(): 'awaiting_confirmation' | undefined {
    return this.state;
  }
  registerAction(
    _name: string,
    action: McpAuthorizationAction,
    onSucceeded: () => Promise<void> | void,
  ): void {
    this.action = action;
    this.state = 'awaiting_confirmation';
    this.onSucceeded = onSucceeded;
  }
  async authorize(): Promise<{ state: 'completed' }> {
    const onSucceeded = this.onSucceeded;
    this.action = undefined;
    this.state = undefined;
    await onSucceeded?.();
    return { state: 'completed' };
  }
  cancelServer(): void {
    this.action = undefined;
    this.state = undefined;
    this.onSucceeded = undefined;
  }
  cancelAll(): void {
    this.cancelServer();
  }
}

function createFakeClient() {
  return {
    getProtocolEra: () => 'legacy',
    getServerCapabilities: () => ({}),
    getServerVersion: () => ({ name: 'fake', version: '1.0.0' }),
    getInstructions: () => undefined,
    setNotificationHandler: vi.fn(),
    callTool: vi.fn(async () => ({ content: [] })),
    request: vi.fn(async () => ({ contents: [] })),
    notification: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onclose: undefined,
    onerror: undefined,
  };
}

function userSettingsPath(): string {
  const path = Storage.getGlobalSettingsPath();
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function registration(): McpServerRegistration {
  const settingsPath = userSettingsPath();
  return {
    key: mcpServerKey(fileMcpSourceId(settingsPath), 'figma'),
    config: {
      scope: 'user',
      type: 'http',
      url: 'https://gateway.example.test/mcp',
      qoder_url: 'https://gateway.example.test',
    } as MCPServerConfig,
    rootsDir: dirname(settingsPath),
  };
}

function createSession(
  sessionId: string,
  server: McpServerRegistration,
  manager: McpManager,
  coordinator: TestAuthorizationCoordinator,
) {
  const context = {
    getSessionId: () => sessionId,
    getMcpServers: () => ({ [server.key.name]: server.config }),
    getAllowedMcpServers: () => [server.key.name],
    getBlockedMcpServers: () => [],
    getTargetDir: () => dirname(userSettingsPath()),
    isTrustedFolder: () => true,
    isInteractive: () => false,
    getToolRegistry: () => ({
      registerTool: vi.fn(),
      unregisterTool: vi.fn(),
      getAllKnownTools: vi.fn(() => []),
      getKnownTool: vi.fn(),
      removeMcpToolsByServer: vi.fn(),
      sortTools: vi.fn(),
      invalidateSchemaCache: vi.fn(),
    }),
    elicit: vi.fn(async () => ({ action: 'cancel' as const })),
    notifyElicitationComplete: vi.fn(),
    registerLazyMetaTools: vi.fn(),
    mcpToolListChange: vi.fn(),
  } as unknown as McpSessionContext;
  return new SessionMcpManager(context, manager, new McpSettingsGate(), {
    createAuthorizationCoordinator: () => coordinator as never,
  });
}

describe('daemon MCP authorization simulation', () => {
  it('runs startup, first session attach, prepare and reconnect', async () => {
    mocks.discoverTools.mockResolvedValue([]);
    mocks.discoverPrompts.mockResolvedValue([]);
    mocks.discoverResources.mockResolvedValue([]);
    const firstAction: McpAuthorizationAction = {
      ...ACTION,
      authorizationRequestId: 'auth-1',
    };
    const freshAction: McpAuthorizationAction = {
      ...ACTION,
      authorizationRequestId: 'auth-2',
    };
    let authorized = false;
    let nextAction = firstAction;
    mocks.connectToMcpServer.mockImplementation(async () => {
      if (!authorized) throw new McpAuthorizationRequiredError(nextAction);
      return createFakeClient();
    });

    const manager = new McpManager(
      {} as ResourceService,
      new Map([['http', { connect: vi.fn() }]]) as McpConnectorMap,
      '1.0.0',
      false,
      {
        enableEnvironmentVariableRedaction: false,
        allowedEnvironmentVariables: [],
        blockedEnvironmentVariables: [],
      },
    );
    const server = registration();

    // Daemon startup: prewarm the user-level gateway server without an
    // interactive auth flow.
    const loaded = await manager.reloadUserMcpServers([server]);
    expect(loaded[0]?.outcome).toBe('auth_required');
    expect(manager.getStatus(server.key)).toBe(MCPServerStatus.AUTH_REQUIRED);
    expect(
      manager.getClient(server.key)?.getAuthorizationRequiredError()?.action,
    ).toEqual(firstAction);

    // Three sessions attach to the same parked pool entry. Their own
    // coordinators must see the action without waiting for another event.
    const coordinators = [
      new TestAuthorizationCoordinator(),
      new TestAuthorizationCoordinator(),
      new TestAuthorizationCoordinator(),
    ];
    const sessions = coordinators.map((coordinator, index) =>
      createSession(`sess-${index}`, server, manager, coordinator),
    );
    for (const session of sessions) await session.initialize();
    for (const coordinator of coordinators) {
      expect(coordinator.getAction()?.authorizationRequestId).toBe('auth-1');
    }

    // Explicit authorize reconnects the same parked client. Drop the cached
    // action first so the preparation exercise really starts from a reconnect.
    coordinators[2].cancelServer();
    nextAction = freshAction;
    await expect(
      sessions[2].prepareMcpAuthorization('figma'),
    ).resolves.toEqual({ kind: 'action', action: freshAction });
    expect(
      manager.getClient(server.key)?.getAuthorizationRequiredError()?.action,
    ).toEqual(freshAction);

    // The host completes authorization; the coordinator callback reconnects
    // the pooled client and it reaches CONNECTED.
    authorized = true;
    await expect(coordinators[2].authorize()).resolves.toEqual({
      state: 'completed',
    });
    expect(manager.getStatus(server.key)).toBe(MCPServerStatus.CONNECTED);
    for (const session of sessions) {
      expect(session.getNeedsAuthServerNames()).toEqual([]);
    }

    for (const session of sessions) await session.dispose();
    await manager.dispose();
  });
});
