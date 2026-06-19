import type OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/default.js';
import { buildNestorAuthHeaders } from './nestorAuthHeader.js';

export class NestorOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  override buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `BlazeRuntime/${version} (${process.platform}; ${process.arch})`;
    const { apiKey, customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders: Record<string, string | undefined> = {
      'User-Agent': userAgent,
      ...(apiKey ? buildNestorAuthHeaders(apiKey) : {}),
    };

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    const channel = this.cliConfig.getChannel?.();

    return {
      ...baseRequest,
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
        ...(channel ? { channel } : {}),
      },
    } as OpenAI.Chat.ChatCompletionCreateParams;
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return { temperature: 0.3 };
  }

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }
}
