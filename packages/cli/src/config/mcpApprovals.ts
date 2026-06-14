/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getErrorMessage,
  hashMcpServerConfig,
  isGatedMcpScope,
  Storage,
  atomicWriteFile,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export const MCP_APPROVALS_FILENAME = 'mcpApprovals.json';

/**
 * The user's persisted decision for one project-scoped MCP server. A decision is
 * bound to `hash` — the canonical hash of the exact config the user reviewed. If
 * `.mcp.json` is later edited, the live hash no longer matches and the server is
 * treated as `pending` again (see issue #4615).
 */
export type McpApprovalStatus = 'approved' | 'rejected';

export interface McpApprovalRecord {
  hash: string;
  status: McpApprovalStatus;
}

/** `{ [projectRoot]: { [serverName]: record } }` — user-local, per project. */
export type McpApprovalsConfig = Record<
  string,
  Record<string, McpApprovalRecord>
>;

export type McpApprovalState = McpApprovalStatus | 'pending';

export interface McpApprovalsError {
  message: string;
  path: string;
}

export function getMcpApprovalsPath(): string {
  if (process.env['QWEN_CODE_MCP_APPROVALS_PATH']) {
    return process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
  }
  // Resolve lazily on every call (mirrors getTrustedFoldersPath): a top-level
  // const would be stale after home-env overrides are applied.
  return path.join(Storage.getGlobalQwenDir(), MCP_APPROVALS_FILENAME);
}

/** Keys are stored normalized so the same project resolves consistently. */
function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export class LoadedMcpApprovals {
  constructor(
    readonly file: { path: string; config: McpApprovalsConfig },
    readonly errors: McpApprovalsError[],
  ) {}

  /**
   * Live approval state for a project server. Returns `pending` when there is no
   * stored decision OR when the stored decision was bound to a different config
   * hash (i.e. `.mcp.json` changed since approval). This is the hash-binding
   * that makes a config edit require re-approval.
   */
  getState(
    projectRoot: string,
    serverName: string,
    config: MCPServerConfig,
  ): McpApprovalState {
    const record =
      this.file.config[normalizeProjectRoot(projectRoot)]?.[serverName];
    if (!record) {
      return 'pending';
    }
    if (record.hash !== hashMcpServerConfig(config)) {
      return 'pending';
    }
    return record.status;
  }

  /** Persist an approve/reject decision bound to the current config hash. */
  async setState(
    projectRoot: string,
    serverName: string,
    config: MCPServerConfig,
    status: McpApprovalStatus,
  ): Promise<void> {
    const root = normalizeProjectRoot(projectRoot);
    const existing = this.file.config[root];
    const project: Record<string, McpApprovalRecord> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : Object.create(null);
    Object.defineProperty(project, serverName, {
      value: { hash: hashMcpServerConfig(config), status },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    this.file.config[root] = project;
    await saveMcpApprovals(this.file);
  }
}

let loadedMcpApprovals: LoadedMcpApprovals | undefined;

/** FOR TESTING ONLY. Resets the in-memory cache. */
export function resetMcpApprovalsForTesting(): void {
  loadedMcpApprovals = undefined;
}

export function loadMcpApprovals(): LoadedMcpApprovals {
  if (loadedMcpApprovals) {
    return loadedMcpApprovals;
  }

  const errors: McpApprovalsError[] = [];
  let config: McpApprovalsConfig = {};
  const filePath = getMcpApprovalsPath();

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(stripJsonComments(content));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        errors.push({
          message: 'MCP approvals file is not a valid JSON object.',
          path: filePath,
        });
      } else {
        config = parsed as McpApprovalsConfig;
      }
    }
  } catch (error: unknown) {
    errors.push({ message: getErrorMessage(error), path: filePath });
  }

  loadedMcpApprovals = new LoadedMcpApprovals(
    { path: filePath, config },
    errors,
  );
  for (const error of errors) {
    writeStderrLine(`Warning: MCP approvals file error: ${error.message}`);
  }
  return loadedMcpApprovals;
}

/**
 * Names of gated servers in `mcpServers` that are NOT approved (pending or
 * rejected) for `projectRoot`. Only checked-in / shareable scopes are gated —
 * project `.mcp.json` and workspace `.qwen/settings.json` (see
 * {@link isGatedMcpScope}); user/system/extension servers are ignored. The
 * returned list is what the discovery layer skips
 * (`Config.isMcpServerPendingApproval`). See issue #4615.
 */
export function getPendingGatedMcpServers(
  mcpServers: Record<string, MCPServerConfig>,
  projectRoot: string,
): string[] {
  const approvals = loadMcpApprovals();
  const pending: string[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isGatedMcpScope(config.scope)) {
      continue;
    }
    if (approvals.getState(projectRoot, name, config) !== 'approved') {
      pending.push(name);
    }
  }
  return pending;
}

export async function saveMcpApprovals(file: {
  path: string;
  config: McpApprovalsConfig;
}): Promise<void> {
  try {
    const dirPath = path.dirname(file.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    await atomicWriteFile(file.path, JSON.stringify(file.config, null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    writeStderrLine('Error saving MCP approvals file.');
    writeStderrLine(error instanceof Error ? error.message : String(error));
  }
}
