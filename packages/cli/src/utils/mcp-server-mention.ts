/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';

export const MCP_SERVER_REF_PREFIX = 'mcp:';

export function parseMcpServerRef(pathName: string): { name: string } | null {
  if (!pathName.startsWith(MCP_SERVER_REF_PREFIX)) return null;
  const name = pathName.slice(MCP_SERVER_REF_PREFIX.length);
  if (!name) return null;
  return { name };
}

export function buildMcpServerRef(serverName: string): string {
  return `${MCP_SERVER_REF_PREFIX}${serverName}`;
}

export function matchMcpServerByRef(
  name: string,
  servers: Record<string, MCPServerConfig>,
): { serverName: string; server: MCPServerConfig } | undefined {
  const lower = name.toLowerCase();
  const matchedName = Object.keys(servers).find(
    (serverName) => serverName.toLowerCase() === lower,
  );
  if (!matchedName) return undefined;
  return { serverName: matchedName, server: servers[matchedName]! };
}

export function buildMcpServerContextText(
  config: Config,
  serverName: string,
): string {
  const lines = [
    `--- MCP Server: ${serverName} ---`,
    `The user explicitly mentioned this MCP server. Prefer using tools and resources from this server when relevant for this turn. This is advisory context, not a hard restriction.`,
  ];

  const prompts =
    config.getPromptRegistry?.()?.getPromptsByServer(serverName) ?? [];
  const resources =
    config.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];

  const details: string[] = [];
  if (resources.length > 0) {
    details.push(`- Resources: ${resources.length}`);
  }
  if (prompts.length > 0) {
    details.push(`- Prompts: ${prompts.length}`);
  }

  if (details.length > 0) {
    lines.push('Available capabilities from this MCP server:');
    lines.push(...details);
  }

  lines.push(`--- End MCP Server: ${serverName} ---`);
  return lines.join('\n');
}
