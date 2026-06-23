/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ClientMcpRegistrar - reverse tool channel for daemon-direct MCP servers
 * (issue #5626, Phase 2).
 *
 * A connected daemon client (e.g. the Chrome extension) cannot be a listening
 * MCP server, but it CAN host MCP tools that the daemon's agent reaches by
 * carrying `mcp_message` JSON-RPC frames over the client transport (the daemon
 * WS). This registrar reuses the SDK-MCP-server control-plane pattern
 * (`SdkControlClientTransport` + `sendSdkMcpMessage`) WITHOUT binding to the
 * SDK subprocess `Query` control plane.
 *
 * The registrar is transport-agnostic: it owns the per-server pending-request
 * correlation map and produces a `sendSdkMcpMessage(serverName, jsonrpc)`
 * callback. The caller wires `sendFrame` to push an `mcp_message` frame down
 * the actual wire (the daemon WS) and calls `resolveMessage` when the matching
 * response frame arrives. This keeps the wire format (WS vs. anything else) out
 * of core, while the `id`-correlation + timeout + teardown semantics live in
 * one tested place.
 *
 * Data flow (mirrors `docs/05-daemon-direct-architecture.md`):
 *   agent MCP client → SdkControlClientTransport.send
 *     → sendSdkMcpMessage('chrome-tools', jsonrpc)   (this registrar)
 *     → sendFrame({ id, server, payload: jsonrpc })  (caller: WS frame down)
 *     → client: MCP Server.handleMessage → tool executor
 *     → client: response frame { id, server, payload: jsonrpc-result }
 *     → resolveMessage(id, payload)                  (caller)
 *     → resolve the pending sendSdkMcpMessage promise → agent gets the result
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CLIENT_MCP_REGISTRAR');

/** Default ceiling on a single in-flight `mcp_message` round-trip. */
export const CLIENT_MCP_MESSAGE_TIMEOUT_MS = 30_000;

/**
 * The frame the registrar asks the caller to put on the wire. The caller is
 * responsible for serializing this into a `{ type: 'mcp_message', ... }` WS
 * frame (the `type` discriminator is owned by the WS layer, not core).
 */
export interface ClientMcpFrame {
  /** Correlation id; the response frame MUST echo it back. */
  id: string;
  /** Logical MCP server name the client advertised via `mcp_register`. */
  server: string;
  /** The raw JSON-RPC MCP message to deliver to the client-hosted server. */
  payload: JSONRPCMessage;
}

/**
 * Caller-supplied sink that puts an outbound frame on the wire. Throwing (or
 * a rejected promise) fails the originating `sendSdkMcpMessage` call so the
 * agent's MCP client sees a transport error rather than hanging.
 */
export type ClientMcpFrameSink = (frame: ClientMcpFrame) => void | Promise<void>;

interface PendingRequest {
  resolve: (message: JSONRPCMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  server: string;
}

export interface ClientMcpRegistrarOptions {
  /** Puts an outbound `mcp_message` frame on the wire. */
  sendFrame: ClientMcpFrameSink;
  /** Per-message round-trip timeout. Defaults to {@link CLIENT_MCP_MESSAGE_TIMEOUT_MS}. */
  messageTimeoutMs?: number;
}

/**
 * Owns the request/response correlation for one wire (one daemon WS client).
 * A single registrar can host several named MCP servers from the same client
 * — `sendSdkMcpMessage` routes by `serverName`, and teardown is per-server or
 * wholesale (on WS close).
 */
export class ClientMcpRegistrar {
  private readonly sendFrame: ClientMcpFrameSink;
  private readonly messageTimeoutMs: number;
  /** Pending in-flight requests, keyed by correlation id. */
  private readonly pending = new Map<string, PendingRequest>();
  /** Registered server names (advertised via `mcp_register`). */
  private readonly servers = new Set<string>();
  private nextId = 1;
  private closed = false;

  constructor(options: ClientMcpRegistrarOptions) {
    this.sendFrame = options.sendFrame;
    this.messageTimeoutMs =
      options.messageTimeoutMs ?? CLIENT_MCP_MESSAGE_TIMEOUT_MS;
  }

  /**
   * Mark a server name as advertised by this client. Idempotent.
   */
  registerServer(serverName: string): void {
    this.servers.add(serverName);
    debugLogger.debug(`Registered client MCP server '${serverName}'`);
  }

  /**
   * Drop a server name and reject any in-flight requests targeting it. Returns
   * `true` if the name was registered. Idempotent for unknown names.
   */
  unregisterServer(serverName: string): boolean {
    const existed = this.servers.delete(serverName);
    this.rejectPendingFor(
      (pending) => pending.server === serverName,
      new Error(`client MCP server '${serverName}' was unregistered`),
    );
    if (existed) {
      debugLogger.debug(`Unregistered client MCP server '${serverName}'`);
    }
    return existed;
  }

  /** True if the server name has been advertised and not torn down. */
  hasServer(serverName: string): boolean {
    return this.servers.has(serverName);
  }

  /** Snapshot of currently-registered server names. */
  registeredServers(): string[] {
    return [...this.servers];
  }

  /** Count of in-flight `mcp_message` round-trips (for tests / accounting). */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * The `SendSdkMcpMessage`-shaped callback to hand to `McpClientManager`
   * (via `addRuntimeMcpServer` with an `isSdkMcpServerConfig`-true config).
   *
   * Sends the JSON-RPC message as an outbound frame and resolves when the
   * client returns the correlated response frame.
   */
  readonly sendSdkMcpMessage = (
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> => {
    if (this.closed) {
      return Promise.reject(
        new Error(`client MCP channel is closed (server '${serverName}')`),
      );
    }
    if (!this.servers.has(serverName)) {
      return Promise.reject(
        new Error(`client MCP server '${serverName}' is not registered`),
      );
    }

    const id = `cmcp-${this.nextId++}`;

    // Notifications (no JSON-RPC `id`, e.g. `notifications/initialized`) are
    // fire-and-forget: the client-hosted server never replies. The agent's
    // transport still `await`s `send()`, so we route the frame and resolve
    // immediately with a synthetic ack — mirroring the SDK `Query` control
    // plane (`Query.ts` handleMcpMessage notification branch). Awaiting a
    // response that will never arrive would otherwise hang the handshake.
    if (!isJsonRpcRequest(message)) {
      let sendResult: void | Promise<void>;
      try {
        sendResult = this.sendFrame({ id, server: serverName, payload: message });
      } catch (err) {
        return Promise.reject(asError(err));
      }
      const ack: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 0,
        result: {},
      } as JSONRPCMessage;
      if (sendResult && typeof (sendResult as Promise<void>).then === 'function') {
        return (sendResult as Promise<void>).then(() => ack);
      }
      return Promise.resolve(ack);
    }

    return new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `client MCP server '${serverName}' did not respond within ${this.messageTimeoutMs}ms (id=${id})`,
          ),
        );
      }, this.messageTimeoutMs);
      // Don't keep the event loop alive on the timeout alone.
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(id, { resolve, reject, timer, server: serverName });

      // Put the frame on the wire. A synchronous throw or a rejected promise
      // must fail THIS request (not leak a pending entry).
      let sendResult: void | Promise<void>;
      try {
        sendResult = this.sendFrame({ id, server: serverName, payload: message });
      } catch (err) {
        this.failPending(id, asError(err));
        return;
      }
      if (sendResult && typeof (sendResult as Promise<void>).then === 'function') {
        (sendResult as Promise<void>).catch((err: unknown) => {
          this.failPending(id, asError(err));
        });
      }
    });
  };

  /**
   * Deliver a response frame from the client. Resolves the matching pending
   * request. Unknown ids are ignored (late response after timeout, or a
   * client→daemon-initiated request the daemon doesn't track — see the
   * architecture note: server→client requests are rare and out of MVP scope).
   *
   * Returns `true` if a pending request was resolved.
   */
  resolveMessage(id: string, payload: JSONRPCMessage): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      debugLogger.debug(`Dropping mcp_message with unknown id '${id}'`);
      return false;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(payload);
    return true;
  }

  /**
   * Tear the whole channel down (WS close). Rejects every pending request and
   * forgets all server names. Idempotent.
   */
  close(reason = 'client MCP channel closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.servers.clear();
    this.rejectPendingFor(() => true, new Error(reason));
  }

  private failPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingFor(
    predicate: (pending: PendingRequest) => boolean,
    error: Error,
  ): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      if (!predicate(pending)) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * A JSON-RPC message is a request (expects a response) when it carries both a
 * `method` and a non-null `id`. Responses/results have an `id` but no
 * `method`; notifications have a `method` but no `id`. Mirrors the request
 * test in the SDK `Query` control plane.
 */
function isJsonRpcRequest(message: JSONRPCMessage): boolean {
  const m = message as { method?: unknown; id?: unknown };
  return (
    typeof m.method === 'string' && m.id !== undefined && m.id !== null
  );
}
