/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import React from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
import type { Config, TerminalImageDisplay } from '@qwen-code/qwen-code-core';
import type { InlineImageData } from '../types.js';
import { MaxSizedBox } from './shared/MaxSizedBox.js';
import { useTerminalOutput } from '../contexts/TerminalOutputContext.js';
import {
  markKittyImageWritten,
  prepareInlineTerminalImage,
  renderTerminalImage,
  wasKittyImageWritten,
  type TerminalImageRenderResult,
} from '../utils/terminal-image-renderer.js';
import { theme } from '../semantic-colors.js';
import {
  sanitizeMultilineForDisplay,
  sanitizeTerminalText,
} from '../utils/textUtils.js';

interface SharedTerminalImageProps {
  contentWidth: number;
  availableTerminalHeight?: number;
}

interface FileTerminalImageProps extends SharedTerminalImageProps {
  data: TerminalImageDisplay;
  config: Config;
}

interface InlineTerminalImageProps extends SharedTerminalImageProps {
  image: InlineImageData;
}

type TerminalImageProps = FileTerminalImageProps | InlineTerminalImageProps;

const RenderedTerminalImage: React.FC<
  SharedTerminalImageProps & {
    result: TerminalImageRenderResult;
    unavailableText: string;
  }
> = ({ result, unavailableText, contentWidth, availableTerminalHeight }) => {
  const writeRaw = useTerminalOutput();

  React.useEffect(() => {
    if (result.kind !== 'kitty') return;
    if (wasKittyImageWritten(result.key)) return;
    markKittyImageWritten(result.key);
    const sequence = result.sequence;
    process.nextTick(() => writeRaw(sequence));
  }, [result, writeRaw]);

  if (result.kind === 'unavailable') {
    return (
      <Text color={theme.text.secondary} wrap="wrap">
        {unavailableText}
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

const FileTerminalImage: React.FC<FileTerminalImageProps> = ({
  data,
  config,
  contentWidth,
  availableTerminalHeight,
}) => {
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

  if (!safePath) {
    return (
      <Text color={theme.status.error}>
        Refusing to display an image outside the current workspace.
      </Text>
    );
  }
  if (!result) return null;
  const unavailableText =
    result.kind === 'unavailable'
      ? `${sanitizeMultilineForDisplay(path.basename(filePath))}: ${sanitizeTerminalText(result.reason)}`
      : '';

  return (
    <RenderedTerminalImage
      result={result}
      unavailableText={unavailableText}
      contentWidth={contentWidth}
      availableTerminalHeight={availableTerminalHeight}
    />
  );
};

const InlineTerminalImage: React.FC<InlineTerminalImageProps> = ({
  image,
  contentWidth,
  availableTerminalHeight,
}) => {
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const prepared = React.useMemo(
    () =>
      prepareInlineTerminalImage({
        data: image.data,
        mimeType: image.mimeType,
        contentWidth,
        availableTerminalHeight,
        disabled: isScreenReaderEnabled,
      }),
    [
      availableTerminalHeight,
      contentWidth,
      image.data,
      image.mimeType,
      isScreenReaderEnabled,
    ],
  );

  if (!prepared.result) {
    return <Text color={theme.text.secondary}>{prepared.fallbackText}</Text>;
  }
  return (
    <RenderedTerminalImage
      result={prepared.result}
      unavailableText={
        prepared.result.kind === 'unavailable'
          ? `${prepared.fallbackText}: ${sanitizeTerminalText(prepared.result.reason)}`
          : prepared.fallbackText
      }
      contentWidth={contentWidth}
      availableTerminalHeight={availableTerminalHeight}
    />
  );
};

export const TerminalImage: React.FC<TerminalImageProps> = (props) =>
  'image' in props ? (
    <InlineTerminalImage {...props} />
  ) : (
    <FileTerminalImage {...props} />
  );
