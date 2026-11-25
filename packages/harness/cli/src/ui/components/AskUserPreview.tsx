/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useState } from 'react';
import {
  Box,
  Text,
  measureElement,
  useAfterLayout,
  type DOMElement,
} from 'ink';
import { theme } from '../semantic-colors.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';

/** A content-sized preview with a bounded viewport and visible overflow count. */
export function AskUserPreview({
  text,
  maxWidth,
  maxLines,
  previews,
}: {
  text: string;
  maxWidth: number;
  maxLines: number;
  previews: readonly string[];
}) {
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<DOMElement>(null);
  const previewRefs = useRef<Array<DOMElement | null>>([]);
  const [previewWidth, setPreviewWidth] = useState(44);
  useAfterLayout(() => {
    const width = Math.min(
      maxWidth,
      Math.max(
        44,
        ...previewRefs.current.map((node) =>
          node ? Math.ceil(measureElement(node).width) + 4 : 0,
        ),
      ),
    );
    if (width !== previewWidth) setPreviewWidth(width);
    if (contentRef.current) {
      const height = Math.round(measureElement(contentRef.current).height);
      if (height !== contentHeight) setContentHeight(height);
    }
  });

  const contentWidth = Math.max(1, maxWidth - 4);
  const hiddenLines = Math.max(0, contentHeight - maxLines);

  return (
    <Box flexDirection="column">
      {/* Measure all previews at the same terminal constraint without adding
          visible rows. Their shared width stays fixed when focus changes. */}
      <Box
        position="absolute"
        height={0}
        overflow="hidden"
        flexDirection="column"
        alignItems="flex-start"
        width={contentWidth}
        aria-hidden
      >
        {previews.map((preview, index) => (
          <Box
            key={index}
            ref={(node: DOMElement | null) => {
              previewRefs.current[index] = node;
            }}
            flexDirection="column"
            flexShrink={0}
            alignSelf="flex-start"
            maxWidth={contentWidth}
          >
            <MarkdownDisplay
              text={preview}
              isPending={false}
              terminalWidth={contentWidth}
              shrinkToContent
            />
          </Box>
        ))}
      </Box>
      <Box
        flexDirection="column"
        alignSelf="flex-start"
        width={Math.min(previewWidth, maxWidth)}
        maxWidth={maxWidth}
      >
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.border.default}
          borderBottom={hiddenLines === 0}
          paddingX={1}
        >
          <Box flexDirection="column" maxHeight={maxLines} overflow="hidden">
            {/* Measure unconstrained content, never the clipped viewport. The
            terminal-derived budget stays independent of this measurement. */}
            <Box ref={contentRef} flexDirection="column" flexShrink={0}>
              <MarkdownDisplay
                text={text}
                isPending={false}
                terminalWidth={Math.max(
                  1,
                  Math.min(previewWidth, maxWidth) - 4,
                )}
                shrinkToContent
              />
            </Box>
          </Box>
        </Box>
        {hiddenLines > 0 && (
          <>
            <Box flexDirection="row">
              <Text color={theme.status.warning} wrap="truncate">
                ├─── ✂ ─── {hiddenLines} lines hidden{' '}
              </Text>
              <Box
                flexGrow={1}
                borderStyle="single"
                borderColor={theme.status.warning}
                borderTop={false}
                borderLeft={false}
                borderRight={false}
              />
              <Box flexShrink={0}>
                <Text color={theme.status.warning}>┤</Text>
              </Box>
            </Box>
            <Box
              height={1}
              borderStyle="single"
              borderColor={theme.border.default}
              borderTop={false}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
