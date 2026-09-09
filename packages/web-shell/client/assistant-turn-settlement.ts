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
  if (
    promptBlockIds.size === 0 ||
    blocks.some(
      (block) =>
        block.kind === 'assistant' &&
        promptBlockIds.has(block.id) &&
        block.streaming,
    )
  ) {
    return undefined;
  }
  const messages = transcriptBlocksToDaemonMessages(blocks, {
    includeSourceIdentity: true,
  });
  // Ownership for the scan below, deliberately wider than `promptBlockIds`,
  // but only while a block can still be backfilled: the reducer admits a delta
  // with no `promptId` and stamps it from a later delta for the same block
  // (sdk-typescript `daemon/ui/transcript.ts:836-840`). A *finished* unstamped
  // assistant block can never be stamped, and the turns that emit one
  // (goal-runtime and background-notification turns never cross the
  // `session/prompt` boundary that sets `entry.activePromptId`) are foreign.
  // Non-assistant blocks are never stamped by the reducer, so they stay
  // admitted; a block stamped with a *different* prompt id is foreign.
  const promptOwnedIds = new Set(
    blocks
      .filter(
        (block) =>
          block.promptId === promptId ||
          (block.promptId === undefined &&
            (block.kind !== 'assistant' || block.streaming === true)),
      )
      .map((block) => block.id),
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Whole-message ownership, not an intersection. The adapter merges
    // consecutive top-level assistant blocks without consulting `promptId`,
    // keeping the first block's `id` and concatenating the text
    // (`adapters/transcriptToMessages.ts:603-620`), and a continuation carries
    // no user echo to separate turns (`acp-bridge/src/bridge.ts:10582`). Two
    // adjacent turns therefore project to one message, and an intersection test
    // published it for both prompt ids — turn B's answer attributed to turn A,
    // under a message id both settlements share. Omitting `message` matches the
    // existing "not attributable" semantics rather than publishing contaminated
    // text. Missing or empty `sourceBlockIds` is not owned either: `every` is
    // vacuously true for an empty array.
    if (
      message?.role !== 'assistant' ||
      !message.sourceBlockIds?.length ||
      !message.sourceBlockIds.every((id) => promptOwnedIds.has(id))
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
