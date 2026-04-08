/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandCompletionItem,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Format all aliases for display.
 */
function formatAliases(aliases: Map<string, string>, title: string): string {
  if (aliases.size === 0) {
    return `**${title}**\n\nNo aliases defined.`;
  }

  const lines = Array.from(aliases.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([alias, mode]) => `- \`${alias}\` → \`${mode}\``);

  return `**${title}** (${aliases.size} aliases)\n\n${lines.join('\n')}`;
}

export const aliasCommand: SlashCommand = {
  name: 'alias',
  altNames: ['aliases'],
  get description() {
    return t('manage mode aliases');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available',
      };
    }

    const modeManager = config.getModeManager();
    const trimmedArgs = args.trim();

    // No args — list all aliases
    if (!trimmedArgs) {
      const allAliases = modeManager.getAllAliases();
      const customAliases = modeManager.getCustomAliases();

      let content = formatAliases(allAliases, 'Mode Aliases');

      if (customAliases.size > 0) {
        content += `\n\n${formatAliases(customAliases, 'Custom Aliases')}`;
      }

      const historyItem: HistoryItemWithoutId = {
        type: MessageType.INFO,
        text: content,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /alias list — list all aliases
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      const allAliases = modeManager.getAllAliases();
      const historyItem: HistoryItemWithoutId = {
        type: MessageType.INFO,
        text: formatAliases(allAliases, 'Mode Aliases'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /alias add <alias> <mode> — add custom alias
    if (trimmedArgs.startsWith('add ')) {
      const parts = trimmedArgs.slice(4).trim().split(/\s+/);
      if (parts.length < 2) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.INFO,
          text: 'Usage: `/alias add <alias> <mode-name>`\n\nExample: `/alias my-dev developer`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const [alias, targetMode] = parts;
      const success = modeManager.addAlias(alias, targetMode);

      if (success) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.SUCCESS,
          text: `Added alias: \`${alias}\` → \`${targetMode}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      } else {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.ERROR,
          text: `Failed to add alias: mode \`${targetMode}\` does not exist.`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // /alias remove <alias> — remove custom alias
    if (trimmedArgs.startsWith('remove ') || trimmedArgs.startsWith('rm ')) {
      const alias = trimmedArgs.replace(/^(remove|rm)\s+/, '').trim();
      if (!alias) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.INFO,
          text: 'Usage: `/alias remove <alias>`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const success = modeManager.removeAlias(alias);
      if (success) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.SUCCESS,
          text: `Removed alias: \`${alias}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      } else {
        const allAliases = modeManager.getAllAliases();
        if (allAliases.has(alias)) {
          const historyItem: HistoryItemWithoutId = {
            type: MessageType.WARNING,
            text: `Cannot remove built-in alias: \`${alias}\``,
          };
          context.ui.addItem(historyItem, Date.now());
        } else {
          const historyItem: HistoryItemWithoutId = {
            type: MessageType.ERROR,
            text: `Alias not found: \`${alias}\``,
          };
          context.ui.addItem(historyItem, Date.now());
        }
      }
      return;
    }

    // /alias show <alias> — show what an alias resolves to
    if (trimmedArgs.startsWith('show ')) {
      const alias = trimmedArgs.slice(5).trim();
      if (!alias) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.INFO,
          text: 'Usage: `/alias show <alias>`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const resolved = modeManager.resolveAlias(alias);
      const allAliases = modeManager.getAllAliases();

      if (allAliases.has(alias)) {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.INFO,
          text: `\`${alias}\` → \`${resolved}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      } else {
        const historyItem: HistoryItemWithoutId = {
          type: MessageType.INFO,
          text: `\`${alias}\` is not a known alias. It resolves to itself: \`${resolved}\``,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // Unknown subcommand — show help
    const historyItem: HistoryItemWithoutId = {
      type: MessageType.INFO,
      text: `**Alias Command**

Manage mode aliases for quick access.

**Usage:**

\`/alias\` — List all aliases
\`/alias list\` — List all aliases
\`/alias add <alias> <mode>\` — Add custom alias
\`/alias remove <alias>\` — Remove custom alias
\`/alias show <alias>\` — Show what alias resolves to

**Built-in Aliases:**

${formatAliases(modeManager.getAllAliases(), '')}`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
  completion: async (
    context,
    partialArg,
  ): Promise<Array<string | CommandCompletionItem> | null> => {
    const subcommands = ['list', 'add', 'remove', 'show'];
    return subcommands
      .filter((s) => s.startsWith(partialArg))
      .map((s) => ({ value: s }));
  },
};
