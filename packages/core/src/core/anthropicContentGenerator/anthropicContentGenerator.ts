/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
type Message = Anthropic.Message;
type MessageCreateParamsNonStreaming =
  Anthropic.MessageCreateParamsNonStreaming;
type MessageCreateParamsStreaming = Anthropic.MessageCreateParamsStreaming;
type RawMessageStreamEvent = Anthropic.RawMessageStreamEvent;
import { getDefaultTokenizer } from '../../utils/request-tokenizer/index.js';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { AnthropicContentConverter } from './converter.js';

type StreamingBlockState = {
  type: string;
  id?: string;
  name?: string;
  inputJson: string;
  signature: string;
};

type MessageCreateParamsWithThinking = MessageCreateParamsNonStreaming & {
  thinking?: { type: 'enabled'; budget_tokens: number };
  // Anthropic beta feature: output_config.effort (requires beta header effort-2025-11-24)
  // This is not yet represented in the official SDK types we depend on.
  output_config?: { effort: 'low' | 'medium' | 'high' };
};

export class AnthropicContentGenerator implements ContentGenerator {
  private client: Anthropic;
  private converter: AnthropicContentConverter;

  constructor(
    private contentGeneratorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
  ) {
    const defaultHeaders = this.buildHeaders();
    const baseURL = contentGeneratorConfig.baseUrl;

    this.client = new Anthropic({
      apiKey: contentGeneratorConfig.apiKey,
      baseURL,
      timeout: contentGeneratorConfig.timeout,
      maxRetries: contentGeneratorConfig.maxRetries,
      defaultHeaders,
    });

    this.converter = new AnthropicContentConverter(
      contentGeneratorConfig.model,
      contentGeneratorConfig.schemaCompliance,
    );
  }

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const anthropicRequest = await this.buildRequest(request);
    const response = (await this.client.messages.create(anthropicRequest, {
      signal: request.config?.abortSignal,
    })) as Message;

    return this.converter.convertAnthropicResponseToGemini(response);
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const anthropicRequest = await this.buildRequest(request);
    const streamingRequest: MessageCreateParamsStreaming & {
      thinking?: { type: 'enabled'; budget_tokens: number };
    } = {
      ...anthropicRequest,
      stream: true,
    };

    const stream = (await this.client.messages.create(
      streamingRequest as MessageCreateParamsStreaming,
      {
        signal: request.config?.abortSignal,
      },
    )) as AsyncIterable<RawMessageStreamEvent>;

    return this.processStream(stream);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    try {
      const tokenizer = getDefaultTokenizer();
      const result = await tokenizer.calculateTokens(request, {
        textEncoding: 'cl100k_base',
      });

      return {
        totalTokens: result.totalTokens,
      };
    } catch (error) {
      console.warn(
        'Failed to calculate tokens with tokenizer, ' +
          'falling back to simple method:',
        error,
      );

      const content = JSON.stringify(request.contents);
      const totalTokens = Math.ceil(content.length / 4);
      return {
        totalTokens,
      };
    }
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Anthropic does not support embeddings.');
  }

  useSummarizedThinking(): boolean {
    return false;
  }

  private buildHeaders(): Record<string, string> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;

    const betas: string[] = [];
    const reasoning = this.contentGeneratorConfig.reasoning;

    // Interleaved thinking is used when we send the `thinking` field.
    if (reasoning !== false) {
      betas.push('interleaved-thinking-2025-05-14');
    }

    // Effort (beta) is enabled when reasoning.effort is set.
    if (reasoning !== false && reasoning?.effort !== undefined) {
      betas.push('effort-2025-11-24');
    }

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
    };

    if (betas.length) {
      headers['anthropic-beta'] = betas.join(',');
    }

    return headers;
  }

  private async buildRequest(
    request: GenerateContentParameters,
  ): Promise<MessageCreateParamsWithThinking> {
    const { system, messages } =
      this.converter.convertGeminiRequestToAnthropic(request);

    const tools = request.config?.tools
      ? await this.converter.convertGeminiToolsToAnthropic(request.config.tools)
      : undefined;

    const sampling = this.buildSamplingParameters(request);
    const thinking = this.buildThinkingConfig(request);
    const outputConfig = this.buildOutputConfig();

    return {
      model: this.contentGeneratorConfig.model,
      system,
      messages,
      tools,
      ...sampling,
      ...(thinking ? { thinking } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };
  }

  private buildSamplingParameters(request: GenerateContentParameters): {
    max_tokens: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
  } {
    const configSamplingParams = this.contentGeneratorConfig.samplingParams;
    const requestConfig = request.config || {};

    const getParam = <T>(
      configKey: keyof NonNullable<typeof configSamplingParams>,
      requestKey?: keyof NonNullable<typeof requestConfig>,
    ): T | undefined => {
      const configValue = configSamplingParams?.[configKey] as T | undefined;
      const requestValue = requestKey
        ? (requestConfig[requestKey] as T | undefined)
        : undefined;
      return configValue !== undefined ? configValue : requestValue;
    };

    const maxTokens =
      getParam<number>('max_tokens', 'maxOutputTokens') ?? 10_000;

    return {
      max_tokens: maxTokens,
      temperature: getParam<number>('temperature', 'temperature') ?? 1,
      top_p: getParam<number>('top_p', 'topP'),
      top_k: getParam<number>('top_k', 'topK'),
    };
  }

  private buildThinkingConfig(
    request: GenerateContentParameters,
  ): { type: 'enabled'; budget_tokens: number } | undefined {
    if (request.config?.thinkingConfig?.includeThoughts === false) {
      return undefined;
    }

    const reasoning = this.contentGeneratorConfig.reasoning;

    if (reasoning === false) {
      return undefined;
    }

    if (reasoning?.budget_tokens !== undefined) {
      return {
        type: 'enabled',
        budget_tokens: reasoning.budget_tokens,
      };
    }

    const effort = reasoning?.effort;
    // When using interleaved thinking with tools, this budget token limit is the entire context window(200k tokens).
    const budgetTokens =
      effort === 'low' ? 16_000 : effort === 'high' ? 64_000 : 32_000;

    return {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
  }

  private buildOutputConfig():
    | { effort: 'low' | 'medium' | 'high' }
    | undefined {
    const reasoning = this.contentGeneratorConfig.reasoning;
    if (reasoning === false || reasoning === undefined) {
      return undefined;
    }

    if (reasoning.effort === undefined) {
      return undefined;
    }

    return { effort: reasoning.effort };
  }

  private async *processStream(
    stream: AsyncIterable<RawMessageStreamEvent>,
  ): AsyncGenerator<GenerateContentResponse> {
    let messageId: string | undefined;
    let model = this.contentGeneratorConfig.model;
    let cachedTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: string | undefined;

    const blocks = new Map<number, StreamingBlockState>();
    const collectedResponses: GenerateContentResponse[] = [];

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          messageId = event.message.id ?? messageId;
          model = event.message.model ?? model;
          cachedTokens =
            event.message.usage?.cache_read_input_tokens ?? cachedTokens;
          promptTokens = event.message.usage?.input_tokens ?? promptTokens;
          break;
        }
        case 'content_block_start': {
          const index = event.index ?? 0;
          const type = String(event.content_block.type || 'text');
          const initialInput =
            type === 'tool_use' && 'input' in event.content_block
              ? JSON.stringify(event.content_block.input)
              : '';
          blocks.set(index, {
            type,
            id:
              'id' in event.content_block ? event.content_block.id : undefined,
            name:
              'name' in event.content_block
                ? event.content_block.name
                : undefined,
            inputJson: initialInput !== '{}' ? initialInput : '',
            signature:
              type === 'thinking' &&
              'signature' in event.content_block &&
              typeof event.content_block.signature === 'string'
                ? event.content_block.signature
                : '',
          });
          break;
        }
        case 'content_block_delta': {
          const index = event.index ?? 0;
          const deltaType = (event.delta as { type?: string }).type || '';
          const blockState = blocks.get(index);

          if (deltaType === 'text_delta') {
            const text = 'text' in event.delta ? event.delta.text : '';
            if (text) {
              const chunk = this.buildGeminiChunk({ text }, messageId, model);
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'thinking_delta') {
            const thinking =
              (event.delta as { thinking?: string }).thinking || '';
            if (thinking) {
              const chunk = this.buildGeminiChunk(
                { text: thinking, thought: true },
                messageId,
                model,
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'signature_delta' && blockState) {
            const signature =
              (event.delta as { signature?: string }).signature || '';
            if (signature) {
              blockState.signature += signature;
              const chunk = this.buildGeminiChunk(
                { thought: true, thoughtSignature: signature },
                messageId,
                model,
              );
              collectedResponses.push(chunk);
              yield chunk;
            }
          } else if (deltaType === 'input_json_delta' && blockState) {
            const jsonDelta =
              (event.delta as { partial_json?: string }).partial_json || '';
            if (jsonDelta) {
              blockState.inputJson += jsonDelta;
            }
          }
          break;
        }
        case 'content_block_stop': {
          const index = event.index ?? 0;
          const blockState = blocks.get(index);
          if (blockState?.type === 'tool_use') {
            const args = safeJsonParse(blockState.inputJson || '{}', {});
            const chunk = this.buildGeminiChunk(
              {
                functionCall: {
                  id: blockState.id,
                  name: blockState.name,
                  args,
                },
              },
              messageId,
              model,
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          blocks.delete(index);
          break;
        }
        case 'message_delta': {
          const stopReasonValue = event.delta.stop_reason;
          if (stopReasonValue) {
            finishReason = stopReasonValue;
          }

          // Some Anthropic-compatible providers may include additional usage fields
          // (e.g. `input_tokens`, `cache_read_input_tokens`) even though the official
          // Anthropic SDK types only expose `output_tokens` here.
          const usageUnknown = event.usage as unknown;
          const usageRecord =
            usageUnknown && typeof usageUnknown === 'object'
              ? (usageUnknown as Record<string, unknown>)
              : undefined;

          if (event.usage?.output_tokens !== undefined) {
            completionTokens = event.usage.output_tokens;
          }
          if (usageRecord?.['input_tokens'] !== undefined) {
            const inputTokens = usageRecord['input_tokens'];
            if (typeof inputTokens === 'number') {
              promptTokens = inputTokens;
            }
          }
          if (usageRecord?.['cache_read_input_tokens'] !== undefined) {
            const cacheRead = usageRecord['cache_read_input_tokens'];
            if (typeof cacheRead === 'number') {
              cachedTokens = cacheRead;
            }
          }

          if (finishReason || event.usage) {
            const chunk = this.buildGeminiChunk(
              undefined,
              messageId,
              model,
              finishReason,
              {
                cachedContentTokenCount: cachedTokens,
                promptTokenCount: cachedTokens + promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: cachedTokens + promptTokens + completionTokens,
              },
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        case 'message_stop': {
          if (promptTokens || completionTokens) {
            const chunk = this.buildGeminiChunk(
              undefined,
              messageId,
              model,
              finishReason,
              {
                cachedContentTokenCount: cachedTokens,
                promptTokenCount: cachedTokens + promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: cachedTokens + promptTokens + completionTokens,
              },
            );
            collectedResponses.push(chunk);
            yield chunk;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private buildGeminiChunk(
    part?: {
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: unknown;
    },
    responseId?: string,
    model?: string,
    finishReason?: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
  ): GenerateContentResponse {
    const response = new GenerateContentResponse();
    response.responseId = responseId;
    response.createTime = Date.now().toString();
    response.modelVersion = model || this.contentGeneratorConfig.model;
    response.promptFeedback = { safetyRatings: [] };

    const candidateParts = part ? [part as unknown as Part] : [];
    const mappedFinishReason =
      finishReason !== undefined
        ? this.converter.mapAnthropicFinishReasonToGemini(finishReason)
        : undefined;
    response.candidates = [
      {
        content: {
          parts: candidateParts,
          role: 'model' as const,
        },
        index: 0,
        safetyRatings: [],
        ...(mappedFinishReason ? { finishReason: mappedFinishReason } : {}),
      },
    ];

    if (usageMetadata) {
      response.usageMetadata = usageMetadata;
    }

    return response;
  }
}
