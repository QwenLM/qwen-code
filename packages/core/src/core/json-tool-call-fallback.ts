/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

const TOOL_ARG_KEYS = new Set([
  'command',
  'content',
  'description',
  'file_path',
  'new_string',
  'old_string',
  'pattern',
  'plan',
  'prompt',
  'query',
  'run_in_background',
  'subagent_type',
  'todos',
]);

const RESERVED_KEYS = new Set(['id', 'name', 'type']);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function copyArgs(source: JsonRecord): JsonRecord {
  const args = Object.create(null) as JsonRecord;
  for (const [key, value] of Object.entries(source)) {
    args[key] = value;
  }
  return args;
}

function extractArgs(call: JsonRecord): JsonRecord | null {
  const nestedArgs = parseArguments(call['args'] ?? call['arguments']);
  if (nestedArgs && Object.keys(nestedArgs).length > 0) {
    return copyArgs(nestedArgs);
  }

  const argEntries = Object.entries(call).filter(
    ([key]) => !RESERVED_KEYS.has(key),
  );
  if (argEntries.length === 0) return null;
  if (!argEntries.some(([key]) => TOOL_ARG_KEYS.has(key))) return null;

  const args = Object.create(null) as JsonRecord;
  for (const [key, value] of argEntries) {
    args[key] = value;
  }
  return args;
}

/**
 * Attempts to recover tool calls from JSON content that the model emitted in
 * the text channel instead of as structured functionCall parts.
 */
export function tryRecoverJsonToolCalls(
  text: string,
  isKnownToolName: (name: string) => boolean,
): {
  recovered: boolean;
  functionCallParts: Part[];
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return { recovered: false, functionCallParts: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { recovered: false, functionCallParts: [] };
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0) return { recovered: false, functionCallParts: [] };

  const recovered = calls.map((call) => {
    if (!isRecord(call) || typeof call['name'] !== 'string') return null;
    const name = call['name'];
    if (!isKnownToolName(name)) return null;
    const args = extractArgs(call);
    return args ? { name, args } : null;
  });

  if (recovered.some((call) => call === null)) {
    return { recovered: false, functionCallParts: [] };
  }

  return {
    recovered: true,
    functionCallParts: recovered.map((toolCall, index) => ({
      functionCall: {
        id: `json-recovered-${index}-${Date.now()}`,
        name: toolCall!.name,
        args: toolCall!.args,
      },
    })),
  };
}
