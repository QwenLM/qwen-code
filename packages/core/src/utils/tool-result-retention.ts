/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimatePartChars,
} from '../services/compactionInputSlimming.js';

// Fallback oversized budget for tool results whose producing tool declares no
// `maxOutputChars` (or when no budget resolver is supplied). Aligned with the
// shell tool's budget — the widest budget among the core built-in tools.
export const OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS = 30_000;

export interface ToolResultRetentionStats {
  /** Number of function-response (tool result) parts retained in history. */
  toolResultCount: number;
  /** Total characters retained across all tool results. */
  totalChars: number;
  /** Character size of the single largest retained tool result. */
  largestResultChars: number;
  /** Tool results retained above their producing tool's output budget. */
  oversizedResultCount: number;
  /** Fallback budget applied when a tool declares none. */
  oversizedThresholdChars: number;
}

export interface AnalyzeToolResultRetentionOptions {
  /** Fallback budget for tools that declare no `maxOutputChars`. */
  thresholdChars?: number;
  /**
   * Resolves the declared output budget of the tool that produced a result
   * (by its `functionResponse.name`), mirroring the scheduler's per-tool
   * limits. A result is oversized only if it exceeds its own tool's budget,
   * so compliant results from high-budget tools (e.g. MCP) are never flagged.
   */
  resolveToolBudgetChars?: (toolName: string) => number | undefined;
}

/**
 * Computes aggregate size/count signals for tool results retained in a
 * conversation history. Deliberately reports sizes and counts only — never
 * content — so the output is safe to paste into bug reports.
 *
 * Sizes reuse `estimatePartChars`, the same model the compression pipeline
 * uses, so both agree about the same history (string outputs are measured as
 * raw chars — no JSON-escaping inflation — and nested media parts are billed
 * at the image token estimate instead of their base64 length).
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
      if (!part.functionResponse) {
        continue;
      }

      const chars = estimatePartChars(part, DEFAULT_IMAGE_TOKEN_ESTIMATE);
      stats.toolResultCount += 1;
      stats.totalChars += chars;
      if (chars > stats.largestResultChars) {
        stats.largestResultChars = chars;
      }

      const budget =
        options.resolveToolBudgetChars?.(part.functionResponse.name ?? '') ??
        thresholdChars;
      // Budgets of `Infinity` (self-managed tools like read-file) never trip.
      if (Number.isFinite(budget) && chars > budget) {
        stats.oversizedResultCount += 1;
      }
    }
  }

  return stats;
}
