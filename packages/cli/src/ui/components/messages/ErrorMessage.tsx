/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { RenderInline } from '../../utils/InlineMarkdownRenderer.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';

interface ErrorMessageProps {
  text: string;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text }) => {
  const prefix = FEED_MARKER.toolError;

  return (
    <PrefixedMessage
      prefix={<Text color={theme.status.error}>{prefix}</Text>}
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
    >
      <RenderInline
        text={text}
        defaultColor={theme.status.error}
        codespanColor={theme.status.error}
      />
    </PrefixedMessage>
  );
};
