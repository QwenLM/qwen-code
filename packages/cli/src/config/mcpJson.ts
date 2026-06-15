/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';

/** Project-scoped MCP config filename, read from the workspace root. */
export const PROJECT_MCP_FILENAME = '.mcp.json';

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

const EMPTY: LoadProjectMcpServersResult = {
  servers: {},
  path: undefined,
  errors: [],
};

/**
 * Load project-scoped MCP servers from `<projectRoot>/.mcp.json`.
 *
 * This is a pure read: it parses JSON and tags each server with
 * `scope: 'project'` so the discovery layer can gate it behind approval. It
 * never spawns a process, opens a transport, or runs a health check. A missing
 * file is normal (returns empty); a malformed file is reported via `errors` and
 * otherwise ignored so it can never crash startup.
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
    return EMPTY;
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
    servers[name] = {
      ...(value as MCPServerConfig),
      scope: 'project',
    };
  }

  return { servers, path: filePath, errors };
}
