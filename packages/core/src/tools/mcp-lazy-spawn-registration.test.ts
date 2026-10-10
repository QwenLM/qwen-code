/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientManager } from './mcp-client-manager.js';
import type { MCPServerConfig, Config } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Issue #13796 — a `readResource` probe lazily spawns an HTTP MCP server
 * but never ran `discover()`, leaving the server CONNECTED with zero tools
 * for the session's lifetime. An `httpUrl` server is never pooled, so the
 * probe always takes the lazy-spawn branch pinned here. Only the transport
 * (`McpClient`) is faked; the manager and registries are real.
 */
const h = vi.hoisted(() => ({
  instances: [] as Array<{ readonly calls: string[] }>,
  // A flag, not a hook: readResource() builds its Promise.race synchronously.
  failConnect: false,
  connectError: new Error('ECONNREFUSED 192.168.0.28:3939'),
}));

vi.mock('./mcp-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('./mcp-client.js')>('./mcp-client.js');

  class FakeMcpClient {
    readonly calls: string[] = [];
    private status = actual.MCPServerStatus.DISCONNECTED;

    constructor(
      private readonly serverName: string,
      _serverConfig: MCPServerConfig,
      private readonly toolRegistry: ToolRegistry,
    ) {
      h.instances.push(this);
    }

    getStatus() {
      return this.status;
    }

    async connect() {
      this.calls.push('connect');
      if (h.failConnect) throw h.connectError;
      this.status = actual.MCPServerStatus.CONNECTED;
    }

    async discover() {
      this.calls.push('discover');
      // Mirrors the real discover(): advertised tools land in the registry.
      this.toolRegistry.registerTool({
        name: `mcp__${this.serverName}__echo`,
      } as never);
    }

    async readResource(uri: string) {
      this.calls.push('readResource');
      return { contents: [{ uri, text: 'resource-body' }] };
    }

    async disconnect() {
      this.calls.push('disconnect');
      this.status = actual.MCPServerStatus.DISCONNECTED;
    }
  }

  return {
    ...actual,
    McpClient: FakeMcpClient,
    // Identity: these fixtures do not rely on mcpServerCommand folding.
    populateMcpServerCommand: vi.fn((servers: unknown) => servers),
  };
});

/** HTTP (streamable) server, matching the reporter's `http://host:3939/mcp`. */
const HTTP_SERVERS = Object.freeze({
  zoteus: { httpUrl: 'http://192.168.0.28:3939/mcp' },
});

function setup(servers: Record<string, MCPServerConfig> = { ...HTTP_SERVERS }) {
  const toolRegistry = {
    registerTool: vi.fn(),
    removeMcpToolsByServer: vi.fn(),
  };
  const config = {
    isTrustedFolder: () => true,
    getMcpServers: () => servers,
    getMcpServerCommand: () => undefined,
    getTargetDir: () => '/session/worktree',
    isMcpServerDisabled: () => false,
    getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
    getPromptRegistry: () => ({
      removePromptsByServer: vi.fn(),
      registerPrompt: vi.fn(),
    }),
    getWorkspaceContext: () => ({}),
    getDebugMode: () => false,
  } as unknown as Config;

  const manager = new McpClientManager(
    config,
    toolRegistry as unknown as ToolRegistry,
    // No auto-reconnect: keeps the health monitor's `setInterval` out of the
    // test so nothing races a real clock.
    { healthConfig: { autoReconnect: false } },
  );

  return { manager, toolRegistry };
}

describe('McpClientManager lazy-spawn tool registration (#13796)', () => {
  let manager: McpClientManager | undefined;

  beforeEach(() => {
    h.instances.length = 0;
    h.failConnect = false;
  });

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
    vi.clearAllMocks();
  });

  it('registers the tools of an HTTP server it lazily spawns for a resource read', async () => {
    const ctx = setup();
    manager = ctx.manager;

    await manager.readResource('zoteus', 'mcp://zoteus/doc');

    // Pre-fix this got 0 calls: the lazy-spawn branch never discovered.
    expect(ctx.toolRegistry.registerTool).toHaveBeenCalledTimes(1);
    expect(ctx.toolRegistry.registerTool).toHaveBeenCalledWith({
      name: 'mcp__zoteus__echo',
    });

    // Discovery happens on the spawn, before the read is served.
    expect(h.instances[0].calls).toEqual([
      'connect',
      'discover',
      'readResource',
    ]);
  });

  it('still returns the resource the caller asked for', async () => {
    const ctx = setup();
    manager = ctx.manager;

    await expect(
      manager.readResource('zoteus', 'mcp://zoteus/doc'),
    ).resolves.toEqual({
      contents: [{ uri: 'mcp://zoteus/doc', text: 'resource-body' }],
    });
  });

  it('discovers once, not on every read, once the lazy-spawned server is connected', async () => {
    const ctx = setup();
    manager = ctx.manager;

    await manager.readResource('zoteus', 'mcp://zoteus/a');
    await manager.readResource('zoteus', 'mcp://zoteus/b');

    // The second read reuses the CONNECTED client; no re-discovery.
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0].calls).toEqual([
      'connect',
      'discover',
      'readResource',
      'readResource',
    ]);
    expect(ctx.toolRegistry.registerTool).toHaveBeenCalledTimes(1);
  });

  it('still surfaces a server that is genuinely unreachable', async () => {
    const ctx = setup();
    manager = ctx.manager;
    const boom = h.connectError;
    h.failConnect = true;

    await expect(
      manager.readResource('zoteus', 'mcp://zoteus/doc'),
    ).rejects.toBe(boom);
    // A server that never came up registers no tools.
    expect(ctx.toolRegistry.registerTool).not.toHaveBeenCalled();
    // The disconnect() cleanup is gated on `weReservedSlot`, false under the
    // default `off` budget mode — pre-existing bookkeeping, not asserted here.
    expect(h.instances[0].calls).toEqual(['connect']);
  });
});
