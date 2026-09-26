/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {
  type MCPServerConfig,
  normalizeClaudeMcpServer,
} from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import { readConfigFile } from './read-config-file.js';

/** Project-scoped MCP config filename, read from the workspace root. */
export const PROJECT_MCP_FILENAME = '.mcp.json';

export interface LoadProjectMcpServersResult {
  /**
   * Servers declared in `.mcp.json`, each tagged `scope: 'project'`. These are
   * UNTRUSTED until the user approves them — loading is side-effect-free and
   * MUST NOT trigger any connection (see issue #4615). Empty when the file is
   * absent or could not be read; errors distinguish those cases.
   */
  servers: Record<string, MCPServerConfig>;
  /** Absolute path of the `.mcp.json` that was read, if any. */
  path: string | undefined;
  /** Non-fatal problems (missing/malformed file, bad shape). Never throws. */
  errors: string[];
}

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

  let raw: string | undefined;
  try {
    raw = readConfigFile(filePath);
  } catch (error) {
    return {
      servers: {},
      path: filePath,
      errors: [`Failed to read ${filePath}: ${(error as Error).message}`],
    };
  }
  if (raw === undefined) return { servers: {}, path: undefined, errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return {
      servers: {},
      path: filePath,
      errors: [`Failed to parse ${filePath}: invalid JSON.`],
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
    // `.mcp.json` is the Claude Code convention, so entries may use Claude's
    // `type`-based transport shape; normalize them to Qwen's field-based shape.
    servers[name] = {
      ...normalizeClaudeMcpServer(value as MCPServerConfig),
      scope: 'project',
    };
  }

  return { servers, path: filePath, errors };
}
