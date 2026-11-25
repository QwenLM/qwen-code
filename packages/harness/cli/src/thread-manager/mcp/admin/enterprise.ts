/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isManagedMcpEnabled,
  MCP_ENTERPRISE_SOURCE,
  expandMcpEnvVars,
  Storage,
  mcpServerKeyId,
  type McpServerRegistration,
  type McpServerKey,
  type McpServerGate,
  managedMcpRefreshNames,
  MCPServerStatus,
  type ManagedMcpResource,
  type ManagedResourcesProvider,
} from '@qwen-code/core';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import stableStringify from 'json-stable-stringify';
import type { ResolvedMcpServer } from './queries.js';
import { requireManager, type DaemonMcpContext } from './context.js';
import { DaemonMcpError } from './errors.js';
import type { McpServerSummary } from './queries.js';
import type { McpPoolDiff } from './poolSync.js';

export function enterpriseServerId(resource: ManagedMcpResource): string {
  return `enterprise:${resource.sourceId}:${resource.name}`;
}

export interface EnterpriseIdentity {
  readonly provider: ManagedResourcesProvider | undefined;
  readonly generation: string | undefined;
  assertCurrent(): void;
}

/** Cache snapshots describe coordinated changes, never the last list request. */
export class EnterpriseMcpAdmin {
  private generation: string | undefined;
  private identity: EnterpriseIdentity | undefined;
  private view = new Map<string, ManagedMcpResource>();
  private active = new Map<string, McpServerRegistration>();
  private gate: McpServerGate | undefined;
  private gateReady: Promise<void> | undefined;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;

  get initialized(): boolean {
    return this.identity !== undefined;
  }

  async initialize(
    context: DaemonMcpContext,
    identity: EnterpriseIdentity,
    onChanged: () => void,
  ): Promise<void> {
    if (!identity.provider) return;
    if (!this.gateReady) {
      const manager = requireManager(context);
      await manager.ready?.();
      if (this.disposed)
        throw new DaemonMcpError(
          'MCP_UNAVAILABLE',
          'MCP management has stopped.',
        );
      this.gate = manager.createManagementGate();
      this.gateReady = (this.gate?.initialize?.() ?? Promise.resolve()).then(
        () => {
          if (!this.disposed) this.gate?.start?.(onChanged);
        },
      );
    }
    await this.gateReady;
    if (this.disposed)
      throw new DaemonMcpError(
        'MCP_UNAVAILABLE',
        'MCP management has stopped.',
      );
    identity.assertCurrent();
    if (identity.provider !== this.identity?.provider) {
      this.unsubscribe?.();
      this.unsubscribe = identity.provider?.subscribeMcpChanges?.(onChanged);
    }
  }

  resources(): readonly ManagedMcpResource[] {
    return [...this.view.values()];
  }
  registrations(): readonly McpServerRegistration[] {
    return [...this.active.values()];
  }

  apply(
    context: DaemonMcpContext,
    identity: EnterpriseIdentity,
    resources: readonly ManagedMcpResource[],
    targets?: readonly ManagedMcpResource[],
    reconnectUnchanged = true,
  ): ReadonlySet<string> {
    identity.assertCurrent();
    const names = targets
      ? new Set(targets.map((entry) => entry.name))
      : undefined;
    const identityChanged = this.identity?.generation !== identity.generation;
    const next =
      identityChanged || !names
        ? resources
        : [
            ...this.resources().filter((entry) => !names.has(entry.name)),
            ...resources.filter((entry) => names.has(entry.name)),
          ];
    this.identity = identity;
    this.view = new Map(
      next.map((entry) => [enterpriseServerId(entry), entry]),
    );
    const previous = this.active;
    this.active = new Map();
    const connect = new Set<string>();
    for (const resource of next) {
      if (!isManagedMcpEnabled(resource) || !this.allowed(context, resource))
        continue;
      const registration = this.registration(resource);
      const id = enterpriseServerId(resource);
      this.active.set(id, registration);
      if (
        (reconnectUnchanged && (!names || names.has(resource.name))) ||
        identityChanged ||
        !isDeepStrictEqual(previous.get(id), registration)
      )
        connect.add(mcpServerKeyId(registration.key));
    }
    return connect;
  }

  /** Policy and identity revocation is synchronous; do not wait behind a connection. */
  invalidate(context: DaemonMcpContext): void {
    try {
      this.identity?.assertCurrent();
    } catch {
      this.view.clear();
      this.active.clear();
      this.identity = undefined;
      return;
    }
    for (const id of this.active.keys()) {
      const resource = this.view.get(id)!;
      if (!isManagedMcpEnabled(resource) || !this.allowed(context, resource))
        this.active.delete(id);
    }
  }

  resolve(
    context: DaemonMcpContext,
    id: string,
    allowDisabled = false,
    access: 'detail' | 'manage' = 'manage',
  ): ResolvedMcpServer {
    this.identity?.assertCurrent();
    const resource = this.require(this.resources(), id, access);
    const enabled = isManagedMcpEnabled(resource);
    if (!allowDisabled && !enabled)
      throw new DaemonMcpError(
        'DISABLED',
        'Enterprise MCP server is disabled.',
      );
    if (!allowDisabled && !this.allowed(context, resource))
      throw new DaemonMcpError(
        'NOT_WRITABLE',
        'Enterprise MCP server is blocked by policy.',
      );
    const registration = this.registration(resource);
    const generation = this.identity?.generation;
    return {
      key: registration.key,
      name: resource.name,
      source: 'enterprise',
      config: registration.config,
      enabled,
      describe: () => this.describe(context, resource),
      assertCurrent: () => {
        this.identity?.assertCurrent();
        if (
          this.identity?.generation !== generation ||
          !this.active.has(id) ||
          mcpServerKeyId(this.active.get(id)!.key) !==
            mcpServerKeyId(registration.key) ||
          !this.allowed(context, resource)
        )
          throw new DaemonMcpError(
            'IDENTITY_CHANGED',
            'Enterprise MCP authorization is no longer current.',
          );
      },
    };
  }

  serverId(key: McpServerKey): string | undefined {
    return [...this.active].find(
      ([, registration]) =>
        mcpServerKeyId(registration.key) === mcpServerKeyId(key),
    )?.[0];
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.gate?.stop?.();
    this.active.clear();
    this.view.clear();
    this.identity = undefined;
  }

  private allowed(
    context: DaemonMcpContext,
    resource: ManagedMcpResource,
  ): boolean {
    const settings = context.readUserSettings().user.settings;
    return (
      this.gate?.evaluate({
        config: this.registration(resource).config,
        serverName: resource.name,
        permissionAliases: [resource.originalName],
        allowList: settings.mcp?.allowed ?? [],
        excludeList: settings.mcp?.excluded ?? [],
      }).allowed ?? true
    );
  }

  private registration(resource: ManagedMcpResource): McpServerRegistration {
    const rootsDir = resource.rootsDir ?? Storage.getGlobalConfigDir();
    const config = {
      ...resource.config,
      ...(resource.config.command
        ? {
            command: expandMcpEnvVars(resource.config.command, process.env),
            cwd: resource.config.cwd ?? rootsDir,
          }
        : {}),
      ...(resource.config.url
        ? { url: expandMcpEnvVars(resource.config.url, process.env) }
        : {}),
      ...(resource.config.httpUrl
        ? { httpUrl: expandMcpEnvVars(resource.config.httpUrl, process.env) }
        : {}),
      [MCP_ENTERPRISE_SOURCE]: resource.sourceId,
    };
    const fingerprint = createHash('sha256')
      .update(stableStringify([config, rootsDir]) ?? '')
      .digest('hex');
    return {
      key: {
        source: `managed-admin:${resource.sourceId}:${fingerprint}`,
        name: resource.name,
      },
      config,
      rootsDir,
    };
  }

  private baseline = new Map<string, ManagedMcpResource>();

  constructor(
    private readonly getProvider?: () => Promise<
      ManagedResourcesProvider | undefined
    >,
  ) {}

  async capture(): Promise<EnterpriseIdentity> {
    const provider = await this.getProvider?.();
    const generation = provider?.getIdentityGeneration?.();
    return {
      provider,
      generation,
      assertCurrent: () => {
        if (generation !== provider?.getIdentityGeneration?.())
          throw new DaemonMcpError(
            'IDENTITY_CHANGED',
            'Enterprise identity changed; retry the operation.',
          );
      },
    };
  }

  async read(
    identity: EnterpriseIdentity,
  ): Promise<readonly ManagedMcpResource[]> {
    identity.assertCurrent();
    const resources = identity.generation
      ? await identity.provider!.readMcpServers().catch(rethrowEnterpriseError)
      : [];
    identity.assertCurrent();
    return resources;
  }

  require(
    resources: readonly ManagedMcpResource[],
    id: string,
    access: 'detail' | 'manage' = 'manage',
  ): ManagedMcpResource {
    const resource = resources.find(
      (entry) =>
        (access === 'detail' || entry.userVisible) &&
        enterpriseServerId(entry) === id,
    );
    if (!resource)
      throw new DaemonMcpError(
        'NOT_FOUND',
        `Enterprise MCP server "${id}" was not found.`,
      );
    return resource;
  }

  async describe(
    context: DaemonMcpContext,
    resource: ManagedMcpResource,
  ): Promise<McpServerSummary> {
    this.identity?.assertCurrent();
    const enabled = isManagedMcpEnabled(resource);
    const blocked = enabled && !this.allowed(context, resource);
    const registration = this.registration(resource);
    const client = context.getMcpManager()?.getClient(registration.key);
    const status = !enabled
      ? MCPServerStatus.DISABLED
      : blocked
        ? MCPServerStatus.BLOCKED
        : (client?.getStatus() ?? MCPServerStatus.DISCONNECTED);
    const error = blocked
      ? 'This MCP server is blocked by policy. Contact your administrator.'
      : status === MCPServerStatus.DISCONNECTED ||
          status === MCPServerStatus.AUTH_REQUIRED
        ? client?.getLastConnectError()
        : undefined;
    return {
      serverId: enterpriseServerId(resource),
      configKey: resource.name,
      source: 'enterprise',
      displayName: resource.displayName,
      originalName: resource.originalName,
      canDisable:
        resource.userVisible &&
        resource.userCanDisable &&
        !resource.config.disabled,
      writable: false,
      config: {},
      enabled,
      transport: resource.config.command
        ? 'stdio'
        : resource.config.type === 'sse'
          ? 'sse'
          : 'http',
      authMethod: context.authMethodOf?.(resource.config) ?? 'none',
      status,
      ...(error
        ? { error: blocked ? String(error) : enterpriseMcpError(error) }
        : {}),
      hasCredentials: await context.hasCredentials(
        resource.name,
        registration.config,
      ),
    };
  }

  async setEnabled(
    identity: EnterpriseIdentity,
    resource: ManagedMcpResource,
    enabled: boolean,
  ): Promise<void> {
    identity.assertCurrent();
    if (!resource.userCanDisable || resource.config.disabled)
      throw new DaemonMcpError(
        'NOT_WRITABLE',
        'This MCP server is controlled by your organization.',
      );
    try {
      await identity.provider!.setMcpServerEnabled(resource, enabled);
    } catch (error) {
      rethrowEnterpriseError(error);
    }
    identity.assertCurrent();
  }

  select(
    identity: EnterpriseIdentity,
    resources: readonly ManagedMcpResource[],
    ids?: readonly string[],
    written: readonly ManagedMcpResource[] = [],
  ) {
    identity.assertCurrent();
    if (this.generation !== identity.generation) {
      this.baseline.clear();
      this.generation = identity.generation;
    }
    const visible = new Map(
      resources
        .filter((entry) => entry.userVisible)
        .map((entry) => [enterpriseServerId(entry), entry]),
    );
    const committed =
      this.identity?.generation === identity.generation ? this.resources() : [];
    const all = new Map([
      ...committed
        .filter((entry) => entry.userVisible)
        .map((entry) => [enterpriseServerId(entry), entry] as const),
      ...written.map((entry) => [enterpriseServerId(entry), entry] as const),
      ...this.baseline,
      ...visible,
    ]);
    const selected = ids ?? [...all.keys()];
    for (const id of selected) {
      if (!all.has(id))
        throw new DaemonMcpError(
          'NOT_FOUND',
          `Enterprise MCP server "${id}" was not found.`,
        );
    }
    const names = managedMcpRefreshNames(
      [...committed, ...this.baseline.values()],
      resources,
      selected.flatMap((id) => {
        const r = all.get(id)!;
        return [r.name, r.originalName];
      }),
    );
    const targets = [
      ...new Map(
        [...committed, ...written, ...this.baseline.values(), ...resources]
          .filter((entry) => names.has(entry.name))
          .map((entry) => [
            JSON.stringify([entry.name, entry.originalName]),
            entry,
          ]),
      ).values(),
    ];
    const affected = new Set(targets.map(enterpriseServerId));
    const diff: { [K in keyof McpPoolDiff]: string[] } = {
      added: [],
      removed: [],
      changed: [],
      unchanged: [],
    };
    for (const id of affected) {
      const old = this.baseline.get(id);
      const next = visible.get(id);
      if (!old && !next) continue;
      diff[
        !old
          ? 'added'
          : !next
            ? 'removed'
            : isDeepStrictEqual(old, next)
              ? 'unchanged'
              : 'changed'
      ].push(id);
    }
    return {
      diff,
      targets,
      commit: () => {
        identity.assertCurrent();
        for (const id of affected) {
          const next = visible.get(id);
          if (next) this.baseline.set(id, next);
          else this.baseline.delete(id);
        }
      },
    };
  }
}

function rethrowEnterpriseError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (
    code === 'NOT_FOUND' ||
    code === 'NOT_WRITABLE' ||
    code === 'IDENTITY_CHANGED'
  )
    throw new DaemonMcpError(code, (error as Error).message);
  if (
    (error as Error & { cause?: { code?: string } }).cause?.code === 'ELOCKED'
  )
    throw new DaemonMcpError(
      'BUSY',
      'Enterprise settings are busy; retry the operation.',
    );
  throw error;
}

/** Enterprise wire errors never include remote bodies, stderr, URLs or credentials. */
export function enterpriseMcpError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ECONNREFUSED': return 'MCP connection refused (ECONNREFUSED).';
    case 'ETIMEDOUT': return 'MCP connection timed out (ETIMEDOUT).';
    case 'ENOTFOUND': return 'MCP host could not be resolved (ENOTFOUND).';
    case 'ENOENT': return 'MCP executable or working directory was not found (ENOENT).';
    default: return 'Enterprise MCP operation failed. Check the server configuration or authorization.';
  }
}
