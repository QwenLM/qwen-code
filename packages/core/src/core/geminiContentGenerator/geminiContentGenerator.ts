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
  ThinkingLevel,
  Content,
  Part,
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { reportGeminiRequest } from '../../telemetry/gen-ai-request.js';

const debugLogger = createDebugLogger('GEMINI');

/**
 * A wrapper for GoogleGenAI that implements the ContentGenerator interface.
 */
export class GeminiContentGenerator implements ContentGenerator {
  private readonly googleGenAI: GoogleGenAI;
  private readonly contentGeneratorConfig?: ContentGeneratorConfig;
  // Latch so the effort-clamp warning fires once per generator lifetime
  // instead of on every request that needs the downgrade.
  private effortClampWarned = false;

  constructor(
    options: {
      apiKey?: string;
      vertexai?: boolean;
      httpOptions?: { headers: Record<string, string> };
    },
    contentGeneratorConfig?: ContentGeneratorConfig,
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
      // Gemini's thinkingLevel ladder is MINIMAL / LOW / MEDIUM / HIGH — there
      // is no xhigh/max, so the extra-strong tiers are capped at HIGH. An unset
      // effort stays UNSPECIFIED so the model picks its own default.
      let thinkingLevel: ThinkingLevel;
      switch (reasoning.effort) {
        case 'low':
          thinkingLevel = 'LOW' as ThinkingLevel;
          break;
        case 'medium':
          thinkingLevel = 'MEDIUM' as ThinkingLevel;
          break;
        case 'high':
          thinkingLevel = 'HIGH' as ThinkingLevel;
          break;
        case 'xhigh':
        case 'max':
          // Gemini has no tier above HIGH; log the clamp once (mirroring the
          // Anthropic generator's one-time clamp warning) so a /effort xhigh|max
          // that silently runs at HIGH leaves a trace in debug logs.
          if (!this.effortClampWarned) {
            debugLogger.warn(
              `reasoning.effort='${reasoning.effort}' is not supported by Gemini; clamping to 'HIGH'.`,
            );
            this.effortClampWarned = true;
          }
          thinkingLevel = 'HIGH' as ThinkingLevel;
          break;
        case undefined:
          // No effort set — let the model pick its own default.
          thinkingLevel = 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel;
          break;
        default: {
          // Exhaustiveness guard: every ReasoningEffort tier (and undefined) is
          // handled above, so this is unreachable. Adding a new tier without a
          // matching case makes this a TypeScript compile error rather than a
          // silent fall-through to UNSPECIFIED. (A `default` is required here by
          // the eslint default-case rule.)
          const _exhaustive: never = reasoning.effort;
          void _exhaustive;
          thinkingLevel = 'THINKING_LEVEL_UNSPECIFIED' as ThinkingLevel;
          break;
        }
      }

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
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config: this.buildGenerateContentConfig(request),
    };
    reportGeminiRequest(finalRequest);
    return this.googleGenAI.models.generateContent(finalRequest);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const finalRequest = {
      ...request,
      contents: this.stripUnsupportedFields(request.contents),
      config: this.buildGenerateContentConfig(request),
    };
    reportGeminiRequest(finalRequest);
    return this.googleGenAI.models.generateContentStream(finalRequest);
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
