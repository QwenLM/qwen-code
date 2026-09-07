/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useConnection,
  useTranscriptStore,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonTextTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { useDaemonPromptSettled } from './daemon/session/DaemonSessionProvider.js';
import type { DaemonPromptSettledEvent } from './daemon/session/types.js';
import type {
  WebShellAssistantMessageInfo,
  WebShellAssistantTurnSettledEvent,
} from './customization.js';

type AssistantTurnSettledHandler = (
  event: WebShellAssistantTurnSettledEvent,
) => void;

/**
 * Pick the turn's final retained top-level assistant message straight off the
 * raw blocks, using the same predicate the SDK reducer applies for this exact
 * question (`findFinalVisibleAssistantForPrompt` in
 * `@qwen-code/sdk`'s `daemon/ui/transcript.ts`): top-level, stamped with this
 * `promptId`, non-empty text.
 *
 * Re-projecting a `promptId`-filtered subset through the render adapter is not
 * equivalent: the reducer never stamps `promptId` on tool blocks, so the filter
 * drops every tool call of the settled turn, the adapter's tool-boundary branch
 * never runs, and its merge branch glues the turn's text halves into one
 * message published under the *first* block's id. Subagent-owned assistant
 * blocks also lose their `parentSubAgent` lookup once `toolsByCallId` is empty
 * and get promoted to a top-level answer.
 */
function getSettledAssistantMessage(
  blocks: readonly DaemonTranscriptBlock[],
  promptId: string,
): WebShellAssistantMessageInfo | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== 'assistant') continue;
    const textBlock: DaemonTextTranscriptBlock = block;
    if (
      textBlock.parentToolCallId !== undefined ||
      textBlock.promptId !== promptId ||
      textBlock.text.trim().length === 0
    ) {
      continue;
    }
    return {
      id: textBlock.id,
      content: textBlock.text,
      isStreaming: textBlock.streaming,
      timestamp: textBlock.serverTimestamp ?? textBlock.clientReceivedAt,
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
