/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  AgentResultDisplay,
  BackgroundActivity,
  BackgroundTaskEntry,
  Config,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { getAgentColor } from '../utils.js';
import {
  formatActivityLabel,
  formatTokenCount,
} from '../../../utils/formatters.js';
import { ToolConfirmationMessage } from '../../messages/ToolConfirmationMessage.js';

/** A single agent contributed to a tree by its parent `ToolGroupMessage`. */
export interface AgentTreeAgent {
  /** Tool call identifier; mirrors the registry entry's `toolUseId`. */
  callId: string;
  data: AgentResultDisplay;
  /**
   * True when this terminal currently has the focus lock for this
   * agent's pending confirmation. Drives whether the approval banner
   * renders inline above the tree.
   */
  isFocused?: boolean;
  /**
   * True when this agent has a pending confirmation but another
   * agent in the same group currently holds the focus lock.
   * Surfaced as a `⏳ Queued approval` annotation on the row.
   */
  isWaitingForOtherApproval?: boolean;
}

export interface AgentTreeProps {
  agents: AgentTreeAgent[];
  config: Config;
  childWidth: number;
  availableHeight?: number;
}

interface AgentDerived {
  toolUses: number;
  tokens: number | null;
  lastActivity: BackgroundActivity | null;
  isAsync: boolean;
  isDone: boolean;
  isError: boolean;
}

const TREE_HEAD_LAST = '└─';
const TREE_HEAD_BRANCH = '├─';
const TREE_TAIL_LAST = '   ⎿  ';
const TREE_TAIL_BRANCH = '│  ⎿  ';

/**
 * Compact tree of running agents in a single tool group.
 *
 * Replaces the suppressed-during-live `AgentExecutionDisplay` for the
 * `isPending` phase of a `ToolGroupMessage`. Renders a header line plus
 * one or two visual rows per agent, with `├─/└─/⎿` connectors so the
 * group reads as a tree without a Box border. Subscribes to the
 * background-task registry's activity stream so row 2 (the last-tool
 * label) stays current as tools fire.
 *
 * Approval banner: when the focus-holding agent has a pending
 * confirmation, the banner renders *above* the tree. The tree continues
 * to render below so siblings remain visible while the user decides.
 */
export const AgentTree: React.FC<AgentTreeProps> = ({
  agents,
  config,
  childWidth,
  availableHeight,
}) => {
  const [, setActivityTick] = useState(0);

  // Re-render when any agent in the tree emits an activity event.
  // `callIdsKey` is the stable signature of the agent set; using it
  // (rather than the `agents` array identity) keeps the listener from
  // resubscribing on every parent render.
  const callIdsKey = agents.map((a) => a.callId).join('\x00');
  useEffect(() => {
    const ids = new Set(callIdsKey ? callIdsKey.split('\x00') : []);
    const registry = config.getBackgroundTaskRegistry();
    return registry.addActivityChangeListener((entry) => {
      if (entry.toolUseId && ids.has(entry.toolUseId)) {
        setActivityTick((n) => n + 1);
      }
    });
  }, [config, callIdsKey]);

  const registry = config.getBackgroundTaskRegistry();
  const entriesByCallId = new Map<string, BackgroundTaskEntry>();
  for (const entry of registry.getAll()) {
    if (entry.toolUseId) entriesByCallId.set(entry.toolUseId, entry);
  }

  const derived: AgentDerived[] = agents.map((a) =>
    deriveAgentState(a, entriesByCallId.get(a.callId)),
  );

  const focused = agents.find((a) => a.isFocused && a.data.pendingConfirmation);

  const commonType = sharedSubagentName(agents);
  const headerText = deriveHeaderText(agents.length, derived, commonType);

  return (
    <Box flexDirection="column">
      {focused && (
        <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
          <Box>
            <Text color={theme.text.secondary}>Approval requested by </Text>
            <Text bold color={getAgentColor(focused.data.subagentColor)}>
              {focused.data.subagentName || 'agent'}
            </Text>
            <Text color={theme.text.secondary}>:</Text>
          </Box>
          <ToolConfirmationMessage
            confirmationDetails={focused.data.pendingConfirmation!}
            isFocused={true}
            availableTerminalHeight={availableHeight}
            contentWidth={childWidth - 2}
            compactMode={true}
            config={config}
          />
        </Box>
      )}
      <Box paddingLeft={1}>
        <Text dimColor>{headerText}</Text>
      </Box>
      {agents.map((agent, index) => (
        <AgentRow
          key={agent.callId}
          agent={agent}
          derived={derived[index]}
          isLast={index === agents.length - 1}
          hideName={commonType !== null}
        />
      ))}
    </Box>
  );
};

interface AgentRowProps {
  agent: AgentTreeAgent;
  derived: AgentDerived;
  isLast: boolean;
  /**
   * True when every agent in the tree shares the same `subagentName`.
   * The shared name has already been promoted into the group header,
   * so the row drops it and shows just the task description.
   */
  hideName: boolean;
}

const AgentRow: React.FC<AgentRowProps> = ({
  agent,
  derived,
  isLast,
  hideName,
}) => {
  const { data } = agent;
  const { toolUses, tokens, lastActivity, isAsync, isDone, isError } = derived;
  const headChar = isLast ? TREE_HEAD_LAST : TREE_HEAD_BRANCH;
  const tailPrefix = isLast ? TREE_TAIL_LAST : TREE_TAIL_BRANCH;
  const taskDescription = data.taskDescription;
  const showTask = !!taskDescription && taskDescription.length > 0;
  const color = getAgentColor(data.subagentColor);

  return (
    <Box flexDirection="column">
      <Box paddingLeft={1}>
        <Text dimColor>{headChar} </Text>
        <Text dimColor={!isDone}>
          {hideName ? (
            showTask && (
              <Text bold color={color}>
                {taskDescription}
              </Text>
            )
          ) : (
            <>
              <Text bold color={color}>
                {data.subagentName || 'agent'}
              </Text>
              {showTask && (
                <Text color={theme.text.secondary}> ({taskDescription})</Text>
              )}
            </>
          )}
          {isAsync ? (
            <Text color={theme.text.secondary}>
              {' · Running in the background'}
            </Text>
          ) : (
            <>
              <Text color={theme.text.secondary}>{' · '}</Text>
              <Text>
                {toolUses} tool {toolUses === 1 ? 'use' : 'uses'}
              </Text>
              {tokens !== null && (
                <>
                  <Text color={theme.text.secondary}>{' · '}</Text>
                  <Text>{formatTokenCount(tokens)} tokens</Text>
                </>
              )}
            </>
          )}
          {agent.isWaitingForOtherApproval && (
            <Text color={theme.text.secondary} dimColor>
              {' · ⏳ Queued approval'}
            </Text>
          )}
        </Text>
      </Box>
      {!isAsync && (
        <Box paddingLeft={1} flexDirection="row">
          <Text dimColor>{tailPrefix}</Text>
          <Text dimColor color={isError ? theme.status.error : undefined}>
            {rowTwoText(data, lastActivity, isDone, isError)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

function deriveAgentState(
  agent: AgentTreeAgent,
  entry: BackgroundTaskEntry | undefined,
): AgentDerived {
  const { data } = agent;
  const isAsync = data.status === 'background';
  const isDone =
    data.status === 'completed' ||
    data.status === 'failed' ||
    data.status === 'cancelled';
  const isError = data.status === 'failed' || data.status === 'cancelled';

  // Prefer the live registry entry's stats while it exists; fall back
  // to the terminal `executionSummary` once foreground entries are
  // unregistered. Without the fallback, finished siblings inside a
  // still-pending group would render as `0 tool uses · 0 tokens`.
  let toolUses = 0;
  let tokens: number | null = null;
  let lastActivity: BackgroundActivity | null = null;
  if (entry) {
    toolUses = entry.stats?.toolUses ?? 0;
    tokens = entry.stats?.totalTokens ?? null;
    const buf = entry.recentActivities;
    lastActivity = buf && buf.length > 0 ? buf[buf.length - 1] : null;
  }
  if (data.executionSummary && (!entry || isDone)) {
    toolUses = data.executionSummary.totalToolCalls;
    tokens = data.executionSummary.totalTokens;
  } else if (tokens === null && typeof data.tokenCount === 'number') {
    tokens = data.tokenCount;
  }

  return { toolUses, tokens, lastActivity, isAsync, isDone, isError };
}

function deriveHeaderText(
  count: number,
  derived: AgentDerived[],
  commonType: string | null,
): string {
  // `isAsync` agents are still running detached from the parent — they
  // are not "finished," so the finished/launched headers must require
  // genuine terminal status. A run that mixes a finished foreground
  // agent with a backgrounded sibling stays in the "Running…" branch
  // until the backgrounded sibling also terminates.
  const allFinished = derived.every((d) => d.isDone);
  const allAsync = derived.every((d) => d.isAsync);

  if (allAsync) {
    return `${count} background agents launched (↓ to manage)`;
  }
  if (allFinished) {
    return commonType
      ? `${count} ${commonType} agents finished`
      : `${count} agents finished`;
  }
  return commonType
    ? `Running ${count} ${commonType} agents…`
    : `Running ${count} agents…`;
}

function rowTwoText(
  data: AgentResultDisplay,
  lastActivity: BackgroundActivity | null,
  isDone: boolean,
  isError: boolean,
): string {
  if (isError) {
    return (
      data.terminateReason ??
      (data.status === 'failed' ? 'Failed' : 'Cancelled')
    );
  }
  if (isDone) {
    return 'Done';
  }
  if (lastActivity) {
    return formatActivityLabel(lastActivity.name, lastActivity.description);
  }
  return 'Initializing…';
}

/**
 * Returns the shared `subagentName` if every agent uses the same one
 * (and the name is non-empty), else `null`. Used to decide whether the
 * header should promote the name (`Running 3 reviewer agents…`) and
 * the per-row labels should drop it.
 */
function sharedSubagentName(agents: AgentTreeAgent[]): string | null {
  if (agents.length === 0) return null;
  const first = agents[0].data.subagentName;
  if (!first) return null;
  return agents.every((a) => a.data.subagentName === first) ? first : null;
}
