/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import type { DescriptiveRadioSelectItem } from './shared/DescriptiveRadioButtonSelect.js';
import type { RewindAction, RewindHistoryEntry } from '../types/rewind.js';
import { t } from '../../i18n/index.js';

interface RewindConfirmationDialogProps {
  entry: RewindHistoryEntry;
  onConfirm: (action: RewindAction) => void;
  onCancel: () => void;
}

function getPreviewLines(
  action: RewindAction,
  entry: RewindHistoryEntry,
): string[] {
  const restoreCodeSummary = entry.restoreCodeSummary ?? entry.codeSummary;
  switch (action) {
    case 'restore_code_and_conversation':
      return [
        t('The conversation will be forked.'),
        restoreCodeSummary.detailText,
      ];
    case 'restore_conversation':
      return [
        t('The conversation will be forked.'),
        t('The code will be unchanged.'),
      ];
    case 'restore_code':
      return [
        t('The conversation will be unchanged.'),
        restoreCodeSummary.detailText,
      ];
    case 'summarize_from_here':
      return [
        t('Messages after this point will be summarized.'),
        t('The code will be unchanged.'),
      ];
    case 'cancel':
    default:
      return [];
  }
}

export function RewindConfirmationDialog({
  entry,
  onConfirm,
  onCancel,
}: RewindConfirmationDialogProps): React.JSX.Element {
  const initialAction: RewindAction = (
    entry.restoreCodeSummary ?? entry.codeSummary
  ).hasChanges
    ? 'restore_code_and_conversation'
    : 'restore_conversation';
  const [highlightedAction, setHighlightedAction] =
    useState<RewindAction>(initialAction);

  useEffect(() => {
    setHighlightedAction(initialAction);
  }, [initialAction, entry.key]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onCancel();
      }
    },
    { isActive: true },
  );

  const options = useMemo(() => {
    const restoreCodeSummary = entry.restoreCodeSummary ?? entry.codeSummary;
    const items: Array<DescriptiveRadioSelectItem<RewindAction>> = [];

    if (restoreCodeSummary.hasChanges) {
      items.push({
        key: 'restore_code_and_conversation',
        value: 'restore_code_and_conversation',
        title: <Text>{t('Restore code and conversation')}</Text>,
        description: (
          <Text color={theme.text.secondary}>
            {t('Fork the conversation and restore the code snapshot')}
          </Text>
        ),
      });
    }

    items.push({
      key: 'restore_conversation',
      value: 'restore_conversation',
      title: <Text>{t('Restore conversation')}</Text>,
      description: (
        <Text color={theme.text.secondary}>
          {t('Fork from this prompt and keep the current code')}
        </Text>
      ),
    });

    if (restoreCodeSummary.hasChanges) {
      items.push({
        key: 'restore_code',
        value: 'restore_code',
        title: <Text>{t('Restore code')}</Text>,
        description: (
          <Text color={theme.text.secondary}>
            {t('Keep the conversation and restore only the code snapshot')}
          </Text>
        ),
      });
    }

    items.push({
      key: 'summarize_from_here',
      value: 'summarize_from_here',
      title: <Text>{t('Summarize from here')}</Text>,
      description: (
        <Text color={theme.text.secondary}>
          {t('Summarize messages after this point before continuing')}
        </Text>
      ),
    });
    items.push({
      key: 'cancel',
      value: 'cancel',
      title: <Text>{t('Never mind')}</Text>,
      description: (
        <Text color={theme.text.secondary}>
          {t('Keep the current conversation and code unchanged')}
        </Text>
      ),
    });

    return items;
  }, [entry.codeSummary, entry.restoreCodeSummary]);

  const previewLines = getPreviewLines(highlightedAction, entry);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        {t('Rewind')}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          {t(
            'Confirm you want to restore to the point before you sent this message:',
          )}
        </Text>
        <Box marginTop={1} paddingLeft={1} flexDirection="column">
          <Text color={theme.text.primary}>│ {entry.label}</Text>
          {entry.timestamp && (
            <Text color={theme.text.secondary}>
              │ ({formatRelativeTime(Date.parse(entry.timestamp))})
            </Text>
          )}
        </Box>
      </Box>

      {previewLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {previewLines.map((line) => (
            <Text key={line} color={theme.text.secondary}>
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <DescriptiveRadioButtonSelect
          items={options}
          initialIndex={0}
          onHighlight={(action) => setHighlightedAction(action)}
          onSelect={(action) => onConfirm(action)}
          showNumbers
          itemGap={0}
        />
      </Box>

      {(entry.restoreCodeSummary ?? entry.codeSummary).hasChanges && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {t('Rewinding does not affect files edited manually or via bash.')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
