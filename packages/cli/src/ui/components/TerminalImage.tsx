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
  renderTerminalImage,
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
  const writtenSequence = React.useRef<string | null>(null);
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

  const kittySequence = result?.kind === 'kitty' ? result.sequence : null;
  React.useEffect(() => {
    writtenSequence.current = null;
  }, [filePath]);
  React.useEffect(() => {
    if (!kittySequence || writtenSequence.current === kittySequence) return;
    writtenSequence.current = kittySequence;
    process.nextTick(() => writeRaw(kittySequence));
  }, [kittySequence, writeRaw]);

  const fileName = sanitizeMultilineForDisplay(path.basename(filePath));
  if (!safePath) {
    return (
      <Text color={theme.status.error}>
        Refusing to display an image outside the current workspace.
      </Text>
    );
  }
  if (!result) return null;
  if (result.kind === 'unavailable') {
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
