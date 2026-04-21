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

  let result: Awaited<ReturnType<typeof fetchGitDiff>>;
  try {
    result = await fetchGitDiff(cwd);
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `${t('Failed to compute git diff stats')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

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

  const header =
    stats.filesCount === 1
      ? t('{{count}} file changed, +{{added}} / -{{removed}}', {
          count: String(stats.filesCount),
          added: String(stats.linesAdded),
          removed: String(stats.linesRemoved),
        })
      : t('{{count}} files changed, +{{added}} / -{{removed}}', {
          count: String(stats.filesCount),
          added: String(stats.linesAdded),
          removed: String(stats.linesRemoved),
        });
  const rows = formatPerFile(perFileStats);
  const hidden = stats.filesCount - perFileStats.size;
  const capNote =
    hidden > 0 && perFileStats.size > 0
      ? `\n  ${t('…and {{hidden}} more (showing first {{shown}})', {
          hidden: String(hidden),
          shown: String(perFileStats.size),
        })}`
      : '';

  return {
    type: 'message',
    messageType: 'info',
    content:
      rows.length > 0 ? `${header}\n${rows.join('\n')}${capNote}` : header,
  };
}

function formatPerFile(perFileStats: Map<string, PerFileStats>): string[] {
  if (perFileStats.size === 0) return [];

  let maxAdded = 0;
  let maxRemoved = 0;
  for (const s of perFileStats.values()) {
    if (s.isBinary || s.isUntracked) continue;
    if (s.added > maxAdded) maxAdded = s.added;
    if (s.removed > maxRemoved) maxRemoved = s.removed;
  }
  const addWidth = String(maxAdded).length;
  const remWidth = String(maxRemoved).length;
  // Width of the `+X -Y` stat column so `?` / `~` rows line up with it.
  const statColumnWidth = 1 + addWidth + 1 + 1 + remWidth;

  const rows: string[] = [];
  for (const [filename, s] of perFileStats) {
    if (s.isUntracked) {
      rows.push(`  ${padMarker('?', statColumnWidth)}  ${filename}`);
    } else if (s.isBinary) {
      rows.push(
        `  ${padMarker('~', statColumnWidth)}  ${filename} ${t('(binary)')}`,
      );
    } else {
      const added = `+${String(s.added).padStart(addWidth)}`;
      const removed = `-${String(s.removed).padStart(remWidth)}`;
      rows.push(`  ${added} ${removed}  ${filename}`);
    }
  }
  return rows;
}

function padMarker(marker: string, width: number): string {
  if (marker.length >= width) return marker;
  const pad = ' '.repeat(width - marker.length);
  return `${marker}${pad}`;
}

export const diffCommand: SlashCommand = {
  name: 'diff',
  get description() {
    return t('Show working-tree change stats versus HEAD');
  },
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: diffAction,
};
