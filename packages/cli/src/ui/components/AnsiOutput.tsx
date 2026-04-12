/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type {
  AnsiLine,
  AnsiOutput,
  AnsiToken,
} from '@qwen-code/qwen-code-core';
import { formatDuration, formatMemoryUsage } from '../utils/formatters.js';
import { theme } from '../semantic-colors.js';

const DEFAULT_HEIGHT = 24;

interface AnsiOutputProps {
  data: AnsiOutput;
  availableTerminalHeight?: number;
}

export const AnsiOutputText: React.FC<AnsiOutputProps> = ({
  data,
  availableTerminalHeight,
}) => {
  const lastLines = data.slice(
    -(availableTerminalHeight && availableTerminalHeight > 0
      ? availableTerminalHeight
      : DEFAULT_HEIGHT),
  );
  return lastLines.map((line: AnsiLine, lineIndex: number) => (
    <Text key={lineIndex}>
      {line.length > 0
        ? line.map((token: AnsiToken, tokenIndex: number) => (
            <Text
              key={tokenIndex}
              color={token.inverse ? token.bg : token.fg}
              backgroundColor={token.inverse ? token.fg : token.bg}
              dimColor={token.dim}
              bold={token.bold}
              italic={token.italic}
              underline={token.underline}
            >
              {token.text}
            </Text>
          ))
        : null}
    </Text>
  ));
};

export interface ShellStatsBarProps {
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  displayHeight?: number;
}

export const ShellStatsBar: React.FC<ShellStatsBarProps> = ({
  totalLines,
  totalBytes,
  timeoutMs,
  displayHeight = DEFAULT_HEIGHT,
}) => {
  const parts: string[] = [];
  if (totalLines && totalLines > displayHeight) {
    parts.push(`+${totalLines - displayHeight} lines`);
  }
  if (timeoutMs) {
    parts.push(`timeout ${formatDuration(timeoutMs)}`);
  }
  if (totalBytes && totalBytes > 0) {
    parts.push(formatMemoryUsage(totalBytes));
  }
  if (parts.length === 0) return null;
  return (
    <Box flexDirection="row" gap={1}>
      {parts.map((part, i) => (
        <Text key={i} color={theme.text.secondary}>
          {part}
        </Text>
      ))}
    </Box>
  );
};
