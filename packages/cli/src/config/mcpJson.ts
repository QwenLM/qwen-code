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
import stripJsonComments from 'strip-json-comments';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import { getHomeEnvFallbackVars } from './environment.js';

/** Project-scoped MCP config filename, read from the workspace root. */
export const PROJECT_MCP_FILENAME = '.mcp.json';

export interface LoadProjectMcpServersResult {
  /**
   * Servers declared in `.mcp.json`, each tagged `scope: 'project'`, with
   * `$VAR` / `${VAR}` placeholders resolved (headers, env, url, command,
   * args) from `process.env` with the home `~/.qwen/.env` as fallback —
   * the same resolution every settings scope applies (see settings.ts).
   * A checked-in `.mcp.json` referencing secrets by name is the only safe
   * way to configure an authenticated server (#4466, #11499). These are
   * UNTRUSTED until the user approves them — loading is side-effect-free
   * and MUST NOT trigger any connection (see issue #4615). Empty when no
   * readable `.mcp.json` exists.
   */
  servers: Record<string, MCPServerConfig>;
  /**
   * The LITERAL (pre-expansion) config each server was loaded from, keyed by
   * server name. Approval hashes bind to this — not the resolved config — so
   * rotating the secret behind a `${VAR}` placeholder never re-prompts an
   * approved server; only editing `.mcp.json` does (#4615, #11499).
   */
  literalServers: Record<string, MCPServerConfig>;
  /** Absolute path of the `.mcp.json` that was read, if any. */
  path: string | undefined;
  /** Non-fatal problems (missing/malformed file, bad shape). Never throws. */
  errors: string[];
}

/**
 * Load project-scoped MCP servers from `<projectRoot>/.mcp.json`.
 *
 * This is a pure read: it parses JSON, resolves env-var placeholders, and
 * tags each server with `scope: 'project'` so the discovery layer can gate
 * it behind approval. It never spawns a process, opens a transport, or
 * runs a health check. A missing file is normal (returns empty); a
 * malformed file is reported via `errors` and otherwise ignored so it can
 * never crash startup.
 */
export function loadProjectMcpServers(
  projectRoot: string,
): LoadProjectMcpServersResult {
  const filePath = path.join(projectRoot, PROJECT_MCP_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Missing/unreadable file is the common case — not an error.
    return {
      servers: {},
      literalServers: {},
      path: undefined,
      errors: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return {
      servers: {},
      literalServers: {},
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
      literalServers: {},
      path: filePath,
      errors: [`${filePath} has no "mcpServers" object`],
    };
  }

  // Same precedence as settings scopes: process.env > home .env >
  // unresolved placeholder. The resolver refuses Qwen-internal secrets
  // (isInternalSecretEnvVar), bounding the untrusted-file angle exactly
  // as it already is for workspace settings and extensions.
  const homeEnvFallback = getHomeEnvFallbackVars();

  const servers: Record<string, MCPServerConfig> = Object.create(null);
  const literalServers: Record<string, MCPServerConfig> = Object.create(null);
  const errors: string[] = [];
  for (const [name, value] of Object.entries(
    mcpServers as Record<string, unknown>,
  )) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${filePath}: server "${name}" is not an object — skipped`);
      continue;
    }
    // `.mcp.json` is the Claude Code convention, so entries may use Claude's
    // `type`-based transport shape; normalize them to Qwen's field-based shape.
    // Env-var resolution runs after transport normalization so it covers the
    // normalized field names (httpUrl/url) as well as Claude's raw shape; the
    // literal record keeps the same normalized-but-unresolved shape so the
    // two configs differ only in expansion.
    const normalized = normalizeClaudeMcpServer(
      value as MCPServerConfig,
    ) as unknown as Record<string, unknown>;
    literalServers[name] = {
      ...normalized,
      scope: 'project',
    } as unknown as MCPServerConfig;
    servers[name] = {
      ...resolveEnvVarsInObject(normalized, homeEnvFallback),
      scope: 'project',
    } as unknown as MCPServerConfig;
  }

  return { servers, literalServers, path: filePath, errors };
}
