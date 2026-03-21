/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion, Part } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('TOKEN_CALC');

const ASCII_TOKENS_PER_CHAR = 0.25;
const NON_ASCII_TOKENS_PER_CHAR = 1.3;
const IMAGE_TOKEN_ESTIMATE = 3000;
const PDF_TOKEN_ESTIMATE = 25800;
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;
const MAX_RECURSION_DEPTH = 3;

function estimateTextTokens(text: string): number {
  if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
    return text.length / 4;
  }

  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) {
      tokens += ASCII_TOKENS_PER_CHAR;
    } else {
      tokens += NON_ASCII_TOKENS_PER_CHAR;
    }
  }
  return tokens;
}

function estimateMediaTokens(part: Part): number | undefined {
  const inlineData = 'inlineData' in part ? part.inlineData : undefined;
  const fileData = 'fileData' in part ? part.fileData : undefined;
  const mimeType = inlineData?.mimeType || fileData?.mimeType;

  if (mimeType?.startsWith('image/')) {
    return IMAGE_TOKEN_ESTIMATE;
  } else if (mimeType?.startsWith('application/pdf')) {
    return PDF_TOKEN_ESTIMATE;
  }
  return undefined;
}

function estimateFunctionResponseTokens(part: Part, depth: number): number {
  const fr = part.functionResponse;
  if (!fr) return 0;

  let totalTokens = (fr.name?.length ?? 0) / 4;
  const response = fr.response as unknown;

  if (typeof response === 'string') {
    totalTokens += response.length / 4;
  } else if (response !== undefined && response !== null) {
    totalTokens += JSON.stringify(response).length / 4;
  }

  const nestedParts = (fr as unknown as { parts?: Part[] }).parts;
  if (nestedParts && nestedParts.length > 0) {
    totalTokens += estimateTokenCountSync(nestedParts, depth + 1);
  }

  return totalTokens;
}

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
        totalTokens += JSON.stringify(part).length / 4;
      }
    }
  }
  return Math.floor(totalTokens);
}

export async function calculateRequestTokenCount(
  request: PartListUnion,
  contentGenerator: ContentGenerator,
  model: string,
): Promise<number> {
  const parts: Part[] = Array.isArray(request)
    ? request.map((p) => (typeof p === 'string' ? { text: p } : p))
    : typeof request === 'string'
      ? [{ text: request }]
      : [request];

  const hasMedia = parts.some((p) => {
    const isMedia = 'inlineData' in p || 'fileData' in p;
    return isMedia;
  });

  if (hasMedia) {
    try {
      const response = await contentGenerator.countTokens({
        model,
        contents: [{ role: 'user', parts }],
      });
      return response.totalTokens ?? 0;
    } catch (error) {
      debugLogger.debug('countTokens API failed:', error);
      return estimateTokenCountSync(parts);
    }
  }

  return estimateTokenCountSync(parts);
}
