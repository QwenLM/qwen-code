/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpCommandOptions } from './options.js';
import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import {
  type MCPServerConfig,
  sessionLogger,
} from '@qwen-code/core';
import type { McpScope } from '../../config/localSettings.js';

export interface SaveNewMcpServerOptions extends McpCommandOptions {
  readonly source: 'mcp.add' | 'mcp.addJson';
  readonly transport?: string;
}

/** Persist a newly built server config; exits on duplicate or write failure. */
export async function saveNewMcpServer(
  name: string,
  serverConfig: MCPServerConfig,
  scope: string,
  options: SaveNewMcpServerOptions,
): Promise<void> {
  const { getMcpServersByScope, upsertMcpServer, guardHomeDirScope } =
    await import('../../config/localSettings.js');

  const cwd = process.cwd();
  const settings = await resolveCommandSettings(cwd);
  guardHomeDirScope(scope, cwd);

  const typedScope = scope as McpScope;
  try {
    if (
      typedScope === 'project' &&
      getMcpServersByScope(
        typedScope,
        cwd,
        settings,
        options.projectConfigValidator,
      )[name]
    ) {
      throw new Error(
        `MCP server "${name}" already exists in ${scope} settings.`,
      );
    }
    const existed = upsertMcpServer(
      name,
      serverConfig,
      typedScope,
      cwd,
      true,
      settings,
      options.projectConfigValidator,
    );
    if (existed) {
      throw new Error(
        `MCP server "${name}" already exists in ${scope} settings.`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    sessionLogger.setExitContext({
      reason: 'config_error',
      exit_code: 1,
      message,
      source: options.source,
    });
    process.exit(1);
  }

  const transport = options.transport ? ` (${options.transport})` : '';
  process.stdout.write(
    `MCP server "${name}" added to ${scope} settings.${transport}\n`,
  );
}
