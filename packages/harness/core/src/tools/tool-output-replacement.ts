/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isSemanticTextBlock(
  value: unknown,
): value is { type: 'text'; text: string } {
  return (
    isRecord(value) &&
    value['type'] === 'text' &&
    isString(value['text'])
  );
}

function isSemanticImageBlock(value: unknown): value is {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
} {
  if (!isRecord(value) || value['type'] !== 'image') return false;
  const source = value['source'];
  return (
    isRecord(source) &&
    source['type'] === 'base64' &&
    isString(source['media_type']) &&
    isString(source['data'])
  );
}

/** Project a semantic hook replacement into the model-facing GenAI parts. */
export function projectToolOutputReplacementToLlmContent(
  replacement: unknown,
): PartListUnion {
  if (typeof replacement === 'string') return replacement;

  if (Array.isArray(replacement)) {
    const parts: Part[] = [];
    for (const block of replacement) {
      if (isSemanticTextBlock(block)) {
        parts.push({ text: block.text });
        continue;
      }
      if (isSemanticImageBlock(block)) {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type,
            data: block.source.data,
          },
        });
      }
    }
    if (parts.length > 0 || replacement.length === 0) return parts;
  }

  if (isRecord(replacement) && isString(replacement['stdout'])) {
    return replacement['stdout'];
  }

  return safeJsonStringify(replacement) ?? String(replacement);
}
