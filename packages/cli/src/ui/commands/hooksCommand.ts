/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { HookRegistryEntry } from '@qwen-code/qwen-code-core';

/**
 * Format hook source for display
 */
function formatHookSource(source: string): string {
  switch (source) {
    case 'project':
      return t('Project');
    case 'user':
      return t('User');
    case 'system':
      return t('System');
    case 'extensions':
      return t('Extension');
    default:
      return source;
  }
}

/**
 * Format hook status for display
 */
function formatHookStatus(enabled: boolean): string {
  return enabled ? t('✓ Enabled') : t('✗ Disabled');
}

const listCommand: SlashCommand = {
  name: 'list',
  get description() {
    return t('List all configured hooks');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    _args: string,
  ): Promise<MessageActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const hookSystem = config.getHookSystem();
    if (!hookSystem) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Hooks are not enabled. Enable hooks in settings to use this feature.',
        ),
      };
    }

    const registry = hookSystem.getRegistry();
    const allHooks = registry.getAllHooks();

    if (allHooks.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'No hooks configured. Add hooks in your settings.json file.',
        ),
      };
    }

    // Group hooks by event
    const hooksByEvent = new Map<string, HookRegistryEntry[]>();
    for (const hook of allHooks) {
      const eventName = hook.eventName;
      if (!hooksByEvent.has(eventName)) {
        hooksByEvent.set(eventName, []);
      }
      hooksByEvent.get(eventName)!.push(hook);
    }

    let output = `**Configured Hooks (${allHooks.length} total)**\n\n`;

    for (const [eventName, hooks] of hooksByEvent) {
      output += `### ${eventName}\n`;
      for (const hook of hooks) {
        const config = hook.config;
        let name: string;
        if (config.name) {
          name = config.name;
        } else if (config.type === 'command') {
          name = config.command;
        } else if (config.type === 'prompt') {
          name =
            (config as { prompt?: string }).prompt?.slice(0, 30) ?? 'unnamed';
        } else {
          name = 'unnamed';
        }
        const source = formatHookSource(hook.source);
        const status = formatHookStatus(hook.enabled);
        const matcher = hook.matcher ? ` (matcher: ${hook.matcher})` : '';
        output += `- **${name}** [${source}] ${status}${matcher}\n`;
      }
      output += '\n';
    }

    return {
      type: 'message',
      messageType: 'info',
      content: output,
    };
  },
};

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  get description() {
    return t('Manage Qwen Code hooks');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    // In interactive mode, open the hooks dialog
    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode === 'interactive') {
      return {
        type: 'dialog',
        dialog: 'hooks',
      };
    }

    // In non-interactive mode, list hooks
    const result = await listCommand.action?.(context, args);
    return result ?? { type: 'message', messageType: 'info', content: '' };
  },
};
