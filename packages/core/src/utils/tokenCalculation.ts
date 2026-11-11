/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

// Token estimation constants
// ASCII characters (0-127) are roughly 4 chars per token
export const ASCII_TOKENS_PER_CHAR = 0.25;
// Non-ASCII characters (including CJK) are often 1-2 tokens per char.
// We use 1.3 as a conservative estimate to avoid underestimation.
export const NON_ASCII_TOKENS_PER_CHAR = 1.3;
// Fixed token estimate for images
export const IMAGE_TOKEN_ESTIMATE = 3000;
// Fixed token estimate for PDFs (~100 pages at 258 tokens/page)
// See: https://ai.google.dev/gemini-api/docs/document-processing
export const PDF_TOKEN_ESTIMATE = 25800;

// Maximum depth for recursive token estimation to prevent stack overflow from
// malicious or buggy nested structures. A depth of 3 is sufficient given
// standard multimodal responses are typically depth 1.
const MAX_RECURSION_DEPTH = 3;

/**
 * Heuristic estimation of tokens for a text string.
 * ASCII characters count as 0.25 tokens; non-ASCII (including CJK) as 1.3.
 */
export function estimateTextTokens(text: string): number {
  let asciiCharacters = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) asciiCharacters++;
  }
  return (
    asciiCharacters * ASCII_TOKENS_PER_CHAR +
    (text.length - asciiCharacters) * NON_ASCII_TOKENS_PER_CHAR
  );
}

/**
 * Heuristic estimation for media parts (images, PDFs) using fixed safe estimates.
 */
function estimateMediaTokens(part: Part): number | undefined {
  const inlineData = 'inlineData' in part ? part.inlineData : undefined;
  const fileData = 'fileData' in part ? part.fileData : undefined;
  const mimeType = inlineData?.mimeType || fileData?.mimeType;

  if (mimeType?.startsWith('image/')) {
    // Images: 3,000 tokens (covers up to 4K resolution on Gen 3)
    // See: https://ai.google.dev/gemini-api/docs/vision#token_counting
    return IMAGE_TOKEN_ESTIMATE;
  } else if (mimeType?.startsWith('application/pdf')) {
    // PDFs: 25,800 tokens (~100 pages at 258 tokens/page)
    // See: https://ai.google.dev/gemini-api/docs/document-processing
    return PDF_TOKEN_ESTIMATE;
  }
  return undefined;
}

/**
 * Heuristic estimation for tool responses, avoiding massive string copies
 * and accounting for nested Gen 3 multimodal parts.
 */
function estimateFunctionResponseTokens(part: Part, depth: number): number {
  const fr = part.functionResponse;
  if (!fr) return 0;

  let totalTokens = (fr.name?.length ?? 0) / 4;
  const response = fr.response as unknown;

  if (typeof response === 'string') {
    totalTokens += response.length / 4;
  } else if (response !== undefined && response !== null) {
    // For objects, stringify only the payload, not the whole Part object.
    totalTokens += JSON.stringify(response).length / 4;
  }

  // Gen 3: Handle nested multimodal parts recursively.
  const nestedParts = (fr as unknown as { parts?: Part[] }).parts;
  if (nestedParts && nestedParts.length > 0) {
    totalTokens += estimateTokenCountSync(nestedParts, depth + 1);
  }

  return totalTokens;
}

/**
 * Estimates token count for parts synchronously using a heuristic.
 * - Text: character-based heuristic (ASCII vs CJK) for all string sizes.
 * - Non-text (Tools, etc): JSON string length / 4.
 */
export function estimateTokenCountSync(
  parts: Part[],
  depth: number = 0,
): number {
  if (depth > MAX_RECURSION_DEPTH) {
    return 0;
  }

  let totalTokens = 0;
  for (const part of parts) {
    if (typeof part.text === 'string') {
      totalTokens += estimateTextTokens(part.text);
    } else if (part.functionResponse) {
      totalTokens += estimateFunctionResponseTokens(part, depth);
    } else {
      const mediaEstimate = estimateMediaTokens(part);
      if (mediaEstimate !== undefined) {
        totalTokens += mediaEstimate;
      } else {
        // Fallback for other non-text parts (e.g., functionCall).
        // Note: JSON.stringify(part) here is safe as these parts are typically small.
        totalTokens += JSON.stringify(part).length / 4;
      }
    }
  }
  return Math.floor(totalTokens);
}
