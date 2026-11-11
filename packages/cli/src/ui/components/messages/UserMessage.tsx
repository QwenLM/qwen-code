/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_USER_PREFIX } from '../../textConstants.js';
import { isSlashCommand as checkIsSlashCommand } from '../../utils/commandUtils.js';
import {
  calculateTransformationsForLine,
  calculateTransformedLine,
} from '../shared/text-buffer.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { useConfig } from '../../contexts/ConfigContext.js';

interface UserMessageProps {
  text: string;
  width: number;
}

export const UserMessage: React.FC<UserMessageProps> = ({ text, width }) => {
  const prefix = '> ';
  const isSlashCommand = checkIsSlashCommand(text);
  const config = useConfig();
  const useBackgroundColor = config.getUseBackgroundColor();

  const textColor = isSlashCommand ? theme.text.accent : theme.text.primary;

  const displayText = useMemo(() => {
    if (!text) return text;
    return text
      .split('\n')
      .map((line) => {
        const transformations = calculateTransformationsForLine(line);
        // We pass a cursor position of [-1, -1] so that no transformations are expanded (e.g. images remain collapsed)
        const { transformedLine } = calculateTransformedLine(
          line,
          0, // line index doesn't matter since cursor is [-1, -1]
          [-1, -1],
          transformations,
        );
        return transformedLine;
      })
      .join('\n');
  }, [text]);

  return (
    <PrefixedMessage
      prefix={
        <Text color={theme.text.accent} aria-label={SCREEN_READER_USER_PREFIX}>
          {prefix}
        </Text>
      }
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
      background={{ baseColor: theme.background.message }}
      useBackgroundColor={useBackgroundColor}
      width={width}
    >
      <Text wrap="wrap" color={textColor}>
        {displayText}
      </Text>
    </PrefixedMessage>
  );
};
