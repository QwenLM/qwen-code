/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import {
  isTerminalStatus,
  readSubagentTranscript,
  type AgentUnifiedTask,
  type Message,
} from '@qwen-code/core';
import { useConfig } from '../contexts/ConfigContext.js';

export interface AgentTranscriptState {
  messages: Message[];
  loading: boolean;
  error?: string;
}

export type AgentTranscriptSource = Pick<
  AgentUnifiedTask,
  'id' | 'agentId' | 'status' | 'liveMessages' | 'transcriptVersion'
>;

interface AgentTranscriptDiskState extends AgentTranscriptState {
  sourceKey?: string;
}

/**
 * Loads the raw subagent transcript messages so the viewer can reuse the same
 * Message -> HistoryItem -> HistoryItemDisplay pipeline as the main session.
 */
export function useAgentTranscript(
  task: AgentTranscriptSource | undefined,
): AgentTranscriptState {
  const config = useConfig();
  const sessionId = config.getSessionId();
  const sessionTranscriptPath = config.getActiveSessionTranscriptPath();
  const liveMessages = task?.liveMessages;
  const transcriptVersion = task?.transcriptVersion;
  const isTerminal = task ? isTerminalStatus(task.status) : false;
  const sourceKey = task?.agentId
    ? `${sessionTranscriptPath}:${task.id}:${task.agentId}`
    : undefined;
  const [diskState, setDiskState] = useState<AgentTranscriptDiskState>({
    messages: [],
    loading: false,
  });

  useEffect(() => {
    if (!task?.agentId) {
      setDiskState({ messages: [], loading: false, sourceKey });
      return;
    }

    let cancelled = false;
    setDiskState((previous) =>
      previous.sourceKey === sourceKey
        ? { ...previous, loading: true, error: undefined }
        : { messages: [], loading: true, sourceKey },
    );
    void readSubagentTranscript(
      { sessionTranscriptPath },
      sessionId,
      task.agentId,
    )
      .then((transcript) => {
        if (cancelled) return;
        setDiskState({
          messages: transcript?.messages ?? [],
          loading: false,
          sourceKey,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setDiskState({
          messages: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          sourceKey,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    sessionTranscriptPath,
    isTerminal,
    sourceKey,
    task?.agentId,
  ]);

  return useMemo<AgentTranscriptState>(() => {
    // `liveMessages` is appended in place while a detail view is active.
    // The version makes that mutation observable without copying the suffix.
    void transcriptVersion;
    if (task?.agentId) {
      const live = liveMessages ?? [];
      if (diskState.sourceKey !== sourceKey) {
        return { messages: live, loading: true };
      }

      const liveUuids = new Set(live.map((message) => message.uuid));
      const diskOnly = diskState.messages.filter(
        (message) => !liveUuids.has(message.uuid),
      );
      return {
        messages: [...diskOnly, ...live],
        loading: diskState.loading,
        error: diskState.error,
      };
    }

    return {
      messages: [],
      loading: diskState.loading || !isTerminal,
    };
  }, [
    diskState,
    liveMessages,
    isTerminal,
    sourceKey,
    task?.agentId,
    transcriptVersion,
  ]);
}
