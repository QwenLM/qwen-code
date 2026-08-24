/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MidTurnQueueItem {
  text: string;
  images?: unknown[];
  files?: unknown[];
  midTurnState?: 'submitting' | 'queued';
  midTurnMessageId?: string;
  isInserting?: boolean;
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
 * Image rows are only matched here — the id proves the daemon owns them, while
 * a text comparison can't verify their attachments. File rows are never
 * matched — files are not pushed mid-turn, so they stay queued for the next
 * turn. Only when no id match exists does the second pass fall back to the
 * first text-only entry with matching text — any mid-turn row when the batch
 * carries no ids (older daemon), or a still-`submitting` row that hasn't
 * received its id yet. Matching stays count-based — one removal per injected
 * message — so a queue that holds the same text twice loses one entry per
 * matching injection. An entry that already fell back to the ordinary path
 * (`midTurnState === undefined`) is never matched.
 *
 * Text fallback skips batches from another originator so coincidentally equal
 * messages are not removed. In strict-id mode, an exact id still wins because
 * a refreshed client can adopt a session-wide daemon-owned row.
 *
 * Returns a NEW array when something was removed, or `null` when nothing matched
 * (so the caller can skip a redundant state update). `strictMessageIds`
 * disables the submitting-row text fallback for daemons that accept the
 * client-generated ids used by reconciliation; older daemons still need the
 * fallback because they mint their id after the request arrives.
 */
export function removeInjectedFromQueue<T extends MidTurnQueueItem>(
  prompts: readonly T[],
  batches: readonly MidTurnInjectedBatch[],
  sessionId: string,
  clientId?: string,
  strictMessageIds = false,
): T[] | null {
  const remaining = [...prompts];
  const isTextOnly = (prompt: T) =>
    (!prompt.images || prompt.images.length === 0) &&
    (!prompt.files || prompt.files.length === 0);
  const hasNoFiles = (prompt: T) => !prompt.files || prompt.files.length === 0;
  let changed = false;
  for (const batch of batches) {
    if (batch.sessionId !== sessionId) continue;
    const originatorMatches =
      batch.originatorClientId === undefined ||
      batch.originatorClientId === clientId;
    if (!originatorMatches && !strictMessageIds) continue;
    for (const [messageIndex, message] of batch.messages.entries()) {
      const messageId = batch.messageIds?.[messageIndex];
      // A strict id match wins regardless of position — and is the only pass
      // that may remove image rows; file rows are never matched because files
      // are not pushed mid-turn. The text fallback below only runs for rows
      // the id can't reach (no ids in the batch, or a row still awaiting its
      // admission id).
      let index =
        messageId !== undefined
          ? remaining.findIndex(
              (prompt) =>
                (prompt.midTurnState !== undefined || prompt.isInserting) &&
                prompt.midTurnMessageId === messageId &&
                hasNoFiles(prompt),
            )
          : -1;
      if (index < 0 && originatorMatches) {
        index = remaining.findIndex(
          (prompt) =>
            (prompt.midTurnState !== undefined || prompt.isInserting) &&
            (messageId === undefined ||
              ((prompt.midTurnState === 'submitting' || prompt.isInserting) &&
                (!strictMessageIds ||
                  prompt.midTurnMessageId === undefined))) &&
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
