/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { HookEventDisplayInfo } from './types.js';
import { HooksConfigSource } from '@qwen-code/qwen-code-core';
import { getTranslatedSourceDisplayMap } from './constants.js';
import { t } from '../../../i18n/index.js';

interface HookDetailStepProps {
  hook: HookEventDisplayInfo;
  selectedIndex: number;
}

export function HookDetailStep({
  hook,
  selectedIndex,
}: HookDetailStepProps): React.JSX.Element {
  const hasConfigs = hook.configs.length > 0;
  const { columns: terminalWidth } = useTerminalSize();

  // Get translated source display map
  const sourceDisplayMap = getTranslatedSourceDisplayMap();

  // Calculate column widths (command: 70%, source: 30%)
  const commandWidth = Math.floor(terminalWidth * 0.65);
  const sourceWidth = Math.floor(terminalWidth * 0.3);

  // Get source display for config list
  const getConfigSourceDisplay = (config: {
    source: HooksConfigSource;
    sourceDisplay: string;
  }): string => {
    if (config.source === HooksConfigSource.Extensions) {
      // For extensions, sourceDisplay is the extension name
      return `${sourceDisplayMap[HooksConfigSource.Extensions]} (${config.sourceDisplay})`;
    }
    return sourceDisplayMap[config.source] || config.source;
  };

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
            const sourceDisplay = getConfigSourceDisplay(config);
            const command =
              config.config.type === 'command' ? config.config.command : '';
            const hookType = config.config.type;

            return (
              <Box key={index}>
                {/* Left column: selector + command */}
                <Box width={commandWidth}>
                  <Box minWidth={2}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                    >
                      {isSelected ? '❯' : ' '}
                    </Text>
                  </Box>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                    bold={isSelected}
                    wrap="wrap"
                  >
                    {`${index + 1}. [${hookType}] ${command}`}
                  </Text>
                </Box>
                {/* Spacer between columns */}
                <Box width={2} />
                {/* Right column: source */}
                <Box width={sourceWidth}>
                  <Text color={theme.text.secondary} wrap="wrap">
                    {sourceDisplay}
                  </Text>
                </Box>
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Enter to select · Esc to go back')}
            </Text>
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
