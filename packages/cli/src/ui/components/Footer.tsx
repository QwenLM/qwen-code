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
  const { text: statusLineText, padding: statusLinePadding } = useStatusLine();
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

  // Left section shows one item in priority order. When a custom status line
  // is active, only the default "? for shortcuts" hint is suppressed because
  // the status line occupies its own row below.
  const leftContent = uiState.ctrlCPressedOnce ? (
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
  ) : statusLineText ? null : (
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

  // When a custom status line is configured, render it as a dedicated row
  // beneath the standard footer (matching upstream placement).
  return (
    <Box flexDirection="column" width="100%">
      <Box
        justifyContent="space-between"
        width="100%"
        flexDirection="row"
        alignItems="center"
      >
        {/* Left Section */}
        <Box
          marginLeft={2}
          justifyContent="flex-start"
          flexDirection={isNarrow ? 'column' : 'row'}
          alignItems={isNarrow ? 'flex-start' : 'center'}
        >
          {leftContent}
        </Box>

        {/* Right Section */}
        <Box alignItems="center" justifyContent="flex-end" marginRight={2}>
          {rightItems.map(({ key, node }, index) => (
            <Box key={key} alignItems="center">
              {index > 0 && <Text color={theme.text.secondary}> | </Text>}
              {node}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Custom status line row — match footer's horizontal inset */}
      {statusLineText && (
        <Box marginLeft={2} marginRight={2} paddingX={statusLinePadding}>
          <Text dimColor wrap="truncate">
            {statusLineText}
          </Text>
        </Box>
      )}
    </Box>
  );
};
