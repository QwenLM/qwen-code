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
   * to produce the band color.
   */
  bandColor: string;
  /**
   * Blend factor (0–1) from terminal background toward bandColor.
   * Lower = more subtle. Default 0.15.
   */
  bandOpacity?: number;
  /** Width, in columns, of the band lines and content background. */
  width: number;
  /** When false, renders children without the band. */
  useBackgroundColor?: boolean;
  children: React.ReactNode;
}

/**
 * Renders a smooth half-line accent band around content, matching gemini-cli's
 * technique:
 *
 *   ▄▄▄▄  foreground = bandColor (bottom half colored, top half = terminal bg)
 *   content  backgroundColor = bandColor (full row colored)
 *   ▀▀▀▀  foreground = bandColor (top half colored, bottom half = terminal bg)
 *
 * The ▄/▀ lines have NO explicit backgroundColor set, so the terminal's real
 * background naturally fills the un-colored half of each cell. This avoids
 * color mismatches when theme.background.primary doesn't perfectly match the
 * real terminal background. The content area uses backgroundColor for a
 * seamless band.
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

  const blendedColor = useMemo(() => {
    const bg = resolveColor(terminalBg) || terminalBg;
    const accent = resolveColor(bandColor) || bandColor;
    return interpolateColor(bg, accent, bandOpacity);
  }, [bandColor, bandOpacity, terminalBg]);

  if (!blendedColor) {
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
      {/* Top half-line: foreground = band color, background = terminal default */}
      <Text color={blendedColor}>{'▄'.repeat(width)}</Text>
      {/* Content area: full backgroundColor for seamless band */}
      <Box width={width} flexDirection="column">
        <Text backgroundColor={blendedColor}>{' '.repeat(width)}</Text>
        <Box marginTop={-1}>{children}</Box>
      </Box>
      {/* Bottom half-line: foreground = band color, background = terminal default */}
      <Text color={blendedColor}>{'▀'.repeat(width)}</Text>
    </Box>
  );
};
