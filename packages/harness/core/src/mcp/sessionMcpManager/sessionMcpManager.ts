/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isDeferredMcpTool,
  readDeferredToolPatterns,
  resolveMcpRegistration,
  type McpRegistration,
} from '../../tools/tool-exposure.js';
import { normalizeMcpSegment } from '../tools/mcp-names.js';
import { namespaceKey } from '../../codemode/tool-search.js';
import type { McpRegistrationMode } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withoutMcpRuntimeMetadata } from '../mcpServerConfig.js';
import type { EventEmitter } from 'node:events';
import stableStringify from 'json-stable-stringify';
import type {
  GetPromptResult,
  ListResourcesResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/client';
import type {
  McpPluginOwner,
  McpToolRuntimeOverride,
  MCPServerConfig,
} from '../mcpServerConfig.js';
import { createSdkMcpServerConfig } from '../mcpServerConfig.js';
import { MCPOAuthTokenStorage } from '../oauth-token-storage.js';
import {
  registerMcpOAuthOpener,
  unregisterMcpOAuthOpener,
} from '../oauthOpenerRegistry.js';
import {
  MCPOAuthProvider,
  type McpOAuthBrowserOpenResult,
} from '../connector/oauth/provider.js';
import type { OAuthToken } from '../token-storage/types.js';
import { Storage } from '../../config/storage.js';
import {
  isManagedResourceLocked,
  isManagedMcpEnabled,
} from '../../config/managedResources.js';
import { buildMcpToolName, type DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { McpAuthTool } from '../../tools/mcp-auth-tool.js';
import type {
  CallToolParams,
  McpCallToolResult,
  McpClient,
} from '../client/mcpClient.js';
import type { SendMcpMessageCallback } from '../connector/transport/sdk-control.js';
import type {
  McpElicitationHandler,
  McpElicitationHost,
} from '../elicitation.js';
import type { DiscoveredMCPPrompt } from '../tools/mcp-prompt.js';
import { MCPServerStatus } from '../client/mcpClient.js';
import { getMcpErrorMessage } from '../errors.js';
import type { LazyMcpServerSnapshot } from '../../tools/mcp-lazy/tool-list-text.js';
import { coreEvents } from '../../utils/events.js';
import { runLogger } from '../../utils/runLogger.js';

import {
  gateDenyMessage,
  isHostPolicyDeny,
  MCP_POLICY_BLOCKED_MESSAGE,
  type McpGateDecision,
  type McpServerGate,
} from '../gate.js';
import {
  type McpAuthorizationAction,
  type McpAuthorizationCoordinator,
  type McpAuthorizationHost,
  type McpAuthorizationOutcome,
  type McpAuthorizationPreparation,
  type McpAuthorizationState,
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
import { pluginMcpRegistrations } from '../pluginMcpRegistrations.js';
import { isMcpAppToolVisible } from '../tools/mcpAppToolMetadata.js';
import {
  fileMcpSourceId,
  flagMcpSourceId,
  isSessionMcpSource,
  mcpServerKey,
  mcpServerKeyId,
  sessionMcpSourceId,
  type McpServerKey,
} from '../server-key.js';
import { MCPDiscoveryState } from './types.js';
import type {
  LazyMcpToolEntry,
  McpHostAuthorizationStart,
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
  readonly sdkBridge?: SendMcpMessageCallback;
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

interface HostAuthFlow {
  readonly flowId: string;
  readonly config: MCPServerConfig;
  assertCurrent(): void;
  readonly authUrlDeferred: Deferred<string>;
  readonly openerResultDeferred: Deferred<McpOAuthBrowserOpenResult | void>;
  readonly authenticatePromise: Promise<OAuthToken>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject: reject as (error: Error) => void };
}

export class SessionMcpManager {
  private entries = new Map<string, ServerEntry>();
  private readonly hostDrivenAuth: boolean;
  private readonly hostAuthFlows = new Map<string, HostAuthFlow>();
  private hostOpenerKey: symbol | undefined;
  private readonly ownedEntries = new Map<string, ServerEntry>();
  private readonly managedDisabled = new Set<string>();
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
  private readonly serverListeners = new Set<
    (key: McpServerKey, event: McpClientEvent) => void
  >();
  private userInteracted = false;
  private authPseudoToolsEnabled = true;
  private readonly authPseudoTools = new Map<string, McpAuthTool>();
  /** SDK-hosted servers this session injected, by logical name. */
  private readonly sdkKeys = new Map<string, McpServerKey>();
  /** Session-level `_meta` merged into every MCP request of this session. */
  private requestMeta: Record<string, unknown> | undefined;
  /** Plugin-contributed server key ids, by plugin id, for teardown. */
  private readonly pluginKeys = new Map<string, string[]>();
  private readonly authorizationCoordinator:
    | McpAuthorizationCoordinator
    | undefined;
  /** The last host-brokered authorization outcome per server. */
  private readonly authorizationOutcomes = new Map<
    string,
    McpAuthorizationOutcome
  >();
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
    this.hostDrivenAuth = options.hostDrivenAuth === true;
    this.appliedRegistration = this.registration();
    this.authorizationCoordinator = options.createAuthorizationCoordinator?.();
    runLogger.log(
      `[session-mcp] created session=${context.getSessionId()} cwd=${this.cwd} configuredServers=${Object.keys(context.getMcpServers() ?? {}).length} lazy=${this.lazyMode}`,
    );
  }

  /** Subscribe to this session's observed server events (tools / resources / prompts / status). */
  onServerEvent(
    listener: (key: McpServerKey, event: McpClientEvent) => void,
  ): () => void {
    this.serverListeners.add(listener);
    return () => {
      this.serverListeners.delete(listener);
    };
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
      if (this.hostDrivenAuth) {
        this.setAuthPseudoToolsEnabled(false);
        this.ensureHostAuthOpener();
      }
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
    this.disposeHostAuthFlows();
    this.mcpManager.detachSession?.(this.context.getSessionId(), this);
    await this.mcpManager.unregisterSession(this.context.getSessionId());
    this.mcpManager.setSessionRequestMeta?.(
      this.context.getSessionId(),
      undefined,
    );
    this.activeKeys.clear();
    runLogger.log(
      `[session-mcp] dispose completed session=${this.context.getSessionId()} activeServers=${activeServers} durationMs=${Date.now() - startedAt}`,
    );
  }

  // ── server set: merge sources → gate + enable → register with the pool ──

  private reloadTail: Promise<unknown> = Promise.resolve();

  reloadMcpServers(options?: {
    serverNames?: readonly string[];
    assertCurrent?: () => void;
    prepare?: () => Promise<readonly string[] | undefined>;
  }): Promise<void> {
    const run = this.reloadTail.then(async () => {
      options?.assertCurrent?.();
      const serverNames = options?.prepare
        ? await options.prepare()
        : options?.serverNames;
      options?.assertCurrent?.();
      // An empty prepared scope means this session has no applicable resources.
      if (options?.prepare && serverNames?.length === 0) return;
      await this.reloadMcpServersNow({
        serverNames,
        assertCurrent: options?.assertCurrent,
      });
    });
    this.reloadTail = run.catch(() => {});
    return run;
  }

  private async reloadMcpServersNow(options?: {
    serverNames?: readonly string[];
    assertCurrent?: () => void;
  }): Promise<void> {
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
    const targetNames =
      options?.serverNames !== undefined && options.serverNames.length > 0
        ? new Set(options.serverNames)
        : undefined;
    for (const [name, config] of Object.entries(servers)) {
      if (targetNames !== undefined && !targetNames.has(name)) continue;
      const entry = this.buildEntry(name, config);
      nextEntries.set(mcpServerKeyId(entry.key), entry);
      nextKeysByName.set(name, entry.key);
    }
    if (targetNames !== undefined) {
      // Targets are the only servers re-evaluated; every other server keeps
      // its entry so this reload cannot remove or reconnect it.
      for (const [id, entry] of previousEntries) {
        if (targetNames.has(entry.key.name) || nextEntries.has(id)) continue;
        nextEntries.set(id, entry);
        nextKeysByName.set(entry.key.name, entry.key);
      }
    }
    // SDK-hosted and plugin servers are adopted through their own registration
    // paths, not getMcpServers(); carry them across a reload so they survive.
    const sdkIds = new Set<string>();
    for (const key of this.sdkKeys.values()) sdkIds.add(mcpServerKeyId(key));
    const pluginIds = new Set<string>();
    for (const ids of this.pluginKeys.values()) {
      for (const id of ids) pluginIds.add(id);
    }
    const preserved = new Set([...sdkIds, ...pluginIds]);
    for (const id of preserved) {
      const existing = this.ownedEntries.get(id) ?? this.entries.get(id);
      const shadowed = existing && this.isShadowedByManaged(existing.key.name);
      if (existing && !shadowed && !nextEntries.has(id)) {
        nextEntries.set(id, existing);
        nextKeysByName.set(existing.key.name, existing.key);
      }
    }

    const eligibleEntries: ServerEntry[] = [];
    this.blocked.clear();
    for (const [id, entry] of nextEntries) {
      // An unshadowed SDK/plugin source needs admission again before reconnecting.
      const fromOwned = preserved.has(id);
      if (fromOwned && previousActiveKeys.has(id)) {
        eligibleEntries.push(entry);
        continue;
      }
      if (
        !fromOwned &&
        !this.context.isTrustedFolder() &&
        entry.config.scope !== 'dynamic'
      ) {
        runLogger.log(
          `[session-mcp] server skipped name=${entry.key.name} reason=untrusted-folder`,
        );
        continue;
      }
      const decision = this.evaluateGate(entry.config, entry.key.name);
      if (!decision.allowed) {
        this.recordBlock(id, decision);
        runLogger.log(
          `[session-mcp] server blocked name=${entry.key.name} reason=${decision.reason} hostPolicy=${isHostPolicyDeny(decision)}`,
        );
        continue;
      }
      if (!fromOwned && !this.isServerEnabled(entry.key.name)) {
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
      if (preserved.has(id) && previousActiveKeys.has(id)) continue;
      const entry = nextEntries.get(id)!;
      // A targeted reload must not retry unrelated servers held over above,
      // including ones currently DISCONNECTED.
      if (targetNames !== undefined && !targetNames.has(entry.key.name))
        continue;
      const previous = previousEntries.get(id);
      // An unchanged server is already in the pool. Re-registering it would
      // race a still-running connect/auth flow (and start a second OAuth
      // callback on the same port) when startup reloads overlap.
      if (
        previous &&
        previousActiveKeys.has(id) &&
        previous.rootsDir === entry.rootsDir &&
        isDeepStrictEqual(
          withoutMcpRuntimeMetadata(previous.config),
          withoutMcpRuntimeMetadata(entry.config),
        ) &&
        this.mcpManager.getStatus(key) !== MCPServerStatus.DISCONNECTED
      ) {
        continue;
      }
      registrations.push({
        key,
        config: entry.config,
        rootsDir: entry.rootsDir,
        ...(entry.sdkBridge ? { sdkBridge: entry.sdkBridge } : {}),
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
    options?.assertCurrent?.();
    if (registrations.length > 0) {
      await this.registerWithPool('configured', registrations, removed.length);
    }
    options?.assertCurrent?.();
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
    for (const { key, config } of registrations) {
      this.syncAuthorizationFromPool(key, config);
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
    const managed = this.context.getManagedMcpServer?.(name);
    if (managed) {
      const fingerprint = createHash('sha256')
        .update(stableStringify([config, this.cwd])!)
        .digest('hex');
      return {
        key: mcpServerKey(`managed:${managed.sourceId}:${fingerprint}`, name),
        config,
        rootsDir: this.cwd,
      };
    }
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

  private evaluateGate(
    config: MCPServerConfig,
    serverName: string,
  ): McpGateDecision {
    return this.mcpServerGate.evaluate({
      config,
      serverName,
      permissionAliases:
        this.context.getMcpServerPermissionAliases?.(serverName),
      allowList: this.context.getAllowedMcpServers() ?? [],
      excludeList: this.context.getBlockedMcpServers() ?? [],
    });
  }

  private recordBlock(
    id: string,
    decision: Extract<McpGateDecision, { allowed: false }>,
  ): void {
    this.blocked.set(id, {
      reason: decision.reason,
      message: gateDenyMessage(decision),
      hostPolicy: isHostPolicyDeny(decision),
    });
  }

  private isShadowedByManaged(name: string): boolean {
    return (
      this.context
        .getManagedMcpServers?.()
        .some((resource) => resource.originalName === name) ?? false
    );
  }

  isServerEnabled(name: string): boolean {
    const managed = this.context.getManagedMcpServer?.(name);
    if (managed) {
      if (
        !isManagedResourceLocked(managed) &&
        this.managedDisabled.has(`${managed.sourceId}:${name}`)
      )
        return false;
      return (
        this.context.isServerEnabled?.(name) ?? isManagedMcpEnabled(managed)
      );
    }
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
    for (const listener of [...this.serverListeners]) {
      try {
        listener(key, event);
      } catch {
        // A host listener must not break the session's pool subscription.
      }
    }
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
          this.syncAuthorizationFromPool(key, undefined, event.status);
        }
        break;
      default:
        break;
    }
    this.emitClientUpdate();
  }

  /**
   * A pooled connection can already be parked before this session registers it.
   * The event that parked it is not replayed, so activation must read the
   * current client state directly.
   */
  private syncAuthorizationFromPool(
    key: McpServerKey,
    configOverride?: MCPServerConfig,
    statusOverride?: MCPServerStatus,
  ): void {
    const client = this.mcpManager.getClient(key);
    const status = statusOverride ?? client?.getStatus();
    if (status !== MCPServerStatus.AUTH_REQUIRED) return;
    const authorizationError = client?.getAuthorizationRequiredError();
    const config =
      configOverride ?? this.entries.get(mcpServerKeyId(key))?.config;
    if (
      authorizationError &&
      config &&
      this.authorizationCoordinator?.canHandle(config)
    ) {
      this.registerAuthorization(key.name, config, authorizationError);
    } else {
      this.mintAuthPseudoTool(key, config);
    }
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
    const tool = this.createAuthPseudoTool(
      name,
      config,
      interactive,
      async () => {
        // Re-attempt the connection; the connector owns the actual auth flow.
        await this.mcpManager.reconnect(key, interactive);
        this.clearAuthPseudoTool(name);
        this.notifyToolListChange();
        return this.getRealToolCount(name);
      },
    );
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
    // App-only tools are not offered to the model; the app reaches them
    // through its own connection path.
    const tools = this.getAllDiscoveredMcpTools().filter((entry) =>
      isMcpAppToolVisible(entry.tool, 'model'),
    );
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
    return this.modelVisibleMcpTools(true);
  }

  /** Model-visible MCP tools declared directly: the complement of the lazy catalog. */
  getDeclaredMcpToolNames(): string[] {
    return this.modelVisibleMcpTools(false).map((entry) => entry.qualifiedName);
  }

  private modelVisibleMcpTools(deferred: boolean): LazyMcpToolEntry[] {
    const context = this.deferralContext();
    return this.getAllDiscoveredMcpTools().filter(
      (entry) =>
        isMcpAppToolVisible(entry.tool, 'model') &&
        this.isReachedThroughMetaTools(entry, context) === deferred,
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
    return entry &&
      isMcpAppToolVisible(entry.tool, 'model') &&
      this.isReachedThroughMetaTools(entry)
      ? entry
      : undefined;
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
    };
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

  /** One page of a server's resource catalog, cursor passed through. */
  async listResources(
    serverName: string,
    cursor?: string,
  ): Promise<ListResourcesResult> {
    const client = this.getClientByName(serverName);
    if (!client) throw new Error(`Unknown MCP server '${serverName}'`);
    return client.listResourcesPage(cursor);
  }

  async readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    return this.mcpManager.readResource(this.requireKey(serverName), uri, {
      requestMeta: this.requestMeta,
      signal: options?.signal,
    });
  }

  /** Calls a tool on one active server, with the raw MCP result. */
  async callTool(
    serverName: string,
    params: CallToolParams,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<McpCallToolResult> {
    const client = this.getClientByName(serverName);
    if (!client) throw new Error(`Unknown MCP server '${serverName}'`);
    return client.callMcpTool(params, {
      ...options,
      requestMeta: this.requestMeta,
    });
  }

  /** Replaces this session's request `_meta` snapshot. */
  setRequestMeta(meta: Record<string, unknown> | undefined): void {
    this.requestMeta = meta && Object.keys(meta).length > 0 ? meta : undefined;
    this.mcpManager.setSessionRequestMeta(
      this.context.getSessionId(),
      this.requestMeta,
    );
  }

  /**
   * Raw initialize result for a connected server, or null while unknown.
   * Product layers read standard fields and any future additions from `raw`.
   */
  getServerInfo(serverName: string): {
    readonly source: 'initialize' | 'discover';
    readonly capabilities: Record<string, unknown>;
    readonly raw: Record<string, unknown>;
  } | null {
    const client = this.getClientByName(serverName);
    if (!client || !client.isConnected()) return null;
    const info = client.getServerInfo();
    return info
      ? {
          source: info.source,
          capabilities: info.capabilities as Record<string, unknown>,
          raw: info.raw,
        }
      : null;
  }

  /** Full discovered tool definitions for one known server. */
  getServerTools(serverName: string): {
    readonly serverName: string;
    readonly tools: ReadonlyArray<{
      readonly qualifiedName: string;
      readonly definition: Record<string, unknown>;
    }>;
  } | null {
    if (!this.keysByName.has(serverName)) return null;
    const tools = this.getAllDiscoveredMcpTools()
      .filter(
        (entry) => entry.serverName === serverName && entry.source !== 'auth',
      )
      .map((entry) => ({
        qualifiedName: entry.qualifiedName,
        definition:
          'definition' in entry.tool ? (entry.tool.definition ?? {}) : {},
      }));
    return { serverName, tools };
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
    const managed = this.context.getManagedMcpServer?.(name);
    if (managed) {
      if (isManagedResourceLocked(managed))
        throw new Error(
          'This MCP server is required by your organization and cannot be disabled.',
        );
      this.managedDisabled.add(`${managed.sourceId}:${name}`);
    } else this.disabled.add(name);
    await this.reloadMcpServers();
  }

  async enableMcpServer(name: string): Promise<void> {
    runLogger.log(
      `[session-mcp] server enable session=${this.context.getSessionId()} name=${name}`,
    );
    const managed = this.context.getManagedMcpServer?.(name);
    if (managed) this.managedDisabled.delete(`${managed.sourceId}:${name}`);
    else this.disabled.delete(name);
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
    const recorded = this.lastErrors.get(name);
    if (recorded) return recorded;
    // A failed tools/list leaves the server connected with an empty catalog;
    // report that reason instead of a clean server with no tools.
    const discoveryError = this.getClientByName(name)?.getToolDiscoveryError();
    return discoveryError === undefined
      ? undefined
      : getMcpErrorMessage(discoveryError);
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
    this.context.getToolRegistry()?.invalidateSchemaCache?.();
    this.notifyToolListChange();
  }

  peekAppliedRegistration(): McpRegistration {
    return this.appliedRegistration;
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
    await client.recoverConnection(signal);
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
      (key) =>
        !isSessionMcpSource(key.source) || !configuredNames.has(key.name),
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
    /** Runtime-only overrides merged onto the server config; never persisted. */
    configOverridesByServer?: Record<string, Record<string, unknown>>,
  ): Promise<{
    connectedServers: string[];
    failedServers: string[];
    blockedServers: string[];
  }> {
    if (serverNames.some((name) => name.startsWith('enterprise_')))
      throw new Error(
        'The enterprise_ MCP namespace is reserved for managed resources.',
      );
    const startedAt = Date.now();
    runLogger.log(
      `[session-mcp] sdk register started session=${this.context.getSessionId()} servers=${serverNames.length} names=${serverNames.join(',')}`,
    );
    const rootsDir = this.context.getTargetDir();
    const admitted: McpServerRegistration[] = [];
    const admittedNames: string[] = [];
    const blockedNames: string[] = [];
    for (const name of serverNames) {
      const config = Object.assign(
        createSdkMcpServerConfig(toolOverridesByServer?.[name]),
        configOverridesByServer?.[name] ?? {},
      ) as MCPServerConfig;
      const key = mcpServerKey(
        sessionMcpSourceId(this.context.getSessionId()),
        name,
      );
      const elicitationHandler = this.buildElicitationHandler(name);
      const registration: McpServerRegistration = {
        key,
        config,
        rootsDir,
        sdkBridge: sendMcpMessage,
        ...(elicitationHandler ? { elicitationHandler } : {}),
      };
      const id = mcpServerKeyId(key);
      this.sdkKeys.set(name, key);
      this.ownedEntries.set(id, registration);
      if (this.isShadowedByManaged(name)) continue;
      this.adoptEntry(registration);
      const decision = this.evaluateGate(config, name);
      if (!decision.allowed) {
        this.recordBlock(id, decision);
        blockedNames.push(name);
        runLogger.log(
          `[session-mcp] server blocked name=${name} reason=${decision.reason} hostPolicy=${isHostPolicyDeny(decision)}`,
        );
        continue;
      }
      this.activeKeys.set(id, key);
      admitted.push(registration);
      admittedNames.push(name);
    }
    if (admitted.length > 0) {
      await this.registerWithPool('sdk', admitted);
    }
    const connectedServers: string[] = [];
    const failedServers: string[] = [];
    for (const name of admittedNames) {
      const key = this.sdkKeys.get(name)!;
      if (this.mcpManager.getStatus(key) === MCPServerStatus.CONNECTED) {
        connectedServers.push(name);
      } else {
        failedServers.push(name);
      }
    }
    this.publishAll();
    runLogger.log(
      `[session-mcp] sdk register completed session=${this.context.getSessionId()} connected=${connectedServers.length} failed=${failedServers.length} blocked=${blockedNames.length} durationMs=${Date.now() - startedAt}`,
    );
    return { connectedServers, failedServers, blockedServers: blockedNames };
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

  // ── plugin servers (standard pooled clients, source=plugin:<id>~<digest>) ──

  async startPlugin(
    owner: McpPluginOwner,
    options?: { readonly waitForConnections?: boolean },
  ): Promise<void> {
    const startedAt = Date.now();
    const servers = owner.mcpServers ?? {};
    if (Object.keys(servers).some((name) => name.startsWith('enterprise_'))) {
      throw new Error(
        'The enterprise_ MCP namespace is reserved for managed resources.',
      );
    }
    runLogger.log(
      `[session-mcp] plugin start session=${this.context.getSessionId()} plugin=${owner.id} servers=${Object.keys(servers).length} names=${Object.keys(servers).join(',')}`,
    );
    const regs = pluginMcpRegistrations(owner, this.context.getTargetDir());
    const admitted: McpServerRegistration[] = [];
    for (const reg of regs) {
      this.ownedEntries.set(mcpServerKeyId(reg.key), reg);
      if (this.isShadowedByManaged(reg.key.name)) continue;
      this.adoptEntry(reg);
      const id = mcpServerKeyId(reg.key);
      const decision = this.evaluateGate(reg.config, reg.key.name);
      if (decision.allowed) {
        this.activeKeys.set(id, reg.key);
        admitted.push(reg);
      } else {
        this.recordBlock(id, decision);
        runLogger.log(
          `[session-mcp] server blocked name=${reg.key.name} reason=${decision.reason} hostPolicy=${isHostPolicyDeny(decision)}`,
        );
      }
    }
    this.pluginKeys.set(
      owner.id,
      regs.map((reg) => mcpServerKeyId(reg.key)),
    );
    if (admitted.length > 0) {
      const registration = this.registerWithPool('plugin', admitted);
      if (options?.waitForConnections === false) {
        void registration.catch((error: unknown) => {
          runLogger.warn(
            `[session-mcp] plugin registration failed session=${this.context.getSessionId()} plugin=${owner.id}`,
            error,
          );
        });
      } else {
        await registration;
      }
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
      const entry = this.ownedEntries.get(id) ?? this.entries.get(id);
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
    if (name.startsWith('enterprise_')) {
      throw new Error(
        'The enterprise_ MCP namespace is reserved for managed resources.',
      );
    }
    if (this.isShadowedByManaged(name)) return;
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
      this.activeKeys.set(mcpServerKeyId(key), key);
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
  getContext(): McpSessionContext {
    return this.context;
  }

  /**
   * Host-driven OAuth: the host owns the user-agent step. Returns the URL to
   * open, or "no user action needed" when stored credentials sufficed.
   */
  async authenticateWithHost(
    serverName: string,
    options: { readonly redirectUri?: string } = {},
  ): Promise<McpHostAuthorizationStart> {
    if (this.hostAuthFlows.has(serverName)) {
      throw new Error(`MCP OAuth flow already in progress for "${serverName}"`);
    }
    const serverCfg = this.getMcpServers()[serverName];
    if (!serverCfg) {
      throw new Error(`unknown MCP server "${serverName}"`);
    }
    this.ensureHostAuthOpener();

    let preparation: McpAuthorizationPreparation | undefined;
    try {
      preparation = await this.prepareMcpAuthorization(serverName);
    } catch (error) {
      if (
        !(error instanceof McpAuthorizationPreparationError) ||
        error.kind !== 'unsupported'
      ) {
        throw new Error(
          'MCP authorization could not be prepared. Retry authentication explicitly if the server is enabled.',
        );
      }
    }
    if (preparation?.kind === 'connected') {
      return { requiresUserAction: false };
    }
    if (preparation) {
      const action = preparation.action;
      const authorization = this.authorizeMcpServer(serverName, {
        confirmOpenUrl: async () => 'accepted',
        openUrl: async () => undefined,
      });
      void authorization
        .then((outcome) => {
          runLogger.log(
            `[session-mcp] authorization finished server=${serverName} state=${outcome.state}`,
          );
        })
        .catch(() => {
          runLogger.warn(
            `[session-mcp] authorization failed server=${serverName}`,
          );
        });
      return { requiresUserAction: true, authUrl: action.url.href };
    }

    const serverUrl = serverCfg.url ?? serverCfg.httpUrl;
    const baseOauthConfig = serverCfg.oauth ?? { enabled: true };
    const redirectUri = options.redirectUri;
    const oauthConfig = redirectUri
      ? { ...baseOauthConfig, redirectUri }
      : baseOauthConfig;

    const authUrlDeferred = createDeferred<string>();
    const openerResultDeferred =
      createDeferred<McpOAuthBrowserOpenResult | void>();
    const authenticateDeferred = createDeferred<OAuthToken>();
    void authUrlDeferred.promise.catch(() => {});
    void openerResultDeferred.promise.catch(() => {});
    const flowId = randomUUID();
    const managedProvider = this.context.getManagedMcpServer?.(serverName)
      ? this.context.getManagedResourcesProvider?.()
      : undefined;
    const identityGeneration = managedProvider?.getIdentityGeneration?.();
    const assertCurrent = () => {
      if (
        managedProvider?.getIdentityGeneration?.() !== identityGeneration ||
        this.hostAuthFlows.get(serverName)?.flowId !== flowId ||
        !isDeepStrictEqual(this.getMcpServers()[serverName], serverCfg) ||
        !this.isServerEnabled(serverName) ||
        !this.evaluateGate(serverCfg, serverName).allowed
      )
        throw new Error('Authorization ended');
    };
    this.hostAuthFlows.set(serverName, {
      flowId,
      config: serverCfg,
      assertCurrent,
      authUrlDeferred,
      openerResultDeferred,
      authenticatePromise: authenticateDeferred.promise,
    });

    const provider = new MCPOAuthProvider(
      MCPOAuthTokenStorage.forServer(serverName, serverCfg),
    );
    provider
      .authenticate(serverName, oauthConfig, serverUrl, {
        skipConsent: true,
        hostDeliversCallback: Boolean(redirectUri),
        flowId,
        beforeTokenCommit: assertCurrent,
      })
      .then(authenticateDeferred.resolve, authenticateDeferred.reject)
      .finally(() => {
        if (this.hostAuthFlows.get(serverName)?.flowId === flowId)
          this.hostAuthFlows.delete(serverName);
      });
    authenticateDeferred.promise.catch(() => {});

    try {
      const winner: { kind: 'url'; authUrl: string } | { kind: 'silent' } =
        await Promise.race([
          authUrlDeferred.promise.then((authUrl) => ({
            kind: 'url' as const,
            authUrl,
          })),
          authenticateDeferred.promise.then(() => ({
            kind: 'silent' as const,
          })),
        ]);
      if (winner.kind === 'silent') {
        return { requiresUserAction: false };
      }
      return { requiresUserAction: true, authUrl: winner.authUrl };
    } catch (error) {
      if (this.hostAuthFlows.get(serverName)?.flowId === flowId)
        this.hostAuthFlows.delete(serverName);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Completes the flow started by {@link authenticateWithHost}. */
  async submitHostAuthCallback(
    serverName: string,
    callbackUrl: string,
  ): Promise<void> {
    const flow = this.hostAuthFlows.get(serverName);
    if (!flow) {
      throw new Error(`no OAuth flow in progress for "${serverName}"`);
    }
    flow.openerResultDeferred.resolve({ callbackUrl });
    await flow.authenticatePromise;
    if (this.getMcpServers()[serverName]) {
      try {
        await this.restartServer(serverName);
      } catch (error) {
        runLogger.warn(
          `[session-mcp] token saved for "${serverName}" but reconnect failed`,
          error,
        );
      }
    }
  }

  /** Ends a host-driven flow that is still waiting for the user. */
  cancelHostAuthorization(serverName: string): boolean {
    const flow = this.hostAuthFlows.get(serverName);
    if (!flow) return false;
    flow.openerResultDeferred.reject(new Error('Authorization cancelled'));
    flow.authUrlDeferred.reject(new Error('Authorization cancelled'));
    this.hostAuthFlows.delete(serverName);
    return true;
  }

  private ensureHostAuthOpener(): void {
    if (this.hostOpenerKey !== undefined) return;
    this.hostOpenerKey = registerMcpOAuthOpener(async (authUrl, meta) => {
      const flow = meta.serverName
        ? this.hostAuthFlows.get(meta.serverName)
        : undefined;
      if (
        flow &&
        (meta.flowId
          ? meta.flowId === flow.flowId
          : !this.context.getManagedMcpServer?.(meta.serverName!))
      ) {
        flow.assertCurrent();
        flow.authUrlDeferred.resolve(authUrl);
        return flow.openerResultDeferred.promise;
      }
      throw new Error(
        `MCP OAuth required for "${meta.serverName ?? '<unknown>'}" but no host-driven flow is in progress. Call mcpAuthenticate() first.`,
      );
    });
  }

  private disposeHostAuthFlows(): void {
    unregisterMcpOAuthOpener(this.hostOpenerKey);
    this.hostOpenerKey = undefined;
    for (const flow of this.hostAuthFlows.values()) {
      flow.openerResultDeferred.reject(new Error('Session ended'));
      flow.authUrlDeferred.reject(new Error('Session ended'));
    }
    this.hostAuthFlows.clear();
  }

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
    const coordinator = this.authorizationCoordinator;
    if (!coordinator) {
      throw new McpAuthorizationPreparationError('unavailable');
    }
    // A new attempt makes the previous result stale.
    this.authorizationOutcomes.delete(name);
    return coordinator.authorize(name, host).then((outcome) => {
      this.authorizationOutcomes.set(name, outcome);
      return outcome;
    });
  }

  /** The live authorization phase, or the last finished one. */
  getAuthorizationState(name: string): McpAuthorizationState | undefined {
    return (
      this.authorizationCoordinator?.getState(name) ??
      this.authorizationOutcomes.get(name)?.state
    );
  }

  /** The last finished authorization, including failure/retry details. */
  getAuthorizationOutcome(name: string): McpAuthorizationOutcome | undefined {
    return this.authorizationOutcomes.get(name);
  }

  /**
   * Stops a host-brokered authorization for this server. Resolves true when
   * one was in progress; the pending authorize() then finishes as cancelled.
   */
  cancelAuthorization(name: string): boolean {
    const coordinator = this.authorizationCoordinator;
    if (!coordinator) return false;
    const state = coordinator.getState(name);
    const active =
      state === 'awaiting_confirmation' ||
      state === 'opening_browser' ||
      state === 'polling' ||
      state === 'reconnecting';
    coordinator.cancelServer(name);
    if (active) {
      this.authorizationOutcomes.set(name, {
        state: 'cancelled',
        canRetryAuthorization: false,
      });
    }
    return active;
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
    const flow = this.hostAuthFlows.get(serverName);
    const serverConfig =
      config ?? this.getMcpServers()[serverName] ?? flow?.config;
    this.cancelHostAuthorization(serverName);
    if (
      serverConfig &&
      this.authorizationCoordinator?.canHandle(serverConfig)
    ) {
      return 'host-owned';
    }

    if (serverConfig) {
      await MCPOAuthTokenStorage.forServer(
        serverName,
        serverConfig,
      ).deleteCredentials(serverName);
    }
    // Without configuration or an in-flight flow there is no credential identity
    // to clear. A bare name must not delete another resource's legacy token.

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
      // Pool status delivery is fire-and-forget and fans out session by session;
      // the action is already on the current attempt, so adopt it here instead
      // of waiting for this session's listener turn.
      const client = this.mcpManager.getClient(key);
      const clientAuthorization =
        client?.getStatus() === MCPServerStatus.AUTH_REQUIRED
          ? client.getAuthorizationRequiredError()
          : undefined;
      if (
        clientAuthorization &&
        clientAuthorization.action.expiresAtMs > Date.now()
      ) {
        this.registerAuthorization(name, config, clientAuthorization);
        runLogger.log(
          `[session-mcp] authorization action adopted session=${this.context.getSessionId()} server=${name}`,
        );
      }
      const freshAction = this.getMcpAuthorizationAction(name);
      if (freshAction && freshAction.expiresAtMs > Date.now()) {
        return { kind: 'action', action: freshAction };
      }
      if (!freshAction && client?.getStatus() === MCPServerStatus.CONNECTED) {
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
    if (
      this.authorizationCoordinator.getAction(name)?.authorizationRequestId ===
      error.action.authorizationRequestId
    ) {
      this.mintAuthPseudoTool(
        this.keysByName.get(name) ?? mcpServerKey('sdk', name),
        config,
      );
      return;
    }
    const generation =
      (this.authorizationRecoveryGenerations.get(name) ?? 0) + 1;
    this.authorizationRecoveryGenerations.set(name, generation);
    try {
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
    } catch (registrationError) {
      // A malformed or colliding action must not disappear inside a listener
      // exception. Keep the authenticate pseudo-tool so the host can retry.
      runLogger.warn(
        `[session-mcp] authorization action registration failed server=${name}`,
        registrationError instanceof Error
          ? registrationError.message
          : registrationError,
      );
      this.mintAuthPseudoTool(
        this.keysByName.get(name) ?? mcpServerKey('sdk', name),
        config,
      );
      return;
    }
    this.mintAuthPseudoTool(
      this.keysByName.get(name) ?? mcpServerKey('sdk', name),
      config,
    );
  }

  private invalidateServerAuthorization(name: string): void {
    this.authorizationPreparations.delete(name);
    this.authorizationOutcomes.delete(name);
    this.authorizationRecoveryGenerations.set(
      name,
      (this.authorizationRecoveryGenerations.get(name) ?? 0) + 1,
    );
    this.authorizationCoordinator?.cancelServer(name);
    for (const listener of this.authorizationInvalidationListeners) {
      listener(name);
    }
  }

  /** Records a server as known; whether it is active is decided by the caller. */
  private adoptEntry(entry: ServerEntry): void {
    const id = mcpServerKeyId(entry.key);
    this.entries.set(id, entry);
    this.keysByName.set(entry.key.name, entry.key);
  }

  private async dropEntry(key: McpServerKey): Promise<void> {
    const id = mcpServerKeyId(key);
    const startedAt = Date.now();
    this.activeKeys.delete(id);
    this.entries.delete(id);
    this.ownedEntries.delete(id);
    if (mcpServerKeyId(this.keysByName.get(key.name) ?? key) === id) {
      this.keysByName.delete(key.name);
    }
    this.blocked.delete(id);
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
