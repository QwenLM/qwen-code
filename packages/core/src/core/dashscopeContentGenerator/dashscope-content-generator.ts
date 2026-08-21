/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { createChildAbortController } from '../../utils/abortController.js';
import { RequestTokenEstimator } from '../../utils/request-tokenizer/index.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  reportDashScopeRequest,
  reportGeminiChunk,
  reportGeminiResponse,
} from '../../telemetry/gen-ai-request.js';
import { buildDashScopeRequest } from './request-converter.js';
import { convertDashScopeResponseToGemini } from './response-converter.js';
import { DashScopeStreamAccumulator } from './stream-accumulator.js';
import { DashScopeStreamTruncatedError } from './errors.js';
import type { DashScopeSseFrame } from './sse.js';
import {
  FetchDashScopeTransport,
  type DashScopeTransport,
} from './transport.js';

const debugLogger = createDebugLogger('DASHSCOPE');

/**
 * Native DashScope `ContentGenerator`. Talks to the multimodal-generation
 * endpoint via a {@link DashScopeTransport} rather than the OpenAI-compatible
 * shim, so it gets raw `reasoning_content`, explicit prompt caching, and
 * true-incremental streaming deltas natively.
 */
export class DashScopeContentGenerator implements ContentGenerator {
  private readonly transport: DashScopeTransport;

  constructor(
    private readonly contentGeneratorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
    transport?: DashScopeTransport,
  ) {
    this.transport =
      transport ??
      new FetchDashScopeTransport(contentGeneratorConfig, cliConfig);
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const child = createChildAbortController(request.config?.abortSignal);
    try {
      const body = buildDashScopeRequest(request, {
        contentGeneratorConfig: this.contentGeneratorConfig,
        streaming: false,
        thinkingMandatory: this.isThinkingMandatory(
          request.model || this.contentGeneratorConfig.model,
        ),
      });
      const telemetryAttempt = reportDashScopeRequest(body);
      const payload = await this.transport.postJson(body, {
        signal: child.signal,
      });
      const response = convertDashScopeResponseToGemini(payload, body.model);
      reportGeminiResponse(telemetryAttempt, response);
      return response;
    } finally {
      child.abort();
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const child = createChildAbortController(request.config?.abortSignal);
    const body = buildDashScopeRequest(request, {
      contentGeneratorConfig: this.contentGeneratorConfig,
      streaming: true,
      thinkingMandatory: this.isThinkingMandatory(
        request.model || this.contentGeneratorConfig.model,
      ),
    });
    const telemetryAttempt = reportDashScopeRequest(body);

    let frames: AsyncGenerator<DashScopeSseFrame>;
    try {
      frames = await this.transport.postSse(body, { signal: child.signal });
    } catch (error) {
      child.abort();
      throw error;
    }

    const model = body.model;

    async function* run(): AsyncGenerator<GenerateContentResponse> {
      try {
        const accumulator = new DashScopeStreamAccumulator(model);
        for await (const frame of frames) {
          for (const chunk of accumulator.push(frame)) {
            reportGeminiChunk(telemetryAttempt, chunk);
            yield chunk;
          }
        }
        const { truncated, emittedToolCalls } = accumulator.finish();
        if (truncated && !emittedToolCalls) {
          throw new DashScopeStreamTruncatedError(
            'DashScope stream ended without a terminal frame',
          );
        }
        // If tool calls were already emitted, don't throw — a retry of this
        // request would duplicate tool side effects on the caller's end.
      } finally {
        child.abort();
      }
    }

    return run();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    try {
      const estimator = new RequestTokenEstimator();
      const result = await estimator.calculateTokens(request);
      return { totalTokens: result.totalTokens };
    } catch (error) {
      debugLogger.warn(
        'Failed to calculate tokens with tokenizer, falling back to simple method:',
        error,
      );
      const content = JSON.stringify(request.contents);
      const totalTokens = Math.ceil(content.length / 4);
      return { totalTokens };
    }
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('DashScope native provider does not support embeddings.');
  }

  useSummarizedThinking(): boolean {
    return false;
  }

  private isThinkingMandatory(model: string): boolean {
    if (
      model.toLowerCase() === this.contentGeneratorConfig.model.toLowerCase()
    ) {
      return this.contentGeneratorConfig.thinkingMandatory === true;
    }
    const authType = this.contentGeneratorConfig.authType;
    if (!authType) {
      return false;
    }
    return (
      this.cliConfig.getResolvedModelConfig?.(
        authType,
        model,
        this.contentGeneratorConfig.baseUrl,
      )?.generationConfig.thinkingMandatory === true
    );
  }
}
