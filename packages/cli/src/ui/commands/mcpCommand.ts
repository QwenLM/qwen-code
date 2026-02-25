/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import {
  getErrorMessage,
  MCPOAuthTokenStorage,
  MCPOAuthProvider,
} from '@qwen-code/qwen-code-core';
import { appEvents, AppEvent } from '../../utils/events.js';
import { t } from '../../i18n/index.js';

const authCommand: SlashCommand = {
  name: 'auth',
  get description() {
    return t('Authenticate with an OAuth-enabled MCP server');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const serverName = args.trim();
    const { config } = context.services;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const mcpServers = config.getMcpServers() || {};

    if (!serverName) {
      // List servers that support OAuth
      const oauthServers = Object.entries(mcpServers)
        .filter(([_, server]) => server.oauth?.enabled)
        .map(([name, _]) => name);

      if (oauthServers.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('No MCP servers configured with OAuth authentication.'),
        };
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `${t('MCP servers with OAuth authentication:')}\n${oauthServers.map((s) => `  - ${s}`).join('\n')}\n\n${t('Use /mcp auth <server-name> to authenticate.')}`,
      };
    }

    const server = mcpServers[serverName];
    if (!server) {
      return {
        type: 'message',
        messageType: 'error',
        content: t("MCP server '{{name}}' not found.", { name: serverName }),
      };
    }

    // Always attempt OAuth authentication, even if not explicitly configured
    // The authentication process will discover OAuth requirements automatically

    const displayListener = (message: string) => {
      context.ui.addItem({ type: 'info', text: message }, Date.now());
    };

    appEvents.on(AppEvent.OauthDisplayMessage, displayListener);

    try {
      context.ui.addItem(
        {
          type: 'info',
          text: t(
            "Starting OAuth authentication for MCP server '{{name}}'...",
            {
              name: serverName,
            },
          ),
        },
        Date.now(),
      );

      let oauthConfig = server.oauth;
      if (!oauthConfig) {
        oauthConfig = { enabled: false };
      }

      const mcpServerUrl = server.httpUrl || server.url;
      const authProvider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
      await authProvider.authenticate(
        serverName,
        oauthConfig,
        mcpServerUrl,
        appEvents,
      );

      context.ui.addItem(
        {
          type: 'info',
          text: t(
            "Successfully authenticated and refreshed tools for '{{name}}'.",
            {
              name: serverName,
            },
          ),
        },
        Date.now(),
      );

      // Trigger tool re-discovery to pick up authenticated server
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        context.ui.addItem(
          {
            type: 'info',
            text: t("Re-discovering tools from '{{name}}'...", {
              name: serverName,
            }),
          },
          Date.now(),
        );
        await toolRegistry.discoverToolsForServer(serverName);
      }
      // Update the client with the new tools
      const geminiClient = config.getGeminiClient();
      if (geminiClient) {
        await geminiClient.setTools();
      }

      // Reload the slash commands to reflect the changes.
      context.ui.reloadCommands();

      return {
        type: 'message',
        messageType: 'info',
        content: t(
          "Successfully authenticated and refreshed tools for '{{name}}'.",
          {
            name: serverName,
          },
        ),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          "Failed to authenticate with MCP server '{{name}}': {{error}}",
          {
            name: serverName,
            error: getErrorMessage(error),
          },
        ),
      };
    } finally {
      appEvents.removeListener(AppEvent.OauthDisplayMessage, displayListener);
    }
  },
  completion: async (context: CommandContext, partialArg: string) => {
    const { config } = context.services;
    if (!config) return [];

    const mcpServers = config.getMcpServers() || {};
    return Object.keys(mcpServers).filter((name) =>
      name.startsWith(partialArg),
    );
  },
};

const manageCommand: SlashCommand = {
  name: 'manage',
  get description() {
    return t('Open MCP management dialog');
  },
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<OpenDialogActionReturn> => ({
    type: 'dialog',
    dialog: 'mcp',
  }),
};

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  get description() {
    return t(
      'Open MCP management dialog, or authenticate with OAuth-enabled servers',
    );
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [manageCommand, authCommand],
  // Default action when no subcommand is provided - open dialog
  action: async (): Promise<OpenDialogActionReturn> => ({
    type: 'dialog',
    dialog: 'mcp',
  }),
};
