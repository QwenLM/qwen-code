/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FinishReason as GenAiFinishReason,
  FunctionCallingConfigMode as GenAiFunctionCallingConfigMode,
  Part,
  PartListUnion,
} from '@google/genai';

export type FinishReason = GenAiFinishReason;
// Keep runtime values limited to the subset used outside provider adapters.
export const FinishReason = {
  STOP: 'STOP' as GenAiFinishReason,
  MAX_TOKENS: 'MAX_TOKENS' as GenAiFinishReason,
} as const;

export type FunctionCallingConfigMode = GenAiFunctionCallingConfigMode;
export const FunctionCallingConfigMode = {
  ANY: 'ANY' as GenAiFunctionCallingConfigMode,
} as const;

// Content conversion is adapted from @google/genai 2.6.0's `_isPart` and
// `_toParts` helpers (Copyright 2025 Google LLC, Apache-2.0); re-check parity
// on SDK upgrades.
function isPart(value: unknown): value is Part {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('fileData' in value ||
      'text' in value ||
      'functionCall' in value ||
      'functionResponse' in value ||
      'inlineData' in value ||
      'videoMetadata' in value ||
      'codeExecutionResult' in value ||
      'executableCode' in value)
  );
}

function toParts(partOrString: PartListUnion): Part[] {
  if (typeof partOrString === 'string') {
    return [{ text: partOrString }];
  }

  if (isPart(partOrString)) {
    return [partOrString];
  }

  if (!Array.isArray(partOrString)) {
    throw new Error('partOrString must be a Part object, string, or array');
  }

  if (partOrString.length === 0) {
    throw new Error('partOrString cannot be an empty array');
  }

  return partOrString.map((part) => {
    if (typeof part === 'string') {
      return { text: part };
    }
    if (isPart(part)) {
      return part;
    }
    throw new Error('element in PartUnion must be a Part object or string');
  });
}

function createContent(role: 'user' | 'model', value: PartListUnion): Content {
  return { role, parts: toParts(value) };
}

export function createUserContent(value: PartListUnion): Content {
  return createContent('user', value);
}

export function createModelContent(value: PartListUnion): Content {
  return createContent('model', value);
}
