/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Process-global MCP connection pool.
//
// One McpManager per process owns every MCP connection and shares them across
// the sessions in that process. A connection is keyed by McpServerKey (source +
// name), so a user-scope server is one connection used by all sessions while two
// projects' `.mcp.json` servers with the same name stay separate. Sessions do not
// own connections: they register the servers they want, and the manager connects
// on demand, refcounts, and tears a connection down only when its last session
// goes away (user-level servers prewarmed at startup stay for the process life).
//
// This class holds no session state and writes to no registry — it only manages
// connections and their catalogs, and reports changes to listeners (each session's
// SessionMcpManager subscribes and reacts for the keys it registered).

import { isDeepStrictEqual } from 'node:util';
import stableStringify from 'json-stable-stringify';
import type { ResourceService } from '@qwen-code/resource';
import type {
  GetPromptResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from './mcpServerConfig.js';
import type { EnvironmentSanitizationConfig } from '../services/environmentSanitization.js';
import type { DiscoveredMCPTool } from './tools/mcp-tool.js';
import {
  inferMcpTransportTelemetryType,
  MCPServerStatus,
  type McpTransportTelemetryType,
} from './client/mcpClient.js';
import { McpProgressTracker } from './client/progress.js';
import type { DiscoveredMCPPrompt } from './tools/mcp-prompt.js';
import { McpClientContext } from './mcpClientContext.js';
import type { McpElicitationHandler } from './elicitation.js';
import { runLogger } from '../utils/runLogger.js';
import { markStartupMilestone } from '../utils/startupTrace.js';
import { McpClient } from './client/mcpClient.js';
import type {
  McpClientCallMetadataProvider,
  McpClientEvent,
} from './client/types.js';
import { SdkHostedMcpConnector } from './connector/sdkHostedConnector.js';
import { withConnectorOverrides } from './connector/connectorOverrides.js';
import { resolveMcpTransportType } from './connector/transportType.js';
import type { McpConnector, McpConnectorMap } from './connector/types.js';
import type { SendMcpMessageCallback } from './connector/transport/sdk-control.js';
import { getMcpErrorMessage } from './errors.js';
import { McpSettingsGate, type McpServerGate } from './gate.js';
import { SessionMcpManager } from './sessionMcpManager/index.js';
import type {
  McpSessionContext,
  McpSessionManagerCreateOptions,
} from './sessionMcpManager/types.js';
import { mcpServerKeyId, type McpServerKey } from './server-key.js';



/** One server a session (or the startup prewarm) asks the pool to hold. */
export interface McpServerRegistration {
  readonly key: McpServerKey;
  readonly config: MCPServerConfig;
  /**
   * Directory of this server's config source; it becomes the connection's MCP
   * `roots`. User-scope servers root at the user config dir, project-scope at the
   * project cwd, and so on — the roots follow where the config actually lives.
   */
  readonly rootsDir: string;
  /** Control-protocol bridge for `sdk-hosted` servers; ignored by other transports. */
  readonly sdkBridge?: SendMcpMessageCallback;
  /** Session-owned servers only; drives elicitation capability and handling. */
  readonly elicitationHandler?: McpElicitationHandler;
}

export interface McpManagerInitOptions {
  /** User-scope servers warmed at process startup. */
  readonly userServers?: readonly McpServerRegistration[];
  readonly signal?: AbortSignal;
}

/** Reacts to a pooled connection's status or catalog change. */
export type McpManagerListener = (
  serverKey: McpServerKey,
  event: McpClientEvent,
) => void | Promise<void>;

interface PoolEntry {
  readonly client: McpClient;
  readonly key: McpServerKey;
  /** Kept so a reconnect (restart / post-auth) can rebuild the same connection. */
  readonly registration: McpServerRegistration;
  /** Prewarmed user-level servers stay for the process life; others refcount. */
  userLevel: boolean;
  refCount: number;
}

export interface McpRegistrationStats {
  readonly serverCount: number;
  readonly newConnectionCount: number;
  readonly reusedConnectionCount: number;
}

type McpConnectionOutcome = 'connected' | 'auth_required' | 'failed';

export interface McpUserServerLoadResult {
  readonly name: string;
  readonly transport: McpTransportTelemetryType;
  readonly durationMs: number;
  readonly outcome: McpConnectionOutcome;
  readonly connectionCreated: boolean;
}

function countOutcome(
  results: readonly McpUserServerLoadResult[],
  outcome: McpConnectionOutcome,
): number {
  return results.filter((result) => result.outcome === outcome).length;
}

function registrationsEqual(
  left: McpServerRegistration,
  right: McpServerRegistration,
): boolean {
  // `scope` is runtime-only source metadata: the prewarm reads the raw user
  // config while the session reads the same server after scope tagging. It
  // must not make the manager tear down and reconnect the pooled client.
  const { scope: _leftScope, ...leftConfig } = left.config;
  const { scope: _rightScope, ...rightConfig } = right.config;
  return (
    left.rootsDir === right.rootsDir &&
    left.sdkBridge === right.sdkBridge &&
    left.elicitationHandler === right.elicitationHandler &&
    isDeepStrictEqual(leftConfig, rightConfig)
  );
}

export class McpManager {
  private readonly clients = new Map<string, PoolEntry>();
  private readonly clientVersion: string;
  private readonly debugMode: boolean;
  private readonly sanitizationConfig: EnvironmentSanitizationConfig;
  private readonly sessionRegistry = new Map<string, Set<string>>();
  private readonly listeners = new Set<McpManagerListener>();
  private disposed = false;
  /**
   * Set as soon as shutdown starts, including the prewarm signal abort that
   * happens before dispose(). Queued session registrations must not dial a new
   * transport after this point.
   */
  private stopping = false;
  /** Process-level `_meta` contributor applied to every pooled connection. */
  private callMetadataProvider: McpClientCallMetadataProvider | undefined;
  private initPromise: Promise<void> | undefined;
  private prewarmPromise: Promise<void> | undefined;
  /**
   * One in-flight initialization per server key. Sessions share a pooled
   * connection, so two sessions registering the same key must await one
   * connect + discovery pass instead of racing the same McpClient.
   */
  private readonly initializationLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly resourceService: ResourceService,
    private readonly connectorMap: McpConnectorMap,
    clientVersion: string,
    debugMode: boolean,
    sanitizationConfig: EnvironmentSanitizationConfig,
  ) {
    this.clientVersion = clientVersion;
    this.debugMode = debugMode;
    this.sanitizationConfig = sanitizationConfig;
  }

  /**
   * Process startup: install product wiring and start the user-level prewarm
   * in the background. A session that registers a server awaits its per-key
   * initialization, so a slow server only delays the session using it. Settings
   * hot reload is intentionally not wired yet; user-scope changes apply on
   * restart.
   */
  init(options: McpManagerInitOptions = {}): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initImpl(options);
      void this.initPromise.then(
        () => markStartupMilestone('mcp_manager_ready'),
        () => {},
      );
    }
    return this.initPromise;
  }

  /** Override to install product auth wiring before the pool starts. */
  protected async initImpl(options: McpManagerInitOptions): Promise<void> {
    this.startUserPrewarm(options.userServers ?? [], options.signal);
  }

  private startUserPrewarm(
    servers: readonly McpServerRegistration[],
    signal?: AbortSignal,
  ): void {
    if (this.prewarmPromise) return;
    if (signal) {
      const markStopping = () => {
        this.stopping = true;
      };
      if (signal.aborted) markStopping();
      else signal.addEventListener('abort', markStopping, { once: true });
    }
    const startedAt = Date.now();
    const userServerCount = servers.length;
    runLogger.log(`[mcp-manager] init started userServers=${userServerCount}`);
    this.prewarmPromise = this.reloadUserMcpServers(servers, signal).then(
      (results) => {
        runLogger.log(
          `[mcp-manager] init completed userServers=${userServerCount} durationMs=${Date.now() - startedAt}`,
        );
        markStartupMilestone('mcp_user_servers_settled', undefined, {
          servers: results.length,
          connected: countOutcome(results, 'connected'),
          auth_required: countOutcome(results, 'auth_required'),
          failed: countOutcome(results, 'failed'),
        });
      },
      (error: unknown) => {
        runLogger.warn(
          `[mcp-manager] init failed userServers=${userServerCount} durationMs=${Date.now() - startedAt}`,
          error,
        );
        throw error;
      },
    );
    void this.prewarmPromise.catch(() => {});
  }

  /** Product-owned static configuration rules, also used before project approval. */
  validateServerConfig(_config: MCPServerConfig): void {}

  /**
   * Creates the session view over this pool. The product subclass replaces the
   * gate (and may replace the connector map) without touching the session code.
   */
  createSessionMcpManager(
    context: McpSessionContext,
    options: McpSessionManagerCreateOptions = {},
  ): SessionMcpManager {
    return new SessionMcpManager(
      context,
      this,
      this.createMcpServerGate(),
      options,
    );
  }

  /** Product sessions override this to inject a product gate. */
  protected createMcpServerGate(): McpServerGate {
    return new McpSettingsGate();
  }

  /** Resolves when {@link init} has installed its wiring. Never starts init implicitly. */
  ready(): Promise<void> {
    return this.initPromise ?? Promise.resolve();
  }

  /** Resolves when the background user-level prewarm settled. */
  whenPrewarmed(): Promise<void> {
    return this.prewarmPromise ?? Promise.resolve();
  }

  /** The process-global resource service this manager was initialized after. */
  getResourceService(): ResourceService {
    return this.resourceService;
  }

  addListener(listener: McpManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Sets the process-level `_meta` contributor applied to every tool call. */
  setCallMetadataProvider(
    provider: McpClientCallMetadataProvider | undefined,
  ): void {
    this.callMetadataProvider = provider;
    for (const entry of this.clients.values()) {
      entry.client.setCallMetadataProvider(provider);
    }
  }

  getClient(key: McpServerKey): McpClient | undefined {
    return this.clients.get(mcpServerKeyId(key))?.client;
  }

  getStatus(key: McpServerKey): MCPServerStatus {
    return (
      this.clients.get(mcpServerKeyId(key))?.client.getStatus() ??
      MCPServerStatus.DISCONNECTED
    );
  }

  /** Every pooled connection, for status views. */
  getClients(): readonly McpClient[] {
    return [...this.clients.values()].map((entry) => entry.client);
  }

  /**
   * Force a fresh connection for a pooled server (explicit restart, or a retry
   * after the user completed an authorization flow). No-op for an unknown key.
   */
  async reconnect(
    key: McpServerKey,
    allowAuthentication = true,
  ): Promise<void> {
    const id = mcpServerKeyId(key);
    const startedAt = Date.now();
    runLogger.log(`[mcp-manager] reconnect started name=${key.name}`);
    await this.runInitializationExclusive(id, async () => {
      const entry = this.clients.get(id);
      if (!entry) {
        runLogger.log(
          `[mcp-manager] reconnect skipped name=${key.name} reason=not-pooled`,
        );
        return;
      }
      await entry.client.disconnect().catch(() => {});
      await this.ensureConnectedLocked(
        entry.registration,
        entry.userLevel,
        undefined,
        allowAuthentication,
      );
    });
    runLogger.log(
      `[mcp-manager] reconnect completed name=${key.name} status=${this.getStatus(key)} durationMs=${Date.now() - startedAt}`,
    );
  }

  /**
   * Select the first stdio declaration in each config source. Sessions use
   * this on their complete eligible set before incremental reload filtering.
   * Different sources, working directories and injected owners stay separate.
   */
  filterDuplicateStdioMcpServers<T extends McpServerRegistration>(
    servers: readonly T[],
  ): T[] {
    const winners = new Map<string, string>();
    return servers.filter((server) => {
      const { key, config, rootsDir } = server;
      if (
        !(key.source.startsWith('file:') || key.source.startsWith('flag:')) ||
        resolveMcpTransportType(config) !== 'stdio'
      ) {
        return true;
      }
      // Preserve argument boundaries and ignore env key order. Absent and
      // empty env both inherit the same environment.
      const signature = stableStringify([
        key.source,
        rootsDir,
        config.cwd ?? null,
        config.command,
        config.args ?? [],
        config.env ?? {},
      ])!;
      const winner = winners.get(signature);
      if (winner !== undefined && winner !== key.name) {
        runLogger.debug(
          `[MCP] Skipping "${key.name}" — duplicate of "${winner}" (same transport signature)`,
        );
        return false;
      }
      winners.set(signature, key.name);
      return true;
    });
  }

  /**
   * Startup prewarm: eagerly connect the user-level servers. They stay pooled for
   * the whole process and are shared by every session. A server that needs
   * authorization parks in AUTH_REQUIRED rather than failing, so it can be
   * connected later once the user authenticates.
   */
  async reloadUserMcpServers(
    servers: readonly McpServerRegistration[],
    signal?: AbortSignal,
  ): Promise<readonly McpUserServerLoadResult[]> {
    const startedAt = Date.now();
    const names = servers.map((server) => server.key.name);
    runLogger.log(
      `[mcp-manager] user MCP config loading count=${servers.length}${
        names.length > 0 ? ` names=${names.join(',')}` : ''
      }`,
    );
    const uniqueServers = this.filterDuplicateStdioMcpServers(servers);
    const activeIds = new Set(
      uniqueServers.map((server) => mcpServerKeyId(server.key)),
    );
    const outcomes = await Promise.all(
      uniqueServers.map(async (server): Promise<McpUserServerLoadResult> => {
        const serverStartedAt = Date.now();
        const existing = this.clients.get(mcpServerKeyId(server.key));
        let outcome: McpConnectionOutcome = 'failed';
        try {
          const entry = await this.ensureConnected(server, true, signal);
          if (entry.client.getStatus() === MCPServerStatus.CONNECTED) {
            outcome = 'connected';
          } else if (
            entry.client.getStatus() === MCPServerStatus.AUTH_REQUIRED
          ) {
            outcome = 'auth_required';
          }
        } catch (error) {
          this.emitDiagnostic(
            'error',
            `Failed to prewarm MCP server '${server.key.name}'`,
            error,
            server.key.name,
          );
        }
        const result: McpUserServerLoadResult = {
          name: server.key.name,
          transport: inferMcpTransportTelemetryType(server.config),
          durationMs: Date.now() - serverStartedAt,
          outcome,
          connectionCreated: existing === undefined,
        };
        runLogger.log(
          `[mcp-manager] user MCP server initialized name=${result.name} transport=${result.transport} status=${result.outcome} durationMs=${result.durationMs}`,
        );
        return result;
      }),
    );
    for (const [id, entry] of this.clients) {
      if (!entry.userLevel || activeIds.has(id)) continue;
      entry.userLevel = false;
      if (entry.refCount > 0) continue;
      this.clients.delete(id);
      await entry.client.disconnect().catch(() => {});
    }
    const count = (status: McpConnectionOutcome) =>
      countOutcome(outcomes, status);
    runLogger.log(
      `[mcp-manager] user MCP config loaded count=${servers.length} connected=${count('connected')} authRequired=${count('auth_required')} failed=${count('failed')} durationMs=${Date.now() - startedAt}`,
    );
    return outcomes;
  }

  /**
   * A session starts using these servers. Connects any not yet pooled and
   * refcounts them so a connection outlives a single session that shares it.
   */
  async registerMcpServers(
    sessionId: string,
    servers: readonly McpServerRegistration[],
    allowAuthentication = true,
  ): Promise<McpRegistrationStats> {
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-manager] session register started session=${sessionId} servers=${servers.length}`,
    );
    let registered = this.sessionRegistry.get(sessionId);
    if (!registered) {
      registered = new Set<string>();
      this.sessionRegistry.set(sessionId, registered);
    }
    const owned = registered;
    const uniqueServers = this.filterDuplicateStdioMcpServers(servers);
    let newConnectionCount = 0;
    let reusedConnectionCount = 0;
    // Connections are independent; starting them together keeps one slow
    // server from delaying the rest. Per-key initialization is single-flight,
    // so a server another session is already connecting is awaited, not dialed
    // twice.
    await Promise.all(
      uniqueServers.map(async (server) => {
        const id = mcpServerKeyId(server.key);
        const serverStartedAt = Date.now();
        const existing = this.clients.get(id);
        const reused = existing?.client.isConnected() === true;
        try {
          const entry = await this.ensureConnected(
            server,
            false,
            undefined,
            allowAuthentication,
          );
          if (!owned.has(id)) {
            entry.refCount += 1;
            owned.add(id);
          }
          if (entry.client.isConnected()) {
            if (reused) reusedConnectionCount += 1;
            else newConnectionCount += 1;
          }
          runLogger.log(
            `[mcp-manager] session server registered session=${sessionId} name=${server.key.name} transport=${inferMcpTransportTelemetryType(server.config)} status=${entry.client.getStatus()} reused=${reused} durationMs=${Date.now() - serverStartedAt}`,
          );
        } catch (error) {
          this.emitDiagnostic(
            'error',
            `Failed to register MCP server '${server.key.name}'`,
            error,
            server.key.name,
          );
          runLogger.log(
            `[mcp-manager] session server registration failed session=${sessionId} name=${server.key.name} transport=${inferMcpTransportTelemetryType(server.config)} durationMs=${Date.now() - serverStartedAt}`,
          );
        }
      }),
    );
    runLogger.log(
      `[mcp-manager] session register completed session=${sessionId} servers=${servers.length} newConnections=${newConnectionCount} reusedConnections=${reusedConnectionCount} durationMs=${Date.now() - startedAt}`,
    );
    return {
      serverCount: servers.length,
      newConnectionCount,
      reusedConnectionCount,
    };
  }

  /** A session stops using these servers; disconnects any it was the last to hold. */
  async unregisterMcpServers(
    sessionId: string,
    keys: readonly McpServerKey[],
  ): Promise<void> {
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-manager] session unregister started session=${sessionId} servers=${keys.length}`,
    );
    const registered = this.sessionRegistry.get(sessionId);
    if (!registered) {
      runLogger.log(
        `[mcp-manager] session unregister skipped session=${sessionId} reason=not-registered durationMs=${Date.now() - startedAt}`,
      );
      return;
    }
    for (const key of keys) {
      const id = mcpServerKeyId(key);
      registered.delete(id);
      await this.release(id);
    }
    if (registered.size === 0) this.sessionRegistry.delete(sessionId);
    runLogger.log(
      `[mcp-manager] session unregister completed session=${sessionId} servers=${keys.length} remaining=${registered.size} durationMs=${Date.now() - startedAt}`,
    );
  }

  /** A session ends: release everything it registered. */
  async unregisterSession(sessionId: string): Promise<void> {
    const startedAt = Date.now();
    const registered = this.sessionRegistry.get(sessionId);
    if (!registered) {
      runLogger.log(
        `[mcp-manager] session unregister-all skipped session=${sessionId} reason=not-registered`,
      );
      return;
    }
    const ids = [...registered];
    runLogger.log(
      `[mcp-manager] session unregister-all started session=${sessionId} servers=${ids.length}`,
    );
    this.sessionRegistry.delete(sessionId);
    for (const id of ids) await this.release(id);
    runLogger.log(
      `[mcp-manager] session unregister-all completed session=${sessionId} servers=${ids.length} durationMs=${Date.now() - startedAt}`,
    );
  }

  // ── session-facing catalog access ────────────────────────────────────────

  async discoverTools(
    sessionId: string,
  ): Promise<readonly DiscoveredMCPTool[]> {
    const tools: DiscoveredMCPTool[] = [];
    for (const client of this.sessionClients(sessionId)) {
      tools.push(...client.getDiscoveredTools());
    }
    return tools;
  }

  async discoverPrompts(
    sessionId: string,
  ): Promise<readonly DiscoveredMCPPrompt[]> {
    const prompts: DiscoveredMCPPrompt[] = [];
    for (const client of this.sessionClients(sessionId)) {
      prompts.push(...client.getDiscoveredPrompts());
    }
    return prompts;
  }

  async discoverResources(
    sessionId: string,
  ): Promise<readonly Resource[]> {
    const resources: Resource[] = [];
    for (const client of this.sessionClients(sessionId)) {
      resources.push(...client.getDiscoveredResources());
    }
    return resources;
  }

  async getPrompt(
    serverKey: McpServerKey,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<GetPromptResult> {
    return this.requireClient(serverKey).getPrompt(name, args);
  }

  async readResource(
    serverKey: McpServerKey,
    uri: string,
  ): Promise<ReadResourceResult> {
    return this.requireClient(serverKey).getResource(uri);
  }

  async dispose(): Promise<void> {
    const startedAt = Date.now();
    const count = this.clients.size;
    runLogger.log(`[mcp-manager] dispose started clients=${count}`);
    this.stopping = true;
    this.disposed = true;
    await this.initPromise?.catch(() => {});
    await this.prewarmPromise?.catch(() => {});
    const entries = [...this.clients.values()];
    this.clients.clear();
    this.sessionRegistry.clear();
    this.listeners.clear();
    await Promise.all(
      entries.map((entry) => entry.client.disconnect().catch(() => {})),
    );
    runLogger.log(
      `[mcp-manager] dispose completed clients=${count} durationMs=${Date.now() - startedAt}`,
    );
  }

  /** In-flight connection and discovery, without starting or retrying it. */
  getPendingDiscovery(key: McpServerKey): Promise<unknown> | undefined {
    return this.initializationLocks.get(mcpServerKeyId(key));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private *sessionClients(sessionId: string): Generator<McpClient> {
    const registered = this.sessionRegistry.get(sessionId);
    if (!registered) return;
    for (const id of registered) {
      const entry = this.clients.get(id);
      if (entry) yield entry.client;
    }
  }

  private requireClient(serverKey: McpServerKey): McpClient {
    const client = this.getClient(serverKey);
    if (!client) {
      throw new Error(
        `MCP server '${serverKey.name}' (${serverKey.source}) is not in the pool`,
      );
    }
    return client;
  }

  private async release(id: string): Promise<void> {
    const entry = this.clients.get(id);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0 || entry.userLevel) return;
    this.clients.delete(id);
    try {
      await entry.client.disconnect();
    } catch (error) {
      runLogger.debug(
        `[mcp-manager] disconnect failed for '${entry.key.name}': ${getMcpErrorMessage(error)}`,
      );
    }
  }

  /**
   * Serializes initialization per server key. The first caller dials; later
   * callers wait for that attempt and then observe its result (usually a
   * CONNECTED client), so the same McpClient is never connected or discovered
   * twice concurrently.
   */
  private runInitializationExclusive<T>(
    id: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.initializationLocks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.initializationLocks.set(id, run);
    void run
      .finally(() => {
        if (this.initializationLocks.get(id) === run) {
          this.initializationLocks.delete(id);
        }
      })
      .catch(() => {});
    return run;
  }

  private createPoolEntry(
    registration: McpServerRegistration,
    userLevel: boolean,
    refCount = 0,
  ): PoolEntry {
    const client = new McpClient({
      serverKey: registration.key,
      serverName: registration.key.name,
      serverConfig: registration.config,
      clientVersion: this.clientVersion,
      debugMode: this.debugMode,
      hostContext: this.buildHostContext(registration),
      elicitationHandler: registration.elicitationHandler,
      callMetadataProvider: this.callMetadataProvider,
      listener: (event) => this.fanOut(registration.key, event),
    });
    return {
      client,
      key: registration.key,
      registration,
      userLevel,
      refCount,
    };
  }

  private ensureConnected(
    registration: McpServerRegistration,
    userLevel: boolean,
    signal?: AbortSignal,
    allowAuthentication = !userLevel,
  ): Promise<PoolEntry> {
    return this.runInitializationExclusive(
      mcpServerKeyId(registration.key),
      () =>
        this.ensureConnectedLocked(
          registration,
          userLevel,
          signal,
          allowAuthentication,
        ),
    );
  }

  private async ensureConnectedLocked(
    registration: McpServerRegistration,
    userLevel: boolean,
    signal: AbortSignal | undefined,
    allowAuthentication: boolean,
  ): Promise<PoolEntry> {
    const id = mcpServerKeyId(registration.key);
    let entry = this.clients.get(id);
    if (this.disposed || this.stopping) {
      // A session registration can be queued behind the prewarm lock and run
      // after shutdown aborts the prewarm. Do not start another transport; the
      // pooled entry (if any) is disconnected by dispose().
      if (entry) return entry;
      throw new Error('McpManager is shutting down');
    }
    if (entry && !registrationsEqual(entry.registration, registration)) {
      await entry.client.disconnect().catch(() => {});
      entry = this.createPoolEntry(
        registration,
        entry.userLevel || userLevel,
        entry.refCount,
      );
      this.clients.set(id, entry);
    } else if (!entry) {
      entry = this.createPoolEntry(registration, userLevel);
      this.clients.set(id, entry);
    } else if (userLevel) {
      entry.userLevel = true;
    }

    const client = entry.client;
    // A prewarm parks AUTH_REQUIRED instead of running the interactive flow.
    // A session registration is an explicit request to finish authentication,
    // so reset the parked client and reconnect with auth enabled.
    if (
      client.getStatus() === MCPServerStatus.AUTH_REQUIRED &&
      allowAuthentication
    ) {
      await client.disconnect().catch(() => {});
    }
    if (client.getStatus() !== MCPServerStatus.DISCONNECTED) return entry;

    const connector = this.connectorFor(registration);
    if (!connector) {
      const transportType = resolveMcpTransportType(registration.config);
      this.emitDiagnostic(
        'error',
        transportType
          ? `No connector registered for '${transportType}' MCP server '${registration.key.name}'`
          : `MCP server '${registration.key.name}' has no transport to connect`,
        undefined,
        registration.key.name,
      );
      return entry;
    }

    try {
      await client.connect(connector, {
        ...(signal ? { signal } : {}),
        allowAuthentication,
      });
    } catch (error) {
      this.emitDiagnostic(
        'error',
        `Failed to connect MCP server '${registration.key.name}'`,
        error,
        registration.key.name,
      );
      return entry;
    }
    // A server needing auth parks in AUTH_REQUIRED (connect resolved without a
    // live socket); only discover when actually connected.
    if (client.getStatus() === MCPServerStatus.CONNECTED) {
      try {
        await client.discover();
        await this.fanOut(registration.key, {
          type: 'tools',
          tools: client.getDiscoveredTools(),
        });
        await this.fanOut(registration.key, {
          type: 'prompts',
          prompts: client.getDiscoveredPrompts(),
        });
        await this.fanOut(registration.key, {
          type: 'resources',
          resources: client.getDiscoveredResources(),
        });
      } catch (error) {
        this.emitDiagnostic(
          'warning',
          `Discovery failed for MCP server '${registration.key.name}'`,
          error,
          registration.key.name,
        );
      }
    }
    return entry;
  }

  private buildHostContext(registration: McpServerRegistration): McpClientContext {
    return new McpClientContext({
      sanitizationConfig: this.sanitizationConfig,
      emitDiagnostic: (severity, message, error, serverName) =>
        this.emitDiagnostic(severity, message, error, serverName),
      // Folder trust is enforced when a session registers non-dynamic servers,
      // before they reach the pool.
      isTrustedFolder: () => true,
      getRoots: () => [registration.rootsDir],
    });
  }

  private emitDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    serverName?: string,
  ): void {
    const suffix = serverName ? ` [${serverName}]` : '';
    if (severity === 'error') {
      runLogger.error(`[mcp-manager] ${message}${suffix}`, error);
    } else if (severity === 'warning') {
      runLogger.warn(`[mcp-manager] ${message}${suffix}`, error);
    } else {
      runLogger.log(`[mcp-manager] ${message}${suffix}`, error);
    }
  }

  private connectorFor(registration: McpServerRegistration): McpConnector | undefined {
    const transportType = resolveMcpTransportType(registration.config);
    const connector: McpConnector | undefined = registration.sdkBridge
      ? new SdkHostedMcpConnector(registration.sdkBridge)
      : transportType
        ? this.connectorMap.get(transportType)
        : undefined;
    if (!connector) return undefined;

    return withConnectorOverrides(connector, {
      progressReporter:
        connector.progressReporter ??
        new McpProgressTracker(registration.key.name),
    });
  }

  private async fanOut(
    serverKey: McpServerKey,
    event: McpClientEvent,
  ): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(serverKey, event);
      } catch (error) {
        runLogger.debug(
          `[mcp-manager] listener failed for '${serverKey.name}': ${getMcpErrorMessage(error)}`,
        );
      }
    }
  }
}
