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
import type { StreamingToolCallParser } from './streamingToolCallParser.js';

export interface RequestContext {
  model: string;
  modalities: InputModalities;
  startTime: number;
  toolCallParser?: StreamingToolCallParser;
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
