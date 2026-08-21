/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { setToolCallPreparations } from '../tool-call-preparation.js';
import { dashScopeErrorFromFrame } from './errors.js';
import {
  convertToolCallToFunctionCallPart,
  mapDashScopeFinishReason,
} from './response-converter.js';
import { buildDashScopeUsageMetadata } from './usage.js';
import type { DashScopeSseFrame } from './sse.js';
import type { DashScopeResponsePayload, DashScopeUsage } from './types.js';

const debugLogger = createDebugLogger('DASHSCOPE');

interface ToolSlot {
  id?: string;
  name?: string;
  args: string;
  prepared: boolean;
}

interface BuildChunkOptions {
  finishReason?: FinishReason;
  usageMetadata?: GenerateContentResponse['usageMetadata'];
  responseId?: string;
  modelVersion?: string;
}

function buildChunk(
  parts: Part[],
  options: BuildChunkOptions = {},
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: { role: 'model', parts },
      index: 0,
      ...(options.finishReason !== undefined
        ? { finishReason: options.finishReason }
        : {}),
    },
  ];
  if (options.usageMetadata !== undefined) {
    response.usageMetadata = options.usageMetadata;
  }
  if (options.responseId !== undefined) {
    response.responseId = options.responseId;
  }
  if (options.modelVersion !== undefined) {
    response.modelVersion = options.modelVersion;
  }
  return response;
}

/**
 * Pure streaming state machine that turns DashScope SSE frames into
 * incremental Gemini `GenerateContentResponse` chunks.
 *
 * Every rule below is live-verified against a captured 20-frame parallel
 * tool-call stream (api-contract.md §4):
 * - Tool-call continuation frames carry `id: ""` (empty string, not
 *   omitted); latching must check truthiness, never `!== undefined`, or a
 *   continuation frame would clobber the real id captured on the open
 *   frame.
 * - `usage` rides every frame and is cumulative; only the LAST frame's
 *   usage is meaningful, and it is attached ONLY to the terminal chunk.
 */
export class DashScopeStreamAccumulator {
  private readonly model: string;
  private readonly toolSlots = new Map<number, ToolSlot>();
  private lastUsage: DashScopeUsage | undefined;
  private sawTerminal = false;
  private emittedToolCallsFlag = false;

  constructor(model: string) {
    this.model = model;
  }

  push(frame: DashScopeSseFrame): GenerateContentResponse[] {
    const err = dashScopeErrorFromFrame(frame);
    if (err) {
      throw err;
    }

    let payload: DashScopeResponsePayload;
    try {
      payload = JSON.parse(frame.data) as DashScopeResponsePayload;
    } catch {
      debugLogger.warn('Failed to parse DashScope SSE frame data', {
        data: frame.data,
      });
      return [];
    }

    const choice = payload.output?.choices?.[0];
    if (payload.usage) {
      this.lastUsage = payload.usage;
    }
    if (!choice) {
      return [];
    }

    const parts: Part[] = [];
    const message = choice.message;

    if (message?.reasoning_content) {
      parts.push({ text: message.reasoning_content, thought: true });
    }

    if (typeof message?.content === 'string') {
      if (message.content) {
        parts.push({ text: message.content });
      }
    } else if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block.text) {
          parts.push({ text: block.text });
        }
      }
    }

    const preparations: Array<{ callId: string; toolName: string }> = [];
    for (const call of message?.tool_calls ?? []) {
      const index = call.index ?? 0;
      let slot = this.toolSlots.get(index);
      if (!slot) {
        slot = { args: '', prepared: false };
        this.toolSlots.set(index, slot);
      }
      if (call.id) {
        slot.id = call.id;
      }
      if (call.function?.name) {
        slot.name = call.function.name;
      }
      slot.args += call.function?.arguments ?? '';

      if (slot.id && slot.name && !slot.prepared) {
        slot.prepared = true;
        preparations.push({ callId: slot.id, toolName: slot.name });
      }
    }

    const fr = mapDashScopeFinishReason(choice.finish_reason);
    if (fr === undefined) {
      if (parts.length === 0 && preparations.length === 0) {
        return [];
      }
      const chunk = buildChunk(parts);
      if (preparations.length > 0) {
        setToolCallPreparations(chunk, preparations);
      }
      return [chunk];
    }

    this.sawTerminal = true;
    if (fr !== FinishReason.MAX_TOKENS) {
      for (const index of [...this.toolSlots.keys()].sort((a, b) => a - b)) {
        const slot = this.toolSlots.get(index);
        if (!slot) {
          continue;
        }
        this.emittedToolCallsFlag = true;
        parts.push(
          convertToolCallToFunctionCallPart({
            id: slot.id ?? '',
            type: 'function',
            function: { name: slot.name, arguments: slot.args },
          }),
        );
      }
    }

    const finalChunk = buildChunk(parts, {
      finishReason: fr,
      usageMetadata: buildDashScopeUsageMetadata(this.lastUsage),
      responseId: payload.request_id,
      modelVersion: this.model,
    });
    if (fr !== FinishReason.MAX_TOKENS && preparations.length > 0) {
      setToolCallPreparations(finalChunk, preparations);
    }
    return [finalChunk];
  }

  finish(): { truncated: boolean; emittedToolCalls: boolean } {
    return {
      truncated: !this.sawTerminal,
      emittedToolCalls: this.emittedToolCallsFlag,
    };
  }
}
