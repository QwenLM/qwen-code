/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Adapts `useDaemonStream` to the exact `useGeminiStream` signature + return
 * type, so `AppContainer` can render a daemon-hosted session by swapping its
 * `useStream` prop (B-prime). It ignores the gemini-specific inputs, reads the
 * attached driver from {@link DaemonStreamContext}, and maps the daemon hook's
 * output onto the in-process contract.
 *
 * First-milestone scope: text turns. `pendingToolCalls` is returned empty (the
 * live in-progress tool display rides the scheduler's `TrackedToolCall[]`, which
 * this path doesn't produce); daemon tool RESULTS still appear because the
 * reducer commits a `tool_group` history item on `turn_complete`. Live tool
 * display + the permission prompt binding are a following slice.
 */
import { useContext } from 'react';
import type { useGeminiStream } from '../useGeminiStream.js';
import { useDaemonStream } from './useDaemonStream.js';
import { DaemonStreamContext } from './DaemonStreamContext.js';

/** Flatten a `submitQuery` argument (string | Part | Part[]) to plain text. */
function toText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (Array.isArray(query)) {
    return query
      .map((p) =>
        typeof p === 'string'
          ? p
          : p && typeof p === 'object' && 'text' in p
            ? String((p as { text?: unknown }).text ?? '')
            : '',
      )
      .join('');
  }
  if (query && typeof query === 'object' && 'text' in query) {
    return String((query as { text?: unknown }).text ?? '');
  }
  return '';
}

export const useDaemonStreamAdapter: typeof useGeminiStream = (
  _geminiClient,
  _history,
  addItem,
) => {
  const driver = useContext(DaemonStreamContext);
  if (!driver) {
    throw new Error(
      'useDaemonStreamAdapter requires a DaemonStreamContext driver (attach the session before rendering).',
    );
  }
  const ds = useDaemonStream(driver, addItem);

  return {
    streamingState: ds.streamingState,
    submitQuery: (query) => ds.submitQuery(toText(query)),
    initError: ds.initError,
    pendingHistoryItems: ds.pendingHistoryItems,
    // No local pending state to clear: the in-flight turn lives in the daemon.
    clearPendingState: () => {},
    thought: ds.thought,
    cancelOngoingRequest: ds.cancelOngoingRequest,
    // Goal-turn preemption is an in-process admission concern; the daemon
    // session's goal turns are not admitted through this adapter.
    preemptGoalTurn: () => {},
    retryLastPrompt: ds.retryLastPrompt,
    // Live tool display deferred (see file header); results land via history.
    pendingToolCalls: [],
    // Approval-mode switching is a daemon-side concern not wired this slice.
    handleApprovalModeChange: async () => {},
    activePtyId: ds.activePtyId,
    loopDetectionConfirmationRequest: ds.loopDetectionConfirmationRequest,
    streamingResponseLengthRef: ds.streamingResponseLengthRef,
    isReceivingContent: ds.isReceivingContent,
  };
};
