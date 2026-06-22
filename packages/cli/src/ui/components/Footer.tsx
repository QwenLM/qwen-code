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
import { BackgroundTasksPill } from './background-view/BackgroundTasksPill.js';
import { MCPHealthPill } from './mcp/MCPHealthPill.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

import { MAX_STATUS_LINES, useStatusLine } from '../hooks/useStatusLine.js';
import { useConfigInitMessage } from '../hooks/useConfigInitMessage.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimModeState } from '../contexts/VimModeContext.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { GeminiSpinner } from './GeminiRespondingSpinner.js';
import { GoalPill, useFooterGoalState } from './GoalPill.js';
import { t } from '../../i18n/index.js';

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimModeState();
  const {
    lines: statusLineLines,
    useThemeColors,
    respectUserColors,
    hideContextIndicator,
  } = useStatusLine();
  const configInitMessage = useConfigInitMessage(uiState.isConfigInitialized);

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

  // Hide "? for shortcuts" when a custom status line is active (it already
  // occupies the footer, so the hint is redundant). Matches upstream behavior.
  const suppressHint = statusLineLines.length > 0;

  // MCP init progress lives in this row (not a standalone component above the
  // input) so the live area's height is constant in the default case, avoiding
  // the residual-blank-line artifact left behind when a separate block unmounts.
  // When a custom status line is active, the row shrinks by 1 on transition to
  // ready — a one-time, small regression preferred over hiding init progress.
  //
  // `configInitMessage` is placed ahead of `showAutoAcceptIndicator` so users
  // launched with YOLO / auto-accept-edits still see the ~1s startup progress;
  // the approval-mode indicator takes over as soon as init finishes.
  const leftBottomContent = uiState.ctrlCPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+C again to exit.')}</Text>
  ) : uiState.ctrlDPressedOnce ? (
    <Text color={theme.status.warning}>{t('Press Ctrl+D again to exit.')}</Text>
  ) : uiState.showEscapePrompt ? (
    <Text color={theme.text.secondary}>{t('Press Esc again to clear.')}</Text>
  ) : uiState.rewindEscPending ? (
    <Text color={theme.text.secondary}>
      {t('Press Esc again to rewind conversation.')}
    </Text>
  ) : vimEnabled && vimMode === 'INSERT' ? (
    <Text color={theme.text.secondary}>-- INSERT --</Text>
  ) : vimEnabled && vimMode === 'NORMAL' ? (
    <Text color={theme.text.secondary}>-- NORMAL --</Text>
  ) : uiState.shellModeActive ? (
    <ShellModeIndicator />
  ) : configInitMessage ? (
    <Text color={theme.text.secondary}>
      <GeminiSpinner /> {configInitMessage}
    </Text>
  ) : showAutoAcceptIndicator !== undefined &&
    showAutoAcceptIndicator !== ApprovalMode.DEFAULT ? (
    <AutoAcceptIndicator approvalMode={showAutoAcceptIndicator} />
  ) : suppressHint ? null : (
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
  // Dream tasks now surface via the BackgroundTasksPill (e.g. "1 dream")
  // alongside the other background-task kinds. The previous `✦ dreaming`
  // right-column indicator was removed to avoid two simultaneous signals
  // for the same underlying state.
  if (promptTokenCount > 0 && contextWindowSize && !hideContextIndicator) {
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
  // Goal pill: only present in `rightItems` when a goal is active so the
  // divider chain stays tight; the pill itself does the live elapsed-time
  // refresh internally.
  const goalActive = useFooterGoalState() !== undefined;
  if (goalActive) {
    rightItems.push({ key: 'goal', node: <GoalPill /> });
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
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={isNarrow ? 0 : 1}
        minWidth={0}
      >
        {statusLineLines.length > 0 &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Box
              flexDirection="column"
              maxHeight={MAX_STATUS_LINES}
              overflow="hidden"
              width="100%"
            >
              <Text
                color={
                  respectUserColors
                    ? undefined
                    : useThemeColors
                      ? theme.text.accent
                      : undefined
                }
                dimColor={respectUserColors ? false : !useThemeColors}
                wrap="wrap"
              >
                {statusLineLines.join('\n')}
              </Text>
            </Box>
          )}
        {/* Built-in worktree indicator. Shown by default whenever a
            worktree is active so the user always has a UI affordance,
            even when a custom statusline is configured — their script
            may not render `payload.worktree` (written before Phase C,
            ignored by choice, or only rendering some fields), and
            silently hiding the indicator could let the user operate
            in the wrong cwd. Users who want the suppression behaviour
            (e.g. their statusline already renders worktree) can opt
            in via the `ui.hideBuiltinWorktreeIndicator` setting.
            Hidden during ctrl-quit warnings so they take precedence.
            (PR #4174 review #3256241831.) */}
        {uiState.activeWorktree &&
          !settings.merged.ui?.hideBuiltinWorktreeIndicator &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Text dimColor wrap="truncate">
              {`⎇ ${uiState.activeWorktree.branch} (${uiState.activeWorktree.slug})`}
            </Text>
          )}
        {/* P7-trigger: the current turn was steered toward the Workflow tool
            by the `workflow` keyword. Hidden during ctrl-quit warnings so they
            take precedence (matches the worktree indicator above). */}
        {uiState.workflowKeywordActive &&
          !uiState.ctrlCPressedOnce &&
          !uiState.ctrlDPressedOnce && (
            <Text color={theme.text.accent} wrap="truncate">
              {`⚙ ${t('workflow active')}`}
            </Text>
          )}
        <Box flexDirection="row" flexShrink={1}>
          <Text wrap="truncate">{leftBottomContent}</Text>
          <BackgroundTasksPill />
          <MCPHealthPill />
        </Box>
      </Box>

      {/* Right Section — never compressed, aligns to top so multi-line
          status lines on the left don't push the indicators to the center. */}
      <Box flexShrink={0} gap={1} alignItems="flex-start">
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
