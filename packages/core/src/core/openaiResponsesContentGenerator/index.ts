/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type OpenAI from 'openai';
import { ResponsesPipeline } from './responses-pipeline.js';
import {
  buildRuntimeFetchOptions,
  redactProxyError,
} from '../../utils/runtimeFetchOptions.js';
import { extractTextFromContents } from '../../utils/extract-text-from-contents.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  DEFAULT_MAX_RETRIES,
  resolveRequestTimeout,
} from '../openaiContentGenerator/constants.js';

const debugLogger = createDebugLogger('RESPONSES');

export class OpenAIResponsesContentGenerator implements ContentGenerator {
  private readonly pipeline: ResponsesPipeline;
  private readonly contentGeneratorConfig: ContentGeneratorConfig;
  private readonly cliConfig: Config;
  private openaiClient: OpenAI | null = null;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
    this.pipeline = new ResponsesPipeline(contentGeneratorConfig, cliConfig);
  }

  private async getOpenAIClient(): Promise<OpenAI> {
    if (this.openaiClient) return this.openaiClient;
    const OpenAISDK = (await import('openai')).default;
    const apiKey =
      this.contentGeneratorConfig.apiKey ??
      (this.contentGeneratorConfig.apiKeyEnvKey
        ? process.env[this.contentGeneratorConfig.apiKeyEnvKey]
        : undefined);
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    // This generator's own baseUrl convention is /v1-less (the streaming
    // pipeline strips any trailing /v1 and appends /v1/responses itself),
    // but the OpenAI SDK does not append /v1 to a custom baseURL on its
    // own -- only to its own built-in default. Normalize the same way the
    // streaming pipeline does so a bare-origin baseUrl still resolves to
    // .../v1/embeddings instead of .../embeddings (404).
    const baseURL = this.contentGeneratorConfig.baseUrl
      ? `${this.contentGeneratorConfig.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1`
      : undefined;
    this.openaiClient = new OpenAISDK({
      apiKey,
      baseURL,
      timeout: resolveRequestTimeout(this.contentGeneratorConfig.timeout),
      maxRetries: this.contentGeneratorConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
      // Mirror the streaming pipeline (responses-pipeline.ts), which
      // applies customHeaders to every request -- without this, headers
      // configured for the streaming path (e.g. a proxy auth header)
      // silently don't reach embedContent's requests.
      ...(this.contentGeneratorConfig.customHeaders
        ? { defaultHeaders: this.contentGeneratorConfig.customHeaders }
        : {}),
      ...(runtimeOptions || {}),
    });
    return this.openaiClient;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.pipeline.execute(
      request,
      userPromptId,
      request.config?.abortSignal ?? undefined,
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const signal = request.config?.abortSignal ?? undefined;
    return this.pipeline.connectStream(request, userPromptId, signal);
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const text = extractTextFromContents(request.contents);

    const client = await this.getOpenAIClient();
    try {
      const embedding = await client.embeddings.create({
        model: this.contentGeneratorConfig.model.includes('embed')
          ? this.contentGeneratorConfig.model
          : 'text-embedding-ada-002',
        input: text,
      });
      const first = embedding.data[0];
      if (!first) {
        throw new Error('Embedding API returned empty data array');
      }
      return {
        embeddings: [{ values: first.embedding }],
      };
    } catch (error) {
      const redactedError = redactProxyError(error);
      debugLogger.error('Embedding error:', redactedError);
      throw new Error(
        `Embedding error: ${redactedError instanceof Error ? redactedError.message : String(redactedError)}`,
      );
    }
  }
}

export function createOpenAIResponsesContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  return new OpenAIResponsesContentGenerator(contentGeneratorConfig, cliConfig);
}
