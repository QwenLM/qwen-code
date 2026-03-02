/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../../semantic-colors.js';
import { RenderInline } from '../../utils/InlineMarkdownRenderer.js';

interface StatusMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  textColor: string;
}

interface StatusTextProps {
  text: string;
}

/**
 * Shared renderer for status-like history messages (info/warning/error/retry).
 * Keeps prefix spacing and wrapping behavior consistent across variants.
 */
export const StatusMessage: React.FC<StatusMessageProps> = ({
  text,
  prefix,
  prefixColor,
  textColor,
}) => {
  if (!text || text.trim() === '') {
    return null;
  }

  const prefixWidth = stringWidth(prefix) + 1;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={prefixColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={textColor}>
          <RenderInline text={text} />
        </Text>
      </Box>
    </Box>
  );
};

export const InfoMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="•"
    prefixColor={theme.text.primary}
    textColor={theme.text.primary}
  />
);

export const SuccessMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="✓"
    prefixColor={theme.status.success}
    textColor={theme.status.success}
  />
);

export const WarningMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="⚠"
    prefixColor={theme.status.warning}
    textColor={theme.status.warning}
  />
);

export const ErrorMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="✕"
    prefixColor={theme.status.error}
    textColor={theme.status.error}
  />
);

export const RetryCountdownMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="↻"
    prefixColor={theme.text.secondary}
    textColor={theme.text.secondary}
  />
);
