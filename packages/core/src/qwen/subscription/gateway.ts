/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

import { ClientError } from '../../client/clientError.js';
import type { CustomClient } from '../../client/customClient.js';
import type { CustomInferenceChatCompletionsApi } from '../../client/api/inference/chat-completions/chatCompletions.js';
import type { CustomInferenceStreamOptions } from '../../client/api/inference/customInferenceStreamOptions.js';
import { CustomApiImpl } from '../../client/impl/custom.js';
import { streamInferenceSse } from '../../client/impl/inference/inferenceSse.js';
import { buildCustomOutboundPipeline } from '../../client/pipeline/outboundPipelineFactory.js';
import type { Pipeline } from '../../client/pipeline/pipeline.js';
import { BaseValve } from '../../client/pipeline/valve/valve.js';
import type { CustomRequest } from '../../client/request/customRequest.js';
import type { CustomResponse } from '../../client/response/customResponse.js';
import type { CustomProviderConfig } from '../../provider/impl/customProviderConfig.js';
import { runLogger } from '../../utils/runLogger.js';
import { getVersionSync } from '../../utils/version.js';
import { normalizeQwenSubscriptionRequestId } from './quota.js';

/** Standard `User-Agent` sent on Qwen Subscription gateway requests. */
export function getQwenSubscriptionUserAgent(
  cliVersion = getVersionSync(),
): string {
  return `QwenCode/${cliVersion || 'unknown'} (${process.platform}; ${process.arch})`;
}

/**
 * Resolves the first valid request id from `x-request-id` or
 * `x-gateway-request-id` after normalizing each candidate independently.
 */
export function resolveQwenSubscriptionHeaderRequestId(
  headers: Headers,
): string | undefined {
  return (
    normalizeQwenSubscriptionRequestId(headers.get('x-request-id')) ??
    normalizeQwenSubscriptionRequestId(headers.get('x-gateway-request-id'))
  );
}

/**
 * Logs `x-request-id` / `x-gateway-request-id` from a subscription gateway
 * response.
 */
export function logQwenSubscriptionGatewayResponse(response: Response): void {
  const requestId = response.headers.get('x-request-id');
  const gatewayRequestId = response.headers.get('x-gateway-request-id');
  if (requestId || gatewayRequestId) {
    const normalizedRequestId =
      normalizeQwenSubscriptionRequestId(requestId) ?? '-';
    const normalizedGatewayRequestId =
      normalizeQwenSubscriptionRequestId(gatewayRequestId) ?? '-';
    runLogger.debug(
      `[qwen-subscription] gateway response status=${response.status} requestId=${normalizedRequestId} gatewayRequestId=${normalizedGatewayRequestId}`,
    );
  }
}

/**
 * Outbound pipeline valve for the Qwen Subscription gateway (`api.qwen.ai`).
 *
 * Sits right after `retry` so every physical send carries the `QwenCode/...`
 * `User-Agent` header and every gateway response logs its correlation headers
 * (`x-request-id` / `x-gateway-request-id`).
 */
export class QwenSubscriptionGatewayValve extends BaseValve {
  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const hasUserAgent = Object.keys(input.headers).some(
      (key) => key.toLowerCase() === 'user-agent',
    );
    if (!hasUserAgent) {
      input.setHeader('User-Agent', getQwenSubscriptionUserAgent());
    }
    await this.getNext()?.invoke(input, output);
    if (output.raw) {
      logQwenSubscriptionGatewayResponse(output.raw);
    }
  }
}

class QwenSubscriptionChatCompletionsApi
  implements CustomInferenceChatCompletionsApi
{
  constructor(private readonly pipeline: Pipeline) {}

  async *stream(
    input: ChatCompletionCreateParamsStreaming,
    options: CustomInferenceStreamOptions = {},
  ): AsyncGenerator<ChatCompletionChunk> {
    let headerRequestId: string | undefined;
    const scopedPipeline: Pipeline = {
      execute: async (request) => {
        const response = await this.pipeline.execute(request);
        headerRequestId = response.raw
          ? resolveQwenSubscriptionHeaderRequestId(response.raw.headers)
          : undefined;
        return response;
      },
      invoke: (request, response) => this.pipeline.invoke(request, response),
      insert: (name, valve, prev) => this.pipeline.insert(name, valve, prev),
      append: (name, valve) => this.pipeline.append(name, valve),
    };
    try {
      yield* streamInferenceSse<ChatCompletionChunk>(scopedPipeline, {
        operation: 'inference.chatCompletions.stream',
        path: '/chat/completions',
        body: input,
        signal: options.signal,
      });
    } catch (error) {
      if (
        error instanceof ClientError &&
        error.statusCode !== undefined &&
        headerRequestId
      ) {
        const normalizedExisting = normalizeQwenSubscriptionRequestId(
          error.requestId,
        );
        if (!normalizedExisting) {
          throw new ClientError(error.message, {
            code: error.code,
            operation: error.operation,
            statusCode: error.statusCode,
            requestId: headerRequestId,
            responseBody: error.responseBody,
            cause: error.cause,
          });
        }
      }
      throw error;
    }
  }
}

/**
 * Build a `CustomClient` wired with `QwenSubscriptionGatewayValve` and
 * per-stream `requestId` propagation onto `ClientError`.
 */
export function createQwenSubscriptionClient(
  config: CustomProviderConfig,
): CustomClient {
  const pipeline = buildCustomOutboundPipeline({
    endpointResolver: config,
    bearerResolver: config,
    apiKeyResolver: config,
  });
  pipeline.insert(
    'qwen-subscription',
    new QwenSubscriptionGatewayValve(),
    'retry',
  );
  const api = new CustomApiImpl(pipeline);
  return {
    api: {
      inference: {
        chatCompletions: new QwenSubscriptionChatCompletionsApi(pipeline),
        responses: api.inference.responses,
        messages: api.inference.messages,
        gemini: api.inference.gemini,
      },
    },
  };
}
