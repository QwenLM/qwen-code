/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { BtwProps } from '../../types.js';
import Spinner from 'ink-spinner';
import { Colors } from '../../colors.js';
import { t } from '../../../i18n/index.js';

export interface BtwDisplayProps {
  btw: BtwProps;
}

/**
 * BtwMessage renders the /btw (by the way) sidebar response.
 * Shows an ephemeral question and answer that doesn't affect the main conversation.
 */
export const BtwMessage: React.FC<BtwDisplayProps> = ({ btw }) => (
  <Box flexDirection="column">
    <Box flexDirection="row">
      <Text color={Colors.Gray} dimColor>
        {'btw> '}
      </Text>
      <Text wrap="wrap" color={Colors.Gray}>
        {btw.question}
      </Text>
    </Box>
    <Box flexDirection="row">
      {btw.isPending ? (
        <Box>
          <Box marginRight={1}>
            <Spinner type="dots" />
          </Box>
          <Text color={Colors.AccentPurple}>{t('Thinking...')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text wrap="wrap" color={Colors.AccentCyan}>
            {btw.answer}
          </Text>
        </Box>
      )}
    </Box>
  </Box>
);
