/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/**
 * Side question execution — lightweight, transient fork for /btw.
 *
 * Runs a single-turn query() that replays the parent's cache-safe request
 * snapshot (model, system prompt, projected history, and tool schemas), but
 * produces no durable artifacts (no transcript or compression).
 * Without a snapshot, its own selection still applies the session model policy.
 *
 * Tool execution is denied via the executionDisabled flag, while schemas come from
 * wrapWithParentToolSchemas() — the model sees the parent's exact
 * tool definitions for cache-identical API prefixes, but any
 * tool_use attempts are rejected.
 */

import { randomUUID } from 'node:crypto';
import { query } from './agent-loop.js';
import { collectQueryResults } from './query-result-collector.js';
import { wrapWithParentToolSchemas } from '../agents/fork-subagent.js';
import type { Message } from '../protocol/transcript/message.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { QueryEvent } from './query-event.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import type { CacheSafeQuerySnapshot } from './cache-safe-query-snapshot.js';
import {
  createAssistantMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { normalizeMessagesForAPI } from '../protocol/provider/request-converter.js';
import type { SystemPrompt } from '../prompts/types.js';
import { completeForkContextMessages } from '../utils/forkContextUtils.js';
import { getCustomContextFromContext } from '../utils/sessionIdContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SideQuestionParams {
  config: Config;
  /** The user's side question text. */
  question: string;
  /**
   * Parent request fields captured as one cache-safe unit. When present these
   * take precedence over the compatibility fields below so a side question
   * cannot mix a rendered prompt or tool list from a different parent request.
   */
  cacheSafeQuerySnapshot?: CacheSafeQuerySnapshot;
  /** Parent's exact system prompt content (for cache-identical prefix). */
  systemPrompt?: SystemPrompt;
  /** Parent's exact tool schemas (for cache-identical prefix). */
  parentToolSchemas?: readonly ModelStreamTool[];
  /** Root session ID for request continuity. */
  sessionId: string;
  /** Parent conversation history (runtime Message[]). */
  messages?: readonly Message[];
  /** Previous side-question exchanges appended after the main conversation. */
  history?: readonly SideQuestionHistoryEntry[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional callback invoked for each QueryEvent (for streaming UI). */
  onEvent?: (event: QueryEvent) => void;
  /** Opaque per-turn identity supplied by the request that asked the question. */
  customContext?: Readonly<Record<string, string>>;
}

export interface SideQuestionResult {
  /** The assistant's text response. */
  textContent: string;
  /** Token usage for the side question call. */
  totalUsage: NonNullableUsage;
  /** True when the response was generated locally after a model failure. */
  synthetic: boolean;
}

export interface SideQuestionHistoryEntry {
  question: string;
  response: string;
  fallback_notice?: string;
}

const SIDE_QUESTION_FAILURE_RESPONSE =
  'The side question could not be answered because the model request failed.';

export const SIDE_QUESTION_SYSTEM_REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

// ---------------------------------------------------------------------------
// runSideQuestion
// ---------------------------------------------------------------------------

/**
 * Runs a transient side question against the LLM.
 *
 * Architecture:
 * - Replays `CacheSafeQuerySnapshot` through `preProjectedMessages` when one is
 *   available; compatibility callers without a snapshot still use `messages[]`
 * - `wrapWithParentToolSchemas()` advertises parent tool schemas without
 *   enabling the parent schema advertisement only
 * - maxTurns = 1: single generation, no tool loop
 * - Reuses the snapshot's resolved model, reasoning, generation, and context
 *   settings as one unit; without a snapshot, select reads the session model
 *   and preferences, then applies the utility SDK policy
 * - No compressionPipeline or hookCoordinator
 */
export async function runSideQuestion(
  params: SideQuestionParams,
): Promise<SideQuestionResult> {
  const {
    question,
    cacheSafeQuerySnapshot,
    systemPrompt,
    parentToolSchemas,
    sessionId,
    messages,
    history,
    signal,
    onEvent,
    customContext,
  } = params;

  // 历史没有保存原模型；补入当前会话模型名，不为历史标记提前选模。
  const historyModel =
    cacheSafeQuerySnapshot?.model ?? params.config.getModel();
  const effectiveSystemPrompt =
    cacheSafeQuerySnapshot?.systemPrompt ?? systemPrompt;
  const effectiveToolSchemas =
    cacheSafeQuerySnapshot?.toolSchemas ?? parentToolSchemas;

  // Wrap the question with constraints — no tools, answer from context only
  const wrappedPrompt = `${SIDE_QUESTION_SYSTEM_REMINDER}

${question}`;

  // Build a cache-aligned schema registry:
  // - Advertises parent's exact tool schemas for byte-identical API prefix
  // - `executionDisabled` rejects any tool call the model still emits
  const toolRegistry = wrapWithParentToolSchemas(
    effectiveToolSchemas,
    params.config,
  );

  const workdirs = params.config.getWorkspaceContext().getDirectories();
  const parentSelection = cacheSafeQuerySnapshot?.modelResolution;
  const snapshotContext = cacheSafeQuerySnapshot
    ? [
        ...completeForkContextMessages(
          cacheSafeQuerySnapshot.forkContextMessages,
        ),
        ...normalizeMessagesForAPI(
          appendSideQuestionHistory(undefined, history, historyModel),
        ),
      ]
    : undefined;
  const generator = query({
    turnHookFactories: params.config.turnHookFactories,
    config: params.config,
    ...(workdirs.length > 0 ? { workdirs } : {}),
    parentSelection,
    prompt: wrappedPrompt,
    promptId: `side-question-${randomUUID()}`,
    modelPurpose: 'side_question',
    querySource: 'side_question',
    systemPrompt: effectiveSystemPrompt,
    messages: cacheSafeQuerySnapshot
      ? undefined
      : appendSideQuestionHistory(messages, history, historyModel),
    preProjectedMessages: snapshotContext,
    maxTurns: 1,
    signal,
    customContext: customContext ?? getCustomContextFromContext(),
    toolRegistry, // parent schemas for cache alignment
    toolExecutor: params.config.getToolExecutor(),
    executionDisabled: true,
    toolChoice: 'none', // API-level constraint: model cannot emit tool_use blocks
    skipCacheWrite: true,
    sessionId,
  });

  const collected = await collectQueryResults(generator, onEvent);

  if (collected.terminal.reason === 'abort') {
    throw (
      collected.terminal.error ??
      new DOMException('Side question cancelled', 'AbortError')
    );
  }

  const extracted = extractSideQuestionResponse(collected.messages);
  const requestFailed = collected.terminal.reason === 'error';

  let textContent = extracted.textContent;
  if (!textContent && requestFailed) {
    const errorMessage = collected.terminal.error?.message?.trim();
    textContent = errorMessage
      ? formatApiError(errorMessage)
      : SIDE_QUESTION_FAILURE_RESPONSE;
  }

  return {
    textContent,
    totalUsage: collected.totalUsage,
    synthetic: extracted.synthetic || requestFailed,
  };
}

function formatApiError(message: string): string {
  return `(API error: ${message})`;
}

function appendSideQuestionHistory(
  messages: readonly Message[] | undefined,
  history: readonly SideQuestionHistoryEntry[] | undefined,
  model: string,
): Message[] {
  const result = [...(messages ?? [])];
  for (const entry of history ?? []) {
    result.push(createUserMessage(entry.question));
    const response = entry.fallback_notice
      ? `${entry.response}\n\n${entry.fallback_notice}`
      : entry.response;
    result.push(
      createAssistantMessage({
        messageId: randomUUID(),

        blocks: [{ type: 'text', text: response }],

        model,
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the text response from the side question's messages.
 *
 * Handles:
 * - Normal text blocks from assistant messages, joined by blank lines
 * - API failures, which arrive as synthetic assistant messages flagged
 *   `isApiErrorMessage`; their text is shown alone as `(API error: …)` so a
 *   partial answer is never glued to the error
 * - Detects tool_use blocks (model attempted a tool call despite being denied)
 *   and returns a user-friendly message explaining the limitation
 * - Skips thinking blocks (model may still emit them)
 * - Falls back to empty string if no text content found
 */
function extractSideQuestionResponse(messages: Message[]): {
  textContent: string;
  synthetic: boolean;
} {
  const textParts: string[] = [];
  let toolUseName: string | null = null;
  let apiErrorText: string | null = null;

  for (const message of messages) {
    if (message.type !== 'assistant') continue;

    const content = message.message.content;
    if (!Array.isArray(content)) continue;

    const messageText: string[] = [];
    for (const block of content) {
      if (block == null) continue;
      if (block.type === 'text' && 'text' in block) {
        messageText.push((block as { type: 'text'; text: string }).text);
      } else if (block.type === 'tool_use' && 'name' in block && !toolUseName) {
        toolUseName = (block as { type: 'tool_use'; name: string }).name;
      }
    }

    if (message.isApiErrorMessage === true) {
      apiErrorText = messageText.join('\n\n').trim();
      continue;
    }
    textParts.push(...messageText);
  }

  if (apiErrorText !== null) {
    return {
      textContent: apiErrorText
        ? formatApiError(apiErrorText)
        : SIDE_QUESTION_FAILURE_RESPONSE,
      synthetic: true,
    };
  }

  const text = textParts.join('\n\n').trim();

  // If the model produced text content, return it (text takes priority)
  if (text) return { textContent: text, synthetic: false };

  // If no text but a tool_use was attempted, inform the user clearly
  if (toolUseName) {
    return {
      textContent: `(The model tried to call ${toolUseName} instead of answering directly. Try rephrasing or ask in the main conversation.)`,
      synthetic: true,
    };
  }

  return { textContent: '', synthetic: false };
}
