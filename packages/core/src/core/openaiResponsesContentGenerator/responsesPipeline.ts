/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import type { GenerateContentParameters } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type {
  ResponsesApiRequest,
  ResponsesApiReasoning,
  ResponsesApiTextControls,
  ResponsesSSEEvent,
  ResponsesSSEEventType,
  ResponsesApiInputItem,
} from './types.js';
import {
  ResponsesStreamState,
  convertResponsesEventToGemini,
  convertGeminiContentsToResponsesInput,
  convertGeminiToolsToResponsesTools,
} from './responsesConverter.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('RESPONSES_PIPELINE');

export interface ResponsesPipelineState {
  lastResponseId: string | null;
  lastInputItemCount: number;
  pendingEncryptedItems: Array<{ type: string; id?: string; encrypted_content: string }>;
}

export class ResponsesPipeline {
  private readonly config: ContentGeneratorConfig;
  private readonly state: ResponsesPipelineState = {
    lastResponseId: null,
    lastInputItemCount: 0,
    pendingEncryptedItems: [],
  };

  constructor(config: ContentGeneratorConfig) {
    this.config = config;
  }

  async *executeStream(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const apiRequest = this.buildRequest(request, userPromptId);
    const streamState = new ResponsesStreamState();

    try {
      yield* this.streamRequest(apiRequest, streamState, signal);
    } catch (error) {
      if (
        this.state.lastResponseId &&
        isResponseExpiredError(error)
      ) {
        debugLogger.debug(
          'previous_response_id expired, retrying with full input',
        );
        this.state.lastResponseId = null;
        this.state.lastInputItemCount = 0;
        const retryRequest = this.buildRequest(request, userPromptId);
        streamState.reset();
        yield* this.streamRequest(retryRequest, streamState, signal);
      } else {
        throw error;
      }
    }

    if (streamState.responseId) {
      this.state.lastResponseId = streamState.responseId;
      this.state.lastInputItemCount =
        (apiRequest.input?.length ?? 0);
    }
    if (streamState.encryptedContentItems.length > 0) {
      this.state.pendingEncryptedItems.push(
        ...streamState.encryptedContentItems,
      );
    }
  }

  async execute(
    request: GenerateContentParameters,
    userPromptId: string,
    signal?: AbortSignal,
  ): Promise<GenerateContentResponse> {
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of this.executeStream(request, userPromptId, signal)) {
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

    if (this.state.pendingEncryptedItems.length > 0) {
      for (const item of this.state.pendingEncryptedItems) {
        input.push(item as ResponsesApiInputItem);
      }
      this.state.pendingEncryptedItems = [];
    }

    let effectiveInput: ResponsesApiInputItem[];
    let previousResponseId: string | undefined;

    if (
      this.state.lastResponseId &&
      input.length > this.state.lastInputItemCount
    ) {
      previousResponseId = this.state.lastResponseId;
      effectiveInput = input.slice(this.state.lastInputItemCount);
    } else {
      effectiveInput = input;
    }

    const reasoning = this.buildReasoning();
    const text = this.buildTextControls();

    const apiRequest: ResponsesApiRequest = {
      model: this.config.model,
      input: effectiveInput,
      instructions,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      truncation: { type: 'auto' },
      stream: true,
      store: true,
      prompt_cache_key: userPromptId,
    };

    if (previousResponseId) {
      apiRequest.previous_response_id = previousResponseId;
    }

    if (reasoning) {
      apiRequest.reasoning = reasoning;
      apiRequest.include = ['reasoning.encrypted_content'];
    }

    if (text) {
      apiRequest.text = text;
    }

    const serviceTier = this.config.serviceTier;
    if (serviceTier) {
      apiRequest.service_tier = serviceTier as 'auto' | 'priority';
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
      for (const [key, value] of Object.entries(this.config.extra_body)) {
        if (!(key in apiRequest)) {
          (apiRequest as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }

    return apiRequest;
  }

  private buildReasoning(): ResponsesApiReasoning | undefined {
    const r = this.config.reasoning;
    if (r === false || r === undefined) return undefined;

    const reasoning: ResponsesApiReasoning = {};
    if (r.effort) reasoning.effort = r.effort;

    if (r.summary) {
      reasoning.summary = r.summary;
    } else if (r.effort) {
      reasoning.summary = 'auto';
    }

    return Object.keys(reasoning).length > 0 ? reasoning : undefined;
  }

  private buildTextControls(): ResponsesApiTextControls | undefined {
    const verbosity = this.config.verbosity;
    if (!verbosity) return undefined;
    return { verbosity: verbosity as 'low' | 'medium' | 'high' };
  }

  private async *streamRequest(
    apiRequest: ResponsesApiRequest,
    streamState: ResponsesStreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com';
    const url = `${baseUrl.replace(/\/$/, '')}/v1/responses`;

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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });

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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEventType: ResponsesSSEEventType | null = null;

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim() as ResponsesSSEEventType;
          } else if (line.startsWith('data: ') && currentEventType) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr) as Record<string, unknown>;
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
            } catch {
              debugLogger.debug(`Failed to parse SSE data: ${dataStr}`);
            }
            currentEventType = null;
          } else if (line.trim() === '') {
            currentEventType = null;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  getState(): Readonly<ResponsesPipelineState> {
    return this.state;
  }

  resetState(): void {
    this.state.lastResponseId = null;
    this.state.lastInputItemCount = 0;
    this.state.pendingEncryptedItems = [];
  }
}

interface ResponsesApiError extends Error {
  status: number;
  responseBody: string;
}

function isResponseExpiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const apiError = error as Partial<ResponsesApiError>;
  if (apiError.status === 404 || apiError.status === 400) {
    const body = apiError.responseBody ?? error.message;
    return (
      body.includes('previous_response_id') ||
      body.includes('response_not_found') ||
      body.includes('expired')
    );
  }
  return false;
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

  const last = chunks[chunks.length - 1]!;
  const allParts = chunks.flatMap(
    (c) => c.candidates?.[0]?.content?.parts ?? [],
  );

  const merged = new GenerateContentResponse();
  Object.assign(merged, last);
  if (merged.candidates?.[0]) {
    merged.candidates = [
      {
        ...merged.candidates[0],
        content: { parts: allParts, role: 'model' as const },
      },
    ];
  }
  return merged;
}
