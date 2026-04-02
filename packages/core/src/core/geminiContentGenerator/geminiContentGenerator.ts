/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  ThinkingLevel,
  Content,
  Part,
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';

const tracer = trace.getTracer('proto.gemini', '1.0.0');

/**
 * A wrapper for GoogleGenAI that implements the ContentGenerator interface.
 */
export class GeminiContentGenerator implements ContentGenerator {
  private readonly googleGenAI: GoogleGenAI;
  private readonly contentGeneratorConfig?: ContentGeneratorConfig;
  private readonly cliConfig?: Config;

  constructor(
    options: {
      apiKey?: string;
      vertexai?: boolean;
      httpOptions?: { headers: Record<string, string> };
    },
    contentGeneratorConfig?: ContentGeneratorConfig,
    cliConfig?: Config,
  ) {
    const customHeaders = contentGeneratorConfig?.customHeaders;
    const finalOptions = customHeaders
      ? (() => {
          const baseHttpOptions = options.httpOptions;
          const baseHeaders = baseHttpOptions?.headers ?? {};

          return {
            ...options,
            httpOptions: {
              ...(baseHttpOptions ?? {}),
              headers: {
                ...baseHeaders,
                ...customHeaders,
              },
            },
          };
        })()
      : options;

    this.googleGenAI = new GoogleGenAI(finalOptions);
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
  }

  private buildGenerateContentConfig(
    request: GenerateContentParameters,
  ): GenerateContentConfig {
    const configSamplingParams = this.contentGeneratorConfig?.samplingParams;
    const requestConfig = request.config || {};

    // Helper function to get parameter value with priority: config > request > default
    const getParameterValue = <T>(
      configValue: T | undefined,
      requestKey: keyof GenerateContentConfig,
      defaultValue?: T,
    ): T | undefined => {
      const requestValue = requestConfig[requestKey] as T | undefined;

      if (configValue !== undefined) return configValue;
      if (requestValue !== undefined) return requestValue;
      return defaultValue;
    };

    return {
      ...requestConfig,
      temperature: getParameterValue<number>(
        configSamplingParams?.temperature,
        'temperature',
        1,
      ),
      topP: getParameterValue<number>(
        configSamplingParams?.top_p,
        'topP',
        0.95,
      ),
      topK: getParameterValue<number>(configSamplingParams?.top_k, 'topK', 64),
      maxOutputTokens: getParameterValue<number>(
        configSamplingParams?.max_tokens,
        'maxOutputTokens',
      ),
      presencePenalty: getParameterValue<number>(
        configSamplingParams?.presence_penalty,
        'presencePenalty',
      ),
      frequencyPenalty: getParameterValue<number>(
        configSamplingParams?.frequency_penalty,
        'frequencyPenalty',
      ),
      thinkingConfig: getParameterValue(
        this.buildThinkingConfig(),
        'thinkingConfig',
        {
          includeThoughts: true,
          thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel,
        },
      ),
    };
  }

  private buildThinkingConfig():
    | { includeThoughts: boolean; thinkingLevel?: ThinkingLevel }
    | undefined {
    const reasoning = this.contentGeneratorConfig?.reasoning;

    if (reasoning === false) {
      return { includeThoughts: false };
    }

    if (reasoning) {
      const thinkingLevel = (
        reasoning.effort === 'low'
          ? 'LOW'
          : reasoning.effort === 'high'
            ? 'HIGH'
            : 'THINKING_LEVEL_UNSPECIFIED'
      ) as ThinkingLevel;

      return {
        includeThoughts: true,
        thinkingLevel,
      };
    }

    return undefined;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const modelId = request.model;
    const span = tracer.startSpan(`gen_ai chat ${modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.system': 'google_gemini',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': modelId,
        'llm.streaming': false,
        user_prompt_id: _userPromptId,
      },
    });

    const startTime = Date.now();
    const logPrompts = this.cliConfig?.getTelemetryLogPromptsEnabled() ?? false;

    try {
      const finalRequest = {
        ...request,
        contents: this.stripUnsupportedFields(request.contents),
        config: this.buildGenerateContentConfig(request),
      };

      // Log prompt content as a span event when telemetry prompt logging is enabled
      if (logPrompts) {
        const promptJson = JSON.stringify(finalRequest.contents);
        span.addEvent('gen_ai.content.prompt', {
          'gen_ai.prompt':
            promptJson.length > 10_000
              ? promptJson.slice(0, 10_000) + '...[truncated]'
              : promptJson,
        });
      }

      const response =
        await this.googleGenAI.models.generateContent(finalRequest);

      const durationMs = Date.now() - startTime;
      this.setUsageAttributes(span, response.usageMetadata, durationMs);

      // Log completion content as a span event
      if (logPrompts) {
        const responseText = (response.candidates?.[0]?.content?.parts ?? [])
          .map((p) => (p as { text?: string }).text ?? '')
          .join('');
        if (responseText) {
          span.addEvent('gen_ai.content.completion', {
            'gen_ai.completion':
              responseText.length > 10_000
                ? responseText.slice(0, 10_000) + '...[truncated]'
                : responseText,
          });
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });

      return response;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const modelId = request.model;
    const span = tracer.startSpan(`gen_ai chat ${modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.system': 'google_gemini',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': modelId,
        'llm.streaming': true,
        user_prompt_id: _userPromptId,
      },
    });

    const startTime = Date.now();
    const logPrompts = this.cliConfig?.getTelemetryLogPromptsEnabled() ?? false;

    try {
      const finalRequest = {
        ...request,
        contents: this.stripUnsupportedFields(request.contents),
        config: this.buildGenerateContentConfig(request),
      };

      // Log prompt content as a span event when telemetry prompt logging is enabled
      if (logPrompts) {
        const promptJson = JSON.stringify(finalRequest.contents);
        span.addEvent('gen_ai.content.prompt', {
          'gen_ai.prompt':
            promptJson.length > 10_000
              ? promptJson.slice(0, 10_000) + '...[truncated]'
              : promptJson,
        });
      }

      const stream =
        await this.googleGenAI.models.generateContentStream(finalRequest);

      return this.wrapStreamWithSpan(stream, span, startTime, logPrompts);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
  }

  /**
   * Wraps a streaming response generator so the OTel span captures usage
   * metadata from the final chunk and is ended when the stream completes.
   */
  private async *wrapStreamWithSpan(
    stream: AsyncGenerator<GenerateContentResponse>,
    span: ReturnType<typeof tracer.startSpan>,
    startTime: number,
    logPrompts: boolean = false,
  ): AsyncGenerator<GenerateContentResponse> {
    let lastUsage: GenerateContentResponseUsageMetadata | undefined;
    const completionParts: string[] = [];

    try {
      for await (const chunk of stream) {
        if (chunk.usageMetadata) {
          lastUsage = chunk.usageMetadata;
        }
        // Collect streamed text for telemetry prompt logging
        if (logPrompts) {
          const text = (chunk.candidates?.[0]?.content?.parts ?? [])
            .map((p) => (p as { text?: string }).text ?? '')
            .join('');
          if (text) {
            completionParts.push(text);
          }
        }
        yield chunk;
      }

      const durationMs = Date.now() - startTime;
      this.setUsageAttributes(span, lastUsage, durationMs);

      // Log streamed completion content as a span event
      if (logPrompts && completionParts.length > 0) {
        const responseText = completionParts.join('');
        span.addEvent('gen_ai.content.completion', {
          'gen_ai.completion':
            responseText.length > 10_000
              ? responseText.slice(0, 10_000) + '...[truncated]'
              : responseText,
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Sets token-usage and duration attributes on an OTel span.
   */
  private setUsageAttributes(
    span: ReturnType<typeof tracer.startSpan>,
    usageMetadata: GenerateContentResponseUsageMetadata | undefined,
    durationMs: number,
  ): void {
    const attrs: Record<string, number> = {
      'llm.duration_ms': durationMs,
    };
    if (usageMetadata) {
      if (usageMetadata.promptTokenCount !== undefined) {
        attrs['gen_ai.usage.input_tokens'] = usageMetadata.promptTokenCount;
      }
      if (usageMetadata.candidatesTokenCount !== undefined) {
        attrs['gen_ai.usage.output_tokens'] =
          usageMetadata.candidatesTokenCount;
      }
      if (usageMetadata.totalTokenCount !== undefined) {
        attrs['gen_ai.usage.total_tokens'] = usageMetadata.totalTokenCount;
      }
    }
    span.setAttributes(attrs);
  }

  /**
   * Strip fields not supported by Gemini API (e.g., displayName in inlineData/fileData)
   */
  private stripUnsupportedFields(
    contents: GenerateContentParameters['contents'],
  ): GenerateContentParameters['contents'] {
    if (!contents) return contents;

    if (typeof contents === 'string') return contents;

    if (Array.isArray(contents)) {
      return contents.map((content) =>
        this.stripContentFields(content),
      ) as GenerateContentParameters['contents'];
    }

    return this.stripContentFields(
      contents,
    ) as GenerateContentParameters['contents'];
  }

  private stripContentFields(
    content: Content | Part | string,
  ): Content | Part | string {
    if (typeof content === 'string') {
      return content;
    }

    // Handle Part directly (for arrays of parts)
    if (!('role' in content) && !('parts' in content)) {
      return this.stripPartFields(content as Part);
    }

    // Handle Content object
    const contentObj = content as Content;
    if (!contentObj.parts) return contentObj;

    return {
      ...contentObj,
      parts: contentObj.parts.map((part) => this.stripPartFields(part)),
    };
  }

  private stripPartFields(part: Part): Part {
    if (typeof part === 'string') {
      return part;
    }

    const result = { ...part };

    // Strip displayName from inlineData
    if (result.inlineData) {
      const { displayName: _, ...inlineDataWithoutDisplayName } =
        result.inlineData as { displayName?: string; [key: string]: unknown };
      result.inlineData = inlineDataWithoutDisplayName as Part['inlineData'];
    }

    // Strip displayName from fileData
    if (result.fileData) {
      const { displayName: _, ...fileDataWithoutDisplayName } =
        result.fileData as { displayName?: string; [key: string]: unknown };
      result.fileData = fileDataWithoutDisplayName as Part['fileData'];
    }

    // Handle functionResponse parts (which may contain nested media parts)
    // Convert unsupported media types (audio, video) to text for Gemini API
    if (result.functionResponse?.parts) {
      const processedParts = result.functionResponse.parts.map((p) => {
        // First convert unsupported media to text (before stripping displayName)
        const converted = this.convertUnsupportedMediaToText(p);
        // Then strip unsupported fields from remaining parts
        return this.stripPartFields(converted);
      });

      result.functionResponse = {
        ...result.functionResponse,
        parts: processedParts,
      };
    }

    return result;
  }

  /**
   * Convert unsupported media types (audio, video) to explanatory text for Gemini API
   */
  private convertUnsupportedMediaToText(part: Part): Part {
    if (typeof part === 'string') return part;

    const inlineMimeType = part.inlineData?.mimeType || '';
    const fileMimeType = part.fileData?.mimeType || '';

    if (
      inlineMimeType.startsWith('audio/') ||
      inlineMimeType.startsWith('video/')
    ) {
      const displayName = (part.inlineData as { displayName?: string })
        ?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : '';
      return {
        text: `Unsupported media type for Gemini: ${inlineMimeType}${displayNameText}.`,
      };
    }

    if (
      fileMimeType.startsWith('audio/') ||
      fileMimeType.startsWith('video/')
    ) {
      const displayName = (part.fileData as { displayName?: string })
        ?.displayName;
      const displayNameText = displayName ? ` (${displayName})` : '';
      return {
        text: `Unsupported media type for Gemini: ${fileMimeType}${displayNameText}.`,
      };
    }

    return part;
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return this.googleGenAI.models.countTokens(request);
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.googleGenAI.models.embedContent(request);
  }

  useSummarizedThinking(): boolean {
    return true;
  }
}
