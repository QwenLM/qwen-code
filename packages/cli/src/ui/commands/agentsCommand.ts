/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType } from '../types.js';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { parseSlashCommand } from '../../utils/commands.js';
import {
  emitLoadErrorSummary,
  type ConfigLoadError,
} from '@qwen-code/core';

function getAgentLoadErrorSummary(
  errors: readonly ConfigLoadError[],
): string | undefined {
  let summary: string | undefined;
  emitLoadErrorSummary(errors, 'agent', (_severity, message) => {
    summary = message;
  });
  return summary;
}

const reloadCommand: SlashCommand = {
  name: 'reload',
  altNames: ['refresh'],
  description: 'Reload agents from disk and refresh tools & system prompt',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Agent context is not available.',
      });
      return;
    }

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: 'Reloading agents...',
      },
      Date.now(),
    );

    try {
      const registry = config.getAgentRegistry();
      await registry.reload();
      const agentNames = registry.getAllDiscoveredAgentNames();
      const loadErrorSummary = getAgentLoadErrorSummary(
        registry.getLoadErrors(),
      );
      context.ui.addItem(
        {
          type: loadErrorSummary ? MessageType.WARNING : MessageType.INFO,
          text: loadErrorSummary
            ? `Agents reloaded with issues. ${loadErrorSummary} ${agentNames.length} agent(s) discovered.`
            : `Agents reloaded successfully. ${agentNames.length} agent(s) discovered.`,
        },
        Date.now(),
      );
    } catch (err) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to reload agents: ${err instanceof Error ? err.message : String(err)}`,
        },
        Date.now(),
      );
    }
  },
};

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'Manage agents',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: false,
  subCommands: [reloadCommand],
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    if (args) {
      const parsed = parseSlashCommand(`/${args}`, [reloadCommand]);
      if (parsed.commandToExecute?.action) {
        return parsed.commandToExecute.action(context, parsed.args);
      }
    }
    // Default: open agent browser
    return { type: 'dialog', dialog: 'agentBrowser' };
  },
};
