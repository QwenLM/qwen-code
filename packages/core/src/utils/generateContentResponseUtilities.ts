/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse, Part, FunctionCall } from '@google/genai';

/**
 * Extracts the text content from a `GenerateContentResponse`.
 * @param response The response from the generate content request.
 * @returns The combined text from all parts, or `undefined` if no text parts are found.
 */
export function getResponseText(
  response: GenerateContentResponse,
): string | undefined {
  const parts = response.candidates?.[0]?.content?.parts;
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
 * Extracts the text content from an array of `Part` objects.
 * @param parts An array of `Part` objects.
 * @returns The combined text from all parts, or `undefined` if no text parts are found.
 */
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
 * Extracts all function calls from a `GenerateContentResponse`.
 * @param response The response from the generate content request.
 * @returns An array of `FunctionCall` objects, or `undefined` if no function calls are found.
 */
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
  return functionCallParts.length > 0 ? functionCallParts : undefined;
}

/**
 * Extracts all function calls from an array of `Part` objects.
 * @param parts An array of `Part` objects.
 * @returns An array of `FunctionCall` objects, or `undefined` if no function calls are found.
 */
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

/**
 * Extracts all function calls from a `GenerateContentResponse` and returns them as a JSON string.
 * @param response The response from the generate content request.
 * @returns A JSON string representing the function calls, or `undefined` if no function calls are found.
 */
export function getFunctionCallsAsJson(
  response: GenerateContentResponse,
): string | undefined {
  const functionCalls = getFunctionCalls(response);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

/**
 * Extracts all function calls from an array of `Part` objects and returns them as a JSON string.
 * @param parts An array of `Part` objects.
 * @returns A JSON string representing the function calls, or `undefined` if no function calls are found.
 */
export function getFunctionCallsFromPartsAsJson(
  parts: Part[],
): string | undefined {
  const functionCalls = getFunctionCallsFromParts(parts);
  if (!functionCalls) {
    return undefined;
  }
  return JSON.stringify(functionCalls, null, 2);
}

/**
 * Gets a structured response from a `GenerateContentResponse`, combining text and function calls.
 * @param response The response from the generate content request.
 * @returns A string containing the text content and/or a JSON representation of the function calls.
 *          Returns `undefined` if the response contains neither.
 */
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

/**
 * Gets a structured response from an array of `Part` objects, combining text and function calls.
 * @param parts An array of `Part` objects.
 * @returns A string containing the text content and/or a JSON representation of the function calls.
 *          Returns `undefined` if the response contains neither.
 */
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
