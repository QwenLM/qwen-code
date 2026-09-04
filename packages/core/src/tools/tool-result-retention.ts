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
import {
  COMBINED_PASS_TOLERANCE_FACTOR,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
  TRUNCATION_FALLBACK_ENVELOPE_SLACK,
} from './truncation.js';

export { COMBINED_PASS_TOLERANCE_FACTOR } from './truncation.js';

// Fallback oversized budget for tool results whose producing tool declares no
// `maxOutputChars` (or when no budget resolver is supplied). Callers should
// pass the configured global truncation threshold instead; this constant only
// keeps a sane default for direct API use. Tools with wider budgets (agent
// 32k, web-search 102k, MCP 500k) are resolved per-tool via
// `resolveToolBudgetChars`, and self-managed tools declare `Infinity`.
export const OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS = 30_000;

export interface ToolResultRetentionStats {
  /** Number of function-response (tool result) parts retained in history. */
  toolResultCount: number;
  /** Total characters retained across all tool results. */
  totalChars: number;
  /** Character size of the single largest retained tool result. */
  largestResultChars: number;
  /**
   * Tool results retained far above their producing tool's output budget:
   * not already truncated (no sentinel prefix) and measured above 2x budget.
   */
  oversizedResultCount: number;
  /** Fallback budget applied when a tool declares none. */
  oversizedThresholdChars: number;
}

export interface AnalyzeToolResultRetentionOptions {
  /**
   * Fallback budget for tools that declare no `maxOutputChars`. Production
   * callers pass the configured global truncation threshold — the bound the
   * scheduler actually applies to such results.
   */
  thresholdChars?: number;
  /**
   * Resolves the declared output budget of the tool that produced a result
   * (by its `functionResponse.name`), mirroring the scheduler's per-tool
   * limits. A result is oversized only if it exceeds its own tool's budget,
   * so compliant results from high-budget tools (e.g. MCP) are never flagged.
   *
   * Caveat: if the tool has been removed from the registry (e.g. an MCP
   * server disconnected mid-session), the resolver misses and the fallback
   * threshold applies, which may over-flag formerly high-budget results.
   */
  resolveToolBudgetChars?: (toolName: string) => number | undefined;
  /**
   * Image token estimate for billing nested media parts, mirroring the
   * compression pipeline's `resolveSlimmingConfig`. Defaults to
   * `DEFAULT_IMAGE_TOKEN_ESTIMATE`; production callers should pass the
   * resolved value so both diagnostics and compression agree about the
   * same history.
   */
  imageTokenEstimate?: number;
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

  const imageTokenEstimate =
    options.imageTokenEstimate ?? DEFAULT_IMAGE_TOKEN_ESTIMATE;

  const stats: ToolResultRetentionStats = {
    toolResultCount: 0,
    totalChars: 0,
    largestResultChars: 0,
    oversizedResultCount: 0,
    oversizedThresholdChars: Number.isFinite(thresholdChars)
      ? thresholdChars
      : 0,
  };

  for (const content of history) {
    for (const part of content.parts ?? []) {
      if (!part.functionResponse) {
        continue;
      }

      const chars = estimatePartChars(part, imageTokenEstimate);
      stats.toolResultCount += 1;
      stats.totalChars += chars;
      if (chars > stats.largestResultChars) {
        stats.largestResultChars = chars;
      }

      const budget =
        options.resolveToolBudgetChars?.(part.functionResponse.name ?? '') ??
        thresholdChars;
      // Results already carrying the truncation sentinel were bounded by a
      // layer; only un-truncated results can signal a bypass. The slack
      // accounts for the token-aware fallback that returns the original
      // (sentinel-less) when the wrapped form would not be smaller.
      const output =
        part.functionResponse.response?.['output'] ??
        part.functionResponse.response?.['error'];
      const alreadyTruncated =
        typeof output === 'string' &&
        (output.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX) ||
          output.startsWith('<persisted-output>'));
      // Compare raw string length — not estimatePartChars (which adds a
      // wrapper floor) — to mirror the scheduler's content.length bound.
      const rawChars = typeof output === 'string' ? output.length : 0;
      if (
        !alreadyTruncated &&
        Number.isFinite(budget) &&
        rawChars >
          budget * COMBINED_PASS_TOLERANCE_FACTOR +
            TRUNCATION_FALLBACK_ENVELOPE_SLACK
      ) {
        stats.oversizedResultCount += 1;
      }
    }
  }

  return stats;
}
