import type OpenAI from 'openai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

/**
 * Provider for ModelScope API
 */
export class ModelScopeOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  /**
   * Checks if the configuration is for ModelScope.
   */
  static isModelScopeProvider(config: ContentGeneratorConfig): boolean {
    return !!config.baseUrl?.includes('modelscope');
  }

  /**
   * ModelScope does not support `stream_options` when `stream` is false.
   * This method removes `stream_options` if `stream` is not true.
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const newRequest = super.buildRequest(request, userPromptId);
    if (!newRequest.stream) {
      delete (newRequest as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
        .stream_options;
    }

    return newRequest;
  }
}
