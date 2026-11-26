/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import {
  CoreToolCallStatus,
  formatMaxTurnsReachedSummary,
  isSubagentProgress,
  checkExhaustive,
  type SubagentActivityItem,
  type TaskStatus,
  isAgentTask,
} from '@qwen-code/core';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';
import {
  SubagentProgressDisplay,
  SubagentRunningStatusIndicator,
  formatToolArgs,
  getSubagentTerminationNotice,
} from './SubagentProgressDisplay.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { useOverflowActions } from '../../contexts/OverflowContext.js';
import { resolveAgentColor, AgentNameBadge } from '../../utils/agentColors.js';
import { getBorderStyle } from '../../utils/borderStyles.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { INDENT } from '../../constants/messageLayout.js';
import {
  isAgentBackgroundLaunchDisplay,
  isAgentTeammateSpawnDisplay,
} from '../../utils/agentToolResultDisplay.js';
import { useTaskRegistry } from '../../contexts/TaskRegistryContext.js';
import { useTaskRegistryVersion } from '../../hooks/useTaskRegistryState.js';
import {
  useAgentTranscript,
  type AgentTranscriptSource,
} from '../../hooks/useAgentTranscript.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { projectSubagentRecentActivity } from '../../../utils/subagentTraceProjection.js';

export interface SubagentGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  terminalWidth: number;
  borderColor?: string;
  borderDimColor?: boolean;
  isFirst?: boolean;
  isExpandable?: boolean;
}

export function getTeammateLaunchIdentity(
  resultDisplay: IndividualToolCallDisplay['resultDisplay'],
  fallbackName: string,
): { name: string; textColor?: string } | undefined {
  if (!isAgentTeammateSpawnDisplay(resultDisplay)) return undefined;
  return {
    name: `@${resultDisplay.name || fallbackName || 'agent'}`,
    textColor: resolveAgentColor(resultDisplay.color),
  };
}

const EXPAND_HINT_KEY = formatCommand(Command.SHOW_MORE_LINES);
const USER_CANCELLED_DISPLAY = 'User cancelled.';

interface TranscriptLoadBatch {
  viewers: Set<symbol>;
  active: Set<symbol>;
  generation: number;
  initialHydrationComplete: boolean;
}

const transcriptLoadBatches = new WeakMap<() => void, TranscriptLoadBatch>();

function updateTranscriptLoadBatch(
  requestTranscriptReplacement: (() => void) | undefined,
  viewerToken: symbol,
  loading: boolean,
): void {
  if (!requestTranscriptReplacement) return;

  let batch = transcriptLoadBatches.get(requestTranscriptReplacement);
  if (!batch) {
    batch = {
      viewers: new Set(),
      active: new Set(),
      generation: 0,
      initialHydrationComplete: false,
    };
    transcriptLoadBatches.set(requestTranscriptReplacement, batch);
  }
  batch.viewers.add(viewerToken);

  if (batch.initialHydrationComplete) return;

  if (loading) {
    if (!batch.active.has(viewerToken)) {
      batch.active.add(viewerToken);
      batch.generation += 1;
    }
    return;
  }

  if (!batch.active.delete(viewerToken) || batch.active.size > 0) return;

  const settledGeneration = ++batch.generation;
  queueMicrotask(() => {
    const latest = transcriptLoadBatches.get(requestTranscriptReplacement);
    if (
      latest !== batch ||
      latest.active.size > 0 ||
      latest.generation !== settledGeneration
    ) {
      return;
    }
    latest.initialHydrationComplete = true;
    requestTranscriptReplacement();
  });
}

function unregisterTranscriptViewer(
  requestTranscriptReplacement: (() => void) | undefined,
  viewerToken: symbol,
): void {
  if (!requestTranscriptReplacement) return;
  const batch = transcriptLoadBatches.get(requestTranscriptReplacement);
  if (!batch) return;
  batch.viewers.delete(viewerToken);
  batch.active.delete(viewerToken);
  batch.generation += 1;
  if (batch.viewers.size === 0) {
    transcriptLoadBatches.delete(requestTranscriptReplacement);
  }
}

function progressStateToTaskStatus(
  state: Extract<
    IndividualToolCallDisplay['resultDisplay'],
    { isSubagentProgress: true }
  >['state'],
): TaskStatus {
  switch (state) {
    case 'running':
    case undefined:
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'killed';
    case 'error':
      return 'failed';
    default:
      return checkExhaustive(state);
  }
}

function mergeLoadedAndFallbackActivity(
  loaded: SubagentActivityItem[],
  fallback: SubagentActivityItem[],
): SubagentActivityItem[] {
  if (loaded.length === 0) return fallback;

  const loadedIds = new Set(loaded.map((item) => item.id));
  const fallbackOnly = fallback.filter((item) => !loadedIds.has(item.id));
  return fallbackOnly.length === 0 ? loaded : [...loaded, ...fallbackOnly];
}

const ExpandedSubagentProgress: React.FC<{
  progress: Extract<
    IndividualToolCallDisplay['resultDisplay'],
    { isSubagentProgress: true }
  >;
  toolCall: IndividualToolCallDisplay;
  terminalWidth: number;
  availableTerminalHeight?: number;
}> = ({ progress, toolCall, terminalWidth, availableTerminalHeight }) => {
  const registry = useTaskRegistry();
  const config = useConfig();
  const { requestTranscriptReplacement } = useApp();
  const registryVersion = useTaskRegistryVersion(registry);
  const registryTaskId = progress.agentId
    ? `a-${progress.agentId}`
    : undefined;
  void registryVersion;
  const registryTask = registryTaskId
    ? registry?.get(registryTaskId)
    : undefined;
  const agentTask = registryTask && isAgentTask(registryTask)
    ? registryTask
    : undefined;
  const effectiveProgress = agentTask?.progress ?? progress;
  const hasRegistryTask = agentTask !== undefined;

  // Start retaining the live suffix before the disk-read effect below runs.
  // This closes the window where a message could arrive after the snapshot but
  // before the expanded view subscribes to live task updates.
  useEffect(() => {
    if (!registry || !registryTaskId || !hasRegistryTask) return undefined;
    return registry.acquireTranscriptViewer(registryTaskId);
  }, [registry, registryTaskId, hasRegistryTask]);

  const transcriptSource = useMemo<AgentTranscriptSource | undefined>(() => {
    if (agentTask) return agentTask;
    if (!effectiveProgress.agentId || !registryTaskId) return undefined;
    return {
      id: registryTaskId,
      agentId: effectiveProgress.agentId,
      status: progressStateToTaskStatus(effectiveProgress.state),
    };
  }, [agentTask, effectiveProgress, registryTaskId]);
  const transcript = useAgentTranscript(transcriptSource);
  const shouldLoadTranscript = effectiveProgress.agentId !== undefined;
  const transcriptViewerTokenRef = useRef<symbol>(Symbol('transcript-viewer'));
  const initialTranscriptLoadStartedRef = useRef(false);
  const initialTranscriptLoadCompleteRef = useRef(false);
  const isInitialTranscriptLoading =
    shouldLoadTranscript &&
    !initialTranscriptLoadCompleteRef.current &&
    transcript.loading;

  // The expanded fallback can already be taller than the terminal. Once its
  // complete transcript arrives, rows above the viewport are native scrollback
  // and cannot be patched in place. Track all viewers sharing this renderer and
  // replay once after their initial load batch settles. Terminal refreshes,
  // newly added viewers, and live messages stay on the normal diff path.
  useLayoutEffect(() => {
    if (!shouldLoadTranscript || initialTranscriptLoadCompleteRef.current) {
      return;
    }
    if (transcript.loading) {
      initialTranscriptLoadStartedRef.current = true;
    } else if (initialTranscriptLoadStartedRef.current) {
      initialTranscriptLoadCompleteRef.current = true;
    }
    updateTranscriptLoadBatch(
      requestTranscriptReplacement,
      transcriptViewerTokenRef.current,
      transcript.loading,
    );
  }, [
    requestTranscriptReplacement,
    shouldLoadTranscript,
    transcript.loading,
  ]);
  useLayoutEffect(
    () => () => {
      unregisterTranscriptViewer(
        requestTranscriptReplacement,
        transcriptViewerTokenRef.current,
      );
    },
    [requestTranscriptReplacement],
  );
  const loadedActivity = useMemo(
    () =>
      transcript.messages.length === 0
        ? []
        : projectSubagentRecentActivity(transcript.messages, {
            targetDir: config.getTargetDir(),
          }),
    [config, transcript.messages],
  );
  const fallbackActivity = useMemo(
    () =>
      effectiveProgress.recentActivity.length > 0
        ? effectiveProgress.recentActivity
        : (toolCall.subagentHistory ?? []),
    [effectiveProgress.recentActivity, toolCall.subagentHistory],
  );
  const history = useMemo(
    () => mergeLoadedAndFallbackActivity(loadedActivity, fallbackActivity),
    [fallbackActivity, loadedActivity],
  );

  return (
    <Box flexDirection="column">
      {isInitialTranscriptLoading && (
        <Text color={theme.text.secondary}>Loading transcript...</Text>
      )}
      {shouldLoadTranscript && transcript.error && (
        <Text color={theme.status.error}>
          Unable to load full transcript: {transcript.error}
        </Text>
      )}
      <SubagentProgressDisplay
        progress={effectiveProgress}
        terminalWidth={terminalWidth}
        historyOverrides={history}
        renderToolResult={(tool) => (
          <ToolResultDisplay
            resultDisplay={tool.resultDisplay}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={Math.max(20, terminalWidth - 2)}
            renderOutputAsMarkdown={tool.renderOutputAsMarkdown}
          />
        )}
      />
    </Box>
  );
};

type CollapsedAgentState =
  | 'running'
  | 'backgrounded'
  | 'completed'
  | 'cancelled'
  | 'error';

function getCollapsedAgentState(
  toolCall: IndividualToolCallDisplay,
): CollapsedAgentState {
  const progress = toolCall.resultDisplay;
  if (
    isAgentBackgroundLaunchDisplay(progress) ||
    isAgentTeammateSpawnDisplay(progress)
  ) {
    return 'backgrounded';
  }

  if (isSubagentProgress(progress)) {
    if (
      progress.state === 'completed' ||
      progress.state === 'cancelled' ||
      progress.state === 'error'
    ) {
      return progress.state;
    }

    if (progress.backgrounded) {
      return 'backgrounded';
    }
  }

  switch (toolCall.status) {
    case CoreToolCallStatus.Success: {
      if (isSubagentProgress(progress)) {
        return progress.state ?? 'running';
      }
      return 'completed';
    }
    case CoreToolCallStatus.Cancelled:
      return 'cancelled';
    case CoreToolCallStatus.Error:
      return 'error';
    case CoreToolCallStatus.Executing:
    case CoreToolCallStatus.Scheduled:
    case CoreToolCallStatus.Validating:
    case CoreToolCallStatus.AwaitingApproval:
      return 'running';
    default:
      return checkExhaustive(toolCall.status);
  }
}

function renderCollapsedStatusIcon(state: CollapsedAgentState) {
  switch (state) {
    case 'running':
      return <SubagentRunningStatusIndicator />;
    case 'backgrounded':
      return <SubagentRunningStatusIndicator />;
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
    default:
      return checkExhaustive(state);
  }
}

export const SubagentGroupDisplay: React.FC<SubagentGroupDisplayProps> = ({
  toolCalls,
  availableTerminalHeight,
  terminalWidth,
  borderColor,
  borderDimColor,
  isFirst: _isFirst,
  isExpandable = true,
}) => {
  const isExpanded = availableTerminalHeight === undefined;
  const overflowActions = useOverflowActions();
  const uniqueId = useId();
  const overflowId = `subagent-${uniqueId}`;

  useEffect(() => {
    if (isExpandable && overflowActions) {
      // Register with the global overflow system so the detailed transcript
      // hint appears in the sticky footer.
      overflowActions.addOverflowingId(overflowId);
    }
    return () => {
      if (overflowActions) {
        overflowActions.removeOverflowingId(overflowId);
      }
    };
  }, [isExpandable, overflowActions, overflowId]);

  if (toolCalls.length === 0) {
    return null;
  }

  const allBackgrounded = toolCalls.every(
    (toolCall) => getCollapsedAgentState(toolCall) === 'backgrounded',
  );
  const allTeammates = toolCalls.every((toolCall) =>
    isAgentTeammateSpawnDisplay(toolCall.resultDisplay),
  );

  // Progress events use the agent color for the group border and name badge.
  const agentColor = (() => {
    for (const tc of toolCalls) {
      if (isSubagentProgress(tc.resultDisplay) && tc.resultDisplay.color) {
        return resolveAgentColor(tc.resultDisplay.color);
      }
    }
    return undefined;
  })();

  let headerText = '';
  if (toolCalls.length === 1) {
    switch (getCollapsedAgentState(toolCalls[0])) {
      case 'completed':
        headerText = 'Agent Completed';
        break;
      case 'backgrounded':
        headerText = allTeammates
          ? 'Teammate Launched'
          : 'Agent Launched in Background';
        break;
      case 'cancelled':
        headerText = 'Agent Cancelled';
        break;
      case 'error':
        headerText = 'Agent Error';
        break;
      case 'running':
        headerText = 'Running Agent...';
        break;
      default:
        headerText = 'Running Agent...';
        break;
    }
  } else {
    let completedCount = 0;
    let backgroundedCount = 0;
    let runningCount = 0;
    let cancelledCount = 0;
    let errorCount = 0;
    for (const tc of toolCalls) {
      const state = getCollapsedAgentState(tc);
      if (state === 'completed') completedCount++;
      else if (state === 'backgrounded') backgroundedCount++;
      else if (state === 'running') runningCount++;
      else if (state === 'cancelled') cancelledCount++;
      else if (state === 'error') errorCount++;
      else checkExhaustive(state);
    }

    if (backgroundedCount === toolCalls.length) {
      headerText = allTeammates
        ? `${toolCalls.length} Teammates Launched`
        : `${toolCalls.length} Agents Launched in Background`;
    } else if (completedCount === toolCalls.length) {
      headerText = `${toolCalls.length} Agents Completed`;
    } else if (cancelledCount === toolCalls.length) {
      headerText = `${toolCalls.length} Agents Cancelled`;
    } else if (errorCount === toolCalls.length) {
      headerText = `${toolCalls.length} Agents Error`;
    } else if (
      runningCount > 0 ||
      backgroundedCount > 0 ||
      completedCount > 0 ||
      cancelledCount > 0 ||
      errorCount > 0
    ) {
      const stateParts = [
        runningCount > 0 ? `${runningCount} running` : undefined,
        backgroundedCount > 0
          ? `${backgroundedCount} launched in background`
          : undefined,
        completedCount > 0 ? `${completedCount} completed` : undefined,
        cancelledCount > 0 ? `${cancelledCount} cancelled` : undefined,
        errorCount > 0 ? `${errorCount} error` : undefined,
      ].filter(Boolean);
      headerText = `${toolCalls.length} Agents (${stateParts.join(', ')})...`;
    } else {
      headerText = `Running ${toolCalls.length} Agents...`;
    }
  }
  const toggleText = `(${EXPAND_HINT_KEY} to ${isExpanded ? 'collapse' : 'expand'})`;

  const renderCollapsedRow = (
    key: string,
    agentName: string,
    icon: React.ReactNode,
    content: string,
    options: {
      displayArgs?: string;
      agentBgColor?: string;
      agentTextColor?: string;
      isFirstRow?: boolean;
    } = {},
  ) => {
    const {
      displayArgs,
      agentBgColor,
      agentTextColor,
      isFirstRow = false,
    } = options;
    return (
      <Box
        key={key}
        flexDirection="row"
        marginLeft={0}
        marginTop={0}
        borderTop={!isFirstRow}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderColor={theme.border.default}
        borderDimColor
      >
        <Box minWidth={2} flexShrink={0}>
          {icon}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <AgentNameBadge
            name={agentName}
            bgColor={agentBgColor}
            textColor={agentTextColor}
            wrap="truncate"
          />
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.border.default}> · </Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={theme.text.response} wrap="truncate">
            {content}
            {displayArgs && ` ${displayArgs}`}
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      borderLeft={true}
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={agentColor ?? (allBackgrounded ? theme.text.primary : borderColor)}
      borderDimColor={agentColor || allBackgrounded ? false : borderDimColor}
      borderStyle={getBorderStyle('tool')}
      marginLeft={INDENT.FEED_LEFT_OFFSET}
      paddingLeft={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <Box flexDirection="row" gap={1} marginBottom={isExpanded ? 1 : 0}>
        <Text color={theme.border.default}>≡</Text>
        <Text bold color={theme.text.primary}>
          {headerText}
        </Text>
        {isExpandable && <Text color={theme.border.default}>{toggleText}</Text>}
      </Box>

      {toolCalls.map((toolCall, index) => {
        const progress = toolCall.resultDisplay;

        if (!isSubagentProgress(progress)) {
          const backgroundLaunch = isAgentBackgroundLaunchDisplay(progress)
            ? progress
            : undefined;
          const teammateLaunch = isAgentTeammateSpawnDisplay(progress)
            ? progress
            : undefined;
          const teammateIdentity = getTeammateLaunchIdentity(
            progress,
            toolCall.name,
          );
          const teammateColor = teammateIdentity?.textColor;
          const agentName = teammateIdentity?.name ?? toolCall.name ?? 'agent';
          const collapsedState = getCollapsedAgentState(toolCall);
          const content =
            collapsedState === 'cancelled'
              ? USER_CANCELLED_DISPLAY
              : collapsedState === 'error'
                ? 'Error'
                : collapsedState === 'backgrounded'
                  ? teammateLaunch
                    ? 'Teammate'
                    : 'Backgrounded agent'
                  : collapsedState === 'completed'
                    ? 'Completed successfully'
                    : 'Starting...';
          if (!isExpanded) {
            return renderCollapsedRow(
              toolCall.callId,
              agentName,
              renderCollapsedStatusIcon(collapsedState),
              content,
              {
                agentTextColor: teammateColor,
                isFirstRow: index === 0,
              },
            );
          } else {
            return (
              <Box
                key={toolCall.callId}
                flexDirection="column"
                marginLeft={0}
                marginBottom={1}
              >
                <Box flexDirection="row">
                  <Box minWidth={2}>
                    {renderCollapsedStatusIcon(collapsedState)}
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <AgentNameBadge
                      name={agentName}
                      bgColor={teammateLaunch ? undefined : agentColor}
                      textColor={teammateColor}
                    />
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={theme.border.default}> · </Text>
                  </Box>
                  <Box flexShrink={1} minWidth={0}>
                    <Text color={theme.text.response} wrap="truncate">
                      {content}
                    </Text>
                  </Box>
                </Box>
                {(backgroundLaunch || teammateLaunch) && (
                  <Box marginLeft={3} marginTop={0}>
                    <Text color={theme.text.secondary} wrap="wrap">
                      Prompt: {(backgroundLaunch ?? teammateLaunch)!.prompt}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          }
        }

        const history = toolCall.subagentHistory ?? progress.recentActivity;
        const lastActivity: SubagentActivityItem | undefined =
          history[history.length - 1];
        const collapsedState = getCollapsedAgentState(toolCall);

        // Collapsed View: Show single compact line per agent
        if (!isExpanded) {
          let content = 'Starting...';
          let formattedArgs: string | undefined;

          if (collapsedState === 'cancelled') {
            content = USER_CANCELLED_DISPLAY;
          } else if (collapsedState === 'completed') {
            const terminationNotice = getSubagentTerminationNotice(progress);
            const maxTurns = progress.terminationDetails?.maxTurns;
            if (
              progress.terminateReason &&
              progress.terminateReason !== 'GOAL'
            ) {
              if (maxTurns !== undefined) {
                content = formatMaxTurnsReachedSummary(maxTurns);
              } else {
                content =
                  terminationNotice ??
                  `Finished Early (${progress.terminateReason})`;
              }
            } else {
              content = 'Completed successfully';
            }
          } else if (collapsedState === 'backgrounded') {
            content = 'Backgrounded agent';
          } else if (lastActivity) {
            // Match expanded view logic exactly:
            // Primary text: displayName || content
            content = lastActivity.displayName || lastActivity.content;

            // Secondary text: description || formatToolArgs(args)
            if (lastActivity.description) {
              formattedArgs = lastActivity.description;
            } else if (lastActivity.type === 'tool_call' && lastActivity.args) {
              formattedArgs = formatToolArgs(lastActivity.args);
            }
          } else if (collapsedState === 'error') {
            content = 'Error';
          }

          const displayArgs =
            collapsedState === 'completed' || collapsedState === 'backgrounded'
              ? ''
              : formattedArgs;

          return renderCollapsedRow(
            toolCall.callId,
            progress.agentName,
            renderCollapsedStatusIcon(collapsedState),
            collapsedState !== 'cancelled' && lastActivity?.type === 'thought'
              ? `💭 ${content}`
              : content,
            {
              displayArgs,
              agentBgColor: resolveAgentColor(progress.color),
              isFirstRow: index === 0,
            },
          );
        }

        // Expanded View: Render full history
        return (
          <Box
            key={toolCall.callId}
            flexDirection="column"
            marginLeft={0}
            marginBottom={1}
          >
            <ExpandedSubagentProgress
              progress={progress}
              toolCall={toolCall}
              terminalWidth={terminalWidth}
              availableTerminalHeight={availableTerminalHeight}
            />
          </Box>
        );
      })}
    </Box>
  );
};
