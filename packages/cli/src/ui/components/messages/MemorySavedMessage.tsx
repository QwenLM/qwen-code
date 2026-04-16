/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { HistoryItemMemorySaved } from '../../types.js';

interface MemorySavedMessageProps {
  item: HistoryItemMemorySaved;
}

/**
 * Displays a post-turn notification that managed-auto-memory files were written.
 * Shown when:
 *  - The model directly wrote to memory files in-turn (via write_file / edit_file).
 *  - The background dream / extraction pipeline completed and touched memory files.
 */
export const MemorySavedMessage: React.FC<MemorySavedMessageProps> = ({
  item,
}) => {
  const verb = item.verb ?? 'Saved';
  const n = item.writtenCount;
  const label = n === 1 ? 'memory' : 'memories';

  return (
    <Box flexDirection="row">
      <Box minWidth={2}>
        <Text dimColor>●</Text>
      </Box>
      <Text dimColor>
        {verb} {n} {label}
      </Text>
    </Box>
  );
};
