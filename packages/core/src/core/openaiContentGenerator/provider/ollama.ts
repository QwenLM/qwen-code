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

/**
 * Hostnames that identify a local Ollama server when paired with the default
 * port. The IPv6 literal keeps the square brackets because WHATWG
 * `URL.hostname` returns `[::1]`, not `::1`, for IPv6 addresses;
 * `host.docker.internal` is how a container reaches a host-side Ollama.
 */
const OLLAMA_LOCAL_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
] as const;

/** Matches "ollama" as a whole hostname label (ollama, my-ollama.local, ...). */
const OLLAMA_LABEL = /(?:^|[.\-_])ollama(?:$|[.\-_])/;

/**
 * True for a private IPv4 address (10/8, 172.16/12, 192.168/16). A LAN peer
 * running Ollama on the default port is a local backend just like loopback, so
 * it counts here too — but only on the default port, never for a public host
 * that happens to share the number (llama.cpp / LM Studio / vLLM reject the
 * empty-object tool shape this provider injects).
 */
function isPrivateIPv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export class OllamaOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isOllamaProvider(config: ContentGeneratorConfig): boolean {
    if (!config.baseUrl) return false;

    try {
      const url = new URL(config.baseUrl);
      const hostname = url.hostname.toLowerCase();
      if (OLLAMA_LABEL.test(hostname)) {
        return true;
      }
      // The default port is the evidence for a local backend: loopback, the
      // container alias, and a private LAN peer. A public host without the
      // "ollama" label is never assumed to be Ollama, even on 11434.
      return (
        url.port === OLLAMA_DEFAULT_PORT &&
        ((OLLAMA_LOCAL_HOSTS as readonly string[]).includes(hostname) ||
          isPrivateIPv4(hostname))
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
