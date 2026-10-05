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

export interface AgentHostRestoreRuntime {
  bridge: AcpSessionBridge;
  workspaceCwd: string;
  generationGuard?: WorkspaceGenerationGuard;
}

/**
 * Re-establishes, in the background, every saved connection for this
 * runtime's workspace whose credential still exists; a record whose
 * credential is gone (revoked) is pruned. A coordinator that is down is
 * retried every 30 s until it answers or this runtime closes. Never throws.
 */
export async function restoreAgentHostConnections(
  runtime: AgentHostRestoreRuntime,
  retryMs = RESTORE_RETRY_MS,
): Promise<void> {
  const { hasAgentHostCredential, startAgentHostConnection } = await import(
    './agent-host-client.js'
  );
  const records = (await readAgentHostConnections()).filter(
    (record) => record.workspaceCwd === runtime.workspaceCwd,
  );
  for (const record of records) {
    void (async () => {
      for (;;) {
        if (runtime.generationGuard?.closed) return;
        if (!(await hasAgentHostCredential(record))) {
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
          return;
        } catch (error) {
          writeStderrLine(
            `qwen serve: could not reconnect to ${record.serverUrl}; retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // TODO(multi-agent): a connection that drops after it was up is
        // retried by its own heartbeat loop; only the first contact is
        // retried here.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          timer.unref?.();
        });
      }
    })();
  }
}
