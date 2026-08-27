/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType, type HistoryItemToolsList } from '../types.js';
import { t } from '../../i18n/index.js';
import { ToolNames } from '@qwen-code/qwen-code-core';

export const toolsCommand: SlashCommand = {
  name: 'tools',
  get description() {
    return t('List available Qwen Code tools. Usage: /tools [desc]');
  },
  kind: CommandKind.BUILT_IN,
  canRunDuringStreaming: true,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    const subCommand = args?.trim();

    // Default to NOT showing descriptions. The user must opt in with an argument.
    let useShowDescriptions = false;
    if (subCommand === 'desc' || subCommand === 'descriptions') {
      useShowDescriptions = true;
    }

    const toolRegistry = context.services.config?.getToolRegistry();
    if (!toolRegistry) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Could not retrieve tool registry.'),
        },
        Date.now(),
      );
      return;
    }

    const tools = toolRegistry.getAllTools();
    // Filter out MCP tools by checking for the absence of a serverName property
    const geminiTools = tools.filter((tool) => !('serverName' in tool));

    const toolsListItem: HistoryItemToolsList = {
      type: MessageType.TOOLS_LIST,
      tools: geminiTools.map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        // Surface the deferred/eager split so a `tools.eager` allowlist is
        // visible rather than silently reshaping the model's toolset — the
        // user-facing half of #10075.
        deferred: toolRegistry.isDeferredAndHidden(tool.name),
      })),
      showDescriptions: useShowDescriptions,
      // Without `tool_search` an on-demand tool cannot be loaded at all, so
      // the footnote below must not tell the user it will be.
      toolSearchAvailable: !!toolRegistry.getTool(ToolNames.TOOL_SEARCH),
    };

    context.ui.addItem(toolsListItem, Date.now());
  },
};
