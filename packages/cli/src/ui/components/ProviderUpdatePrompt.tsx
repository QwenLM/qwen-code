/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import type {
  ProviderUpdateEntry,
  UpdateChoice,
} from '../hooks/useProviderUpdates.js';

interface ProviderUpdatePromptProps {
  entries: ProviderUpdateEntry[];
  onConfirm: (choice: UpdateChoice) => void;
}

const ProviderDiffSection = ({ entry }: { entry: ProviderUpdateEntry }) => {
  const { providerLabel, diff } = entry;
  const hasModelChanges = diff.added.length > 0 || diff.removed.length > 0;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.text.secondary}>
        {providerLabel}
      </Text>
      {hasModelChanges ? (
        <Box flexDirection="column">
          {diff.added.map((model) => (
            <Text key={model} color={theme.status.success}>
              {'  + '}
              {model}
            </Text>
          ))}
          {diff.removed.map((model) => (
            <Text key={model} color={theme.status.error}>
              {'  - '}
              {model}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={theme.text.secondary}>
          {'  '}
          {t('Model parameters updated (context window, capabilities, etc.)')}
        </Text>
      )}
    </Box>
  );
};

export const ProviderUpdatePrompt = ({
  entries,
  onConfirm,
}: ProviderUpdatePromptProps) => {
  const handleKeypress = useCallback(
    (key: Key) => {
      if (key.name === 'escape') {
        onConfirm('later');
      }
    },
    [onConfirm],
  );
  useKeypress(handleKeypress, { isActive: true });

  const affectedEntry = entries.find((e) => e.diff.currentModelAffected);

  const title =
    entries.length === 1
      ? t('Built-in Provider Update · {{provider}}', {
          provider: entries[0]!.providerLabel,
        })
      : t('Built-in Provider Updates');

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      <Text bold>{title}</Text>

      <Box flexDirection="column" marginTop={1} gap={1}>
        {entries.map((entry) => (
          <ProviderDiffSection key={entry.providerLabel} entry={entry} />
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {affectedEntry && (
          <Text color={theme.status.warning}>
            {t(
              'Note: Your selected model is being removed. It will switch to "{{model}}" after update.',
              { model: affectedEntry.diff.fallbackModel ?? '' },
            )}
          </Text>
        )}
        <Text color={theme.text.secondary}>
          {t('Tips: Your credentials will not be modified.')}
        </Text>
      </Box>

      <Box marginTop={1}>
        <RadioButtonSelect
          items={[
            {
              label: t('Update all'),
              value: 'update' as UpdateChoice,
              key: 'update',
            },
            {
              label: t('Skip this version'),
              value: 'skip' as UpdateChoice,
              key: 'skip',
            },
            {
              label: t('Remind me later (esc)'),
              value: 'later' as UpdateChoice,
              key: 'later',
            },
          ]}
          onSelect={onConfirm}
        />
      </Box>
    </Box>
  );
};
