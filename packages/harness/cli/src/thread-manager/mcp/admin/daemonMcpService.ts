/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-level MCP management: the servers a daemon knows about, their config
 * and live status, and their authorization, without a session. It works on
 * the process-wide pool and the user settings; every change that affects
 * servers is followed by a refresh of all open sessions, so they use the new
 * config from their next tool call.
 *
 * Protocol-neutral: a host translates its wire format to these methods and
 * maps `DaemonMcpError.code` to its error encoding.
 */

import {
  MCPOAuthTokenStorage,
  MCPServerStatus,
  mcpServerKeyId,
  type ManagedResourcesProvider,
  type ManagedMcpRefreshTarget,
  type ManagedMcpResource,
  runLogger,
  type DiscoveredMCPTool,
  type MCPServerConfig,
  type McpManager,
  type McpServerRegistration,
  type PluginManagerFactory,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';
import { getSettingsResolveOptions } from '../../../config/settings.js';
import type { ThreadMcpReloadOutcome } from '../../thread-session/contract/threadSessionTypes.js';
import {
  DaemonMcpAuthorization,
  type McpAuthorizationStart,
  type McpCancelAuthorizationResult,
  type McpClearAuthResult,
} from './authorization.js';
import { defaultMcpAuthMethod, type DaemonMcpContext } from './context.js';
import { DaemonMcpError } from './errors.js';
import { UserPoolSync, type McpPoolDiff } from './poolSync.js';
import {
  EnterpriseMcpAdmin,
  enterpriseMcpError,
  enterpriseServerId,
  type EnterpriseIdentity,
} from './enterprise.js';
import {
  mcpConfigVersion,
  rawUserMcpServers,
  requireReadable,
} from './userSettings.js';
import { serverIdForKey } from './serverIds.js';
import {
  callMcpServerTool,
  getMcpServerInfo,
  getMcpServerTools,
  listMcpServerResources,
  listMcpServers,
  readMcpServerResource,
  reconnectMcpServer,
  type McpServerInfo,
  type McpServerList,
  type McpServerResourceResult,
  type McpServerSummary,
  type McpServerToolCall,
} from './queries.js';
import { parseServerId } from './serverIds.js';
import { waitAtMost } from './waitAtMost.js';
import {
  createUserMcpServers,
  deleteUserMcpServer,
  setUserMcpServerEnabled,
  updateUserMcpServer,
  validateUserMcpServers,
  type McpValidateResult,
  type UserServerTarget,
} from './writes.js';

/**
 * How long a call waits for the pool to connect what changed, and for open
 * sessions to follow. Past it the call returns and the work carries on.
 */
export const DAEMON_MCP_WAIT_MS = 10_000;

export type DaemonMcpEvent = {
  readonly serverId: string;
} & (
  | { readonly kind: 'tools'; readonly toolsCount: number }
  | { readonly kind: 'status' }
);

export interface DaemonMcpServiceDeps {
  getMcpManager(): McpManager | undefined;
  getManagedResourcesProvider?(): Promise<ManagedResourcesProvider | undefined>;
  getSettingsService(): SettingsService;
  /** Optional fallback when the pool cannot report what it was given. */
  startupUserServers?(): readonly McpServerRegistration[];
  /** The product's plugin manager factory, for user-level plugin servers. */
  getPluginManagerFactory?(): PluginManagerFactory | undefined;
  /** Re-reads MCP in every open session, reporting each session's outcome. */
  refreshSessions(options: {
    readonly plugins: boolean;
    readonly serverNames?: readonly string[];
    readonly enterprise?: {
      targets?: readonly ManagedMcpRefreshTarget[];
      assertCurrent: () => void;
    };
  }): Promise<readonly ThreadMcpReloadOutcome[]>;
}

/** How the open sessions followed a change. */
export interface DaemonMcpSessionSync {
  /** Each open session's refresh; empty when they did not all finish in time. */
  readonly sessions: readonly ThreadMcpReloadOutcome[];
  /** False when the refresh failed or ran past the wait bound. */
  readonly sessionsSettled: boolean;
}

export interface DaemonMcpReloadResult
  extends McpPoolDiff,
    DaemonMcpSessionSync {}

export interface DaemonMcpServerDetail {
  readonly serverId: string;
  readonly server: McpServerSummary | null;
  readonly info: McpServerInfo['info'];
  readonly tools: readonly DiscoveredMCPTool[];
}

export type DaemonMcpAuthRequest =
  | {
      readonly action: 'start';
      readonly serverId: string;
      readonly redirectUri: string;
    }
  | {
      readonly action: 'complete';
      readonly serverId: string;
      readonly callbackUrl: string;
    }
  | { readonly action: 'cancel'; readonly serverId: string }
  | { readonly action: 'clear'; readonly serverId: string };

export type DaemonMcpAuthResult =
  | McpAuthorizationStart
  | McpServerSummary
  | McpCancelAuthorizationResult
  | McpClearAuthResult;

/** One item of a `daemon.mcp.edit_servers` batch. */
export type DaemonMcpEditItem =
  | {
      readonly op: 'create';
      readonly configKey: string;
      readonly config: unknown;
      readonly onConflict?: 'reject' | 'replace';
    }
  | {
      readonly op: 'update';
      readonly serverId?: string;
      readonly configKey?: string;
      readonly mode: 'replace' | 'merge';
      readonly config: unknown;
    }
  | {
      readonly op: 'delete';
      readonly serverId?: string;
      readonly configKey?: string;
    }
  | {
      readonly op: 'set_enabled';
      readonly serverId: string;
      readonly enabled: boolean;
    };

export type DaemonMcpEditResultItem =
  | {
      readonly op: 'create';
      readonly configKey: string;
      readonly serverId: string;
      readonly action: 'created' | 'replaced';
    }
  | { readonly op: 'update'; readonly serverId: string }
  | {
      readonly op: 'delete';
      readonly deleted: string;
      readonly credentialsDeleted: boolean;
    }
  | { readonly op: 'set_enabled'; readonly server: McpServerSummary };

export type DaemonMcpEditResult =
  | { readonly mode: 'validate'; readonly validation: McpValidateResult }
  | {
      readonly mode: 'apply';
      readonly configVersion: string;
      readonly results: readonly DaemonMcpEditResultItem[];
    };

export class DaemonMcpService {
  private readonly context: DaemonMcpContext;
  private readonly enterprise: EnterpriseMcpAdmin;
  private coordinationTail: Promise<unknown> = Promise.resolve();
  private readonly pool: UserPoolSync;
  private readonly authorization: DaemonMcpAuthorization;
  private readonly waitMs: number;
  private disposed = false;
  private managerUnsubscribe: (() => void) | undefined;
  private readonly eventListeners = new Set<(event: DaemonMcpEvent) => void>();

  constructor(
    private readonly deps: DaemonMcpServiceDeps,
    options: { readonly waitMs?: number } = {},
  ) {
    this.enterprise = new EnterpriseMcpAdmin(deps.getManagedResourcesProvider);
    this.waitMs = options.waitMs ?? DAEMON_MCP_WAIT_MS;
    const readUserSettings = () => {
      const settingsService = deps.getSettingsService();
      // Another process may have just edited the file; do not serve a cache.
      settingsService.peekUserSettingsSource()?.invalidate();
      return settingsService.resolve(
        getSettingsResolveOptions(process.cwd(), ['user']),
      );
    };
    this.pool = new UserPoolSync({
      getMcpManager: deps.getMcpManager,
      readUserSettings,
      startupServers: () =>
        deps.getMcpManager()?.getUserRegistrations?.() ??
        deps.startupUserServers?.() ??
        [],
      waitMs: this.waitMs,
      pluginManagerFactory: deps.getPluginManagerFactory?.(),
    });
    this.context = {
      resolveEnterprise: (id, allowDisabled) =>
        this.enterprise.resolve(this.context, id, allowDisabled),
      getMcpManager: deps.getMcpManager,
      authMethodOf: (config) =>
        deps.getMcpManager()?.authMethodOf?.(config) ??
        defaultMcpAuthMethod(config),
      readUserSettings,
      hasCredentials: async (serverName, config) =>
        (await readCredentials(serverName, config)) !== null,
      deleteCredentials: async (serverName, config) => {
        if (config) {
          // The server's own identity, plus the keys it may have been stored
          // under before; another server of the same name is left alone.
          const storage = MCPOAuthTokenStorage.forServer(serverName, config);
          if ((await storage.getCredentials(serverName)) === null) return false;
          try {
            await storage.deleteCredentials(serverName);
            return true;
          } catch {
            return false;
          }
        }
        // Config already gone: everything under the name that is not a
        // plugin's (the old management target had no plugin owner).
        const existing = await new MCPOAuthTokenStorage()
          .getAllCredentials()
          .catch(() => new Map());
        const existed = [...existing.keys()].some(
          (key) => key === serverName || key.startsWith(`${serverName}|`),
        );
        await MCPOAuthTokenStorage.deleteCredentialsByServerName(serverName);
        return existed;
      },
      deleteCredentialsIfToken: async (serverName, token, config) => {
        if (config) {
          await MCPOAuthTokenStorage.forServer(serverName, config)
            .deleteInvalidToken(serverName, token)
            .catch(() => {});
          return;
        }
        const storage = new MCPOAuthTokenStorage();
        let stored;
        try {
          stored = await storage.getCredentials(serverName);
        } catch {
          return; // unreadable counts as present: never drop on a read failure
        }
        if (stored?.token.accessToken !== token.accessToken) return;
        await storage.deleteCredentials(serverName).catch(() => {});
      },
      userRegistrations: () => this.pool.registrations(),
      syncPool: () => this.pool.sync(),
    };
    this.authorization = new DaemonMcpAuthorization(this.context);
  }

  // ── events ───────────────────────────────────────────────────────────────

  onEvent(listener: (event: DaemonMcpEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.ensureEventSubscription();
    void this.ensureEnterpriseRuntime().catch((error) =>
      runLogger.warn(
        '[daemon-mcp] enterprise initialization failed',
        enterpriseMcpError(error),
      ),
    );
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Subscribes to the process-wide pool once the manager exists. */
  ensureEventSubscription(): void {
    if (this.managerUnsubscribe) return;
    const manager = this.deps.getMcpManager();
    if (!manager) return;
    this.managerUnsubscribe = manager.addListener((key, event) => {
      if (event.type !== 'tools' && event.type !== 'status') return;
      const serverId = this.enterprise.serverId(key) ?? serverIdForKey(key);
      // The pool also holds session-owned servers; they have no daemon id.
      if (
        !serverId.startsWith('user:') &&
        !serverId.startsWith('plugin:') &&
        !serverId.startsWith('enterprise:')
      ) {
        return;
      }
      const eventValue: DaemonMcpEvent =
        event.type === 'tools'
          ? { kind: 'tools', serverId, toolsCount: event.tools.length }
          : { kind: 'status', serverId };
      for (const listener of this.eventListeners) {
        try {
          listener(eventValue);
        } catch {
          // 一个宿主监听失败不能断开连接池事件。
        }
      }
    });
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** `cwds` is reserved for project-level servers, which are not supported yet. */
  async list(
    options: { readonly cwds?: readonly string[] } = {},
  ): Promise<McpServerList> {
    this.ensureEventSubscription();
    if (options.cwds && options.cwds.length > 0) {
      throw new DaemonMcpError(
        'UNSUPPORTED',
        'Project-level MCP servers are not supported yet; omit cwds.',
      );
    }
    const identity = await this.ensureEnterpriseRuntime();
    const list = await listMcpServers(this.context);
    const resources = this.enterprise.resources();
    const servers = await Promise.all(
      resources.map((entry) => this.enterprise.describe(this.context, entry)),
    );
    identity.assertCurrent();
    return { ...list, servers: [...list.servers, ...servers] };
  }

  /** Summary, protocol facts and current tool catalog of one server. */
  async getServer(serverId: string): Promise<DaemonMcpServerDetail> {
    if (parseServerId(serverId)?.kind === 'enterprise') {
      const identity = await this.ensureEnterpriseRuntime();
      const resource = this.enterprise.require(
        this.enterprise.resources(),
        serverId,
        'detail',
      );
      const server = await this.enterprise.describe(this.context, resource);
      identity.assertCurrent();
      if (server.status !== MCPServerStatus.CONNECTED)
        return { serverId, server, info: null, tools: [] };
      try {
        const target = this.enterprise.resolve(
          this.context,
          serverId,
          false,
          'detail',
        );
        return {
          serverId,
          server,
          info: getMcpServerInfo(this.context, serverId, target).info,
          tools: getMcpServerTools(this.context, serverId, target).tools,
        };
      } catch (error) {
        throw safeEnterpriseOperationError(error);
      }
    }
    const info = getMcpServerInfo(this.context, serverId).info;
    let tools: readonly DiscoveredMCPTool[] = [];
    try {
      tools = getMcpServerTools(this.context, serverId).tools;
    } catch {
      // 未连接时没有工具目录；info 仍是权威来源。
      tools = [];
    }
    const list = await listMcpServers(this.context);
    return {
      serverId,
      server:
        list.servers.find((server) => server.serverId === serverId) ?? null,
      info,
      tools,
    };
  }

  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpServerToolCall> {
    return callMcpServerTool(this.context, serverId, toolName, args);
  }

  listResources(
    serverId: string,
    cursor?: string,
  ): Promise<McpServerResourceResult> {
    return listMcpServerResources(this.context, serverId, cursor);
  }

  readResource(
    serverId: string,
    uri: string,
  ): Promise<McpServerResourceResult> {
    return readMcpServerResource(this.context, serverId, uri);
  }

  async reconnect(serverId: string): Promise<McpServerSummary> {
    if (parseServerId(serverId)?.kind !== 'enterprise')
      return reconnectMcpServer(this.context, serverId);
    await this.ensureEnterpriseRuntime();
    try {
      return await reconnectMcpServer(this.context, serverId);
    } catch (error) {
      throw safeEnterpriseOperationError(error);
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * `daemon.mcp.edit_servers`: a single validate pass, or a batch applied in
   * order against one starting version. Each write re-locks the settings file
   * and chains the version returned by the previous one, so a batch never
   * collides with itself. The reply reports the persisted batch; connections
   * and the open sessions' refresh continue in the background (callers read
   * readiness from `list_servers`).
   */
  async edit(request: {
    readonly mode: 'validate' | 'apply';
    readonly expectedVersion?: string;
    readonly confirmToken?: string;
    readonly items: readonly DaemonMcpEditItem[];
  }): Promise<DaemonMcpEditResult & Partial<DaemonMcpSessionSync>> {
    const startedAt = Date.now();
    runLogger.log(
      `[daemon-mcp] edit started mode=${request.mode} items=${request.items.length} ops=${request.items.map((item) => item.op).join(',') || 'none'}`,
    );
    const identity = await this.enterprise.capture();
    const coordinated = await this.coordinate(() =>
      this.editCoordinated(request, identity),
    );
    // The batch is persisted and its pool ownership is submitted by the time
    // `editCoordinated` returns. Connecting and refreshing sessions must not
    // hold the write reply; their failures are logged and visible through the
    // server listing instead.
    for (const task of coordinated.poolTasks ?? []) {
      void task.catch((error: unknown) => {
        runLogger.warn('[daemon-mcp] pool task failed after edit', error);
      });
    }
    void coordinated.sync?.catch((error: unknown) => {
      runLogger.warn('[daemon-mcp] session sync failed after edit', error);
    });
    identity.assertCurrent();
    runLogger.log(
      `[daemon-mcp] edit completed mode=${coordinated.result.mode} items=${request.items.length} background=true durationMs=${Date.now() - startedAt}`,
    );
    return coordinated.result;
  }

  private async editCoordinated(
    request: {
      readonly mode: 'validate' | 'apply';
      readonly expectedVersion?: string;
      readonly confirmToken?: string;
      readonly items: readonly DaemonMcpEditItem[];
    },
    identity: EnterpriseIdentity,
  ): Promise<{
    result: DaemonMcpEditResult;
    sync?: Promise<DaemonMcpSessionSync>;
    poolTasks?: ReadonlyArray<Promise<void>>;
  }> {
    identity.assertCurrent();
    for (const item of request.items) {
      if (
        (item.op === 'update' || item.op === 'delete') &&
        item.serverId &&
        parseServerId(item.serverId)?.kind === 'enterprise'
      ) {
        this.enterprise.require(
          await this.enterprise.read(identity),
          item.serverId,
        );
        throw new DaemonMcpError(
          'NOT_WRITABLE',
          'Enterprise MCP configuration is managed by your organization.',
        );
      }
    }
    if (request.mode === 'validate') {
      const items = request.items.map((item) => {
        if (item.op === 'create') {
          return {
            configKey: item.configKey,
            config: item.config,
            intent: 'create' as const,
          };
        }
        if (item.op === 'update') {
          const configKey =
            item.configKey ?? configKeyOfServerId(item.serverId);
          return { configKey, config: item.config, intent: 'update' as const };
        }
        throw new DaemonMcpError(
          'INVALID_CONFIG',
          `"validate" accepts only create and update items; got "${item.op}".`,
        );
      });
      return {
        result: {
          mode: 'validate',
          validation: validateUserMcpServers(this.context, items),
        },
      };
    }
    identity.assertCurrent();
    if (
      request.items.some((item) => item.op !== 'set_enabled') &&
      request.expectedVersion === undefined
    )
      throw new DaemonMcpError(
        'INVALID_CONFIG',
        'expected_version is required for create/update/delete batches.',
      );
    const initialVersion = mcpConfigVersion(
      rawUserMcpServers(requireReadable(this.context.readUserSettings())),
    );
    if (
      request.expectedVersion !== undefined &&
      request.expectedVersion !== initialVersion
    )
      throw new DaemonMcpError(
        'VERSION_CONFLICT',
        'MCP settings changed; reload before editing.',
      );
    let version = request.expectedVersion;
    const changedEnterprise: ManagedMcpResource[] = [];
    const changedOrdinary = new Set<string>();
    const poolTasks: Array<Promise<void>> = [];
    const writeContext: DaemonMcpContext = {
      ...this.context,
      syncPool: async () => {
        await this.pool
          .prepareSync()
          .then(({ applying }) => {
            poolTasks.push(applying);
          })
          .catch((error: unknown) => {
            runLogger.warn(
              '[daemon-mcp] pool preparation failed after write',
              error,
            );
          });
      },
    };
    let sync: Promise<DaemonMcpSessionSync> | undefined;
    const results: DaemonMcpEditResultItem[] = [];
    try {
      for (const item of request.items) {
        identity.assertCurrent();
        switch (item.op) {
          case 'create': {
            const result = await createUserMcpServers(writeContext, {
              expectedVersion: version!,
              items: [
                {
                  configKey: item.configKey,
                  config: item.config,
                  ...(item.onConflict ? { onConflict: item.onConflict } : {}),
                },
              ],
              ...(request.confirmToken
                ? { confirmToken: request.confirmToken }
                : {}),
            });
            changedOrdinary.add(item.configKey);
            version = result.configVersion;
            results.push({ op: 'create', ...result.items[0]! });
            break;
          }
          case 'update': {
            const result = await updateUserMcpServer(writeContext, {
              ...targetOf(item.serverId, item.configKey),
              expectedVersion: version!,
              mode: item.mode,
              config: item.config,
            });
            changedOrdinary.add(serverNameOf(result.serverId)!);
            version = result.configVersion;
            results.push({ op: 'update', serverId: result.serverId });
            break;
          }
          case 'delete': {
            const result = await deleteUserMcpServer(writeContext, {
              ...targetOf(item.serverId, item.configKey),
              expectedVersion: version!,
            });
            await this.authorization.settleUserServer(result.deleted);
            const credentialsDeleted = await this.context.deleteCredentials(
              result.deleted,
            );
            changedOrdinary.add(result.deleted);
            version = result.configVersion;
            results.push({
              op: 'delete',
              deleted: result.deleted,
              credentialsDeleted,
            });
            break;
          }
          case 'set_enabled': {
            if (parseServerId(item.serverId)?.kind === 'enterprise') {
              const resource = this.enterprise.require(
                await this.enterprise.read(identity),
                item.serverId,
              );
              await this.enterprise.setEnabled(
                identity,
                resource,
                item.enabled,
              );
              changedEnterprise.push(resource);
              const current = this.enterprise.require(
                await this.enterprise.read(identity),
                item.serverId,
              );
              results.push({
                op: 'set_enabled',
                server: await this.enterprise.describe(this.context, current),
              });
              break;
            }
            const result = await setUserMcpServerEnabled(writeContext, {
              serverId: item.serverId,
              enabled: item.enabled,
              ...(version !== undefined ? { expectedVersion: version } : {}),
            });
            changedOrdinary.add(result.server.configKey);
            version = result.configVersion;
            results.push({ op: 'set_enabled', server: result.server });
            break;
          }
          default:
            throw new DaemonMcpError(
              'INVALID_CONFIG',
              `Unsupported edit operation "${(item as { op: string }).op}".`,
            );
        }
      }
    } finally {
      if (changedEnterprise.length || changedOrdinary.size) {
        identity.assertCurrent();
        const selection = changedEnterprise.length
          ? this.enterprise.select(
              identity,
              await this.enterprise.read(identity),
              changedEnterprise.map(
                (entry) => `enterprise:${entry.sourceId}:${entry.name}`,
              ),
              changedEnterprise,
            )
          : undefined;
        if (selection) {
          await this.enterprise.initialize(
            this.context,
            identity,
            this.onEnterpriseChanged,
          );
          poolTasks.push(
            this.applyEnterprise(
              identity,
              await this.enterprise.read(identity),
              selection.targets,
            ),
          );
        }
        sync = this.sessionSync(false, [...changedOrdinary], {
          // These names were verified by the edit, including newly created ordinary servers.
          targets: selection?.targets ?? [],
          assertCurrent: identity.assertCurrent,
        });
        selection?.commit();
      }
    }
    identity.assertCurrent();
    return {
      result: {
        mode: 'apply',
        configVersion: version ?? initialVersion,
        results,
      },
      sync,
      poolTasks,
    };
  }

  /**
   * Re-reads the user settings and user-level plugins; the pool connects only
   * what was added or changed, then every open session follows (reloading its
   * plugins too when a plugin server changed).
   */
  reload(options?: {
    readonly serverIds?: readonly string[];
  }): Promise<DaemonMcpReloadResult> {
    return this.reloadInternal(options, true);
  }

  private async reloadInternal(
    options: { readonly serverIds?: readonly string[] } | undefined,
    reconnectUnchanged: boolean,
  ): Promise<DaemonMcpReloadResult> {
    const identity = await this.enterprise.capture();
    const coordinated = await this.coordinate(async () => {
      identity.assertCurrent();
      const targets = options?.serverIds?.length
        ? [...new Set(options.serverIds)]
        : undefined;
      for (const id of targets ?? []) {
        if (!parseServerId(id))
          throw new DaemonMcpError(
            'INVALID_CONFIG',
            `Invalid MCP server id "${id}".`,
          );
      }
      await this.enterprise.initialize(
        this.context,
        identity,
        this.onEnterpriseChanged,
      );
      const resources = await this.enterprise.read(identity);
      const enterpriseIds = targets?.filter(
        (id) => parseServerId(id)?.kind === 'enterprise',
      );
      const selection = this.enterprise.select(
        identity,
        resources,
        enterpriseIds,
      );
      const ordinaryIds = reconnectUnchanged
        ? targets?.filter((id) => parseServerId(id)?.kind !== 'enterprise')
        : [];
      const { diff: ordinaryDiff, applying } =
        ordinaryIds?.length === 0
          ? {
              diff: { added: [], removed: [], changed: [], unchanged: [] },
              applying: Promise.resolve(),
            }
          : await this.pool.prepareReload(ordinaryIds);
      if (ordinaryIds) {
        const known = new Set(Object.values(ordinaryDiff).flat());
        const missing = ordinaryIds.find((id) => !known.has(id));
        if (missing)
          throw new DaemonMcpError(
            'NOT_FOUND',
            `MCP server "${missing}" was not found.`,
          );
      }
      identity.assertCurrent();
      const scoped = ordinaryIds
        ? filterPoolDiff(ordinaryDiff, new Set(ordinaryIds))
        : ordinaryDiff;
      const diff = {
        added: [...scoped.added, ...selection.diff.added],
        removed: [...scoped.removed, ...selection.diff.removed],
        changed: [...scoped.changed, ...selection.diff.changed],
        unchanged: [...scoped.unchanged, ...selection.diff.unchanged],
      };
      const plugins = [
        ...scoped.added,
        ...scoped.removed,
        ...scoped.changed,
      ].some((id) => parseServerId(id)?.kind === 'plugin');
      const names = ordinaryIds
        ?.map(serverNameOf)
        .filter((name): name is string => name !== undefined);
      const sync = this.sessionSync(
        plugins,
        names,
        identity.generation || selection.targets.length
          ? {
              targets: targets === undefined ? undefined : selection.targets,
              assertCurrent: identity.assertCurrent,
            }
          : undefined,
      );
      const enterpriseApplying = this.applyEnterprise(
        identity,
        resources,
        targets === undefined ? undefined : selection.targets,
        reconnectUnchanged,
      );
      selection.commit();
      return {
        diff,
        sync,
        applying: Promise.all([applying, enterpriseApplying]).then(() => {}),
      };
    });
    const [sync] = await Promise.all([
      coordinated.sync,
      this.pool.waitForConnections(coordinated.applying),
    ]);
    identity.assertCurrent();
    return { ...coordinated.diff, ...sync };
  }

  // ── authorization ────────────────────────────────────────────────────────

  async auth(request: DaemonMcpAuthRequest): Promise<DaemonMcpAuthResult> {
    const enterprise = parseServerId(request.serverId)?.kind === 'enterprise';
    if (enterprise) await this.ensureEnterpriseRuntime();
    try {
      return await this.authenticate(request);
    } catch (error) {
      if (enterprise) throw safeEnterpriseOperationError(error);
      throw error;
    }
  }

  private authenticate(
    request: DaemonMcpAuthRequest,
  ): Promise<DaemonMcpAuthResult> {
    switch (request.action) {
      case 'start':
        return this.authorization.authenticate(request.serverId, {
          redirectUri: request.redirectUri,
        });
      case 'complete':
        return this.authorization.submitCallback(
          request.serverId,
          request.callbackUrl,
        );
      case 'cancel':
        return Promise.resolve(this.authorization.cancel(request.serverId));
      case 'clear':
        return this.authorization.clear(request.serverId);
      default:
        return Promise.reject(
          new DaemonMcpError(
            'UNSUPPORTED',
            `Unsupported auth action "${(request as { action: string }).action}".`,
          ),
        );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enterprise.dispose();
    if (this.deps.getMcpManager())
      void this.pool.submitEnterprise([], new Set()).catch(() => {});
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = undefined;
    this.eventListeners.clear();
    this.authorization.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private readonly onEnterpriseChanged = () => {
    if (this.disposed) return;
    const previous = this.enterprise.registrations();
    this.enterprise.invalidate(this.context);
    this.cancelRemovedAuthorizations(previous);
    void this.pool
      .submitEnterprise(this.enterprise.registrations(), new Set())
      .catch(() => {});
    void this.reloadInternal(undefined, false).catch((error) =>
      runLogger.warn(
        '[daemon-mcp] enterprise refresh failed',
        enterpriseMcpError(error),
      ),
    );
  };

  private cancelRemovedAuthorizations(
    previous: readonly McpServerRegistration[],
  ): void {
    const active = new Set(
      this.enterprise.registrations().map((r) => mcpServerKeyId(r.key)),
    );
    for (const registration of previous)
      if (!active.has(mcpServerKeyId(registration.key)))
        this.authorization.invalidate(registration.key);
  }

  private applyEnterprise(
    identity: EnterpriseIdentity,
    resources: readonly ManagedMcpResource[],
    targets?: readonly ManagedMcpResource[],
    reconnectUnchanged = true,
  ): Promise<void> {
    const previous = this.enterprise.registrations();
    if (!identity.provider && previous.length === 0) return Promise.resolve();
    if (this.disposed)
      throw new DaemonMcpError(
        'MCP_UNAVAILABLE',
        'MCP management has stopped.',
      );
    const affected = [...this.enterprise.resources(), ...resources];
    const connectOnly = this.enterprise.apply(
      this.context,
      identity,
      resources,
      targets,
      reconnectUnchanged,
    );
    this.cancelRemovedAuthorizations(previous);
    const applying = this.pool.submitEnterprise(
      this.enterprise.registrations(),
      connectOnly,
    );
    for (const id of new Set(affected.map(enterpriseServerId))) {
      for (const listener of this.eventListeners) {
        try {
          listener({ kind: 'status', serverId: id });
        } catch {
          // An observer cannot roll back the already committed management view.
        }
      }
    }
    return applying;
  }

  private async ensureEnterpriseRuntime(): Promise<EnterpriseIdentity> {
    const identity = await this.enterprise.capture();
    await this.coordinate(async () => {
      identity.assertCurrent();
      if (this.disposed)
        throw new DaemonMcpError(
          'MCP_UNAVAILABLE',
          'MCP management has stopped.',
        );
      this.enterprise.invalidate(this.context);
      if (this.enterprise.initialized) return;
      await this.enterprise.initialize(
        this.context,
        identity,
        this.onEnterpriseChanged,
      );
      const resources = await this.enterprise.read(identity);
      void this.applyEnterprise(identity, resources).catch(() => {});
    });
    return identity;
  }

  private coordinate<T>(action: () => Promise<T>): Promise<T> {
    const run = this.coordinationTail.then(() => {
      if (this.disposed)
        throw new DaemonMcpError(
          'MCP_UNAVAILABLE',
          'MCP management has stopped.',
        );
      return action();
    });
    this.coordinationTail = run.catch(() => {});
    return run;
  }

  /** Refreshes every open session, waiting at most the bound. */
  private async sessionSync(
    plugins: boolean,
    serverNames?: readonly string[],
    enterprise?: {
      targets?: readonly ManagedMcpRefreshTarget[];
      assertCurrent: () => void;
    },
  ): Promise<DaemonMcpSessionSync> {
    const startedAt = Date.now();
    runLogger.log(
      `[daemon-mcp] session sync started plugins=${plugins} servers=${serverNames?.length ?? 'all'} enterprise=${enterprise ? 'yes' : 'no'}`,
    );
    const refresh = this.deps
      .refreshSessions({
        plugins,
        ...(enterprise ? { enterprise } : {}),
        ...(serverNames !== undefined ? { serverNames } : {}),
      })
      .catch((error: unknown) => {
        runLogger.warn('[daemon-mcp] refreshing sessions failed', error);
        return undefined;
      });
    const sessions = await waitAtMost(refresh, this.waitMs);
    runLogger.log(
      `[daemon-mcp] session sync finished settled=${sessions !== undefined} sessions=${sessions?.length ?? 0} durationMs=${Date.now() - startedAt}`,
    );
    return {
      sessions: sessions ?? [],
      sessionsSettled: sessions !== undefined,
    };
  }
}

function filterPoolDiff(diff: McpPoolDiff, targets: Set<string>): McpPoolDiff {
  const keep = (serverId: string) => targets.has(serverId);
  return {
    added: diff.added.filter(keep),
    removed: diff.removed.filter(keep),
    changed: diff.changed.filter(keep),
    unchanged: diff.unchanged.filter(keep),
  };
}

function serverNameOf(serverId: string): string | undefined {
  const parsed = parseServerId(serverId);
  if (!parsed) return undefined;
  return parsed.kind === 'user' ? parsed.configKey : parsed.name;
}

function targetOf(
  serverId: string | undefined,
  configKey: string | undefined,
): UserServerTarget {
  if ((serverId === undefined) === (configKey === undefined)) {
    throw new DaemonMcpError(
      'INVALID_CONFIG',
      'exactly one of server_id or config_key is required',
    );
  }
  return serverId !== undefined ? { serverId } : { configKey: configKey! };
}

function configKeyOfServerId(serverId: string | undefined): string {
  const parsed = serverId === undefined ? undefined : parseServerId(serverId);
  if (!parsed || parsed.kind !== 'user') {
    throw new DaemonMcpError(
      'INVALID_CONFIG',
      'config_key is required to update an entry that cannot be loaded',
    );
  }
  return parsed.configKey;
}

async function readCredentials(serverName: string, config?: MCPServerConfig) {
  try {
    const storage = config
      ? MCPOAuthTokenStorage.forServer(serverName, config)
      : new MCPOAuthTokenStorage();
    return await storage.getCredentials(serverName);
  } catch {
    return null;
  }
}

function safeEnterpriseOperationError(error: unknown): DaemonMcpError {
  return new DaemonMcpError(
    error instanceof DaemonMcpError ? error.code : 'RELOAD_FAILED',
    enterpriseMcpError(error),
  );
}
