/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'shell-quote';
import type { MCPServerConfig } from '../mcpServerConfig.js';

export function populateMcpServerCommand(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
): Record<string, MCPServerConfig> {
  if (mcpServerCommand) {
    const cmd = mcpServerCommand;
    const args = parse(cmd, process.env) as string[];
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new Error('failed to parse mcpServerCommand: ' + cmd);
    }
    // use generic server name 'mcp'; tag as flag-source so downstream
    // governance/UI classify this legacy entry-point consistently with
    // --mcp-config / the brand-prefixed MCP_CONFIG env var
    // (see docs/design/mcp-source-model.md).
    mcpServers['mcp'] = {
      command: args[0],
      args: args.slice(1),
      scope: 'flag',
    };
  }
  return mcpServers;
}
