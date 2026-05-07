/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box } from 'ink';
import { AuthType, isCodingPlanConfig } from '@qwen-code/qwen-code-core';
import { Header, AuthDisplayType } from './Header.js';
import { Tips } from './Tips.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { resolveCustomBanner } from '../utils/customBanner.js';

interface AppHeaderProps {
  version: string;
}

/**
 * Determine the auth display type based on auth type and configuration.
 */
function getAuthDisplayType(
  authType?: AuthType,
  baseUrl?: string,
  apiKeyEnvKey?: string,
): AuthDisplayType {
  if (!authType) {
    return AuthDisplayType.UNKNOWN;
  }

  // Check if it's a Coding Plan config
  if (isCodingPlanConfig(baseUrl, apiKeyEnvKey)) {
    return AuthDisplayType.CODING_PLAN;
  }

  switch (authType) {
    case AuthType.QWEN_OAUTH:
      return AuthDisplayType.QWEN_OAUTH;
    default:
      return AuthDisplayType.API_KEY;
  }
}

export const AppHeader = ({ version }: AppHeaderProps) => {
  const settings = useSettings();
  const config = useConfig();
  const uiState = useUIState();

  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  const model = uiState.currentModel;
  const targetDir = config.getTargetDir();
  const showBanner =
    !config.getScreenReader() && !settings.merged.ui?.hideBanner;
  const showTips = !(settings.merged.ui?.hideTips || config.getScreenReader());

  const authDisplayType = getAuthDisplayType(
    authType,
    contentGeneratorConfig?.baseUrl,
    contentGeneratorConfig?.apiKeyEnvKey,
  );

  // Resolve once per (settings identity) — file reads and sanitization are
  // not free, and the merged settings reference is stable across renders
  // until a settings hot-reload swaps it.
  const resolvedBanner = useMemo(
    () => (showBanner ? resolveCustomBanner(settings) : undefined),
    [showBanner, settings],
  );

  return (
    <Box flexDirection="column">
      {showBanner && (
        <Header
          version={version}
          authDisplayType={authDisplayType}
          model={model}
          workingDirectory={targetDir}
          customAsciiArt={resolvedBanner?.asciiArt}
          customBannerTitle={resolvedBanner?.title}
          customBannerSubtitle={resolvedBanner?.subtitle}
        />
      )}
      {showTips && <Tips />}
    </Box>
  );
};
