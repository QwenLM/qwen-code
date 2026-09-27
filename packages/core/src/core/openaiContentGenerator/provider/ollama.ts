/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/** Default port of a local Ollama server. */
const OLLAMA_DEFAULT_PORT = '11434';

/** Loopback hostnames that identify a local Ollama server on the default port. */
const OLLAMA_LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/** Matches "ollama" as a whole hostname label (ollama, my-ollama.local, ...). */
const OLLAMA_LABEL = /(?:^|[.\-_])ollama(?:$|[.\-_])/;

export class OllamaOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isOllamaProvider(config: ContentGeneratorConfig): boolean {
    if (!config.baseUrl) return false;

    try {
      const url = new URL(config.baseUrl);
      const hostname = url.hostname.toLowerCase();
      if (OLLAMA_LABEL.test(hostname)) {
        return true;
      }
      return (
        (OLLAMA_LOCAL_HOSTS as readonly string[]).includes(hostname) &&
        url.port === OLLAMA_DEFAULT_PORT
      );
    } catch {
      return false;
    }
  }

  /**
   * Ollama rejects a function tool that carries no `parameters` at all:
   * `400 ... Unable to generate parser for this template. Automatic parser
   * generation failed: JSON schema error at #: properties must be an object`.
   * Zero-argument tools therefore get an empty object schema injected here,
   * mirroring the MiniMax provider. The converter sets `parameters = undefined`
   * for parameterless tools because llama.cpp / LM Studio / vLLM reject the
   * empty-object shape, so this stays scoped to Ollama.
   */
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
              parameters: { type: 'object', properties: {} },
            },
          }
        : tool,
    );
    return baseRequest;
  }
}
