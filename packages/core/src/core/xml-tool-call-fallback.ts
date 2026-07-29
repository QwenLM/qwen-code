/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { Part } from '@google/genai';

const debugLogger = createDebugLogger('XML_TOOL_CALL_FALLBACK');

const INVOKE_PATTERN = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
const PARAMETER_PATTERN =
  /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;

export interface ExtractedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Detects whether text contains XML-style tool call patterns.
 */
export function containsXmlToolCalls(text: string): boolean {
  INVOKE_PATTERN.lastIndex = 0;
  return INVOKE_PATTERN.test(text);
}

/**
 * Parses a raw parameter value, restoring structured JSON values (objects,
 * arrays, numbers, booleans) when the model emitted them inline, and falling
 * back to the plain string otherwise.
 */
function parseParameterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Extracts XML-style tool calls from plain text content.
 * Returns an array of extracted tool calls, or an empty array if none found.
 */
export function extractXmlToolCalls(text: string): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = [];

  // Reset lastIndex for global regex
  INVOKE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INVOKE_PATTERN.exec(text)) !== null) {
    const toolName = match[1];
    const paramsBlock = match[2];

    const args: Record<string, unknown> = {};
    PARAMETER_PATTERN.lastIndex = 0;

    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAMETER_PATTERN.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2].trim();
      args[paramName] = parseParameterValue(paramValue);
    }

    if (toolName && Object.keys(args).length > 0) {
      results.push({ name: toolName, args });
    }
  }

  return results;
}

/**
 * Attempts to recover tool calls from XML-formatted text content.
 * If XML tool calls are found, returns functionCall parts and the
 * remaining text (with XML blocks removed).
 */
export function tryRecoverXmlToolCalls(text: string): {
  recovered: boolean;
  functionCallParts: Part[];
  remainingText: string;
} {
  const extracted = extractXmlToolCalls(text);

  if (extracted.length === 0) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  debugLogger.warn(
    `Recovered ${extracted.length} XML-style tool call(s) from plain text content: ${extracted.map((t) => t.name).join(', ')}`,
  );

  const functionCallParts: Part[] = extracted.map((toolCall, index) => ({
    functionCall: {
      id: `xml-recovered-${index}-${Date.now()}`,
      name: toolCall.name,
      args: toolCall.args,
    },
  }));

  // Remove XML blocks from text, keep surrounding content
  INVOKE_PATTERN.lastIndex = 0;
  const remainingText = text
    .replace(INVOKE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { recovered: true, functionCallParts, remainingText };
}
