/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentChatView — displays a single in-process agent's conversation.
 *
 * Renders the agent's message history using HistoryItemDisplay — the same
 * component used by the main agent view. AgentMessage[] is converted to
 * HistoryItem[] by agentMessagesToHistoryItems() so all 27 HistoryItem types
 * are available without duplicating rendering logic.
 *
 * Layout:
 *  - Static area:  finalized messages (efficient Ink <Static>)
 *  - Live area:    tool groups still executing / awaiting confirmation
 *  - Status line:  spinner while the agent is running
 *
 * Model text output is shown only after each round completes (no live
 * streaming), which avoids per-chunk re-renders and keeps the display simple.
 */

import { Box, Text, Static } from 'ink';
import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  AgentStatus,
  AgentEventType,
  type AgentStatusChangeEvent,
} from '@qwen-code/qwen-code-core';
import {
  useAgentViewState,
  useAgentViewActions,
} from '../../contexts/AgentViewContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { HistoryItemDisplay } from '../HistoryItemDisplay.js';
import { ToolCallStatus } from '../../types.js';
import { theme } from '../../semantic-colors.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { agentMessagesToHistoryItems } from './agentHistoryAdapter.js';

// ─── Main Component ─────────────────────────────────────────

interface AgentChatViewProps {
  agentId: string;
}

export const AgentChatView = ({ agentId }: AgentChatViewProps) => {
  const { agents } = useAgentViewState();
  const { setAgentShellFocused } = useAgentViewActions();
  const uiState = useUIState();
  const { historyRemountKey, availableTerminalHeight, constrainHeight } =
    uiState;
  const { columns: terminalWidth } = useTerminalSize();
  const agent = agents.get(agentId);
  const contentWidth = terminalWidth - 4;

  // Force re-render on message updates and status changes.
  // STREAM_TEXT is deliberately excluded — model text is shown only after
  // each round completes (via committed messages), avoiding per-chunk re-renders.
  const [, setRenderTick] = useState(0);
  const tickRef = useRef(0);
  const forceRender = useCallback(() => {
    tickRef.current += 1;
    setRenderTick(tickRef.current);
  }, []);

  useEffect(() => {
    if (!agent) return;

    const emitter = agent.interactiveAgent.getEventEmitter();
    if (!emitter) return;

    const onStatusChange = (_event: AgentStatusChangeEvent) => forceRender();
    const onToolCall = () => forceRender();
    const onToolResult = () => forceRender();
    const onRoundEnd = () => forceRender();
    const onApproval = () => forceRender();
    const onOutputUpdate = () => forceRender();

    emitter.on(AgentEventType.STATUS_CHANGE, onStatusChange);
    emitter.on(AgentEventType.TOOL_CALL, onToolCall);
    emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
    emitter.on(AgentEventType.ROUND_END, onRoundEnd);
    emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    emitter.on(AgentEventType.TOOL_OUTPUT_UPDATE, onOutputUpdate);

    return () => {
      emitter.off(AgentEventType.STATUS_CHANGE, onStatusChange);
      emitter.off(AgentEventType.TOOL_CALL, onToolCall);
      emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
      emitter.off(AgentEventType.ROUND_END, onRoundEnd);
      emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
      emitter.off(AgentEventType.TOOL_OUTPUT_UPDATE, onOutputUpdate);
    };
  }, [agent, forceRender]);

  const interactiveAgent = agent?.interactiveAgent;
  const messages = interactiveAgent?.getMessages() ?? [];
  const pendingApprovals = interactiveAgent?.getPendingApprovals();
  const liveOutputs = interactiveAgent?.getLiveOutputs();
  const shellPids = interactiveAgent?.getShellPids();
  const status = interactiveAgent?.getStatus();
  const isRunning =
    status === AgentStatus.RUNNING || status === AgentStatus.INITIALIZING;

  // Derive the active PTY PID: first shell PID among currently-executing tools.
  // Resets naturally to undefined when the tool finishes (shellPids cleared).
  const activePtyId =
    shellPids && shellPids.size > 0
      ? shellPids.values().next().value
      : undefined;

  // Track whether the user has toggled input focus into the embedded shell.
  // Mirrors the main agent's embeddedShellFocused in AppContainer.
  const [embeddedShellFocused, setEmbeddedShellFocusedLocal] = useState(false);

  // Sync to AgentViewContext so AgentTabBar can suppress arrow-key navigation
  // when an agent's embedded shell is focused.
  useEffect(() => {
    setAgentShellFocused(embeddedShellFocused);
    return () => setAgentShellFocused(false);
  }, [embeddedShellFocused, setAgentShellFocused]);

  // Reset focus when the shell exits (activePtyId disappears).
  useEffect(() => {
    if (!activePtyId) setEmbeddedShellFocusedLocal(false);
  }, [activePtyId]);

  // Ctrl+F: toggle shell input focus when a PTY is active.
  useKeypress(
    (key) => {
      if (key.ctrl && key.name === 'f') {
        if (activePtyId || embeddedShellFocused) {
          setEmbeddedShellFocusedLocal((prev) => !prev);
        }
      }
    },
    { isActive: true },
  );

  // Convert AgentMessage[] → HistoryItem[] via adapter.
  // tickRef.current in deps ensures we rebuild when events fire even if
  // messages.length and pendingApprovals.size haven't changed (e.g. a
  // tool result updates an existing entry in place).
  const allItems = useMemo(
    () =>
      agentMessagesToHistoryItems(
        messages,
        pendingApprovals ?? new Map(),
        liveOutputs,
        shellPids,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      messages.length,
      pendingApprovals?.size,
      liveOutputs?.size,
      shellPids?.size,
      tickRef.current,
    ],
  );

  // Split into committed (Static) and pending (live area).
  // Any tool_group with an Executing or Confirming tool — plus everything
  // after it — stays in the live area so confirmation dialogs remain
  // interactive (Ink's <Static> cannot receive input).
  const splitIndex = useMemo(() => {
    for (let idx = allItems.length - 1; idx >= 0; idx--) {
      const item = allItems[idx]!;
      if (
        item.type === 'tool_group' &&
        item.tools.some(
          (t) =>
            t.status === ToolCallStatus.Executing ||
            t.status === ToolCallStatus.Confirming,
        )
      ) {
        return idx;
      }
    }
    return allItems.length; // all committed
  }, [allItems]);

  const committedItems = allItems.slice(0, splitIndex);
  const pendingItems = allItems.slice(splitIndex);

  if (!agent || !interactiveAgent) {
    return (
      <Box marginX={2}>
        <Text color={theme.status.error}>
          Agent &quot;{agentId}&quot; not found.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Committed message history.
          key includes historyRemountKey: when refreshStatic() clears the
          terminal it bumps the key, forcing Static to remount and re-emit
          all items on the cleared screen. */}
      <Static
        key={`agent-${agentId}-${historyRemountKey}`}
        items={committedItems.map((item) => (
          <HistoryItemDisplay
            key={item.id}
            item={item}
            isPending={false}
            terminalWidth={terminalWidth}
            mainAreaWidth={contentWidth}
          />
        ))}
      >
        {(item) => item}
      </Static>

      {/* Live area — tool groups awaiting confirmation or still executing.
          Must remain outside Static so confirmation dialogs are interactive.
          Pass PTY state so ShellInputPrompt is reachable via Ctrl+F. */}
      {pendingItems.map((item) => (
        <HistoryItemDisplay
          key={item.id}
          item={item}
          isPending={true}
          terminalWidth={terminalWidth}
          mainAreaWidth={contentWidth}
          availableTerminalHeight={
            constrainHeight ? availableTerminalHeight : undefined
          }
          isFocused={true}
          activeShellPtyId={activePtyId ?? null}
          embeddedShellFocused={embeddedShellFocused}
        />
      ))}

      {/* Spinner */}
      {isRunning && (
        <Box marginX={2} marginTop={1}>
          <GeminiRespondingSpinner />
        </Box>
      )}
    </Box>
  );
};
