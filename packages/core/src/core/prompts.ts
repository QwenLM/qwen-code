/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import * as snippets from '../prompts/snippets.js';

/**
 * Provides the system prompt for the history compression process.
 */
export function getCompressionPrompt(config: Config): string {
  return snippets.getCompressionPrompt(config.getApprovedPlanPath());
}

// --- Internal Helpers ---

export type CompactSummaryParseMode =
  | 'paired'
  | 'open_only'
  | 'close_only'
  | 'plain'
  | 'empty';

export type CompactSummaryParseResult =
  | { summary: string; mode: Exclude<CompactSummaryParseMode, 'empty'> }
  | { summary: null; mode: 'empty' };

/**
 * Compact formatter: remove only the first
 * case-sensitive paired analysis block, then format the first paired summary.
 * Validate text before formatting; even an empty formatted result is accepted.
 * Parse modes are metadata only and never impose a tag requirement.
 */
export function parseCompactSummary(raw: string): CompactSummaryParseResult {
  if (!raw.trim()) return { summary: null, mode: 'empty' };

  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const summaryBlock = /<summary>([\s\S]*?)<\/summary>/;
  const mode = summaryBlock.test(withoutAnalysis)
    ? 'paired'
    : withoutAnalysis.includes('<summary>')
      ? 'open_only'
      : withoutAnalysis.includes('</summary>')
        ? 'close_only'
        : 'plain';

  const summary = withoutAnalysis
    .replace(
      summaryBlock,
      (_match, content: string) => `Summary:\n${content.trim()}`,
    )
    .replace(/\n\n+/g, '\n\n')
    .trim();

  return { summary, mode };
}

/** Returns only the formatted summary for callers that do not need its mode. */
export function formatCompactSummary(raw: string): string | null {
  return parseCompactSummary(raw).summary;
}

export interface CompactSummaryMessageOptions {
  /**
   * Auto compact: suppress follow-up questions and resume
   * directly. Appends the "Continue the conversation from where it left off…"
   * block that is always included on auto-compact.
   */
  suppressFollowUpQuestions?: boolean;
  /**
   * Full transcript path the model can reference if it needs pre-compaction
   * details (exact code snippets, error messages, etc.).
   */
  transcriptPath?: string;
}

/**
 * Wraps a formatted compact summary with a human-readable preamble that
 * tells the model it is resuming a compacted conversation.
 *
 * Used by:
 *   - `buildPostCompactHistory()` in compact-utils.ts (fork-compact path)
 *     → passes `{ suppressFollowUpQuestions: true }`
 */
export function getCompactSummaryUserMessage(
  summary: string,
  options: CompactSummaryMessageOptions = {},
): string {
  const parts: string[] = [
    'This session is being continued from a previous conversation that ran out of context.',
    'The summary below covers the earlier portion of the conversation.',
    '',
    summary,
  ];

  if (options.transcriptPath) {
    parts.push(
      '',
      `If you need specific details from before compaction (like exact code snippets, error messages, ` +
        `or content you generated), read the full transcript at: ${options.transcriptPath}`,
    );
  }

  if (options.suppressFollowUpQuestions) {
    parts.push(
      '',
      'Continue the conversation from where it left off without asking the user any further questions.',
      'Resume directly — do not acknowledge the summary, do not recap what was happening, ' +
        'do not preface with "I\'ll continue" or similar.',
      'Pick up the last task as if the break never happened.',
    );
  }

  return parts.join('\n');
}
