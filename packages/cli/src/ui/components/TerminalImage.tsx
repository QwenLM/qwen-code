/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Text, type DOMElement, useIsScreenReaderEnabled } from 'ink';
import type { InlineImageData } from '../types.js';
import { theme } from '../semantic-colors.js';
import { useTerminalOutput } from '../contexts/TerminalOutputContext.js';
import { useVirtualViewport } from '../contexts/VirtualViewportContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  measureElementPosition,
  measureFrameHeight,
} from '../utils/measure-element-position.js';
import { prepareTerminalImage } from '../utils/terminal-image.js';

interface TerminalImageProps {
  image: InlineImageData;
  contentWidth: number;
  availableTerminalHeight?: number;
}

interface ITerm2Placement {
  column: number;
  row: number;
}

interface ITerm2Emission extends ITerm2Placement {
  imageSequence: string;
}

export function calculateITerm2Placement(
  node: DOMElement,
  terminalHeight: number,
  requiredRows?: number,
  terminalWidth?: number,
  requiredColumns?: number,
): ITerm2Placement | null {
  const metrics = measureElementPosition(node);
  const imageRows = requiredRows ?? metrics.height;
  const frameHeight = measureFrameHeight(node);
  const renderedHeight = frameHeight - metrics.height + imageRows;
  const frameTop = Math.min(0, terminalHeight - renderedHeight);
  const row = frameTop + metrics.y;
  const column = metrics.x;
  const imageColumns = requiredColumns ?? metrics.width;

  if (
    metrics.width <= 0 ||
    imageRows <= 0 ||
    imageColumns <= 0 ||
    column < 0 ||
    row < 0 ||
    row + imageRows > terminalHeight ||
    (terminalWidth !== undefined && column + imageColumns > terminalWidth)
  ) {
    return null;
  }

  return {
    column,
    row,
  };
}

export function buildITerm2PlacementSequence(
  imageSequence: string,
  placement: ITerm2Placement,
): string {
  return `\u001b7\u001b[${placement.row + 1};${placement.column + 1}H${imageSequence}\u001b8`;
}

const TerminalImageInternal: React.FC<TerminalImageProps> = ({
  image,
  contentWidth,
  availableTerminalHeight,
}) => {
  const writeRaw = useTerminalOutput();
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const useAbsoluteTerminalCoordinates = useVirtualViewport();
  const containerRef = useRef<DOMElement>(null);
  const emittedKittySequenceRef = useRef<string | null>(null);
  const emittedITerm2PlacementRef = useRef<ITerm2Emission | null>(null);
  const [iterm2PlacementAvailable, setITerm2PlacementAvailable] =
    useState(true);
  const prepared = useMemo(
    () =>
      prepareTerminalImage({
        data: image.data,
        mimeType: image.mimeType,
        contentWidth,
        availableTerminalHeight,
      }),
    [availableTerminalHeight, contentWidth, image.data, image.mimeType],
  );

  useEffect(() => {
    if (
      isScreenReaderEnabled ||
      prepared.kind !== 'terminal-image' ||
      prepared.protocol !== 'kitty' ||
      !prepared.placeholder ||
      emittedKittySequenceRef.current === prepared.sequence
    ) {
      return;
    }
    emittedKittySequenceRef.current = prepared.sequence;
    let cancelled = false;
    let written = false;
    process.nextTick(() => {
      if (cancelled) {
        return;
      }
      written = true;
      writeRaw(prepared.sequence);
    });
    return () => {
      cancelled = true;
      if (!written && emittedKittySequenceRef.current === prepared.sequence) {
        emittedKittySequenceRef.current = null;
      }
    };
  }, [isScreenReaderEnabled, prepared, writeRaw]);

  // Parent layout and virtual scrolling can move a history item without
  // changing this component's props, so placement must be measured after every
  // render rather than from a dependency list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (
      isScreenReaderEnabled ||
      prepared.kind !== 'terminal-image' ||
      prepared.protocol !== 'iterm2' ||
      !useAbsoluteTerminalCoordinates ||
      !containerRef.current
    ) {
      emittedITerm2PlacementRef.current = null;
      return;
    }

    const placement = calculateITerm2Placement(
      containerRef.current,
      terminalHeight,
      prepared.rows,
      terminalWidth,
      prepared.widthCells,
    );
    const isAvailable = placement !== null;
    if (!placement) {
      // Ink rewrites the reserved rows with fallback text while the image is
      // outside the viewport. Forget the old placement so returning to the
      // same coordinates emits the OSC image again instead of leaving only
      // the fallback behind.
      emittedITerm2PlacementRef.current = null;
    }
    if (isAvailable !== iterm2PlacementAvailable) {
      setITerm2PlacementAvailable(isAvailable);
      return;
    }
    if (!placement) {
      return;
    }

    const previousEmission = emittedITerm2PlacementRef.current;
    if (
      previousEmission?.imageSequence === prepared.sequence &&
      previousEmission.column === placement.column &&
      previousEmission.row === placement.row
    ) {
      return;
    }
    const emission: ITerm2Emission = {
      imageSequence: prepared.sequence,
      ...placement,
    };
    emittedITerm2PlacementRef.current = emission;
    const sequence = buildITerm2PlacementSequence(prepared.sequence, placement);
    let cancelled = false;
    let written = false;
    process.nextTick(() => {
      if (cancelled) {
        return;
      }
      written = true;
      writeRaw(sequence);
    });
    return () => {
      cancelled = true;
      if (!written && emittedITerm2PlacementRef.current === emission) {
        emittedITerm2PlacementRef.current = null;
      }
    };
  });

  const fallbackText =
    prepared.kind === 'terminal-image' ? prepared.fallbackText : prepared.text;
  if (
    isScreenReaderEnabled ||
    prepared.kind === 'fallback' ||
    (prepared.protocol === 'iterm2' && !useAbsoluteTerminalCoordinates)
  ) {
    return <Text color={theme.text.secondary}>{fallbackText}</Text>;
  }

  if (prepared.protocol === 'kitty' && prepared.placeholder) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {prepared.placeholder.lines.map((line, index) => (
          <Box key={index}>
            <Text
              color={prepared.placeholder!.color}
              wrap="truncate-end"
              selectable={false}
            >
              {line}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      flexDirection="column"
      flexShrink={0}
      width={prepared.widthCells}
    >
      {iterm2PlacementAvailable ? (
        Array.from({ length: prepared.rows }, (_, index) => (
          <Text key={index} selectable={false}>
            {' '}
          </Text>
        ))
      ) : (
        <Text color={theme.text.secondary}>{fallbackText}</Text>
      )}
    </Box>
  );
};

export const TerminalImage = memo(TerminalImageInternal);
