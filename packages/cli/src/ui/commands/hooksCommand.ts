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
  HookEventName,
} from '@qwen-code/qwen-code-core';
import { supportsMatchers } from '../components/hooks/constants.js';
import { normalizeMatcher } from '../components/hooks/matcherGrouping.js';

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
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
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

    interface FlattenedHook {
      name: string;
      source: string;
    }

    const hooksByEvent = new Map<string, Map<string, FlattenedHook[]>>();

    const addHook = (
      eventName: string,
      matcher: string,
      hook: FlattenedHook,
    ): void => {
      const matcherKey = supportsMatchers(eventName as HookEventName)
        ? matcher
        : '*';
      let matcherMap = hooksByEvent.get(eventName);
      if (!matcherMap) {
        matcherMap = new Map<string, FlattenedHook[]>();
        hooksByEvent.set(eventName, matcherMap);
      }
      let bucket = matcherMap.get(matcherKey);
      if (!bucket) {
        bucket = [];
        matcherMap.set(matcherKey, bucket);
      }
      bucket.push(hook);
    };

    const extractName = (config: {
      type: string;
      command?: string;
      url?: string;
      name?: string;
    }): string =>
      config.name ||
      (config.type === 'command' ? config.command : undefined) ||
      (config.type === 'http' ? config.url : undefined) ||
      'unnamed';

    for (const hook of configHooks) {
      const configHook = hook as HookRegistryEntry;
      const config = configHook.config as {
        type: string;
        command?: string;
        url?: string;
        name?: string;
      };
      addHook(configHook.eventName, normalizeMatcher(configHook.matcher), {
        name: extractName(config),
        source: formatHookSource(configHook.source),
      });
    }

    for (const hook of sessionHooks) {
      const sessionHook = hook as SessionHookEntry;
      const config = sessionHook.config as {
        type: string;
        command?: string;
        url?: string;
        name?: string;
      };
      addHook(sessionHook.eventName, normalizeMatcher(sessionHook.matcher), {
        name: extractName(config),
        source: formatHookSource('session'),
      });
    }

    let output = `**Configured Hooks (${totalHooks} total)**\n\n`;

    for (const [eventName, matcherMap] of hooksByEvent) {
      output += `### ${eventName}\n\n`;
      const useMatchers = supportsMatchers(eventName as HookEventName);
      if (useMatchers) {
        for (const [matcher, hookList] of matcherMap) {
          output += `#### ${t('Matcher:')} ${matcher}\n`;
          for (const hook of hookList) {
            output += `- **${hook.name}** [${hook.source}]\n`;
          }
          output += '\n';
        }
      } else {
        for (const hookList of matcherMap.values()) {
          for (const hook of hookList) {
            output += `- **${hook.name}** [${hook.source}]\n`;
          }
        }
        output += '\n';
      }
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
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode === 'interactive') {
      return {
        type: 'dialog',
        dialog: 'hooks',
      };
    }

    const result = await listCommand.action?.(context, args);
    return result ?? { type: 'message', messageType: 'info', content: '' };
  },
};
