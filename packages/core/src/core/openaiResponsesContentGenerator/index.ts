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
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { ResponsesPipeline } from './responsesPipeline.js';
import { RequestTokenEstimator } from '../../utils/request-tokenizer/index.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('RESPONSES');

export class OpenAIResponsesContentGenerator implements ContentGenerator {
  private readonly pipeline: ResponsesPipeline;
  private readonly contentGeneratorConfig: ContentGeneratorConfig;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    _cliConfig: Config,
  ) {
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.pipeline = new ResponsesPipeline(contentGeneratorConfig);
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
    return this.pipeline.executeStream(request, userPromptId, signal);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    try {
      const estimator = new RequestTokenEstimator();
      const result = await estimator.calculateTokens(request);
      return { totalTokens: result.totalTokens };
    } catch (error) {
      debugLogger.warn('Token estimation fallback:', error);
      const content = JSON.stringify(request.contents);
      return { totalTokens: Math.ceil(content.length / 4) };
    }
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    let text = '';
    if (Array.isArray(request.contents)) {
      text = request.contents
        .map((content) => {
          if (typeof content === 'string') return content;
          if ('parts' in content && content.parts) {
            return content.parts
              .map((part) =>
                typeof part === 'string'
                  ? part
                  : 'text' in part
                    ? (part as { text?: string }).text || ''
                    : '',
              )
              .join(' ');
          }
          return '';
        })
        .join(' ');
    } else if (request.contents) {
      if (typeof request.contents === 'string') {
        text = request.contents;
      } else if ('parts' in request.contents && request.contents.parts) {
        text = request.contents.parts
          .map((part) =>
            typeof part === 'string' ? part : 'text' in part ? part.text : '',
          )
          .join(' ');
      }
    }

    const OpenAI = (await import('openai')).default;
    const apiKey =
      this.contentGeneratorConfig.apiKey ??
      (this.contentGeneratorConfig.apiKeyEnvKey
        ? process.env[this.contentGeneratorConfig.apiKeyEnvKey]
        : undefined);
    const client = new OpenAI({
      apiKey,
      baseURL: this.contentGeneratorConfig.baseUrl,
    });

    try {
      const embedding = await client.embeddings.create({
        model: this.contentGeneratorConfig.model.includes('embed')
          ? this.contentGeneratorConfig.model
          : 'text-embedding-ada-002',
        input: text,
      });
      return {
        embeddings: [{ values: embedding.data[0]!.embedding }],
      };
    } catch (error) {
      debugLogger.error('Embedding error:', error);
      throw new Error(
        `Embedding error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  useSummarizedThinking(): boolean {
    return true;
  }

  resetPipelineState(): void {
    this.pipeline.resetState();
  }
}

export function createOpenAIResponsesContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  return new OpenAIResponsesContentGenerator(contentGeneratorConfig, cliConfig);
}
