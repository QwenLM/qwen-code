/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  type Content,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata,
  type ContentListUnion,
  type ContentUnion,
  type Part,
  type PartUnion,
  type FinishReason,
} from '@google/genai';
import type OpenAI from 'openai';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  ApiErrorEvent,
} from '../../telemetry/types.js';
import type { Config } from '../../config/config.js';
import {
  logApiError,
  logApiRequest,
  logApiResponse,
} from '../../telemetry/loggers.js';
import type { ContentGenerator } from '../contentGenerator.js';
import { isStructuredError } from '../../utils/quotaErrorDetection.js';
import { OpenAIContentConverter } from '../openaiContentGenerator/converter.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';

interface StructuredError {
  status: number;
}

/**
 * A decorator that wraps a ContentGenerator to add logging to API calls.
 */
export class LoggingContentGenerator implements ContentGenerator {
  private openaiLogger?: OpenAILogger;
  private schemaCompliance?: 'auto' | 'openapi_30';

  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly config: Config,
  ) {
    const generatorConfig = this.config.getContentGeneratorConfig();
    if (generatorConfig?.enableOpenAILogging) {
      this.openaiLogger = new OpenAILogger(generatorConfig.openAILoggingDir);
      this.schemaCompliance = generatorConfig.schemaCompliance;
    }
  }

  getWrapped(): ContentGenerator {
    return this.wrapped;
  }

  private logApiRequest(
    contents: Content[],
    model: string,
    promptId: string,
  ): void {
    const requestText = JSON.stringify(contents);
    logApiRequest(
      this.config,
      new ApiRequestEvent(model, promptId, requestText),
    );
  }

  private _logApiResponse(
    responseId: string,
    durationMs: number,
    model: string,
    prompt_id: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
  ): void {
    logApiResponse(
      this.config,
      new ApiResponseEvent(
        responseId,
        model,
        durationMs,
        prompt_id,
        this.config.getContentGeneratorConfig()?.authType,
        usageMetadata,
        responseText,
      ),
    );
  }

  private _logApiError(
    responseId: string | undefined,
    durationMs: number,
    error: unknown,
    model: string,
    prompt_id: string,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType =
      (error as { type?: string })?.type ||
      (error instanceof Error ? error.name : 'unknown');
    const errorResponseId =
      (error as { requestID?: string; request_id?: string })?.requestID ||
      (error as { requestID?: string; request_id?: string })?.request_id ||
      responseId;
    const errorStatus =
      (error as { code?: string | number; status?: number })?.code ??
      (error as { status?: number })?.status ??
      (isStructuredError(error)
        ? (error as StructuredError).status
        : undefined);

    logApiError(
      this.config,
      new ApiErrorEvent(
        errorResponseId,
        model,
        errorMessage,
        durationMs,
        prompt_id,
        this.config.getContentGeneratorConfig()?.authType,
        errorType,
        errorStatus,
      ),
    );
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const startTime = Date.now();
    this.logApiRequest(this.toContents(req.contents), req.model, userPromptId);
    const openaiRequest = await this.buildOpenAIRequestForLogging(req);
    try {
      const response = await this.wrapped.generateContent(req, userPromptId);
      const durationMs = Date.now() - startTime;
      this._logApiResponse(
        response.responseId ?? '',
        durationMs,
        response.modelVersion || req.model,
        userPromptId,
        response.usageMetadata,
        JSON.stringify(response),
      );
      await this.logOpenAIInteraction(openaiRequest, response);
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(undefined, durationMs, error, req.model, userPromptId);
      await this.logOpenAIInteraction(openaiRequest, undefined, error);
      throw error;
    }
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const startTime = Date.now();
    this.logApiRequest(this.toContents(req.contents), req.model, userPromptId);
    const openaiRequest = await this.buildOpenAIRequestForLogging(req);

    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.wrapped.generateContentStream(req, userPromptId);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(undefined, durationMs, error, req.model, userPromptId);
      await this.logOpenAIInteraction(openaiRequest, undefined, error);
      throw error;
    }

    return this.loggingStreamWrapper(
      stream,
      startTime,
      userPromptId,
      req.model,
      openaiRequest,
    );
  }

  private async *loggingStreamWrapper(
    stream: AsyncGenerator<GenerateContentResponse>,
    startTime: number,
    userPromptId: string,
    model: string,
    openaiRequest?: OpenAI.Chat.ChatCompletionCreateParams,
  ): AsyncGenerator<GenerateContentResponse> {
    const responses: GenerateContentResponse[] = [];

    let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined;
    try {
      for await (const response of stream) {
        responses.push(response);
        if (response.usageMetadata) {
          lastUsageMetadata = response.usageMetadata;
        }
        yield response;
      }
      // Only log successful API response if no error occurred
      const durationMs = Date.now() - startTime;
      this._logApiResponse(
        responses[0]?.responseId ?? '',
        durationMs,
        responses[0]?.modelVersion || model,
        userPromptId,
        lastUsageMetadata,
        JSON.stringify(responses),
      );
      const consolidatedResponse =
        this.consolidateGeminiResponsesForLogging(responses);
      await this.logOpenAIInteraction(openaiRequest, consolidatedResponse);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(
        undefined,
        durationMs,
        error,
        responses[0]?.modelVersion || model,
        userPromptId,
      );
      await this.logOpenAIInteraction(openaiRequest, undefined, error);
      throw error;
    }
  }

  private async buildOpenAIRequestForLogging(
    request: GenerateContentParameters,
  ): Promise<OpenAI.Chat.ChatCompletionCreateParams | undefined> {
    if (!this.openaiLogger) {
      return undefined;
    }

    const converter = new OpenAIContentConverter(
      request.model,
      this.schemaCompliance,
    );
    const messages = converter.convertGeminiRequestToOpenAI(request, {
      cleanOrphanToolCalls: false,
    });

    const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: request.model,
      messages,
    };

    if (request.config?.tools) {
      openaiRequest.tools = await converter.convertGeminiToolsToOpenAI(
        request.config.tools,
      );
    }

    if (request.config?.temperature !== undefined) {
      openaiRequest.temperature = request.config.temperature;
    }
    if (request.config?.topP !== undefined) {
      openaiRequest.top_p = request.config.topP;
    }
    if (request.config?.maxOutputTokens !== undefined) {
      openaiRequest.max_tokens = request.config.maxOutputTokens;
    }
    if (request.config?.presencePenalty !== undefined) {
      openaiRequest.presence_penalty = request.config.presencePenalty;
    }
    if (request.config?.frequencyPenalty !== undefined) {
      openaiRequest.frequency_penalty = request.config.frequencyPenalty;
    }

    return openaiRequest;
  }

  private async logOpenAIInteraction(
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams | undefined,
    response?: GenerateContentResponse,
    error?: unknown,
  ): Promise<void> {
    if (!this.openaiLogger || !openaiRequest) {
      return;
    }

    const openaiResponse = response
      ? this.convertGeminiResponseToOpenAIForLogging(response, openaiRequest)
      : undefined;

    await this.openaiLogger.logInteraction(
      openaiRequest,
      openaiResponse,
      error instanceof Error
        ? error
        : error
          ? new Error(String(error))
          : undefined,
    );
  }

  private convertGeminiResponseToOpenAIForLogging(
    response: GenerateContentResponse,
    openaiRequest: OpenAI.Chat.ChatCompletionCreateParams,
  ): OpenAI.Chat.ChatCompletion {
    const converter = new OpenAIContentConverter(
      openaiRequest.model,
      this.schemaCompliance,
    );

    return converter.convertGeminiResponseToOpenAI(response);
  }

  private consolidateGeminiResponsesForLogging(
    responses: GenerateContentResponse[],
  ): GenerateContentResponse | undefined {
    if (responses.length === 0) {
      return undefined;
    }

    const consolidated = new GenerateContentResponse();
    const combinedParts: Part[] = [];
    const functionCallIndex = new Map<string, number>();
    let finishReason: FinishReason | undefined;
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

    for (const response of responses) {
      if (response.usageMetadata) {
        usageMetadata = response.usageMetadata;
      }

      const candidate = response.candidates?.[0];
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
      }

      const parts = candidate?.content?.parts ?? [];
      for (const part of parts as Part[]) {
        if (typeof part === 'string') {
          combinedParts.push({ text: part });
          continue;
        }

        if ('text' in part) {
          if (part.text) {
            combinedParts.push({
              text: part.text,
              ...(part.thought ? { thought: true } : {}),
              ...(part.thoughtSignature
                ? { thoughtSignature: part.thoughtSignature }
                : {}),
            });
          }
          continue;
        }

        if ('functionCall' in part && part.functionCall) {
          const callKey =
            part.functionCall.id || part.functionCall.name || 'tool_call';
          const existingIndex = functionCallIndex.get(callKey);
          const functionPart = { functionCall: part.functionCall };
          if (existingIndex !== undefined) {
            combinedParts[existingIndex] = functionPart;
          } else {
            functionCallIndex.set(callKey, combinedParts.length);
            combinedParts.push(functionPart);
          }
          continue;
        }

        if ('functionResponse' in part && part.functionResponse) {
          combinedParts.push({ functionResponse: part.functionResponse });
          continue;
        }

        combinedParts.push(part);
      }
    }

    const lastResponse = responses[responses.length - 1];
    const lastCandidate = lastResponse.candidates?.[0];

    consolidated.responseId = lastResponse.responseId;
    consolidated.createTime = lastResponse.createTime;
    consolidated.modelVersion = lastResponse.modelVersion;
    consolidated.promptFeedback = lastResponse.promptFeedback;
    consolidated.usageMetadata = usageMetadata;

    consolidated.candidates = [
      {
        content: {
          role: lastCandidate?.content?.role || 'model',
          parts: combinedParts,
        },
        ...(finishReason ? { finishReason } : {}),
        index: 0,
        safetyRatings: lastCandidate?.safetyRatings || [],
      },
    ];

    return consolidated;
  }

  async countTokens(req: CountTokensParameters): Promise<CountTokensResponse> {
    return this.wrapped.countTokens(req);
  }

  async embedContent(
    req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.wrapped.embedContent(req);
  }

  useSummarizedThinking(): boolean {
    return this.wrapped.useSummarizedThinking();
  }

  private toContents(contents: ContentListUnion): Content[] {
    if (Array.isArray(contents)) {
      // it's a Content[] or a PartsUnion[]
      return contents.map((c) => this.toContent(c));
    }
    // it's a Content or a PartsUnion
    return [this.toContent(contents)];
  }

  private toContent(content: ContentUnion): Content {
    if (Array.isArray(content)) {
      // it's a PartsUnion[]
      return {
        role: 'user',
        parts: this.toParts(content),
      };
    }
    if (typeof content === 'string') {
      // it's a string
      return {
        role: 'user',
        parts: [{ text: content }],
      };
    }
    if ('parts' in content) {
      // it's a Content - process parts to handle thought filtering
      return {
        ...content,
        parts: content.parts
          ? this.toParts(content.parts.filter((p) => p != null))
          : [],
      };
    }
    // it's a Part
    return {
      role: 'user',
      parts: [this.toPart(content as Part)],
    };
  }

  private toParts(parts: PartUnion[]): Part[] {
    return parts.map((p) => this.toPart(p));
  }

  private toPart(part: PartUnion): Part {
    if (typeof part === 'string') {
      // it's a string
      return { text: part };
    }

    // Handle thought parts for CountToken API compatibility
    // The CountToken API expects parts to have certain required "oneof" fields initialized,
    // but thought parts don't conform to this schema and cause API failures
    if ('thought' in part && part.thought) {
      const thoughtText = `[Thought: ${part.thought}]`;

      const newPart = { ...part };
      delete (newPart as Record<string, unknown>)['thought'];

      const hasApiContent =
        'functionCall' in newPart ||
        'functionResponse' in newPart ||
        'inlineData' in newPart ||
        'fileData' in newPart;

      if (hasApiContent) {
        // It's a functionCall or other non-text part. Just strip the thought.
        return newPart;
      }

      // If no other valid API content, this must be a text part.
      // Combine existing text (if any) with the thought, preserving other properties.
      const text = (newPart as { text?: unknown }).text;
      const existingText = text ? String(text) : '';
      const combinedText = existingText
        ? `${existingText}\n${thoughtText}`
        : thoughtText;

      return {
        ...newPart,
        text: combinedText,
      };
    }

    return part;
  }
}
