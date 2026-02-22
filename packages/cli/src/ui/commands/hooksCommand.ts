/**
 * @license
 * Copyright 2025 Google LLC
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
      return 'Project';
    case 'user':
      return 'User';
    case 'system':
      return 'System';
    case 'extensions':
      return 'Extension';
    default:
      return source;
  }
}

/**
 * Format hook status for display
 */
function formatHookStatus(enabled: boolean): string {
  return enabled ? '✓ Enabled' : '✗ Disabled';
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
        const name = hook.config.name || hook.config.command || 'unnamed';
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

const enableCommand: SlashCommand = {
  name: 'enable',
  get description() {
    return t('Enable a disabled hook');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const hookName = args.trim();
    if (!hookName) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Please specify a hook name. Usage: /hooks enable <hook-name>',
        ),
      };
    }

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
        messageType: 'error',
        content: t('Hooks are not enabled.'),
      };
    }

    const registry = hookSystem.getRegistry();
    registry.setHookEnabled(hookName, true);

    return {
      type: 'message',
      messageType: 'info',
      content: t('Hook "{{name}}" has been enabled for this session.', {
        name: hookName,
      }),
    };
  },
  completion: async (context: CommandContext, partialArg: string) => {
    const { config } = context.services;
    if (!config) return [];

    const hookSystem = config.getHookSystem();
    if (!hookSystem) return [];

    const registry = hookSystem.getRegistry();
    const allHooks = registry.getAllHooks();

    // Return disabled hooks for enable command
    return allHooks
      .filter((hook) => !hook.enabled)
      .map((hook) => hook.config.name || hook.config.command || '')
      .filter((name) => name && name.startsWith(partialArg));
  },
};

const disableCommand: SlashCommand = {
  name: 'disable',
  get description() {
    return t('Disable an active hook');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const hookName = args.trim();
    if (!hookName) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Please specify a hook name. Usage: /hooks disable <hook-name>',
        ),
      };
    }

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
        messageType: 'error',
        content: t('Hooks are not enabled.'),
      };
    }

    const registry = hookSystem.getRegistry();
    registry.setHookEnabled(hookName, false);

    return {
      type: 'message',
      messageType: 'info',
      content: t('Hook "{{name}}" has been disabled for this session.', {
        name: hookName,
      }),
    };
  },
  completion: async (context: CommandContext, partialArg: string) => {
    const { config } = context.services;
    if (!config) return [];

    const hookSystem = config.getHookSystem();
    if (!hookSystem) return [];

    const registry = hookSystem.getRegistry();
    const allHooks = registry.getAllHooks();

    // Return enabled hooks for disable command
    return allHooks
      .filter((hook) => hook.enabled)
      .map((hook) => hook.config.name || hook.config.command || '')
      .filter((name) => name && name.startsWith(partialArg));
  },
};

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  get description() {
    return t('Manage Qwen Code hooks');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [listCommand, enableCommand, disableCommand],
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    // If no subcommand provided, show list
    if (!args.trim()) {
      const result = await listCommand.action?.(context, '');
      return result ?? { type: 'message', messageType: 'info', content: '' };
    }

    const [subcommand, ...rest] = args.trim().split(/\s+/);
    const subArgs = rest.join(' ');

    let result: SlashCommandActionReturn | void;
    switch (subcommand.toLowerCase()) {
      case 'list':
        result = await listCommand.action?.(context, subArgs);
        break;
      case 'enable':
        result = await enableCommand.action?.(context, subArgs);
        break;
      case 'disable':
        result = await disableCommand.action?.(context, subArgs);
        break;
      default:
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Unknown subcommand: {{cmd}}. Available: list, enable, disable',
            {
              cmd: subcommand,
            },
          ),
        };
    }
    return result ?? { type: 'message', messageType: 'info', content: '' };
  },
  completion: async (context: CommandContext, partialArg: string) => {
    const subcommands = ['list', 'enable', 'disable'];
    const parts = partialArg.split(/\s+/);

    if (parts.length <= 1) {
      // Complete subcommand
      return subcommands.filter((cmd) => cmd.startsWith(partialArg));
    }

    // Complete subcommand arguments
    const [subcommand, ...rest] = parts;
    const subArgs = rest.join(' ');

    switch (subcommand.toLowerCase()) {
      case 'enable':
        return enableCommand.completion?.(context, subArgs) ?? [];
      case 'disable':
        return disableCommand.completion?.(context, subArgs) ?? [];
      default:
        return [];
    }
  },
};
