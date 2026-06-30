/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  reloadPluginsRuntime,
  type ReloadPluginsSummary,
} from '../../config/hot-reload.js';
import { clearPluginsChanged } from '../../config/plugin-refresh-state.js';
import { t } from '../../i18n/index.js';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatReloadPluginsSummary(summary: ReloadPluginsSummary) {
  return [
    countLabel(summary.extensionCount, 'plugin'),
    countLabel(summary.commandCount, 'command'),
    countLabel(summary.skillCount, 'skill'),
    countLabel(summary.hookCount, 'hook'),
    countLabel(summary.mcpServerCount, 'plugin MCP server'),
    countLabel(summary.lspServerCount, 'plugin LSP server'),
  ].join(' · ');
}

export const reloadPluginsCommand: SlashCommand = {
  name: 'reload-plugins',
  get description() {
    return t('Reload extension runtime changes.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context: CommandContext): Promise<MessageActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    try {
      const summary = await reloadPluginsRuntime({
        config,
        reloadCommands: context.ui.reloadCommands,
      });
      // Only clear the pending-refresh flag on a successful reload — a failed
      // reload leaves the runtime stale, so the user should be able to retry
      // /reload-plugins (and still see the "changes detected" notice if they
      // haven't).
      clearPluginsChanged();

      return {
        type: 'message',
        messageType: 'info',
        content: t('Reloaded: {{summary}}', {
          summary: formatReloadPluginsSummary(summary),
        }),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          error instanceof Error
            ? t('Reload failed: {{message}}', { message: error.message })
            : t('Reload failed.'),
      };
    }
  },
};
