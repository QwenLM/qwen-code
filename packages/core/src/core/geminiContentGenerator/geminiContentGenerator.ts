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
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';

/**
 * A wrapper for GoogleGenAI that implements the ContentGenerator interface.
 */
export class GeminiContentGenerator implements ContentGenerator {
  private readonly googleGenAI: GoogleGenAI;
  private readonly contentGeneratorConfig?: ContentGeneratorConfig;

  constructor(
    options: {
      apiKey?: string;
      vertexai?: boolean;
      httpOptions?: { headers: Record<string, string> };
    },
    contentGeneratorConfig?: ContentGeneratorConfig,
  ) {
    this.googleGenAI = new GoogleGenAI(options);
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
    const finalRequest = {
      ...request,
      config: this.buildGenerateContentConfig(request),
    };
    return this.googleGenAI.models.generateContent(finalRequest);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const finalRequest = {
      ...request,
      config: this.buildGenerateContentConfig(request),
    };
    return this.googleGenAI.models.generateContentStream(finalRequest);
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
