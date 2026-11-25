/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import type {
  SubagentProgress,
  SubagentActivityItem,
} from '@qwen-code/core';
import {
  CoreToolCallStatus,
  formatMaxTurnsReachedNotice,
  safeJsonToMarkdown,
} from '@qwen-code/core';
import {
  STATUS_INDICATOR_WIDTH,
  ToolInfo,
  ToolStatusPulseFrames,
} from './ToolShared.js';
import { ToolContainer } from './ToolContainer.js';
import { resolveAgentColor, AgentNameBadge } from '../../utils/agentColors.js';
import {
  projectToolCallDisplay,
  type ToolResultDisplaySource,
} from '../../utils/toolDisplayProjection.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';

export interface SubagentProgressDisplayProps {
  progress: SubagentProgress;
  terminalWidth: number;
  historyOverrides?: SubagentActivityItem[];
  renderToolResult?: (tool: IndividualToolCallDisplay) => React.ReactNode;
}

export const SubagentRunningStatusIndicator: React.FC = () => (
  <Text color={theme.text.primary}>
    {FEED_MARKER.subagentRunning}
  </Text>
);

function renderSubagentStateIndicator(state: SubagentProgress['state']) {
  switch (state) {
    case 'completed':
      return (
        <Text color={theme.status.success}>{FEED_MARKER.subagentCompleted}</Text>
      );
    case 'cancelled':
      return (
        <Text color={theme.text.secondary}>{FEED_MARKER.subagentCanceled}</Text>
      );
    case 'error':
      return <Text color={theme.status.error}>{FEED_MARKER.subagentError}</Text>;
    case 'running':
    case undefined:
      return <SubagentRunningStatusIndicator />;
    default:
      return <SubagentRunningStatusIndicator />;
  }
}

export function getSubagentTerminationNotice(
  progress: SubagentProgress,
): string | undefined {
  if (progress.terminateReason !== 'MAX_TURNS') {
    return undefined;
  }
  const maxTurns = progress.terminationDetails?.maxTurns;
  return maxTurns !== undefined
    ? formatMaxTurnsReachedNotice(maxTurns)
    : 'Reached the maximum turn limit. The task may be incomplete.';
}

function getSubagentStateText(progress: SubagentProgress): string {
  if (progress.state === 'cancelled') {
    return 'User cancelled.';
  }

  if (progress.state === 'error') {
    return 'Failed.';
  }

  if (progress.state === 'completed') {
    const terminationNotice = getSubagentTerminationNotice(progress);
    if (terminationNotice) {
      return terminationNotice;
    }
    if (progress.terminateReason && progress.terminateReason !== 'GOAL') {
      return `Finished early (${progress.terminateReason}).`;
    }
    return 'Completed successfully.';
  }

  return 'Running...';
}

function renderActivityStatusIndicator(item: SubagentActivityItem) {
  if (item.type === 'tool_call') {
    switch (item.status) {
      case 'running':
        return (
          <Text color={theme.text.primary}>
            <ToolStatusPulseFrames shouldAnimate />
          </Text>
        );
      case 'completed':
        return (
          <Text color={theme.status.success}>{FEED_MARKER.toolSuccess}</Text>
        );
      case 'cancelled':
        return (
          <Text color={theme.text.secondary} bold>
            {FEED_MARKER.toolCanceled}
          </Text>
        );
      case 'error':
        return (
          <Text color={theme.status.error} bold>
            {FEED_MARKER.toolError}
          </Text>
        );
      default:
        return (
          <Text color={theme.text.secondary}>{FEED_MARKER.toolPending}</Text>
        );
    }
  }

  if (item.type === 'compact') {
    return <Text color={theme.border.default}>{FEED_MARKER.toolResultConnector}</Text>;
  }

  return <Text color={theme.border.default}>{FEED_MARKER.toolResultConnector}</Text>;
}

export const formatToolArgs = (args?: string): string => {
  if (!args) return '';
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== 'object' || parsed === null) {
      return args;
    }

    if (
      'description' in parsed &&
      typeof parsed.description === 'string' &&
      parsed.description
    ) {
      return parsed.description;
    }
    if ('command' in parsed && typeof parsed.command === 'string')
      return parsed.command;
    if ('file_path' in parsed && typeof parsed.file_path === 'string')
      return parsed.file_path;
    if ('dir_path' in parsed && typeof parsed.dir_path === 'string')
      return parsed.dir_path;
    if ('query' in parsed && typeof parsed.query === 'string')
      return parsed.query;
    if ('url' in parsed && typeof parsed.url === 'string') return parsed.url;
    if ('target' in parsed && typeof parsed.target === 'string')
      return parsed.target;

    return args;
  } catch {
    return args;
  }
};

export const SubagentProgressDisplay: React.FC<
  SubagentProgressDisplayProps
> = ({ progress, terminalWidth, historyOverrides, renderToolResult }) => {
  const agentBgColor = resolveAgentColor(progress.color);
  const history = (historyOverrides ?? progress.recentActivity).filter(
    (item) =>
      !(
        progress.state === 'cancelled' &&
        item.type === 'thought' &&
        item.content === 'Request cancelled.'
      ),
  );
  const resultText =
    progress.result !== undefined && progress.state !== 'cancelled'
      ? safeJsonToMarkdown(progress.result)
      : undefined;
  const terminationNotice = getSubagentTerminationNotice(progress);

  return (
    <Box flexDirection="column" paddingY={0}>
      <Box flexDirection="row" marginBottom={history.length > 0 ? 0 : 1}>
        <Box minWidth={STATUS_INDICATOR_WIDTH}>
          {renderSubagentStateIndicator(progress.state)}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <AgentNameBadge name={progress.agentName} bgColor={agentBgColor} />
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.border.default}> · </Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text
            color={
              progress.state === 'error'
                ? theme.status.error
                : theme.text.response
            }
            wrap="truncate"
          >
            {getSubagentStateText(progress)}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginLeft={0} gap={0}>
        {progress.prompt && (
          <Box marginLeft={STATUS_INDICATOR_WIDTH + 1}>
            <Text color={theme.text.secondary} wrap="wrap">
              Prompt: {progress.prompt}
            </Text>
          </Box>
        )}
        {history.map((item: SubagentActivityItem) => {
            if (item.type === 'thought') {
              const isCancellation = item.content === 'Request cancelled.';
              const color = isCancellation
                ? theme.status.warning
                : theme.text.response;

              return (
                <Box key={item.id} flexDirection="row">
                  <Box minWidth={STATUS_INDICATOR_WIDTH}>
                    {renderActivityStatusIndicator(item)}
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={color} italic={!isCancellation}>
                      {item.content}
                    </Text>
                  </Box>
                </Box>
              );
            } else if (item.type === 'compact') {
              return (
                <Box key={item.id} flexDirection="row">
                  <Box minWidth={STATUS_INDICATOR_WIDTH}>
                    {renderActivityStatusIndicator(item)}
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={theme.ui.comment}>
                      {item.content}
                    </Text>
                  </Box>
                </Box>
              );
            } else if (item.type === 'tool_call') {
              const projectedTool = projectActivityToolCall(item);

              if (projectedTool) {
                const showResult =
                  projectedTool.resultDisplay !== undefined &&
                  projectedTool.resultDisplay !== '';

                return (
                  <ToolContainer
                    key={item.id}
                    header={
                      <>
                        <Box minWidth={STATUS_INDICATOR_WIDTH}>
                          {renderActivityStatusIndicator(item)}
                        </Box>
                        <ToolInfo
                          name={projectedTool.name}
                          status={projectedTool.status}
                          description={projectedTool.description}
                          emphasis="medium"
                          progressMessage={projectedTool.progressMessage}
                          originalRequestName={projectedTool.originalRequestName}
                        />
                      </>
                    }
                    terminalWidth={terminalWidth}
                  >
                    {showResult && renderToolResult
                      ? renderToolResult(projectedTool)
                      : null}
                  </ToolContainer>
                );
              }

              const formattedArgs =
                item.description || formatToolArgs(item.args);
              const displayArgs =
                formattedArgs.length > 60
                  ? formattedArgs.slice(0, 60) + '...'
                  : formattedArgs;

              return (
                <Box key={item.id} flexDirection="column">
                  <Box flexDirection="row">
                    <Box minWidth={STATUS_INDICATOR_WIDTH}>
                      {renderActivityStatusIndicator(item)}
                    </Box>
                    <Box flexDirection="row" flexGrow={1} flexWrap="wrap">
                      <Text
                        bold
                        color={theme.text.primary}
                        strikethrough={item.status === 'cancelled'}
                      >
                        {item.displayName || item.content}
                      </Text>
                      {displayArgs && (
                        <Box marginLeft={1}>
                          <Text
                            color={theme.text.response}
                            wrap="truncate"
                            strikethrough={item.status === 'cancelled'}
                          >
                            {displayArgs}
                          </Text>
                        </Box>
                      )}
                    </Box>
                  </Box>
                </Box>
              );
            }
            return null;
          })}
      </Box>

      {resultText !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          {progress.terminateReason && progress.terminateReason !== 'GOAL' && (
            <Box marginBottom={1}>
              <Text color={theme.status.warning} bold>
                {terminationNotice ??
                  `Agent Finished Early (${progress.terminateReason})`}
              </Text>
            </Box>
          )}
          <MarkdownDisplay
            text={resultText}
            isPending={progress.state !== 'completed'}
            terminalWidth={terminalWidth}
          />
        </Box>
      )}
    </Box>
  );
};

function projectActivityToolCall(
  item: SubagentActivityItem,
): IndividualToolCallDisplay | undefined {
  if (item.type !== 'tool_call') {
    return undefined;
  }

  const projected = projectToolCallDisplay({
    toolUse: {
      id: item.id,
      name: item.content,
      input: item.toolInput ?? parseActivityToolInput(item.args),
    },
    toolResult: item.toolResult as ToolResultDisplaySource | undefined,
    runtime: {
      status: mapActivityToolStatus(item.status),
    },
  });

  return {
    ...projected,
    name: item.displayName ?? projected.name,
    description: item.description ?? projected.description,
  };
}

function mapActivityToolStatus(
  status: SubagentActivityItem['status'],
): CoreToolCallStatus {
  switch (status) {
    case 'running':
      return CoreToolCallStatus.Executing;
    case 'completed':
      return CoreToolCallStatus.Success;
    case 'error':
      return CoreToolCallStatus.Error;
    case 'cancelled':
      return CoreToolCallStatus.Cancelled;
    default:
      return CoreToolCallStatus.Scheduled;
  }
}

function parseActivityToolInput(args?: string): Record<string, unknown> {
  if (!args) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
