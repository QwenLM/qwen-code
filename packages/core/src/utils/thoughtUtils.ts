/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';

export type ThoughtSummary = {
  subject: string;
  description: string;
};

const START_DELIMITER = '**';
const END_DELIMITER = '**';

// Think tag delimiters
const THINK_START_TAG = '<think>';
const THINK_END_TAG = '</think>';

/**
 * Extracts thinking content from text containing <think>...</think> tags.
 *
 * This function handles models that output their reasoning process wrapped
 * in XML-style think tags (common in DeepSeek, Qwen, and other open-source
 * models). It extracts the thinking content and separates it from the
 * actual response.
 *
 * @param text The raw text that may contain <think> tags.
 * @returns An object containing:
 *   - thinkingContent: The extracted thinking content (empty string if no tags found)
 *   - responseContent: The remaining text after removing think tags
 *   - hasThinkTags: Boolean indicating whether think tags were found
 *
 * @example
 * // Single think tag
 * extractThinkTags('<think>Let me analyze this...</think>The answer is 42')
 * // Returns: { thinkingContent: 'Let me analyze this...', responseContent: 'The answer is 42', hasThinkTags: true }
 *
 * @example
 * // No think tags
 * extractThinkTags('Just a regular response')
 * // Returns: { thinkingContent: '', responseContent: 'Just a regular response', hasThinkTags: false }
 */
export function extractThinkTags(text: string): {
  thinkingContent: string;
  responseContent: string;
  hasThinkTags: boolean;
} {
  if (!text || typeof text !== 'string') {
    return { thinkingContent: '', responseContent: text || '', hasThinkTags: false };
  }

  const thinkStartIndex = text.indexOf(THINK_START_TAG);

  // No think tags found
  if (thinkStartIndex === -1) {
    return { thinkingContent: '', responseContent: text, hasThinkTags: false };
  }

  const thinkContentStart = thinkStartIndex + THINK_START_TAG.length;
  const thinkEndIndex = text.indexOf(THINK_END_TAG, thinkContentStart);

  // Opening tag found but no closing tag - treat entire remaining text as thinking
  if (thinkEndIndex === -1) {
    const thinkingContent = text.substring(thinkContentStart).trim();
    const responseContent = text.substring(0, thinkStartIndex).trim();
    return {
      thinkingContent,
      responseContent,
      hasThinkTags: true,
    };
  }

  // Both tags found, extract content
  const thinkingContent = text
    .substring(thinkContentStart, thinkEndIndex)
    .trim();
  const responseContent = (
    text.substring(0, thinkStartIndex) +
    text.substring(thinkEndIndex + THINK_END_TAG.length)
  ).trim();

  return {
    thinkingContent,
    responseContent,
    hasThinkTags: true,
  };
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

export function getThoughtText(
  response: GenerateContentResponse,
): string | null {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];

    if (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.length > 0
    ) {
      return candidate.content.parts
        .filter((part) => part.thought)
        .map((part) => part.text ?? '')
        .join('');
    }
  }
  return null;
}
