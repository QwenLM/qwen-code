/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import type { GenerateContentParameters } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import type {
  ResponsesApiRequest,
  ResponsesApiReasoning,
  ResponsesSSEEvent,
  ResponsesSSEEventType,
} from './types.js';
import {
  ResponsesStreamState,
  convertResponsesEventToGemini,
  convertGeminiContentsToResponsesInput,
  convertGeminiToolsToResponsesTools,
  cleanOrphanedFunctionCalls,
} from './responses-converter.js';
import { buildRuntimeFetchOptions } from '../../utils/runtimeFetchOptions.js';
import { createHash } from 'node:crypto';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('RESPONSES_PIPELINE');

export class ResponsesPipeline {
  private readonly config: ContentGeneratorConfig;
  private readonly cliConfig: Config;

  constructor(config: ContentGeneratorConfig, cliConfig: Config) {
    this.config = config;
    this.cliConfig = cliConfig;
  }

  async *executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const activeRequest = this.buildRequest(request, userPromptId);
    const streamState = new ResponsesStreamState();
    yield* this.streamRequest(activeRequest, streamState, signal);
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): Promise<GenerateContentResponse> {
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of this.executeStream(
      request,
      userPromptId,
      signal,
    )) {
      chunks.push(chunk);
    }
    return mergeStreamResponses(chunks);
  }

  private buildRequest(
    request: GenerateContentParameters,
    userPromptId: string,
  ): ResponsesApiRequest {
    const { instructions, input } =
      convertGeminiContentsToResponsesInput(request);
    const tools = convertGeminiToolsToResponsesTools(request);

    // History is always re-derived in full from this app's own Content[]
    // (matching every other content generator in this codebase) rather than
    // continued via previous_response_id, so context editing, compaction, and
    // mid-session model switching all keep working the same way they already
    // do for the other wires.
    const reasoning = this.buildReasoning();

    const apiRequest: ResponsesApiRequest = {
      model: this.config.model,
      input: cleanOrphanedFunctionCalls(input),
      instructions,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
      prompt_cache_key: sanitizePromptCacheKey(userPromptId),
      // We never reference previous_response_id, so server-side storage of
      // the response buys nothing. The spec pairs reasoning.encrypted_content
      // with store:false as the intended stateless-replay recipe — set it
      // unconditionally for consistency, not just when reasoning is on.
      store: false,
    };

    // Map Gemini-style toolConfig.functionCallingConfig.mode to the
    // Responses API's tool_choice, mirroring the Chat Completions and
    // Anthropic pipelines. Without this, structured side queries that force
    // tool use (e.g. baseLlmClient's respond_in_schema) fall back to
    // tool_choice:auto and reasoning-heavy models may skip the tool call
    // entirely.
    if (tools && tools.length > 0) {
      const fcMode = request.config?.toolConfig?.functionCallingConfig?.mode;
      if (fcMode === 'ANY') {
        apiRequest.tool_choice = 'required';
      } else if (fcMode === 'NONE') {
        apiRequest.tool_choice = 'none';
      }
    }

    if (reasoning) {
      apiRequest.reasoning = reasoning;
      // Request the encrypted reasoning blob so prior-turn thinking can be
      // replayed on the next turn via part.thoughtSignature. See
      // responses-converter.ts for the encode/decode side of this round trip.
      apiRequest.include = ['reasoning.encrypted_content'];
    }

    if (this.config.samplingParams) {
      if (this.config.samplingParams.temperature != null) {
        apiRequest.temperature = this.config.samplingParams.temperature;
      }
      if (this.config.samplingParams.top_p != null) {
        apiRequest.top_p = this.config.samplingParams.top_p;
      }
      if (this.config.samplingParams.max_tokens != null) {
        apiRequest.max_output_tokens = this.config.samplingParams.max_tokens;
      }
    }

    if (this.config.extra_body) {
      const requestRecord = apiRequest as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(this.config.extra_body)) {
        // apiRequest is built from an object literal, so optional fields
        // like `tools`/`instructions` are already present as keys even when
        // their value is undefined — check the value, not just key presence,
        // so extra_body can still fill in a field nothing else set.
        if (!(key in requestRecord) || requestRecord[key] === undefined) {
          requestRecord[key] = value;
        }
      }
    }

    return apiRequest;
  }

  private buildReasoning(): ResponsesApiReasoning | undefined {
    const r = this.config.reasoning;
    if (r === false || r === undefined) return undefined;

    const reasoning: ResponsesApiReasoning = {};
    // The Responses API reasoning.effort enum (none, minimal, low, medium,
    // high, xhigh, max) is a superset of the unified ladder, so every tier
    // passes through verbatim with no clamping.
    if (r.effort) {
      reasoning.effort = r.effort;
      // 'auto' is required to receive reasoning_summary_text.delta events at
      // all; the unified reasoning config has no separate summary knob.
      reasoning.summary = 'auto';
    }

    return Object.keys(reasoning).length > 0 ? reasoning : undefined;
  }

  private async *streamRequest(
    apiRequest: ResponsesApiRequest,
    streamState: ResponsesStreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const baseUrl = (this.config.baseUrl ?? 'https://api.openai.com')
      .replace(/\/v1\/?$/, '')
      .replace(/\/$/, '');
    const url = `${baseUrl}/v1/responses`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    const apiKey =
      this.config.apiKey ??
      (this.config.apiKeyEnvKey
        ? process.env[this.config.apiKeyEnvKey]
        : undefined);
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (this.config.customHeaders) {
      Object.assign(headers, this.config.customHeaders);
    }

    const body = JSON.stringify(apiRequest);
    debugLogger.debug(`POST ${url}`, body.substring(0, 500));

    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers,
      body,
      signal,
    };

    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    if (runtimeOptions?.fetchOptions?.dispatcher) {
      fetchOpts.dispatcher = runtimeOptions.fetchOptions.dispatcher;
    }

    const response = await fetch(url, fetchOpts as RequestInit);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err = new Error(
        `Responses API error ${response.status}: ${errBody.substring(0, 500)}`,
      );
      (err as ResponsesApiError).status = response.status;
      (err as ResponsesApiError).responseBody = errBody;
      throw err;
    }

    if (!response.body) {
      throw new Error('Responses API returned no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType: ResponsesSSEEventType | null = null;
    let dataAccumulator = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim() as ResponsesSSEEventType;
            dataAccumulator = '';
            continue;
          }

          if (line.startsWith('data: ')) {
            const dataContent = line.slice(6);
            if (dataContent === '[DONE]') continue;

            if (currentEventType) {
              dataAccumulator += (dataAccumulator ? '\n' : '') + dataContent;
            } else {
              try {
                const data = JSON.parse(dataContent) as Record<string, unknown>;
                const eventType = data['type'] as
                  | ResponsesSSEEventType
                  | undefined;
                if (eventType) {
                  const sseEvent: ResponsesSSEEvent = {
                    event: eventType,
                    data,
                  };
                  const geminiResp = convertResponsesEventToGemini(
                    sseEvent,
                    this.config.model,
                    streamState,
                  );
                  if (geminiResp) {
                    yield geminiResp;
                  }
                }
              } catch (err) {
                if (err instanceof SyntaxError) {
                  debugLogger.debug(
                    `Failed to parse SSE data: ${dataContent.substring(0, 200)}`,
                  );
                } else {
                  throw err;
                }
              }
            }
            continue;
          }

          if (line.trim() === '' && currentEventType && dataAccumulator) {
            try {
              const data = JSON.parse(dataAccumulator) as Record<
                string,
                unknown
              >;
              const sseEvent: ResponsesSSEEvent = {
                event: currentEventType,
                data,
              };
              const geminiResp = convertResponsesEventToGemini(
                sseEvent,
                this.config.model,
                streamState,
              );
              if (geminiResp) {
                yield geminiResp;
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                debugLogger.debug(
                  `Failed to parse SSE data: ${dataAccumulator.substring(0, 200)}`,
                );
              } else {
                throw err;
              }
            }
            currentEventType = null;
            dataAccumulator = '';
          } else if (line.trim() === '') {
            currentEventType = null;
            dataAccumulator = '';
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

function sanitizePromptCacheKey(key: string): string {
  if (key.length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, PROMPT_CACHE_KEY_MAX_LENGTH);
}

interface ResponsesApiError extends Error {
  status: number;
  responseBody: string;
}

export function mergeStreamResponses(
  chunks: GenerateContentResponse[],
): GenerateContentResponse {
  if (chunks.length === 0) {
    const empty = new GenerateContentResponse();
    empty.candidates = [];
    return empty;
  }
  if (chunks.length === 1) return chunks[0]!;

  const allParts = chunks.flatMap(
    (c) => c.candidates?.[0]?.content?.parts ?? [],
  );

  const usageChunk = [...chunks].reverse().find((c) => c.usageMetadata);
  const finishChunk = [...chunks]
    .reverse()
    .find((c) => c.candidates?.[0]?.finishReason);
  const finishReason = finishChunk?.candidates?.[0]?.finishReason;

  const merged = new GenerateContentResponse();
  merged.responseId = chunks.find((c) => c.responseId)?.responseId;
  merged.modelVersion = chunks[0]?.modelVersion;
  merged.createTime = chunks[0]?.createTime;
  if (usageChunk?.usageMetadata) {
    merged.usageMetadata = usageChunk.usageMetadata;
  }

  merged.candidates = [
    {
      content: { parts: allParts, role: 'model' as const },
      index: 0,
      safetyRatings: [],
      ...(finishReason ? { finishReason } : {}),
    },
  ];
  return merged;
}
