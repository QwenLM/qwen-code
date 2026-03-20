/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { memo } from 'react';
import { Box, Text } from 'ink';
import type { BtwProps } from '../../types.js';
import { Colors } from '../../colors.js';
import { t } from '../../../i18n/index.js';

export interface BtwDisplayProps {
  btw: BtwProps;
}

const BtwMessageInner: React.FC<BtwDisplayProps> = ({ btw }) => (
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
      <Box>
        <Text color={Colors.AccentYellow}>{'+ '}</Text>
        <Text color={Colors.AccentYellow}>{t('Answering...')}</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text wrap="wrap">{btw.answer}</Text>
        <Box marginTop={1}>
          <Text dimColor>{t('Press Space, Enter, or Escape to dismiss')}</Text>
        </Box>
      </Box>
    )}
  </Box>
);

export const BtwMessage = memo(BtwMessageInner);
