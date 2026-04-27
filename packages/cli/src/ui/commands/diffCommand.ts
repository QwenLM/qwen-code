/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  fetchGitDiff,
  type GitDiffResult,
  type PerFileStats,
} from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';
import { t } from '../../i18n/index.js';
import {
  MessageType,
  type DiffRenderModel,
  type DiffRenderRow,
  type HistoryItemDiffStats,
} from '../types.js';

async function diffAction(
  context: CommandContext,
): Promise<MessageActionReturn | void> {
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

  let result: GitDiffResult | null;
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

  if (result.stats.filesCount === 0) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('Clean working tree — no changes against HEAD.'),
    };
  }

  const model = buildDiffRenderModel(result);

  // Interactive path: dispatch a structured history item so `DiffStatsDisplay`
  // can render with theme colors. Non-interactive / ACP stay on the
  // plain-text MessageActionReturn path so pipes, logs, and transports that
  // don't speak Ink still see legible output.
  if (context.executionMode === 'interactive') {
    const item: HistoryItemDiffStats = {
      type: MessageType.DIFF_STATS,
      model,
    };
    context.ui.addItem(item, Date.now());
    return;
  }

  return {
    type: 'message',
    messageType: 'info',
    content: renderDiffModelText(model),
  };
}

/**
 * Convert the raw `fetchGitDiff` result into a display-ready structure that
 * both the Ink component and the plain-text renderer consume. Order of rows
 * mirrors git's numstat output (which uses alphabetical or insertion order).
 */
export function buildDiffRenderModel(result: GitDiffResult): DiffRenderModel {
  const rows: DiffRenderRow[] = [];
  for (const [filename, s] of result.perFileStats) {
    rows.push(toRow(filename, s));
  }
  const hiddenCount = Math.max(0, result.stats.filesCount - rows.length);
  return {
    filesCount: result.stats.filesCount,
    linesAdded: result.stats.linesAdded,
    linesRemoved: result.stats.linesRemoved,
    rows,
    hiddenCount,
  };
}

function toRow(filename: string, s: PerFileStats): DiffRenderRow {
  if (s.isBinary) {
    return {
      filename,
      isBinary: true,
      isUntracked: Boolean(s.isUntracked),
      truncated: false,
    };
  }
  return {
    filename,
    added: s.added,
    removed: s.isUntracked ? 0 : s.removed,
    isBinary: false,
    isUntracked: Boolean(s.isUntracked),
    truncated: Boolean(s.truncated),
  };
}

/**
 * Single source of truth for the per-row column layout. Used by both the
 * Ink component and the plain-text renderer so the two paths can never
 * silently disagree on alignment.
 */
export interface DiffColumnWidths {
  /** Digits in the widest non-binary `added` value (min 1). */
  addWidth: number;
  /** Digits in the widest non-binary `removed` value (min 1). */
  remWidth: number;
  /** Visual width of the `+X -Y` stat column, used to pad the binary `~`
   *  marker so it lines up with the numeric rows. */
  statColumnWidth: number;
}

export function computeDiffColumnWidths(
  rows: readonly DiffRenderRow[],
): DiffColumnWidths {
  let maxAdded = 0;
  let maxRemoved = 0;
  for (const r of rows) {
    if (r.isBinary) continue;
    if ((r.added ?? 0) > maxAdded) maxAdded = r.added ?? 0;
    if ((r.removed ?? 0) > maxRemoved) maxRemoved = r.removed ?? 0;
  }
  const addWidth = String(maxAdded).length;
  const remWidth = String(maxRemoved).length;
  // `+` + addDigits + ' ' + `-` + remDigits.
  const statColumnWidth = 1 + addWidth + 1 + 1 + remWidth;
  return { addWidth, remWidth, statColumnWidth };
}

/**
 * Plain-text rendering of a `DiffRenderModel`. Used in non-interactive / ACP
 * modes where no Ink renderer is available, and as the source of truth for
 * the text column layout the Ink component mirrors.
 */
export function renderDiffModelText(model: DiffRenderModel): string {
  const { filesCount, linesAdded, linesRemoved, rows, hiddenCount } = model;
  const header =
    filesCount === 1
      ? t('{{count}} file changed, +{{added}} / -{{removed}}', {
          count: String(filesCount),
          added: String(linesAdded),
          removed: String(linesRemoved),
        })
      : t('{{count}} files changed, +{{added}} / -{{removed}}', {
          count: String(filesCount),
          added: String(linesAdded),
          removed: String(linesRemoved),
        });
  const lines = formatRowsText(rows);
  const capNote =
    hiddenCount > 0 && rows.length > 0
      ? `\n  ${t('…and {{hidden}} more (showing first {{shown}})', {
          hidden: String(hiddenCount),
          shown: String(rows.length),
        })}`
      : '';
  return lines.length > 0 ? `${header}\n${lines.join('\n')}${capNote}` : header;
}

function formatRowsText(rows: DiffRenderRow[]): string[] {
  if (rows.length === 0) return [];
  const { addWidth, remWidth, statColumnWidth } = computeDiffColumnWidths(rows);

  const out: string[] = [];
  for (const r of rows) {
    if (r.isBinary) {
      const suffix = r.isUntracked
        ? ` ${t('(binary, new)')}`
        : ` ${t('(binary)')}`;
      out.push(`  ${padMarker('~', statColumnWidth)}  ${r.filename}${suffix}`);
      continue;
    }
    const added = `+${String(r.added ?? 0).padStart(addWidth)}`;
    const removed = `-${String(r.removed ?? 0).padStart(remWidth)}`;
    let suffix = '';
    if (r.isUntracked) {
      suffix = r.truncated ? ` ${t('(new, partial)')}` : ` ${t('(new)')}`;
    }
    out.push(`  ${added} ${removed}  ${r.filename}${suffix}`);
  }
  return out;
}

function padMarker(marker: string, width: number): string {
  if (marker.length >= width) return marker;
  return `${marker}${' '.repeat(width - marker.length)}`;
}

export const diffCommand: SlashCommand = {
  name: 'diff',
  get description() {
    return t('Show working-tree change stats versus HEAD');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: diffAction,
};
