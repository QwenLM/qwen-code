/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { loadProjectMcpServers } from './mcpJson.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

/**
 * Assemble the effective MCP server map from every source in precedence order,
 * lowest → highest (later wins on a name collision):
 *
 *   1. user / default settings    (`scope` unset)
 *   2. project `.mcp.json`         (`scope: 'project'`)  ← Claude parity: project > user
 *   3. workspace / system settings (`scope: 'workspace' | 'system'`)
 *   4. `--mcp-config` CLI servers  (`scope` unset)
 *
 * `mergedSettingsServers` is `settings.merged.mcpServers`, whose entries are
 * already stamped with their winning provenance scope by `mergeSettings`
 * (issue #4615). We split that single map by scope so a checked-in `.mcp.json`
 * can override a *user*-level server while still yielding to a workspace or
 * enterprise-enforced (`system`) one. Loading `.mcp.json` is a pure read and
 * never connects.
 */
export function assembleMcpServers(
  mergedSettingsServers: Record<string, MCPServerConfig> | undefined,
  cwd: string,
  cliMcpServers?: Record<string, MCPServerConfig> | null,
): Record<string, MCPServerConfig> {
  const belowProject: Record<string, MCPServerConfig> = {};
  const aboveProject: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mergedSettingsServers ?? {})) {
    // workspace/system settings outrank a `.mcp.json` server; user/default
    // settings sit below it.
    if (config.scope === 'workspace' || config.scope === 'system') {
      aboveProject[name] = config;
    } else {
      belowProject[name] = config;
    }
  }

  const projectResult = loadProjectMcpServers(cwd);
  for (const error of projectResult.errors) {
    writeStderrLine(`Warning: ${error}`);
  }

  return {
    ...belowProject,
    ...projectResult.servers,
    ...aboveProject,
    ...(cliMcpServers ?? {}),
  };
}
