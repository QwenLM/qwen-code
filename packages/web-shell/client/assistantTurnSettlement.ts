/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useConnection,
  useDaemonPromptSettled,
  useTranscriptStore,
  type DaemonPromptSettledEvent,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useCallback, useRef } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type {
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnSettledEvent,
} from './customization';

const MAX_RECENT_WEB_SHELL_SETTLEMENTS = 1024;

type AssistantTurnSettledHandler = (
  event: WebShellAssistantTurnSettledEvent,
) => void;

function getSettledAssistantMessage(
  blocks: readonly DaemonTranscriptBlock[],
  promptId: string,
): WebShellAssistantMessageInfo | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block?.kind !== 'assistant' ||
      block.promptId !== promptId ||
      block.parentToolCallId !== undefined ||
      block.text.trim().length === 0
    ) {
      continue;
    }
    return {
      id: block.id,
      content: block.text,
      isStreaming: block.streaming ?? false,
      timestamp: block.serverTimestamp ?? block.clientReceivedAt,
    };
  }
  return undefined;
}

function projectAssistantTurnSettlement(
  event: DaemonPromptSettledEvent,
  currentSessionId: string | undefined,
  blocks: readonly DaemonTranscriptBlock[],
): WebShellAssistantTurnSettledEvent {
  const message =
    currentSessionId === event.sessionId
      ? getSettledAssistantMessage(blocks, event.promptId)
      : undefined;
  return {
    sessionId: event.sessionId,
    promptId: event.promptId,
    outcome: event.outcome,
    ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
    transcriptComplete: event.transcriptComplete,
    ...(message ? { message } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function useAssistantTurnSettlementProjection(
  onAssistantTurnSettled: AssistantTurnSettledHandler | undefined,
): void {
  const store = useTranscriptStore();
  const connection = useConnection();
  useDaemonPromptSettled((event) => {
    if (!onAssistantTurnSettled) return;
    onAssistantTurnSettled(
      projectAssistantTurnSettlement(
        event,
        connection.sessionId,
        store.getSnapshot().blocks,
      ),
    );
  });
}

export function useAssistantTurnSettlementDispatcher(
  onAssistantTurnSettled: AssistantTurnSettledHandler | undefined,
): AssistantTurnSettledHandler {
  const recentKeysRef = useRef(new Set<string>());
  const recentKeyOrderRef = useRef<string[]>([]);
  const deliveringKeysRef = useRef(new Set<string>());
  return useCallback(
    (event) => {
      if (!onAssistantTurnSettled) return;
      const key = JSON.stringify([event.sessionId, event.promptId]);
      if (recentKeysRef.current.has(key) || deliveringKeysRef.current.has(key))
        return;
      deliveringKeysRef.current.add(key);
      try {
        onAssistantTurnSettled(event);
      } finally {
        deliveringKeysRef.current.delete(key);
      }
      recentKeysRef.current.add(key);
      recentKeyOrderRef.current.push(key);
      while (
        recentKeyOrderRef.current.length > MAX_RECENT_WEB_SHELL_SETTLEMENTS
      ) {
        const oldestKey = recentKeyOrderRef.current.shift();
        if (oldestKey !== undefined) recentKeysRef.current.delete(oldestKey);
      }
    },
    [onAssistantTurnSettled],
  );
}

export function AssistantTurnSettlementObserver({
  onAssistantTurnSettled,
}: {
  onAssistantTurnSettled?: AssistantTurnSettledHandler;
}) {
  useAssistantTurnSettlementProjection(onAssistantTurnSettled);
  return null;
}
