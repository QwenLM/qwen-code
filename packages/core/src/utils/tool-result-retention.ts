/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

// Matches the shell tool's per-tool output budget introduced by the layered
// tool-output truncation work; results retained above this size are the ones
// most likely to tax every later turn in a long session.
export const OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS = 30_000;

export interface ToolResultRetentionStats {
  /** Number of function-response (tool result) parts retained in history. */
  toolResultCount: number;
  /** Total characters retained across all tool results. */
  totalChars: number;
  /** Character size of the single largest retained tool result. */
  largestResultChars: number;
  /** Tool results retained above `oversizedThresholdChars`. */
  oversizedResultCount: number;
  oversizedThresholdChars: number;
}

export interface AnalyzeToolResultRetentionOptions {
  thresholdChars?: number;
}

/**
 * Computes aggregate size/count signals for tool results retained in a
 * conversation history. Deliberately reports sizes and counts only — never
 * content — so the output is safe to paste into bug reports.
 */
export function analyzeToolResultRetention(
  history: Content[],
  options: AnalyzeToolResultRetentionOptions = {},
): ToolResultRetentionStats {
  const thresholdChars =
    options.thresholdChars ?? OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS;

  const stats: ToolResultRetentionStats = {
    toolResultCount: 0,
    totalChars: 0,
    largestResultChars: 0,
    oversizedResultCount: 0,
    oversizedThresholdChars: thresholdChars,
  };

  for (const content of history) {
    for (const part of content.parts ?? []) {
      const functionResponse = part.functionResponse;
      if (!functionResponse) {
        continue;
      }

      const chars = measureToolResultChars(functionResponse.response);
      stats.toolResultCount += 1;
      stats.totalChars += chars;
      if (chars > stats.largestResultChars) {
        stats.largestResultChars = chars;
      }
      if (chars > thresholdChars) {
        stats.oversizedResultCount += 1;
      }
    }
  }

  return stats;
}

// Approximates the retained size of a tool result by serializing its response
// payload. `response` is the only field that can grow unboundedly; name/id
// are small identifiers that don't need to be counted.
function measureToolResultChars(
  response: Record<string, unknown> | undefined,
): number {
  if (!response) {
    return 0;
  }
  try {
    return JSON.stringify(response).length;
  } catch {
    // Circular or non-serializable payloads can't be measured precisely;
    // report zero rather than throwing from a diagnostic path.
    return 0;
  }
}
