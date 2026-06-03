/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { HookType } from '@qwen-code/qwen-code-core';
import type { HookConfigDisplayInfo } from './types.js';
import { getConfigSourceDisplay } from './sourceLabels.js';
import { t } from '../../../i18n/index.js';

interface HandlerListBodyProps {
  configs: HookConfigDisplayInfo[];
  selectedIndex: number;
}

export function HandlerListBody({
  configs,
  selectedIndex,
}: HandlerListBodyProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();
  const commandWidth = Math.floor(terminalWidth * 0.65);
  const sourceWidth = Math.floor(terminalWidth * 0.3);

  return (
    <>
      <Text bold color={theme.text.primary}>
        {t('Configured hooks:')}
      </Text>
      {configs.map((config, index) => {
        const isSelected = index === selectedIndex;
        const sourceDisplay = getConfigSourceDisplay(config);
        const hookDisplay = describeHook(config);
        const typeDisplay = formatTypeDisplay(config);

        return (
          <Box key={index}>
            <Box width={commandWidth}>
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
                wrap="wrap"
              >
                {`${index + 1}. [${typeDisplay}] ${hookDisplay}`}
              </Text>
            </Box>
            <Box width={2} />
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
  );
}

function describeHook(info: HookConfigDisplayInfo): string {
  const { config } = info;
  switch (config.type) {
    case HookType.Command:
      return config.command || '';
    case HookType.Http:
      return config.name || config.url || '';
    case HookType.Function:
      return config.name || config.id || 'function-hook';
    case HookType.Prompt: {
      const promptText = config.prompt || '';
      const maxLength = 50;
      return (
        config.name ||
        (promptText.length > maxLength
          ? promptText.slice(0, maxLength) + '...'
          : promptText)
      );
    }
    case HookType.Agent:
      return config.name || `agent:${config.agent ?? 'general-purpose'}`;
    default: {
      const _exhaustive: never = config;
      void _exhaustive;
      return '';
    }
  }
}

function formatTypeDisplay(info: HookConfigDisplayInfo): string {
  const { config } = info;
  const isAsync = config.type === HookType.Command && config.async === true;
  return isAsync ? `${config.type} async` : String(config.type);
}
