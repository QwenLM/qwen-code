/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';
import { BedrockClient } from '../../../utils/bedrockClient.js';
import {
  convertOpenAIToBedrock,
  convertBedrockToOpenAI,
  convertBedrockStreamToOpenAI,
} from './bedrockConverter.js';
import type { BedrockStreamEvent } from './bedrockTypes.js';

/**
 * Bedrock provider for AWS Bedrock Converse API
 * This provider converts between OpenAI format and Bedrock format
 */
export class BedrockOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  private cliConfig: Config;
  private bedrockClient: BedrockClient;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.cliConfig = cliConfig;

    // Initialize Bedrock client with region from config or environment
    this.bedrockClient = new BedrockClient({
      region:
        process.env['AWS_REGION'] ||
        process.env['AWS_DEFAULT_REGION'] ||
        'us-east-1',
      profile: process.env['AWS_PROFILE'],
      timeout: contentGeneratorConfig.timeout || DEFAULT_TIMEOUT,
      maxRetries: contentGeneratorConfig.maxRetries || DEFAULT_MAX_RETRIES,
    });
  }

  /**
   * Check if this is a Bedrock provider request
   */
  static isBedrockProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    return contentGeneratorConfig.authType === AuthType.USE_BEDROCK;
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    return {
      'User-Agent': `QwenCode/${version} (${process.platform}; ${process.arch})`,
    };
  }

  /**
   * Build a client - for Bedrock, we return a wrapper that converts to OpenAI format
   */
  buildClient(): OpenAI {
    // Create a minimal OpenAI-compatible object that delegates to Bedrock
    return {
      chat: {
        completions: {
          create: async (
            params: OpenAI.Chat.ChatCompletionCreateParams,
          ): Promise<
            | OpenAI.Chat.ChatCompletion
            | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
          > => {
            const modelId = params.model;

            // Convert request to Bedrock format
            const bedrockRequest = convertOpenAIToBedrock(params, modelId);

            if (params.stream) {
              // Streaming mode
              return this.createStreamingResponse(bedrockRequest, modelId);
            } else {
              // Non-streaming mode
              const bedrockResponse =
                await this.bedrockClient.converse(bedrockRequest);
              return convertBedrockToOpenAI(bedrockResponse, modelId);
            }
          },
        },
      },
    } as OpenAI;
  }

  /**
   * Create async iterable for streaming responses
   */
  private async *createStreamingResponse(
    bedrockRequest: ReturnType<typeof convertOpenAIToBedrock>,
    modelId: string,
  ): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
    // Collect stream events
    const events: BedrockStreamEvent[] = [];

    for await (const event of this.bedrockClient.converseStream(
      bedrockRequest,
    )) {
      events.push(event);
    }

    // Convert collected events to OpenAI format
    yield* convertBedrockStreamToOpenAI(events, modelId);
  }

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    // For Bedrock, we don't need to modify the request here
    // The conversion happens in buildClient()
    return request;
  }
}
