/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ToolCallStatus, mapCoreStatusToDisplayStatus } from '../../types.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { theme } from '../../semantic-colors.js';
import type { CoreToolCallStatus } from '@qwen-code/core';
import { SHELL_TOOL_NAME, POWERSHELL_TOOL_NAME } from '@qwen-code/core';
import { isCompletedAskUserTool } from '../../utils/toolConfirmationUtils.js';
import { INDENT } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { debugState } from '../../debug.js';
import { useTerminalViewport } from '../../../ink/hooks/use-terminal-viewport.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';

export const STATUS_INDICATOR_WIDTH = INDENT.STATUS_INDICATOR_WIDTH;
const TOOL_STATUS_PULSE_INTERVAL_MS = 1200;
const ALWAYS_VISIBLE = () => true;

/**
 * Returns true if the tool name corresponds to a shell tool.
 */
export function isShellTool(name: string): boolean {
  return (
    name === SHELL_COMMAND_NAME ||
    name === SHELL_NAME ||
    name === SHELL_TOOL_NAME ||
    name === POWERSHELL_TOOL_NAME
  );
}

export type TextEmphasis = 'high' | 'medium' | 'low';

type ToolStatusIndicatorProps = {
  status: CoreToolCallStatus;
  isFocused?: boolean;
};

export const ToolStatusPulseFrames: React.FC<{
  shouldAnimate: boolean;
  isVisible?: () => boolean;
}> = ({ shouldAnimate, isVisible = ALWAYS_VISIBLE }) => {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (!shouldAnimate) {
      return undefined;
    }

    debugState.debugNumAnimatedComponents++;
    const interval = setInterval(() => {
      if (!isVisible()) {
        return;
      }
      setFrame((prev) => (prev + 1) % FEED_MARKER.toolExecutingFrames.length);
    }, TOOL_STATUS_PULSE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      debugState.debugNumAnimatedComponents--;
    };
  }, [isVisible, shouldAnimate]);

  if (!shouldAnimate) {
    return <>{FEED_MARKER.toolSuccess}</>;
  }

  return <>{FEED_MARKER.toolExecutingFrames[frame]}</>;
};

export const ToolStatusPulse: React.FC<{
  isVisible?: () => boolean;
}> = ({ isVisible }) => {
  const settings = useSettings();
  return (
    <ToolStatusPulseFrames
      shouldAnimate={settings.merged.ui?.showSpinner !== false}
      isVisible={isVisible}
    />
  );
};

export const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status: coreStatus,
  isFocused,
}) => {
  const [viewportRef, , readVisibility] = useTerminalViewport();
  const bypassVisibility = useAlternateBuffer();
  const isVisible = React.useCallback(
    () => bypassVisibility || readVisibility(),
    [bypassVisibility, readVisibility],
  );
  const status = mapCoreStatusToDisplayStatus(coreStatus);
  const executingColor = theme.text.primary;
  const confirmingColor = isFocused ? theme.ui.focus : theme.status.warning;

  return (
    <Box ref={viewportRef} minWidth={STATUS_INDICATOR_WIDTH}>
      {status === ToolCallStatus.Pending && (
        <Text color={theme.text.secondary}>{FEED_MARKER.toolPending}</Text>
      )}
      {status === ToolCallStatus.Executing && (
        <Text color={executingColor} aria-label={'Executing:'}>
          <ToolStatusPulse isVisible={isVisible} />
        </Text>
      )}
      {status === ToolCallStatus.Success && (
        <Text color={theme.status.success} aria-label={'Success:'}>
          {FEED_MARKER.toolSuccess}
        </Text>
      )}
      {status === ToolCallStatus.Confirming && (
        <Text color={confirmingColor} aria-label={'Confirming:'}>
          {FEED_MARKER.toolConfirming}
        </Text>
      )}
      {status === ToolCallStatus.Canceled && (
        <Text color={theme.text.secondary} aria-label={'Canceled:'} bold>
          {FEED_MARKER.toolCanceled}
        </Text>
      )}
      {status === ToolCallStatus.Error && (
        <Text color={theme.status.error} aria-label={'Error:'} bold>
          {FEED_MARKER.toolError}
        </Text>
      )}
    </Box>
  );
};

type ToolInfoProps = {
  name: string;
  description: string;
  status: CoreToolCallStatus;
  emphasis: TextEmphasis;
  progressMessage?: string;
  originalRequestName?: string;
};

export const ToolInfo: React.FC<ToolInfoProps> = ({
  name,
  description,
  status: coreStatus,
  emphasis,
  progressMessage: _progressMessage,
  originalRequestName,
}) => {
  const status = mapCoreStatusToDisplayStatus(coreStatus);
  const nameColor = React.useMemo<string>(() => {
    switch (emphasis) {
      case 'high':
        return theme.text.primary;
      case 'medium':
        return theme.text.primary;
      case 'low':
        return theme.text.secondary;
      default: {
        const exhaustiveCheck: never = emphasis;
        return exhaustiveCheck;
      }
    }
  }, [emphasis]);

  // Hide description for completed Ask User tools (the result display speaks for itself)
  const isCompletedAskUser = isCompletedAskUserTool(name, status);

  return (
    <Box overflow="hidden" height={1} flexGrow={1} flexShrink={1}>
      <Text strikethrough={status === ToolCallStatus.Canceled} wrap="truncate">
        <Text color={nameColor} bold>
          {name}
        </Text>
        {originalRequestName && originalRequestName !== name && (
          <Text color={theme.ui.comment} italic>
            {' '}
            (redirection from {originalRequestName})
          </Text>
        )}
        {!isCompletedAskUser && (
          <>
            {' '}
            <Text color={theme.text.response}>{description}</Text>
          </>
        )}
      </Text>
    </Box>
  );
};

export interface McpProgressIndicatorProps {
  progress: number;
  total?: number;
  message?: string;
  barWidth: number;
}

export const McpProgressIndicator: React.FC<McpProgressIndicatorProps> = ({
  progress,
  total,
  message,
  barWidth,
}) => {
  const percentage =
    total && total > 0
      ? Math.min(100, Math.round((progress / total) * 100))
      : null;

  let rawFilled: number;
  if (total && total > 0) {
    rawFilled = Math.round((progress / total) * barWidth);
  } else {
    rawFilled = Math.floor(progress) % (barWidth + 1);
  }

  const filled = Math.max(
    0,
    Math.min(Number.isFinite(rawFilled) ? rawFilled : 0, barWidth),
  );
  const empty = Math.max(0, barWidth - filled);
  const progressBar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.accent}>
          {progressBar} {percentage !== null ? `${percentage}%` : `${progress}`}
        </Text>
      </Box>
      {message && (
        <Text color={theme.text.response} wrap="truncate">
          {message}
        </Text>
      )}
    </Box>
  );
};

export const TrailingIndicator: React.FC = () => (
  <Text color={theme.text.primary} wrap="truncate">
    {' '}
    ←
  </Text>
);
