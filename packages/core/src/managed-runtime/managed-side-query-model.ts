/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  GoogleGenAI,
  type GenerateContentParameters,
  GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
} from '@google/genai';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { ManagedSideQueryError } from './managed-side-query.js';
import { normalizeOpenAiWireBaseUrl } from '../core/openaiContentGenerator/constants.js';

export interface ManagedSideQueryResult {
  outcome: string;
  text: string;
  usage?: GenerateContentResponseUsageMetadata;
}

async function collectStream(
  stream: AsyncIterable<GenerateContentResponse>,
  progress: (text: string) => void,
): Promise<ManagedSideQueryResult> {
  let text = '';
  let usage: GenerateContentResponseUsageMetadata | undefined;
  let completion = 'unknown_completion';
  let tool = false;
  let filtered = false;
  let truncated = false;
  for await (const response of stream) {
    const chunk = classifyManagedSideQueryResponse(response);
    text += chunk.text;
    if (chunk.text) progress(text);
    usage = chunk.usage ?? usage;
    tool ||= chunk.outcome === 'tool_request';
    filtered ||= chunk.outcome === 'filtered';
    truncated ||= chunk.outcome === 'truncated';
    if (chunk.outcome !== 'unknown_completion') completion = chunk.outcome;
  }
  if (completion === 'empty_response' && text.trim()) completion = 'success';
  return {
    text,
    usage,
    outcome: filtered
      ? 'filtered'
      : truncated
        ? 'truncated'
        : tool
          ? 'tool_request'
          : completion,
  };
}

export function classifyManagedSideQueryResponse(
  response: GenerateContentResponse,
): ManagedSideQueryResult {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((part) => !part.thought && !part.thoughtSignature)
    .map((part) => part.text ?? '')
    .join('');
  const reason = candidate?.finishReason;
  const outcome =
    response.promptFeedback?.blockReason ||
    [
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'IMAGE_SAFETY',
    ].includes(reason ?? '')
      ? 'filtered'
      : reason === 'MAX_TOKENS'
        ? 'truncated'
        : parts.some((part) => part.functionCall)
          ? 'tool_request'
          : reason === 'STOP'
            ? text.trim()
              ? 'success'
              : 'empty_response'
            : 'unknown_completion';
  return { outcome, text, usage: response.usageMetadata };
}

/** One SDK call; intentionally has no Config, Session, retry loop, or fallback. */
export async function generateManagedSideQuery(
  model: ContentGeneratorConfig,
  request: GenerateContentParameters,
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<ManagedSideQueryResult> {
  if (
    !model.apiKey ||
    !model.baseUrl ||
    !model.authType ||
    request.model !== model.model
  )
    throw new ManagedSideQueryError('model_config_unavailable');
  signal.throwIfAborted();
  const maxTokens = request.config?.maxOutputTokens;
  const sampling = model.samplingParams;
  const timeout = model.timeout ?? 300_000;
  const progress = (text: string): void => {
    if (Buffer.byteLength(text) > 512 * 1024)
      throw new ManagedSideQueryError('response_too_large');
    onProgress?.(text);
  };
  if (model.authType === AuthType.USE_GEMINI) {
    const client = new GoogleGenAI({
      apiKey: model.apiKey,
      vertexai: false,
      httpOptions: {
        baseUrl: model.baseUrl,
        timeout,
        retryOptions: { attempts: 1 },
      },
    });
    return collectStream(
      await client.models.generateContentStream({
        ...request,
        config: {
          ...request.config,
          temperature: sampling?.temperature,
          topP: sampling?.top_p,
          topK: sampling?.top_k,
          presencePenalty: sampling?.presence_penalty,
          frequencyPenalty: sampling?.frequency_penalty,
          seed:
            typeof sampling?.['seed'] === 'number'
              ? sampling['seed']
              : undefined,
          abortSignal: signal,
          httpOptions: { timeout, retryOptions: { attempts: 1 } },
        },
      }),
      progress,
    );
  }
  if (model.authType === AuthType.USE_ANTHROPIC) {
    const [{ default: Anthropic }, { AnthropicContentConverter }] =
      await Promise.all([
        import('@anthropic-ai/sdk'),
        import('../core/anthropicContentGenerator/converter.js'),
      ]);
    const hostname = new URL(model.baseUrl).hostname.toLowerCase();
    const native =
      hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
    const client = new Anthropic({
      ...(native
        ? { apiKey: model.apiKey, authToken: null }
        : { apiKey: null, authToken: model.apiKey }),
      baseURL: model.baseUrl,
      maxRetries: 0,
      timeout,
      defaultHeaders: native
        ? { 'User-Agent': 'QwenCode/side-query/1' }
        : {
            'User-Agent': 'claude-cli/unknown (external, cli)',
            'x-app': 'cli',
          },
    });
    const converter = new AnthropicContentConverter(model.model, 'auto', false);
    const converted = converter.convertLlmRequestToAnthropic(request, {
      stripAssistantThinking: true,
    });
    const stream = client.messages.stream(
      {
        model: model.model,
        ...converted,
        max_tokens: maxTokens ?? 4096,
        temperature: sampling?.temperature,
        top_p: sampling?.top_p,
        top_k: sampling?.top_k,
      },
      { signal, maxRetries: 0 },
    );
    let text = '';
    for await (const event of stream) {
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'text'
      ) {
        text += event.content_block.text;
        if (text) progress(text);
      }
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        text += event.delta.text;
        progress(text);
      }
    }
    const response = await stream.finalMessage();
    return classifyManagedSideQueryResponse(
      converter.convertAnthropicResponseToLlm(response),
    );
  }
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: model.apiKey,
    baseURL:
      model.authType === AuthType.USE_OPENAI_RESPONSES
        ? `${normalizeOpenAiWireBaseUrl(model.baseUrl)}/v1`
        : model.baseUrl,
    organization: null,
    project: null,
    maxRetries: 0,
    timeout,
  });
  if (model.authType === AuthType.USE_OPENAI_RESPONSES) {
    const {
      convertGeminiContentsToResponsesInput,
      convertResponsesEventToGemini,
      ResponsesStreamState,
    } = await import(
      '../core/openaiResponsesContentGenerator/responses-converter.js'
    );
    const converted = convertGeminiContentsToResponsesInput(request);
    const stream = await client.responses.create(
      {
        model: model.model,
        instructions: converted.instructions,
        input:
          converted.input as unknown as import('openai/resources/responses/responses.js').ResponseInput,
        max_output_tokens: maxTokens,
        temperature: sampling?.temperature,
        top_p: sampling?.top_p,
        store: false,
        stream: true,
      },
      { signal, maxRetries: 0 },
    );
    const state = new ResponsesStreamState();
    async function* convertedStream() {
      for await (const event of stream) {
        let response = convertResponsesEventToGemini(
          {
            event:
              event.type as import('../core/openaiResponsesContentGenerator/types.js').ResponsesSSEEvent['event'],
            data: event as unknown as Record<string, unknown>,
          },
          model.model,
          state,
        );
        const terminal =
          event.type === 'response.completed' ||
          event.type === 'response.incomplete';
        const refused =
          event.type.startsWith('response.refusal.') ||
          (terminal &&
            event.response.output?.some(
              (item) =>
                item.type === 'message' &&
                item.content.some((part) => part.type === 'refusal'),
            ));
        if (refused) {
          response ??= new GenerateContentResponse();
          response.candidates ??= [{}];
          response.candidates[0]!.finishReason = FinishReason.SAFETY;
        } else if (
          event.type === 'response.incomplete' &&
          !['max_output_tokens', 'content_filter'].includes(
            event.response.incomplete_details?.reason ?? '',
          ) &&
          response?.candidates?.[0]
        ) {
          response.candidates[0].finishReason =
            FinishReason.FINISH_REASON_UNSPECIFIED;
        }
        if (response) yield response;
      }
    }
    return collectStream(convertedStream(), progress);
  }
  if (model.authType !== AuthType.USE_OPENAI)
    throw new ManagedSideQueryError('model_config_unavailable');
  const { convertLlmRequestToOpenAI, convertOpenAIChunkToLlm } = await import(
    '../core/openaiContentGenerator/converter.js'
  );
  const { StreamingToolCallParser } = await import(
    '../core/openaiContentGenerator/streamingToolCallParser.js'
  );
  const context = {
    model: model.model,
    modalities: {},
    startTime: Date.now(),
    maxOutputTokens: maxTokens,
    toolCallParser: new StreamingToolCallParser(),
  };
  const stream = await client.chat.completions.create(
    {
      model: model.model,
      messages: convertLlmRequestToOpenAI(request, context),
      max_tokens: maxTokens,
      temperature: sampling?.temperature,
      top_p: sampling?.top_p,
      ...(sampling?.top_k !== undefined ? { top_k: sampling.top_k } : {}),
      presence_penalty: sampling?.presence_penalty,
      frequency_penalty: sampling?.frequency_penalty,
      seed:
        typeof sampling?.['seed'] === 'number' ? sampling['seed'] : undefined,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal, maxRetries: 0 },
  );
  async function* convertedStream() {
    for await (const chunk of stream) {
      const response = convertOpenAIChunkToLlm(chunk, context);
      const refusal = chunk.choices[0]?.delta.refusal;
      if (typeof refusal === 'string') {
        response.candidates ??= [{}];
        const candidate = response.candidates[0]!;
        candidate.content ??= { role: 'model', parts: [] };
        candidate.content.parts ??= [];
        candidate.content.parts.push({ text: refusal });
        candidate.finishReason = FinishReason.SAFETY;
      }
      yield response;
    }
  }
  return collectStream(convertedStream(), progress);
}
