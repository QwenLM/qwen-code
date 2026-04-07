/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemText } from '../types.js';
import { t } from '../../i18n/index.js';

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  altNames: ['modehooks', 'mh'],
  get description() {
    return t('manage mode hooks (onEnter, onExit, etc.)');
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

    const trimmedArgs = args.trim();

    // No args — show help and current mode hooks
    if (!trimmedArgs) {
      const modeManager = config.getModeManager();
      const currentMode = config.getCurrentMode();
      const modeName = currentMode?.config.name ?? 'general';
      const hooks = modeManager.getHookRegistry().getHooks(modeName);

      const lines: string[] = [
        '**Mode Hooks Management**',
        '',
        `Current mode: **${currentMode?.config.icon ?? '⚙️'} ${currentMode?.config.displayName ?? 'General'}**`,
        '',
        hooks.length > 0
          ? `**Hooks for "${modeName}":**\n\n${hooks.map((h, i) =>
              `${i + 1}. **${h.trigger}** → ${h.commandType}: \`${h.command}\`${h.description ? ` — ${h.description}` : ''}`,
            ).join('\n')}`
          : 'No hooks registered for this mode.',
        '',
        '**Usage:**',
        '',
        '`/hooks list` — Show hooks for current mode',
        '`/hooks add <trigger> <type> <command>` — Add a hook',
        '`/hooks remove <index>` — Remove a hook by index',
        '`/hooks test <trigger>` — Test execute hooks',
        '',
        '**Triggers:** `onEnter`, `onExit`, `onStart`, `beforeAction`, `afterAction`',
        '**Types:** `shell`, `slash`, `message`, `prompt`',
        '',
        '**Examples:**',
        '- `/hooks add onEnter shell git status`',
        '- `/hooks add onExit message "Leaving developer mode"`',
        '- `/hooks add onEnter slash /test`',
      ];

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /hooks list
    if (trimmedArgs.startsWith('list')) {
      const modeManager = config.getModeManager();
      const currentMode = config.getCurrentMode();
      const modeName = currentMode?.config.name ?? 'general';
      const hooks = modeManager.getHookRegistry().getHooks(modeName);

      const lines: string[] = [`**Hooks for "${modeName}":**`, ''];
      if (hooks.length === 0) {
        lines.push('No hooks registered.');
      } else {
        hooks.forEach((h, i) => {
          lines.push(
            `${i + 1}. **${h.trigger}** → ${h.commandType}: \`${h.command}\`${h.description ? ` — ${h.description}` : ''}`,
          );
        });
      }

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: lines.join('\n'),
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /hooks add <trigger> <type> <command>
    if (trimmedArgs.startsWith('add')) {
      const parts = trimmedArgs.replace(/^add\s+/, '').trim().split(/\s+/);
      if (parts.length < 3) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: 'Usage: `/hooks add <trigger> <type> <command>`\n\nExample: `/hooks add onEnter shell git status`',
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const [trigger, commandType, ...commandParts] = parts;
      const command = commandParts.join(' ');

      const validTriggers = ['onEnter', 'onExit', 'onStart', 'beforeAction', 'afterAction'];
      if (!validTriggers.includes(trigger)) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Invalid trigger: \`${trigger}\`. Must be one of: ${validTriggers.join(', ')}`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const validTypes = ['shell', 'slash', 'message', 'prompt'];
      if (!validTypes.includes(commandType)) {
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `Invalid type: \`${commandType}\`. Must be one of: ${validTypes.join(', ')}`,
        };
        context.ui.addItem(historyItem, Date.now());
        return;
      }

      const modeManager = config.getModeManager();
      const currentMode = config.getCurrentMode();
      const modeName = currentMode?.config.name ?? 'general';

      modeManager.registerHooks(modeName, [{
        trigger: trigger as any,
        commandType: commandType as any,
        command,
      }]);

      const historyItem: Omit<HistoryItemText, 'id'> = {
        type: MessageType.TEXT,
        text: `✅ Hook added to **${modeName}**:\n\n**${trigger}** → ${commandType}: \`${command}\``,
      };
      context.ui.addItem(historyItem, Date.now());
      return;
    }

    // /hooks test <trigger>
    if (trimmedArgs.startsWith('test')) {
      const trigger = trimmedArgs.replace(/^test\s+/, '').trim() || 'onEnter';

      try {
        const results = await config.executeModeHooks(trigger as any);
        const lines: string[] = [`**Hook execution results for "${trigger}":**`, ''];

        results.forEach((r, i) => {
          const icon = r.success ? '✅' : '❌';
          lines.push(
            `${icon} ${r.hook.commandType}: \`${r.hook.command}\``,
          );
          if (r.output) {
            lines.push(`   Output: \`\`\`\n${r.output.trim().slice(0, 200)}\n\`\`\``);
          }
          if (r.error) {
            lines.push(`   Error: ${r.error}`);
          }
          lines.push(`   Duration: ${r.durationMs}ms`);
          lines.push('');
        });

        if (results.length === 0) {
          lines.push('No hooks found for this trigger.');
        }

        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: lines.join('\n'),
        };
        context.ui.addItem(historyItem, Date.now());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const historyItem: Omit<HistoryItemText, 'id'> = {
          type: MessageType.TEXT,
          text: `❌ Hook execution failed: ${errorMessage}`,
        };
        context.ui.addItem(historyItem, Date.now());
      }
      return;
    }

    // Unknown subcommand
    const historyItem: Omit<HistoryItemText, 'id'> = {
      type: MessageType.TEXT,
      text: `Unknown command: \`/hooks ${trimmedArgs}\`\n\nUse \`/hooks\` alone for help.`,
    };
    context.ui.addItem(historyItem, Date.now());
  },
};
