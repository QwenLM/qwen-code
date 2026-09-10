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
import { assistantVisibleTextOf } from './adapters/transcriptToMessages.js';

type AssistantTurnSettledHandler = (
  event: WebShellAssistantTurnSettledEvent,
) => void;

function getSettledAssistantMessage(
  blocks: readonly DaemonTranscriptBlock[],
  promptId: string,
): WebShellAssistantMessageInfo | undefined {
  // Select at the block layer, by identity: `blocks` is the array the reducer
  // stamps `promptId` on, so this prompt's final assistant block is read off it
  // directly. Deriving it from the render adapter instead needs ownership
  // reconstructed from `sourceBlockIds` (the adapter drops `promptId`) and
  // inherits the adapter's merge of consecutive top-level assistant blocks,
  // which crosses turn boundaries — a continuation carries no user echo to
  // separate them (`acp-bridge/src/bridge.ts:10582`). Every block shape this
  // module did not hand-model then became a way to publish a foreign turn's
  // text, an earlier non-final message of this turn, or nothing at all, under a
  // `(sessionId, promptId)` key that is burned before the listener runs. The
  // exclusion terms below are the SDK's own for this exact question
  // (`sdk-typescript` `daemon/ui/transcript.ts`,
  // `findFinalVisibleAssistantForPrompt`), kept local because exporting it
  // would widen the `@qwen-code/sdk/daemon` public surface.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    // A subagent block belongs to its parent tool call; an unstamped block
    // belongs to a turn that never crossed the `session/prompt` boundary
    // setting `entry.activePromptId` (goal-runtime, background notification) or
    // to restored history, which is unstamped by construction; a block stamped
    // with another prompt id belongs to that prompt. None is this answer.
    if (
      block?.kind !== 'assistant' ||
      block.parentToolCallId !== undefined ||
      block.promptId !== promptId
    ) {
      continue;
    }
    // Still streaming means "not yet settled", not "keep looking": publishing
    // partial text is unrecoverable, as no corrected callback can follow.
    if (block.streaming) return undefined;
    // The renderer strips insight protocol frames from assistant block text,
    // so the raw `block.text` is not the message a host would see. A
    // payload-only block (an `/insight` progress/ready frame) renders to no
    // assistant text, so the substantive answer one slot earlier is still this
    // turn's final visible message — publishing the raw frame would leak
    // protocol JSON as the answer.
    const visibleText = assistantVisibleTextOf(block.text);
    if (visibleText.length === 0) continue;
    return {
      id: block.id,
      content: visibleText,
      isStreaming: block.streaming,
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
