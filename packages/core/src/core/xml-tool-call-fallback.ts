/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

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
 * Parses a raw parameter value. Only values that look like structured JSON
 * (objects or arrays) are parsed; scalar strings are preserved as-is to
 * avoid coercing e.g. a file named "null" or a string port "8080".
 */
function parseParameterValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
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

    const args: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
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
 * If XML tool calls are found and dominate the content, returns
 * functionCall parts and the remaining text (with recovered XML
 * blocks removed). Parameterless invoke blocks are preserved as
 * plain text since extractXmlToolCalls intentionally skips them.
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

  // Intent guard: only recover when XML blocks dominate the content.
  // Substantial surrounding prose suggests the model is documenting or
  // echoing the format, not emitting a tool call. Measure against all
  // invoke blocks (including parameterless ones the extraction skips).
  INVOKE_PATTERN.lastIndex = 0;
  const proseOnly = text
    .replace(INVOKE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 0 && proseOnly.length / text.length > 0.2) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  // Strip only invoke blocks that contain parameters (the ones we actually
  // recovered). Parameterless blocks are preserved as plain text.
  INVOKE_PATTERN.lastIndex = 0;
  const remainingText = text
    .replace(INVOKE_PATTERN, (block) => {
      PARAMETER_PATTERN.lastIndex = 0;
      return PARAMETER_PATTERN.test(block) ? '' : block;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const functionCallParts: Part[] = extracted.map((toolCall, index) => ({
    functionCall: {
      id: `xml-recovered-${index}-${Date.now()}`,
      name: toolCall.name,
      args: toolCall.args,
    },
  }));

  return { recovered: true, functionCallParts, remainingText };
}
