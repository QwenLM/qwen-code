/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { DiffRenderModel, DiffRenderRow } from '../../types.js';
import { computeDiffColumnWidths } from '../../commands/diffCommand.js';
import { t } from '../../../i18n/index.js';

interface DiffStatsDisplayProps {
  model: DiffRenderModel;
}

/**
 * Colored rendering of `/diff` output for interactive mode. Mirrors the
 * layout of the plain-text fallback (see `renderDiffModelText`) so the two
 * modes stay visually aligned, but uses Ink primitives with `theme.status.*`
 * tokens instead of baking ANSI into the text.
 */
export const DiffStatsDisplay: React.FC<DiffStatsDisplayProps> = ({
  model,
}) => {
  const { filesCount, linesAdded, linesRemoved, rows, hiddenCount } = model;
  // Single source of truth shared with `renderDiffModelText`, so the
  // interactive Ink output and the non-interactive plain text never drift
  // out of column alignment.
  const { addWidth, remWidth, statColumnWidth } = computeDiffColumnWidths(rows);

  const headerLabel =
    filesCount === 1
      ? t('{{count}} file changed', { count: String(filesCount) })
      : t('{{count}} files changed', { count: String(filesCount) });

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.text.primary}>{headerLabel}</Text>
        <Text color={theme.text.secondary}>, </Text>
        <Text color={theme.status.success}>+{linesAdded}</Text>
        <Text color={theme.text.secondary}> / </Text>
        <Text color={theme.status.error}>-{linesRemoved}</Text>
      </Text>
      {rows.map((row) => (
        <DiffRow
          key={row.filename}
          row={row}
          addWidth={addWidth}
          remWidth={remWidth}
          statColumnWidth={statColumnWidth}
        />
      ))}
      {hiddenCount > 0 && rows.length > 0 && (
        <Box>
          <Text color={theme.text.secondary}>
            {'  '}
            {t('…and {{hidden}} more (showing first {{shown}})', {
              hidden: String(hiddenCount),
              shown: String(rows.length),
            })}
          </Text>
        </Box>
      )}
    </Box>
  );
};

interface DiffRowProps {
  row: DiffRenderRow;
  addWidth: number;
  remWidth: number;
  statColumnWidth: number;
}

const DiffRow: React.FC<DiffRowProps> = ({
  row,
  addWidth,
  remWidth,
  statColumnWidth,
}) => {
  if (row.isBinary) {
    const marker = padRight('~', statColumnWidth);
    const suffix = row.isUntracked
      ? t('(binary, new)')
      : row.isDeleted
        ? t('(binary, deleted)')
        : t('(binary)');
    return (
      <Box>
        <Text>
          <Text color={theme.text.primary}>{'  '}</Text>
          <Text color={theme.text.secondary}>{marker}</Text>
          <Text color={theme.text.primary}>{'  '}</Text>
          <Text color={theme.text.primary}>{row.filename}</Text>
          <Text color={theme.text.secondary}> {suffix}</Text>
        </Text>
      </Box>
    );
  }
  const added = String(row.added ?? 0).padStart(addWidth);
  const removed = String(row.removed ?? 0).padStart(remWidth);
  let suffix: string | null = null;
  if (row.isUntracked) {
    suffix = row.truncated ? t('(new, partial)') : t('(new)');
  } else if (row.isDeleted) {
    suffix = t('(deleted)');
  }
  return (
    <Box>
      <Text>
        <Text color={theme.text.primary}>{'  '}</Text>
        <Text color={theme.status.success}>+{added}</Text>
        <Text color={theme.text.primary}> </Text>
        <Text color={theme.status.error}>-{removed}</Text>
        <Text color={theme.text.primary}>{'  '}</Text>
        <Text color={theme.text.primary}>{row.filename}</Text>
        {suffix && <Text color={theme.text.secondary}> {suffix}</Text>}
      </Text>
    </Box>
  );
};

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
