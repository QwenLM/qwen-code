/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { INDENT } from '../../constants/messageLayout.js';

export interface PrefixedMessageBackground {
  /** The solid background color. */
  baseColor: string;
}

export interface PrefixedMessageProps {
  /** Prefix icon or custom ReactNode (e.g., AnimatedPrefix) */
  prefix: React.ReactNode;
  /** Prefix fixed width (character count) */
  prefixWidth: number;
  /** Content area */
  children: React.ReactNode;
  /** Optional message background surface configuration. */
  background?: PrefixedMessageBackground;
  /** Optional: Whether to use background color (from user config) */
  useBackgroundColor?: boolean;
  /** Optional: Full width of the component */
  width?: number;
  /** Optional: left inset for top-level feed alignment */
  leftInset?: number;
}

/**
 * PrefixedMessage — unified base component for messages with a leading icon/prefix.
 *
 * Covers: UserMessage, HintMessage, AssistantMessage, InfoMessage, WarningMessage,
 * ErrorMessage, CompressionMessage, etc.
 *
 * Rule M3: Messages with prefixes must use PrefixedMessage.
 * Rule M7: Message backgrounds are only applied via PrefixedMessage.background.
 */
export const PrefixedMessage: React.FC<PrefixedMessageProps> = ({
  prefix,
  prefixWidth,
  children,
  background,
  useBackgroundColor,
  width,
  leftInset = INDENT.FEED_LEFT_OFFSET,
}) => {
  const hasBackgroundPadding =
    Boolean(background) && useBackgroundColor !== false;

  const inner = (
    <Box
      flexDirection="row"
      paddingY={0}
      paddingLeft={hasBackgroundPadding ? INDENT.FEED_LEFT_OFFSET : leftInset}
      paddingRight={hasBackgroundPadding ? INDENT.FEED_LEFT_OFFSET : 0}
      alignSelf="flex-start"
      {...(width !== undefined ? { width } : {})}
    >
      <Box width={prefixWidth} flexShrink={0}>
        {typeof prefix === 'string' ? <Text>{prefix}</Text> : prefix}
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );

  if (background) {
    return (
      <Box
        width="100%"
        flexDirection="column"
        alignItems="stretch"
        backgroundColor={
          useBackgroundColor === false ? undefined : background.baseColor
        }
      >
        {inner}
      </Box>
    );
  }

  return inner;
};
