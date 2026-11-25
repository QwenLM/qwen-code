/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelRequestCompletedSnapshot,
  ModelRequestFinishedSnapshot,
} from '../model-request/types.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { Message } from '../protocol/transcript/message.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  emitForkAgentStarted,
  emitForkAgentCompleted,
} from '../utils/diagnosticInterceptors.js';
import {
  customContextContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import { runLogger } from '../utils/runLogger.js';
import type { QueryCollectorResult } from './query-result-collector.js';

export interface ForkedAgentCompletion {
  model: string;
  requestId?: string;
  modelRequestIds: string[];
  modelRequests: ModelRequestCompletedSnapshot[];
  modelRequestResults: ModelRequestFinishedSnapshot[];
  totalUsage: NonNullableUsage;
  durationMs: number;
  success: boolean;
}

export interface ForkedAgentResult {
  /** All runtime messages yielded during the fork's query loop. */
  messages: Message[];
  /** Accumulated token usage across all API calls in the loop. */
  totalUsage: NonNullableUsage;
  /** Concatenated text content from all assistant responses (convenience). */
  textContent: string;
}

export interface ForkExecution {
  execute: (request: ForkRequestContext) => Promise<QueryCollectorResult>;
  promptId: string;
  forkLabel: string;
  model: string;
  sessionScopeId?: string;
  customContext?: Readonly<Record<string, string>>;
  onCompleted?: (completion: ForkedAgentCompletion) => void;
  /** Include time spent seeding the sidechain transcript before execution. */
  startedAt?: number;
}

export interface ForkRequestContext {
  promptId: string;
  customContext?: Readonly<Record<string, string>>;
  onModelRequestCompleted: (request: ModelRequestCompletedSnapshot) => void;
  onModelRequestFinished: (result: ModelRequestFinishedSnapshot) => void;
}

/** Observe one fork invocation, including terminal errors and stream cancellation. */
export async function withForkAccounting(
  options: ForkExecution,
): Promise<ForkedAgentResult> {
  const { forkLabel, model, sessionScopeId, execute } = options;
  const startTime = options.startedAt ?? Date.now();
  const forkPromptId = `${options.promptId}-fork-${forkLabel}`;
  const modelRequests: ModelRequestCompletedSnapshot[] = [];
  const modelRequestResults: ModelRequestFinishedSnapshot[] = [];

  // Best-effort lifecycle event — never block the fork.
  try {
    emitForkAgentStarted({
      sessionScopeId,
      forkLabel,
      promptId: forkPromptId,
    });
  } catch {
    // diagnostic-only — swallow
  }

  let collected: QueryCollectorResult | undefined;
  let success = false;
  try {
    const customContext = snapshotCustomContext(options.customContext);
    const request: ForkRequestContext = {
      promptId: forkPromptId,
      customContext,
      onModelRequestCompleted: (snapshot) => {
        modelRequests.push(snapshot);
      },
      onModelRequestFinished: (snapshot) => {
        modelRequestResults.push(snapshot);
      },
    };
    collected = customContext
      ? await customContextContext.run(customContext, execute, request)
      : await execute(request);

    if (
      collected.terminal.reason === 'error' ||
      collected.terminal.reason === 'abort'
    ) {
      const terminalError =
        collected.terminal.error ??
        new Error(
          collected.terminal.reason === 'abort'
            ? 'Forked agent was aborted'
            : 'Forked agent failed',
        );
      if (
        collected.terminal.reason === 'abort' &&
        terminalError.name === 'Error'
      ) {
        terminalError.name = 'AbortError';
      }
      throw terminalError;
    }

    const { messages, totalUsage, textContent } = collected;
    runLogger.debug(
      `Forked agent [${forkLabel}] finished: ${messages.length} msgs, ` +
        `usage: in=${collected.terminal.usage.input_tokens} out=${collected.terminal.usage.output_tokens}, ` +
        `duration=${Date.now() - startTime}ms`,
    );

    success = true;
    return { messages, totalUsage, textContent };
  } finally {
    const messages = collected?.messages ?? [];
    const totalUsage = collected?.totalUsage ?? cloneUsage();
    let requestId = collected?.terminal.requestId;
    if (!requestId) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'assistant') {
          requestId = msg.message.usage?.request_id;
          break;
        }
      }
    }
    const durationMs = Date.now() - startTime;
    const modelRequestIds = Array.from(
      new Set([
        ...modelRequests.map((completion) => completion.requestId),
        ...modelRequestResults.map((result) => result.requestId),
        ...messages
          .filter((message) => message.type === 'assistant')
          .map((message) => message.message.usage?.request_id)
          .filter((value): value is string => Boolean(value)),
      ]),
    );
    if (requestId && !modelRequestIds.includes(requestId)) {
      modelRequestIds.push(requestId);
    }

    // Best-effort diagnostic lifecycle event — never block the fork.
    try {
      emitForkAgentCompleted({
        sessionScopeId,
        forkLabel,
        promptId: forkPromptId,
        requestId,
        durationMs,
        inputTokens: totalUsage.input_tokens,
        outputTokens: totalUsage.output_tokens,
        cacheReadInputTokens: totalUsage.cache_read_input_tokens,
        cacheCreationInputTokens: totalUsage.cache_creation_input_tokens,
        success,
      });
    } catch {
      // diagnostic-only — swallow
    }

    // Domain owners use the completion to enrich their existing events.
    try {
      options.onCompleted?.({
        model,
        requestId,
        modelRequestIds,
        modelRequests,
        modelRequestResults,
        totalUsage,
        durationMs,
        success,
      });
    } catch {
      // observer-only — swallow
    }
  }
}
