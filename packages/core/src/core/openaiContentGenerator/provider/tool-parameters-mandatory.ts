/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/**
 * Servers that type `tools[].function.parameters` as a required field reject a
 * request whose parameterless tool omits it (Pydantic `Field required`, e.g.
 * TabbyAPI). converter.ts omits the field deliberately (#11431) because
 * llama.cpp / LM Studio / vLLM reject the shapes that replace it (#11410), so
 * the route is chosen by the user's `generationConfig.toolParametersMandatory`
 * rather than by endpoint sniffing: a self-hosted server shares `localhost`
 * with exactly the endpoints that need the omission, so the URL cannot identify
 * it. MiniMax needs the same repair with a different shape and keeps its own
 * provider; the vendor hostname checks win over this opt-in.
 */
export class ToolParametersMandatoryOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isToolParametersMandatory(config: ContentGeneratorConfig): boolean {
    return config.toolParametersMandatory === true;
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    baseRequest.tools = baseRequest.tools?.map((tool) =>
      tool.function.parameters === undefined
        ? {
            ...tool,
            function: {
              ...tool.function,
              parameters: { type: 'object' },
            },
          }
        : tool,
    );
    return baseRequest;
  }
}
