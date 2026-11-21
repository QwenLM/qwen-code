/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';

export * from './stats-formatters.js';

export const TableRow: React.FC<{
  cells: Array<{ text: string; width: number; color?: string; bold?: boolean }>;
}> = ({ cells }) => (
  <Box>
    {cells.map((cell, i) => (
      <Box key={i} width={cell.width}>
        <Text color={cell.color} bold={cell.bold}>
          {cell.text}
        </Text>
      </Box>
    ))}
  </Box>
);
