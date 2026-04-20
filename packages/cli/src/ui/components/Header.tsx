/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { shortenPath, tildeifyPath } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { shortAsciiLogo } from './AsciiArt.js';
import { getAsciiArtWidth, getCachedStringWidth } from '../utils/textUtils.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

/**
 * Auth display type for the Header component.
 * Simplified representation of authentication method shown to users.
 */
export enum AuthDisplayType {
  QWEN_OAUTH = 'Qwen OAuth',
  CODING_PLAN = 'Coding Plan',
  API_KEY = 'API Key',
  UNKNOWN = 'Unknown',
}

interface HeaderProps {
  customAsciiArt?: string; // For user-defined ASCII art
  version: string;
  authDisplayType?: AuthDisplayType;
  model: string;
  workingDirectory: string;
}

export const Header: React.FC<HeaderProps> = ({
  customAsciiArt,
  version,
  // authDisplayType,
  model,
  workingDirectory,
}) => {
  const { columns: terminalWidth } = useTerminalSize();

  const displayLogo = customAsciiArt ?? shortAsciiLogo;
  const logoWidth = getAsciiArtWidth(displayLogo);
  // const formattedAuthType = authDisplayType ?? AuthDisplayType.UNKNOWN;

  // Calculate available space properly:
  // First determine if logo can be shown, then use remaining space for path
  const containerMarginX = 2; // marginLeft + marginRight on the outer container
  const logoGap = 2; // Gap between logo and info panel
  const infoPanelPaddingX = 1;
  const infoPanelBorderWidth = 2; // left + right border
  const infoPanelChromeWidth = infoPanelBorderWidth + infoPanelPaddingX * 2;
  const minPathLength = 40; // Minimum readable path length
  const minInfoPanelWidth = minPathLength + infoPanelChromeWidth;

  const availableTerminalWidth = Math.max(
    0,
    terminalWidth - containerMarginX * 2,
  );

  // Check if we have enough space for logo + gap + minimum info panel
  const showLogo =
    availableTerminalWidth >= logoWidth + logoGap + minInfoPanelWidth;

  // Calculate available width for info panel (use all remaining space)
  // Cap at 60 when in two-column layout (with logo)
  const maxInfoPanelWidth = 60;
  const availableInfoPanelWidth = showLogo
    ? Math.min(availableTerminalWidth - logoWidth - logoGap, maxInfoPanelWidth)
    : availableTerminalWidth;

  // Calculate max path lengths (subtract padding/borders from available space)
  const maxPathLength = Math.max(
    0,
    availableInfoPanelWidth - infoPanelChromeWidth,
  );

  const infoPanelContentWidth = Math.max(
    0,
    availableInfoPanelWidth - infoPanelChromeWidth,
  );
  const modelText = `Model: ${model}`;
  const modelHintText = ' (/model to change)';
  const showModelHint =
    infoPanelContentWidth > 0 &&
    getCachedStringWidth(modelText + modelHintText) <= infoPanelContentWidth;

  // Now shorten the path to fit the available space
  const tildeifiedPath = tildeifyPath(workingDirectory);
  const shortenedPath = shortenPath(tildeifiedPath, Math.max(3, maxPathLength));
  const displayPath =
    maxPathLength <= 0
      ? ''
      : shortenedPath.length > maxPathLength
        ? shortenedPath.slice(0, maxPathLength)
        : shortenedPath;

  // Use theme gradient colors if available, otherwise use text colors (excluding primary)
  // Note: tinygradient requires at least 2 colors, so check length
  const gradientColors =
    theme.ui.gradient && theme.ui.gradient.length >= 2
      ? theme.ui.gradient
      : [theme.text.secondary, theme.text.link, theme.text.accent];

  return (
    <Box
      flexDirection="row"
      alignItems="center"
      marginX={containerMarginX}
      width={availableTerminalWidth}
    >
      {/* Left side: ASCII logo (only if enough space) */}
      {showLogo && (
        <>
          <Box flexShrink={0}>
            <Gradient colors={gradientColors}>
              <Text>{displayLogo}</Text>
            </Gradient>
          </Box>
          {/* Fixed gap between logo and info panel */}
          <Box width={logoGap} />
        </>
      )}

      {/* Right side: Info panel (flexible width, max 60 in two-column layout) */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border.default}
        paddingX={infoPanelPaddingX}
        flexGrow={showLogo ? 0 : 1}
        width={showLogo ? availableInfoPanelWidth : undefined}
      >
        {/* Title line: >_ DataWorks DataAgent (v{version}) */}
        <Text>
          <Text bold color={theme.text.accent}>
            &gt;_ DataWorks DataAgent (Powered by Qwen Code)
          </Text>
          <Text color={theme.text.accent}> (v{version})</Text>
        </Text>
        {/* Empty line for spacing */}
        <Text color={theme.text.secondary}>
          Built-in DataWorks Official Skills
        </Text>
        {/* Model line */}
        <Text>
          <Text color={theme.text.secondary}>{modelText}</Text>
          {showModelHint && (
            <Text color={theme.text.secondary}>{modelHintText}</Text>
          )}
        </Text>
        {/* Directory line */}
        <Text color={theme.text.secondary}>{displayPath}</Text>
      </Box>
    </Box>
  );
};
