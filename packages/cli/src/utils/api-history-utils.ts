/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import {
  COMPRESSION_CONTINUATION_BRIDGE_MARKER,
  COMPRESSION_SUMMARY_MODEL_ACK,
  POST_COMPACT_ATTACHMENT_TEXT_PREFIXES,
  createDebugLogger,
  getStartupContextLength,
  isSystemReminderContent,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('API_HISTORY_UTILS');
const LEGACY_COMPRESSION_CONTINUATION_BRIDGE_PROMPT =
  'Continue with the prior task using the context above.';
const BACKGROUND_NOTIFICATION_PREFIX = '<task-notification';

/**
 * Checks whether a Content entry is the synthetic continuation bridge
 * inserted after compression. New histories use an invisible sentinel marker;
 * the exact visible prompt is kept as a legacy fallback for sessions
 * compressed before the marker was added.
 */
export function isCompressionContinuationBridge(
  content: Content | undefined,
): boolean {
  if (!content || content.role !== 'user') return false;
  return (
    content.parts?.some(
      (part) =>
        'text' in part &&
        typeof part.text === 'string' &&
        (part.text.startsWith(COMPRESSION_CONTINUATION_BRIDGE_MARKER) ||
          part.text === LEGACY_COMPRESSION_CONTINUATION_BRIDGE_PROMPT),
    ) ?? false
  );
}

export function hasTextPart(
  content: Content | undefined,
  text: string,
): boolean {
  return (
    content?.parts?.some((part) => 'text' in part && part.text === text) ??
    false
  );
}

export function hasModelTextPart(
  content: Content | undefined,
  text: string,
): boolean {
  return content?.role === 'model' && hasTextPart(content, text);
}

function hasModelFunctionCallPart(content: Content | undefined): boolean {
  return (
    content?.role === 'model' &&
    (content.parts?.some(
      (part) => 'functionCall' in part && part.functionCall,
    ) ??
      false)
  );
}

export function isPostCompactAttachmentContent(
  content: Content | undefined,
): boolean {
  if (!content || content.role !== 'user') return false;

  return (
    content.parts?.some((part) => {
      const text = 'text' in part ? part.text : undefined;
      return (
        typeof text === 'string' &&
        POST_COMPACT_ATTACHMENT_TEXT_PREFIXES.some((prefix) =>
          text.startsWith(prefix),
        )
      );
    }) ?? false
  );
}

/**
 * Checks if a Content entry is a user-initiated text prompt
 * as opposed to a tool result (functionResponse).
 */
export function isApiUserTextContent(content: Content): boolean {
  if (content.role !== 'user') return false;
  if (!content.parts || content.parts.length === 0) return false;

  const hasFunctionResponse = content.parts.some(
    (part) => 'functionResponse' in part,
  );
  if (hasFunctionResponse) return false;
  if (isSystemReminderContent(content)) return false;

  const textParts = content.parts
    .filter(
      (part): part is { text: string } & Part =>
        'text' in part &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0,
    )
    .map((part) => part.text.trim());
  if (textParts.length === 0) return false;

  const fullText = textParts.join(' ');
  return (
    !fullText.startsWith('?') &&
    !fullText.startsWith(BACKGROUND_NOTIFICATION_PREFIX)
  );
}

export function hasCompressionSummaryPair(
  apiHistory: Content[],
  startIndex: number,
): boolean {
  const summary = apiHistory[startIndex];
  return (
    !!summary &&
    isApiUserTextContent(summary) &&
    hasModelTextPart(apiHistory[startIndex + 1], COMPRESSION_SUMMARY_MODEL_ACK)
  );
}

/**
 * Returns the first API history index after the synthetic post-compression
 * prelude. Compression always emits summary + ack, and may also emit one
 * synthetic user attachment block plus a trailing model functionCall block.
 */
export function getCompressionTailStartIndex(
  apiHistory: Content[],
  startIndex: number,
): number {
  if (!hasCompressionSummaryPair(apiHistory, startIndex)) return startIndex;

  let tailStartIndex = startIndex + 2;
  if (isPostCompactAttachmentContent(apiHistory[tailStartIndex])) {
    tailStartIndex += 1;
    if (hasModelFunctionCallPart(apiHistory[tailStartIndex])) {
      tailStartIndex += 1;
    }
  }

  return tailStartIndex;
}

export function getApiUserTextIndices(
  apiHistory: Content[],
  startIndex: number,
  skipContinuationBridge: boolean,
): number[] {
  const indices: number[] = [];

  for (let i = startIndex; i < apiHistory.length; i++) {
    const content = apiHistory[i]!;
    if (!isApiUserTextContent(content)) continue;
    if (skipContinuationBridge && isCompressionContinuationBridge(content)) {
      debugLogger.debug('Skipping compression continuation bridge at index', i);
      continue;
    }
    indices.push(i);
  }

  return indices;
}

/**
 * Detects whether the API history starts with the startup context pair
 * (user env context + model acknowledgment).
 */
export function hasStartupContext(apiHistory: Content[]): boolean {
  return getStartupContextLength(apiHistory) > 0;
}
