/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import {
  clearAllPluginCaches,
  mcpServerKeyId,
  runLogger,
  type McpManager,
  type McpServerRegistration,
  type PluginManagerFactory,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { collectDaemonUserMcpRegistrations } from '../../../mcp/framework.js';
import { requireManager } from './context.js';
import { DaemonMcpError } from './errors.js';
import { serverIdOf } from './serverIds.js';
import { requireReadable } from './userSettings.js';
import { waitAtMost } from './waitAtMost.js';

/** Server ids by what a reload changed in the pool's user-level set. */
export interface McpPoolDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
  readonly unchanged: string[];
}

export interface UserPoolSyncDeps {
  getMcpManager(): McpManager | undefined;
  readUserSettings(): LoadedSettings;
  /** What the pool was given at startup: the baseline of the first diff. */
  startupServers(): readonly McpServerRegistration[];
  /** How long a caller waits for the pool to connect what changed. */
  readonly waitMs: number;
  /** The product's plugin manager factory; without it, product plugins are skipped. */
  readonly pluginManagerFactory?: PluginManagerFactory;
}

/**
 * Keeps the pool's user-level set (user settings entries and the MCP of
 * user-level plugins) in line with the settings: added or enabled servers
 * connect, changed ones reconnect, removed or disabled ones are released once
 * no session uses them, unchanged ones are left alone. Syncs run one after
 * another.
 */
export class UserPoolSync {
  private queue: Promise<unknown> = Promise.resolve();
  private enterprise: readonly McpServerRegistration[] = [];
  private applied: readonly McpServerRegistration[] | undefined;

  constructor(private readonly deps: UserPoolSyncDeps) {}

  /** The latest coordinated user-level registrations, possibly still connecting. */
  registrations(): readonly McpServerRegistration[] {
    return this.applied ?? this.deps.startupServers();
  }

  submitEnterprise(
    servers: readonly McpServerRegistration[],
    connectOnly: ReadonlySet<string>,
  ): Promise<void> {
    this.enterprise = servers;
    const ordinary = this.registrations().filter(
      (r) => !r.key.source.startsWith('managed-admin:'),
    );
    return this.submit([...ordinary, ...servers], connectOnly);
  }

  private submit(
    servers: readonly McpServerRegistration[],
    connectOnly: ReadonlySet<string>,
  ): Promise<void> {
    this.applied = servers;
    const applying = requireManager(this.deps)
      .reloadUserMcpServers(servers, undefined, connectOnly, connectOnly)
      .then(() => {});
    void applying.catch((error) =>
      runLogger.warn('[daemon-mcp] pool sync failed', error),
    );
    return applying;
  }

  /** Resolves once the pool has followed, or after the wait bound. */
  async sync(): Promise<void> {
    await this.waitForConnections(
      this.enqueue(false).then(({ applying }) => applying),
    );
  }

  /**
   * The same sync from fresh plugin data, reporting what changed against what
   * the pool was last given. The diff is final even if connecting is still
   * under way when the wait bound passes.
   */
  async reload(targets?: readonly string[]): Promise<McpPoolDiff> {
    const { diff, applying } = await this.prepareReload(targets);
    await this.waitForConnections(applying);
    return diff;
  }

  prepareSync(): Promise<{ diff: McpPoolDiff; applying: Promise<void> }> {
    return this.enqueue(false);
  }

  prepareReload(
    targets?: readonly string[],
  ): Promise<{ diff: McpPoolDiff; applying: Promise<void> }> {
    const targetIds =
      targets !== undefined && targets.length > 0
        ? new Set(targets)
        : undefined;
    return this.enqueue(true, targetIds);
  }

  /**
   * Queues one sync. Settles once the diff is known; `applying` settles when
   * the pool has followed. Only actual connection mutations wait for it.
   */
  private enqueue(
    fresh: boolean,
    targets?: ReadonlySet<string>,
  ): Promise<{ diff: McpPoolDiff; applying: Promise<void> }> {
    const run = this.queue.then(async () => {
      requireManager(this.deps);
      if (fresh) clearAllPluginCaches();
      // A file that cannot be read never tears servers down.
      const settings = requireReadable(this.deps.readUserSettings());
      const next = await collectDaemonUserMcpRegistrations(settings, {
        factory: this.deps.pluginManagerFactory,
      });
      // Syncing without the plugins would release their servers.
      if (!next) {
        throw new DaemonMcpError(
          'RELOAD_FAILED',
          'User-level plugins could not be loaded; nothing was changed.',
        );
      }
      const diff = diffRegistrations(
        this.registrations().filter(
          (r) => !r.key.source.startsWith('managed-admin:'),
        ),
        next,
      );
      // Daemon server ids are not pool ids; map the requested targets onto
      // the pool keys so only those connections are awaited.
      const waitFor =
        targets === undefined
          ? undefined
          : new Set(
              next
                .filter((registration) => targets.has(serverIdOf(registration)))
                .map((registration) => mcpServerKeyId(registration.key)),
            );
      // Computing the next view must not wait for a previous connection.
      // The pool serializes each key; publishing ownership cannot wait for a slow connection.
      // A write sync only applies what the diff names. Re-awaiting an
      // unchanged server would queue behind another caller's in-flight
      // handshake and make a single toggle wait on an unrelated connection.
      const connectIds =
        targets !== undefined
          ? (waitFor ?? new Set<string>())
          : fresh
            ? new Set(next.map((r) => mcpServerKeyId(r.key)))
            : new Set(
                next
                  .filter(
                    (registration) =>
                      diff.added.includes(serverIdOf(registration)) ||
                      diff.changed.includes(serverIdOf(registration)),
                  )
                  .map((registration) => mcpServerKeyId(registration.key)),
              );
      const applying = this.submit(
        [...next, ...this.enterprise],
        connectIds,
      );
      runLogger.log(
        `[daemon-mcp] pool sync prepared fresh=${fresh} targets=${targets?.size ?? 'none'} added=${diff.added.length} changed=${diff.changed.length} removed=${diff.removed.length} connect=${connectIds.size}`,
      );
      return { diff, applying };
    });
    this.queue = run.catch((error: unknown) => {
      runLogger.warn('[daemon-mcp] pool preparation failed', error);
    });
    return run;
  }

  async waitForConnections(work: Promise<void>): Promise<void> {
    const startedAt = Date.now();
    const done = await waitAtMost(
      work.then(
        () => true,
        () => true,
      ),
      this.deps.waitMs,
    );
    runLogger.log(
      `[daemon-mcp] pool wait finished settled=${done} durationMs=${Date.now() - startedAt}`,
    );
    if (!done) {
      runLogger.log(
        `[daemon-mcp] pool sync still running after ${this.deps.waitMs}ms; not waiting`,
      );
    }
  }
}

/**
 * What changed between two user-level sets, by `serverId`: a plugin server
 * whose config changed has a new pool key but is the same server. `scope` is
 * runtime-only metadata and is ignored, as the pool does.
 */
function diffRegistrations(
  previous: readonly McpServerRegistration[],
  next: readonly McpServerRegistration[],
): McpPoolDiff {
  const before = new Map(previous.map((r) => [serverIdOf(r), r]));
  const after = new Set(next.map(serverIdOf));
  const diff: McpPoolDiff = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
  };
  for (const registration of next) {
    const serverId = serverIdOf(registration);
    const old = before.get(serverId);
    const bucket = !old
      ? diff.added
      : sameRegistration(old, registration)
        ? diff.unchanged
        : diff.changed;
    bucket.push(serverId);
  }
  for (const serverId of before.keys()) {
    if (!after.has(serverId)) diff.removed.push(serverId);
  }
  return diff;
}

function sameRegistration(
  left: McpServerRegistration,
  right: McpServerRegistration,
): boolean {
  const { scope: _left, ...leftConfig } = left.config;
  const { scope: _right, ...rightConfig } = right.config;
  return (
    left.rootsDir === right.rootsDir &&
    isDeepStrictEqual(leftConfig, rightConfig)
  );
}
