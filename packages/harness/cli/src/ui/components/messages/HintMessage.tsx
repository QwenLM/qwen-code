/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_USER_PREFIX } from '../../textConstants.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { useConfig } from '../../contexts/ConfigContext.js';

interface HintMessageProps {
  text: string;
}

export const HintMessage: React.FC<HintMessageProps> = ({ text }) => {
  const prefix = '💡 ';
  const prefixWidth = prefix.length;
  const config = useConfig();
  const useBackgroundColor = config.getUseBackgroundColor();

  return (
    <PrefixedMessage
      prefix={
        <Text color={theme.text.accent} aria-label={SCREEN_READER_USER_PREFIX}>
          {prefix}
        </Text>
      }
      prefixWidth={prefixWidth}
      background={{ baseColor: theme.background.message }}
      useBackgroundColor={useBackgroundColor}
    >
      <Text wrap="wrap" italic color={theme.text.accent}>
        {`Steering Hint: ${text}`}
      </Text>
    </PrefixedMessage>
  );
};
