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
