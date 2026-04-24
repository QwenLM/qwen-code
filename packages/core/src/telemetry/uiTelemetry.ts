/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import {
  EVENT_API_ERROR,
  EVENT_API_RESPONSE,
  EVENT_TOOL_CALL,
} from './constants.js';

import { ToolCallDecision } from './tool-call-decision.js';
import type {
  ApiErrorEvent,
  ApiResponseEvent,
  ToolCallEvent,
} from './types.js';
import { MAIN_SOURCE } from '../utils/subagentNameContext.js';

export { MAIN_SOURCE } from '../utils/subagentNameContext.js';

export type UiEvent =
  | (ApiResponseEvent & { 'event.name': typeof EVENT_API_RESPONSE })
  | (ApiErrorEvent & { 'event.name': typeof EVENT_API_ERROR })
  | (ToolCallEvent & { 'event.name': typeof EVENT_TOOL_CALL });

export {
  EVENT_API_ERROR,
  EVENT_API_RESPONSE,
  EVENT_TOOL_CALL,
} from './constants.js';

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

/**
 * Per-model counters without the nested source breakdown. Used both as the
 * aggregate `ModelMetrics` shape (via extension) and as the value type of the
 * `bySource` map — keeping the type non-recursive.
 */
export interface ModelMetricsCore {
  api: {
    totalRequests: number;
    totalErrors: number;
    totalLatencyMs: number;
  };
  tokens: {
    prompt: number;
    candidates: number;
    total: number;
    cached: number;
    thoughts: number;
    tool: number;
  };
}

export interface ModelMetrics extends ModelMetricsCore {
  /**
   * Per-source breakdown. Keys are subagent names, or `MAIN_SOURCE` ("main")
   * for calls originating from the main conversation. Every API call that
   * increments an aggregate counter also increments the matching per-source
   * record so the two views stay consistent.
   */
  bySource: Record<string, ModelMetricsCore>;
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

const createInitialModelMetricsCore = (): ModelMetricsCore => ({
  api: {
    totalRequests: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
  },
  tokens: {
    prompt: 0,
    candidates: 0,
    total: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
  },
});

// `bySource` keys are user-controlled subagent names. Using a prototype-free
// map avoids crashes when a subagent is named after an inherited Object
// member (e.g. `constructor`, `toString`, `hasOwnProperty`), which would
// otherwise short-circuit `!bySource[name]` checks and return the inherited
// prototype member as the "bucket".
const createInitialModelMetrics = (): ModelMetrics => ({
  ...createInitialModelMetricsCore(),
  bySource: Object.create(null) as Record<string, ModelMetricsCore>,
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
  #lastCachedContentTokenCount = 0;

  addEvent(event: UiEvent) {
    switch (event['event.name']) {
      case EVENT_API_RESPONSE:
        this.processApiResponse(event);
        break;
      case EVENT_API_ERROR:
        this.processApiError(event);
        break;
      case EVENT_TOOL_CALL:
        this.processToolCall(event);
        break;
      default:
        // We should not emit update for any other event metric.
        return;
    }

    this.emit('update', {
      metrics: this.#metrics,
      lastPromptTokenCount: this.#lastPromptTokenCount,
    });
  }

  getMetrics(): SessionMetrics {
    return this.#metrics;
  }

  getLastPromptTokenCount(): number {
    return this.#lastPromptTokenCount;
  }

  setLastPromptTokenCount(lastPromptTokenCount: number): void {
    this.#lastPromptTokenCount = lastPromptTokenCount;
    this.emit('update', {
      metrics: this.#metrics,
      lastPromptTokenCount: this.#lastPromptTokenCount,
    });
  }

  getLastCachedContentTokenCount(): number {
    return this.#lastCachedContentTokenCount;
  }

  setLastCachedContentTokenCount(count: number): void {
    this.#lastCachedContentTokenCount = count;
  }

  /**
   * Resets metrics to the initial state (used when resuming a session).
   */
  reset(): void {
    this.#metrics = createInitialMetrics();
    this.#lastPromptTokenCount = 0;
    this.#lastCachedContentTokenCount = 0;
    this.emit('update', {
      metrics: this.#metrics,
      lastPromptTokenCount: this.#lastPromptTokenCount,
    });
  }

  private getOrCreateModelMetrics(modelName: string): ModelMetrics {
    if (!this.#metrics.models[modelName]) {
      this.#metrics.models[modelName] = createInitialModelMetrics();
    }
    return this.#metrics.models[modelName];
  }

  private getOrCreateSourceMetrics(
    modelMetrics: ModelMetrics,
    source: string,
  ): ModelMetricsCore {
    if (!modelMetrics.bySource[source]) {
      modelMetrics.bySource[source] = createInitialModelMetricsCore();
    }
    return modelMetrics.bySource[source];
  }

  private processApiResponse(event: ApiResponseEvent) {
    const modelMetrics = this.getOrCreateModelMetrics(event.model);
    const sourceMetrics = this.getOrCreateSourceMetrics(
      modelMetrics,
      event.subagent_name ?? MAIN_SOURCE,
    );

    for (const bucket of [modelMetrics, sourceMetrics]) {
      bucket.api.totalRequests++;
      bucket.api.totalLatencyMs += event.duration_ms;

      bucket.tokens.prompt += event.input_token_count;
      bucket.tokens.candidates += event.output_token_count;
      bucket.tokens.total += event.total_token_count;
      bucket.tokens.cached += event.cached_content_token_count;
      bucket.tokens.thoughts += event.thoughts_token_count;
      bucket.tokens.tool += event.tool_token_count;
    }
  }

  private processApiError(event: ApiErrorEvent) {
    const modelMetrics = this.getOrCreateModelMetrics(event.model);
    const sourceMetrics = this.getOrCreateSourceMetrics(
      modelMetrics,
      event.subagent_name ?? MAIN_SOURCE,
    );

    for (const bucket of [modelMetrics, sourceMetrics]) {
      bucket.api.totalRequests++;
      bucket.api.totalErrors++;
      bucket.api.totalLatencyMs += event.duration_ms;
    }
  }

  private processToolCall(event: ToolCallEvent) {
    const { tools, files } = this.#metrics;
    tools.totalCalls++;
    tools.totalDurationMs += event.duration_ms;

    if (event.success) {
      tools.totalSuccess++;
    } else {
      tools.totalFail++;
    }

    if (!tools.byName[event.function_name]) {
      tools.byName[event.function_name] = {
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

    const toolStats = tools.byName[event.function_name];
    toolStats.count++;
    toolStats.durationMs += event.duration_ms;
    if (event.success) {
      toolStats.success++;
    } else {
      toolStats.fail++;
    }

    if (event.decision) {
      tools.totalDecisions[event.decision]++;
      toolStats.decisions[event.decision]++;
    }

    // Aggregate line count data from metadata
    if (event.metadata) {
      if (event.metadata['model_added_lines'] !== undefined) {
        files.totalLinesAdded += event.metadata['model_added_lines'];
      }
      if (event.metadata['model_removed_lines'] !== undefined) {
        files.totalLinesRemoved += event.metadata['model_removed_lines'];
      }
    }
  }
}

export const uiTelemetryService = new UiTelemetryService();
