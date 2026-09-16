/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { describeHookConfig } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';
import { HookType } from '@qwen-code/qwen-code-core/hooks/types.js';
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
        const hookDisplay = describeHookConfig(config.config);
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
                {!config.enabled && (
                  <Text
                    color={theme.status.warning}
                  >{`  ${t('disabled')}`}</Text>
                )}
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

function formatTypeDisplay(info: HookConfigDisplayInfo): string {
  const { config } = info;
  const isAsync = config.type === HookType.Command && config.async === true;
  return isAsync ? `${config.type} async` : String(config.type);
}
