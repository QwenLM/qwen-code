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
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

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
 * both the Ink component and the plain-text renderer consume.
 *
 * Row order is the iteration order of `result.perFileStats`, which is a
 * `Map` and therefore preserves insertion order: tracked numstat entries
 * first (alphabetical, as git emits them), then untracked entries appended
 * by `fetchGitDiff` in their `ls-files --others` order. Renderers depend on
 * this — if `perFileStats` ever switches to a different container, the row
 * sequence must continue to be stable across runs.
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
      isDeleted: Boolean(s.isDeleted),
      truncated: false,
    };
  }
  return {
    filename,
    added: s.added,
    removed: s.isUntracked ? 0 : s.removed,
    isBinary: false,
    isUntracked: Boolean(s.isUntracked),
    isDeleted: Boolean(s.isDeleted),
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

// Match standalone C0 controls (incl. TAB/CR/LF/BEL/BS), DEL, and C1 controls.
// `escapeAnsiCtrlCodes` only neutralizes multi-byte ANSI sequences, so a
// filename like `bad\nINJECTED.txt` or `bad\roverwrite.txt` would otherwise
// still break layout in the non-interactive / ACP rendering path.
// eslint-disable-next-line no-control-regex
const FILENAME_CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/g;

function escapeControlChar(ch: string): string {
  switch (ch) {
    case '\b':
      return '\\b';
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\f':
      return '\\f';
    case '\r':
      return '\\r';
    default: {
      // JSON.stringify only escapes 0x00-0x1F (and `"` / `\`); DEL (0x7F) and
      // C1 controls (0x80-0x9F) are returned as raw bytes, which is exactly
      // what we are trying to keep out of the rendered output. Hand-roll the
      // \uXXXX escape so every matched code point becomes printable.
      const code = ch.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
}

function sanitizeFilenameForDisplay(name: string): string {
  return escapeAnsiCtrlCodes(name).replace(
    FILENAME_CONTROL_CHARS_REGEX,
    escapeControlChar,
  );
}

function formatRowsText(rows: DiffRenderRow[]): string[] {
  if (rows.length === 0) return [];
  const { addWidth, remWidth, statColumnWidth } = computeDiffColumnWidths(rows);

  const out: string[] = [];
  for (const r of rows) {
    // Escape ANSI sequences AND standalone control bytes in the filename. Git
    // permits raw bytes like `\x1b`, `\n`, `\r`, BEL, BS in tracked / untracked
    // paths, and the non-interactive (and ACP) text path streams straight to
    // stdout / logs / transports without going through the interactive
    // history's `escapeAnsiCtrlCodes(item)` sanitizer in `HistoryItemDisplay`.
    // Without this hop, a hostile filename could inject color resets, cursor
    // moves, full screen clears, or layout-breaking newlines into CI logs and
    // any consumer's terminal.
    const safeName = sanitizeFilenameForDisplay(r.filename);
    if (r.isBinary) {
      const suffix = r.isUntracked
        ? ` ${t('(binary, new)')}`
        : r.isDeleted
          ? ` ${t('(binary, deleted)')}`
          : ` ${t('(binary)')}`;
      out.push(`  ${padMarker('~', statColumnWidth)}  ${safeName}${suffix}`);
      continue;
    }
    const added = `+${String(r.added ?? 0).padStart(addWidth)}`;
    const removed = `-${String(r.removed ?? 0).padStart(remWidth)}`;
    let suffix = '';
    if (r.isUntracked) {
      suffix = r.truncated ? ` ${t('(new, partial)')}` : ` ${t('(new)')}`;
    } else if (r.isDeleted) {
      suffix = ` ${t('(deleted)')}`;
    }
    out.push(`  ${added} ${removed}  ${safeName}${suffix}`);
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
