/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import {
  type GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import { OpenAIContentConverter } from './converter.js';
import type { ErrorHandler, RequestContext } from './errorHandler.js';
import { tokenLimit } from '../tokenLimits.js';
import { trimMessagesForContextBudget } from './contextBudgetTrim.js';

/**
 * Error thrown when the API returns an error embedded as stream content
 * instead of a proper HTTP error. Some providers (e.g., certain OpenAI-compatible
 * endpoints) return throttling errors as a normal SSE chunk with
 * finish_reason="error_finish" and the error message in delta.content.
 */
export class StreamContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamContentError';
  }
}

export interface PipelineConfig {
  cliConfig: Config;
  provider: OpenAICompatibleProvider;
  contentGeneratorConfig: ContentGeneratorConfig;
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
      this.contentGeneratorConfig.schemaCompliance,
      this.contentGeneratorConfig.modalities ?? {},
    );
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    // For OpenAI-compatible providers, the configured model is the single source of truth.
    // We intentionally ignore request.model because upstream callers may pass a model string
    // that is not valid/available for the OpenAI-compatible backend.
    const effectiveModel = this.contentGeneratorConfig.model;
    this.converter.setModel(effectiveModel);
    this.converter.setModalities(this.contentGeneratorConfig.modalities ?? {});
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      false,
      effectiveModel,
      async (openaiRequest) => {
        const openaiResponse = (await this.client.chat.completions.create(
          openaiRequest,
          {
            signal: request.config?.abortSignal,
          },
        )) as OpenAI.Chat.ChatCompletion;

        const geminiResponse =
          this.converter.convertOpenAIResponseToGemini(openaiResponse);

        return geminiResponse;
      },
    );
  }

  async executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const effectiveModel = this.contentGeneratorConfig.model;
    this.converter.setModel(effectiveModel);
    this.converter.setModalities(this.contentGeneratorConfig.modalities ?? {});
    return this.executeWithErrorHandling(
      request,
      userPromptId,
      true,
      effectiveModel,
      async (openaiRequest, context) => {
        // Stage 1: Create OpenAI stream
        const stream = (await this.client.chat.completions.create(
          openaiRequest,
          {
            signal: request.config?.abortSignal,
          },
        )) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

        // Stage 2: Process stream with conversion and logging
        return this.processStreamWithLogging(stream, context, request);
      },
    );
  }

  /**
   * Stage 2: Process OpenAI stream with conversion and logging
   * This method handles the complete stream processing pipeline:
   * 1. Convert OpenAI chunks to Gemini format while preserving original chunks
   * 2. Filter empty responses
   * 3. Handle chunk merging for providers that send finishReason and usageMetadata separately
   * 4. Collect both formats for logging
   * 5. Handle success/error logging
   */
  private async *processStreamWithLogging(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    context: RequestContext,
    request: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const collectedGeminiResponses: GenerateContentResponse[] = [];

    // Reset streaming tool calls to prevent data pollution from previous streams
    this.converter.resetStreamingToolCalls();

    // State for handling chunk merging.
    // pendingFinishResponse holds a finish chunk waiting to be merged with
    // a subsequent usage-metadata chunk before yielding.
    // finishYielded is set to true once the merged finish response has been
    // yielded, so that any further trailing chunks are treated as normal
    // chunks instead of triggering another merge (which would duplicate the
    // function-call parts from the finish chunk).
    let pendingFinishResponse: GenerateContentResponse | null = null;
    let finishYielded = false;

    try {
      // Stage 2a: Convert and yield each chunk while preserving original
      for await (const chunk of stream) {
        // Detect API errors returned as stream content.
        // Some providers return errors (e.g., TPM throttling) as a normal SSE chunk
        // with finish_reason="error_finish" and the error in delta.content,
        // instead of returning a proper HTTP error status.
        if ((chunk.choices?.[0]?.finish_reason as string) === 'error_finish') {
          const errorContent =
            chunk.choices?.[0]?.delta?.content?.trim() ||
            'Unknown stream error';
          throw new StreamContentError(errorContent);
        }

        const response = this.converter.convertOpenAIChunkToGemini(chunk);

        // Stage 2b: Filter empty responses to avoid downstream issues
        if (
          response.candidates?.[0]?.content?.parts?.length === 0 &&
          !response.candidates?.[0]?.finishReason &&
          !response.usageMetadata
        ) {
          continue;
        }

        // Stage 2c: Handle chunk merging for providers that send
        // finishReason and usageMetadata in separate chunks.
        // Once the merged finish response has been yielded, skip
        // further merging so trailing chunks don't duplicate the
        // function-call parts carried by the finish chunk.
        if (finishYielded) {
          // Finish already yielded — absorb any remaining usage
          // metadata but do NOT yield another response.
          // Note: pendingFinishResponse is guaranteed non-null here because
          // finishYielded is only set to true inside the `if (pendingFinishResponse)`
          // block below. TypeScript cannot infer this through the callback
          // assignment in handleChunkMerging, so an explicit cast is needed.
          if (response.usageMetadata) {
            const pending =
              pendingFinishResponse as GenerateContentResponse | null;
            if (pending) {
              pending.usageMetadata = response.usageMetadata;
            }
          }
          collectedGeminiResponses.push(response);
          continue;
        }

        const shouldYield = this.handleChunkMerging(
          response,
          collectedGeminiResponses,
          (mergedResponse) => {
            pendingFinishResponse = mergedResponse;
          },
        );

        if (shouldYield) {
          // If we have a pending finish response, yield it instead
          if (pendingFinishResponse) {
            yield pendingFinishResponse;
            finishYielded = true;
            // Keep pendingFinishResponse alive so late-arriving usage
            // metadata can still be merged (see finishYielded block above).
          } else {
            yield response;
          }
        }
      }

      // Stage 2d: If there's still a pending finish response at the end
      // (e.g. no usage chunk arrived after the finish chunk), yield it.
      if (pendingFinishResponse && !finishYielded) {
        yield pendingFinishResponse;
      }

      // Stage 2e: Stream completed successfully
      context.duration = Date.now() - context.startTime;
    } catch (error) {
      // Clear streaming tool calls on error to prevent data pollution
      this.converter.resetStreamingToolCalls();

      // Re-throw StreamContentError directly so it can be handled by
      // the caller's retry logic (e.g., TPM throttling retry in sendMessageStream)
      if (error instanceof StreamContentError) {
        throw error;
      }

      // Use shared error handling logic
      await this.handleError(error, context, request);
    }
  }

  /**
   * Handle chunk merging for providers that send finishReason and usageMetadata separately.
   *
   * Strategy: When we encounter a finishReason chunk, we hold it and merge all subsequent
   * chunks into it until the stream ends. This ensures the final chunk contains both
   * finishReason and the most up-to-date usage information from any provider pattern.
   *
   * @param response Current Gemini response
   * @param collectedGeminiResponses Array to collect responses for logging
   * @param setPendingFinish Callback to set pending finish response
   * @returns true if the response should be yielded, false if it should be held for merging
   */
  private handleChunkMerging(
    response: GenerateContentResponse,
    collectedGeminiResponses: GenerateContentResponse[],
    setPendingFinish: (response: GenerateContentResponse) => void,
  ): boolean {
    const isFinishChunk = response.candidates?.[0]?.finishReason;

    // Check if we have a pending finish response from previous chunks
    const hasPendingFinish =
      collectedGeminiResponses.length > 0 &&
      collectedGeminiResponses[collectedGeminiResponses.length - 1]
        .candidates?.[0]?.finishReason;

    if (isFinishChunk) {
      if (hasPendingFinish) {
        // Duplicate finish chunk (e.g. from OpenRouter providers that send two
        // finish_reason chunks for tool calls). The streaming tool call parser
        // was already reset after the first finish chunk, so the second one
        // carries no functionCall parts. Merge only usageMetadata and keep the
        // candidates (including functionCall parts) from the first finish chunk.
        const lastResponse =
          collectedGeminiResponses[collectedGeminiResponses.length - 1];
        if (response.usageMetadata) {
          lastResponse.usageMetadata = response.usageMetadata;
        }
        setPendingFinish(lastResponse);
      } else {
        // This is a finish reason chunk
        collectedGeminiResponses.push(response);
        setPendingFinish(response);
      }
      return false; // Don't yield yet, wait for potential subsequent chunks to merge
    } else if (hasPendingFinish) {
      // We have a pending finish chunk, merge this chunk's data into it
      const lastResponse =
        collectedGeminiResponses[collectedGeminiResponses.length - 1];
      const mergedResponse = new GenerateContentResponse();

      // Keep the finish reason from the previous chunk
      mergedResponse.candidates = lastResponse.candidates;

      // Merge usage metadata if this chunk has it
      if (response.usageMetadata) {
        mergedResponse.usageMetadata = response.usageMetadata;
      } else {
        mergedResponse.usageMetadata = lastResponse.usageMetadata;
      }

      // Copy other essential properties from the current response
      mergedResponse.responseId = response.responseId;
      mergedResponse.createTime = response.createTime;
      mergedResponse.modelVersion = response.modelVersion;
      mergedResponse.promptFeedback = response.promptFeedback;

      // Update the collected responses with the merged response
      collectedGeminiResponses[collectedGeminiResponses.length - 1] =
        mergedResponse;

      setPendingFinish(mergedResponse);
      return true; // Yield the merged response
    }

    // Normal chunk - collect and yield
    collectedGeminiResponses.push(response);
    return true;
  }

  private async buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
    streaming: boolean = false,
    effectiveModel: string,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams> {
    const messages = this.converter.convertGeminiRequestToOpenAI(request);

    // Apply provider-specific enhancements
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: effectiveModel,
      messages,
      ...this.buildGenerateContentConfig(request),
    };

    // Add streaming options if present
    if (streaming) {
      (
        baseRequest as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming
      ).stream = true;
      baseRequest.stream_options = { include_usage: true };
    }

    // Add tools if present
    if (request.config?.tools) {
      baseRequest.tools = await this.converter.convertGeminiToolsToOpenAI(
        request.config.tools,
      );
    }

    const contextLimit =
      this.contentGeneratorConfig.contextWindowSize ??
      tokenLimit(effectiveModel, 'input');
    baseRequest.messages = trimMessagesForContextBudget(
      baseRequest.messages,
      baseRequest.tools,
      contextLimit,
    );

    // Let provider enhance the request (e.g., add metadata, cache control)
    return this.config.provider.buildRequest(baseRequest, userPromptId);
  }

  private buildGenerateContentConfig(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    const defaultSamplingParams =
      this.config.provider.getDefaultGenerationConfig();
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = requestKey
        ? (request.config?.[requestKey] as T | undefined)
        : undefined;
      const defaultValue = requestKey
        ? (defaultSamplingParams[requestKey] as T)
        : undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    // Helper function to conditionally add parameter if it has a value
    const addParameterIfDefined = <T>(
      key: string,
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof request.config>,
    ): Record<string, T | undefined> => {
      const value = getParameterValue<T>(configKey, requestKey);

      return value !== undefined ? { [key]: value } : {};
    };

    const params: Record<string, unknown> = {
      // Parameters with request fallback but no defaults
      ...addParameterIfDefined('temperature', 'temperature', 'temperature'),
      ...addParameterIfDefined('top_p', 'top_p', 'topP'),

      // Max tokens (special case: different property names)
      ...addParameterIfDefined('max_tokens', 'max_tokens', 'maxOutputTokens'),

      // Config-only parameters (no request fallback)
      ...addParameterIfDefined('top_k', 'top_k', 'topK'),
      ...addParameterIfDefined('repetition_penalty', 'repetition_penalty'),
      ...addParameterIfDefined(
        'presence_penalty',
        'presence_penalty',
        'presencePenalty',
      ),
      ...addParameterIfDefined(
        'frequency_penalty',
        'frequency_penalty',
        'frequencyPenalty',
      ),
      ...this.buildReasoningConfig(request),
    };

    return params;
  }

  private buildReasoningConfig(
    request: GenerateContentParameters,
  ): Record<string, unknown> {
    // Reasoning configuration for OpenAI-compatible endpoints is highly fragmented.
    // For example, across common providers and models:
    //
    //   - deepseek-reasoner   — thinking is enabled by default and cannot be disabled
    //   - glm-4.7             — thinking is enabled by default; can be disabled via `extra_body.thinking.enabled`
    //   - kimi-k2-thinking    — thinking is enabled by default and cannot be disabled
    //   - gpt-5.x series      — thinking is enabled by default; can be disabled via `reasoning.effort`
    //   - qwen3 series        — model-dependent; can be manually disabled via `extra_body.enable_thinking`
    //
    // Given this inconsistency, we avoid mapping values and only pass through the
    // configured reasoning object when explicitly enabled. This keeps provider- and
    // model-specific semantics intact while honoring request-level opt-out.

    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return {};
    }

    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false || reasoning === undefined) {
      return {};
    }

    return { reasoning };
  }

  /**
   * Common error handling wrapper for execute methods
   */
  private async executeWithErrorHandling<T>(
    request: GenerateContentParameters,
    userPromptId: string,
    isStreaming: boolean,
    effectiveModel: string,
    executor: (
      openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
      context: RequestContext,
    ) => Promise<T>,
  ): Promise<T> {
    const context = this.createRequestContext(
      userPromptId,
      isStreaming,
      effectiveModel,
    );

    try {
      const openaiRequest = await this.buildRequest(
        request,
        userPromptId,
        isStreaming,
        effectiveModel,
      );

      const result = await executor(openaiRequest, context);

      context.duration = Date.now() - context.startTime;
      return result;
    } catch (error) {
      // Use shared error handling logic
      return await this.handleError(error, context, request);
    }
  }

  /**
   * Shared error handling logic for both executeWithErrorHandling and processStreamWithLogging
   * This centralizes the common error processing steps to avoid duplication
   */
  private async handleError(
    error: unknown,
    context: RequestContext,
    request: GenerateContentParameters,
  ): Promise<never> {
    context.duration = Date.now() - context.startTime;
    this.config.errorHandler.handle(error, context, request);
  }

  /**
   * Create request context with common properties
   */
  private createRequestContext(
    userPromptId: string,
    isStreaming: boolean,
    effectiveModel: string,
  ): RequestContext {
    return {
      userPromptId,
      model: effectiveModel,
      authType: this.contentGeneratorConfig.authType || 'unknown',
      startTime: Date.now(),
      duration: 0,
      isStreaming,
    };
  }
}
