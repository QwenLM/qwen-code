/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type ToolCall,
  type CompletedToolCall,
  ROOT_TOOL_CALL_SCOPE_ID,
  type EditorType,
  type ToolCallSnapshot,
  CoreToolCallStatus,
  type SubagentActivityItem,
} from '@qwen-code/core';
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';

export type MarkToolsAsSubmittedFn = (callIds: string[]) => void;
export type CancelAllFn = (signal: AbortSignal) => void;
export type RetireToolCallsFn = (callIds: readonly string[]) => void;

const MAX_RETIRED_TOOL_CALL_IDS = 512;

/**
 * The shape expected by the TUI projection layer.
 * It matches the Core ToolCall structure + the UI metadata flag.
 */
export type TrackedToolCall = ToolCall & {
  responseSubmittedToAssistant?: boolean;
  subagentHistory?: SubagentActivityItem[];
};

// Narrowed types for specific statuses
export type TrackedWaitingToolCall = Extract<
  TrackedToolCall,
  { status: 'awaiting_approval' }
>;
export type TrackedCompletedToolCall = Extract<
  TrackedToolCall,
  { status: 'success' | 'error' }
>;
export type TrackedCancelledToolCall = Extract<
  TrackedToolCall,
  { status: 'cancelled' }
>;

/**
 * Projects tool-call snapshots published by the per-agent executors.
 */
export function useToolScheduler(
  _onComplete: (tools: CompletedToolCall[]) => Promise<void>,
  config: Config,
  _getPreferredEditor: () => EditorType | undefined,
): [
  TrackedToolCall[],
  MarkToolsAsSubmittedFn,
  React.Dispatch<React.SetStateAction<TrackedToolCall[]>>,
  CancelAllFn,
  number,
  RetireToolCallsFn,
] {
  // State stores tool calls organized by their originating toolCallScopeId
  const [toolCallsMap, setToolCallsMap] = useState<
    Record<string, TrackedToolCall[]>
  >({});
  const [lastToolOutputTime, setLastToolOutputTime] = useState<number>(0);

  const cancelledCallIdsRef = useRef<Set<string>>(new Set());
  const retiredCallIdsRef = useRef<Set<string>>(new Set());
  const latestToolCallsRef = useRef<TrackedToolCall[]>([]);

  const toolCallSnapshots = config.toolCallSnapshots;

  const internalAdaptToolCalls = useCallback(
    (coreCalls: ToolCall[], prevTracked: TrackedToolCall[]) =>
      adaptToolCalls(coreCalls, prevTracked),
    [],
  );

  useEffect(() => {
    const handler = (event: ToolCallSnapshot) => {
      const isRoot = event.toolCallScopeId === ROOT_TOOL_CALL_SCOPE_ID;
      const visibleToolCalls = event.toolCalls.filter(
        (call) => !retiredCallIdsRef.current.has(call.request.callId),
      );

      if (visibleToolCalls.length === 0) {
        return;
      }

      // Skip empty updates from Scheduler's clearBatch() in the finally block of
      // _startBatch(). These would wipe toolCallsMap before the consumer's
      // push-completed-tools useEffect can fire, causing tools to flash and
      // disappear. The schedule() function already clears state at the start of
      // each new batch via setToolCallsMap({}), so these are redundant for the UI.
      //
      // TODO(useToolScheduler): build tool state from explicit query lifecycle
      // events so empty scheduler updates can be processed without dropping UI
      // state.
      // After cancelAll(), discard late updates for the cancelled batch.
      // The UI already wrote a synthetic cancelled history item in cancelTurn();
      // accepting later success/progress updates would show the cancelled tools
      // again as running or completed.
      if (cancelledCallIdsRef.current.size > 0) {
        const eventCallIds = visibleToolCalls.map((tc) => tc.request.callId);
        const isCancelledBatchUpdate =
          eventCallIds.length > 0 &&
          eventCallIds.every((callId) =>
            cancelledCallIdsRef.current.has(callId),
          );
        if (isCancelledBatchUpdate) {
          return;
        }
      }

      // Update output timer for UI spinners (Side Effect)
      const hasExecuting = visibleToolCalls.some(
        (tc) => tc.status === CoreToolCallStatus.Executing,
      );

      if (hasExecuting) {
        setLastToolOutputTime(Date.now());
      }

      setToolCallsMap((prev) => {
        const prevCalls = prev[event.toolCallScopeId] ?? [];
        const prevCallIds = new Set(prevCalls.map((tc) => tc.request.callId));

        // For non-root schedulers, we only show tool calls that:
        // 1. Are currently awaiting approval.
        // 2. Were previously shown (e.g., they are now executing or completed).
        // This prevents "thinking" tools (reads/searches) from flickering in the UI
        // unless they specifically required user interaction.
        const filteredToolCalls = isRoot
          ? visibleToolCalls
          : visibleToolCalls.filter(
              (tc) =>
                tc.status === CoreToolCallStatus.AwaitingApproval ||
                prevCallIds.has(tc.request.callId),
            );

        // If this is a subagent and we have no tools to show and weren't showing any,
        // we can skip the update entirely to avoid unnecessary re-renders.
        if (
          !isRoot &&
          filteredToolCalls.length === 0 &&
          prevCalls.length === 0
        ) {
          return prev;
        }

        const adapted = internalAdaptToolCalls(filteredToolCalls, prevCalls);

        return {
          ...prev,
          [event.toolCallScopeId]: adapted,
        };
      });
    };

    return toolCallSnapshots.subscribeToolCallSnapshots(handler);
  }, [toolCallSnapshots, internalAdaptToolCalls]);

  const cancelAll: CancelAllFn = useCallback(
    (_signal) => {
      const activeCallIds = latestToolCallsRef.current.map(
        (tc) => tc.request.callId,
      );
      cancelledCallIdsRef.current = new Set(activeCallIds);
      setToolCallsMap((previous) => previous);
    },
    [],
  );

  const retireToolCalls: RetireToolCallsFn = useCallback((callIds) => {
    if (callIds.length === 0) return;

    for (const callId of callIds) {
      // 删除后重新插入，把 callId 移到 Set 末尾作为最近使用项。
      retiredCallIdsRef.current.delete(callId);
      retiredCallIdsRef.current.add(callId);
      if (retiredCallIdsRef.current.size > MAX_RETIRED_TOOL_CALL_IDS) {
        const oldestCallId = retiredCallIdsRef.current.values().next().value;
        if (oldestCallId !== undefined) {
          retiredCallIdsRef.current.delete(oldestCallId);
        }
      }
    }

    const retired = new Set(callIds);
    setToolCallsMap((previous) => {
      const next: Record<string, TrackedToolCall[]> = {};
      for (const [toolCallScopeId, calls] of Object.entries(previous)) {
        const retained = calls.filter(
          (call) => !retired.has(call.request.callId),
        );
        if (retained.length > 0) next[toolCallScopeId] = retained;
      }
      return next;
    });
  }, []);

  const markToolsAsSubmitted: MarkToolsAsSubmittedFn = useCallback(
    (callIdsToMark: string[]) => {
      setToolCallsMap((prevMap) => {
        const nextMap = { ...prevMap };
        for (const [sid, calls] of Object.entries(nextMap)) {
          nextMap[sid] = calls.map((tc) =>
            callIdsToMark.includes(tc.request.callId)
              ? { ...tc, responseSubmittedToAssistant: true }
              : tc,
          );
        }
        return nextMap;
      });
    },
    [],
  );

  // Flatten the map for the UI components that expect a single list of tools.
  const toolCalls = useMemo(
    () => Object.values(toolCallsMap).flat(),
    [toolCallsMap],
  );
  latestToolCallsRef.current = toolCalls;

  // Provide a setter that maintains compatibility with legacy [].
  const setToolCallsForDisplay = useCallback(
    (action: React.SetStateAction<TrackedToolCall[]>) => {
      setToolCallsMap((prev) => {
        const currentFlattened = Object.values(prev).flat();
        const nextFlattened =
          typeof action === 'function' ? action(currentFlattened) : action;

        if (nextFlattened.length === 0) {
          return {};
        }

        // Re-group by toolCallScopeId to preserve multi-scheduler state
        const nextMap: Record<string, TrackedToolCall[]> = {};
        for (const call of nextFlattened) {
          // All tool calls should have a toolCallScopeId from the core.
          // Default to ROOT_TOOL_CALL_SCOPE_ID as a safeguard.
          const sid = call.toolCallScopeId ?? ROOT_TOOL_CALL_SCOPE_ID;
          if (!nextMap[sid]) {
            nextMap[sid] = [];
          }
          nextMap[sid].push(call);
        }
        return nextMap;
      });
    },
    [],
  );

  return [
    toolCalls,
    markToolsAsSubmitted,
    setToolCallsForDisplay,
    cancelAll,
    lastToolOutputTime,
    retireToolCalls,
  ];
}

/**
 * ADAPTER: Merges UI metadata (submitted flag).
 */
function adaptToolCalls(
  coreCalls: ToolCall[],
  prevTracked: TrackedToolCall[],
): TrackedToolCall[] {
  const prevMap = new Map(prevTracked.map((t) => [t.request.callId, t]));

  return coreCalls.map((coreCall): TrackedToolCall => {
    const prev = prevMap.get(coreCall.request.callId);
    const responseSubmittedToAssistant =
      prev?.responseSubmittedToAssistant ?? false;
    return {
      ...coreCall,
      responseSubmittedToAssistant,
    } as TrackedToolCall;
  });
}
