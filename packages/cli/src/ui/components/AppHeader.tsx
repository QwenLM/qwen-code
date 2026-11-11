/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useTips } from '../hooks/useTips.js';
import { theme } from '../semantic-colors.js';
import { runLogger, DEFAULT_CONTEXT_FILENAME } from '@qwen-code/core';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { useI18nService } from '../i18n/index.js';
import { type CliWelcomeHeaderProps } from './WelcomeHeaderProps.js';

import { QwenCodeWelcomeHeader } from './QwenCodeWelcomeHeader.js';
import { DefaultWelcomeHeader } from './DefaultWelcomeHeader.js';
import { useCliApplication } from '../contexts/CliApplicationContext.js';
import { CLI_DISPLAY_NAME } from '../../brand.js';

interface AppHeaderProps {
  version: string;
  showDetails?: boolean;
}

/**
 * Keep a decorative header failure from terminating the session.
 */
class WelcomeHeaderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  override state = { failed: false };

  override componentDidCatch(error: Error) {
    runLogger.error(
      '[welcome-header] welcome header failed to render; using the default header',
      error,
    );
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const AppHeader = ({
  version,
  showDetails: _showDetails = true,
}: AppHeaderProps) => {
  const i18n = useI18nService();
  const settings = useSettings();
  const config = useConfig();
  const { terminalWidth } = useUIState();
  const { showTips, markShown: markTipsShown } = useTips();
  const application = useCliApplication();

  const screenReader = config.getScreenReader();
  const showHeader = !(settings.merged.ui.hideBanner || screenReader);
  const tipsEnabled =
    !(settings.merged.ui.hideTips || screenReader) && showTips;

  const headerProps: CliWelcomeHeaderProps = {
    cliDisplayName: application?.getCliDisplayName() ?? CLI_DISPLAY_NAME,
    terminalWidth,
    version,
    versionLabel: `v${version}`,
    // Tips are fixed-length by design: the header's geometry must not change
    // after its first paint, so this list may not depend on anything that
    // resolves asynchronously (e.g. the memory file count).
    tips: tipsEnabled
      ? {
          title: i18n.get('home.tips.title'),
          lines: [
            i18n.get('home.tips.context', {
              filename: DEFAULT_CONTEXT_FILENAME,
            }),
            i18n.get('home.tips.help'),
            i18n.get('home.tips.tasks'),
            i18n.get('home.tips.specific'),
          ],
          markShown: markTipsShown,
        }
      : undefined,
  };
  const sessionAgent = config.getSessionAgent();

  return (
    <OffscreenFreeze layoutKey={terminalWidth}>
      <Box flexDirection="column">
        {showHeader && (
          <WelcomeHeaderBoundary
            fallback={<DefaultWelcomeHeader {...headerProps} />}
          >
            <QwenCodeWelcomeHeader {...headerProps} />
          </WelcomeHeaderBoundary>
        )}
        {showHeader && sessionAgent && (
          <Box
            overflow="hidden"
            flexWrap="nowrap"
            paddingLeft={1}
            marginBottom={1}
          >
            <Text color={theme.text.accent}>@{sessionAgent}</Text>
          </Box>
        )}
      </Box>
    </OffscreenFreeze>
  );
};
