/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import type { HookEventDisplayInfo } from './types.js';
import { t } from '../../../i18n/index.js';

interface HooksListStepProps {
  hooks: HookEventDisplayInfo[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}

export function HooksListStep({
  hooks,
  onSelect,
  onCancel,
}: HooksListStepProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useKeypress(
    (key) => {
      if (key.name === 'up') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.name === 'down') {
        setSelectedIndex((prev) => Math.min(hooks.length - 1, prev + 1));
      } else if (key.name === 'return') {
        onSelect(selectedIndex);
      } else if (key.name === 'escape') {
        onCancel();
      }
    },
    { isActive: true },
  );

  if (hooks.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.text.secondary}>{t('No hook events found.')}</Text>
      </Box>
    );
  }

  // Calculate total configured hooks
  const totalConfigured = hooks.reduce(
    (sum, hook) => sum + hook.configs.length,
    0,
  );

  // Get the correct plural/singular form
  const hooksConfiguredText =
    totalConfigured === 1
      ? t('{{count}} hook configured', { count: String(totalConfigured) })
      : t('{{count}} hooks configured', { count: String(totalConfigured) });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {t('Hooks')}
        </Text>
        <Text color={theme.text.secondary}>{` · ${hooksConfiguredText}`}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={theme.text.secondary}>
          {t(
            'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.',
          )}
        </Text>
      </Box>

      {hooks.map((hook, index) => {
        const isSelected = index === selectedIndex;
        const configCount = hook.configs.length;
        const maxDigits = String(hooks.length).length;
        const paddedIndex = String(index + 1).padStart(maxDigits);

        return (
          <Box key={hook.event}>
            <Box minWidth={2}>
              <Text color={isSelected ? theme.text.accent : theme.text.primary}>
                {isSelected ? '❯' : ' '}
              </Text>
            </Box>
            <Box width={30}>
              <Text
                color={isSelected ? theme.text.accent : theme.text.primary}
                bold={isSelected}
              >
                {paddedIndex}. {hook.event}
                {configCount > 0 && (
                  <Text color={theme.status.success}> ({configCount})</Text>
                )}
              </Text>
            </Box>
            <Text color={theme.text.secondary}>{hook.shortDescription}</Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to select · Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}
