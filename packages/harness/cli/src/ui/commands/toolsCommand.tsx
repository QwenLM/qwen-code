/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { ToolsList } from '../components/views/ToolsList.js';
import { BRAND_CLI_NAME } from '@qwen-code/core';

async function listTools(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const toolRegistry = context.services.agentContext?.toolRegistry;
  if (!toolRegistry) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve tool registry.',
    });
    return;
  }

  const tools = toolRegistry.getAllTools();

  const toolItems = tools.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    serverName: ('serverName' in tool ? tool.serverName : undefined) as
      | string
      | undefined,
  }));

  return {
    type: 'custom_dialog',
    component: (
      <ToolsList
        tools={toolItems}
        onClose={() => context.ui.removeComponent()}
      />
    ),
  };
}

export const toolsCommand: SlashCommand = {
  name: 'tools',
  get description() {
    return `List available ${BRAND_CLI_NAME} tools.`;
  },
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context: CommandContext) => listTools(context),
};
