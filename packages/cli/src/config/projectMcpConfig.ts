/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';

export const PROJECT_MCP_CONFIG_FILENAME = '.mcp.json';

type ParsedMcpConfig = {
  mcpServers?: unknown;
};

function isServerMap(value: unknown): value is Record<string, MCPServerConfig> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (server) =>
        typeof server === 'object' &&
        server !== null &&
        !Array.isArray(server) &&
        hasMcpTransport(server),
    )
  );
}

function hasMcpTransport(value: object): value is MCPServerConfig {
  const server = value as MCPServerConfig;
  return (
    typeof server.command === 'string' ||
    typeof server.url === 'string' ||
    typeof server.httpUrl === 'string' ||
    typeof server.tcp === 'string' ||
    server.type === 'sdk'
  );
}

export function loadProjectMcpServers(
  cwd: string = process.cwd(),
): Record<string, MCPServerConfig> {
  const projectConfigPath = path.join(cwd, PROJECT_MCP_CONFIG_FILENAME);
  if (!fs.existsSync(projectConfigPath)) {
    return {};
  }

  let parsed: ParsedMcpConfig | Record<string, MCPServerConfig>;
  try {
    parsed = JSON.parse(
      stripJsonComments(fs.readFileSync(projectConfigPath, 'utf-8')),
    ) as ParsedMcpConfig | Record<string, MCPServerConfig>;
  } catch (error) {
    throw new Error(
      `Failed to parse ${projectConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const servers =
    typeof parsed === 'object' &&
    parsed !== null &&
    'mcpServers' in parsed &&
    typeof parsed.mcpServers === 'object'
      ? parsed.mcpServers
      : parsed;

  if (!isServerMap(servers)) {
    throw new Error(
      `Invalid ${projectConfigPath}: expected an object of MCP servers.`,
    );
  }

  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...server,
        source: 'project',
        pendingApproval: true,
        projectConfigPath,
      },
    ]),
  );
}

export function mergeProjectMcpServers(
  baseServers: Record<string, MCPServerConfig>,
  projectServers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const merged = { ...baseServers };
  for (const [name, server] of Object.entries(projectServers)) {
    if (!merged[name]) {
      merged[name] = server;
    }
  }
  return merged;
}
