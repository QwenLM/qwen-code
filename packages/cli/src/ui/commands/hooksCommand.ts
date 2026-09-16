/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildHooksListing } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';
import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { Config, HookEventName } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { supportsMatchers } from '../components/hooks/constants.js';
import { normalizeMatcher } from '../components/hooks/matcherGrouping.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { MessageType } from '../types.js';
import { resolveHookSettingsForConfig } from '../../config/hook-settings.js';

const debugLogger = createDebugLogger('HOOKS_COMMAND');

/**
 * Re-reads the settings files and reloads the hook registry, so hooks added,
 * changed or removed since startup run without a restart. The hook fields are
 * resolved exactly as at startup (bare and safe mode load none; project hooks
 * only in a trusted folder). Session hooks registered by skills or the SDK
 * live outside the registry and are unaffected.
 */
async function reloadHooksFromSettings(
  config: Config,
  settings: LoadedSettings,
): Promise<void> {
  const hookSystem = config.getHookSystem();
  if (!hookSystem) {
    return;
  }
  // Keep the startup settings paths after --worktree changes cwd, and never
  // run startup corruption recovery while refreshing an active session.
  if (
    !settings.reloadScopesFromDiskAtomically([
      SettingScope.User,
      SettingScope.Workspace,
    ])
  ) {
    throw new Error(
      'Settings could not be read; the previous hooks are still active.',
    );
  }
  config.setHooksFromSettings(
    resolveHookSettingsForConfig(
      settings.merged.hooks,
      {
        userHooks: settings.getUserHooks(),
        projectHooks: settings.getProjectHooks(),
      },
      config.getBareMode() || config.isSafeMode(),
    ),
  );
  await hookSystem.reload();
}

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

    const listing = buildHooksListing(config);
    const totalHooks = listing.rows.length;

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
      enabled: boolean;
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

    for (const row of listing.rows) {
      addHook(row.eventName, normalizeMatcher(row.matcher), {
        name: row.name || row.displayText || t('unnamed'),
        source: row.extensionName
          ? `${formatHookSource(row.source)} (${row.extensionName})`
          : formatHookSource(row.source),
        enabled: row.enabled,
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
            output += `- **${hook.name}** [${hook.source}]${hook.enabled ? '' : ` ${t('(disabled)')}`}\n`;
          }
          output += '\n';
        }
      } else {
        for (const hookList of matcherMap.values()) {
          for (const hook of hookList) {
            output += `- **${hook.name}** [${hook.source}]${hook.enabled ? '' : ` ${t('(disabled)')}`}\n`;
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
  canRunDuringStreaming: true,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode === 'interactive') {
      const { config, settings } = context.services;
      if (config) {
        try {
          await reloadHooksFromSettings(config, settings);
        } catch (error) {
          // The menu still opens on the hooks loaded so far.
          debugLogger.warn(`Failed to reload hooks for /hooks: ${error}`);
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Failed to reload hook definitions: {{error}}', {
                error: error instanceof Error ? error.message : String(error),
              }),
            },
            Date.now(),
          );
        }
      }
      return {
        type: 'dialog',
        dialog: 'hooks',
      };
    }

    const result = await listCommand.action?.(context, args);
    return result ?? { type: 'message', messageType: 'info', content: '' };
  },
};
