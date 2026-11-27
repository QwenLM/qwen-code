/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import {
  runLogger,
  createCache,
  stripScope,
  type MCPServerConfig,
} from '@qwen-code/core';

/**
 * The standard file name for project-level MCP configuration.
 */
export const PROJECT_MCP_CONFIG_FILE = '.mcp.json';

/**
 * Returns the absolute path to the `.mcp.json` file in the given directory.
 */
export function getProjectMcpJsonPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_MCP_CONFIG_FILE);
}

export interface ProjectMcpConfigValidator {
  validateServerConfig(config: MCPServerConfig): void;
}

interface CachedProjectMcpConfig {
  servers: Record<string, MCPServerConfig>;
  validated: WeakMap<ProjectMcpConfigValidator, Record<string, MCPServerConfig>>;
}

const projectMcpJsonCache = createCache<string, CachedProjectMcpConfig>({
  storage: 'map',
  defaultTtl: 5000,
});

export function clearProjectMcpJsonCache(): void {
  projectMcpJsonCache.clear();
}

/**
 * Loads MCP server configuration from a project-level `.mcp.json` file.
 *
 * The file is expected to contain a JSON object with a top-level `mcpServers`
 * key, matching the same format used in settings.json. Product readers pass
 * their MCP manager or command rules explicitly; shared readers omit them.
 * Each rules instance has an independent cached view over the raw file.
 */
export function loadProjectMcpJson(
  projectDir: string,
  validator?: ProjectMcpConfigValidator,
): Record<string, MCPServerConfig> {
  const cached = projectMcpJsonCache.getOrCreate(projectDir, () => ({
    servers: _doLoadProjectMcpJson(projectDir),
    validated: new WeakMap(),
  }));
  if (!validator) return cached.servers;
  const previous = cached.validated.get(validator);
  if (previous) return previous;
  const servers = Object.fromEntries(
    Object.entries(cached.servers).filter(([name, config]) => {
      try {
        validator.validateServerConfig(config);
        return true;
      } catch (error) {
        runLogger.warn(
          `Skipped invalid MCP server "${name}" at mcpServers.${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }),
  );
  cached.validated.set(validator, servers);
  return servers;
}

function _doLoadProjectMcpJson(
  projectDir: string,
): Record<string, MCPServerConfig> {
  const mcpJsonPath = path.join(projectDir, PROJECT_MCP_CONFIG_FILE);
  try {
    let content: string;
    try {
      content = fs.readFileSync(mcpJsonPath, 'utf-8');
    } catch (readErr: unknown) {
      // File doesn't exist or is unreadable — not an error
      if (
        readErr instanceof Error &&
        'code' in readErr &&
        (readErr as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return {};
      }
      throw readErr;
    }
    const parsed: unknown = JSON.parse(stripJsonComments(content));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      runLogger.log(
        'warn',
        `Invalid ${PROJECT_MCP_CONFIG_FILE}: expected a JSON object`,
      );
      return {};
    }

    const obj = parsed as Record<string, unknown>;
    if (
      obj['mcpServers'] &&
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      typeof obj['mcpServers'] === 'object' &&
      !Array.isArray(obj['mcpServers'])
    ) {
      runLogger.log(
        'info',
        `Loaded project MCP config from ${mcpJsonPath}: ${Object.keys(obj['mcpServers']).length} server(s)`,
      );

      return obj['mcpServers'] as Record<string, MCPServerConfig>;
    }
    return {};
  } catch (error: unknown) {
    runLogger.log(
      'warn',
      `Failed to load ${mcpJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

/**
 * Writes MCP server configuration to a project-level `.mcp.json` file.
 *
 * Uses an atomic write-to-temp-then-rename pattern so that a crash
 * mid-write never leaves a truncated file.
 */
export function writeProjectMcpJson(
  projectDir: string,
  servers: Record<string, MCPServerConfig>,
): void {
  const mcpJsonPath = getProjectMcpJsonPath(projectDir);
  // Strip runtime-only `scope` field before persisting — see
  // docs/design/mcp-source-model.md.
  const persisted = stripScope(servers);
  const content = JSON.stringify({ mcpServers: persisted }, null, 2) + '\n';

  // Atomic write: write to temp file, then rename.
  const tmpPath = `${mcpJsonPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, mcpJsonPath);
    projectMcpJsonCache.clear();
  } catch (err) {
    // Clean up temp file on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}
