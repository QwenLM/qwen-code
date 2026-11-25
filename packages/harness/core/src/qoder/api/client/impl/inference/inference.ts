/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { runLogger } from '../../../../../utils/runLogger.js';

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import { isSseDone } from '../../../../../protocol/provider/payload-parser.js';
import type {
  CustomInferenceChatCompletionsApi,
  CustomInferenceMessagesApi,
  CustomInferenceResponsesApi,
} from '../../../../../client/api/inference/inference.js';
import type {
  QoderInferenceApi,
  QoderInferenceRequest,
  QoderInferenceStreamOptions,
} from '../../api/inference/inference.js';
import { QoderInferenceError } from '../../api/inference/inference.js';
import type { QoderOutboundPipeline } from '../../pipeline/qoderOutboundPipeline.js';
import { QoderRequestBuilder } from '../../request/qoderRequest.js';
import { QODER_AGENT_ID } from '../../../regions.js';
import { prepareQoderResponsesBody } from './request.js';

const RESPONSES_PATH = '/api/v1/responses';

export interface QoderInferenceApiOptions {
  readonly gatewayBaseUrl: string;
  readonly generateId?: () => string;
}

/**
 * Responses gateway adapter. Protocol conversion stays in the caller; this
 * impl only declares the Qoder request and decodes the SSE frames.
 */
export class QoderInferenceApiImpl implements QoderInferenceApi {
  private readonly generateId: () => string;

  /** Only the Responses wire is served; other public protocols are unsupported. */
  readonly chatCompletions: CustomInferenceChatCompletionsApi = {
    stream: () => this.unsupported('chat completions'),
  };
  readonly messages: CustomInferenceMessagesApi = {
    stream: () => this.unsupported('messages'),
  };
  readonly responses: CustomInferenceResponsesApi = {
    stream: (input, options) =>
      this.stream({ body: input }, { signal: options?.signal }),
  };

  constructor(
    private readonly pipeline: QoderOutboundPipeline,
    private readonly options: QoderInferenceApiOptions,
  ) {
    this.generateId = options.generateId ?? randomUUID;
  }

  private unsupported(protocol: string): never {
    throw new QoderInferenceError(`Qoder does not support ${protocol}.`);
  }

  async *stream(
    input: QoderInferenceRequest,
    options: QoderInferenceStreamOptions = {},
  ): AsyncIterable<ResponseStreamEvent> {
    options.signal?.throwIfAborted();
    const sessionId =
      (options.sessionId ?? input.sessionId)?.trim() || this.generateId();
    const requestSetId =
      (options.requestSetId ?? input.requestSetId)?.trim() || this.generateId();

    const builder = QoderRequestBuilder.builder()
      .operation('inference.responses.stream')
      .post()
      .path(RESPONSES_PATH)
      .query({ AgentId: QODER_AGENT_ID })
      .origin(this.options.gatewayBaseUrl)
      .requireLogin()
      .session(sessionId)
      .requestSet(requestSetId)
      .signal(options.signal)
      .header('Accept', 'text/event-stream')
      .json(prepareQoderResponsesBody(input.body, input))
      .stream();
    if (input.requestId) builder.requestId(input.requestId);
    const request = builder.build();

    let response;
    try {
      response = await this.pipeline.execute(request);
    } catch (error) {
      const cancelled =
        options.signal?.aborted === true ||
        (error instanceof Error && error.name === 'AbortError');
      const log = cancelled
        ? runLogger.debug.bind(runLogger)
        : runLogger.warn.bind(runLogger);
      log('[qoder-inference] request failed', {
        sessionId,
        requestSetId,
        logicalRequestId: input.requestId,
        requestId: request.headers['X-Request-Id'] ?? input.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const raw = response.raw;
    const requestId =
      response.requestId || request.headers['X-Request-Id'] || input.requestId;
    runLogger.debug('[qoder-inference] response headers', {
      sessionId,
      requestSetId,
      logicalRequestId: input.requestId,
      requestId,
      traceId: response.traceId,
      status: raw?.status,
    });
    if (!raw) {
      throw new QoderInferenceError(
        `Qoder inference returned no response body (requestId=${requestId ?? 'unknown'}).`,
        requestId ? { requestId } : undefined,
      );
    }
    if (!raw.ok) {
      throw await toInferenceError(raw, {
        requestId,
        traceId: response.traceId,
        sessionId,
        requestSetId,
      });
    }

    for await (const frame of response.sse()) {
      if (isSseDone(frame.data)) {
        return;
      }
      if (frame.data === '') {
        continue;
      }
      try {
        yield JSON.parse(frame.data) as ResponseStreamEvent;
      } catch {
        throw new QoderInferenceError(
          'Qoder inference returned an invalid SSE event.',
        );
      }
    }
  }
}

interface InferenceFailureContext {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sessionId: string;
  readonly requestSetId: string;
}

async function toInferenceError(
  response: Response,
  context: InferenceFailureContext,
): Promise<QoderInferenceError> {
  const responseBody = await response.text().catch(() => '');
  const bodyText = responseBody.trim();
  const detail = bodyText
    ? `: ${bodyText.slice(0, 300)}`
    : ': response body is empty';
  const trace = context.traceId ? ` traceId=${context.traceId}` : '';
  runLogger.warn('[qoder-inference] inference failed', {
    sessionId: context.sessionId,
    requestSetId: context.requestSetId,
    requestId: context.requestId,
    traceId: context.traceId,
    status: response.status,
    url: response.url,
  });
  runLogger.debug('[qoder-inference] inference failure body', {
    requestId: context.requestId,
    traceId: context.traceId,
    status: response.status,
    url: response.url,
    responseBody: responseBody.slice(0, 2_000),
  });
  return new QoderInferenceError(
    `Qoder inference failed with HTTP ${response.status} (${response.url}) requestId=${context.requestId ?? 'unknown'}${trace}${detail}`,
    {
      status: response.status,
      responseBody: responseBody.slice(0, 64_000),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
    },
  );
}
