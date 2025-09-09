/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { Config } from '../../config/config.js';
import { ContentGeneratorConfig } from '../contentGenerator.js';
import { type OpenAICompatibleProvider } from './provider/index.js';
import { OpenAIContentConverter } from './converter.js';
import { TelemetryService, RequestContext } from './telemetryService.js';
import { ErrorHandler } from './errorHandler.js';

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
  telemetryService: TelemetryService;
  errorHandler: ErrorHandler;
}

export class ContentGenerationPipeline {
  client: OpenAI;
  private converter: OpenAIContentConverter;
  private contentGeneratorConfig: ContentGeneratorConfig;

  constructor(private config: PipelineConfig) {
    this.contentGeneratorConfig = config.contentGeneratorConfig;
    this.client = this.config.provider.buildClient();
    this.converter = new OpenAIContentConverter(
      this.contentGeneratorConfig.model,
    );
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      false,
      async (openaiRequest, context) => {
        const openaiResponse = (await this.client.chat.completions.create(
          openaiRequest,
        )) as OpenAI.Chat.ChatCompletion;

        const geminiResponse =
          this.converter.convertOpenAIResponseToGemini(openaiResponse);

        // Log success
        await this.config.telemetryService.logSuccess(
          context,
          geminiResponse,
          openaiRequest,
          openaiResponse,
        );

        return geminiResponse;
      },
    );
  }

  async executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      true,
      async (openaiRequest, context) => {
        // Stage 1: Create OpenAI stream
        const stream = (await this.client.chat.completions.create(
          openaiRequest,
        )) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

        // Stage 2: Process stream with conversion and logging
        return this.processStreamWithLogging(
          stream,
          context,
          openaiRequest,
          request,
        );
      },
    );
  }

  /**
   * Stage 2: Process OpenAI stream with conversion and logging
   * This method handles the complete stream processing pipeline:
   * 1. Convert OpenAI chunks to Gemini format while preserving original chunks
   * 2. Filter empty responses
   * 3. Collect both formats for logging
   * 4. Handle success/error logging with original OpenAI format
   */
  private async *processStreamWithLogging(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    context: RequestContext,
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
    request: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const collectedGeminiResponses: GenerateContentResponse[] = [];
    const collectedOpenAIChunks: OpenAI.Chat.ChatCompletionChunk[] = [];

    // Reset streaming tool calls to prevent data pollution from previous streams
    this.converter.resetStreamingToolCalls();

    try {
      // Stage 2a: Convert and yield each chunk while preserving original
      for await (const chunk of stream) {
        const response = this.converter.convertOpenAIChunkToGemini(chunk);

        // Stage 2b: Filter empty responses to avoid downstream issues
        if (
          response.candidates?.[0]?.content?.parts?.length === 0 &&
          !response.usageMetadata
        ) {
          continue;
        }

        // Stage 2c: Collect both formats and yield Gemini format to consumer
        collectedGeminiResponses.push(response);
        collectedOpenAIChunks.push(chunk);
        yield response;
      }

      // Stage 2d: Stream completed successfully - perform logging with original OpenAI chunks
      context.duration = Date.now() - context.startTime;

      await this.config.telemetryService.logStreamingSuccess(
        context,
        collectedGeminiResponses,
        openaiRequest,
        collectedOpenAIChunks,
      );
    } catch (error) {
      // Stage 2e: Stream failed - handle error and logging
      context.duration = Date.now() - context.startTime;

      // Clear streaming tool calls on error to prevent data pollution
      this.converter.resetStreamingToolCalls();

      await this.config.telemetryService.logError(
        context,
        error,
        openaiRequest,
      );

      this.config.errorHandler.handle(error, context, request);
    }
  }

  private async buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
    streaming: boolean = false,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams> {
    const messages = this.converter.convertGeminiRequestToOpenAI(request);

    // Apply provider-specific enhancements
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.contentGeneratorConfig.model,
      messages,
      ...this.buildSamplingParameters(request),
    };

    // Let provider enhance the request (e.g., add metadata, cache control)
    const enhancedRequest = this.config.provider.buildRequest(
      baseRequest,
      userPromptId,
    );

    // Add tools if present
    if (request.config?.tools) {
      enhancedRequest.tools = await this.converter.convertGeminiToolsToOpenAI(
        request.config.tools,
      );
    }

    // Add streaming options if needed
    if (streaming) {
      enhancedRequest.stream = true;
      enhancedRequest.stream_options = { include_usage: true };
    }

    return enhancedRequest;
  }

  private buildSamplingParameters(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey: keyof NonNullable<typeof request.config>,
      defaultValue?: T,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = request.config?.[requestKey] as T | undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    // Helper function to conditionally add parameter if it has a value
    const addParameterIfDefined = <T>(
      key: string,
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
      defaultValue?: T,
    ): Record<string, T> | Record<string, never> => {
      const value = requestKey
        ? getParameterValue(configKey, requestKey, defaultValue)
        : ((configSamplingParams?.[configKey] as T | undefined) ??
          defaultValue);

      return value !== undefined ? { [key]: value } : {};
    };

    const params = {
      // Parameters with request fallback and defaults
      temperature: getParameterValue('temperature', 'temperature', 0.0),
      top_p: getParameterValue('top_p', 'topP', 1.0),

      // Max tokens (special case: different property names)
      ...addParameterIfDefined('max_tokens', 'max_tokens', 'maxOutputTokens'),

      // Config-only parameters (no request fallback)
      ...addParameterIfDefined('top_k', 'top_k'),
      ...addParameterIfDefined('repetition_penalty', 'repetition_penalty'),
      ...addParameterIfDefined('presence_penalty', 'presence_penalty'),
      ...addParameterIfDefined('frequency_penalty', 'frequency_penalty'),
    };

    return params;
  }

  /**
   * Common error handling wrapper for execute methods
   */
  private async executeWithErrorHandling<T>(
    request: GenerateContentParameters,
    userPromptId: string,
    isStreaming: boolean,
    executor: (
      openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
      context: RequestContext,
    ) => Promise<T>,
  ): Promise<T> {
    const context = this.createRequestContext(userPromptId, isStreaming);

    try {
      const openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        isStreaming,
      );

      const result = await executor(openaiRequest, context);

      context.duration = Date.now() - context.startTime;
      return result;
    } catch (error) {
      context.duration = Date.now() - context.startTime;

      // Log error
      const openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        isStreaming,
      );
      await this.config.telemetryService.logError(
        context,
        error,
        openaiRequest,
      );

      // Handle and throw enhanced error
      this.config.errorHandler.handle(error, context, request);
    }
  }

  /**
   * Create request context with common properties
   */
  private createRequestContext(
    userPromptId: string,
    isStreaming: boolean,
  ): RequestContext {
    return {
      userPromptId,
      model: this.contentGeneratorConfig.model,
      authType: this.contentGeneratorConfig.authType || 'unknown',
      startTime: Date.now(),
      duration: 0,
      isStreaming,
    };
  }
}
