/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test helpers for constructing runtime Message objects in compression-v2 tests.
 *
 * These replace the old flat `{ role, content }` pattern with properly typed
 * `UserMessage` and `AssistantMessage` objects.
 */

import { randomUUID } from 'node:crypto';
import type {
  UserMessage,
  AssistantMessage,
  ContentBlockParam,
  ContentBlock,
} from '../protocol/transcript/message.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';

let counter = 0;

/**
 * Create a test UserMessage with content blocks.
 */
export function makeUser(
  content: ContentBlockParam[] | string,
  options?: {
    timestamp?: string;
    isCompactSummary?: boolean;
    isMeta?: boolean;
    isVisibleInTranscriptOnly?: boolean;
  },
): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: options?.timestamp ?? new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
    isCompactSummary: options?.isCompactSummary,
    isMeta: options?.isMeta,
    isVisibleInTranscriptOnly: options?.isVisibleInTranscriptOnly,
  };
}

/**
 * Create a test AssistantMessage with content blocks.
 */
export function makeAssistant(
  content: ContentBlock[],
  options?: { timestamp?: string },
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: options?.timestamp ?? new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `msg-test-${++counter}`,

      model: 'test-model',
      stop_reason: 'end_turn',

      usage: cloneUsage(),
      content,
    },
  };
}
