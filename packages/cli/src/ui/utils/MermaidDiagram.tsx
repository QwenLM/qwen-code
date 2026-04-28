/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../semantic-colors.js';
import { MaxSizedBox } from '../components/shared/MaxSizedBox.js';
import { renderMermaidVisual } from './mermaidVisualRenderer.js';
import { renderMermaidImageSync } from './mermaidImageRenderer.js';

interface MermaidDiagramProps {
  source: string;
  sourceCopyCommand: string;
  contentWidth: number;
  isPending: boolean;
  availableTerminalHeight?: number;
}

const MERMAID_PADDING = 1;

const MermaidDiagramInternal: React.FC<MermaidDiagramProps> = ({
  source,
  sourceCopyCommand,
  contentWidth,
  isPending,
  availableTerminalHeight,
}) => {
  const { write } = useStdout();
  const preparedKittySequence = React.useRef<string | null>(null);
  const innerWidth = Math.max(8, contentWidth - MERMAID_PADDING);
  const visual = React.useMemo(
    () => renderMermaidVisual(source, innerWidth),
    [source, innerWidth],
  );
  const image = React.useMemo(
    () =>
      isPending
        ? null
        : renderMermaidImageSync({
            source,
            contentWidth: innerWidth,
            availableTerminalHeight,
          }),
    [availableTerminalHeight, innerWidth, isPending, source],
  );

  const kittySequence =
    image?.kind === 'terminal-image' &&
    image.protocol === 'kitty' &&
    image.placeholder
      ? image.sequence
      : null;

  React.useEffect(() => {
    if (!kittySequence || preparedKittySequence.current === kittySequence) {
      return;
    }
    preparedKittySequence.current = kittySequence;
    write(kittySequence);
  }, [kittySequence, write]);

  const titleWithSourceHint = (title: string) =>
    `${title} · source: ${sourceCopyCommand}`;

  if (
    image?.kind === 'terminal-image' &&
    image.protocol === 'kitty' &&
    image.placeholder
  ) {
    return (
      <Box
        paddingLeft={MERMAID_PADDING}
        flexDirection="column"
        width={contentWidth}
        flexShrink={0}
      >
        <Text bold color={theme.text.accent}>
          {titleWithSourceHint(visual.title)}
        </Text>
        <MaxSizedBox
          maxHeight={availableTerminalHeight}
          maxWidth={innerWidth}
          overflowDirection="bottom"
        >
          {image.placeholder.lines.map((line, index) => (
            <Box key={index}>
              <Text color={image.placeholder!.color} wrap="truncate-end">
                {line}
              </Text>
            </Box>
          ))}
        </MaxSizedBox>
      </Box>
    );
  }

  if (image?.kind === 'terminal-image') {
    return (
      <Box
        paddingLeft={MERMAID_PADDING}
        flexDirection="column"
        width={contentWidth}
        flexShrink={0}
      >
        <Text bold color={theme.text.accent}>
          {titleWithSourceHint(visual.title)}
        </Text>
        <Box flexDirection="column" height={image.rows}>
          <Text>{image.sequence}</Text>
        </Box>
      </Box>
    );
  }

  if (image?.kind === 'ansi') {
    return (
      <Box
        paddingLeft={MERMAID_PADDING}
        flexDirection="column"
        width={contentWidth}
        flexShrink={0}
      >
        <Text bold color={theme.text.accent}>
          {titleWithSourceHint(visual.title)}
        </Text>
        <MaxSizedBox
          maxHeight={availableTerminalHeight}
          maxWidth={innerWidth}
          overflowDirection="bottom"
        >
          {image.lines.map((line, index) => (
            <Box key={index}>
              <Text>{line || ' '}</Text>
            </Box>
          ))}
        </MaxSizedBox>
      </Box>
    );
  }

  return (
    <Box
      paddingLeft={MERMAID_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      <Text bold color={theme.text.accent}>
        {titleWithSourceHint(visual.title)}
      </Text>
      <MaxSizedBox
        maxHeight={availableTerminalHeight}
        maxWidth={innerWidth}
        overflowDirection="bottom"
      >
        {visual.lines.map((line, index) => (
          <Box key={index}>
            <Text color={theme.text.primary}>{line || ' '}</Text>
          </Box>
        ))}
      </MaxSizedBox>
      {visual.warning && (
        <Text color={theme.text.secondary} wrap="wrap">
          {visual.warning}
        </Text>
      )}
      {!isPending && image?.kind === 'unavailable' && (
        <Text color={theme.text.secondary} wrap="wrap">
          Image rendering unavailable: {image.reason}
        </Text>
      )}
    </Box>
  );
};

export const MermaidDiagram = React.memo(MermaidDiagramInternal);
