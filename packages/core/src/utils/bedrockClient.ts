/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { fromEnv, fromIni } from '@aws-sdk/credential-providers';
import type {
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockStreamEvent,
} from '../core/openaiContentGenerator/provider/bedrock/types.js';
import { getBedrockModelId } from '../core/openaiContentGenerator/provider/bedrock/types.js';

/**
 * Configuration for Bedrock client
 */
export interface BedrockClientConfig {
  region?: string;
  profile?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Wrapper around AWS Bedrock Runtime Client with convenience methods
 */
export class BedrockClient {
  private client: BedrockRuntimeClient;

  constructor(config?: BedrockClientConfig) {
    const region = config?.region || process.env['AWS_REGION'] || 'us-east-1';
    const profile = config?.profile || process.env['AWS_PROFILE'];

    // Use AWS SDK credential chain
    // Priority: 1) Environment variables 2) Profile 3) Default chain (EC2/ECS/Container)
    const credentials = profile ? fromIni({ profile }) : fromEnv();

    this.client = new BedrockRuntimeClient({
      region,
      credentials,
      requestHandler: config?.timeout
        ? {
            requestTimeout: config.timeout,
          }
        : undefined,
      maxAttempts: config?.maxRetries,
    });
  }

  /**
   * Execute a Bedrock Converse request (non-streaming)
   */
  async converse(
    request: BedrockConverseRequest,
  ): Promise<BedrockConverseResponse> {
    const { modelId, messages, system, inferenceConfig, toolConfig } = request;

    // Map the model ID
    const bedrockModelId = getBedrockModelId(modelId);

    const command = new ConverseCommand({
      modelId: bedrockModelId,
      messages: messages as never, // AWS SDK types are slightly different
      system: system as never,
      inferenceConfig: inferenceConfig as never,
      toolConfig: toolConfig as never,
    });

    const response = await this.client.send(command);

    // Convert response to our type format
    return {
      output: {
        message: response.output?.message as never,
      },
      stopReason: response.stopReason as never,
      usage: {
        inputTokens: response.usage?.inputTokens || 0,
        outputTokens: response.usage?.outputTokens || 0,
        totalTokens: response.usage?.totalTokens || 0,
      },
      metrics: response.metrics
        ? {
            latencyMs: response.metrics.latencyMs || 0,
          }
        : undefined,
    };
  }

  /**
   * Execute a Bedrock Converse request with streaming
   */
  async *converseStream(
    request: BedrockConverseRequest,
  ): AsyncGenerator<BedrockStreamEvent> {
    const { modelId, messages, system, inferenceConfig, toolConfig } = request;

    // Map the model ID
    const bedrockModelId = getBedrockModelId(modelId);

    const command = new ConverseStreamCommand({
      modelId: bedrockModelId,
      messages: messages as never,
      system: system as never,
      inferenceConfig: inferenceConfig as never,
      toolConfig: toolConfig as never,
    });

    const response = await this.client.send(command);

    if (!response.stream) {
      throw new Error('No stream returned from Bedrock');
    }

    // Iterate over the stream
    for await (const event of response.stream) {
      // Map AWS SDK stream events to our type format
      if (event.messageStart) {
        yield {
          messageStart: {
            role: event.messageStart.role as 'assistant',
          },
        };
      } else if (event.contentBlockStart) {
        yield {
          contentBlockStart: {
            start: event.contentBlockStart.start as never,
            contentBlockIndex: event.contentBlockStart.contentBlockIndex || 0,
          },
        };
      } else if (event.contentBlockDelta) {
        yield {
          contentBlockDelta: {
            delta: event.contentBlockDelta.delta as never,
            contentBlockIndex: event.contentBlockDelta.contentBlockIndex || 0,
          },
        };
      } else if (event.contentBlockStop) {
        yield {
          contentBlockStop: {
            contentBlockIndex: event.contentBlockStop.contentBlockIndex || 0,
          },
        };
      } else if (event.messageStop) {
        yield {
          messageStop: {
            stopReason: event.messageStop.stopReason as never,
          },
        };
      } else if (event.metadata) {
        yield {
          metadata: {
            usage: {
              inputTokens: event.metadata.usage?.inputTokens || 0,
              outputTokens: event.metadata.usage?.outputTokens || 0,
              totalTokens: event.metadata.usage?.totalTokens || 0,
            },
            metrics: event.metadata.metrics
              ? {
                  latencyMs: event.metadata.metrics.latencyMs || 0,
                }
              : undefined,
          },
        };
      }
    }
  }

  /**
   * Check if AWS credentials are available
   */
  static async checkCredentials(): Promise<boolean> {
    try {
      // Try to get credentials from the credential chain
      const credentials = fromEnv();
      await credentials();
      return true;
    } catch {
      try {
        // Try default profile
        const credentials = fromIni();
        await credentials();
        return true;
      } catch {
        return false;
      }
    }
  }
}
