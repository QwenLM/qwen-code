/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isDeferredMcpTool,
  readDeferredToolPatterns,
  readMcpDeferThreshold,
  resolveMcpRegistration,
  type McpRegistration,
} from '../../tools/tool-exposure.js';
import { estimateTextTokens } from '../../utils/tokenCalculation.js';
import { normalizeMcpSegment } from '../tools/mcp-names.js';
import { namespaceKey } from '../../codemode/tool-search.js';
import type { McpRegistrationMode } from './types.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EventEmitter } from 'node:events';
import stableStringify from 'json-stable-stringify';
import type {
  GetPromptResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  McpPluginOwner,
  McpToolRuntimeOverride,
  MCPServerConfig,
} from '../mcpServerConfig.js';
import { createSdkMcpServerConfig } from '../mcpServerConfig.js';
import { MCPOAuthTokenStorage } from '../oauth-token-storage.js';
import type { OAuthToken } from '../token-storage/types.js';
import { Storage } from '../../config/storage.js';
import {
  buildMcpToolName,
  type DiscoveredMCPTool,
} from '../tools/mcp-tool.js';
import { McpAuthTool } from '../../tools/mcp-auth-tool.js';
import type { McpClient } from '../client/mcpClient.js';
import type { SendMcpMessageCallback } from '../connector/transport/sdk-control.js';
import type {
  McpElicitationHandler,
  McpElicitationHost,
} from '../elicitation.js';
import type { DiscoveredMCPPrompt } from '../tools/mcp-prompt.js';
import { MCPServerStatus } from '../client/mcpClient.js';
import type { LazyMcpServerSnapshot } from '../../tools/mcp-lazy/tool-list-text.js';
import { mcpModelContext } from '../tools/mcp-model-context.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import { resolveMcpRequestTimeoutMs } from '../tools/mcp-timeouts.js';
import { coreEvents } from '../../utils/events.js';
import { runLogger } from '../../utils/runLogger.js';


import {
  gateDenyMessage,
  isHostPolicyDeny,
  MCP_POLICY_BLOCKED_MESSAGE,
  type McpServerGate,
} from '../gate.js';
import {
  type McpAuthorizationAction,
  type McpAuthorizationCoordinator,
  type McpAuthorizationHost,
  type McpAuthorizationOutcome,
  type McpAuthorizationPreparation,
  McpAuthorizationPreparationError,
  type McpAuthorizationRequiredError,
  type McpServerPresentation,
  McpConfigurationError,
} from '../authorization.js';
import type { McpClientEvent } from '../client/types.js';
import type {
  McpManager,
  McpRegistrationStats,
  McpServerRegistration,
} from '../mcpManager.js';
import {
  fileMcpSourceId,
  flagMcpSourceId,
  isSessionMcpSource,
  mcpServerKey,
  mcpServerKeyId,
  pluginMcpSourceId,
  sessionMcpSourceId,
  type McpServerKey,
} from '../server-key.js';
import { MCPDiscoveryState } from './types.js';
import type {
  LazyMcpToolEntry,
  McpSessionContext,
  McpSessionManagerCreateOptions,
  SessionMcpStartupSnapshot,
} from './types.js';

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function mcpConfigFingerprint(config: MCPServerConfig): string {
  const { scope: _scope, ...rest } = config;
  return createHash('sha256')
    .update(stableStringify(rest) ?? '')
    .digest('hex')
    .slice(0, 16);
}

export type McpResourceEntry = Resource & { readonly serverName: string };

interface ServerEntry {
  readonly key: McpServerKey;
  readonly config: MCPServerConfig;
  readonly rootsDir: string;
  /** Present only for session-owned servers. */
  readonly elicitationHandler?: McpElicitationHandler;
}

export interface McpServerView {
  readonly key: McpServerKey;
  readonly name: string;
  readonly config: MCPServerConfig;
  readonly status: MCPServerStatus;
  readonly allowed: boolean;
  readonly denyMessage?: string;
  readonly hostPolicyBlocked: boolean;
}

export class SessionMcpManager {
  private entries = new Map<string, ServerEntry>();
  private activeKeys = new Map<string, McpServerKey>();
  private readonly blocked = new Map<
    string,
    { reason: string; message: string; hostPolicy: boolean }
  >();
  private keysByName = new Map<string, McpServerKey>();
  private readonly disabled = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private gateStarted = false;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly lastErrors = new Map<string, string>();
  private readonly toolListListeners = new Set<() => void>();
  private userInteracted = false;
  private authPseudoToolsEnabled = true;
  private readonly authPseudoTools = new Map<string, McpAuthTool>();
  /** SDK-hosted servers this session injected, by logical name. */
  private readonly sdkKeys = new Map<string, McpServerKey>();
  /** Plugin-contributed server key ids, by plugin id, for teardown. */
  private readonly pluginKeys = new Map<string, string[]>();
  private readonly authorizationCoordinator:
    | McpAuthorizationCoordinator
    | undefined;
  private readonly authorizationPreparations = new Map<
    string,
    Promise<McpAuthorizationPreparation>
  >();
  private readonly authorizationRecoveryGenerations = new Map<string, number>();
  private readonly authorizationInvalidationListeners = new Set<
    (name: string) => void
  >();
  private authorizationStopped = false;

  private readonly cwd: string;
  private readonly mcpConfigPaths: readonly string[];
  private readonly eventEmitter?: EventEmitter;
  private readonly elicitationHost?: McpElicitationHost;
  private lazyMode: boolean;
  private appliedRegistration: McpRegistration;
  private declaredMcpServers: ReadonlySet<string> = new Set();
  private mcpDeferralSettled = false;
  /** Last context window a request reported, so a later retry can decide without one. */
  private lastContextWindow: number | undefined;
  private discoveryPreparation: Promise<void> | undefined;
  /** Keyed by server key id: one logical name can come from several sources. */
  private readonly serverDiscoveries = new Map<
    string,
    { readonly name: string; readonly pending: Promise<unknown> }
  >();

  constructor(
    private readonly context: McpSessionContext,
    private readonly mcpManager: McpManager,
    private readonly mcpServerGate: McpServerGate,
    options: McpSessionManagerCreateOptions = {},
  ) {
    this.cwd = options.cwd ?? context.getTargetDir();
    this.mcpConfigPaths = options.mcpConfigPaths ?? [];
    this.eventEmitter = options.eventEmitter;
    this.elicitationHost = options.elicitationHost;
    this.lazyMode = options.lazyMode === true;
    this.appliedRegistration = this.registration();
    this.authorizationCoordinator = options.createAuthorizationCoordinator?.();
    runLogger.log(
      `[session-mcp] created session=${context.getSessionId()} cwd=${this.cwd} configuredServers=${Object.keys(context.getMcpServers() ?? {}).length} lazy=${this.lazyMode}`,
    );
  }

  /** Subscribe to changes in the session's injectable MCP tool set. */
  onToolListChange(listener: () => void): () => void {
    this.toolListListeners.add(listener);
    return () => {
      this.toolListListeners.delete(listener);
    };
  }

  private notifyToolListChange(): void {
    void this.context.mcpToolListChange();
    for (const listener of [...this.toolListListeners]) listener();
  }

  /**
   * Publishes the session's live connections so UI subscribers (MCP browser,
   * status line, resume) refresh. Mirrors the old manager's McpClientUpdate.
   */
  private emitClientUpdate(): void {
    if (!this.eventEmitter) return;
    const clients = new Map<string, McpClient>();
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      if (client) clients.set(key.name, client);
    }
    this.eventEmitter.emit('mcp-client-update', {
      sessionId: this.context.getSessionId(),
      clients,
    });
  }

  /** Subscribes to pool changes and registers the session's active servers. */
  async initialize(): Promise<void> {
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] initialize started session=${this.context.getSessionId()}`,
    );
    try {
      this.discoveryPreparation = (async () => {
        await this.mcpManager.ready();
        await this.mcpServerGate.initialize?.();
      })();
      await this.discoveryPreparation;
      this.discoveryPreparation = undefined;
      this.mcpServerGate.start?.(() => {
        void this.reconcileMcpGate();
      });
      this.gateStarted = true;
      this.unsubscribe = this.mcpManager.addListener((key, event) =>
        this.onPoolEvent(key, event),
      );
      await this.reloadMcpServers();
      const durationMs = Date.now() - startedAt;
      runLogger.log(
        `[session-mcp] initialize completed session=${this.context.getSessionId()} activeServers=${this.activeKeys.size} durationMs=${durationMs}`,
      );
    } catch (error) {
      this.discoveryPreparation = undefined;
      runLogger.warn(
        `[session-mcp] initialize failed session=${this.context.getSessionId()} durationMs=${Date.now() - startedAt}`,
        error,
      );
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const startedAt = Date.now();
    const activeServers = this.activeKeys.size;
    runLogger.log(
      `[session-mcp] dispose started session=${this.context.getSessionId()} activeServers=${activeServers}`,
    );
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.gateStarted) {
      this.mcpServerGate.stop?.();
      this.gateStarted = false;
    }
    this.authorizationStopped = true;
    this.authorizationCoordinator?.cancelAll();
    await this.mcpManager.unregisterSession(this.context.getSessionId());
    this.activeKeys.clear();
    runLogger.log(
      `[session-mcp] dispose completed session=${this.context.getSessionId()} activeServers=${activeServers} durationMs=${Date.now() - startedAt}`,
    );
  }

  // ── server set: merge sources → gate + enable → register with the pool ──

  async reloadMcpServers(): Promise<void> {
    const startedAt = Date.now();
    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
    const servers = this.context.getMcpServers() ?? {};
    const previousEntries = this.entries;
    const previousActiveKeys = this.activeKeys;
    runLogger.log(
      `[session-mcp] reload started session=${this.context.getSessionId()} configuredServers=${Object.keys(servers).length}`,
    );
    const nextEntries = new Map<string, ServerEntry>();
    const nextKeysByName = new Map<string, McpServerKey>();
    for (const [name, config] of Object.entries(servers)) {
      const entry = this.buildEntry(name, config);
      nextEntries.set(mcpServerKeyId(entry.key), entry);
      nextKeysByName.set(name, entry.key);
    }
    // SDK-hosted and plugin servers are adopted through their own registration
    // paths, not getMcpServers(); carry them across a reload so they survive.
    const preserved = new Set<string>();
    for (const key of this.sdkKeys.values()) preserved.add(mcpServerKeyId(key));
    for (const ids of this.pluginKeys.values()) {
      for (const id of ids) preserved.add(id);
    }
    for (const id of preserved) {
      const existing = this.entries.get(id);
      if (existing && !nextEntries.has(id)) {
        nextEntries.set(id, existing);
        nextKeysByName.set(existing.key.name, existing.key);
      }
    }

    const eligibleEntries: ServerEntry[] = [];
    this.blocked.clear();
    for (const [id, entry] of nextEntries) {
      // SDK/plugin servers were admitted at registration; don't re-gate them.
      if (preserved.has(id)) {
        eligibleEntries.push(entry);
        continue;
      }
      if (!this.context.isTrustedFolder() && entry.config.scope !== 'dynamic') {
        runLogger.log(
          `[session-mcp] server skipped name=${entry.key.name} reason=untrusted-folder`,
        );
        continue;
      }
      const decision = this.mcpServerGate.evaluate({
        config: entry.config,
        serverName: entry.key.name,
        allowList: this.context.getAllowedMcpServers() ?? [],
        excludeList: this.context.getBlockedMcpServers() ?? [],
      });
      if (!decision.allowed) {
        this.blocked.set(id, {
          reason: decision.reason,
          message: gateDenyMessage(decision),
          hostPolicy: isHostPolicyDeny(decision),
        });
        runLogger.log(
          `[session-mcp] server blocked name=${entry.key.name} reason=${decision.reason} hostPolicy=${isHostPolicyDeny(decision)}`,
        );
        continue;
      }
      if (!this.isEnabled(entry.key.name)) {
        runLogger.log(
          `[session-mcp] server skipped name=${entry.key.name} reason=disabled`,
        );
        continue;
      }
      eligibleEntries.push(entry);
    }

    // Deduplicate the complete eligible set before skipping unchanged entries.
    // Otherwise a reload could register a duplicate after omitting its winner.
    const nextActive = new Map(
      this.mcpManager
        .filterDuplicateStdioMcpServers(eligibleEntries)
        .map((entry) => [mcpServerKeyId(entry.key), entry.key]),
    );

    const registrations: McpServerRegistration[] = [];
    for (const [id, key] of nextActive) {
      // SDK/plugin servers were registered through their own paths and are
      // only preserved across reloads; re-registering them would duplicate the
      // registration cycle and lose their ownership metadata.
      if (preserved.has(id)) continue;
      const entry = nextEntries.get(id)!;
      const previous = previousEntries.get(id);
      // An unchanged server is already in the pool. Re-registering it would
      // race a still-running connect/auth flow (and start a second OAuth
      // callback on the same port) when startup reloads overlap.
      if (
        previous &&
        previousActiveKeys.has(id) &&
        previous.rootsDir === entry.rootsDir &&
        isDeepStrictEqual(previous.config, entry.config) &&
        this.mcpManager.getStatus(key) !== MCPServerStatus.DISCONNECTED
      ) {
        continue;
      }
      registrations.push({
        key,
        config: entry.config,
        rootsDir: entry.rootsDir,
        ...(entry.elicitationHandler
          ? { elicitationHandler: entry.elicitationHandler }
          : {}),
      });
    }
    const removed: McpServerKey[] = [];
    for (const [id, key] of previousActiveKeys) {
      if (!nextActive.has(id)) removed.push(key);
    }

    this.entries = nextEntries;
    this.keysByName = nextKeysByName;
    this.activeKeys = nextActive;

    if (removed.length > 0) {
      runLogger.log(
        `[session-mcp] unregister started session=${this.context.getSessionId()} servers=${removed.length} names=${removed.map((key) => key.name).join(',')}`,
      );
      await this.mcpManager.unregisterMcpServers(
        this.context.getSessionId(),
        removed,
      );
      runLogger.log(
        `[session-mcp] unregister completed session=${this.context.getSessionId()} servers=${removed.length}`,
      );
    }
    if (registrations.length > 0) {
      await this.registerWithPool('configured', registrations, removed.length);
    }
    this.discoveryState = MCPDiscoveryState.COMPLETED;
    this.publishAll();
    runLogger.log(
      `[session-mcp] reload completed session=${this.context.getSessionId()} activeServers=${this.activeKeys.size} registered=${registrations.length} removed=${removed.length} durationMs=${Date.now() - startedAt}`,
    );
  }

  private async registerWithPool(
    kind: 'configured' | 'sdk' | 'plugin' | 'dynamic',
    registrations: readonly McpServerRegistration[],
    _removedServerCount = 0,
  ): Promise<{
    durationMs: number;
    newConnectionCount: number;
    reusedConnectionCount: number;
  }> {
    if (registrations.length === 0) {
      return {
        durationMs: 0,
        newConnectionCount: 0,
        reusedConnectionCount: 0,
      };
    }
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] register started session=${this.context.getSessionId()} kind=${kind} servers=${registrations.length} names=${registrations.map((registration) => registration.key.name).join(',')}`,
    );
    let stats: McpRegistrationStats;
    try {
      const registration = this.mcpManager.registerMcpServers(
        this.context.getSessionId(),
        registrations,
        this.canAuthenticateInteractively(),
      );
      for (const { key } of registrations) {
        const pending =
          this.mcpManager.getPendingDiscovery(key) ?? registration;
        const id = mcpServerKeyId(key);
        const entry = { name: key.name, pending };
        this.serverDiscoveries.set(id, entry);
        void pending
          .finally(() => {
            if (this.serverDiscoveries.get(id) === entry) {
              this.serverDiscoveries.delete(id);
            }
            // Finishing discovery can make the deferral decision possible for
            // the first time, so retry it instead of waiting for the next
            // conversation boundary.
            this.settleMcpDeferralWhenReady();
          })
          .catch(() => {});
      }
      stats = await registration;
    } catch (error) {
      runLogger.warn(
        `[session-mcp] register failed session=${this.context.getSessionId()} kind=${kind} servers=${registrations.length} durationMs=${Date.now() - startedAt}`,
        error,
      );
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    runLogger.log(
      `[session-mcp] register completed session=${this.context.getSessionId()} kind=${kind} servers=${registrations.length} newConnections=${stats.newConnectionCount} reusedConnections=${stats.reusedConnectionCount} durationMs=${durationMs}`,
    );
    return {
      durationMs,
      newConnectionCount: stats.newConnectionCount,
      reusedConnectionCount: stats.reusedConnectionCount,
    };
  }

  private buildEntry(name: string, config: MCPServerConfig): ServerEntry {
    const cwd = this.cwd;
    const configPath = this.mcpConfigPaths[0];
    const scope = config.scope;
    if (scope === 'dynamic') {
      return {
        key: mcpServerKey(
          sessionMcpSourceId(this.context.getSessionId()),
          name,
        ),
        config,
        rootsDir: cwd,
        elicitationHandler: this.buildElicitationHandler(name),
      };
    }
    if (scope === 'user') {
      // Match the startup prewarm's key so the session reuses the pooled
      // user-level connection instead of opening a second one.
      const settingsPath = realpathOrSelf(Storage.getGlobalSettingsPath());
      return {
        key: mcpServerKey(fileMcpSourceId(settingsPath), name),
        config,
        rootsDir: dirname(settingsPath),
      };
    }
    const projectPath = configPath
      ? realpathOrSelf(configPath)
      : realpathOrSelf(cwd);
    if (scope === 'flag') {
      // `--mcp-config` / the brand-prefixed `MCP_CONFIG` env var arrive with
      // the process argv, which the daemon owns per session. The same name can
      // therefore be injected with a different endpoint or credential by
      // another session, so the pool identity includes the injected config
      // instead of only the workspace. An identical injection still shares one
      // connection.
      return {
        key: mcpServerKey(
          flagMcpSourceId(projectPath, mcpConfigFingerprint(config)),
          name,
        ),
        config,
        rootsDir: configPath ? dirname(projectPath) : cwd,
      };
    }
    // project / local / untagged all root at the session's project or the
    // first disk MCP config file visible to this session.
    return {
      key: mcpServerKey(fileMcpSourceId(projectPath), name),
      config,
      rootsDir: configPath ? dirname(projectPath) : cwd,
    };
  }

  private isEnabled(name: string): boolean {
    if (this.disabled.has(name)) return false;
    return this.context.isServerEnabled?.(name) ?? true;
  }

  /** Only an interactive surface may start a browser/consent OAuth flow. */
  private canAuthenticateInteractively(): boolean {
    return this.context.isInteractive?.() ?? false;
  }

  // ── pool events → session registries ─────────────────────────────────────

  private onPoolEvent(key: McpServerKey, event: McpClientEvent): void {
    if (!this.activeKeys.has(mcpServerKeyId(key))) return;
    switch (event.type) {
      case 'tools':
        this.notifyToolListChange();
        break;
      case 'prompts':
      case 'resources':
        break;
      case 'status':
        if (event.status === MCPServerStatus.CONNECTED) {
          this.clearAuthPseudoTool(key.name);
        } else if (event.status === MCPServerStatus.AUTH_REQUIRED) {
          const client = this.mcpManager.getClient(key);
          const authorizationError = client?.getAuthorizationRequiredError();
          const entry = this.entries.get(mcpServerKeyId(key));
          if (
            authorizationError &&
            entry &&
            this.authorizationCoordinator?.canHandle(entry.config)
          ) {
            this.registerAuthorization(
              key.name,
              entry.config,
              authorizationError,
            );
          } else {
            this.mintAuthPseudoTool(key);
          }
        }
        break;
      default:
        break;
    }
    this.emitClientUpdate();
  }

  private mintAuthPseudoTool(
    key: McpServerKey,
    configOverride?: MCPServerConfig,
  ): void {
    if (!this.authPseudoToolsEnabled) return;
    const entry = this.entries.get(mcpServerKeyId(key));
    const config = configOverride ?? entry?.config;
    const name = key.name;
    if (!config || this.authPseudoTools.has(name)) return;
    const interactive = this.context.isInteractive?.() ?? false;
    const tool = this.createAuthPseudoTool(name, config, interactive, async () => {
      // Re-attempt the connection; the connector owns the actual auth flow.
      await this.mcpManager.reconnect(key, interactive);
      this.clearAuthPseudoTool(name);
      this.notifyToolListChange();
      return this.getRealToolCount(name);
    });
    this.authPseudoTools.set(name, tool);
    runLogger.log(
      `[session-mcp] auth pseudo-tool registered session=${this.context.getSessionId()} server=${name} interactive=${interactive}`,
    );
    this.notifyToolListChange();
  }

  /** Product hook: build the auth pseudo-tool for this server. */
  protected createAuthPseudoTool(
    serverName: string,
    config: MCPServerConfig,
    interactive: boolean,
    onAuthComplete: () => Promise<number>,
  ): McpAuthTool {
    return new McpAuthTool(serverName, config, onAuthComplete, interactive);
  }

  protected getRealToolCount(serverName: string): number {
    return this.getAllDiscoveredMcpTools().filter(
      (entry) => entry.serverName === serverName && entry.source !== 'auth',
    ).length;
  }

  private clearAuthPseudoTool(name: string): void {
    if (!this.authPseudoTools.delete(name)) return;
    runLogger.log(
      `[session-mcp] auth pseudo-tool cleared session=${this.context.getSessionId()} server=${name}`,
    );
    this.notifyToolListChange();
  }

  private publishAll(): void {
    this.notifyToolListChange();
    this.emitClientUpdate();
  }

  /**
   * Per-session elicitation wiring. Only session-owned/SDK servers receive it;
   * shared plugin/disk connections never do.
   */
  private buildElicitationHandler(
    serverName: string,
  ): McpElicitationHandler | undefined {
    const host = this.elicitationHost;
    if (!host) return undefined;
    return {
      request: (params, signal, progressReporter) =>
        host.request(serverName, params, signal, progressReporter),
      complete: (elicitationId: string) =>
        host.complete(serverName, elicitationId),
    };
  }

  // ── tool registration (eager / lazy) ─────────────────────────────────────

  // ── aggregation ──────────────────────────────────────────────────────────

  /**
   * Startup diagnostics view: `active` is 0 until the server set is resolved,
   * `pending` counts active servers with a connect/discovery still in flight.
   */
  getStartupSnapshot(): SessionMcpStartupSnapshot {
    let pending = 0;
    let tools = this.authPseudoToolsEnabled ? this.authPseudoTools.size : 0;
    for (const key of this.activeKeys.values()) {
      if (this.mcpManager.getPendingDiscovery(key) !== undefined) pending += 1;
      tools += this.mcpManager.getClient(key)?.getDiscoveredTools().length ?? 0;
    }
    return { active: this.activeKeys.size, pending, tools };
  }

  getAllDiscoveredMcpTools(): readonly LazyMcpToolEntry[] {
    const out: LazyMcpToolEntry[] = [];
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      if (!client) continue;
      const serverName = key.name;
      const sdkKey = this.sdkKeys.get(serverName);
      const source =
        sdkKey && mcpServerKeyId(sdkKey) === mcpServerKeyId(key)
          ? 'sdk'
          : 'client';
      for (const tool of client.getDiscoveredTools()) {
        out.push(toLazyEntry(serverName, tool, source));
      }
    }
    // OAuth/host-authorization authenticate pseudo-tools for servers parked in
    // AUTH_REQUIRED — surfaced through the same channel so the model reaches
    // them via mcp_list/mcp_call (CLI-specific, not standard MCP).
    if (this.authPseudoToolsEnabled) {
      for (const [serverName, authTool] of this.authPseudoTools) {
        out.push({
          qualifiedName: authTool.name,
          serverName,
          toolName: 'authenticate',
          description: authTool.description ?? '',
          inputSchema: authTool.parameterSchema ?? {
            type: 'object',
            properties: {},
          },
          tool: authTool,
          alwaysLoad: false,
          source: 'auth',
        });
      }
    }
    return out;
  }

  /**
   * The exact catalog a session should inject. Lazy mode is resolved here;
   * callers register the returned tools and meta-tool flag without knowing
   * which mode produced them.
   */
  getInjectedMcpTools(): {
    readonly tools: readonly LazyMcpToolEntry[];
    readonly includeMetaTools: boolean;
  } {
    const tools = this.getAllDiscoveredMcpTools();
    return this.appliedRegistration.mode === 'lazy'
      ? {
          tools: tools.filter((entry) => entry.alwaysLoad),
          includeMetaTools: true,
        }
      : { tools, includeMetaTools: true };
  }

  /** Updates the session-owned lazy mode and re-announces the injection set. */
  setLazyMode(value: boolean): void {
    if (this.lazyMode === value) return;
    const previous = this.lazyMode;
    this.lazyMode = value;
    runLogger.log(
      `[session-mcp] lazy mode changed session=${this.context.getSessionId()} ${previous}->${value}`,
    );
    this.syncLazyMode();
  }

  getLazyDiscoveredMcpTools(): readonly LazyMcpToolEntry[] {
    const context = this.deferralContext();
    return this.getAllDiscoveredMcpTools().filter((entry) =>
      this.isReachedThroughMetaTools(entry, context),
    );
  }

  getDiscoveredMcpToolByQualifiedName(
    qualifiedName: string,
  ): LazyMcpToolEntry | undefined {
    return this.getAllDiscoveredMcpTools().find(
      (e) => e.qualifiedName === qualifiedName,
    );
  }

  getLazyDiscoveredMcpToolByQualifiedName(
    qualifiedName: string,
  ): LazyMcpToolEntry | undefined {
    const entry = this.getDiscoveredMcpToolByQualifiedName(qualifiedName);
    return entry && this.isReachedThroughMetaTools(entry) ? entry : undefined;
  }

  private isReachedThroughMetaTools(
    entry: LazyMcpToolEntry,
    context = this.deferralContext(),
  ): boolean {
    return this.appliedRegistration.mode === 'full'
      ? isDeferredMcpTool(entry.tool, context)
      : !entry.alwaysLoad;
  }

  private deferralContext() {
    return {
      patterns: readDeferredToolPatterns(this.context.getSetting?.('codeMode')),
      mcpViaCodeMode: this.appliedRegistration.mcpViaCodeMode,
      declaredMcpServers: this.declaredMcpServers,
    };
  }

  /**
   * Keeps MCP tools declared in CodeMode `on` mode when every server has been
   * discovered and their declarations fit `codeMode.mcpDeferThreshold`.
   *
   * Decides at most once per conversation so declarations stay stable for the
   * prompt cache, but only once the inputs exist: on a cold start an unknown
   * context window or unfinished discovery would otherwise lock "defer
   * everything" in for the whole conversation.
   */
  settleMcpDeferral(contextWindow: number | undefined): void {
    if (contextWindow !== undefined) this.lastContextWindow = contextWindow;
    if (this.mcpDeferralSettled) return;
    const next = this.mcpServersToDeclare(
      contextWindow ?? this.lastContextWindow,
    );
    if (next === undefined) return;
    this.mcpDeferralSettled = true;
    const current = this.declaredMcpServers;
    if (next.size === current.size && [...next].every((s) => current.has(s)))
      return;
    this.declaredMcpServers = next;
    this.reapplyRegistration();
  }

  /** Retries the decision once discovery settles, reusing the last known window. */
  private settleMcpDeferralWhenReady(): void {
    if (this.mcpDeferralSettled || this.lastContextWindow === undefined) return;
    this.settleMcpDeferral(this.lastContextWindow);
  }

  /**
   * The servers whose tools stay declared, or undefined while an input for a
   * stable decision is still missing.
   */
  private mcpServersToDeclare(
    contextWindow: number | undefined,
  ): ReadonlySet<string> | undefined {
    const codeModeSettings = this.context.getSetting?.('codeMode');
    const exposure = this.context.getCodeModeExposure?.();
    const threshold = readMcpDeferThreshold(codeModeSettings);
    // Configuration alone settles "always defer"; no context window needed.
    if (
      exposure !== 'on' ||
      threshold <= 0 ||
      !this.appliedRegistration.mcpViaCodeMode
    )
      return new Set();
    // These are missing inputs, not decisions. The discovery gate is global
    // because the estimate spans every server, so one server still connecting
    // defers the decision rather than the tools.
    if (
      contextWindow === undefined ||
      this.discoveryPreparation ||
      this.serverDiscoveries.size
    )
      return undefined;
    const budget = (contextWindow * threshold) / 100;
    const patterns = readDeferredToolPatterns(codeModeSettings);
    // Only tools the decision flips count; pinned and opted-in tools are unaffected.
    const flipped = this.getAllDiscoveredMcpTools().filter(
      (entry) =>
        isDeferredMcpTool(entry.tool, { patterns, mcpViaCodeMode: true }) &&
        !isDeferredMcpTool(entry.tool, { patterns, mcpViaCodeMode: false }),
    );
    if (!flipped.length) return new Set();
    // Approximates the declaration cost from the model-agnostic schema; it does
    // not include per-model schema rewrites or the request's tool wrapper.
    const tokens = flipped.reduce(
      (sum, entry) =>
        sum + estimateTextTokens(JSON.stringify(entry.tool.getSchema())),
      0,
    );
    const declare = tokens < budget;
    runLogger.log(
      `[CodeMode] MCP tools ${declare ? 'declared' : 'deferred'}: ${flipped.length} tools, ~${tokens} tokens, threshold ${threshold}% of ${contextWindow}.`,
    );
    return declare
      ? new Set(flipped.map((entry) => entry.serverName))
      : new Set();
  }

  /** A conversation boundary (reset, resume, rewind, compact) decides again before its next request. */
  resetMcpDeferral(): void {
    this.mcpDeferralSettled = false;
  }

  /** Model declarations depend on registration state even when no tool is re-registered. */
  private reapplyRegistration(): void {
    this.context.getToolRegistry()?.invalidateSchemaCache?.();
    this.notifyToolListChange();
  }

  private registration(): McpRegistration {
    return resolveMcpRegistration(
      this.context.getCodeModeExposure?.(),
      this.lazyMode,
    );
  }

  // ── session-facing catalog access ────────────────────────────────────────

  async discoverTools(): Promise<readonly DiscoveredMCPTool[]> {
    const startedAt = Date.now();
    const tools: DiscoveredMCPTool[] = [];
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      if (client) tools.push(...client.getDiscoveredTools());
    }
    this.notifyToolListChange();
    runLogger.log(
      `[session-mcp] tools read session=${this.context.getSessionId()} count=${tools.length} durationMs=${Date.now() - startedAt}`,
    );
    return tools;
  }

  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<GetPromptResult> {
    return this.mcpManager.getPrompt(this.requireKey(serverName), name, args);
  }

  async readResource(
    serverName: string,
    uri: string,
  ): Promise<ReadResourceResult> {
    return this.mcpManager.readResource(this.requireKey(serverName), uri);
  }

  /** Prompts discovered for one active server. */
  getPromptsByServer(serverName: string): readonly DiscoveredMCPPrompt[] {
    const key = this.keysByName.get(serverName);
    const prompts = key
      ? (this.mcpManager.getClient(key)?.getDiscoveredPrompts() ?? [])
      : [];
    runLogger.debug(
      `[session-mcp] prompts read session=${this.context.getSessionId()} server=${serverName} count=${prompts.length}`,
    );
    return prompts;
  }

  /** Resources discovered across this session's active servers. */
  getResources(): readonly McpResourceEntry[] {
    const out: McpResourceEntry[] = [];
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      if (!client) continue;
      for (const resource of client.getDiscoveredResources()) {
        out.push({ ...resource, serverName: key.name });
      }
    }
    runLogger.debug(
      `[session-mcp] resources read session=${this.context.getSessionId()} count=${out.length}`,
    );
    return out;
  }

  /** Find a resource by its `serverName:uri` identifier. */
  findResourceByUri(identifier: string): McpResourceEntry | undefined {
    const colonIndex = identifier.indexOf(':');
    if (colonIndex <= 0) return undefined;
    const serverName = identifier.substring(0, colonIndex);
    const uri = identifier.substring(colonIndex + 1);
    const found = this.getResources().find(
      (resource) => resource.serverName === serverName && resource.uri === uri,
    );
    runLogger.debug(
      `[session-mcp] resource lookup session=${this.context.getSessionId()} server=${serverName} uri=${uri} found=${found !== undefined}`,
    );
    return found;
  }

  // ── status / enable-disable ──────────────────────────────────────────────

  listMcpServers(): McpServerView[] {
    const views: McpServerView[] = [];
    for (const [id, entry] of this.entries) {
      const block = this.blocked.get(id);
      const active = this.activeKeys.has(id);
      views.push({
        key: entry.key,
        name: entry.key.name,
        config: entry.config,
        status: active
          ? this.mcpManager.getStatus(entry.key)
          : MCPServerStatus.DISCONNECTED,
        allowed: active,
        ...(block ? { denyMessage: block.message } : {}),
        hostPolicyBlocked: block?.hostPolicy ?? false,
      });
    }
    return views;
  }

  getServerStatus(name: string): MCPServerStatus {
    const key = this.keysByName.get(name);
    if (!key || !this.activeKeys.has(mcpServerKeyId(key))) {
      return MCPServerStatus.DISCONNECTED;
    }
    return this.mcpManager.getStatus(key);
  }

  canUseMcpServer(name: string): boolean {
    const key = this.keysByName.get(name);
    return key !== undefined && this.activeKeys.has(mcpServerKeyId(key));
  }

  getMcpServerDenyMessage(name: string): string | undefined {
    const key = this.keysByName.get(name);
    if (!key) return undefined;
    return this.blocked.get(mcpServerKeyId(key))?.message;
  }

  isMcpServerBlockedByHostPolicy(name: string): boolean {
    const key = this.keysByName.get(name);
    if (!key) return false;
    return this.blocked.get(mcpServerKeyId(key))?.hostPolicy ?? false;
  }

  async disableMcpServer(name: string): Promise<void> {
    runLogger.log(
      `[session-mcp] server disable session=${this.context.getSessionId()} name=${name}`,
    );
    this.disabled.add(name);
    await this.reloadMcpServers();
  }

  async enableMcpServer(name: string): Promise<void> {
    runLogger.log(
      `[session-mcp] server enable session=${this.context.getSessionId()} name=${name}`,
    );
    this.disabled.delete(name);
    await this.reloadMcpServers();
  }

  // ── consumer-facing catalog / status API ─────────────────────────────────

  getMcpServers(): Record<string, MCPServerConfig> {
    const out: Record<string, MCPServerConfig> = {};
    for (const entry of this.entries.values())
      out[entry.key.name] = entry.config;
    return out;
  }

  getClientByName(name: string): McpClient | undefined {
    const key = this.keysByName.get(name);
    return key ? this.mcpManager.getClient(key) : undefined;
  }

  getClient(name: string): McpClient | undefined {
    return this.getClientByName(name);
  }

  getMcpServerCount(): number {
    return this.entries.size;
  }

  getMcpInstructions(): string {
    return this.getConnectedServerInstructions()
      .map((entry) => entry.instructions)
      .join('\n\n');
  }

  getConnectedServerInstructions(): Array<{
    serverName: string;
    instructions: string;
  }> {
    const out: Array<{ serverName: string; instructions: string }> = [];
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      const instructions = client?.getInstructions();
      if (client?.isConnected() && instructions) {
        out.push({ serverName: key.name, instructions });
      }
    }
    return out;
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }

  getNeedsAuthServerNames(): string[] {
    const out: string[] = [];
    for (const key of this.activeKeys.values()) {
      if (this.mcpManager.getStatus(key) === MCPServerStatus.AUTH_REQUIRED) {
        out.push(key.name);
      }
    }
    return out;
  }

  getNeedsAuthServerCount(): number {
    return this.getNeedsAuthServerNames().length;
  }

  getBlockedMcpServers(): Array<{ name: string; pluginName: string }> {
    const out: Array<{ name: string; pluginName: string }> = [];
    for (const id of this.blocked.keys()) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      out.push({
        name: entry.key.name,
        pluginName: entry.config.plugin?.name ?? '',
      });
    }
    return out;
  }

  getLastError(name: string): string | undefined {
    return this.lastErrors.get(name);
  }

  getMcpServerConfigurationError(
    name: string,
  ): McpConfigurationError | undefined {
    const key = this.keysByName.get(name);
    const err = key
      ? this.mcpManager.getClient(key)?.getLastConnectError()
      : undefined;
    return err instanceof McpConfigurationError ? err : undefined;
  }

  getMcpConfigurationErrorCount(): number {
    let count = 0;
    for (const key of this.activeKeys.values()) {
      if (
        this.getMcpServerConfigurationError(key.name) &&
        !this.isMcpServerBlockedByHostPolicy(key.name)
      ) {
        count += 1;
      }
    }
    return count;
  }

  emitDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    _serverName?: string,
  ): void {
    // Info-level MCP chatter is suppressed until the user actually interacts with
    // MCP, matching the old manager's "verbose after first interaction" behavior.
    if (severity === 'info' && !this.userInteracted) return;
    coreEvents.emitFeedback(severity, message, error);
  }

  setUserInteractedWithMcp(): void {
    this.userInteracted = true;
  }

  peekLazyMode(): boolean {
    return this.appliedRegistration.mode === 'lazy';
  }

  syncLazyMode(): void {
    const next = this.registration();
    if (
      next.mode === this.appliedRegistration.mode &&
      next.mcpViaCodeMode === this.appliedRegistration.mcpViaCodeMode
    )
      return;
    this.appliedRegistration = next;
    this.reapplyRegistration();
  }

  peekAppliedRegistration(): McpRegistration {
    return {
      ...this.appliedRegistration,
      declaredMcpServers: this.declaredMcpServers,
    };
  }

  peekRegistrationMode(): McpRegistrationMode {
    if (this.peekLazyMode()) return 'lazy';
    return this.getLazyDiscoveredMcpTools().length ? 'deferred' : 'eager';
  }

  /** Wait only for the requested servers, including startup preparation. */
  async whenDiscovered(servers?: readonly string[]): Promise<void> {
    await this.discoveryPreparation?.catch(() => {});
    const key = (name: string) => namespaceKey(normalizeMcpSegment(name));
    const wanted = servers && new Set(servers.map(key));
    await Promise.all(
      [...this.serverDiscoveries.values()]
        .filter((entry) => !wanted || wanted.has(key(entry.name)))
        .map((entry) => entry.pending.catch(() => {})),
    );
  }

  getLazyMcpServerSnapshot(): LazyMcpServerSnapshot[] | null {
    const byServer = new Map<string, LazyMcpServerSnapshot>();
    for (const entry of this.getLazyDiscoveredMcpTools()) {
      let snap = byServer.get(entry.serverName);
      if (!snap) {
        snap = { serverName: entry.serverName, toolNames: [] };
        byServer.set(entry.serverName, snap);
      }
      snap.toolNames.push(entry.qualifiedName);
    }
    for (const key of this.activeKeys.values()) {
      const client = this.mcpManager.getClient(key);
      if (!client) continue;
      const snap = byServer.get(key.name);
      if (!snap) continue;
      const description = client.getServerConfig().description;
      if (description) snap.description = description;
      const instructions = client.getInstructions();
      if (instructions) snap.instructions = instructions;
    }
    return [...byServer.values()];
  }

  async prepareLazyMcpTool(
    entry: LazyMcpToolEntry,
    signal: AbortSignal,
  ): Promise<LazyMcpToolEntry> {
    if (!this.canUseMcpServer(entry.serverName)) {
      throw new Error(
        this.getMcpServerDenyMessage(entry.serverName) ??
          MCP_POLICY_BLOCKED_MESSAGE,
      );
    }
    signal.throwIfAborted();
    if (entry.source !== 'client') return entry;
    const client = this.getClientByName(entry.serverName);
    if (!client) {
      throw new Error(
        `MCP server '${entry.serverName}' is no longer available.`,
      );
    }
    const previous = lazyToolContract(entry);
    // 一个调用取消只停止自身等待，不取消其他调用共享的连接恢复。
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            'MCP connection recovery timed out.',
            'TimeoutError',
          ),
        ),
      resolveMcpRequestTimeoutMs(),
    );
    try {
      await raceWithAbortSignal(
        mcpModelContext.exit(() => client.ensureConnected()),
        AbortSignal.any([signal, deadline.signal]),
      );
    } finally {
      clearTimeout(timer);
    }
    signal.throwIfAborted();
    if (this.getClientByName(entry.serverName) !== client) {
      throw new Error(
        `MCP server '${entry.serverName}' changed during recovery. Call mcp_get before retrying.`,
      );
    }
    const current = this.getLazyDiscoveredMcpToolByQualifiedName(
      entry.qualifiedName,
    );
    if (!current) {
      throw new Error(
        `MCP tool '${entry.qualifiedName}' is no longer available after recovery.`,
      );
    }
    if (
      current.tool !== entry.tool &&
      !isDeepStrictEqual(previous, lazyToolContract(current))
    ) {
      throw new Error(
        `MCP tool '${entry.qualifiedName}' changed during recovery. Call mcp_get and request the tool again.`,
      );
    }
    return current;
  }

  async restart(): Promise<void> {
    const startedAt = Date.now();
    // A just-approved project server can be active twice: the session-owned copy
    // adopted when it was approved, plus its configured entry once the settings
    // are re-read. Reconnecting both dials the same endpoint twice, and a
    // hanging server then pays its connect timeout twice.
    const configuredNames = new Set(
      [...this.activeKeys.values()]
        .filter((key) => !isSessionMcpSource(key.source))
        .map((key) => key.name),
    );
    const restartKeys = [...this.activeKeys.values()].filter(
      (key) => !isSessionMcpSource(key.source) || !configuredNames.has(key.name),
    );
    runLogger.log(
      `[session-mcp] restart started session=${this.context.getSessionId()} servers=${restartKeys.length}`,
    );
    await Promise.all(
      restartKeys.map((key) =>
        this.mcpManager.reconnect(key, this.canAuthenticateInteractively()),
      ),
    );
    await this.reloadMcpServers();
    runLogger.log(
      `[session-mcp] restart completed session=${this.context.getSessionId()} servers=${restartKeys.length} durationMs=${Date.now() - startedAt}`,
    );
  }

  async restartServer(
    name: string,
    throwOnFailure = false,
    opts?: { preserveAuthorization?: boolean },
  ): Promise<void> {
    const key = this.keysByName.get(name);
    if (!key) {
      if (throwOnFailure) throw new Error(`Unknown MCP server '${name}'`);
      return;
    }
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] server restart session=${this.context.getSessionId()} name=${name} preserveAuthorization=${opts?.preserveAuthorization === true}`,
    );
    if (!opts?.preserveAuthorization) this.invalidateServerAuthorization(name);
    await this.mcpManager.reconnect(key, this.canAuthenticateInteractively());
    this.notifyToolListChange();
    runLogger.log(
      `[session-mcp] server restart completed session=${this.context.getSessionId()} name=${name} status=${this.mcpManager.getStatus(key)} durationMs=${Date.now() - startedAt}`,
    );
  }

  // ── SDK-hosted servers (session-injected standard pooled clients) ────────

  async registerSdkMcpClients(
    serverNames: readonly string[],
    sendMcpMessage: SendMcpMessageCallback,
    toolOverridesByServer?: Record<
      string,
      Record<string, McpToolRuntimeOverride>
    >,
  ): Promise<{ connectedServers: string[]; failedServers: string[] }> {
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] sdk register started session=${this.context.getSessionId()} servers=${serverNames.length} names=${serverNames.join(',')}`,
    );
    const rootsDir = this.context.getTargetDir();
    const regs: McpServerRegistration[] = [];
    for (const name of serverNames) {
      const config = createSdkMcpServerConfig(toolOverridesByServer?.[name]);
      const key = mcpServerKey(
        sessionMcpSourceId(this.context.getSessionId()),
        name,
      );
      const elicitationHandler = this.buildElicitationHandler(name);
      regs.push({
        key,
        config,
        rootsDir,
        sdkBridge: sendMcpMessage,
        ...(elicitationHandler ? { elicitationHandler } : {}),
      });
      this.sdkKeys.set(name, key);
      this.adoptEntry({ key, config, rootsDir, elicitationHandler });
    }
    if (regs.length > 0) {
      await this.registerWithPool('sdk', regs);
    }
    const connectedServers: string[] = [];
    const failedServers: string[] = [];
    for (const name of serverNames) {
      const key = this.sdkKeys.get(name)!;
      if (this.mcpManager.getStatus(key) === MCPServerStatus.CONNECTED) {
        connectedServers.push(name);
      } else {
        failedServers.push(name);
      }
    }
    this.publishAll();
    runLogger.log(
      `[session-mcp] sdk register completed session=${this.context.getSessionId()} connected=${connectedServers.length} failed=${failedServers.length} durationMs=${Date.now() - startedAt}`,
    );
    return { connectedServers, failedServers };
  }

  async unregisterSdkMcpClient(name: string): Promise<void> {
    const key = this.sdkKeys.get(name);
    if (!key) return;
    const startedAt = Date.now();
    this.sdkKeys.delete(name);
    await this.dropEntry(key);
    runLogger.log(
      `[session-mcp] sdk unregister completed session=${this.context.getSessionId()} name=${name} durationMs=${Date.now() - startedAt}`,
    );
  }

  hasSdkClient(name: string): boolean {
    const key = this.sdkKeys.get(name);
    return (
      key !== undefined &&
      this.mcpManager.getClient(key)?.isConnected() === true
    );
  }

  // ── plugin servers (standard pooled clients, source=plugin:<id>) ─────────

  async startPlugin(owner: McpPluginOwner): Promise<void> {
    const startedAt = Date.now();
    const servers = owner.mcpServers ?? {};
    runLogger.log(
      `[session-mcp] plugin start session=${this.context.getSessionId()} plugin=${owner.id} servers=${Object.keys(servers).length} names=${Object.keys(servers).join(',')}`,
    );
    const rootsDir = owner.path ?? this.context.getTargetDir();
    const plugin = {
      name: owner.name,
      path: owner.path,
      id: owner.id,
    };
    const regs: McpServerRegistration[] = [];
    const keyIds: string[] = [];
    for (const [name, config] of Object.entries(servers)) {
      const key = mcpServerKey(pluginMcpSourceId(owner.id), name);
      const pluginConfig: MCPServerConfig = { ...config, plugin };
      regs.push({ key, config: pluginConfig, rootsDir });
      keyIds.push(mcpServerKeyId(key));
      this.adoptEntry({ key, config: pluginConfig, rootsDir });
    }
    this.pluginKeys.set(owner.id, keyIds);
    if (regs.length > 0) {
      await this.registerWithPool('plugin', regs);
    }
    this.publishAll();
    runLogger.log(
      `[session-mcp] plugin start completed session=${this.context.getSessionId()} plugin=${owner.id} servers=${regs.length} durationMs=${Date.now() - startedAt}`,
    );
  }

  async stopPlugin(owner: McpPluginOwner): Promise<void> {
    const keyIds = this.pluginKeys.get(owner.id);
    if (!keyIds) return;
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] plugin stop started session=${this.context.getSessionId()} plugin=${owner.id} servers=${keyIds.length}`,
    );
    this.pluginKeys.delete(owner.id);
    for (const id of keyIds) {
      const entry = this.entries.get(id);
      if (entry) await this.dropEntry(entry.key);
    }
    runLogger.log(
      `[session-mcp] plugin stop completed session=${this.context.getSessionId()} plugin=${owner.id} servers=${keyIds.length} durationMs=${Date.now() - startedAt}`,
    );
  }

  setAuthPseudoToolsEnabled(enabled: boolean): void {
    this.authPseudoToolsEnabled = enabled;
    if (enabled) return;
    this.authPseudoTools.clear();
    this.notifyToolListChange();
  }

  /**
   * Ad-hoc server (e.g. an agent's inline frontmatter server, or a just-approved
   * project server). Registers it with the pool and, when `registries` is given,
   * publishes its catalog there (subagent registries) instead of the session's
   * main registries.
   */
  async maybeDiscoverMcpServer(
    name: string,
    config: MCPServerConfig,
    throwOnFailure = false,
  ): Promise<void> {
    const startedAt = Date.now();
    const rootsDir = this.context.getTargetDir();
    // Agent-inline servers are owned by this session, so they keep elicitation
    // and must not collide with a same-named disk/plugin server.
    const key = mcpServerKey(
      sessionMcpSourceId(this.context.getSessionId()),
      name,
    );
    runLogger.log(
      `[session-mcp] dynamic register started session=${this.context.getSessionId()} name=${name} transport=${config.type ?? (config.command ? 'stdio' : 'http')}`,
    );
    try {
      const elicitationHandler = this.buildElicitationHandler(name);
      await this.registerWithPool('dynamic', [
        { key, config, rootsDir, elicitationHandler },
      ]);
      this.adoptEntry({ key, config, rootsDir, elicitationHandler });
      this.notifyToolListChange();
      runLogger.log(
        `[session-mcp] dynamic register completed session=${this.context.getSessionId()} name=${name} status=${this.mcpManager.getStatus(key)} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      if (throwOnFailure) throw error;
      this.lastErrors.set(name, String(error));
      runLogger.warn(
        `[session-mcp] dynamic register failed session=${this.context.getSessionId()} name=${name} durationMs=${Date.now() - startedAt}`,
        error,
      );
    }
  }

  /** The catalog a caller can publish into its own (e.g. subagent) registries. */
  getServerCatalog(name: string):
    | {
        tools: readonly DiscoveredMCPTool[];
        prompts: readonly DiscoveredMCPPrompt[];
        resources: readonly Resource[];
      }
    | undefined {
    const key = this.keysByName.get(name);
    const client = key ? this.mcpManager.getClient(key) : undefined;
    if (!client) return undefined;
    const tools = client.getDiscoveredTools();
    const prompts = client.getDiscoveredPrompts();
    const resources = client.getDiscoveredResources();
    runLogger.debug(
      `[session-mcp] server catalog read session=${this.context.getSessionId()} server=${name} tools=${tools.length} prompts=${prompts.length} resources=${resources.length}`,
    );
    return {
      tools,
      prompts,
      resources,
    };
  }

  // ── compatibility surface for the session MCP wiring ─────────────────────

  /** Re-evaluate the gate for every server after a policy/settings change. */
  async reconcileMcpGate(): Promise<void> {
    await this.reloadMcpServers();
  }

  /** The session's servers are loaded from the context; alias for the reload. */
  async startConfiguredMcpServers(): Promise<void> {
    await this.reloadMcpServers();
  }

  /** Registries come from the session context, so there is nothing to attach. */
  setMainRegistries(_registries: unknown): void {}

  /** Drop every live connection's socket (e.g. an explicit global refresh). */
  abortAll(): void {
    for (const key of this.activeKeys.values()) {
      this.mcpManager.getClient(key)?.abortConnection('abortAll');
    }
  }

  /**
   * Subagent registry teardown. Pooled catalogs are re-published on the next
   * reload; a per-agent registry set is owned and dropped by its creator.
   */
  // Host-brokered authorization (injected coordinator). The connector performs
  // the transport handshake; the session side coordinates the browser
  // lifecycle the UI drives (prepare → action → authorize → reconnect).
  getMcpAuthorizationAction(name: string): McpAuthorizationAction | undefined {
    return this.authorizationCoordinator?.getAction(name);
  }

  authorizeMcpServer(
    name: string,
    host: McpAuthorizationHost,
  ): Promise<McpAuthorizationOutcome> {
    if (!this.authorizationCoordinator) {
      throw new McpAuthorizationPreparationError('unavailable');
    }
    return this.authorizationCoordinator.authorize(name, host);
  }

  onServerAuthorizationInvalidated(
    listener: (name: string) => void,
  ): () => void {
    this.authorizationInvalidationListeners.add(listener);
    return () => {
      this.authorizationInvalidationListeners.delete(listener);
    };
  }

  /**
   * Persist an out-of-band OAuth token for a locally authenticated server.
   * Returns `host-owned` when the host coordinator controls this server's
   * authorization, so the caller must not write a local credential.
   */
  async storeAuthorizationToken(
    serverName: string,
    token: OAuthToken,
    config?: MCPServerConfig,
  ): Promise<'stored' | 'host-owned'> {
    const serverConfig = config ?? this.getMcpServers()[serverName];
    if (!serverConfig) {
      throw new Error(`unknown MCP server "${serverName}"`);
    }
    if (this.authorizationCoordinator?.canHandle(serverConfig)) {
      return 'host-owned';
    }

    const storage = MCPOAuthTokenStorage.forServer(serverName, serverConfig);
    const existing = await storage.getCredentials(serverName);
    await storage.saveToken(
      serverName,
      token,
      serverConfig.oauth?.clientId ?? existing?.clientId,
      serverConfig.oauth?.tokenUrl ?? existing?.tokenUrl,
      serverConfig.httpUrl ?? serverConfig.url,
      serverConfig.oauth?.resource ?? existing?.resource,
    );

    if (this.getMcpServers()[serverName]) {
      try {
        await this.restartServer(serverName);
      } catch (error) {
        runLogger.warn(
          `[session-mcp] token stored for "${serverName}" but reconnect failed`,
          error,
        );
      }
    }
    return 'stored';
  }

  /**
   * Delete locally stored OAuth credentials. Returns `host-owned` when the
   * host coordinator controls this server's authorization.
   */
  async clearAuthorization(
    serverName: string,
    config?: MCPServerConfig,
  ): Promise<'cleared' | 'host-owned'> {
    const serverConfig = config ?? this.getMcpServers()[serverName];
    if (serverConfig && this.authorizationCoordinator?.canHandle(serverConfig)) {
      return 'host-owned';
    }

    if (serverConfig) {
      await MCPOAuthTokenStorage.forServer(
        serverName,
        serverConfig,
      ).deleteCredentials(serverName);
    } else {
      // The server is already gone from the session: its identity is unknown,
      // so everything stored under the name goes.
      await MCPOAuthTokenStorage.deleteCredentialsByServerName(serverName);
    }

    if (this.getMcpServers()[serverName]) {
      try {
        await this.restartServer(serverName);
      } catch (error) {
        runLogger.warn(
          `[session-mcp] credentials cleared for "${serverName}" but reconnect failed`,
          error,
        );
      }
    }
    return 'cleared';
  }

  /** Static config validation owned by the coordinator for this server. */
  validateMcpServerConfig(config: MCPServerConfig): void {
    this.authorizationCoordinator?.validateServerConfig?.(config);
  }

  /** Host UI presentation for a brokered server, or undefined for direct ones. */
  getMcpServerPresentation(
    config: MCPServerConfig,
  ): McpServerPresentation | undefined {
    return this.authorizationCoordinator?.getServerPresentation?.(config);
  }

  prepareMcpAuthorization(name: string): Promise<McpAuthorizationPreparation> {
    const existing = this.authorizationPreparations.get(name);
    if (existing) return existing;
    const key = this.keysByName.get(name);
    const config = key
      ? this.entries.get(mcpServerKeyId(key))?.config
      : undefined;
    const promise = (async (): Promise<McpAuthorizationPreparation> => {
      if (!key || !config) {
        throw new McpAuthorizationPreparationError('unavailable');
      }
      if (!this.authorizationCoordinator?.canHandle(config)) {
        throw new McpAuthorizationPreparationError('unsupported');
      }
      if (this.authorizationStopped || !this.canUseMcpServer(name)) {
        throw new McpAuthorizationPreparationError('unavailable');
      }
      const action = this.getMcpAuthorizationAction(name);
      if (action && action.expiresAtMs > Date.now()) {
        return { kind: 'action', action };
      }
      this.authorizationCoordinator?.cancelServer(name);
      const generation =
        (this.authorizationRecoveryGenerations.get(name) ?? 0) + 1;
      this.authorizationRecoveryGenerations.set(name, generation);
      // Reconnect: the connector re-attempts; if still unauthorized the client
      // re-parks in AUTH_REQUIRED and re-registers a fresh action via the event.
      await this.mcpManager.reconnect(key);
      const freshAction = this.getMcpAuthorizationAction(name);
      if (
        freshAction &&
        freshAction.expiresAtMs > Date.now() &&
        freshAction.authorizationRequestId !== action?.authorizationRequestId
      ) {
        return { kind: 'action', action: freshAction };
      }
      if (
        !freshAction &&
        this.mcpManager.getStatus(key) === MCPServerStatus.CONNECTED
      ) {
        return { kind: 'connected' };
      }
      throw new McpAuthorizationPreparationError('resolve_failed');
    })().finally(() => {
      if (this.authorizationPreparations.get(name) === promise) {
        this.authorizationPreparations.delete(name);
      }
    });
    this.authorizationPreparations.set(name, promise);
    return promise;
  }

  private registerAuthorization(
    name: string,
    config: MCPServerConfig,
    error: McpAuthorizationRequiredError,
  ): void {
    if (this.authorizationStopped || !this.authorizationCoordinator) return;
    const generation =
      (this.authorizationRecoveryGenerations.get(name) ?? 0) + 1;
    this.authorizationRecoveryGenerations.set(name, generation);
    this.authorizationCoordinator.registerAction(
      name,
      error.action,
      async () => {
        if (this.authorizationRecoveryGenerations.get(name) !== generation)
          return;
        const key = this.keysByName.get(name);
        if (key) await this.mcpManager.reconnect(key);
      },
    );
    this.mintAuthPseudoTool(
      this.keysByName.get(name) ?? mcpServerKey('sdk', name),
      config,
    );
  }

  private invalidateServerAuthorization(name: string): void {
    this.authorizationPreparations.delete(name);
    this.authorizationRecoveryGenerations.set(
      name,
      (this.authorizationRecoveryGenerations.get(name) ?? 0) + 1,
    );
    this.authorizationCoordinator?.cancelServer(name);
    for (const listener of this.authorizationInvalidationListeners) {
      listener(name);
    }
  }

  private adoptEntry(entry: ServerEntry): void {
    const id = mcpServerKeyId(entry.key);
    this.entries.set(id, entry);
    this.keysByName.set(entry.key.name, entry.key);
    this.activeKeys.set(id, entry.key);
  }

  private async dropEntry(key: McpServerKey): Promise<void> {
    const id = mcpServerKeyId(key);
    const startedAt = Date.now();
    this.activeKeys.delete(id);
    this.entries.delete(id);
    this.keysByName.delete(key.name);
    await this.mcpManager.unregisterMcpServers(this.context.getSessionId(), [
      key,
    ]);
    this.notifyToolListChange();
    runLogger.log(
      `[session-mcp] server unregistered session=${this.context.getSessionId()} name=${key.name} durationMs=${Date.now() - startedAt}`,
    );
  }

  serverNameToServerKey(name: string): McpServerKey | undefined {
    return this.keysByName.get(name);
  }

  private requireKey(serverName: string): McpServerKey {
    const key = this.keysByName.get(serverName);
    if (!key) throw new Error(`Unknown MCP server '${serverName}'`);
    return key;
  }
}

function lazyToolContract(entry: LazyMcpToolEntry) {
  const tool = entry.tool;
  return {
    name: entry.qualifiedName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    alwaysLoad: entry.alwaysLoad,
    readOnly: tool.isReadOnly,
    destructive: tool.isDestructive(),
    openWorld: tool.isOpenWorld(),
  };
}

function toLazyEntry(
  serverName: string,
  tool: DiscoveredMCPTool,
  source: 'client' | 'sdk',
): LazyMcpToolEntry {
  return {
    qualifiedName: buildMcpToolName(serverName, tool.serverToolName),
    serverName,
    toolName: tool.serverToolName,
    description: tool.description ?? '',
    inputSchema: tool.parameterSchema,
    tool,
    alwaysLoad: tool.alwaysLoad,
    source,
  };
}
