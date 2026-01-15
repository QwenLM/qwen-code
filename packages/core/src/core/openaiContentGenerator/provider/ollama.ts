import type OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';

/**
 * Ollama provider (local Ollama HTTP API) - scaffold implementation.
 *
 * Notes / assumptions (documented so future maintainers can adapt):
 * - Assumes Ollama local HTTP endpoint is available at `baseUrl` in
 *   `contentGeneratorConfig`. If not provided, defaults to `http://localhost:11434`.
 * - Ollama request/response shapes vary between versions. This provider implements
 *   a conservative mapping from OpenAI-style `ChatCompletionCreateParams` to a
 *   JSON body that Ollama commonly accepts (model, prompt/messages, max_tokens,
 *   temperature). Streaming is supported by reading chunked/line-delimited JSON
 *   from the response body and converting it into OpenAI-compatible chunks.
 * - This is intentionally a pragmatic scaffold: if your Ollama instance uses a
 *   different API shape (e.g., `/v1/chat/completions` or different stream format),
 *   adapt `mapRequest()` and `createStreamIterable()` accordingly.
 */
export class OllamaOpenAICompatibleProvider implements OpenAICompatibleProvider {
  protected contentGeneratorConfig: ContentGeneratorConfig;
  protected cliConfig: Config;

  constructor(contentGeneratorConfig: ContentGeneratorConfig, cliConfig: Config) {
    this.contentGeneratorConfig = contentGeneratorConfig;
    this.cliConfig = cliConfig;
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion?.() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders: Record<string, string | undefined> = {
      'User-Agent': userAgent,
      'Content-Type': 'application/json',
    };

    if (this.contentGeneratorConfig.apiKey) {
      // Ollama may not require API keys for local usage, but allow Authorization if present
      defaultHeaders['Authorization'] = `Bearer ${this.contentGeneratorConfig.apiKey}`;
    }

    return customHeaders ? { ...defaultHeaders, ...customHeaders } : defaultHeaders;
  }

  buildClient(): OpenAI {
    // We return a lightweight client object that implements the subset used by
    // the pipeline: `client.chat.completions.create(request, opts)`.
    const baseUrl = this.contentGeneratorConfig.baseUrl || 'http://localhost:11434';
    const headers = this.buildHeaders();
    const timeout = this.contentGeneratorConfig.timeout || DEFAULT_TIMEOUT;
    const maxRetries = this.contentGeneratorConfig.maxRetries || DEFAULT_MAX_RETRIES;

    // Minimal client implementation
    const client: any = {
      chat: {
        completions: {
          create: async (request: OpenAI.Chat.ChatCompletionCreateParams, opts?: any) => {
            const mapped = this.mapRequest(request);
            const url = `${baseUrl.replace(/\/$/, '')}/api/generate`;

            // If streaming requested, return an async iterable
            if ((request as any).stream) {
              const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(mapped),
                // signal may be provided via opts
                signal: opts?.signal,
              });

              return this.createStreamIterable(response);
            }

            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(mapped),
              signal: opts?.signal,
            });

            const json = await response.json().catch(() => ({}));

            // Map Ollama response to OpenAI.Chat.ChatCompletion-like object
            const openaiResponse: any = {
              id: json.id || json.uuid || 'ollama-response',
              object: 'chat.completion',
              created: Date.now() / 1000,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: json.text || json.output || '' },
                  finish_reason: json.finish_reason || 'stop',
                },
              ],
            };

            return openaiResponse as OpenAI.Chat.ChatCompletion;
          },
        },
      },
    };

    return client as OpenAI;
  }

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    // For Ollama we pass through the request; mapping to Ollama payload is handled in buildClient().
    return { ...request };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
  }

  private mapRequest(request: OpenAI.Chat.ChatCompletionCreateParams): Record<string, unknown> {
    // Convert OpenAI-style chat request into a generic Ollama payload.
    // This is a best-effort mapping and should be adapted if your Ollama API differs.
    const messages = (request.messages || []).map((m: any) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map((p:any)=>p.text||p).join('') : m.content }));

    const prompt = messages.map((m: any) => `${m.role}: ${m.content}`).join('\n');

    const payload: any = {
      model: request.model,
      prompt,
    };

    if ((request as any).temperature !== undefined) payload.temperature = (request as any).temperature;
    if ((request as any).max_tokens !== undefined) payload.max_tokens = (request as any).max_tokens;
    if ((request as any).top_p !== undefined) payload.top_p = (request as any).top_p;

    // Allow passthrough of other fields
    return { ...payload };
  }

  private async *createStreamIterable(response: Response): AsyncIterable<any> {
    // Create an async iterable that yields OpenAI.Chat.ChatCompletionChunk-like objects.
    // Many Ollama-like servers emit line-delimited JSON or SSE. We implement a
    // robust line-by-line reader and attempt to parse JSON from each non-empty line.
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          // Some servers prefix SSE lines with "data: "; remove if present
          const trimmed = line.replace(/^data:\s*/, '');
          try {
            const parsed = JSON.parse(trimmed);
            // Emit a minimal ChatCompletionChunk-compatible object
            const chunk: any = {
              id: parsed.id || undefined,
              object: 'chat.completion.chunk',
              model: parsed.model || undefined,
              choices: [
                {
                  delta: { content: parsed.text || parsed.output || '' },
                  index: 0,
                },
              ],
            };
            yield chunk;
          } catch (e) {
            // Not JSON - yield as text chunk
            const chunk: any = {
              id: undefined,
              object: 'chat.completion.chunk',
              model: undefined,
              choices: [
                { delta: { content: trimmed }, index: 0 },
              ],
            };
            yield chunk;
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          yield {
            id: parsed.id || undefined,
            object: 'chat.completion.chunk',
            model: parsed.model || undefined,
            choices: [{ delta: { content: parsed.text || parsed.output || '' }, index: 0 }],
          };
        } catch (e) {
          yield {
            id: undefined,
            object: 'chat.completion.chunk',
            model: undefined,
            choices: [{ delta: { content: buffer.trim() }, index: 0 }],
          };
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
}
