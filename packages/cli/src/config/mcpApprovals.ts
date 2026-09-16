/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
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

/**
 * Keys are stored normalized so the same project resolves consistently. On
 * Windows, paths are case-insensitive but the entry points that produce a
 * project root disagree on casing: the CLI keeps `process.cwd()` as typed
 * (`D:\project`) while IDE integrations hand over VS Code's
 * `workspaceFolders[0].uri.fsPath`, which lowercases the drive letter
 * (`d:\project`). Fold case on win32 — same convention as
 * `getProjectHash()`/`sanitizeCwd()`. See issue #9775.
 */
function normalizeProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

function isApprovalRecordMap(
  value: unknown,
): value is Record<string, McpApprovalRecord> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A win32 absolute path — drive-letter (`D:\...`) or UNC (`\\server\share`).
 * These are the only stored keys whose case is folded at load time: folding
 * every key would corrupt foreign POSIX paths (e.g. a `~/.qwen` synced from a
 * Linux machine), whose case is significant on the filesystem they belong to.
 */
function isWin32AbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * Merge two per-project records that collided on case after folding. Stored
 * decisions carry no timestamps and file order does not track recency (older
 * builds appended differently-cased keys at the end), so on conflict keep the
 * conservative outcome: a rejection always wins over an approval, never the
 * reverse, so a stale approval cannot silently re-enable a server the user
 * later rejected.
 */
function mergeApprovalRecords(
  existing: Record<string, McpApprovalRecord>,
  incoming: Record<string, McpApprovalRecord>,
): Record<string, McpApprovalRecord> {
  // Use a null-prototype target so a server literally named `__proto__`
  // keeps its decision as an own property: on a normal object the assignment
  // `merged['__proto__'] = record` goes through the Object.prototype setter,
  // the record becomes the map's prototype and JSON.stringify omits it.
  const merged: Record<string, McpApprovalRecord> = Object.assign(
    Object.create(null),
    existing,
  );
  for (const [name, record] of Object.entries(incoming)) {
    // A stored record value can be `null` (corrupted sync / hand edit /
    // format drift). Reading `record.status` would throw and condemn the
    // whole approvals file — every project degrades to pending and the next
    // save rewrites from a near-empty config — so skip non-record values.
    if (!isApprovalRecordMap(record)) {
      continue;
    }
    const current = merged[name];
    if (!current) {
      merged[name] = record;
    } else if (current.status !== record.status) {
      merged[name] = current.status === 'rejected' ? current : record;
    }
  }
  return merged;
}

/**
 * Approvals written by older builds may key a project by a differently-cased
 * path than {@link normalizeProjectRoot} now produces (e.g. an uppercased
 * drive letter recorded by the CLI). Fold stored keys to match at load time so
 * those decisions aren't orphaned; duplicates that differ only in case merge
 * into one entry and are rewritten in normalized form on the next save.
 */
function normalizeStoredProjectKeys(
  config: McpApprovalsConfig,
): McpApprovalsConfig {
  if (os.platform() !== 'win32') {
    return config;
  }
  const normalized: McpApprovalsConfig = Object.create(null);
  for (const [key, value] of Object.entries(config)) {
    // Stored keys are already absolute and separator-normalized; fold case
    // only — re-resolving here could rewrite foreign keys into unrelated
    // local ones, and folding non-win32 keys would corrupt POSIX paths.
    const projectKey = isWin32AbsolutePath(key) ? key.toLowerCase() : key;
    const existing = normalized[projectKey];
    normalized[projectKey] =
      isApprovalRecordMap(existing) && isApprovalRecordMap(value)
        ? mergeApprovalRecords(existing, value)
        : isApprovalRecordMap(value) || !isApprovalRecordMap(existing)
          ? value
          : existing;
  }
  return normalized;
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
    const project: Record<string, McpApprovalRecord> = isApprovalRecordMap(
      existing,
    )
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
        config = normalizeStoredProjectKeys(parsed as McpApprovalsConfig);
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

/**
 * Names of gated servers in `mcpServers` whose state is strictly `pending` —
 * i.e. awaiting a first decision OR a re-decision because a config edit changed
 * the hash their prior decision was bound to. This is what the interactive
 * approval dialog should prompt for.
 *
 * Distinct from {@link getPendingGatedMcpServers}, which is `!== 'approved'` and
 * so also includes `rejected` servers: discovery must keep skipping those, but
 * the dialog must NOT re-prompt them. Using this stricter set to drive the
 * prompt is what lets a config edit re-surface a previously *rejected* server
 * (its hash no longer matches → `pending`) without nagging about a settled
 * rejection. See issue #4615.
 */
export function getPromptableMcpServers(
  mcpServers: Record<string, MCPServerConfig>,
  projectRoot: string,
): string[] {
  const approvals = loadMcpApprovals();
  const promptable: string[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!isGatedMcpScope(config.scope)) {
      continue;
    }
    if (approvals.getState(projectRoot, name, config) === 'pending') {
      promptable.push(name);
    }
  }
  return promptable;
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
