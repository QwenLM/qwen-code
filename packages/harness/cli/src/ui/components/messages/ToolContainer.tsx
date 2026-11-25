/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { INDENT } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { theme } from '../../semantic-colors.js';
import { StickyHeader } from '../StickyHeader.js';

export interface ToolContainerStickyProps {
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
}

export interface ToolContainerProps {
  /** Tool header (status indicator + tool info) — rendered at INDENT.TOOL_HEADER */
  header: React.ReactNode;
  /** Tool content (result/output) — rendered at INDENT.TOOL_CONTENT. Pass null to skip. */
  children: React.ReactNode | null;
  /** Optional payload (diff/grep etc.) — rendered at INDENT.TOOL_PAYLOAD */
  payload?: React.ReactNode;
  /** Optional footer status information. */
  footer?: React.ReactNode;
  /** Width control */
  terminalWidth: number;
  /** Whether to use StickyHeader for the header slot */
  sticky?: boolean;
  /** StickyHeader related props (required when sticky=true) */
  stickyProps?: ToolContainerStickyProps;
}

/**
 * ToolContainer — unified base component for tool display.
 *
 * Provides standardized render slots with semantic INDENT constants:
 * - Header at INDENT.TOOL_HEADER (0)
 * - Content connector at INDENT.TOOL_CONTENT (2)
 * - Content body / payload at INDENT.TOOL_PAYLOAD (4)
 *
 * Rule M4: Tool header/content must use ToolContainer.
 */
export const ToolContainer: React.FC<ToolContainerProps> = ({
  header,
  children,
  payload,
  footer,
  terminalWidth,
  sticky,
  stickyProps,
}) => {
  const headerContent = <Box paddingLeft={INDENT.TOOL_HEADER}>{header}</Box>;
  const resultBodyWidth = Math.max(1, terminalWidth - INDENT.TOOL_PAYLOAD);

  return (
    <>
      {sticky && stickyProps ? (
        <StickyHeader
          width={terminalWidth}
          isFirst={stickyProps.isFirst}
          borderColor={stickyProps.borderColor}
          borderDimColor={stickyProps.borderDimColor}
        >
          {header}
        </StickyHeader>
      ) : (
        headerContent
      )}
      {children != null && (
        <Box
          width={terminalWidth}
          paddingLeft={INDENT.TOOL_CONTENT}
          flexDirection="row"
        >
          <Text color={theme.border.default}>
            {FEED_MARKER.toolResultConnector}
          </Text>
          <Box width={resultBodyWidth} flexDirection="column" flexShrink={1}>
            {children}
          </Box>
        </Box>
      )}
      {payload && (
        <Box marginLeft={INDENT.TOOL_PAYLOAD} flexDirection="column">
          {payload}
        </Box>
      )}
      {footer}
    </>
  );
};
