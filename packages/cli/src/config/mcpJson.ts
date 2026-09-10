/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type MCPServerConfig,
  normalizeClaudeMcpServer,
} from '@qwen-code/qwen-code-core';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import stripJsonComments from 'strip-json-comments';

/** Project-scoped MCP config filename, read from the workspace root. */
export const PROJECT_MCP_FILENAME = '.mcp.json';

/**
 * Fields expanded for `$VAR` / `${VAR}`. An allowlist, not a denylist: metadata
 * (`description`, `extensionName`, `includeTools`, …) is left verbatim.
 * `authProviderType` is excluded on purpose — it selects a provider from a
 * fixed enum (`google_credentials`, …), a constant rather than a per-environment
 * value, so a placeholder there gains nothing.
 */
const ENV_EXPANDED_TRANSPORT_FIELDS = [
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'httpUrl',
  'headers',
  'tcp',
  'oauth',
  'targetAudience',
  'targetServiceAccount',
] as const;

/**
 * Nesting cap for one server entry. `resolveEnvVarsInObject` and the
 * `JSON.stringify` in `hashMcpServerConfig` both recurse, and overflow well
 * below this on hostile input. Depth is counted from the server entry itself
 * (entry = 1), so each consumer's recursion is bounded relative to where it
 * starts: `parseMcpConfig` hands the resolver the whole map of servers, one
 * level above the entry, so cap + 1; `hashMcpServerConfig` stringifies the
 * entry, so cap; `resolveTransportEnvVars` hands the resolver one field of the
 * entry, so cap − 1.
 */
export const MAX_MCP_SERVER_CONFIG_DEPTH = 64;

/**
 * Whether `root` nests objects/arrays deeper than `maxDepth`. Input is always
 * `JSON.parse` output, i.e. a finite tree. Iterative because a recursive probe
 * would overflow on the input it exists to reject; a cycle, were one ever
 * passed, terminates by exceeding `maxDepth`.
 */
export function exceedsMaxDepth(root: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 1 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') {
      continue;
    }
    if (depth > maxDepth) {
      return true;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Expand `$VAR` / `${VAR}` in the transport fields of one entry, leaving every
 * other field byte-identical. Returns the input unchanged when nothing expanded.
 */
function resolveTransportEnvVars(config: MCPServerConfig): MCPServerConfig {
  const source = config as unknown as Record<string, unknown>;
  let resolved: Record<string, unknown> | undefined;
  for (const field of ENV_EXPANDED_TRANSPORT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      continue;
    }
    const original = source[field];
    const value = resolveEnvVarsInObject(original);
    if (value === original) {
      continue;
    }
    resolved ??= { ...source };
    resolved[field] = value;
  }
  return (resolved ?? config) as unknown as MCPServerConfig;
}

export interface LoadProjectMcpServersResult {
  /**
   * Servers declared in `.mcp.json`, each tagged `scope: 'project'`. These are
   * UNTRUSTED until the user approves them — loading is side-effect-free and
   * MUST NOT trigger any connection (see issue #4615). Empty when no readable
   * `.mcp.json` exists.
   */
  servers: Record<string, MCPServerConfig>;
  /** Absolute path of the `.mcp.json` that was read, if any. */
  path: string | undefined;
  /** Non-fatal problems (missing/malformed file, bad shape). Never throws. */
  errors: string[];
}

/** Options for {@link loadProjectMcpServers}. */
export interface LoadProjectMcpServersOptions {
  /**
   * Expand `$VAR` / `${VAR}` in transport fields. Default true.
   *
   * Pass false whenever the approval gate is off (bare mode, safe mode, or
   * `--yolo`), because then nothing stands between a checked-in `.mcp.json` and
   * a live connection: a repository could name any variable in its own headers
   * and have the real value posted to an endpoint it chose. Unexpanded, the
   * placeholder travels as the literal text it is.
   */
  expandEnv?: boolean;
}

/**
 * Load project-scoped MCP servers from `<projectRoot>/.mcp.json`, each tagged
 * `scope: 'project'` so the discovery layer can gate it behind approval.
 *
 * A pure read: never spawns a process, opens a transport or runs a health check
 * (#4615). Never throws — a missing file returns empty, and anything malformed,
 * over-deep or otherwise unusable is reported via `errors` and skipped, per
 * entry, so one bad server cannot cost the session.
 *
 * Note `getHomeEnvFallbackVars()` is deliberately NOT passed: the only keys it
 * would add over `process.env` are the ones `loadEnvironment` refused to apply
 * (loader-affecting keys such as `NODE_OPTIONS`, private provenance markers),
 * and a repository-supplied file must not be able to read those (#8653).
 */
export function loadProjectMcpServers(
  projectRoot: string,
  options: LoadProjectMcpServersOptions = {},
): LoadProjectMcpServersResult {
  const expandEnv = options.expandEnv ?? true;
  const filePath = path.join(projectRoot, PROJECT_MCP_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Missing/unreadable file is the common case — not an error.
    return { servers: {}, path: undefined, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return {
      servers: {},
      path: filePath,
      errors: [`Failed to parse ${filePath}: ${(e as Error).message}`],
    };
  }

  const mcpServers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (
    !mcpServers ||
    typeof mcpServers !== 'object' ||
    Array.isArray(mcpServers)
  ) {
    return {
      servers: {},
      path: filePath,
      errors: [`${filePath} has no "mcpServers" object`],
    };
  }

  const servers: Record<string, MCPServerConfig> = Object.create(null);
  const errors: string[] = [];
  for (const [name, value] of Object.entries(
    mcpServers as Record<string, unknown>,
  )) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${filePath}: server "${name}" is not an object — skipped`);
      continue;
    }
    if (exceedsMaxDepth(value, MAX_MCP_SERVER_CONFIG_DEPTH)) {
      errors.push(
        `${filePath}: server "${name}" nests deeper than ` +
          `${MAX_MCP_SERVER_CONFIG_DEPTH} levels — skipped`,
      );
      continue;
    }
    try {
      // `.mcp.json` is the Claude Code convention, so entries may use Claude's
      // `type`-based transport shape; normalize them to Qwen's field-based shape.
      servers[name] = {
        ...normalizeClaudeMcpServer(
          expandEnv
            ? resolveTransportEnvVars(value as MCPServerConfig)
            : (value as MCPServerConfig),
        ),
        scope: 'project',
      };
    } catch (e) {
      // Keeps the "never throws" contract total, per entry.
      errors.push(
        `${filePath}: server "${name}" could not be processed: ` +
          `${(e as Error).message} — skipped`,
      );
    }
  }

  return { servers, path: filePath, errors };
}
