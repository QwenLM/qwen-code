/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { Config } from '@qwen-code/qwen-code-core';

/** Prints the combined memory the session actually carries: hierarchical context
 * files plus the auto-memory prompt and context. Mirrors what the system
 * prompt assembles (client.ts contextFiles + autoMemory layers). */
function showMemoryAction(config: Config | null): SlashCommandActionReturn {
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Config not loaded.'),
    };
  }
  const sections = [
    config.getUserMemory(),
    config.getAutoMemoryPrompt(),
    config.getAutoMemoryContext?.() ?? '',
  ].filter((section) => section.trim().length > 0);
  const combined = sections.join('\n\n---\n\n');
  const fileCount = config.getMemoryFileCount();
  if (combined.length === 0) {
    return {
      type: 'message',
      messageType: 'info',
      content:
        fileCount > 0
          ? t(
              'Hierarchical memory (QWEN.md or other context files) is loaded but content is empty.',
            )
          : t(
              'No hierarchical memory (QWEN.md or other context files) is currently loaded.',
            ),
    };
  }
  if (fileCount > 0) {
    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Loaded memory from {{count}} context file(s).\n\nCurrent combined memory content:\n```markdown\n{{content}}\n```',
        { count: String(fileCount), content: combined },
      ),
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: t(
      'Current combined memory content:\n```markdown\n{{content}}\n```',
      { content: combined },
    ),
  };
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  argumentHint: '[show|migrate-team]',
  get description() {
    return t('Open the memory manager.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context: CommandContext, args: string) => {
    const action = args.trim();
    if (!action) {
      return { type: 'dialog', dialog: 'memory' };
    }
    if (action !== 'migrate-team') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /memory show | /memory migrate-team'),
      };
    }
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }
    if (!config.getTeamMemoryEnabled() || !config.isTrustedFolder()) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Team memory migration requires enabled team memory in a trusted project.',
        ),
      };
    }
    const result = await config.getMemoryManager().scheduleMetadataMigration({
      projectRoot: config.getProjectRoot(),
      scope: 'team',
      config,
    });
    if (result.status === 'skipped') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          result.skippedReason === 'complete'
            ? t('Team memory metadata is already complete.')
            : t('Team memory migration was not started: {{reason}}', {
                reason: result.skippedReason ?? 'unknown',
              }),
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content: t('Team memory migration started (task {{taskId}}).', {
        taskId: result.taskId ?? 'unknown',
      }),
    };
  },
  subCommands: [
    {
      name: 'show',
      get description() {
        return t('Print the combined memory content the session carries.');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: async (
        context: CommandContext,
      ): Promise<SlashCommandActionReturn> =>
        showMemoryAction(context.services.config ?? null),
    },
  ],
};
