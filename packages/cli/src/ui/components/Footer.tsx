/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { AutoAcceptIndicator } from './AutoAcceptIndicator.js';
import { ShellModeIndicator } from './ShellModeIndicator.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

import { useStatusLine } from '../hooks/useStatusLine.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { useVerboseMode } from '../contexts/VerboseModeContext.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const { vimEnabled, vimMode } = useVimMode();
  const { text: statusLineText } = useStatusLine();
  const { verboseMode } = useVerboseMode();

  const { promptTokenCount, showAutoAcceptIndicator } = {
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    showAutoAcceptIndicator: uiState.showAutoAcceptIndicator,
  };

  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);

  // Determine sandbox info from environment
  const sandboxEnv = process.env['SANDBOX'];
  const sandboxInfo = sandboxEnv
    ? sandboxEnv === 'sandbox-exec'
      ? 'seatbelt'
      : sandboxEnv.startsWith('qwen-code')
        ? 'docker'
        : sandboxEnv
    : null;

  // Check if debug mode is enabled
  const debugMode = config.getDebugMode();

  const contextWindowSize =
    config.getContentGeneratorConfig()?.contextWindowSize;

  // Left bottom row: high-priority messages > approval mode > hint.
  // Matches upstream layout where status line and hints coexist vertically.
  const leftBottomContent = uiState.ctrlCPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+C again to exit.')}</Text>
  ) : uiState.ctrlDPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+D again to exit.')}</Text>
  ) : uiState.showEscapePrompt ? (
    <Text color={theme.text.secondary}>{t('Press Esc again to clear.')}</Text>
  ) : vimEnabled && vimMode === 'INSERT' ? (
    <Text color={theme.text.secondary}>-- INSERT --</Text>
  ) : uiState.shellModeActive ? (
    <ShellModeIndicator />
  ) : showAutoAcceptIndicator !== undefined &&
    showAutoAcceptIndicator !== ApprovalMode.DEFAULT ? (
    <AutoAcceptIndicator approvalMode={showAutoAcceptIndicator} />
  ) : (
    <Text color={theme.text.secondary}>{t('? for shortcuts')}</Text>
  );

  const rightItems: Array<{ key: string; node: React.ReactNode }> = [];
  if (sandboxInfo) {
    rightItems.push({
      key: 'sandbox',
      node: <Text color={theme.status.success}>🔒 {sandboxInfo}</Text>,
    });
  }
  if (debugMode) {
    rightItems.push({
      key: 'debug',
      node: <Text color={theme.status.warning}>Debug Mode</Text>,
    });
  }
  if (promptTokenCount > 0 && contextWindowSize) {
    rightItems.push({
      key: 'context',
      node: (
        <Text color={theme.text.accent}>
          <ContextUsageDisplay
            promptTokenCount={promptTokenCount}
            terminalWidth={terminalWidth}
            contextWindowSize={contextWindowSize}
          />
        </Text>
      ),
    });
  }
  if (verboseMode) {
    rightItems.push({
      key: 'verbose',
      node: <Text color={theme.text.accent}>{t('verbose')}</Text>,
    });
  }

  // Layout matches upstream: left column has status line (top) + hints/mode
  // (bottom), right section has indicators. Status line and hints coexist.
  return (
    <Box
      flexDirection={isNarrow ? 'column' : 'row'}
      justifyContent={isNarrow ? 'flex-start' : 'space-between'}
      width="100%"
      paddingX={2}
      gap={isNarrow ? 0 : 1}
    >
      {/* Left column — status line on top, hints/mode on bottom */}
      <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
        {statusLineText && (
          <Text dimColor wrap="truncate">
            {statusLineText}
          </Text>
        )}
        <Text wrap="truncate">{leftBottomContent}</Text>
      </Box>

      {/* Right Section — never compressed */}
      <Box flexShrink={0} gap={1}>
        {rightItems.map(({ key, node }, index) => (
          <Box key={key} alignItems="center">
            {index > 0 && <Text color={theme.text.secondary}> | </Text>}
            {node}
          </Box>
        ))}
      </Box>
    </Box>
  );
};
