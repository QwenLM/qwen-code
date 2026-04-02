/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { BtwProps } from '../../types.js';
import { Colors } from '../../colors.js';
import { t } from '../../../i18n/index.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

export interface BtwDisplayProps {
  btw: BtwProps;
}

// marginX(2)*2 + border(1)*2 + paddingX(1)*2 = 8
const BTW_CHROME_WIDTH = 8;

const BtwMessageInternal: React.FC<BtwDisplayProps> = ({ btw }) => {
  const { columns: terminalWidth } = useTerminalSize();
  const contentWidth = Math.max(20, terminalWidth - BTW_CHROME_WIDTH);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentYellow}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row">
        <Text color={Colors.AccentYellow} bold>
          {'/btw '}
        </Text>
        <Text wrap="wrap" color={Colors.AccentYellow}>
          {btw.question}
        </Text>
      </Box>
      {btw.isPending ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={Colors.AccentYellow}>{'+ '}</Text>
            <Text color={Colors.AccentYellow}>{t('Answering...')}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t('Press Escape to cancel')}</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <MarkdownDisplay
            text={btw.answer}
            isPending={false}
            contentWidth={contentWidth}
          />
          <Box marginTop={1}>
            <Text dimColor>
              {t('Press Space, Enter, or Escape to dismiss')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export const BtwMessage = React.memo(BtwMessageInternal);
