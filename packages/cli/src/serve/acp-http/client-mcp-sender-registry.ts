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
 *   provider: registry.claim(server, wsRegistrar.sendSdkMcpMessage)
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
import {
  CLIENT_MCP_OVER_WS_CONFIG_FLAG,
  type ClientMcpOverWsRuntimeConfig,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { ClientMcpServerProvider } from './client-mcp-ws.js';

/** The `sendSdkMcpMessage`-shaped callback a WS connection registers. */
export type WsClientMcpSender = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

function runtimeConfig(): ClientMcpOverWsRuntimeConfig {
  return {
    type: 'sdk',
    [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
  };
}

/**
 * Process-scoped registry mapping an advertised client-hosted MCP server name
 * to the WS connection's `sendSdkMcpMessage`. One instance per daemon, shared
 * by the bridge (read side, via {@link ClientMcpSenderRegistry.lookup}) and the
 * WS provider (write side).
 *
 * Server names are unique per daemon. The WS layer rejects a second
 * `mcp_register` on the same connection, and `claim` rejects a duplicate from
 * another connection before either registration can mutate the ACP child.
 *
 * Each entry remembers its OWNER (the registering connection's stable client
 * id). `delete` is ownership-scoped so one connection cannot remove another
 * connection's live tools.
 */
export class ClientMcpSenderRegistry {
  private readonly senders = new Map<
    string,
    { sender: WsClientMcpSender; owner: string }
  >();

  /**
   * Atomically reserve a server name for one WS connection.
   */
  claim(serverName: string, sender: WsClientMcpSender, owner: string): boolean {
    if (this.senders.has(serverName)) return false;
    this.senders.set(serverName, { sender, owner });
    return true;
  }

  /**
   * Forget a server's WS sender — but only when `owner` still owns the entry.
   * Idempotent. The ownership guard stops a connection from clobbering a
   * same-named entry owned by a peer.
   */
  delete(serverName: string, owner: string): void {
    if (this.senders.get(serverName)?.owner === owner) {
      this.senders.delete(serverName);
    }
  }

  /** Whether `owner` currently owns the entry for `serverName`. */
  owns(serverName: string, owner: string): boolean {
    return this.senders.get(serverName)?.owner === owner;
  }

  /** Currently-registered server names (tests / accounting). */
  serverNames(): string[] {
    return [...this.senders.keys()];
  }

  runtimeRegistrations(): Array<{
    name: string;
    config: Record<string, unknown>;
    originatorClientId: string;
  }> {
    return [...this.senders].map(([name, { owner }]) => ({
      name,
      config: runtimeConfig(),
      originatorClientId: owner,
    }));
  }

  /**
   * The {@link ClientMcpMessageSender} the bridge consumes. Returns a
   * `(payload) => Promise<payload>` bound to the named server, or `undefined`
   * when no client currently hosts it. The bridge passes a `JSONRPCMessage` as
   * `payload`; we keep the public type `unknown` to match the bridge's
   * SDK-free contract.
   */
  readonly lookup: ClientMcpMessageSender = (serverName: string) => {
    const entry = this.senders.get(serverName);
    if (!entry) return undefined;
    return (payload: unknown) =>
      entry.sender(serverName, payload as JSONRPCMessage) as Promise<unknown>;
  };
}

/**
 * Minimal slice of the bridge the provider needs: add / remove a runtime MCP
 * server in the live ACP child. Mirrors `HttpAcpBridge.addRuntimeMcpServer` /
 * `removeRuntimeMcpServer` so the provider stays decoupled from the full
 * bridge surface (and easy to fake in tests).
 */
export interface ClientMcpBridge {
  preheat(): Promise<void>;
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
      // A browser extension can connect before the daemon's ACP child is warm.
      // Runtime MCP mutation requires that live channel, so establish it here
      // instead of relying on a Web Shell request to race ahead of registration.
      await bridge.preheat();
      // Record the sender FIRST so the child's discovery handshake — which the
      // bridge add triggers synchronously — can route `client_mcp/message`
      // frames back to this WS. The atomic claim also prevents concurrent
      // connections from mutating the same child-side runtime server.
      if (!registry.claim(serverName, sendSdkMcpMessage, originatorClientId)) {
        throw new Error(
          `client MCP server '${serverName}' is already registered`,
        );
      }
      try {
        const result = await bridge.addRuntimeMcpServer(
          serverName,
          runtimeConfig(),
          originatorClientId,
        );
        if ((result as { skipped?: boolean }).skipped) {
          registry.delete(serverName, originatorClientId);
          throw new Error(
            `runtime MCP add skipped: ${(result as { reason?: string }).reason ?? 'unknown'}`,
          );
        }
        // Refuse to let a browser-hosted client shadow a server the user
        // configured in settings: the runtime overlay would otherwise reroute
        // that server's discovery and tool calls back through this WS client.
        // Roll back the child-side add (the catch below drops the sender route).
        if ((result as { shadowedSettings?: boolean }).shadowedSettings) {
          await bridge
            .removeRuntimeMcpServer(serverName, originatorClientId)
            .catch(() => {});
          throw new Error(
            `client MCP server '${serverName}' conflicts with a configured MCP server`,
          );
        }
        return { toolCount: (result as { toolCount: number }).toolCount };
      } catch (err) {
        // Roll back the sender on any failure so a half-registered name can't
        // leak a dangling route.
        registry.delete(serverName, originatorClientId);
        throw err;
      }
    },
    async unregisterClientMcpServer(serverName) {
      // Only tear down if THIS connection still owns the route.
      if (!registry.owns(serverName, originatorClientId)) return;
      registry.delete(serverName, originatorClientId);
      // Best-effort: drop the child-side runtime server too. Idempotent on the
      // bridge (`not_present` skip).
      await bridge
        .removeRuntimeMcpServer(serverName, originatorClientId)
        .catch(() => {});
    },
  };
}
