/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentResponse,
  Part,
  FunctionCall,
} from '@google/genai';
import { getResponseText } from './partUtils.js';

export function getResponseTextFromParts(parts: Part[]): string | undefined {
  if (!parts) {
    return undefined;
  }
  const textSegments = parts
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string');

  if (textSegments.length === 0) {
    return undefined;
  }
  return textSegments.join('');
}

/**
 * Default `output` string `convertToFunctionResponse` (in `coreToolScheduler`)
 * writes when a tool returned no text (e.g. media-only / empty results).
 * Exported as the single source of truth so the producer (coreToolScheduler)
 * and this consumer cannot drift: `getToolResponseDisplayText` treats it as
 * non-informative and falls back to media placeholders / the summary
 * `resultDisplay` instead of surfacing the literal.
 */
export const TOOL_SUCCEEDED_OUTPUT = 'Tool execution succeeded.';

/**
 * Extract the FULL tool-result text for display (Ctrl+O transcript full detail),
 * from the persisted `functionResponse` parts.
 *
 * Tool results are wrapped as `{ functionResponse: { response: { output },
 * parts?: media } }` (see `createFunctionResponsePart`). The complete content
 * lives in `response.output`; media attachments live in the NESTED
 * `functionResponse.parts`. `getResponseTextFromParts` only reads top-level
 * `part.text`, so it cannot see this — hence a dedicated extractor.
 *
 * Rules:
 * - concatenate every non-empty `response.output` (skipping the non-informative
 *   "Tool execution succeeded." placeholder);
 * - for nested media parts emit a `<media: mime>` placeholder; keep nested text;
 * - output present → return it (+ any media placeholders);
 * - no output but media present → return the placeholder(s);
 * - nothing extractable → return `undefined` so the UI falls back to the
 *   summary `resultDisplay`.
 *
 * Does NOT apply any character cap — the bound is whatever core already applied
 * (truncateToolOutput / per-tool paging). Full-detail semantics, §4.9.
 */
export function getToolResponseDisplayText(
  parts: Part[] | undefined,
): string | undefined {
  if (!parts || parts.length === 0) {
    return undefined;
  }
  const segments: string[] = [];
  for (const part of parts) {
    const fr = part.functionResponse as
      | {
          response?: { output?: unknown };
          parts?: Part[];
        }
      | undefined;
    if (!fr) {
      // Non-functionResponse part (rare inside tool results) — keep its text.
      if (typeof part.text === 'string' && part.text.length > 0) {
        segments.push(part.text);
      }
      continue;
    }
    const output = fr.response?.output;
    if (
      typeof output === 'string' &&
      output.length > 0 &&
      output !== TOOL_SUCCEEDED_OUTPUT
    ) {
      segments.push(output);
    }
    if (Array.isArray(fr.parts)) {
      for (const nested of fr.parts) {
        if (nested.inlineData) {
          segments.push(`<media: ${nested.inlineData.mimeType ?? 'inline'}>`);
        } else if (nested.fileData) {
          segments.push(
            `<media: ${nested.fileData.mimeType ?? nested.fileData.fileUri ?? 'file'}>`,
          );
        } else if (typeof nested.text === 'string' && nested.text.length > 0) {
          segments.push(nested.text);
        }
      }
    }
  }
  if (segments.length === 0) {
    return undefined;
  }
  return segments.join('\n');
}

export function getFunctionCalls(
  response: GenerateContentResponse,
): FunctionCall[] | undefined {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    return undefined;
  }
  const functionCallParts = parts
    .filter((part) => !!part.functionCall)
    .map((part) => part.functionCall as FunctionCall);

  // Handle special case: model returns two tool_calls where first has name but no args,
  // and second has no name but has args. Merge them together.
  if (functionCallParts.length === 2) {
    const [first, second] = functionCallParts;
    const firstHasNameOnly =
      first.name && (!first.args || Object.keys(first.args).length === 0);
    const secondHasArgsOnly =
      !second.name && second.args && Object.keys(second.args).length > 0;

    if (firstHasNameOnly && secondHasArgsOnly) {
      return [
        {
          name: first.name,
          args: second.args,
        },
      ];
    }
  }

  return functionCallParts.length > 0 ? functionCallParts : undefined;
}

export function getFunctionCallsFromParts(
  parts: Part[],
): FunctionCall[] | undefined {
  if (!parts) {
    return undefined;
  }
  const functionCallParts = parts
    .filter((part) => !!part.functionCall)
    .map((part) => part.functionCall as FunctionCall);
  return functionCallParts.length > 0 ? functionCallParts : undefined;
}

export function getFunctionCallsAsJson(
  response: GenerateContentResponse,
): string | undefined {
  const functionCalls = getFunctionCalls(response);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

export function getFunctionCallsFromPartsAsJson(
  parts: Part[],
): string | undefined {
  const functionCalls = getFunctionCallsFromParts(parts);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

export function getStructuredResponse(
  response: GenerateContentResponse,
): string | undefined {
  const textContent = getResponseText(response);
  const functionCallsJson = getFunctionCallsAsJson(response);

  if (textContent && functionCallsJson) {
    return `${textContent}\n${functionCallsJson}`;
  }
  if (textContent) {
    return textContent;
  }
  if (functionCallsJson) {
    return functionCallsJson;
  }
  return undefined;
}

export function getStructuredResponseFromParts(
  parts: Part[],
): string | undefined {
  const textContent = getResponseTextFromParts(parts);
  const functionCallsJson = getFunctionCallsFromPartsAsJson(parts);

  if (textContent && functionCallsJson) {
    return `${textContent}\n${functionCallsJson}`;
  }
  if (textContent) {
    return textContent;
  }
  if (functionCallsJson) {
    return functionCallsJson;
  }
  return undefined;
}
