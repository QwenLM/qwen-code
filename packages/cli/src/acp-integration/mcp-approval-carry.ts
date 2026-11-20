/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isGatedMcpScope,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core/config/mcp-server-config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type {
  McpApprovalState,
  McpApprovalStatus,
} from '../config/mcpApprovals.js';
import { PROJECT_MCP_FILENAME } from '../config/mcpJson.js';

/** The subset of `LoadedMcpApprovals` this module needs. */
export interface McpApprovalStore {
  getState(
    projectRoot: string,
    serverName: string,
    config: MCPServerConfig,
  ): McpApprovalState;
  /** Resolves to `false` when the decision could not be persisted. */
  setState(
    projectRoot: string,
    serverName: string,
    config: MCPServerConfig,
    status: McpApprovalStatus,
  ): Promise<boolean>;
}

/** Why a gated server's decision did not follow the session. */
export type McpApprovalCarrySkipReason =
  | 'config-source-missing'
  | 'config-source-changed'
  | 'no-decision';

export interface McpApprovalCarryResult {
  /**
   * Decisions applied to the new directory. A decision may be applied in
   * memory while its persistence failed — see {@link failed}.
   */
  carried: Array<{ server: string; status: McpApprovalStatus }>;
  /** Decisions that could not be made durable, or could not be applied. */
  failed: Array<{ server: string; message: string }>;
  /** Gated servers whose gate state was deliberately left untouched. */
  skipped: Array<{ server: string; reason: McpApprovalCarrySkipReason }>;
}

/**
 * Canonical path of the configuration file that supplies gated servers of
 * `scope` for `dir`, or `undefined` when that file does not exist.
 *
 * A missing file is deliberately not a match: "no configuration here" must
 * never be read as "the same configuration as there".
 */
export function resolveGatedConfigSource(
  dir: string,
  scope: MCPServerConfig['scope'],
): string | undefined {
  if (!isGatedMcpScope(scope)) return undefined;
  const candidate =
    scope === 'project'
      ? path.join(dir, PROJECT_MCP_FILENAME)
      : new Storage(dir).getWorkspaceSettingsPath();
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Carries gated MCP approval decisions from the session's previous working
 * directory to its new one.
 *
 * A decision is carried only when both directories resolve the server's
 * configuration file to the same real path and the stored decision still
 * matches the server config hash. The user reviewed that exact configuration,
 * so changing the session's working directory without changing its source does
 * not create anything new to approve. A different configuration file, an
 * edited config, and an undecided server keep their gate state, and a carried
 * rejection stays a rejection instead of being cleared.
 *
 * Returns what was carried, what was deliberately skipped, and what failed —
 * a `cd` writes a security-relevant decision, so the outcome stays reportable
 * to the caller instead of being silently dropped.
 */
export async function carryGatedMcpApprovals(
  previousCwd: string,
  nextCwd: string,
  servers: Record<string, MCPServerConfig> | undefined,
  approvals: McpApprovalStore,
): Promise<McpApprovalCarryResult> {
  const result: McpApprovalCarryResult = {
    carried: [],
    failed: [],
    skipped: [],
  };
  if (!servers) return result;

  const sourcesByScope = new Map<
    MCPServerConfig['scope'],
    { previous?: string; next?: string }
  >();

  for (const [name, server] of Object.entries(servers)) {
    if (!isGatedMcpScope(server.scope)) continue;

    let sources = sourcesByScope.get(server.scope);
    if (!sources) {
      sources = {
        previous: resolveGatedConfigSource(previousCwd, server.scope),
        next: resolveGatedConfigSource(nextCwd, server.scope),
      };
      sourcesByScope.set(server.scope, sources);
    }
    if (sources.previous === undefined || sources.next === undefined) {
      result.skipped.push({ server: name, reason: 'config-source-missing' });
      continue;
    }
    if (sources.previous !== sources.next) {
      result.skipped.push({ server: name, reason: 'config-source-changed' });
      continue;
    }

    const state = approvals.getState(previousCwd, name, server);
    // `pending` covers both "never decided" and "the config changed since the
    // decision" — neither of those should follow the session.
    if (state === 'pending') {
      result.skipped.push({ server: name, reason: 'no-decision' });
      continue;
    }

    try {
      const persisted = await approvals.setState(nextCwd, name, server, state);
      result.carried.push({ server: name, status: state });
      if (!persisted) {
        result.failed.push({
          server: name,
          message: 'the approval store could not be written',
        });
      }
    } catch (error) {
      result.failed.push({
        server: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * One-line, fail-loud summary of a carry attempt for the daemon's stderr.
 * Returns `undefined` when there was nothing gated to report, so a `cd` in a
 * workspace without gated servers stays quiet.
 */
export function formatMcpApprovalCarryLog(
  sessionId: string | undefined,
  previousCwd: string,
  nextCwd: string,
  result: McpApprovalCarryResult,
): string | undefined {
  if (
    result.carried.length === 0 &&
    result.failed.length === 0 &&
    result.skipped.length === 0
  ) {
    return undefined;
  }
  const carried = result.carried
    .map((entry) => `${entry.server}:${entry.status}`)
    .join(', ');
  const skipped = result.skipped
    .map((entry) => `${entry.server}:${entry.reason}`)
    .join(', ');
  const failed = result.failed
    .map((entry) => `${entry.server}:${entry.message}`)
    .join(', ');
  return (
    `qwen serve: session=${sessionId ?? 'unknown'} cd ` +
    `${previousCwd} -> ${nextCwd}: ` +
    `gated MCP approvals carried=[${carried}] skipped=[${skipped}] failed=[${failed}]`
  );
}
