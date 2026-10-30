/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Connections made through `POST …/hosts/connect`, persisted.
 *
 * The credential of a joined Host already survives a restart; this record is
 * what says "reconnect on boot". It sits next to the credentials in
 * `~/.qwen/agent-hosts/connections.json` (0600), and holds no secret.
 * Several daemons on one machine share it, so writes are locked.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

export interface AgentHostConnectionRecord {
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  allowHttp: boolean;
}

interface ConnectionsFile {
  schemaVersion: 1;
  connections: AgentHostConnectionRecord[];
}

export function agentHostConnectionsPath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'agent-hosts',
    'connections.json',
  );
}

function isRecord(value: unknown): value is AgentHostConnectionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['serverUrl'] === 'string' &&
    typeof entry['workspaceId'] === 'string' &&
    typeof entry['workspaceCwd'] === 'string' &&
    typeof entry['allowHttp'] === 'boolean'
  );
}

type ConnectionKey = Pick<
  AgentHostConnectionRecord,
  'serverUrl' | 'workspaceId' | 'workspaceCwd'
>;

function sameConnection(a: ConnectionKey, b: ConnectionKey): boolean {
  return (
    a.serverUrl === b.serverUrl &&
    a.workspaceId === b.workspaceId &&
    a.workspaceCwd === b.workspaceCwd
  );
}

/** Every saved connection; an unreadable file reads as none. */
export async function readAgentHostConnections(): Promise<
  AgentHostConnectionRecord[]
> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(agentHostConnectionsPath(), 'utf8'),
    ) as Partial<ConnectionsFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.connections)) {
      return [];
    }
    return parsed.connections.filter(isRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeStderrLine(
        `qwen serve: ignoring unreadable ${agentHostConnectionsPath()}.`,
      );
    }
    return [];
  }
}

async function updateConnections(
  mutate: (
    connections: AgentHostConnectionRecord[],
  ) => AgentHostConnectionRecord[],
): Promise<void> {
  const filePath = agentHostConnectionsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(filePath, {
    realpath: false,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
  });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    const next: ConnectionsFile = {
      schemaVersion: 1,
      connections: mutate(await readAgentHostConnections()),
    };
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await release().catch(() => undefined);
  }
}

export async function saveAgentHostConnection(
  record: AgentHostConnectionRecord,
): Promise<void> {
  await updateConnections((connections) => [
    ...connections.filter((entry) => !sameConnection(entry, record)),
    record,
  ]);
}

/** Returns true when a record was removed. */
export async function removeAgentHostConnection(
  target: ConnectionKey,
): Promise<boolean> {
  let removed = false;
  await updateConnections((connections) => {
    const kept = connections.filter((entry) => !sameConnection(entry, target));
    removed = kept.length !== connections.length;
    return kept;
  });
  return removed;
}

const RESTORE_RETRY_MS = 30_000;
/** How often a restored connection checks that it is still up. */
const RESTORE_WATCH_MS = 5_000;

export interface AgentHostRestoreRuntime {
  bridge: AcpSessionBridge;
  workspaceCwd: string;
  generationGuard?: WorkspaceGenerationGuard;
}

export interface AgentHostRestoreOptions {
  /**
   * The trusted, active runtime serving `workspaceCwd` right now, or
   * undefined (not registered, not trusted, or between generations).
   */
  runtimeFor(workspaceCwd: string): AgentHostRestoreRuntime | undefined;
  /** Stops every restore loop. */
  signal?: AbortSignal;
  retryMs?: number;
  watchMs?: number;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return delay(ms, undefined, { ref: false, signal }).catch(() => undefined);
}

/**
 * Keeps every saved connection up, for every workspace this daemon serves,
 * in the background. Each record waits until its workspace has a trusted
 * active runtime (a workspace registered or trusted later is picked up on
 * the next check, every 5 s), connects, and connects again when that
 * runtime is replaced or the connection stops. A coordinator that is down is
 * retried every 30 s. A record whose credential is gone (revoked) is pruned; a
 * record that was removed (`DELETE hosts/connect`) is let go. Never throws.
 */
export async function restoreAgentHostConnections(
  options: AgentHostRestoreOptions,
): Promise<void> {
  const {
    hasAgentHostCredential,
    isAgentHostConnectionRunning,
    startAgentHostConnection,
  } = await import('./agent-host-client.js');
  const retryMs = options.retryMs ?? RESTORE_RETRY_MS;
  const watchMs = options.watchMs ?? RESTORE_WATCH_MS;
  const { signal } = options;
  const keep = async (saved: AgentHostConnectionRecord) => {
    while (!signal?.aborted) {
      const record = (await readAgentHostConnections()).find((entry) =>
        sameConnection(entry, saved),
      );
      if (!record || signal?.aborted) return;
      const runtime = options.runtimeFor(record.workspaceCwd);
      if (runtime && !runtime.generationGuard?.closed) {
        const credential = await hasAgentHostCredential(record);
        if (signal?.aborted) return;
        if (credential === undefined) {
          // Unreadable is not revoked: keep the record and try again later.
          writeStderrLine(
            `qwen serve: could not read the Agent Host credential for ${record.serverUrl}; retrying.`,
          );
          await pause(retryMs, signal);
          continue;
        }
        if (!credential) {
          await removeAgentHostConnection(record).catch(() => undefined);
          writeStderrLine(
            `qwen serve: dropped the saved Agent Host connection to ${record.serverUrl} (no credential).`,
          );
          return;
        }
        try {
          await startAgentHostConnection({
            ...record,
            bridge: runtime.bridge,
            workspaceCwd: runtime.workspaceCwd,
            ...(runtime.generationGuard
              ? { generationGuard: runtime.generationGuard }
              : {}),
          });
          if (signal?.aborted) return;
          // Up. Watch it: a replaced runtime (trust change, re-registration)
          // closes this generation, and the connection stops with it.
          while (
            !signal?.aborted &&
            !runtime.generationGuard?.closed &&
            isAgentHostConnectionRunning(record)
          ) {
            await pause(watchMs, signal);
          }
        } catch (error) {
          writeStderrLine(
            `qwen serve: could not reconnect to ${record.serverUrl}; retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
          await pause(retryMs, signal);
          continue;
        }
      }
      // No usable runtime yet, or the connection just stopped: look again
      // soon, never in a tight loop.
      await pause(watchMs, signal);
    }
  };
  // One loop per saved connection. The file is read again every watch tick,
  // so a record saved after boot (`qwen agents join` against this running
  // daemon) is supervised too, instead of only on the next restart.
  const supervised = new Set<string>();
  const supervise = (record: AgentHostConnectionRecord) => {
    const key = `${record.serverUrl}\0${record.workspaceId}\0${record.workspaceCwd}`;
    if (supervised.has(key)) return;
    supervised.add(key);
    void keep(record)
      .catch((error: unknown) =>
        writeStderrLine(
          `qwen serve: stopped restoring the Agent Host connection to ${record.serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => supervised.delete(key));
  };
  for (const record of await readAgentHostConnections()) supervise(record);
  void (async () => {
    while (!signal?.aborted) {
      await pause(watchMs, signal);
      if (signal?.aborted) return;
      const records = await readAgentHostConnections().catch(
        (): AgentHostConnectionRecord[] => [],
      );
      for (const record of records) supervise(record);
    }
  })();
}
