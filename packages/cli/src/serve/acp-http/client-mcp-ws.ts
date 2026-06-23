/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-hosted MCP over the daemon WS (issue #5626, Phase 2 "reverse tool
 * channel").
 *
 * A connected WS client (the Chrome extension) hosts an MCP server (its
 * browser tools) that the daemon's agent calls. The agent's MCP client side is
 * the existing `SdkControlClientTransport`; this module is the daemon-WS glue
 * that carries the same `mcp_message` JSON-RPC frames over the WS rather than
 * the SDK subprocess control plane.
 *
 * Per-connection lifecycle:
 *   - `mcp_register { server }`     → register an SDK-type runtime MCP server
 *                                     whose `sendSdkMcpMessage` pushes
 *                                     `mcp_message` frames down THIS WS.
 *   - `mcp_message { id, server, payload }` (client→daemon) → resolve the
 *                                     correlated pending request.
 *   - `mcp_unregister { server }`   → remove the runtime server + reject
 *                                     pending.
 *   - WS close                      → tear down all of the connection's
 *                                     servers + reject pending.
 *
 * Wiring status (see the architecture note in `05-daemon-direct-architecture.md`
 * and the PR notes): the WS framing + correlation is fully wired through the
 * real `ClientMcpRegistrar` / `SdkControlClientTransport` round-trip. The deep
 * hookup into the agent's live `McpClientManager` is injected via a
 * {@link ClientMcpServerProvider}. In the current daemon the `McpClientManager`
 * lives in the ACP child process while this WS lives in the parent, so the
 * provider is wired only when one is supplied (the round-trip test supplies a
 * real in-process manager). When absent, registration is rejected with a
 * structured `not_wired` error so the contract stays honest.
 */

import {
  ClientMcpRegistrar,
  type ClientMcpFrame,
} from '@qwen-code/qwen-code-core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** WS frame discriminators owned by this module. */
export const CLIENT_MCP_FRAME_TYPES = {
  register: 'mcp_register',
  message: 'mcp_message',
  unregister: 'mcp_unregister',
} as const;

/** Inbound `mcp_register` frame from a client. */
export interface McpRegisterFrame {
  type: 'mcp_register';
  /** Logical server name; tools are discovered via the MCP handshake. */
  server: string;
}

/** Bidirectional `mcp_message` frame (request/response correlated by `id`). */
export interface McpMessageFrame {
  type: 'mcp_message';
  id: string;
  server: string;
  payload: JSONRPCMessage;
}

/** Inbound `mcp_unregister` frame from a client. */
export interface McpUnregisterFrame {
  type: 'mcp_unregister';
  server: string;
}

/**
 * Injection point for the deep wiring into the agent's live MCP stack. An
 * implementation registers an SDK-type runtime MCP server whose discovery /
 * tool calls route through `sendSdkMcpMessage`, and tears it down on
 * unregister / WS close.
 */
export interface ClientMcpServerProvider {
  /**
   * Register a client-hosted MCP server. `sendSdkMcpMessage` is the callback
   * the agent's `SdkControlClientTransport` invokes; it MUST route to this
   * connection's WS. Resolves once the server is registered + discovered.
   */
  registerClientMcpServer(
    serverName: string,
    sendSdkMcpMessage: (
      serverName: string,
      message: JSONRPCMessage,
    ) => Promise<JSONRPCMessage>,
  ): Promise<{ toolCount: number }>;
  /** Remove a previously-registered client-hosted MCP server. Idempotent. */
  unregisterClientMcpServer(serverName: string): Promise<void>;
}

/** A minimal sink for pushing frames down the owning WS. */
export type WsFrameSender = (frame: McpMessageFrame) => void;

/** Outcome of handling one inbound client-MCP frame (for the WS reply). */
export type ClientMcpHandleResult =
  | { kind: 'registered'; server: string; toolCount: number }
  | { kind: 'unregistered'; server: string }
  | { kind: 'message_resolved'; id: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'error'; code: string; message: string };

/**
 * Server-name validation mirroring the runtime-MCP-mutation guard in
 * `acpAgent.ts`: ≤256 chars, alphanumeric + underscore/hyphen, not a reserved
 * JS property name.
 */
function isValidServerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(name) &&
    name !== '__proto__' &&
    name !== 'constructor' &&
    name !== 'prototype'
  );
}

/**
 * Per-WS-connection holder for client-hosted MCP servers. One instance per
 * connection; disposed on WS close.
 */
export class ClientMcpWsConnection {
  private readonly registrar: ClientMcpRegistrar;
  private disposed = false;

  constructor(
    private readonly sendFrame: WsFrameSender,
    private readonly provider: ClientMcpServerProvider | undefined,
  ) {
    this.registrar = new ClientMcpRegistrar({
      sendFrame: (frame: ClientMcpFrame) => {
        this.sendFrame({
          type: CLIENT_MCP_FRAME_TYPES.message,
          id: frame.id,
          server: frame.server,
          payload: frame.payload,
        });
      },
    });
  }

  /**
   * Route a parsed inbound frame. Returns a structured result the WS layer can
   * turn into an ack/error reply (or ignore). Never throws — protocol errors
   * are returned as `{ kind: 'error' }`.
   */
  async handleFrame(frame: {
    type?: unknown;
    server?: unknown;
    id?: unknown;
    payload?: unknown;
  }): Promise<ClientMcpHandleResult> {
    if (this.disposed) {
      return { kind: 'error', code: 'closed', message: 'connection closed' };
    }
    switch (frame.type) {
      case CLIENT_MCP_FRAME_TYPES.register:
        return this.handleRegister(frame.server);
      case CLIENT_MCP_FRAME_TYPES.unregister:
        return this.handleUnregister(frame.server);
      case CLIENT_MCP_FRAME_TYPES.message:
        return this.handleMessage(frame.id, frame.payload);
      default:
        return {
          kind: 'ignored',
          reason: `unknown client-mcp frame type: ${String(frame.type)}`,
        };
    }
  }

  /** Whether a frame's `type` is one this module owns. */
  static isClientMcpFrameType(type: unknown): boolean {
    return (
      type === CLIENT_MCP_FRAME_TYPES.register ||
      type === CLIENT_MCP_FRAME_TYPES.message ||
      type === CLIENT_MCP_FRAME_TYPES.unregister
    );
  }

  private async handleRegister(
    server: unknown,
  ): Promise<ClientMcpHandleResult> {
    if (!isValidServerName(server)) {
      return {
        kind: 'error',
        code: 'invalid_server_name',
        message:
          'server must be ≤256 chars, alphanumeric + underscore/hyphen, and not a reserved JS property name',
      };
    }
    if (this.registrar.hasServer(server)) {
      return {
        kind: 'error',
        code: 'already_registered',
        message: `server '${server}' is already registered on this connection`,
      };
    }
    if (!this.provider) {
      return {
        kind: 'error',
        code: 'not_wired',
        message:
          'client_mcp_over_ws is advertised but no McpClientManager provider is wired into this daemon process',
      };
    }
    // Advertise to the registrar BEFORE registering so the SDK discovery
    // handshake (which the provider triggers synchronously) can route frames.
    this.registrar.registerServer(server);
    try {
      const { toolCount } = await this.provider.registerClientMcpServer(
        server,
        this.registrar.sendSdkMcpMessage,
      );
      return { kind: 'registered', server, toolCount };
    } catch (err) {
      // Roll back the registrar advertisement on failure.
      this.registrar.unregisterServer(server);
      return {
        kind: 'error',
        code: 'register_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleUnregister(
    server: unknown,
  ): Promise<ClientMcpHandleResult> {
    if (!isValidServerName(server)) {
      return {
        kind: 'error',
        code: 'invalid_server_name',
        message: 'server name is invalid',
      };
    }
    const existed = this.registrar.unregisterServer(server);
    if (existed && this.provider) {
      try {
        await this.provider.unregisterClientMcpServer(server);
      } catch {
        // Best-effort teardown — the registrar already rejected pending.
      }
    }
    return { kind: 'unregistered', server };
  }

  private handleMessage(
    id: unknown,
    payload: unknown,
  ): ClientMcpHandleResult {
    if (typeof id !== 'string' || id.length === 0) {
      return {
        kind: 'error',
        code: 'invalid_id',
        message: '`id` must be a non-empty string',
      };
    }
    if (payload === null || typeof payload !== 'object') {
      return {
        kind: 'error',
        code: 'invalid_payload',
        message: '`payload` must be a JSON-RPC message object',
      };
    }
    const resolved = this.registrar.resolveMessage(
      id,
      payload as JSONRPCMessage,
    );
    return resolved
      ? { kind: 'message_resolved', id }
      : { kind: 'ignored', reason: `no pending request for id '${id}'` };
  }

  /** Currently-registered server names on this connection. */
  registeredServers(): string[] {
    return this.registrar.registeredServers();
  }

  /** In-flight `mcp_message` round-trip count (for tests / accounting). */
  pendingCount(): number {
    return this.registrar.pendingCount();
  }

  /**
   * Tear the connection down: reject pending, forget servers, and best-effort
   * remove each from the provider. Idempotent.
   */
  async dispose(reason = 'client MCP WS connection closed'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const servers = this.registrar.registeredServers();
    this.registrar.close(reason);
    if (this.provider) {
      await Promise.allSettled(
        servers.map((server) =>
          this.provider!.unregisterClientMcpServer(server),
        ),
      );
    }
  }
}
