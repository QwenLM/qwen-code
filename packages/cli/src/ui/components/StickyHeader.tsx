/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, type DOMElement } from 'ink';
import { INDENT } from '../constants/messageLayout.js';

export interface StickyHeaderProps {
  children: React.ReactNode;
  width: number;
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
  containerRef?: React.RefObject<DOMElement | null>;
}

export const StickyHeader: React.FC<StickyHeaderProps> = ({
  children,
  width,
  isFirst: _isFirst,
  borderColor: _borderColor,
  borderDimColor: _borderDimColor,
  containerRef,
}) => (
  <Box
    ref={containerRef}
    sticky
    minHeight={1}
    flexShrink={0}
    width={width}
    stickyChildren={
      <Box flexDirection="column" width={width} opaque>
        <Box paddingLeft={INDENT.TOOL_HEADER}>{children}</Box>
      </Box>
    }
  >
    <Box width={width} paddingLeft={INDENT.TOOL_HEADER}>
      {children}
    </Box>
  </Box>
);
