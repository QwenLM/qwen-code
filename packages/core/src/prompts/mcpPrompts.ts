/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { DiscoveredMCPPrompt } from '../mcp/tools/mcp-prompt.js';

/** Prompts discovered for one MCP server in this session. */
export function getMCPServerPrompts(
  config: Config,
  serverName: string,
): readonly DiscoveredMCPPrompt[] {
  return config.getMcpClientManager()?.getPromptsByServer(serverName) ?? [];
}
