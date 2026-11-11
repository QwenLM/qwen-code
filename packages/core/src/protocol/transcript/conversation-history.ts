/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantMessage, Message } from './message.js';

/**
 * Strips provider-specific thought signatures from runtime assistant messages.
 *
 * Runtime `Message[]` stores raw thinking blocks so provider switches can reuse
 * the durable transcript. Some providers reject thought signatures that were
 * emitted by a different backend, so session owners can sanitize the in-memory
 * assistant blocks before the next request.
 */
export function stripThoughtSignaturesFromMessages(
  messages: Message[],
): Message[];
export function stripThoughtSignaturesFromMessages(
  messages: readonly Message[],
): readonly Message[];
export function stripThoughtSignaturesFromMessages(
  messages: readonly Message[],
): readonly Message[] {
  let changed = false;

  const sanitized = messages.map((message) => {
    if (message.type !== 'assistant') {
      return message;
    }

    const nextAssistant = stripThoughtSignaturesFromAssistant(message);
    if (nextAssistant !== message) {
      changed = true;
    }
    return nextAssistant;
  });

  return changed ? sanitized : messages;
}

function stripThoughtSignaturesFromAssistant(
  message: AssistantMessage,
): AssistantMessage {
  let changed = false;

  const content = message.message.content.map((block) => {
    if (block.type !== 'thinking' || block.signature === '') {
      return block;
    }

    changed = true;
    return {
      ...block,
      signature: '',
    };
  });

  if (!changed) {
    return message;
  }

  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  };
}
