/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGeneratorConfig,
  InputModalities,
} from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type { OpenAIResponseParsingOptions } from './responseParsingOptions.js';
import type { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { TaggedThinkingParser } from './taggedThinkingParser.js';

export interface StreamingTextDeltaState {
  emittedText: string;
  cumulativeMode: boolean;
}

export interface RequestContext {
  model: string;
  modalities: InputModalities;
  startTime: number;
  toolCallParser?: StreamingToolCallParser;
  responseParsingOptions?: OpenAIResponseParsingOptions;
  taggedThinkingParser?: TaggedThinkingParser;
  // When true, media parts in tool-result messages are split into a follow-up
  // user message for strict OpenAI-compat servers. See ContentGeneratorConfig
  // for details.
  splitToolMedia?: boolean;
  /**
   * Per-stream mutable state for cumulative-delta normalization on the visible
   * content channel. Initialised lazily on first use. Must NOT be shared or
   * reused across requests — stale state will silently corrupt text output.
   */
  textDeltaState?: StreamingTextDeltaState;
  /**
   * Same as textDeltaState but for the reasoning/thinking content channel.
   * The two channels are tracked independently so interleaved chunks on each
   * channel are deduplicated correctly.
   */
  reasoningDeltaState?: StreamingTextDeltaState;
}

export interface ErrorHandler {
  handle(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): never;
  shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean;
}

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
  errorHandler: ErrorHandler;
}
