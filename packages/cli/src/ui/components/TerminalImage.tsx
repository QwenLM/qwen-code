/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import React from 'react';
import { Box, Text } from 'ink';
import type { Config, TerminalImageDisplay } from '@qwen-code/qwen-code-core';
import { MaxSizedBox } from './shared/MaxSizedBox.js';
import { useTerminalOutput } from '../contexts/TerminalOutputContext.js';
import {
  markKittyImageWritten,
  renderTerminalImage,
  wasKittyImageWritten,
  type TerminalImageRenderResult,
} from '../utils/terminal-image-renderer.js';
import { theme } from '../semantic-colors.js';
import {
  sanitizeMultilineForDisplay,
  sanitizeTerminalText,
} from '../utils/textUtils.js';

interface TerminalImageProps {
  data: TerminalImageDisplay;
  config: Config;
  contentWidth: number;
  availableTerminalHeight?: number;
}

export const TerminalImage: React.FC<TerminalImageProps> = ({
  data,
  config,
  contentWidth,
  availableTerminalHeight,
}) => {
  const writeRaw = useTerminalOutput();
  const filePath = path.resolve(data.filePath);
  const safePath = config.getWorkspaceContext().isPathWithinWorkspace(filePath);
  const result = React.useMemo<TerminalImageRenderResult | null>(
    () =>
      safePath
        ? renderTerminalImage({
            display: {
              type: 'terminal_image',
              filePath,
              mimeType: data.mimeType,
            },
            contentWidth,
            availableTerminalHeight,
          })
        : null,
    [availableTerminalHeight, contentWidth, data.mimeType, filePath, safePath],
  );

  // The Kitty payload is written once per terminal session per render key; the
  // terminal keeps the image and redraws it from the placeholder cells, so a
  // remount (live row -> Static row, or a resize) must not re-transmit it.
  React.useEffect(() => {
    if (!result || result.kind !== 'kitty') return;
    if (wasKittyImageWritten(result.key)) return;
    markKittyImageWritten(result.key);
    const sequence = result.sequence;
    process.nextTick(() => writeRaw(sequence));
  }, [result, writeRaw]);

  if (!safePath) {
    return (
      <Text color={theme.status.error}>
        Refusing to display an image outside the current workspace.
      </Text>
    );
  }
  if (!result) return null;
  if (result.kind === 'unavailable') {
    const fileName = sanitizeMultilineForDisplay(path.basename(filePath));
    return (
      <Text color={theme.text.secondary} wrap="wrap">
        {fileName}: {sanitizeTerminalText(result.reason)}
      </Text>
    );
  }
  if (result.kind === 'ansi') {
    return (
      <MaxSizedBox
        maxHeight={availableTerminalHeight}
        maxWidth={contentWidth}
        overflowDirection="bottom"
      >
        {result.lines.map((line, index) => (
          <Box key={index}>
            <Text>{line || ' '}</Text>
          </Box>
        ))}
      </MaxSizedBox>
    );
  }
  return (
    <MaxSizedBox
      maxHeight={availableTerminalHeight}
      maxWidth={contentWidth}
      overflowDirection="bottom"
    >
      {result.placeholder.lines.map((line, index) => (
        <Box key={index}>
          <Text color={result.placeholder.color} wrap="truncate-end">
            {line}
          </Text>
        </Box>
      ))}
    </MaxSizedBox>
  );
};
