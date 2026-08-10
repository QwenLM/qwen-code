/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Hook that subscribes to an AgentSessionView and
 * derives streaming state, elapsed time, input-active flag, and status.
 *
 * Extracts the common reactivity + derived-state pattern shared by
 * AgentComposer and AgentChatView so each component only deals with
 * layout and interaction.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AgentStatus,
  isTerminalStatus,
  type AgentSessionView,
} from '@qwen-code/qwen-code-core';
import { StreamingState } from '../types.js';
import { useTimer } from './useTimer.js';

// ─── Types ──────────────────────────────────────────────────

export interface AgentStreamingInfo {
  /** The agent's current lifecycle status. */
  status: AgentStatus | undefined;
  /** Derived streaming state for StreamingContext / LoadingIndicator. */
  streamingState: StreamingState;
  /** Whether the agent can accept user input right now. */
  isInputActive: boolean;
  /** Seconds elapsed while in Responding state (resets each cycle). */
  elapsedTime: number;
  /** Prompt token count from the most recent round (for context usage). */
  lastPromptTokenCount: number;
}

// ─── Hook ───────────────────────────────────────────────────

/**
 * Subscribe to an AgentSessionView and derive UI streaming state.
 *
 * @param view - The agent view, or undefined if not yet registered.
 */
export function useAgentStreamingState(
  view: AgentSessionView | undefined,
): AgentStreamingInfo {
  // ── Force-render on agent events ──

  const [, setTick] = useState(0);
  const tickRef = useRef(0);
  const forceRender = useCallback(() => {
    tickRef.current += 1;
    setTick(tickRef.current);
  }, []);

  // ── Track last prompt token count from USAGE_METADATA events ──

  const [lastPromptTokenCount, setLastPromptTokenCount] = useState(
    () => view?.getLastPromptTokenCount?.() ?? 0,
  );

  useEffect(() => {
    if (!view) return;
    return view.onChange(() => {
      setLastPromptTokenCount(view.getLastPromptTokenCount?.() ?? 0);
      forceRender();
    });
  }, [view, forceRender]);

  // ── Derived state ──

  const status = view?.getStatus();
  const pendingApprovals = view?.getPendingApprovals();
  const hasPendingApprovals =
    pendingApprovals !== undefined && pendingApprovals.size > 0;

  const streamingState = useMemo(() => {
    if (hasPendingApprovals) {
      return StreamingState.WaitingForConfirmation;
    }
    if (status === AgentStatus.RUNNING || status === AgentStatus.INITIALIZING) {
      return StreamingState.Responding;
    }
    return StreamingState.Idle;
  }, [status, hasPendingApprovals]);

  const isInputActive =
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding) &&
    status !== undefined &&
    !isTerminalStatus(status);

  // ── Timer (resets each time we enter Responding) ──

  const [timerResetKey, setTimerResetKey] = useState(0);
  const prevStreamingRef = useRef(streamingState);
  useEffect(() => {
    if (
      streamingState === StreamingState.Responding &&
      prevStreamingRef.current !== StreamingState.Responding
    ) {
      setTimerResetKey((k) => k + 1);
    }
    prevStreamingRef.current = streamingState;
  }, [streamingState]);

  const elapsedTime = useTimer(
    streamingState === StreamingState.Responding,
    timerResetKey,
  );

  return {
    status,
    streamingState,
    isInputActive,
    elapsedTime,
    lastPromptTokenCount,
  };
}
