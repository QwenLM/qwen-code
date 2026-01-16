import type OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
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
    const headersObj = this.buildHeaders();

    console.log('[Ollama Provider] Initializing client with baseUrl:', baseUrl);

    // Minimal client implementation
    const client: any = {
      chat: {
        completions: {
          create: async (request: OpenAI.Chat.ChatCompletionCreateParams, opts?: any) => {
            const mapped = this.mapRequest(request);
            const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

            console.log('[Ollama Provider] Making request to:', url);
            console.log('[Ollama Provider] Request payload:', JSON.stringify(mapped, null, 2));
            console.log('[Ollama Provider] Streaming:', (request as any).stream);
            console.log('[Ollama Provider] Signal:', opts?.signal ? 'provided' : 'none');

            // If streaming requested, return an async iterable
            if ((request as any).stream) {
              console.log('[Ollama Provider] Starting streaming request...');
              
              // Check if signal is already aborted before making the request
              if (opts?.signal?.aborted) {
                console.log('[Ollama Provider] Signal already aborted before fetch, returning early');
                throw new DOMException('This operation was aborted', 'AbortError');
              }
              
              try {
                const response = await fetch(url, {
                  method: 'POST',
                  headers: headersObj as HeadersInit,
                  body: JSON.stringify(mapped),
                  // signal may be provided via opts
                  signal: opts?.signal,
                });

                console.log('[Ollama Provider] Response received. Status:', response.status, response.statusText);
                console.log('[Ollama Provider] Response headers:', Object.fromEntries(response.headers.entries()));

                if (!response.ok) {
                  const errorText = await response.text().catch(() => 'Unknown error');
                  console.error('[Ollama Provider] API Error:', errorText);
                  throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${errorText}`);
                }

                console.log('[Ollama Provider] Creating stream iterable...');
                return this.createStreamIterable(response);
              } catch (error: any) {
                console.error('[Ollama Provider] Fetch error:', error);
                console.error('[Ollama Provider] Error name:', error.name);
                console.error('[Ollama Provider] Error message:', error.message);
                console.error('[Ollama Provider] Error code:', error.code);
                console.error('[Ollama Provider] Error stack:', error.stack);
                
                // Check signal state after error
                if (opts?.signal) {
                  console.error('[Ollama Provider] Signal state after error:');
                  console.error('[Ollama Provider]   - Signal.aborted:', opts.signal.aborted);
                  console.error('[Ollama Provider]   - Abort reason:', opts.signal.reason);
                }
                
                throw error;
              }
            }

            console.log('[Ollama Provider] Starting non-streaming request...');
            // Check if signal is already aborted before making the request
                          if (opts?.signal?.aborted) {
                            console.log('[Ollama Provider] Signal already aborted before fetch, returning early');
                            throw new DOMException('This operation was aborted', 'AbortError');
                          }
                          
                          const response = await fetch(url, {
                            method: 'POST',
                            headers: headersObj as HeadersInit,
                            body: JSON.stringify(mapped),
                            signal: opts?.signal,
                          });
            if (!response.ok) {
              const errorText = await response.text().catch(() => 'Unknown error');
              throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const json = await response.json().catch(() => ({}));

            // Map Ollama /api/chat response to OpenAI.Chat.ChatCompletion-like object
            const openaiResponse: any = {
              id: json.id || json.uuid || 'ollama-response',
              object: 'chat.completion',
              created: Date.now() / 1000,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: json.message?.content || '' },
                  finish_reason: json.done_reason || 'stop',
                },
              ],
              usage: {
                prompt_tokens: json.prompt_eval_count,
                completion_tokens: json.eval_count,
                total_tokens: (json.prompt_eval_count || 0) + (json.eval_count || 0),
              },
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
    // Convert OpenAI-style chat request into Ollama /api/chat payload.
    // Ollama /api/chat accepts messages array similar to OpenAI format.
    const messages = (request.messages || []).map((m: any) => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map((p: any) => p.text || p).join('')
        : m.content,
    }));

    console.log('[Ollama Provider] Mapping request. Original model:', request.model);
    console.log('[Ollama Provider] Messages count:', messages.length);

    const payload: any = {
      model: request.model,
      messages,
      stream: (request as any).stream !== false, // Default to streaming
    };

    // Map generation config options
    const options: any = {};
    if ((request as any).temperature !== undefined) options.temperature = (request as any).temperature;
    if ((request as any).max_tokens !== undefined) options.num_predict = (request as any).max_tokens;
    if ((request as any).top_p !== undefined) options.top_p = (request as any).top_p;
    if ((request as any).frequency_penalty !== undefined) options.frequency_penalty = (request as any).frequency_penalty;
    if ((request as any).presence_penalty !== undefined) options.presence_penalty = (request as any).presence_penalty;

    if (Object.keys(options).length > 0) {
      payload.options = options;
      console.log('[Ollama Provider] Generation options:', options);
    }

    console.log('[Ollama Provider] Mapped payload:', JSON.stringify(payload, null, 2));

    return payload;
  }

  private async *createStreamIterable(response: Response): AsyncIterable<any> {
    // Create an async iterable that yields OpenAI.Chat.ChatCompletionChunk-like objects.
    // Ollama /api/chat emits line-delimited JSON. We implement a
    // robust line-by-line reader and attempt to parse JSON from each non-empty line.
    const reader = response.body?.getReader();
    if (!reader) {
      console.error('[Ollama Provider] No reader available for response body');
      return;
    }

    console.log('[Ollama Provider] Stream iterable created. Starting to read stream...');

    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.log('[Ollama Provider] Stream reading completed. Total chunks:', chunkCount);
          break;
        }

        const decoded = decoder.decode(value, { stream: true });
        buffer += decoded;

        console.log('[Ollama Provider] Received data chunk. Size:', value.length, 'bytes. Buffer length:', buffer.length);

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          console.log('[Ollama Provider] Processing line:', line.substring(0, 100) + (line.length > 100 ? '...' : ''));

          // Some servers prefix SSE lines with "data: "; remove if present
          const trimmed = line.replace(/^data:\s*/, '');
          try {
            const parsed = JSON.parse(trimmed);
            console.log('[Ollama Provider] Parsed JSON:', JSON.stringify(parsed, null, 2));

            // Extract content from Ollama /api/chat response format
            const content = parsed.message?.content || '';

            // Skip empty content chunks
            if (!content && !parsed.done) {
              console.log('[Ollama Provider] Skipping empty content chunk (not done yet)');
              continue;
            }

            chunkCount++;

            // Emit a minimal ChatCompletionChunk-compatible object
            const chunk: any = {
              id: parsed.id || undefined,
              object: 'chat.completion.chunk',
              model: parsed.model || undefined,
              choices: [
                {
                  delta: { content },
                  index: 0,
                  finish_reason: parsed.done ? parsed.done_reason : undefined,
                },
              ],
            };

            // Add usage info if available in final chunk
            if (parsed.done) {
              chunk.usage = {
                prompt_tokens: parsed.prompt_eval_count,
                completion_tokens: parsed.eval_count,
                total_tokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0),
              };
              console.log('[Ollama Provider] Final chunk received. Done reason:', parsed.done_reason);
            }

            console.log('[Ollama Provider] Yielding chunk #', chunkCount, 'with content length:', content.length);
            yield chunk;
          } catch (e) {
            console.error('[Ollama Provider] Failed to parse line as JSON:', trimmed);
            console.error('[Ollama Provider] Parse error:', e);
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
        console.log('[Ollama Provider] Flushing remaining buffer:', buffer.substring(0, 100) + (buffer.length > 100 ? '...' : ''));
        try {
          const parsed = JSON.parse(buffer.trim());
          const content = parsed.message?.content || '';
          yield {
            id: parsed.id || undefined,
            object: 'chat.completion.chunk',
            model: parsed.model || undefined,
            choices: [{ delta: { content }, index: 0 }],
          };
        } catch (e) {
          console.error('[Ollama Provider] Failed to parse remaining buffer:', e);
          yield {
            id: undefined,
            object: 'chat.completion.chunk',
            model: undefined,
            choices: [{ delta: { content: buffer.trim() }, index: 0 }],
          };
        }
      }
    } catch (error: any) {
      console.error('[Ollama Provider] Error in stream iterable:', error);
      console.error('[Ollama Provider] Error name:', error.name);
      console.error('[Ollama Provider] Error message:', error.message);
      console.error('[Ollama Provider] Error stack:', error.stack);
      throw error;
    } finally {
      try {
        console.log('[Ollama Provider] Releasing reader lock...');
        reader.releaseLock();
      } catch (e) {
        console.error('[Ollama Provider] Error releasing reader lock:', e);
      }
    }
  }
}
