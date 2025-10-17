import type OpenAI from 'openai';

// Extended types to support cache_control for DashScope
export type ChatCompletionContentPartWithCache =
  OpenAI.Chat.ChatCompletionContentPart & {
    cache_control?: { type: 'ephemeral' };
  };

export type ChatCompletionToolWithCache = OpenAI.Chat.ChatCompletionTool & {
  cache_control?: { type: 'ephemeral' };
};

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
