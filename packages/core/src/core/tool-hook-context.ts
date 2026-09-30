/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

export const TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE =
  '\n[hook additional context truncated]';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function safePrefix(text: string, length: number): string {
  if (length <= 0) return '';
  if (length >= text.length) return text;
  const end = isHighSurrogate(text.charCodeAt(length - 1))
    ? length - 1
    : length;
  return text.slice(0, end);
}

/**
 * Joins already-sanitized hook `additionalContext` segments (in the order
 * given) and bounds the result to `maxChars` characters, including the
 * truncation notice. Returns undefined when there is nothing to deliver.
 */
export function boundToolHookContext(
  segments: ReadonlyArray<string | undefined>,
  maxChars: number,
): string | undefined {
  const joined = segments.filter((segment) => !!segment).join('\n\n');
  if (!joined || !(maxChars > 0)) return undefined;
  if (joined.length <= maxChars) return joined;
  const notice = TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE;
  if (maxChars <= notice.length) {
    return safePrefix(joined, maxChars) || undefined;
  }
  return safePrefix(joined, maxChars - notice.length) + notice;
}

/**
 * Appends hook context to the text of the functionResponse that belongs to
 * `callId`, without mutating the input. Other parts (media, nested parts,
 * sibling text) and the functionResponse id/name are preserved. Prefers the
 * part whose id matches; falls back to the only functionResponse when none
 * carries a matching id. Returns the input unchanged when no unambiguous
 * target exists.
 */
export function appendToolHookContextToParts(
  parts: Part[],
  callId: string,
  context: string | undefined,
): Part[] {
  if (!context) return parts;
  let index = parts.findIndex((part) => part.functionResponse?.id === callId);
  if (index === -1) {
    const candidates = parts
      .map((part, i) => (part.functionResponse ? i : -1))
      .filter((i) => i !== -1);
    if (candidates.length !== 1) return parts;
    index = candidates[0];
  }

  const updated = [...parts];
  updated[index] = appendTextToFunctionResponse(parts[index], context);
  return updated;
}

/**
 * Appends `text` after a blank line to a functionResponse part's `output`
 * (or its string `error`), without mutating the part. A structured output is
 * serialized first; a response with neither gets `output` set to `text`.
 * Parts without a functionResponse are returned unchanged.
 */
export function appendTextToFunctionResponse(part: Part, text: string): Part {
  const functionResponse = part.functionResponse;
  if (!functionResponse) return part;
  const response = functionResponse.response ?? {};
  const output = response['output'];
  const error = response['error'];
  let key: 'output' | 'error' = 'output';
  let currentText = '';
  if (typeof output === 'string') {
    currentText = output;
  } else if (typeof error === 'string') {
    key = 'error';
    currentText = error;
  } else if (output !== undefined) {
    currentText = JSON.stringify(output) ?? '';
  }

  return {
    ...part,
    functionResponse: {
      ...functionResponse,
      response: {
        ...response,
        [key]: currentText ? `${currentText}\n\n${text}` : text,
      },
    },
  };
}
