import OpenAI from 'openai';

// Extended types to support cache_control for DashScope
export interface ChatCompletionContentPartTextWithCache
  extends OpenAI.Chat.ChatCompletionContentPartText {
  cache_control?: { type: 'ephemeral' };
}

export type ChatCompletionContentPartWithCache =
  | ChatCompletionContentPartTextWithCache
  | OpenAI.Chat.ChatCompletionContentPartImage
  | OpenAI.Chat.ChatCompletionContentPartRefusal;

export interface OpenAICompatibleProvider {
  buildHeaders(): Record<string, string | undefined>;
  buildClient(): OpenAI;
  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams;
}

export type DashScopeRequestMetadata = {
  metadata: {
    sessionId?: string;
    promptId: string;
  };
};
