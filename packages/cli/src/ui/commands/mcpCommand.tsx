/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
} from './types.js';
import { CommandKind } from './types.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { refreshMcpServersFromDisk } from '../../config/config.js';

const reloadCommand: SlashCommand = {
  name: 'reload',
  altNames: ['refresh'],
  description: 'Reloads MCP servers',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: false,
  action: async (
    context: CommandContext,
  ): Promise<void | SlashCommandActionReturn> => {
    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    const mcpClientManager = config.getMcpClientManager();
    if (!mcpClientManager) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Could not retrieve mcp client manager.',
      };
    }

    context.ui.addItem({
      type: 'info',
      text: 'Reloading MCP servers...',
    });

    // Re-read settings from disk (settings.json, .mcp.json, settings.local.json)
    // so servers added since startup — e.g. via `qwen mcp add` or the
    // `/mcp-config` skill from inside the MCP browser — are picked up.
    // Project-scope servers that have never been approved are returned as
    // `pending` and surfaced to the user via the approval dialog.
    let pendingApproval: Record<
      string,
      import('@qwen-code/core').MCPServerConfig
    > = {};
    try {
      const refreshed = refreshMcpServersFromDisk(
        config,
        config.getSessionArtifactProjectRoot(),
      );
      pendingApproval = refreshed.pending;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.ui.addItem({
        type: 'error',
        text: `Failed to re-read MCP server config from disk: ${message}`,
      });
    }

    await mcpClientManager.restart();

    await config.refreshMcpContext();

    // Reload the slash commands to reflect the changes.
    context.ui.reloadCommands();

    if (Object.keys(pendingApproval).length > 0) {
      context.ui.addItem({
        type: 'info',
        text: `MCP servers reloaded. ${Object.keys(pendingApproval).length} new project-scope server(s) need your approval.`,
      });
      return {
        type: 'dialog',
        dialog: 'mcpApproval',
        props: { pending: pendingApproval },
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: 'MCP servers reloaded successfully.',
    };
  },
};

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Manage configured Model Context Protocol (MCP) servers',
  kind: CommandKind.BUILT_IN,
  requiredStartupGates: ['mcp-budget'],
  autoExecute: false,
  subCommands: [reloadCommand],
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    if (args) {
      const parsed = parseSlashCommand(`/${args}`, mcpCommand.subCommands!);
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    // Default action: open the interactive MCP browser dialog.
    return { type: 'dialog', dialog: 'mcpBrowser' };
  },
};
