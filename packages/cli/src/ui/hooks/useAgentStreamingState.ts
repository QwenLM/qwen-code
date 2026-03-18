/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Hook that subscribes to an AgentInteractive's events and
 * derives streaming state, elapsed time, input-active flag, and status.
 *
 * Extracts the common reactivity + derived-state pattern shared by
 * AgentComposer and AgentChatView so each component only deals with
 * layout and interaction.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AgentStatus,
  AgentEventType,
  isTerminalStatus,
  type AgentInteractive,
  type AgentEventEmitter,
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
 * Subscribe to an AgentInteractive's events and derive UI streaming state.
 *
 * @param interactiveAgent - The agent instance, or undefined if not yet registered.
 * @param events - Which event types trigger a re-render. Defaults to
 *   STATUS_CHANGE, TOOL_WAITING_APPROVAL, and TOOL_RESULT — sufficient for
 *   composer / footer use. Callers like AgentChatView can pass a broader set
 *   (e.g. include TOOL_CALL, ROUND_END, TOOL_OUTPUT_UPDATE) for richer updates.
 */
export function useAgentStreamingState(
  interactiveAgent: AgentInteractive | undefined,
  events?: ReadonlyArray<(typeof AgentEventType)[keyof typeof AgentEventType]>,
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
    () => interactiveAgent?.getLastPromptTokenCount() ?? 0,
  );

  const subscribedEvents = events ?? DEFAULT_EVENTS;

  useEffect(() => {
    if (!interactiveAgent) return;
    const emitter: AgentEventEmitter | undefined =
      interactiveAgent.getEventEmitter();
    if (!emitter) return;

    const handler = () => forceRender();
    for (const evt of subscribedEvents) {
      emitter.on(evt, handler);
    }

    // Dedicated listener for usage metadata — updates React state directly
    // so the token count is available immediately (even if no other event
    // triggers a re-render). Prefers totalTokenCount (prompt + output)
    // because output becomes history for the next round, matching
    // geminiChat.ts.
    const usageHandler = (event: {
      usage?: { totalTokenCount?: number; promptTokenCount?: number };
    }) => {
      const count =
        event?.usage?.totalTokenCount ?? event?.usage?.promptTokenCount;
      if (typeof count === 'number' && count > 0) {
        setLastPromptTokenCount(count);
      }
    };
    emitter.on(AgentEventType.USAGE_METADATA, usageHandler);

    return () => {
      for (const evt of subscribedEvents) {
        emitter.off(evt, handler);
      }
      emitter.off(AgentEventType.USAGE_METADATA, usageHandler);
    };
  }, [interactiveAgent, forceRender, subscribedEvents]);

  // ── Derived state ──

  const status = interactiveAgent?.getStatus();
  const pendingApprovals = interactiveAgent?.getPendingApprovals();
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

// ─── Defaults ───────────────────────────────────────────────

const DEFAULT_EVENTS = [
  AgentEventType.STATUS_CHANGE,
  AgentEventType.TOOL_WAITING_APPROVAL,
  AgentEventType.TOOL_RESULT,
] as const;
