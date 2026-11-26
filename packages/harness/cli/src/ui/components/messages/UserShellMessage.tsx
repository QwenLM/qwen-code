/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { useConfig } from '../../contexts/ConfigContext.js';

interface UserShellMessageProps {
  text: string;
  width: number;
}

export const UserShellMessage: React.FC<UserShellMessageProps> = ({
  text,
  width,
}) => {
  const config = useConfig();
  const useBackgroundColor = config.getUseBackgroundColor();

  // Remove leading '!' if present, as App.tsx adds it for the processor.
  const commandToDisplay = text.startsWith('!') ? text.substring(1) : text;

  return (
    <PrefixedMessage
      prefix={<Text color={theme.ui.symbol}>$ </Text>}
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
      background={{ baseColor: theme.background.message }}
      useBackgroundColor={useBackgroundColor}
      width={width}
    >
      <Text color={theme.text.primary}>{commandToDisplay}</Text>
    </PrefixedMessage>
  );
};
