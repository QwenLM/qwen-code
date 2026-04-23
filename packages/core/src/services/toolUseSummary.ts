/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool Use Summary Generator
 *
 * Generates a short human-readable label (git-commit-subject style, ~30 chars)
 * describing what a batch of tool calls accomplished. Uses the configured fast
 * model so the call is cheap; runs in parallel with the next turn's API call so
 * its ~1s latency is hidden behind the 5-30s main-model streaming.
 *
 * Ported from Claude Code (`services/toolUseSummary/toolUseSummaryGenerator.ts`).
 * The system prompt is verbatim; the input/output shape and truncation rules
 * are preserved for behavioral parity with the SDK `tool_use_summary` message.
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { getResponseText } from '../utils/partUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TOOL_USE_SUMMARY');

/**
 * Message emitted into the stream after a tool batch completes with a
 * successful summary. Mirrors Claude Code's `ToolUseSummaryMessage` so SDK
 * clients consuming either stream see a compatible shape.
 */
export interface ToolUseSummaryMessage {
  type: 'tool_use_summary';
  summary: string;
  /** Tool-use call IDs this summary describes. */
  precedingToolUseIds: string[];
  uuid: string;
  timestamp: string;
}

/**
 * Creates a `tool_use_summary` message. The UUID and timestamp are generated
 * here so the message is immediately serializable for recording/SDK emission.
 */
export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary',
    summary,
    precedingToolUseIds,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`;

/** Max characters per input/output field fed to the summarizer. */
const INPUT_TRUNCATE_LENGTH = 300;
/** Max characters of the last assistant text included as user-intent prefix. */
const LAST_ASSISTANT_TEXT_LENGTH = 200;
/** Output length cap. Matches mobile UI truncation behavior. */
const MAX_SUMMARY_LENGTH = 100;

export interface ToolInfo {
  name: string;
  input: unknown;
  output: unknown;
}

export interface GenerateToolUseSummaryParams {
  config: Config;
  tools: ToolInfo[];
  signal: AbortSignal;
  /**
   * Trailing text from the assistant's last message, used as intent prefix
   * so the summarizer knows what the user was trying to accomplish.
   */
  lastAssistantText?: string;
  /**
   * Fast model to use. If omitted, falls back to `config.getFastModel()`;
   * if that also returns undefined, the call is skipped (returns null).
   * Unlike `sessionRecap`, this does not fall back to the main model —
   * summary generation is a nice-to-have and must not incur main-model cost.
   */
  model?: string;
}

/**
 * Generates a short label for a completed tool batch.
 *
 * @returns The summary string, or null when skipped (no tools, no fast model,
 * aborted, or model failure). Non-critical: callers should not surface errors.
 */
export async function generateToolUseSummary(
  params: GenerateToolUseSummaryParams,
): Promise<string | null> {
  const { config, tools, signal, lastAssistantText } = params;

  if (tools.length === 0) {
    return null;
  }

  const model = params.model ?? config.getFastModel();
  if (!model) {
    debugLogger.debug('No fast model configured — skipping summary generation');
    return null;
  }

  if (signal.aborted) {
    return null;
  }

  try {
    const toolSummaries = tools
      .map((tool) => {
        const inputStr = truncateJson(tool.input, INPUT_TRUNCATE_LENGTH);
        const outputStr = truncateJson(tool.output, INPUT_TRUNCATE_LENGTH);
        return `Tool: ${tool.name}\nInput: ${inputStr}\nOutput: ${outputStr}`;
      })
      .join('\n\n');

    const contextPrefix = lastAssistantText
      ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, LAST_ASSISTANT_TEXT_LENGTH)}\n\n`
      : '';

    const userPrompt = `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`;

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      debugLogger.debug('No gemini client available — skipping');
      return null;
    }

    const response = await geminiClient.generateContent(
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      {
        systemInstruction: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
        tools: [],
        maxOutputTokens: 60,
        temperature: 0.3,
      },
      signal,
      model,
      'tool_use_summary_generation',
    );

    if (signal.aborted) return null;

    const raw = getResponseText(response)?.trim();
    if (!raw) {
      debugLogger.debug('Summary generation returned empty result');
      return null;
    }

    const cleaned = cleanSummary(raw);
    if (!cleaned) {
      debugLogger.debug(`Summary cleaned to empty: raw="${raw}"`);
      return null;
    }

    debugLogger.debug(`Summary generated: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    if (signal.aborted) return null;
    debugLogger.warn(
      `Summary generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Truncates a JSON value to a maximum length for the prompt. Mirrors
 * Claude Code's `truncateJson` behavior (including the `...` suffix).
 */
export function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = JSON.stringify(value);
    if (str == null) return '[undefined]';
    return str.length <= maxLength ? str : str.slice(0, maxLength - 3) + '...';
  } catch {
    return '[unable to serialize]';
  }
}

/**
 * Strips markdown, quotes, and common prefix noise from the model's raw
 * response. Enforces `MAX_SUMMARY_LENGTH` as a hard cap — the mobile UI
 * truncates around 30 chars, but we allow some slack so unusual-but-useful
 * labels (e.g. CJK phrases) survive. Returns empty string if the result is
 * unusable (error message, prefixed label, etc.).
 */
export function cleanSummary(raw: string): string {
  // Take first line only
  let text = raw.split('\n')[0]?.trim() ?? '';

  // Strip leading bullet/dash first — otherwise a bulleted quoted label like
  // `- "Searched auth/"` would keep its leading quote after the trailing one
  // is stripped.
  text = text.replace(/^[-*•]\s+/, '').trim();

  // Strip surrounding quotes/backticks. Bounded to {1,10} to keep the
  // regex engine linear on pathological model output (CodeQL rule
  // js/polynomial-redos) — real labels never have ten-plus opening quotes.
  text = text
    .replace(/^["'`]{1,10}/, '')
    .replace(/["'`]{1,10}$/, '')
    .trim();

  // Strip common prefix labels like "Label:" "Summary:"
  text = text.replace(/^(label|summary|result|output)\s*[:：]\s*/i, '').trim();

  if (!text) return '';

  // Reject error-message-like responses
  const lower = text.toLowerCase();
  if (
    lower.startsWith('api error') ||
    lower.startsWith('error:') ||
    lower.startsWith('i cannot') ||
    lower.startsWith("i can't") ||
    lower.startsWith('unable to')
  ) {
    return '';
  }

  // Hard cap length
  if (text.length > MAX_SUMMARY_LENGTH) {
    text = text.slice(0, MAX_SUMMARY_LENGTH).trim();
  }

  return text;
}
