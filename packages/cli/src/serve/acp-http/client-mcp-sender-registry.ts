/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reverse tool channel — parent-side sender registry + provider (issue #5626,
 * Phase 2).
 *
 * The daemon WS (parent process) holds a per-connection `ClientMcpRegistrar`
 * that carries `mcp_message` JSON-RPC frames down to the extension. But the
 * agent's `McpClientManager` — where the matching `sendSdkMcpMessage` binds —
 * runs in the `qwen --acp` CHILD process. The child reaches back up via the
 * `qwen/control/client_mcp/message` ext-method, which `BridgeClient.extMethod`
 * answers by looking up a sender for the named server.
 *
 * This module is the glue:
 *   - `ClientMcpSenderRegistry` is the process-scoped map `serverName →
 *     sendSdkMcpMessage` shared between the bridge (`clientMcpSender` option)
 *     and the WS provider (below). The serve layer creates ONE per daemon.
 *   - `createClientMcpServerProvider` builds the `ClientMcpServerProvider` the
 *     WS connection injects. On `mcp_register` it (1) records the WS
 *     registrar's `sendSdkMcpMessage` in the registry, then (2) asks the bridge
 *     to add an SDK-type runtime MCP server in the child. The child's manager
 *     spawns an `SdkControlClientTransport` whose `sendMcpMessage` is the
 *     session-scoped `client_mcp/message` ext-method — which the bridge routes
 *     back through the registry to the WS. Tool discovery happens entirely
 *     inside that handshake; the returned `toolCount` is what the child
 *     reported.
 *
 * Wire (full round-trip):
 *   extension --WS--> daemon: mcp_register{server}
 *   provider: registry.set(server, wsRegistrar.sendSdkMcpMessage)
 *   provider: bridge.addRuntimeMcpServer(server, {type:'sdk', __clientMcpOverWs}, clientId)
 *     -> parent->child ext: workspaceMcpRuntimeAdd
 *     -> child: addRuntimeMcpServer(sdk-type) -> SdkControlClientTransport
 *     -> child agent runs MCP initialize/tools/list:
 *          child: sendSdkMcpMessage(server, jsonrpc)
 *          -> child->parent ext: client_mcp/message{server, payload}
 *          -> BridgeClient.extMethod -> registry.get(server) -> wsRegistrar
 *          -> daemon --WS--> extension: mcp_message{id, server, payload}
 *          -> extension --WS--> daemon: mcp_message{id, payload: result}
 *          -> wsRegistrar.resolveMessage -> ext result -> child agent
 *     -> child returns toolCount -> provider acks `mcp_registered`
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ClientMcpMessageSender } from '@qwen-code/acp-bridge/bridgeOptions';
import { CLIENT_MCP_OVER_WS_CONFIG_FLAG } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ClientMcpServerProvider } from './client-mcp-ws.js';

/** The `sendSdkMcpMessage`-shaped callback a WS connection registers. */
export type WsClientMcpSender = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

/**
 * Process-scoped registry mapping an advertised client-hosted MCP server name
 * to the WS connection's `sendSdkMcpMessage`. One instance per daemon, shared
 * by the bridge (read side, via {@link ClientMcpSenderRegistry.lookup}) and the
 * WS provider (write side).
 *
 * Server names are unique per daemon: the WS layer rejects a second
 * `mcp_register` for a name on the same connection (`already_registered`), and
 * the bridge's `addRuntimeMcpServer` reconciles a cross-connection collision by
 * replacing the runtime server. `set` therefore last-writer-wins; the matching
 * `addRuntimeMcpServer` already tore down the prior server's transport.
 */
export class ClientMcpSenderRegistry {
  private readonly senders = new Map<string, WsClientMcpSender>();

  /** Record a server's WS sender. Idempotent (last writer wins). */
  set(serverName: string, sender: WsClientMcpSender): void {
    this.senders.set(serverName, sender);
  }

  /** Forget a server's WS sender. Idempotent. */
  delete(serverName: string): void {
    this.senders.delete(serverName);
  }

  /** Currently-registered server names (tests / accounting). */
  serverNames(): string[] {
    return [...this.senders.keys()];
  }

  /**
   * The {@link ClientMcpMessageSender} the bridge consumes. Returns a
   * `(payload) => Promise<payload>` bound to the named server, or `undefined`
   * when no client currently hosts it. The bridge passes a `JSONRPCMessage` as
   * `payload`; we keep the public type `unknown` to match the bridge's
   * SDK-free contract.
   */
  readonly lookup: ClientMcpMessageSender = (serverName: string) => {
    const sender = this.senders.get(serverName);
    if (!sender) return undefined;
    return (payload: unknown) =>
      sender(serverName, payload as JSONRPCMessage) as Promise<unknown>;
  };
}

/**
 * Minimal slice of the bridge the provider needs: add / remove a runtime MCP
 * server in the live ACP child. Mirrors `HttpAcpBridge.addRuntimeMcpServer` /
 * `removeRuntimeMcpServer` so the provider stays decoupled from the full
 * bridge surface (and easy to fake in tests).
 */
export interface ClientMcpBridge {
  addRuntimeMcpServer(
    name: string,
    config: Record<string, unknown>,
    originatorClientId: string,
  ): Promise<
    | { toolCount: number; [k: string]: unknown }
    | { skipped: true; reason: string; [k: string]: unknown }
  >;
  removeRuntimeMcpServer(
    name: string,
    originatorClientId: string,
  ): Promise<unknown>;
}

/**
 * Build the `ClientMcpServerProvider` the WS connection injects. Wires the
 * per-connection registrar's sender into the shared registry and drives the
 * child-side runtime MCP add/remove through the bridge.
 *
 * @param registry shared process-scoped sender registry (also passed to the
 *        bridge as `clientMcpSender`).
 * @param bridge the live ACP bridge (add/remove runtime MCP server).
 * @param originatorClientId stable client id for this WS connection — used as
 *        the runtime-MCP mutation originator (audit / event attribution).
 */
export function createClientMcpServerProvider(
  registry: ClientMcpSenderRegistry,
  bridge: ClientMcpBridge,
  originatorClientId: string,
): ClientMcpServerProvider {
  return {
    async registerClientMcpServer(serverName, sendSdkMcpMessage) {
      // Record the sender FIRST so the child's discovery handshake — which the
      // bridge add triggers synchronously — can route `client_mcp/message`
      // frames back to this WS.
      registry.set(serverName, sendSdkMcpMessage);
      try {
        const result = await bridge.addRuntimeMcpServer(
          serverName,
          {
            // SDK-type so the child binds `SdkControlClientTransport`
            // (`isSdkMcpServerConfig`); the flag tells the child to KEEP the
            // type and bind `sendSdkMcpMessage` to the reverse ext-method.
            type: 'sdk',
            [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
          },
          originatorClientId,
        );
        if ((result as { skipped?: boolean }).skipped) {
          registry.delete(serverName);
          throw new Error(
            `runtime MCP add skipped: ${(result as { reason?: string }).reason ?? 'unknown'}`,
          );
        }
        return { toolCount: (result as { toolCount: number }).toolCount };
      } catch (err) {
        // Roll back the sender on any failure so a half-registered name can't
        // leak a dangling route.
        registry.delete(serverName);
        throw err;
      }
    },
    async unregisterClientMcpServer(serverName) {
      registry.delete(serverName);
      // Best-effort: drop the child-side runtime server too. Idempotent on the
      // bridge (`not_present` skip).
      await bridge
        .removeRuntimeMcpServer(serverName, originatorClientId)
        .catch(() => {});
    },
  };
}
