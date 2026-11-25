/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Context window analysis — breaks down conversation history
 * token usage by category (tool calls, tool results, user/assistant messages,
 * etc.) using heuristic estimation.
 *
 * Token estimates reuse the provider-request text and content-block rules.
 * Categories describe the local content; the collector reconciles their sum
 * with the measured or estimated complete request.
 *
 * system messages (local_command_output / local_command) are tracked for
 * display purposes but are NOT added to `total` — they are UI-only annotations
 * that are never sent to the model and must not inflate the API-usage estimate.
 */

import {
  READ_FILE_TOOL_NAME,
  SKILL_TOOL_NAME,
  estimateTextTokens,
  estimateRequestBlockTokens,
  normalizeMessagesForAPI,
  type Message,
  type ModelStreamMessage,
} from '@qwen-code/core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DuplicateReadInfo {
  /** Total number of times this file was read */
  count: number;
  /**
   * Estimated "wasted" tokens: avg_tokens_per_read × (count - 1).
   * The first read is considered necessary; subsequent reads are waste.
   */
  tokens: number;
}

export interface TokenStats {
  /** tool_use blocks: toolName → tokens */
  toolRequests: Map<string, number>;
  /** tool_result blocks: toolName → tokens */
  toolResults: Map<string, number>;
  /** Plain user text (non-tool-result) tokens */
  humanMessages: number;
  /** Assistant text (non-tool-use) tokens */
  assistantMessages: number;
  /** thinking / redacted_thinking block tokens */
  thinkingTokens: number;
  /**
   * Local command output (system messages with subtype local_command_output).
   * Tracked for the breakdown display only — NOT included in `total` because
   * these messages are UI-only annotations that are never sent to the model.
   */
  localCommandOutputs: number;
  /** Everything else (images, unknown block types, …) */
  other: number;

  /** attachmentType → estimated token count for all attachment messages of that type */
  attachments: Map<string, number>;

  /**
   * Skill name → tokens actually injected into the conversation via the
   * Skill tool (tool_result blocks for SKILL_TOOL_NAME calls).
   * Skills that were never invoked will not appear in this map (0 tokens).
   */
  skillTokens: Map<string, number>;

  /** file_path → duplicate-read stats (only entries with count > 1) */
  duplicateFileReads: Map<string, DuplicateReadInfo>;

  /**
   * Sum of all estimated tokens across all categories that are actually sent
   * to the model (humanMessages + assistantMessages + thinkingTokens +
   * toolRequests + toolResults + attachments + other).
   *
   * localCommandOutputs is intentionally excluded — those messages never reach
   * the model and must not inflate the estimated context usage.
   */
  total: number;
}

export function getModelMessageTokens(stats: TokenStats): number {
  const attachmentTokens = [...stats.attachments.values()].reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
  return (
    stats.humanMessages +
    stats.assistantMessages +
    stats.thinkingTokens +
    attachmentTokens
  );
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

/** Round the shared text heuristic for category display. */
export function estimateString(s: string): number {
  return Math.round(estimateTextTokens(s));
}

function estimateContent(content: ModelStreamMessage['content']): number {
  return typeof content === 'string'
    ? estimateString(content)
    : content.reduce(
        (total, block) => total + Math.round(estimateRequestBlockTokens(block)),
        0,
      );
}

/**
 * Rough token estimate for an arbitrary value by JSON-serialising it and using
 * the same context-specific text estimator. Intended for opaque blobs (tool
 * schemas, attachment objects) where per-field extraction is not practical.
 */
export function roughEstimate(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return s ? estimateString(s) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function increment(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

/**
 * Analyse a conversation history and return per-category token estimates.
 *
 * @param messages 会话历史；模型分类只读取标准请求消息，宿主注释单独统计。
 */
export function analyzeContext(messages: readonly Message[]): TokenStats {
  const stats: TokenStats = {
    toolRequests: new Map(),
    toolResults: new Map(),
    humanMessages: 0,
    assistantMessages: 0,
    thinkingTokens: 0,
    localCommandOutputs: 0,
    other: 0,
    attachments: new Map(),
    skillTokens: new Map(),
    duplicateFileReads: new Map(),
    total: 0,
  };

  // Maps tool_use.id → tool name (populated while scanning assistant messages)
  const toolIds = new Map<string, string>();
  // Maps tool_use.id → file_path for read_file tool calls
  const readToolPaths = new Map<string, string>();
  // Maps tool_use.id → skill name for Skill tool calls
  const skillToolNames = new Map<string, string>();
  // Cumulative read stats: file_path → { count, totalTokens }
  const fileReadStats = new Map<
    string,
    { count: number; totalTokens: number }
  >();

  for (const message of messages) {
    if (message.type === 'attachment') {
      const tokens = normalizeMessagesForAPI([message]).reduce(
        (total, projected) => total + estimateContent(projected.content),
        0,
      );
      increment(stats.attachments, message.attachment.type, tokens);
      stats.total += tokens;
    } else if (
      message.type === 'system' &&
      (message.subtype === 'local_command_output' ||
        message.subtype === 'local_command')
    ) {
      stats.localCommandOutputs += estimateString(message.content);
    }
  }

  const modelMessages = normalizeMessagesForAPI(
    messages.filter((message) => message.type !== 'attachment'),
  );
  for (const message of modelMessages) {
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        const tokens = estimateString(message.content);
        stats.assistantMessages += tokens;
        stats.total += tokens;
      } else {
        for (const block of message.content) {
          const tokens = Math.round(estimateRequestBlockTokens(block));
          stats.total += tokens;
          if (block.type === 'text') stats.assistantMessages += tokens;
          else stats.thinkingTokens += tokens;
        }
      }
      for (const call of message.toolCalls ?? []) {
        const tokens = estimateString(call.id) + estimateString(call.name) +
          estimateString(call.arguments);
        stats.assistantMessages += tokens;
        stats.total += tokens;
        increment(stats.toolRequests, call.name, tokens);
        toolIds.set(call.id, call.name);
        try {
          const input: unknown = JSON.parse(call.arguments);
          if (input !== null && typeof input === 'object') {
            if (call.name === READ_FILE_TOOL_NAME && 'file_path' in input &&
                typeof input.file_path === 'string') {
              readToolPaths.set(call.id, input.file_path);
            } else if (call.name === SKILL_TOOL_NAME && 'skill' in input &&
                       typeof input.skill === 'string') {
              skillToolNames.set(call.id, input.skill);
            }
          }
        } catch {
          // 未完成的 JSON 仍计入请求量，但没有可用的文件或技能归属。
        }
      }
    } else if (message.role === 'tool') {
      const tokens = estimateContent(message.content);
      const toolName = toolIds.get(message.toolCallId) ?? 'unknown';
      stats.humanMessages += tokens;
      stats.total += tokens;
      increment(stats.toolResults, toolName, tokens);
      const filePath = readToolPaths.get(message.toolCallId);
      if (toolName === READ_FILE_TOOL_NAME && filePath) {
        const existing = fileReadStats.get(filePath) ?? { count: 0, totalTokens: 0 };
        fileReadStats.set(filePath, {
          count: existing.count + 1,
          totalTokens: existing.totalTokens + tokens,
        });
      } else if (toolName === SKILL_TOOL_NAME) {
        const skillName = skillToolNames.get(message.toolCallId);
        if (skillName) increment(stats.skillTokens, skillName, tokens);
      }
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') {
        const tokens = estimateString(message.content);
        stats.humanMessages += tokens;
        stats.total += tokens;
      } else {
        for (const block of message.content) {
          const tokens = Math.round(estimateRequestBlockTokens(block));
          stats.total += tokens;
          if (block.type === 'text') stats.humanMessages += tokens;
          else stats.other += tokens;
        }
      }
    }
  }

  // Compute duplicate-read waste: first read is necessary, rest are waste
  fileReadStats.forEach((data, filePath) => {
    if (data.count > 1) {
      const avgTokensPerRead = Math.floor(data.totalTokens / data.count);
      stats.duplicateFileReads.set(filePath, {
        count: data.count,
        tokens: avgTokensPerRead * (data.count - 1),
      });
    }
  });

  return stats;
}
