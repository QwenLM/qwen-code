/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useConnection,
  useTranscriptStore,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { useDaemonPromptSettled } from './daemon/session/DaemonSessionProvider.js';
import type { DaemonPromptSettledEvent } from './daemon/session/types.js';
import type {
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnSettledEvent,
} from './customization.js';
import { transcriptBlocksToDaemonMessages } from './adapters/transcriptToMessages.js';

type AssistantTurnSettledHandler = (
  event: WebShellAssistantTurnSettledEvent,
) => void;

function getSettledAssistantMessage(
  blocks: readonly DaemonTranscriptBlock[],
  promptId: string,
): WebShellAssistantMessageInfo | undefined {
  const messages = transcriptBlocksToDaemonMessages(
    blocks.filter((block) => block.promptId === promptId),
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    return {
      id: message.id,
      content: message.content,
      isStreaming: message.isStreaming,
      timestamp: message.timestamp,
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
    ...event,
    ...(message ? { message } : {}),
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

export function AssistantTurnSettlementObserver({
  onAssistantTurnSettled,
}: {
  onAssistantTurnSettled?: AssistantTurnSettledHandler;
}) {
  useAssistantTurnSettlementProjection(onAssistantTurnSettled);
  return null;
}
