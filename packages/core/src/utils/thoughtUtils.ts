/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse, Part } from '@google/genai';

export type ThoughtSummary = {
  subject: string;
  description: string;
};

const START_DELIMITER = '**';
const END_DELIMITER = '**';
const OPENAI_REASONING_THOUGHT_MARKER = Symbol('openaiReasoningThought');

type OpenAIReasoningThoughtPart = Part & {
  [OPENAI_REASONING_THOUGHT_MARKER]?: true;
};

export function createOpenAIReasoningThoughtPart(text: string): Part {
  const part: OpenAIReasoningThoughtPart = { text, thought: true };
  Object.defineProperty(part, OPENAI_REASONING_THOUGHT_MARKER, {
    value: true,
  });
  return part;
}

/**
 * @remarks The marker is stored on the original Part object and does not
 * survive cloning, spreading, or JSON serialization.
 */
export function isOpenAIReasoningThoughtPart(part: Part): boolean {
  return Boolean(
    (part as OpenAIReasoningThoughtPart)[OPENAI_REASONING_THOUGHT_MARKER],
  );
}

/**
 * Recognizes the OpenAI Responses reasoning-replay payload that
 * `openaiResponsesContentGenerator` stashes in the shared
 * `Part.thoughtSignature` field (`JSON.stringify({ id, encrypted_content })`).
 *
 * `thoughtSignature` carries no origin marker, so every wire that reads it has
 * to decide for itself whether the value is one of its own. A native Anthropic
 * `thinking.signature` or Gemini `thoughtSignature` is an opaque token that
 * never takes this JSON shape, so recognizing the payload is enough to keep it
 * off a foreign wire without putting a legitimate native signature at risk.
 *
 * Mirrors the shape checks already in `llm-chat.ts`
 * (`isCompleteResponsesReasoningSignature`) and `responses-converter.ts`
 * (`decodeReasoningSignature`).
 * See https://github.com/QwenLM/qwen-code/issues/9453
 */
export function isResponsesReasoningSignature(
  signature: string | undefined,
): boolean {
  if (!signature || !signature.startsWith('{')) return false;
  try {
    const payload: unknown = JSON.parse(signature);
    return (
      payload !== null &&
      typeof payload === 'object' &&
      'id' in payload &&
      typeof payload.id === 'string' &&
      'encrypted_content' in payload &&
      typeof payload.encrypted_content === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Parses a raw thought string into a structured ThoughtSummary object.
 *
 * Thoughts are expected to have a bold "subject" part enclosed in double
 * asterisks (e.g., **Subject**). The rest of the string is considered
 * the description. This function only parses the first valid subject found.
 *
 * @param rawText The raw text of the thought.
 * @returns A ThoughtSummary object. If no valid subject is found, the entire
 * string is treated as the description.
 */
export function parseThought(rawText: string): ThoughtSummary {
  const startIndex = rawText.indexOf(START_DELIMITER);
  if (startIndex === -1) {
    // No start delimiter found, the whole text is the description.
    return { subject: '', description: rawText };
  }

  const endIndex = rawText.indexOf(
    END_DELIMITER,
    startIndex + START_DELIMITER.length,
  );
  if (endIndex === -1) {
    // Start delimiter found but no end delimiter, so it's not a valid subject.
    // Treat the entire string as the description.
    return { subject: '', description: rawText };
  }

  const subject = rawText
    .substring(startIndex + START_DELIMITER.length, endIndex)
    .trim();

  // The description is everything before the start delimiter and after the end delimiter.
  const description = (
    rawText.substring(0, startIndex) +
    rawText.substring(endIndex + END_DELIMITER.length)
  ).trim();

  return { subject, description };
}

export function getThoughtSummary(
  response: GenerateContentResponse,
): ThoughtSummary | null {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];

    if (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.length > 0
    ) {
      const thoughtParts = candidate.content.parts.filter(
        (part) => part.thought,
      );
      if (thoughtParts.length === 0) {
        return null;
      }

      const thoughtText = thoughtParts.map((part) => part.text ?? '').join('');
      if (!thoughtText) {
        return null;
      }

      if (thoughtParts.some(isOpenAIReasoningThoughtPart)) {
        return { subject: '', description: thoughtText };
      }

      return parseThought(thoughtText);
    }
  }
  return null;
}
