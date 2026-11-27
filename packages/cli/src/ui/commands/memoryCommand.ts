/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { MessageType } from '../types.js';
import { sanitizeTerminalLine } from '../utils/textUtils.js';

const MIGRATE_WORKTREE = 'migrate-worktree';

function migrationMessage(
  content: string,
  messageType: MessageActionReturn['messageType'] = 'info',
): MessageActionReturn {
  return { type: 'message', messageType, content };
}

async function migrateWorktree(
  context: CommandContext,
  source: string,
): Promise<MessageActionReturn> {
  if (!source) {
    return migrationMessage(
      t(
        'Enter one old checkout or memory directory with /memory migrate-worktree <path>.',
      ),
    );
  }
  const config = context.services.config;
  const signal = context.abortSignal;
  const errorMessageType =
    context.executionMode === 'acp' ? 'warning' : 'error';
  if (
    !config?.isManagedMemoryAvailable() ||
    !config.isTrustedFolder() ||
    config.isProvisionalWorkspace() ||
    config.getExecutionEnvironment() ||
    !context.confirmAction ||
    !signal
  ) {
    return migrationMessage(
      t(
        'Worktree memory migration requires a trusted session with managed memory and interactive confirmation.',
      ),
      errorMessageType,
    );
  }

  try {
    const { prepareWorktreeMemoryMigration } = await import(
      '@qwen-code/qwen-code-core/memory/worktree-migration.js'
    );
    const plan = await prepareWorktreeMemoryMigration(config, source, signal);
    const conflicts = plan.conflicts.map((conflict) =>
      t('Conflict: {{conflict}}', {
        conflict: sanitizeTerminalLine(conflict),
      }),
    );
    if (plan.topics.length === 0) {
      return migrationMessage(
        [t('No project memory changes were proposed.'), ...conflicts].join(
          '\n',
        ),
      );
    }

    const preview = [
      t('Source memory directory: {{path}}', {
        path: sanitizeTerminalLine(plan.source),
      }),
      t('Target memory directory: {{path}}', {
        path: sanitizeTerminalLine(plan.target),
      }),
      '',
      ...plan.topics.map(({ filename, summary, update }) =>
        update
          ? t('Update {{filename}}: {{summary}}', {
              filename,
              summary: sanitizeTerminalLine(summary),
            })
          : t('Add {{filename}}: {{summary}}', {
              filename,
              summary: sanitizeTerminalLine(summary),
            }),
      ),
      ...conflicts,
    ].join('\n');
    const title = t('Apply these project memory changes?');
    const interactive = context.executionMode === 'interactive';
    if (interactive) {
      context.ui.addItem({ type: MessageType.INFO, text: preview }, Date.now());
    }
    const confirmed = await context.confirmAction(
      interactive
        ? `${title}\n\n${t('Use Page Up or Page Down to review the preview above.')}`
        : title,
      preview,
    );
    if (!confirmed || signal.aborted || context.beginCommit?.() === false) {
      return migrationMessage(t('Worktree memory migration cancelled.'));
    }

    await plan.apply();
    const { refreshMemoryInstruction } = await import(
      '@qwen-code/qwen-code-core/memory/refresh.js'
    );
    await refreshMemoryInstruction(config, {
      logContext: 'worktree migration',
    });
    return migrationMessage(
      t('Applied project memory changes to {{count}} topic file(s).', {
        count: String(plan.topics.length),
      }),
    );
  } catch (error) {
    if (signal.aborted) {
      return migrationMessage(t('Worktree memory migration cancelled.'));
    }
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ESTALE'
    ) {
      return migrationMessage(
        t(
          'Project memory conflict. A topic changed after the plan was prepared. Prepare a new migration plan.',
        ),
        errorMessageType,
      );
    }
    return migrationMessage(
      t('Worktree memory migration failed: {{message}}', {
        message: sanitizeTerminalLine(
          error instanceof Error ? error.message : String(error),
        ),
      }),
      errorMessageType,
    );
  }
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  argumentHint: '[migrate-team | migrate-worktree <path>]',
  get description() {
    return t('Open the memory manager.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (context, args) => {
    const action = args.trim();
    const [subcommand] = action.split(/\s+/, 1);
    if (subcommand === MIGRATE_WORKTREE) {
      const source = action.slice(MIGRATE_WORKTREE.length).trim();
      return migrateWorktree(
        context,
        source.replace(/^(["'])([\s\S]*)\1$/, '$2'),
      );
    }
    if (!action && context.executionMode !== 'acp') {
      return { type: 'dialog', dialog: 'memory' };
    }
    if (context.executionMode === 'acp') {
      return migrationMessage(t('Usage: /memory migrate-worktree <path>'));
    }
    if (action !== 'migrate-team') {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Usage: /memory migrate-team or /memory migrate-worktree <path>',
        ),
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
};
