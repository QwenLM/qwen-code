/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import stringWidth from 'string-width';
import { theme } from '../../semantic-colors.js';
import { RenderInline } from '../../utils/InlineMarkdownRenderer.js';

interface StatusMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  textColor: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}

interface StatusTextProps {
  text: string;
  linkUrl?: string;
  linkText?: string;
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
  children,
  footer,
}) => {
  if ((!text || text.trim() === '') && !footer) {
    return null;
  }

  const prefixWidth = stringWidth(prefix) + 1;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={prefixColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {text && text.trim() !== '' && (
          <Text wrap="wrap" color={textColor}>
            <RenderInline text={text} />
            {children}
          </Text>
        )}
        {footer}
      </Box>
    </Box>
  );
};

export const InfoMessage: React.FC<StatusTextProps> = ({
  text,
  linkUrl,
  linkText,
}) => (
  <StatusMessage
    text={text}
    prefix="●"
    prefixColor={theme.text.primary}
    textColor={theme.text.primary}
    footer={
      linkUrl && (
        <Link url={linkUrl}>
          <Text color={theme.text.link} underline>
            {linkText ?? linkUrl}
          </Text>
        </Link>
      )
    }
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
    prefix="△"
    prefixColor={theme.status.warning}
    textColor={theme.status.warning}
  />
);

export const ErrorMessage: React.FC<StatusTextProps & { hint?: string }> = ({
  text,
  hint,
}) => (
  <StatusMessage
    text={text}
    prefix="✕"
    prefixColor={theme.status.error}
    textColor={theme.status.error}
  >
    {hint && <Text color={theme.text.secondary}> ({hint})</Text>}
  </StatusMessage>
);

export const RetryCountdownMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="↻"
    prefixColor={theme.text.secondary}
    textColor={theme.text.secondary}
  />
);

export const AwayRecapMessage: React.FC<StatusTextProps> = ({ text }) => (
  <StatusMessage
    text={text}
    prefix="❯"
    prefixColor={theme.text.secondary}
    textColor={theme.text.secondary}
  />
);
