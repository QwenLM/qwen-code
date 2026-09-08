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
import { transcriptBlocksToDaemonMessages } from './adapters/transcriptToMessages.js';
import { useDaemonPromptSettled } from './daemon/session/DaemonSessionProvider.js';
import type { DaemonPromptSettledEvent } from './daemon/session/types.js';
import type {
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnSettledEvent,
} from './customization.js';

type AssistantTurnSettledHandler = (
  event: WebShellAssistantTurnSettledEvent,
) => void;

function getSettledAssistantMessage(
  blocks: readonly DaemonTranscriptBlock[],
  promptId: string,
): WebShellAssistantMessageInfo | undefined {
  const promptBlockIds = new Set(
    blocks
      .filter(
        (block) =>
          block.kind === 'assistant' &&
          block.parentToolCallId === undefined &&
          block.promptId === promptId,
      )
      .map((block) => block.id),
  );
  const messages = transcriptBlocksToDaemonMessages(blocks, {
    includeSourceIdentity: true,
  });
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role !== 'assistant' ||
      !message.sourceBlockIds?.some((id) => promptBlockIds.has(id))
    ) {
      continue;
    }
    // A whitespace-only assistant block that cannot merge (after a tool
    // boundary, or carrying a segmentId) renders as its own empty message and
    // would otherwise win the backward scan as the turn's final message. The
    // adapter's own emptiness test rejects only zero-length text, so re-apply
    // the block-level skip here. Streaming stays `return undefined` (not yet
    // settled) rather than `continue`.
    if (message.content.trim().length === 0) continue;
    if (message.isStreaming) return undefined;
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
  // Field by field, not by spread: the published host contract only widens
  // through a deliberate edit here, so an internal-only field added to
  // `DaemonPromptSettledEvent` cannot silently reach every host.
  return {
    sessionId: event.sessionId,
    promptId: event.promptId,
    outcome: event.outcome,
    ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
    ...(event.error
      ? {
          error: {
            message: event.error.message,
            ...(event.error.code !== undefined
              ? { code: event.error.code }
              : {}),
          },
        }
      : {}),
    ...(message ? { message } : {}),
  };
}

export function useAssistantTurnSettlementProjection(
  onAssistantTurnSettled: AssistantTurnSettledHandler | undefined,
): void {
  const store = useTranscriptStore();
  const connection = useConnection();
  useDaemonPromptSettled(
    onAssistantTurnSettled
      ? (event) =>
          onAssistantTurnSettled(
            projectAssistantTurnSettlement(
              event,
              connection.sessionId,
              store.getSnapshot().blocks,
            ),
          )
      : undefined,
  );
}

export function AssistantTurnSettlementObserver({
  onAssistantTurnSettled,
}: {
  onAssistantTurnSettled: AssistantTurnSettledHandler;
}) {
  useAssistantTurnSettlementProjection(onAssistantTurnSettled);
  return null;
}
