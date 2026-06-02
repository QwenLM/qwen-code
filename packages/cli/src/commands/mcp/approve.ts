/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Files for 'qwen mcp approve' / 'qwen mcp reject' commands (issue #4615).
import type { CommandModule } from 'yargs';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { isGatedMcpScope } from '@qwen-code/qwen-code-core';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { loadSettings } from '../../config/settings.js';
import { assembleMcpServers } from '../../config/mcpServers.js';
import {
  loadMcpApprovals,
  type McpApprovalStatus,
} from '../../config/mcpApprovals.js';

/**
 * All gated (approval-requiring) servers visible from `cwd` — project
 * `.mcp.json` plus workspace `.qwen/settings.json` (#4615). Non-gated sources
 * (user/system/extension) never need approval and are excluded.
 */
function loadGatedServers(cwd: string): Record<string, MCPServerConfig> {
  const settings = loadSettings(cwd);
  const all = assembleMcpServers(settings.merged.mcpServers, cwd);
  const gated: Record<string, MCPServerConfig> = {};
  for (const [serverName, config] of Object.entries(all)) {
    if (isGatedMcpScope(config.scope)) {
      gated[serverName] = config;
    }
  }
  return gated;
}

function setProjectServerStatus(
  name: string | undefined,
  status: McpApprovalStatus,
  all: boolean,
): void {
  const cwd = process.cwd();
  const servers = loadGatedServers(cwd);

  const names = Object.keys(servers);
  if (names.length === 0) {
    writeStdoutLine(
      'No approval-requiring MCP servers found (looked in .mcp.json and .qwen/settings.json).',
    );
    return;
  }

  const verb = status === 'approved' ? 'Approved' : 'Rejected';
  const approvals = loadMcpApprovals();

  const targets = all ? names : name ? [name] : [];
  if (targets.length === 0) {
    writeStdoutLine('Specify a server name or pass --all.');
    return;
  }

  for (const target of targets) {
    const config = servers[target];
    if (!config) {
      writeStdoutLine(
        `Server "${target}" not found. Available: ${names.join(', ')}`,
      );
      continue;
    }
    // The decision binds to this exact config's hash: editing the server in
    // its source file later returns it to pending (issue #4615).
    approvals.setState(cwd, target, config, status);
    writeStdoutLine(
      `${verb} MCP server "${target}" (bound to its current config).`,
    );
  }

  if (status === 'approved') {
    writeStdoutLine(
      'Approved servers connect in your next interactive session.',
    );
  }
}

export const approveCommand: CommandModule = {
  command: 'approve [name]',
  describe:
    'Approve a gated MCP server (.mcp.json or workspace .qwen/settings.json)',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp approve [options] [name]')
      .positional('name', {
        describe: 'Name of the gated server to approve',
        type: 'string',
      })
      .option('all', {
        describe: 'Approve all gated servers in this workspace',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    setProjectServerStatus(
      argv['name'] as string | undefined,
      'approved',
      argv['all'] as boolean,
    );
  },
};

export const rejectCommand: CommandModule = {
  command: 'reject [name]',
  describe:
    'Reject a gated MCP server (.mcp.json or workspace .qwen/settings.json)',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp reject [options] [name]')
      .positional('name', {
        describe: 'Name of the gated server to reject',
        type: 'string',
      })
      .option('all', {
        describe: 'Reject all gated servers in this workspace',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    setProjectServerStatus(
      argv['name'] as string | undefined,
      'rejected',
      argv['all'] as boolean,
    );
  },
};
