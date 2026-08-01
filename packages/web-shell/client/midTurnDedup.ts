/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MidTurnQueueItem {
  text: string;
  images?: unknown[];
  midTurnState?: 'submitting' | 'queued';
  midTurnMessageId?: string;
}

export interface MidTurnInjectedBatch {
  sessionId: string;
  messages: readonly string[];
  messageIds?: readonly string[];
  /** Trusted client id that queued the messages (from the SSE envelope). */
  originatorClientId?: string;
}

/**
 * Reconcile injected mid-turn messages against the local pending queue: remove
 * the entry matching each injected message for `sessionId`, across ALL `batches`
 * (a multi-batch turn drains once per tool batch, so the consumer must process
 * every accumulated batch, not just the latest).
 *
 * Each injected message is matched in two passes. The first pass is a strict
 * `midTurnMessageId` match (the daemon mints an id at admission and echoes it on
 * injection); it wins regardless of array position, so two same-text sends can't
 * steal each other's removal when their admission responses arrive out of order.
 * Only when no id match exists does the second pass fall back to the first
 * text-only entry with matching text — any mid-turn row when the batch carries
 * no ids (older daemon), or a still-`submitting` row that hasn't received its id
 * yet. Matching stays count-based — one removal per injected message — so a
 * queue that holds the same text twice loses one entry per matching injection.
 * Entries carrying images are never matched: image messages aren't pushed
 * mid-turn (the drain channel carries plain strings), so they stay queued for
 * the next turn. An entry that already fell back to the ordinary path
 * (`midTurnState === undefined`) is never matched.
 *
 * Skips a batch whose `originatorClientId` is some OTHER client: the daemon
 * broadcasts the injection frame to every client on the session, but only the
 * client that queued the message should drop it — a peer with a coincidentally
 * equal text must keep its own entry. Batches with no originator (anonymous
 * push) are reconciled regardless.
 *
 * Returns a NEW array when something was removed, or `null` when nothing matched
 * (so the caller can skip a redundant state update).
 */
export function removeInjectedFromQueue<T extends MidTurnQueueItem>(
  prompts: readonly T[],
  batches: readonly MidTurnInjectedBatch[],
  sessionId: string,
  clientId?: string,
): T[] | null {
  const remaining = [...prompts];
  const isTextOnly = (prompt: T) =>
    !prompt.images || prompt.images.length === 0;
  let changed = false;
  for (const batch of batches) {
    if (batch.sessionId !== sessionId) continue;
    if (
      batch.originatorClientId !== undefined &&
      batch.originatorClientId !== clientId
    ) {
      continue;
    }
    for (const [messageIndex, message] of batch.messages.entries()) {
      const messageId = batch.messageIds?.[messageIndex];
      // A strict id match wins regardless of position; the text fallback below
      // only runs for rows the id can't reach (no ids in the batch, or a row
      // still awaiting its admission id).
      let index =
        messageId !== undefined
          ? remaining.findIndex(
              (prompt) =>
                prompt.midTurnState !== undefined &&
                prompt.midTurnMessageId === messageId &&
                isTextOnly(prompt),
            )
          : -1;
      if (index < 0) {
        index = remaining.findIndex(
          (prompt) =>
            prompt.midTurnState !== undefined &&
            (messageId === undefined ||
              (prompt.midTurnState === 'submitting' &&
                prompt.midTurnMessageId === undefined)) &&
            prompt.text === message &&
            isTextOnly(prompt),
        );
      }
      if (index >= 0) {
        remaining.splice(index, 1);
        changed = true;
      }
    }
  }
  return changed ? remaining : null;
}
