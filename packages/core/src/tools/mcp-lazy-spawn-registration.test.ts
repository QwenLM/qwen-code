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
 * Issue #13796 — an HTTP MCP server that was down when the session started
 * gets brought up later by a `readResource` probe. The probe connects, but
 * the lazy-spawn branch of `McpClientManager.readResource()` never ran
 * `discover()`, so the session kept the server at CONNECTED with ZERO
 * registered tools for its whole lifetime (`qwen mcp list` still reports
 * "Connected", and `qwen mcp reconnect --all` runs in a separate process so
 * it cannot repair the live registry either).
 *
 * Mode pinned: LEGACY per-session (non-pooled). `POOLED_TRANSPORTS_DEFAULT`
 * is `{'stdio','websocket'}` (mcp-pool-key.ts), so an `httpUrl` server is
 * never in `pooledConnections` and `readResource()` cannot take the pooled
 * early-return — it always falls through to the lazy-spawn branch below.
 *
 * Only the transport boundary (`McpClient`) is replaced. The manager, its
 * `readResource()` code path, `MCPServerStatus` and the budget/slot
 * bookkeeping are the real production modules. The fake mirrors real
 * `McpClient.discover()` by registering its tools into the `ToolRegistry` it
 * was constructed with, so the assertion below is "did tools land in the
 * registry", not "did the manager call a method".
 */
const h = vi.hoisted(() => ({
  instances: [] as Array<{ readonly calls: string[] }>,
  // A flag rather than a per-instance hook: `readResource()` builds its
  // `Promise.race` array synchronously, so `client.connect()` is invoked
  // before the caller can reach the freshly-constructed instance.
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
      // Mirrors real `McpClient.discover()`: every tool the server advertises
      // is pushed into the shared registry (mcp-client.ts:686-688).
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
    // Identity: the manager only uses it to fold `mcpServerCommand` into the
    // configured servers, which these fixtures do not rely on.
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

    // The reporter's symptom: CONNECTED, but no `mcp__zoteus__*` tool exists
    // for the rest of the session. Pre-fix this received 0 calls because the
    // lazy-spawn branch connected without ever discovering.
    expect(ctx.toolRegistry.registerTool).toHaveBeenCalledTimes(1);
    expect(ctx.toolRegistry.registerTool).toHaveBeenCalledWith({
      name: 'mcp__zoteus__echo',
    });

    // Discovery must happen on the spawn, before the read is served — not as a
    // detached background task that the caller cannot observe.
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

    // Second read reuses the CONNECTED client, so the lazy-spawn branch (and
    // therefore discovery) must not run again.
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
    // No tools registered for a server that never came up: the failure is
    // surfaced to the caller instead of leaving a CONNECTED-with-zero-tools
    // server behind.
    expect(ctx.toolRegistry.registerTool).not.toHaveBeenCalled();
    // The `disconnect()` cleanup in this catch is gated on `weReservedSlot`,
    // which is false under the default `off` budget mode (`tryReserveSlot`
    // returns 'reserved' without recording it in `reservedSlots`). That is
    // pre-existing slot bookkeeping, orthogonal to this fix, so it is not
    // asserted here.
    expect(h.instances[0].calls).toEqual(['connect']);
  });
});
