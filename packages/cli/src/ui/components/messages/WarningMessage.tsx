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

interface WarningMessageProps {
  text: string;
}

export const WarningMessage: React.FC<WarningMessageProps> = ({ text }) => {
  const prefix = FEED_MARKER.warning;

  return (
    <PrefixedMessage
      prefix={<Text color={theme.status.warning}>{prefix}</Text>}
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
    >
      <RenderInline
        text={text}
        defaultColor={theme.status.warning}
        codespanColor={theme.status.warning}
      />
    </PrefixedMessage>
  );
};
