/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Pipeline } from '../../../pipeline/pipeline.js';
import type { CustomInferenceGeminiApi } from '../../../api/inference/gemini/gemini.js';
import type { CustomInferenceStreamOptions } from '../../../api/inference/customInferenceStreamOptions.js';
import { streamInferenceSse } from '../inferenceSse.js';

export class CustomInferenceGeminiApiImpl implements CustomInferenceGeminiApi {
  constructor(protected readonly pipeline: Pipeline) {}

  stream(
    input: GenerateContentParameters,
    options: CustomInferenceStreamOptions = {},
  ): AsyncIterable<GenerateContentResponse> {
    const { model, contents, config } = input;
    // REST splits the SDK config: tools/systemInstruction/toolConfig are
    // top-level, the generation knobs (temperature, maxOutputTokens,
    // thinkingConfig, …) live under generationConfig.
    const {
      httpOptions: _httpOptions,
      abortSignal: _abortSignal,
      tools,
      toolConfig,
      systemInstruction,
      ...generationConfig
    } = config ?? {};
    const body: Record<string, unknown> = { contents };
    if (tools) body['tools'] = tools;
    if (toolConfig) body['toolConfig'] = toolConfig;
    if (systemInstruction) body['systemInstruction'] = systemInstruction;
    if (Object.keys(generationConfig).length > 0) {
      body['generationConfig'] = generationConfig;
    }
    return streamInferenceSse<GenerateContentResponse>(this.pipeline, {
      operation: 'inference.gemini.stream',
      path: `/models/${encodeURIComponent(stripModelsPrefix(model))}:streamGenerateContent?alt=sse`,
      body,
      signal: options.signal,
    });
  }
}

function stripModelsPrefix(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}
