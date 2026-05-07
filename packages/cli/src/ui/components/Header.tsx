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
import { getRenderableGradientColors } from '../utils/gradientUtils.js';
import { pickAsciiArtTier } from '../utils/customBanner.js';

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
  /**
   * Width-aware override for the logo column. Each tier is a sanitized
   * ASCII string; the renderer picks `large` when it fits, then `small`,
   * then falls through to the default Qwen logo. Either tier may be
   * omitted: a missing tier simply skips that step.
   */
  customAsciiArt?: { small?: string; large?: string };
  /**
   * Sanitized replacement for the bold ">_ Qwen Code" title in the info
   * panel. The version suffix is always appended. When undefined or empty
   * the default title is used; the leading `>_` glyph is part of the
   * default brand and is dropped when a custom title is set.
   */
  customBannerTitle?: string;
  /**
   * Sanitized subtitle string rendered between the title and the
   * auth/model line. When undefined the existing blank spacer row is
   * preserved so unset users see the same layout as before.
   */
  customBannerSubtitle?: string;
  version: string;
  authDisplayType?: AuthDisplayType;
  model: string;
  workingDirectory: string;
}

export const Header: React.FC<HeaderProps> = ({
  customAsciiArt,
  customBannerTitle,
  customBannerSubtitle,
  version,
  authDisplayType,
  model,
  workingDirectory,
}) => {
  const { columns: terminalWidth } = useTerminalSize();

  const formattedAuthType = authDisplayType ?? AuthDisplayType.UNKNOWN;

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

  // Two distinct fallback paths:
  //   - User supplied a custom tier and at least one tier fits → render that.
  //   - User supplied custom art but neither tier fits → hide the logo column.
  //     Falling back to the bundled QWEN logo here would silently undo a
  //     white-label deployment on narrow terminals.
  //   - User supplied no custom art → fall through to `shortAsciiLogo` and let
  //     the existing width gate decide whether to show or hide it.
  const hasCustomArt = Boolean(customAsciiArt?.small || customAsciiArt?.large);
  const customTier = pickAsciiArtTier(
    customAsciiArt?.small,
    customAsciiArt?.large,
    availableTerminalWidth,
    logoGap,
    minInfoPanelWidth,
    getAsciiArtWidth,
  );
  const displayLogo = customTier ?? (hasCustomArt ? '' : shortAsciiLogo);
  const logoWidth = getAsciiArtWidth(displayLogo);

  // Check if we have enough space for logo + gap + minimum info panel.
  // When `displayLogo` is empty (custom art too wide for both tiers) showLogo
  // will be false, hiding the column entirely.
  const showLogo =
    displayLogo !== '' &&
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
  const authModelText = `${formattedAuthType} | ${model}`;
  const modelHintText = ' (/model to change)';
  const showModelHint =
    infoPanelContentWidth > 0 &&
    getCachedStringWidth(authModelText + modelHintText) <=
      infoPanelContentWidth;

  // Now shorten the path to fit the available space
  const tildeifiedPath = tildeifyPath(workingDirectory);
  const shortenedPath = shortenPath(tildeifiedPath, Math.max(3, maxPathLength));
  const displayPath =
    maxPathLength <= 0
      ? ''
      : shortenedPath.length > maxPathLength
        ? shortenedPath.slice(0, maxPathLength)
        : shortenedPath;

  const gradientColors = getRenderableGradientColors(theme.ui.gradient, [
    theme.text.secondary,
    theme.text.link,
    theme.text.accent,
  ]);

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
            {gradientColors ? (
              <Gradient colors={gradientColors}>
                <Text>{displayLogo}</Text>
              </Gradient>
            ) : (
              <Text>{displayLogo}</Text>
            )}
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
        {/* Title line: customBannerTitle (already sanitized) or the default
            ">_ Qwen Code" brand. Version suffix is always appended. */}
        <Text>
          <Text bold color={theme.text.accent}>
            {customBannerTitle ? customBannerTitle : '>_ Qwen Code'}
          </Text>
          <Text color={theme.text.secondary}> (v{version})</Text>
        </Text>
        {/* Subtitle (when set) replaces the blank spacer row. We always
            emit a row here so the auth/model line stays at the same
            vertical position regardless of whether the subtitle is set. */}
        {customBannerSubtitle ? (
          <Text color={theme.text.secondary}>{customBannerSubtitle}</Text>
        ) : (
          <Text> </Text>
        )}
        {/* Auth and Model line */}
        <Text>
          <Text color={theme.text.secondary}>{authModelText}</Text>
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
