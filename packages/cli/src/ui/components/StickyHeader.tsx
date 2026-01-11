/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';

export interface StickyHeaderProps {
  children: React.ReactNode;
  width: number;
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
}

export const StickyHeader: React.FC<StickyHeaderProps> = ({
  children,
  width,
  isFirst,
  borderColor,
  borderDimColor,
}) => (
  <Box
    minHeight={1}
    flexShrink={0}
    width={width}
    borderStyle="round"
    borderColor={borderColor}
    borderDimColor={borderDimColor}
    borderBottom={false}
    borderTop={isFirst}
    borderLeft={true}
    borderRight={true}
    paddingX={1}
    paddingBottom={1}
    paddingTop={isFirst ? 0 : 1}
  >
    {children}
  </Box>
);
