/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
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
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from '../reasoning-effort.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  reportLlmChunk,
  reportLlmRequest,
  reportLlmResponse,
  type GenAiAttemptHandle,
} from '../../telemetry/gen-ai-request.js';

const debugLogger = createDebugLogger('GEMINI');

// Gemini 2.5 has no `thinkingLevel`; the request is rejected outright when the
// field is present. That family takes a `thinkingBudget` instead, which is the
// split the unified-effort design already calls for
// (docs/design/2026-06-30-unified-reasoning-effort-cli.md).
const BUDGET_STYLE_MODEL = /gemini-2\.5/;
const BUDGET_STYLE_PRO = /gemini-2\.5-pro/;

// Buckets invert the budget -> level thresholds in that same design doc. The
// top tiers take the model's documented ceiling, which is the one place where
// 2.5 can go beyond what the Gemini 3 ladder expresses.
const THINKING_BUDGET_CEILING_PRO = 32768;
const THINKING_BUDGET_CEILING = 24576;

function thinkingBudgetForEffort(
  effort: ReasoningEffort,
  model: string,
): number {
  switch (effort) {
    case 'low':
      return 2048;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    case 'xhigh':
    case 'max':
      return BUDGET_STYLE_PRO.test(model)
        ? THINKING_BUDGET_CEILING_PRO
        : THINKING_BUDGET_CEILING;
    default: {
      const _exhaustive: never = effort;
      void _exhaustive;
      return 16384;
    }
  }
}

function observeLlmStream(
  stream: AsyncIterable<GenerateContentResponse>,
  telemetryAttempt: GenAiAttemptHandle | undefined,
): AsyncGenerator<GenerateContentResponse> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (!result.done) reportLlmChunk(telemetryAttempt, result.value);
      return result;
    },
    async return(value?: GenerateContentResponse) {
      if (iterator.return) return iterator.return(value);
      return { done: true, value };
    },
    async throw(error?: unknown) {
      if (iterator.throw) return iterator.throw(error);
      await iterator.return?.();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * A wrapper for GoogleGenAI that implements the ContentGenerator interface.
 */
export class LlmContentGenerator implements ContentGenerator {
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
        this.buildThinkingConfig(request.model),
        'thinkingConfig',
        { includeThoughts: true },
      ),
    };
  }

  private buildThinkingConfig(model: string):
    | {
        includeThoughts: boolean;
        thinkingLevel?: ThinkingLevel;
        thinkingBudget?: number;
      }
    | undefined {
    const reasoning = this.contentGeneratorConfig?.reasoning;

    if (reasoning === false) {
      return { includeThoughts: false };
    }

    if (!reasoning) {
      return undefined;
    }

    // No effort set: send neither knob. THINKING_LEVEL_UNSPECIFIED means "the
    // model decides", which is exactly what omitting the field does, and the
    // 2.5 family rejects the field itself.
    if (reasoning.effort === undefined) {
      return { includeThoughts: true };
    }

    if (BUDGET_STYLE_MODEL.test(model)) {
      return {
        includeThoughts: true,
        thinkingBudget: thinkingBudgetForEffort(reasoning.effort, model),
      };
    }

    // Gemini's thinkingLevel ladder is MINIMAL / LOW / MEDIUM / HIGH — there
    // is no xhigh/max, so the extra-strong tiers clamp down via the shared
    // rank-based clamp (the Anthropic generator uses the same helper for its
    // own per-model ceilings).
    const clamped = clampReasoningEffort(reasoning.effort, [
      'low',
      'medium',
      'high',
    ]);
    if (clamped !== reasoning.effort && !this.effortClampWarned) {
      debugLogger.warn(
        `reasoning.effort='${reasoning.effort}' is not supported by Gemini; clamping to '${clamped.toUpperCase()}'.`,
      );
      this.effortClampWarned = true;
    }
    const thinkingLevel = (
      {
        low: 'LOW',
        medium: 'MEDIUM',
        high: 'HIGH',
      } as Record<'low' | 'medium' | 'high', ThinkingLevel>
    )[clamped as 'low' | 'medium' | 'high'];

    return {
      includeThoughts: true,
      thinkingLevel,
    };
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
    const telemetryAttempt = reportLlmRequest(finalRequest);
    const response =
      await this.googleGenAI.models.generateContent(finalRequest);
    reportLlmResponse(telemetryAttempt, response);
    return response;
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
    const telemetryAttempt = reportLlmRequest(finalRequest);
    const stream =
      await this.googleGenAI.models.generateContentStream(finalRequest);
    return observeLlmStream(stream, telemetryAttempt);
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

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.googleGenAI.models.embedContent(request);
  }
}
