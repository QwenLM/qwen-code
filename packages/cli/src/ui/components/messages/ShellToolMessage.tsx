/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { ToolStatusIndicator } from './ToolShared.js';
import type { ToolMessageProps } from './ToolMessage.js';
import {
  SHELL_COMPACT_FOLD_THRESHOLD_COMPLETED,
  SHELL_COMPACT_MAX_LINES_COMPLETED,
  SHELL_COMPACT_MAX_LINES_EXECUTING,
} from '../../constants.js';
import { useFoldState } from '../../contexts/FoldStateContext.js';
import {
  type Config,
  CoreToolCallStatus,
  SHELL_PROGRESS_THRESHOLD_MS,
} from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';
import { ToolContainer } from './ToolContainer.js';
import { FoldLevel, INDENT } from '../../constants/messageLayout.js';
import { formatBytes, formatDuration } from '../../utils/formatters.js';
import { useShellElapsedTime } from '../../hooks/useShellElapsedTime.js';
import { wrapAnsi } from '../../../ink/wrapAnsi.js';

const DESCRIPTION_MAX_LINES = 2;
const DESCRIPTION_MAX_CHARS = 160;

const backgroundKey = formatCommand(Command.TOGGLE_BACKGROUND_SHELL);
const expandKey = formatCommand(Command.SHOW_MORE_LINES);

/** Truncate text by line count and character length, appending '…' if truncated. */
function truncateHeaderText(text: string): string {
  const lines = text.split('\n');
  const needsLineTruncation = lines.length > DESCRIPTION_MAX_LINES;
  const needsCharTruncation = text.length > DESCRIPTION_MAX_CHARS;
  if (!needsLineTruncation && !needsCharTruncation) {
    return text;
  }
  let truncated = needsLineTruncation
    ? lines.slice(0, DESCRIPTION_MAX_LINES).join('\n')
    : text;
  if (truncated.length > DESCRIPTION_MAX_CHARS) {
    truncated = truncated.slice(0, DESCRIPTION_MAX_CHARS);
  }
  return truncated.trim() + '…';
}

function getResultColor(status: CoreToolCallStatus): string {
  if (status === CoreToolCallStatus.Success) return theme.status.success;
  if (status === CoreToolCallStatus.Error) return theme.status.error;
  return theme.text.secondary;
}

/** True when the tool is still in-flight or awaiting user action. */
function isActiveStatus(status: CoreToolCallStatus): boolean {
  return (
    status === CoreToolCallStatus.Executing ||
    status === CoreToolCallStatus.Validating ||
    status === CoreToolCallStatus.AwaitingApproval ||
    status === CoreToolCallStatus.Scheduled
  );
}

export interface ShellToolMessageProps extends ToolMessageProps {
  config?: Config;
  isExpandable?: boolean;
}

interface ShellExecutionStatusProps {
  elapsedSeconds: number;
  showDetails: boolean;
  shellProgress: ShellToolMessageProps['shellProgress'];
  showBackgroundHint: boolean;
  hasOutput: boolean;
  hiddenLineCount: number;
  showOutputBytes?: boolean;
}

export const ShellExecutionStatus: React.FC<ShellExecutionStatusProps> = ({
  elapsedSeconds,
  showDetails,
  shellProgress,
  showBackgroundHint,
  hasOutput,
  hiddenLineCount,
  showOutputBytes = true,
}) => {
  const showOutputMetadata = showDetails && hasOutput;
  const elapsedLabel =
    elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : formatDuration(elapsedSeconds * 1000);
  const lineSummary = shellProgress?.totalLines
    ? `~${shellProgress.totalLines} lines`
    : !shellProgress && hiddenLineCount > 0
      ? `+${hiddenLineCount} lines`
      : null;
  const metadata = [
    lineSummary,
    `(${elapsedLabel})`,
    showOutputBytes && shellProgress && shellProgress.totalBytes > 0
      ? formatBytes(shellProgress.totalBytes)
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <>
      <Box>
        <Text color={theme.text.secondary}>
          {showOutputMetadata
            ? metadata.join(' ')
            : `Running…${showDetails ? ` (${elapsedLabel})` : ''}`}
        </Text>
      </Box>
      {showBackgroundHint && (
        <Box>
          <Text color={theme.text.secondary}>
            ({backgroundKey} to run in background)
          </Text>
        </Box>
      )}
    </>
  );
};

export const ShellToolMessage: React.FC<ShellToolMessageProps> = ({
  name,
  description,
  displayTitle,
  resultDisplay,
  status,
  availableTerminalHeight,
  terminalWidth,
  executionId,
  config: _config,
  isExpandable = true,
  isClientInitiated,
  originalRequestName,
  shellProgress,
  startedAt,
}) => {
  const { globalFoldLevel } = useFoldState();
  const isExpanded = globalFoldLevel === FoldLevel.FullyExpanded;

  const headerText = displayTitle ?? description ?? '';
  const displayDesc = isExpanded
    ? headerText
    : truncateHeaderText(headerText);

  const resultColor = getResultColor(status);
  const isExecuting = status === CoreToolCallStatus.Executing;
  const { elapsedMs, elapsedSeconds } = useShellElapsedTime(
    startedAt,
    isExecuting,
  );
  const showRunningDetails =
    isExecuting && elapsedMs >= SHELL_PROGRESS_THRESHOLD_MS;

  const outputInfo = React.useMemo(() => {
    if (!resultDisplay || isExpanded) {
      return { lines: null, hidden: 0 };
    }

    if (typeof resultDisplay === 'string') {
      const contentWidth = Math.max(1, terminalWidth - INDENT.TOOL_PAYLOAD);
      const allLines = wrapAnsi(resultDisplay, contentWidth, {
        hard: true,
        wordWrap: false,
        trim: false,
      }).split('\n');
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      if (!isExecuting) {
        // Keep a four-line completed result intact. Longer results use the
        // three-line preview, with the final result as the source of truth for
        // the hidden count rather than potentially stale live progress.
        const shouldCollapse =
          allLines.length > SHELL_COMPACT_FOLD_THRESHOLD_COMPLETED;
        return {
          lines: shouldCollapse
            ? allLines.slice(0, SHELL_COMPACT_MAX_LINES_COMPLETED)
            : allLines,
          hidden: shouldCollapse
            ? allLines.length - SHELL_COMPACT_MAX_LINES_COMPLETED
            : 0,
        };
      }

      // A running result only contains a bounded tail window, so progress is
      // the authoritative source for the total line count in this state.
      const effectiveTotal = Math.max(
        allLines.length,
        shellProgress?.totalLines ?? 0,
      );
      return {
        lines: allLines.slice(-SHELL_COMPACT_MAX_LINES_EXECUTING),
        hidden: Math.max(
          0,
          effectiveTotal - SHELL_COMPACT_MAX_LINES_EXECUTING,
        ),
      };
    }

    return { lines: null, hidden: 0 };
  }, [
    resultDisplay,
    isExpanded,
    shellProgress,
    isExecuting,
    terminalWidth,
  ]);

  const hasCompactOutput =
    outputInfo.lines !== null && outputInfo.lines.length > 0;
  // Exclude empty string — that case is handled by the no-output indicator
  const useToolResultFallback =
    !isExpanded &&
    resultDisplay != null &&
    resultDisplay !== '' &&
    outputInfo.lines === null;

  const hasNoOutput = resultDisplay == null || resultDisplay === '';
  const inFlight = isActiveStatus(status);
  const canBackground = isExecuting && executionId != null;
  const showBackgroundHint =
    canBackground && showRunningDetails && !isExpanded;
  const showRunningOnly = isExecuting && !showRunningDetails;
  const hasVisibleOutput =
    (isExpanded && !hasNoOutput) ||
    (!isExpanded &&
      !showRunningOnly &&
      (hasCompactOutput || useToolResultFallback));
  const hasContent =
    isExecuting ||
    (!isExpanded && hasCompactOutput) ||
    useToolResultFallback ||
    (isExpanded && !hasNoOutput) ||
    (hasNoOutput && !inFlight);

  const headerRow = (
    <Box flexDirection="row">
      <ToolStatusIndicator status={status} isFocused={false} />
      <Text wrap="wrap">
        <Text color={theme.text.primary} bold>
          {name}
        </Text>
        {displayDesc ? (
          <Text color={theme.text.response}>({displayDesc})</Text>
        ) : null}
        {originalRequestName && originalRequestName !== name ? (
          <Text color={theme.ui.comment} italic>
            {' '}
            from {originalRequestName}
          </Text>
        ) : null}
      </Text>
    </Box>
  );

  const content = (
    <>
      {/* ── Compact output (default view) ── */}
      {!isExpanded && hasCompactOutput && !showRunningOnly && (
        <Box flexDirection="column">
          {outputInfo.lines.map((line: string, i: number) => (
            <Box key={i} overflow="hidden" height={1}>
              <Text wrap="truncate" color={theme.text.secondary}>
                {line}
              </Text>
            </Box>
          ))}
          {outputInfo.hidden > 0 && !isExecuting && (
            <Box>
              <Text color={theme.text.secondary}>
                &hellip; +{outputInfo.hidden} lines
                {isExpandable ? ` (${expandKey} to expand)` : ''}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* ── Compact fallback for structured results ── */}
      {useToolResultFallback && !showRunningOnly && (
        <ToolResultDisplay
          resultDisplay={resultDisplay}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          renderOutputAsMarkdown={true}
          hasFocus={false}
          maxLines={SHELL_COMPACT_MAX_LINES_COMPLETED}
        />
      )}

      {/* ── Expanded output (ctrl+o) ── */}
      {isExpanded && !hasNoOutput && (
        <>
          <ToolResultDisplay
            resultDisplay={resultDisplay}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
            renderOutputAsMarkdown={true}
            hasFocus={false}
          />
        </>
      )}

      {isExecuting && (
        <ShellExecutionStatus
          elapsedSeconds={elapsedSeconds}
          showDetails={showRunningDetails}
          shellProgress={shellProgress}
          showBackgroundHint={showBackgroundHint}
          hasOutput={hasVisibleOutput}
          hiddenLineCount={isExpanded ? 0 : outputInfo.hidden}
          showOutputBytes={!isClientInitiated}
        />
      )}

      {/* ── No output indicator (both views) ── */}
      {hasNoOutput && !inFlight && (
        <Text color={resultColor}>(no output)</Text>
      )}
    </>
  );

  return (
    <ToolContainer header={headerRow} terminalWidth={terminalWidth}>
      {hasContent ? content : null}
    </ToolContainer>
  );
};
