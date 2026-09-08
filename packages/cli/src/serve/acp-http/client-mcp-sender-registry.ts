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
 *
 * Each entry remembers its OWNER (the registering connection's stable client
 * id). `delete` is ownership-scoped: a disconnecting connection only removes
 * the entry if it still owns it. Otherwise connection A's teardown could delete
 * a same-named entry that connection B re-registered after A — silently
 * breaking B's live tools.
 */
export class ClientMcpSenderRegistry {
  private readonly senders = new Map<
    string,
    { sender: WsClientMcpSender; owner: string }
  >();
  private readonly sessionSenders = new Map<
    string,
    Map<
      string,
      {
        sender: (payload: unknown) => Promise<unknown>;
        owner: string;
        registration?: object;
      }
    >
  >();
  private readonly sessionScopedServerNames = new Set<string>();

  /**
   * Record a server's WS sender, owned by `owner` (the registering
   * connection's stable client id). Idempotent; last writer wins and takes
   * ownership, so the new owner's `delete` is the one that takes effect.
   */
  set(serverName: string, sender: WsClientMcpSender, owner: string): void {
    this.senders.set(serverName, { sender, owner });
  }

  /**
   * Forget a server's WS sender — but only when `owner` still owns the entry.
   * Idempotent. The ownership guard stops a disconnecting connection from
   * clobbering an entry a later connection re-registered under the same name.
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

  setSession(
    serverName: string,
    sessionId: string,
    sender: (payload: unknown) => Promise<unknown>,
    owner: string,
    registration?: object,
  ): void {
    let bySession = this.sessionSenders.get(serverName);
    if (!bySession) {
      bySession = new Map();
      this.sessionSenders.set(serverName, bySession);
    }
    bySession.set(sessionId, { sender, owner, registration });
    this.sessionScopedServerNames.add(serverName);
  }

  ownsSession(serverName: string, sessionId: string, owner: string): boolean {
    return this.sessionSenders.get(serverName)?.get(sessionId)?.owner === owner;
  }

  /** Whether any connection currently owns a sender route for the session. */
  hasSession(serverName: string, sessionId: string): boolean {
    return this.sessionSenders.get(serverName)?.has(sessionId) === true;
  }

  deleteSession(
    serverName: string,
    sessionId: string,
    owner: string,
    registration?: object,
  ): boolean {
    const bySession = this.sessionSenders.get(serverName);
    const entry = bySession?.get(sessionId);
    if (entry?.owner !== owner) return false;
    // A registration token scopes a rollback to the registration that stored
    // it: a stale late-failing register must not delete the entry a newer
    // register of the same (server, session, connection) re-installed.
    if (registration !== undefined && entry.registration !== registration) {
      return false;
    }
    bySession!.delete(sessionId);
    if (bySession!.size === 0) {
      this.sessionSenders.delete(serverName);
      // Release the reservation too: keeping it would reject every later
      // workspace-wide registration of the name for the daemon's lifetime
      // while acking nothing, and the reservation's only purpose (blocking
      // cross-scope collisions) ends with the last session entry.
      this.sessionScopedServerNames.delete(serverName);
    }
    return true;
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
    const entry = this.senders.get(serverName);
    const sessionEntries = this.sessionSenders.get(serverName);
    if (!entry && !sessionEntries) return undefined;
    return (payload, context) => {
      if (context?.sessionId) {
        const sessionEntry = sessionEntries?.get(context.sessionId);
        if (sessionEntry) return sessionEntry.sender(payload);
        if (this.sessionScopedServerNames.has(serverName)) {
          return Promise.reject(
            new Error(
              `No session-scoped MCP sender for '${serverName}' in session '${context.sessionId}'.`,
            ),
          );
        }
      }
      if (this.sessionScopedServerNames.has(serverName)) {
        return Promise.reject(
          new Error(
            `Session-scoped MCP server '${serverName}' requires a session context.`,
          ),
        );
      }
      if (!entry) {
        return Promise.reject(
          new Error(`No client MCP sender for '${serverName}'.`),
        );
      }
      return entry.sender(
        serverName,
        payload as JSONRPCMessage,
      ) as Promise<unknown>;
    };
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
  /**
   * Session-scoped twins of the two above: add/remove a runtime MCP server in
   * ONE live session, without touching workspace bootstrap state, sibling
   * sessions, or sessions created later.
   */
  addSessionRuntimeMcpServer(
    sessionId: string,
    name: string,
    config: Record<string, unknown>,
    originatorClientId?: string,
  ): Promise<
    | { toolCount: number; [k: string]: unknown }
    | { skipped: true; reason: string; [k: string]: unknown }
  >;
  removeSessionRuntimeMcpServer(
    sessionId: string,
    name: string,
    originatorClientId?: string,
  ): Promise<unknown>;
}

/**
 * Register a client-hosted server into ONE live session. Mirrors the channel
 * worker's production sequence (`serve/channel-worker-group.ts`): record the
 * session sender, add the session-scoped runtime server, then confirm this
 * connection still owns the route.
 *
 * Session scope is what keeps a browser-connected filesystem (or any other
 * client-hosted capability) out of sibling sessions: the workspace-scoped add
 * fans out to every active session AND is copied onto every session created
 * later (`acp-integration/acpAgent.ts`), so a channel-driven or background
 * session would otherwise inherit tools that read the connecting user's
 * machine. `ClientMcpSenderRegistry.lookup` additionally hard-rejects a call
 * whose `context.sessionId` has no sender for a session-scoped name.
 */
async function registerSessionScopedClientMcpServer(
  registry: ClientMcpSenderRegistry,
  bridge: ClientMcpBridge,
  originatorClientId: string,
  serverName: string,
  sendSdkMcpMessage: WsClientMcpSender,
  sessionId: string,
): Promise<{ toolCount: number }> {
  // Identity of THIS registration attempt, so the rollback below cannot tear
  // down a newer registration of the same (server, session) on this
  // connection: register frames dispatch off-queue, so a slow add can reject
  // after a reconnect's register already re-installed the route.
  const registration = {};
  registry.setSession(
    serverName,
    sessionId,
    (payload) =>
      sendSdkMcpMessage(
        serverName,
        payload as JSONRPCMessage,
      ) as Promise<unknown>,
    originatorClientId,
    registration,
  );
  try {
    const runtimeConfig: ClientMcpOverWsRuntimeConfig = {
      type: 'sdk',
      [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
      // The user connected this server on purpose, for this session. Left
      // deferred, its tools sit behind tool_search and the agent has to guess
      // their names before it can use the bridge at all. The daemon's
      // chrome-devtools registration sets the same flag for the same reason.
      alwaysLoadTools: true,
    };
    const result = await bridge.addSessionRuntimeMcpServer(
      sessionId,
      serverName,
      runtimeConfig,
      originatorClientId,
    );
    if ((result as { skipped?: boolean }).skipped) {
      throw new Error(
        `runtime MCP add skipped: ${(result as { reason?: string }).reason ?? 'unknown'}`,
      );
    }
    // Refuse to let a browser-hosted client shadow a server the user configured
    // in settings: the runtime overlay would otherwise reroute that server's
    // discovery and tool calls back through this WS client.
    if ((result as { shadowedSettings?: boolean }).shadowedSettings) {
      throw new Error(
        `client MCP server '${serverName}' conflicts with a configured MCP server`,
      );
    }
    // A peer may have re-registered the same (server, session) while we awaited.
    if (!registry.ownsSession(serverName, sessionId, originatorClientId)) {
      // Dispose-during-add: the entry is gone entirely and our child-side add
      // just completed, so nothing else will remove the runtime server we
      // created. A peer-owned entry means the survivor's name-keyed child
      // server is the live one - leave it alone.
      if (!registry.hasSession(serverName, sessionId)) {
        await bridge
          .removeSessionRuntimeMcpServer(
            sessionId,
            serverName,
            originatorClientId,
          )
          .catch(() => {});
      }
      throw new Error(
        `client MCP registration for '${serverName}' was superseded`,
      );
    }
    return { toolCount: (result as { toolCount: number }).toolCount };
  } catch (err) {
    // Owner-scoped on purpose: only tear the child-side server down while THIS
    // connection still owns the sender route. After a supersession the peer owns
    // the live tools, and removal is keyed by name — it would kill them.
    if (
      registry.deleteSession(
        serverName,
        sessionId,
        originatorClientId,
        registration,
      )
    ) {
      await bridge
        .removeSessionRuntimeMcpServer(
          sessionId,
          serverName,
          originatorClientId,
        )
        .catch(() => {});
    }
    throw err;
  }
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
    async registerClientMcpServer(serverName, sendSdkMcpMessage, scope) {
      if (scope?.sessionId !== undefined) {
        return registerSessionScopedClientMcpServer(
          registry,
          bridge,
          originatorClientId,
          serverName,
          sendSdkMcpMessage,
          scope.sessionId,
        );
      }
      // Record the sender FIRST so the child's discovery handshake — which the
      // bridge add triggers synchronously — can route `client_mcp/message`
      // frames back to this WS. Owned by this connection's client id so a peer
      // re-registering the same name can't be deleted by our teardown.
      registry.set(serverName, sendSdkMcpMessage, originatorClientId);
      try {
        const runtimeConfig: ClientMcpOverWsRuntimeConfig = {
          // SDK-type so the child binds `SdkControlClientTransport`
          // (`isSdkMcpServerConfig`); the flag tells the child to KEEP the
          // type and bind `sendSdkMcpMessage` to the reverse ext-method.
          type: 'sdk',
          [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
        };
        const result = await bridge.addRuntimeMcpServer(
          serverName,
          runtimeConfig,
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
    async unregisterClientMcpServer(serverName, scope) {
      const sessionId = scope?.sessionId;
      if (sessionId !== undefined) {
        // Owner-scoped for the same reason as the workspace path below: a peer
        // that re-registered this (server, session) owns the live tools now.
        if (
          !registry.deleteSession(serverName, sessionId, originatorClientId)
        ) {
          return;
        }
        await bridge
          .removeSessionRuntimeMcpServer(
            sessionId,
            serverName,
            originatorClientId,
          )
          .catch(() => {});
        return;
      }
      // Only tear down if THIS connection still owns the route. A later
      // connection may have re-registered the same name (last-writer-wins), and
      // `Config.removeRuntimeMcpServer` is NOT owner-scoped — removing the
      // child server by name alone would kill the newer owner's live tools.
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
