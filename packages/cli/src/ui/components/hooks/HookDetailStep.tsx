/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { HookEventDisplayInfo } from './types.js';
import { HooksConfigSource, HookType } from '@qwen-code/qwen-code-core';
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

            // Get display text based on hook type
            let hookDisplay = '';
            const hookType = config.config.type;

            if (hookType === HookType.Command) {
              // For command hook, show command (truncate if too long)
              hookDisplay = config.config.command || '';
            } else if (hookType === HookType.Http) {
              // For http hook, show name or url
              hookDisplay = config.config.name || config.config.url || '';
            } else if (hookType === HookType.Function) {
              // For function hook, show name or id
              hookDisplay =
                config.config.name || config.config.id || 'function-hook';
            } else if (hookType === HookType.Prompt) {
              // For prompt hook, show name or prompt content (truncated)
              const promptText = config.config.prompt || '';
              const maxLength = 50;
              hookDisplay =
                config.config.name ||
                (promptText.length > maxLength
                  ? promptText.slice(0, maxLength) + '...'
                  : promptText);
            }

            // Check if this is an async hook (only command hooks support async)
            const isAsync =
              hookType === HookType.Command && config.config.async === true;
            const typeDisplay = isAsync
              ? `${hookType} async`
              : String(hookType);

            return (
              <Box key={index}>
                {/* Left column: selector + display */}
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
                    {`${index + 1}. [${typeDisplay}] ${hookDisplay}`}
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
