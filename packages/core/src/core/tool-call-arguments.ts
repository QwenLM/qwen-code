/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type ToolCallArgumentsParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'MALFORMED_JSON' | 'NON_OBJECT' };

/** Strictly parses a completed tool-call argument buffer as a JSON object. */
export function parseToolCallArguments(
  json: string,
): ToolCallArgumentsParseResult {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reason: 'NON_OBJECT' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'MALFORMED_JSON' };
  }
}
