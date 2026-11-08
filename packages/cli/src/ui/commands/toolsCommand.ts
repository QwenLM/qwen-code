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
import { isMediaPolicyToolHiddenFromModel } from '@qwen-code/qwen-code-core/omni/policy/model-access.js';
import { t } from '../../i18n/index.js';

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
    const config = context.services.config!;

    const tools = toolRegistry.getAllTools();
    // Filter out MCP tools by checking for the absence of a serverName property
    const llmTools = tools.filter((tool) => !('serverName' in tool));

    const toolsListItem: HistoryItemToolsList = {
      type: MessageType.TOOLS_LIST,
      tools: llmTools.map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        // Omni media-policy tools without modelAccess.enabled are stripped
        // from the model's declarations but stay listed here for the human;
        // the flag renders a "fixed-only" marker so the discrepancy between
        // /tools and what the model can call is visible, not confusing.
        ...(isMediaPolicyToolHiddenFromModel(config, tool)
          ? { fixedOnly: true }
          : {}),
        // Surface the deferred/eager split so a `tools.eager` allowlist is
        // visible rather than silently reshaping the model's toolset — the
        // user-facing half of #10075.
        deferred: toolRegistry.isDeferredAndHidden(tool.name),
      })),
      showDescriptions: useShowDescriptions,
    };

    context.ui.addItem(toolsListItem, Date.now());
  },
};
