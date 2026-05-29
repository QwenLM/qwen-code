/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  interpolateColor,
  resolveColor,
  supportsTrueColor,
} from '../../themes/color-utils.js';

export interface HalfLinePaddedBoxProps {
  /**
   * Base accent color blended onto the terminal background at low opacity
   * to produce a subtle half-block line color.
   */
  bandColor: string;
  /**
   * Blend factor (0–1) from terminal background toward bandColor.
   * Lower = more subtle. Default 0.35.
   */
  bandOpacity?: number;
  /** Width, in columns, of the band lines. */
  width: number;
  /** When false, renders children without the band. */
  useBackgroundColor?: boolean;
  children: React.ReactNode;
}

/**
 * Renders two thin half-block accent lines (▄ above, ▀ below) around content.
 * The line color is `bandColor` blended at low opacity onto
 * `theme.background.primary`, so it stays subtle on both light and dark
 * themes. The content area has no backgroundColor — it inherits the terminal's
 * real background.
 */
export const HalfLinePaddedBox: React.FC<HalfLinePaddedBoxProps> = (props) => {
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  if (props.useBackgroundColor === false || isScreenReaderEnabled) {
    return <>{props.children}</>;
  }
  return <HalfLinePaddedBoxInternal {...props} />;
};

const HalfLinePaddedBoxInternal: React.FC<HalfLinePaddedBoxProps> = ({
  bandColor,
  bandOpacity = 0.15,
  width,
  children,
}) => {
  const terminalBg = theme.background.primary || 'black';

  const lineColor = useMemo(() => {
    const bg = resolveColor(terminalBg) || terminalBg;
    const accent = resolveColor(bandColor) || bandColor;
    return interpolateColor(bg, accent, bandOpacity);
  }, [bandColor, bandOpacity, terminalBg]);

  if (!lineColor) {
    return <>{children}</>;
  }

  if (!supportsTrueColor()) {
    return <>{children}</>;
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      alignItems="stretch"
      minHeight={1}
      flexShrink={0}
    >
      <Box width={width} flexDirection="row">
        <Text color={lineColor}>{'▄'.repeat(width)}</Text>
      </Box>
      {children}
      <Box width={width} flexDirection="row">
        <Text color={lineColor}>{'▀'.repeat(width)}</Text>
      </Box>
    </Box>
  );
};
