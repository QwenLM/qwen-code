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

export type ResponsesReasoningSignaturePayload =
  | { id: string; encrypted_content: string }
  | { id: string; plaintext: true };

/**
 * Parses the OpenAI Responses reasoning-replay payload that
 * `openaiResponsesContentGenerator` stashes in the shared
 * `Part.thoughtSignature` field: either `JSON.stringify({ id, encrypted_content })`
 * (encrypted replay) or `JSON.stringify({ id, plaintext: true })` (verified
 * plaintext replay on endpoints without encrypted reasoning blobs).
 *
 * Shared by `isResponsesReasoningSignature` and `responses-converter.ts` so
 * foreign-wire recognition and Responses replay decoding never drift.
 * See https://github.com/QwenLM/qwen-code/issues/9453
 */
export function parseResponsesReasoningSignature(
  signature: unknown,
): ResponsesReasoningSignaturePayload | undefined {
  if (typeof signature !== 'string') return undefined;
  if (!signature.trimStart().startsWith('{')) return undefined;
  try {
    const payload: unknown = JSON.parse(signature);
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !('id' in payload) ||
      typeof payload.id !== 'string'
    ) {
      return undefined;
    }
    if (
      'encrypted_content' in payload &&
      typeof payload.encrypted_content === 'string'
    ) {
      return { id: payload.id, encrypted_content: payload.encrypted_content };
    }
    if ('plaintext' in payload && payload.plaintext === true) {
      return { id: payload.id, plaintext: true };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Recognizes the OpenAI Responses reasoning-replay payload stashed in
 * `Part.thoughtSignature`. A native Anthropic `thinking.signature` or Gemini
 * `thoughtSignature` is an opaque token that never takes this JSON shape, so
 * recognizing the payload keeps it off foreign wires without risking native
 * signatures.
 */
export function isResponsesReasoningSignature(signature: unknown): boolean {
  return parseResponsesReasoningSignature(signature) !== undefined;
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

/** The text of a response's thought parts, joined as the model sent it. */
export function getThoughtText(response: GenerateContentResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.thought)
    .map((part) => part.text ?? '')
    .join('');
}

/** `thoughtText` is the response's `getThoughtText`, when already read. */
export function getThoughtSummary(
  response: GenerateContentResponse,
  thoughtText = getThoughtText(response),
): ThoughtSummary | null {
  if (!thoughtText) {
    return null;
  }

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  if (
    parts.some((part) => part.thought && isOpenAIReasoningThoughtPart(part))
  ) {
    return { subject: '', description: thoughtText };
  }

  return parseThought(thoughtText);
}
