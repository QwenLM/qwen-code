/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { TaskUpdateDiffDisplay as TaskUpdateDiffDisplayData } from '@qwen-code/qwen-code-core';
import { Colors } from '../colors.js';
import { theme } from '../semantic-colors.js';

const FIELD_COL_WIDTH = 14;
const DESC_MAX_LEN = 80;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

interface Props {
  data: TaskUpdateDiffDisplayData;
}

export const TaskUpdateDiffDisplay: React.FC<Props> = ({ data }) => (
    <Box flexDirection="column">
      {/* Task title header */}
      <Box>
        <Text color={theme.text.primary}>{data.title}</Text>
      </Box>

      {data.changes.length === 0 ? (
        <Box>
          <Text color={theme.text.secondary}>no changes</Text>
        </Box>
      ) : (
        data.changes.map(({ field, from, to }) => {
          const isString = field === 'title' || field === 'description';
          const fromDisplay = isString
            ? `"${truncate(from, DESC_MAX_LEN)}"`
            : from;
          const toDisplay = isString ? `"${truncate(to, DESC_MAX_LEN)}"` : to;

          return (
            <Box key={field} flexDirection="row">
              <Box width={FIELD_COL_WIDTH}>
                <Text color={theme.text.secondary}>{field}</Text>
              </Box>
              <Text color={theme.text.secondary}>
                {fromDisplay}
                {' → '}
              </Text>
              <Text color={Colors.AccentGreen}>{toDisplay}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
