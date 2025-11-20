/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { logApiError, logApiResponse } from '../../telemetry/loggers.js';
import { ApiErrorEvent, ApiResponseEvent } from '../../telemetry/types.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';
import type { GenerateContentResponse } from '@google/genai';
import type OpenAI from 'openai';

export interface RequestContext {
  userPromptId: string;
  model: string;
  authType: string;
  startTime: number;
  duration: number;
  isStreaming: boolean;
}

export interface TelemetryService {
  logSuccess(
    context: RequestContext,
    response: GenerateContentResponse,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
    openaiResponse?: OpenAI.Chat.ChatCompletion,
  ): Promise<void>;

  logError(
    context: RequestContext,
    error: unknown,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
  ): Promise<void>;

  logStreamingSuccess(
    context: RequestContext,
    responses: GenerateContentResponse[],
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
    openaiChunks?: OpenAI.Chat.ChatCompletionChunk[],
  ): Promise<void>;
}

export class DefaultTelemetryService implements TelemetryService {
  private logger: OpenAILogger;

  constructor(
    private config: Config,
    private enableOpenAILogging: boolean = false,
    openAILoggingDir?: string,
  ) {
    // Always create a new logger instance to ensure correct working directory
    // If no custom directory is provided, undefined will use the default path
    this.logger = new OpenAILogger(openAILoggingDir);
  }

  async logSuccess(
    context: RequestContext,
    response: GenerateContentResponse,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
    openaiResponse?: OpenAI.Chat.ChatCompletion,
  ): Promise<void> {
    // Log API response event for UI telemetry
    const responseEvent = new ApiResponseEvent(
      response.responseId || 'unknown',
      context.model,
      context.duration,
      context.userPromptId,
      context.authType,
      response.usageMetadata,
    );

    logApiResponse(this.config, responseEvent);

    // Log interaction if enabled
    if (this.enableOpenAILogging && openaiRequest && openaiResponse) {
      await this.logger.logInteraction(openaiRequest, openaiResponse);
    }
  }

  async logError(
    context: RequestContext,
    error: unknown,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log API error event for UI telemetry
    const errorEvent = new ApiErrorEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any)?.requestID || 'unknown',
      context.model,
      errorMessage,
      context.duration,
      context.userPromptId,
      context.authType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any)?.type,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any)?.code,
    );
    logApiError(this.config, errorEvent);

    // Log error interaction if enabled
    if (this.enableOpenAILogging && openaiRequest) {
      await this.logger.logInteraction(
        openaiRequest,
        undefined,
        error as Error,
      );
    }
  }

  async logStreamingSuccess(
    context: RequestContext,
    responses: GenerateContentResponse[],
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
    openaiChunks?: OpenAI.Chat.ChatCompletionChunk[],
  ): Promise<void> {
    // Get final usage metadata from the last response that has it
    const finalUsageMetadata = responses
      .slice()
      .reverse()
      .find((r) => r.usageMetadata)?.usageMetadata;

    // Log API response event for UI telemetry
    const responseEvent = new ApiResponseEvent(
      responses[responses.length - 1]?.responseId || 'unknown',
      context.model,
      context.duration,
      context.userPromptId,
      context.authType,
      finalUsageMetadata,
    );

    logApiResponse(this.config, responseEvent);

    // Log interaction if enabled - combine chunks only when needed
    if (
      this.enableOpenAILogging &&
      openaiRequest &&
      openaiChunks &&
      openaiChunks.length > 0
    ) {
      const combinedResponse = this.combineOpenAIChunksForLogging(openaiChunks);
      await this.logger.logInteraction(openaiRequest, combinedResponse);
    }
  }

  /**
   * Combine OpenAI chunks for logging purposes
   * This method consolidates all OpenAI stream chunks into a single ChatCompletion response
   * for telemetry and logging purposes, avoiding unnecessary format conversions
   */
  private combineOpenAIChunksForLogging(
    chunks: OpenAI.Chat.ChatCompletionChunk[],
  ): OpenAI.Chat.ChatCompletion {
    if (chunks.length === 0) {
      throw new Error('No chunks to combine');
    }

    const firstChunk = chunks[0];

    // Combine all content from chunks
    let combinedContent = '';
    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
    let finishReason:
      | 'stop'
      | 'length'
      | 'tool_calls'
      | 'content_filter'
      | 'function_call'
      | null = null;
    let usage:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        }
      | undefined;

    for (const chunk of chunks) {
      const choice = chunk.choices?.[0];
      if (choice) {
        // Combine text content
        if (choice.delta?.content) {
          combinedContent += choice.delta.content;
        }

        // Collect tool calls
        if (choice.delta?.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            if (toolCall.index !== undefined) {
              if (!toolCalls[toolCall.index]) {
                toolCalls[toolCall.index] = {
                  id: toolCall.id || '',
                  type: toolCall.type || 'function',
                  function: { name: '', arguments: '' },
                };
              }

              if (toolCall.function?.name) {
                toolCalls[toolCall.index].function.name +=
                  toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                toolCalls[toolCall.index].function.arguments +=
                  toolCall.function.arguments;
              }
            }
          }
        }

        // Get finish reason from the last chunk
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Get usage from the last chunk that has it
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    // Create the combined ChatCompletion response
    const message: OpenAI.Chat.ChatCompletionMessage = {
      role: 'assistant',
      content: combinedContent || null,
      refusal: null,
    };

    // Add tool calls if any
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.filter((tc) => tc.id); // Filter out empty tool calls
    }

    const combinedResponse: OpenAI.Chat.ChatCompletion = {
      id: firstChunk.id,
      object: 'chat.completion',
      created: firstChunk.created,
      model: firstChunk.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason || 'stop',
          logprobs: null,
        },
      ],
      usage: usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      system_fingerprint: firstChunk.system_fingerprint,
    };

    return combinedResponse;
  }
}
