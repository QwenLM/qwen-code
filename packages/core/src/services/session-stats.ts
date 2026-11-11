/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { runLogger } from '../utils/runLogger.js';
import type { Message } from '../protocol/transcript/message.js';
import type { SessionCreditsSnapshot } from './session-state-usage.js';

/**
 * How a tool call was resolved by the user. Kept for the session-stats views.
 */
export enum ToolCallDecision {
  ACCEPT = 'accept',
  REJECT = 'reject',
  MODIFY = 'modify',
  AUTO_ACCEPT = 'auto_accept',
}

/** Who issued an LLM request; only used to bucket local session stats. */
export enum LlmRole {
  MAIN = 'main',
  SUBAGENT = 'subagent',
  UTILITY_TOOL = 'utility_tool',
  UTILITY_COMPRESSOR = 'utility_compressor',
  UTILITY_SUMMARIZER = 'utility_summarizer',
  UTILITY_ROUTER = 'utility_router',
  UTILITY_LOOP_DETECTOR = 'utility_loop_detector',
  UTILITY_EDIT_CORRECTOR = 'utility_edit_corrector',
  UTILITY_AUTOCOMPLETE = 'utility_autocomplete',
  UTILITY_FAST_ACK_HELPER = 'utility_fast_ack_helper',
}

export type ModelRequestStatus = 'success' | 'error' | 'abort';

export interface ModelRequestTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
  credits?: number;
  originalCredits?: number;
  billable?: boolean;
}

export interface UiModelRequestResult {
  model: string;
  durationMs: number;
  status: ModelRequestStatus;
  usage?: ModelRequestTokenUsage;
}

export interface ToolCallStats {
  count: number;
  success: number;
  fail: number;
  durationMs: number;
  decisions: {
    [ToolCallDecision.ACCEPT]: number;
    [ToolCallDecision.REJECT]: number;
    [ToolCallDecision.MODIFY]: number;
    [ToolCallDecision.AUTO_ACCEPT]: number;
  };
}

export interface RoleMetrics {
  totalRequests: number;
  totalErrors: number;
  totalLatencyMs: number;
  tokens: {
    input: number;
    prompt: number;
    candidates: number;
    total: number;
    cached: number;
    thoughts: number;
    tool: number;
  };
}

export interface ModelMetrics {
  api: {
    totalRequests: number;
    totalErrors: number;
    totalLatencyMs: number;
  };
  tokens: {
    input: number;
    prompt: number;
    candidates: number;
    total: number;
    cached: number;
    thoughts: number;
    tool: number;
  };
  roles: Partial<Record<LlmRole, RoleMetrics>>;
}

export interface SessionMetrics {
  models: Record<string, ModelMetrics>;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    totalDurationMs: number;
    totalDecisions: {
      [ToolCallDecision.ACCEPT]: number;
      [ToolCallDecision.REJECT]: number;
      [ToolCallDecision.MODIFY]: number;
      [ToolCallDecision.AUTO_ACCEPT]: number;
    };
    byName: Record<string, ToolCallStats>;
  };
  files: {
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
}

const createInitialModelMetrics = (): ModelMetrics => ({
  api: {
    totalRequests: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
  },
  tokens: {
    input: 0,
    prompt: 0,
    candidates: 0,
    total: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
  },
  roles: {},
});

const createInitialMetrics = (): SessionMetrics => ({
  models: {},
  tools: {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    totalDurationMs: 0,
    totalDecisions: {
      [ToolCallDecision.ACCEPT]: 0,
      [ToolCallDecision.REJECT]: 0,
      [ToolCallDecision.MODIFY]: 0,
      [ToolCallDecision.AUTO_ACCEPT]: 0,
    },
    byName: {},
  },
  files: {
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  },
});

export class UiTelemetryService extends EventEmitter {
  #metrics: SessionMetrics = createInitialMetrics();
  #lastPromptTokenCount = 0;
  #sessionCreditsSessionId: string | undefined;
  #sessionCredits: SessionCreditsSnapshot = {
    observed: false,
    totalCredits: 0,
    byModel: {},
  };

  private emitUpdate(): void {
    const update = {
      metrics: this.#metrics,
      lastPromptTokenCount: this.#lastPromptTokenCount,
      sessionCreditsSessionId: this.#sessionCreditsSessionId,
      sessionCredits: this.getSessionCreditsSnapshot(),
    };
    for (const listener of this.rawListeners('update')) {
      try {
        listener.call(this, update);
      } catch (error) {
        this.logUpdateListenerFailure(error);
      }
    }
  }

  private logUpdateListenerFailure(error: unknown): void {
    try {
      runLogger.warn('[ui-telemetry] Update listener failed', error);
    } catch {
      // UI observers and diagnostic logging must not affect the agent loop.
    }
  }

  /**
   * Records terminal model-request stats for the interactive session UI.
   * Reported separately by the model-request caller.
   * Aborted requests contribute their elapsed time, but not errors or tokens.
   */
  recordModelRequest(result: UiModelRequestResult): void {
    const modelMetrics = this.getOrCreateModelMetrics(result.model);
    modelMetrics.api.totalRequests++;
    modelMetrics.api.totalLatencyMs += result.durationMs;

    if (result.status === 'error') {
      modelMetrics.api.totalErrors++;
    } else if (result.status === 'success' && result.usage) {
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const cachedTokens = result.usage.cacheReadTokens ?? 0;
      const thinkingTokens = result.usage.thinkingTokens ?? 0;

      modelMetrics.tokens.prompt += inputTokens;
      modelMetrics.tokens.candidates += outputTokens;
      modelMetrics.tokens.total +=
        result.usage.totalTokens ?? inputTokens + outputTokens + thinkingTokens;
      modelMetrics.tokens.cached += cachedTokens;
      modelMetrics.tokens.thoughts += thinkingTokens;
      modelMetrics.tokens.input = Math.max(
        0,
        modelMetrics.tokens.prompt - modelMetrics.tokens.cached,
      );
    }

    this.emitUpdate();
  }

  /**
   * Records a finished tool call for the interactive session UI.
   *
   * Fed by the streaming executor's terminal-call observer so tool counts,
   * durations, decisions and code deltas stay live within a session. Resumed
   * sessions rebuild the same fields from transcript messages instead.
   */
  recordToolCall(entry: {
    name: string;
    success: boolean;
    durationMs: number;
    decision?: ToolCallDecision;
    linesAdded?: number;
    linesRemoved?: number;
  }): void {
    const { tools, files } = this.#metrics;
    tools.totalCalls++;
    tools.totalDurationMs += entry.durationMs;
    if (entry.success) {
      tools.totalSuccess++;
    } else {
      tools.totalFail++;
    }

    let toolStats = tools.byName[entry.name];
    if (!toolStats) {
      toolStats = {
        count: 0,
        success: 0,
        fail: 0,
        durationMs: 0,
        decisions: {
          [ToolCallDecision.ACCEPT]: 0,
          [ToolCallDecision.REJECT]: 0,
          [ToolCallDecision.MODIFY]: 0,
          [ToolCallDecision.AUTO_ACCEPT]: 0,
        },
      };
      tools.byName[entry.name] = toolStats;
    }

    toolStats.count++;
    toolStats.durationMs += entry.durationMs;
    if (entry.success) {
      toolStats.success++;
    } else {
      toolStats.fail++;
    }

    if (entry.decision) {
      tools.totalDecisions[entry.decision]++;
      toolStats.decisions[entry.decision]++;
    }

    // Live calls only: hydrateFromMessages() rebuilds counts from the
    // transcript on resume and clears first, so the two never overlap.
    if (entry.linesAdded !== undefined) {
      files.totalLinesAdded += entry.linesAdded;
    }
    if (entry.linesRemoved !== undefined) {
      files.totalLinesRemoved += entry.linesRemoved;
    }

    this.emitUpdate();
  }

  getMetrics(): SessionMetrics {
    return this.#metrics;
  }

  getLastPromptTokenCount(): number {
    return this.#lastPromptTokenCount;
  }

  getSessionCreditsSnapshot(): SessionCreditsSnapshot {
    return {
      observed: this.#sessionCredits.observed,
      ...(this.#sessionCredits.historyIncomplete
        ? { historyIncomplete: true as const }
        : {}),
      totalCredits: this.#sessionCredits.totalCredits,
      byModel: Object.fromEntries(
        Object.entries(this.#sessionCredits.byModel).map(([model, usage]) => [
          model,
          { credits: usage.credits },
        ]),
      ),
    };
  }

  getSessionCreditsSessionId(): string | undefined {
    return this.#sessionCreditsSessionId;
  }

  setSessionCreditsSnapshot(
    sessionId: string,
    snapshot: SessionCreditsSnapshot,
  ): void {
    this.#sessionCreditsSessionId = sessionId;
    this.#sessionCredits = {
      observed: snapshot.observed,
      ...(snapshot.historyIncomplete
        ? { historyIncomplete: true as const }
        : {}),
      totalCredits: snapshot.totalCredits,
      byModel: Object.fromEntries(
        Object.entries(snapshot.byModel).map(([model, usage]) => [
          model,
          { credits: usage.credits },
        ]),
      ),
    };
    this.emitUpdate();
  }

  setLastPromptTokenCount(lastPromptTokenCount: number): void {
    this.#lastPromptTokenCount = lastPromptTokenCount;
    this.emitUpdate();
  }

  clear(newSessionId?: string): void {
    this.#metrics = createInitialMetrics();
    this.#lastPromptTokenCount = 0;
    if (!newSessionId || this.#sessionCreditsSessionId !== newSessionId) {
      this.#sessionCreditsSessionId = newSessionId;
      this.#sessionCredits = {
        observed: false,
        totalCredits: 0,
        byModel: {},
      };
    }
    this.emit('clear', newSessionId);
    this.emitUpdate();
  }

  hydrateFromMessages(sessionId: string, messages: readonly Message[]) {
    this.clear(sessionId);

    // Track the LAST assistant turn's tokens as the "current context window"
    // size, not the session-cumulative sum. Otherwise resume after several
    // turns (or after a /compact) would surface a much larger value than the
    // window actually holds, falsely tripping `atBlockingLimit`.
    let latestContextTokens = 0;
    const pendingToolNames = new Map<string, string>();

    for (const message of messages) {
      if (message.type === 'assistant') {
        const model = message.message.model || 'unknown';
        const modelMetrics = this.getOrCreateModelMetrics(model);
        const usage = message.message.usage;

        modelMetrics.api.totalRequests++;
        if (usage) {
          modelMetrics.tokens.prompt += usage.input_tokens;
          modelMetrics.tokens.candidates += usage.output_tokens;
          modelMetrics.tokens.total += usage.input_tokens + usage.output_tokens;
          modelMetrics.tokens.cached += usage.cache_read_input_tokens;
          modelMetrics.tokens.input = Math.max(
            0,
            modelMetrics.tokens.prompt - modelMetrics.tokens.cached,
          );
          latestContextTokens = usage.input_tokens;
        }

        for (const block of message.message.content) {
          if (block.type !== 'tool_use') {
            continue;
          }

          this.#metrics.tools.totalCalls++;
          pendingToolNames.set(block.id, block.name);

          if (!this.#metrics.tools.byName[block.name]) {
            this.#metrics.tools.byName[block.name] = {
              count: 0,
              success: 0,
              fail: 0,
              durationMs: 0,
              decisions: {
                [ToolCallDecision.ACCEPT]: 0,
                [ToolCallDecision.REJECT]: 0,
                [ToolCallDecision.MODIFY]: 0,
                [ToolCallDecision.AUTO_ACCEPT]: 0,
              },
            };
          }

          this.#metrics.tools.byName[block.name].count++;
        }
        continue;
      }

      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') {
            continue;
          }

          const toolName = pendingToolNames.get(block.tool_use_id) ?? 'unknown';
          const toolStats = this.#metrics.tools.byName[toolName];
          if (!toolStats) {
            continue;
          }

          if (block.is_error) {
            this.#metrics.tools.totalFail++;
            toolStats.fail++;
          } else {
            this.#metrics.tools.totalSuccess++;
            toolStats.success++;
          }

          pendingToolNames.delete(block.tool_use_id);
        }
      }
    }

    this.#lastPromptTokenCount = latestContextTokens;

    this.emitUpdate();
  }

  private getOrCreateModelMetrics(modelName: string): ModelMetrics {
    if (!Object.hasOwn(this.#metrics.models, modelName)) {
      Object.defineProperty(this.#metrics.models, modelName, {
        value: createInitialModelMetrics(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return this.#metrics.models[modelName];
  }

}

export const uiTelemetryService = new UiTelemetryService();
