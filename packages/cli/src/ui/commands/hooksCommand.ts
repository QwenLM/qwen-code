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
import type {
  HookRegistryEntry,
  SessionHookEntry,
} from '@qwen-code/qwen-code-core';

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
    case 'session':
      return t('Session (temporary)');
    default:
      return source;
  }
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
    const configHooks = registry.getAllHooks();

    // Get session hooks
    const sessionId = config.getSessionId();
    const sessionHooksManager = hookSystem.getSessionHooksManager();
    const sessionHooks = sessionId
      ? sessionHooksManager.getAllSessionHooks(sessionId)
      : [];

    const totalHooks = configHooks.length + sessionHooks.length;

    if (totalHooks === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'No hooks configured. Add hooks in your settings.json file or invoke a skill with hooks.',
        ),
      };
    }

    // Group hooks by event
    const hooksByEvent = new Map<
      string,
      Array<{ hook: HookRegistryEntry | SessionHookEntry; isSession: boolean }>
    >();

    // Add config hooks
    for (const hook of configHooks) {
      const eventName = hook.eventName;
      if (!hooksByEvent.has(eventName)) {
        hooksByEvent.set(eventName, []);
      }
      hooksByEvent.get(eventName)!.push({ hook, isSession: false });
    }

    // Add session hooks
    for (const hook of sessionHooks) {
      const eventName = hook.eventName;
      if (!hooksByEvent.has(eventName)) {
        hooksByEvent.set(eventName, []);
      }
      hooksByEvent.get(eventName)!.push({ hook, isSession: true });
    }

    let output = `**Configured Hooks (${totalHooks} total)**\n\n`;

    for (const [eventName, hooks] of hooksByEvent) {
      output += `### ${eventName}\n`;
      for (const { hook, isSession } of hooks) {
        let name: string;
        let source: string;
        let matcher: string;
        let config: {
          type: string;
          command?: string;
          url?: string;
          name?: string;
        };

        if (isSession) {
          // Session hook
          const sessionHook = hook as SessionHookEntry;
          config = sessionHook.config as {
            type: string;
            command?: string;
            url?: string;
            name?: string;
          };
          name =
            config.name ||
            (config.type === 'command' ? config.command : undefined) ||
            (config.type === 'http' ? config.url : undefined) ||
            'unnamed';
          source = formatHookSource('session');
          matcher = sessionHook.matcher
            ? ` (matcher: ${sessionHook.matcher})`
            : '';
        } else {
          // Config hook
          const configHook = hook as HookRegistryEntry;
          config = configHook.config as {
            type: string;
            command?: string;
            url?: string;
            name?: string;
          };
          name =
            config.name ||
            (config.type === 'command' ? config.command : undefined) ||
            (config.type === 'http' ? config.url : undefined) ||
            'unnamed';
          source = formatHookSource(configHook.source);
          matcher = configHook.matcher
            ? ` (matcher: ${configHook.matcher})`
            : '';
        }

        output += `- **${name}** [${source}]${matcher}\n`;
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
