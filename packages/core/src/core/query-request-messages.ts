/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Attachment } from '../attachments/types.js';
import type { Message } from '../protocol/transcript/message.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import {
  getPendingTurnMessages,
  type QueryRuntimeState,
} from './query-runtime-state.js';

/** Keeps durable per-turn attachments stable across request preparation retries. */
export function createQueryRequestMessages(
  getAttachments?: (turnsUsed: number) => readonly Attachment[],
) {
  let turnCount = -1;
  let attachments: Message[] = [];

  return {
    prepare(state: QueryRuntimeState) {
      let newMessages: readonly Message[] = [];
      if (turnCount !== state.turnCount) {
        attachments = (getAttachments?.(state.turnCount) ?? []).map(
          createAttachmentMessage,
        );
        turnCount = state.turnCount;
        newMessages = attachments;
      }
      // A retry can retain these attachments after the pending user message.
      // Keep one copy in the request tail even if compaction removed history.
      const pendingTurnMessages: Message[] = [];
      const seen = new Set<string>();
      for (const message of [
        ...(getPendingTurnMessages(state) ?? []),
        ...attachments,
      ]) {
        if (seen.has(message.uuid)) continue;
        seen.add(message.uuid);
        pendingTurnMessages.push(message);
      }
      return { newMessages, pendingTurnMessages };
    },
    commit(state: QueryRuntimeState): QueryRuntimeState {
      if (attachments.length === 0) return state;
      const existingIds = new Set(
        state.messages.map((message) => message.uuid),
      );
      const missing = attachments.filter(
        (message) => !existingIds.has(message.uuid),
      );
      return missing.length === 0
        ? state
        : { ...state, messages: [...state.messages, ...missing] };
    },
  };
}
