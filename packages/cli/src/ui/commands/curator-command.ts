/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAutoSkillCuratorStatus,
  restoreArchivedAutoSkill,
  runAutoSkillCurator,
  type AutoSkillCuratorEntry,
  type AutoSkillCuratorRunResult,
  type AutoSkillCuratorStatus,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type {
  CommandContext,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';

function message(
  content: string,
  messageType: MessageActionReturn['messageType'] = 'info',
): MessageActionReturn {
  return { type: 'message', messageType, content };
}

function displayName(entry: AutoSkillCuratorEntry): string {
  return entry.skillName === entry.directoryName
    ? entry.directoryName
    : `${entry.skillName} (${entry.directoryName})`;
}

function formatStatus(status: AutoSkillCuratorStatus): string {
  const lines = [
    t('Auto-skill curator'),
    t('Last run: {{time}}', { time: status.lastRunAt ?? t('never') }),
    t('Active: {{count}}', { count: String(status.active.length) }),
    t('Stale: {{count}}', { count: String(status.stale.length) }),
    t('Archived: {{count}}', { count: String(status.archived.length) }),
  ];
  if (status.stale.length > 0) {
    lines.push('', t('Stale skills:'));
    lines.push(...status.stale.map((entry) => `  ${displayName(entry)}`));
  }
  if (status.archived.length > 0) {
    lines.push('', t('Archived skills:'));
    lines.push(...status.archived.map((entry) => `  ${displayName(entry)}`));
  }
  return lines.join('\n');
}

function formatRun(result: AutoSkillCuratorRunResult): string {
  const prefix = result.dryRun
    ? t('Dry run complete.')
    : t('Curator run complete.');
  const lines = [
    prefix,
    t('Checked: {{count}}', { count: String(result.checked) }),
    t('Marked stale: {{count}}', {
      count: String(result.markedStale.length),
    }),
    t('{{verb}}: {{count}}', {
      verb: result.dryRun ? t('Would archive') : t('Archived'),
      count: String(result.archived.length),
    }),
  ];
  if (result.archived.length > 0) {
    lines.push(...result.archived.map((name) => `  ${name}`));
  }
  return lines.join('\n');
}

async function statusAction(
  context: CommandContext,
): Promise<MessageActionReturn> {
  const config = context.services.config;
  if (!config) return message(t('Config not loaded.'), 'error');
  try {
    return message(
      formatStatus(await getAutoSkillCuratorStatus(config.getProjectRoot())),
    );
  } catch (error) {
    return message(
      t('Failed to read auto-skill curator status: {{message}}', {
        message: error instanceof Error ? error.message : String(error),
      }),
      'error',
    );
  }
}

const statusCommand: SlashCommand = {
  name: 'status',
  get description() {
    return t('Show project auto-skill lifecycle status.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: statusAction,
};

const runCommand: SlashCommand = {
  name: 'run',
  get description() {
    return t('Run project auto-skill lifecycle maintenance.');
  },
  argumentHint: '[--dry-run]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args) => {
    const config = context.services.config;
    if (!config) return message(t('Config not loaded.'), 'error');
    const normalized = args.trim();
    if (normalized !== '' && normalized !== '--dry-run') {
      return message(t('Usage: /curator run [--dry-run]'), 'error');
    }
    try {
      const result = await runAutoSkillCurator(config.getProjectRoot(), {
        dryRun: normalized === '--dry-run',
      });
      if (!result.dryRun && result.archived.length > 0) {
        await config.getSkillManager()?.refreshCache();
      }
      return message(formatRun(result));
    } catch (error) {
      return message(
        t('Failed to run auto-skill curator: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
        'error',
      );
    }
  },
};

const restoreCommand: SlashCommand = {
  name: 'restore',
  get description() {
    return t('Restore an archived project auto-skill.');
  },
  argumentHint: '<directory>',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args) => {
    const config = context.services.config;
    if (!config) return message(t('Config not loaded.'), 'error');
    const directoryName = args.trim();
    if (!directoryName) {
      return message(t('Usage: /curator restore <directory>'), 'error');
    }
    try {
      await restoreArchivedAutoSkill(config.getProjectRoot(), directoryName);
      await config.getSkillManager()?.refreshCache();
      return message(
        t('Restored auto-skill: {{name}}', { name: directoryName }),
      );
    } catch (error) {
      return message(
        t('Failed to restore auto-skill: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
        'error',
      );
    }
  },
  completion: async (context, partialArg) => {
    const config = context.services.config;
    if (!config) return [];
    try {
      const status = await getAutoSkillCuratorStatus(config.getProjectRoot());
      return status.archived
        .map((entry) => entry.directoryName)
        .filter((name) => name.startsWith(partialArg));
    } catch {
      return [];
    }
  },
};

export const curatorCommand: SlashCommand = {
  name: 'curator',
  get description() {
    return t('Maintain project auto-skills based on recent use.');
  },
  argumentHint: '[status|run [--dry-run]|restore <directory>]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: statusAction,
  subCommands: [statusCommand, runCommand, restoreCommand],
};
