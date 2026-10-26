/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  FunctionCall,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { FinishReason } from './genai-compat.js';
import {
  StreamEventType,
  type ModelFallbackInfo,
  type StreamEvent,
} from './llm-chat.js';

export interface ModelStreamTextPart {
  text: string;
  thought: boolean;
}

export interface ModelStreamAttemptSnapshot {
  text: string;
  thoughtText: string;
  functionCalls: FunctionCall[];
  usageMetadata?: GenerateContentResponseUsageMetadata;
  responseId?: string;
  finishReason?: FinishReason;
  wasOutputTruncated: boolean;
}

export type ModelStreamAttemptTransition =
  | {
      type: 'chunk';
      response: GenerateContentResponse;
      textParts: ModelStreamTextPart[];
      functionCalls: FunctionCall[];
      finishReason?: FinishReason;
    }
  | {
      type: 'attempt_reset';
      reason: 'retry';
      preserveText: boolean;
      retryInfo: Extract<StreamEvent, { type: StreamEventType.RETRY }>;
    }
  | {
      type: 'attempt_reset';
      reason: 'model_fallback';
      preserveText: false;
      info: ModelFallbackInfo;
    }
  | {
      type: 'compressed';
      info: Extract<StreamEvent, { type: StreamEventType.COMPRESSED }>['info'];
    };

export class ModelStreamAttemptState {
  private text = '';
  private thoughtText = '';
  private functionCalls: FunctionCall[] = [];
  private usageMetadata?: GenerateContentResponseUsageMetadata;
  private responseId?: string;
  private finishReason?: FinishReason;
  private wasOutputTruncated = false;

  accept(event: StreamEvent): ModelStreamAttemptTransition {
    switch (event.type) {
      case StreamEventType.CHUNK:
        return this.acceptChunk(event.value);
      case StreamEventType.RETRY: {
        const preserveText = event.isContinuation === true;
        this.reset(preserveText);
        return {
          type: 'attempt_reset',
          reason: 'retry',
          preserveText,
          retryInfo: event,
        };
      }
      case StreamEventType.MODEL_FALLBACK:
        this.reset(false);
        return {
          type: 'attempt_reset',
          reason: 'model_fallback',
          preserveText: false,
          info: event.info,
        };
      case StreamEventType.COMPRESSED:
        return { type: 'compressed', info: event.info };
      default:
        throw new Error('Unsupported model stream event');
    }
  }

  snapshot(): ModelStreamAttemptSnapshot {
    return {
      text: this.text,
      thoughtText: this.thoughtText,
      functionCalls: [...this.functionCalls],
      ...(this.usageMetadata ? { usageMetadata: this.usageMetadata } : {}),
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      wasOutputTruncated: this.wasOutputTruncated,
    };
  }

  private acceptChunk(
    response: GenerateContentResponse,
  ): ModelStreamAttemptTransition {
    const textParts = (response.candidates?.[0]?.content?.parts ?? [])
      .filter(
        (part): part is typeof part & { text: string } =>
          typeof part.text === 'string' && part.text.length > 0,
      )
      .map((part) => ({
        text: part.text,
        thought: part.thought === true,
      }));
    for (const part of textParts) {
      if (part.thought) {
        this.thoughtText += part.text;
      } else {
        this.text += part.text;
      }
    }

    const functionCalls = response.functionCalls ?? [];
    this.functionCalls.push(...functionCalls);
    if (response.usageMetadata) {
      this.usageMetadata = response.usageMetadata;
    }
    if (response.responseId) {
      this.responseId = response.responseId;
    }
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason) {
      this.finishReason = finishReason;
      if (finishReason === FinishReason.MAX_TOKENS) {
        this.wasOutputTruncated = true;
      }
    }

    return {
      type: 'chunk',
      response,
      textParts,
      functionCalls,
      ...(finishReason ? { finishReason } : {}),
    };
  }

  private reset(preserveText: boolean): void {
    if (!preserveText) {
      this.text = '';
      this.thoughtText = '';
    }
    this.functionCalls = [];
    this.usageMetadata = undefined;
    this.responseId = undefined;
    this.finishReason = undefined;
    this.wasOutputTruncated = false;
  }
}
