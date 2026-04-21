/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchGitDiff, type PerFileStats } from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';
import { t } from '../../i18n/index.js';

async function diffAction(
  context: CommandContext,
): Promise<MessageActionReturn> {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }

  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Could not determine current working directory.'),
    };
  }

  const result = await fetchGitDiff(cwd);
  if (!result) {
    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.',
      ),
    };
  }

  const { stats, perFileStats } = result;
  if (stats.filesCount === 0) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('Clean working tree — no changes against HEAD.'),
    };
  }

  const fileWord = stats.filesCount === 1 ? 'file' : 'files';
  const header = `${stats.filesCount} ${fileWord} changed, +${stats.linesAdded} / -${stats.linesRemoved}`;
  const rows = formatPerFile(perFileStats);
  const hidden = stats.filesCount - perFileStats.size;
  const capNote =
    hidden > 0
      ? `\n  …and ${hidden} more (showing first ${perFileStats.size})`
      : '';

  return {
    type: 'message',
    messageType: 'info',
    content:
      rows.length > 0 ? `${header}\n${rows.join('\n')}${capNote}` : header,
  };
}

function formatPerFile(perFileStats: Map<string, PerFileStats>): string[] {
  const rows: string[] = [];
  const maxAdded = Math.max(
    0,
    ...[...perFileStats.values()].map((s) => s.added),
  );
  const maxRemoved = Math.max(
    0,
    ...[...perFileStats.values()].map((s) => s.removed),
  );
  const addWidth = String(maxAdded).length;
  const remWidth = String(maxRemoved).length;

  for (const [filename, s] of perFileStats) {
    if (s.isUntracked) {
      rows.push(`  ?  ${filename}`);
    } else if (s.isBinary) {
      rows.push(`  ~  ${filename} (binary)`);
    } else {
      const added = `+${String(s.added).padStart(addWidth)}`;
      const removed = `-${String(s.removed).padStart(remWidth)}`;
      rows.push(`  ${added} ${removed}  ${filename}`);
    }
  }
  return rows;
}

export const diffCommand: SlashCommand = {
  name: 'diff',
  get description() {
    return t('Show working-tree change stats versus HEAD');
  },
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  action: diffAction,
};
