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
import { getTranslatedSourceDisplayMap } from './constants.js';
import { t } from '../../../i18n/index.js';

interface HookDetailStepProps {
  hook: HookEventDisplayInfo;
  onBack: () => void;
}

export function HookDetailStep({
  hook,
  onBack,
}: HookDetailStepProps): React.JSX.Element {
  const hasConfigs = hook.configs.length > 0;
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Get translated source display map
  const sourceDisplayMap = getTranslatedSourceDisplayMap();

  // Handle keyboard navigation
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      } else if (hasConfigs) {
        if (key.name === 'up') {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.name === 'down') {
          setSelectedIndex((prev) =>
            Math.min(hook.configs.length - 1, prev + 1),
          );
        }
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {hook.event}
        </Text>
      </Box>

      {/* Description */}
      {hook.description && (
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>{hook.description}</Text>
        </Box>
      )}

      {/* Exit codes */}
      {hook.exitCodes.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            {t('Exit codes:')}
          </Text>
          {hook.exitCodes.map((ec, index) => (
            <Box key={index}>
              <Text color={theme.text.secondary}>
                {`  ${ec.code}: ${ec.description}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1} />

      {/* Configs or empty state */}
      {hasConfigs ? (
        <>
          <Text bold color={theme.text.primary}>
            {t('Configured hooks:')}
          </Text>
          {hook.configs.map((config, index) => {
            const isSelected = index === selectedIndex;
            const sourceDisplay =
              sourceDisplayMap[config.source] || config.source;

            return (
              <Box key={index}>
                <Box minWidth={2}>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                  >
                    {isSelected ? '❯' : ' '}
                  </Text>
                </Box>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                  bold={isSelected}
                >
                  {`${index + 1}. ${config.config.command}`}
                </Text>
                <Text color={theme.text.secondary}> · </Text>
                <Text color={theme.text.secondary}>{sourceDisplay}</Text>
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
          </Box>
        </>
      ) : (
        <>
          <Box>
            <Text color={theme.text.secondary}>
              {t('No hooks configured for this event.')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('To add hooks, edit settings.json directly or ask Qwen.')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
