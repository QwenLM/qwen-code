/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { getI18nService } from '../../../../../i18n/index.js';
import { runLogger } from '../../../../../utils/runLogger.js';
import { redactHeadersForDebug } from '../../../../log-redaction.js';
import {
  getPaidConfirmationMessage,
  isNewPaidConfirmationCode,
} from '../../../../../provider/qoder/qoderPaidConfirmationText.js';

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import { isSseDone } from '../../../../../protocol/provider/payload-parser.js';
import { parseApiErrorBody } from '../../../../../protocol/provider/qoder-api-error.js';
import type { ParsedQoderApiErrorBody } from '../../../../../protocol/provider/qoder-api-error.js';
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
const PAID_CONFIRMATION_OLD_MESSAGE =
  '当前模型的免费额度已用完，请稍后再试或切换模型。';
const BACKGROUND_PAID_SUBTASKS = new Set([
  'title_generation',
  'prompt_suggestion',
  'awareness_nudge',
]);

function isBackgroundPaidSubTask(subTask: string | undefined): boolean {
  return subTask !== undefined && BACKGROUND_PAID_SUBTASKS.has(subTask);
}

/** The current prompt is a user message, not a tool continuation. */
function isUserMessageInput(
  input: QoderInferenceRequest['body']['input'],
): boolean {
  if (typeof input === 'string') return true;
  const last = Array.isArray(input) ? input[input.length - 1] : undefined;
  return (
    typeof last === 'object' &&
    last !== null &&
    last.type === 'message' &&
    last.role === 'user'
  );
}

function paidConfirmationMessage(): string {
  return getPaidConfirmationMessage(getI18nService()?.locale ?? 'en');
}

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
  private readonly paidConfirmation = new Set<string>();

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
    const modelKey =
      typeof input.body.model === 'string' ? input.body.model : '';
    const paidConfirmed =
      isUserMessageInput(input.body.input) &&
      this.paidConfirmation.has(modelKey) &&
      !isBackgroundPaidSubTask(input.business?.sub_task);

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
    if (paidConfirmed) {
      builder.header('Cosy-Paid-Confirmed', 'true');
    }
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
    runLogger.debug('[qoder-inference] request headers', {
      sessionId,
      requestSetId,
      logicalRequestId: input.requestId,
      requestId: request.headers['X-Request-Id'] ?? input.requestId,
      headers: redactHeadersForDebug(request.headers),
    });
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
      const failure = await toInferenceError(raw, {
        requestId,
        traceId: response.traceId,
        sessionId,
        requestSetId,
        fallbackModelKey: modelKey,
      });
      this.notePaidConfirmation(
        failure,
        isBackgroundPaidSubTask(input.business?.sub_task),
      );
      throw failure;
    }

    for await (const frame of response.sse()) {
      if (isSseDone(frame.data)) {
        break;
      }
      if (frame.data === '') {
        continue;
      }
      if (frame.data.includes('MODEL_PAID_CONFIRM_REQUIRED')) {
        const parsed = parseApiErrorBody(frame.data);
        if (parsed?.subCode === 'MODEL_PAID_CONFIRM_REQUIRED') {
          const failure = paidConfirmationError(
            parsed,
            modelKey,
            requestId,
            response.traceId,
            raw.status,
          );
          this.notePaidConfirmation(
            failure,
            isBackgroundPaidSubTask(input.business?.sub_task),
          );
          throw failure;
        }
      }
      try {
        const event = JSON.parse(frame.data) as ResponseStreamEvent;
        if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete'
        ) {
          this.paidConfirmation.delete(modelKey);
        }
        yield event;
      } catch {
        throw new QoderInferenceError(
          'Qoder inference returned an invalid SSE event.',
        );
      }
    }
  }

  private notePaidConfirmation(
    error: QoderInferenceError,
    background: boolean,
  ): void {
    if (
      background ||
      error.subCode !== 'MODEL_PAID_CONFIRM_REQUIRED' ||
      !isNewPaidConfirmationCode(error.code) ||
      !error.modelKey
    ) {
      return;
    }
    this.paidConfirmation.add(error.modelKey);
  }
}

interface InferenceFailureContext {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sessionId: string;
  readonly requestSetId: string;
  readonly fallbackModelKey?: string;
}

function paidConfirmationError(
  parsed: ParsedQoderApiErrorBody,
  fallbackModelKey: string,
  requestId: string | undefined,
  traceId: string | undefined,
  status: number,
): QoderInferenceError {
  const isNewCode = isNewPaidConfirmationCode(parsed.code);
  const modelKey = parsed.modelKey ?? fallbackModelKey;
  return new QoderInferenceError(
    isNewCode ? paidConfirmationMessage() : PAID_CONFIRMATION_OLD_MESSAGE,
    {
      status,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.subCode ? { subCode: parsed.subCode } : {}),
      ...(modelKey ? { modelKey } : {}),
      ...(parsed.confirmationExpiresAt !== undefined
        ? { confirmationExpiresAt: parsed.confirmationExpiresAt }
        : {}),
      ...(requestId ? { requestId } : {}),
      ...(traceId ? { traceId } : {}),
    },
  );
}

async function toInferenceError(
  response: Response,
  context: InferenceFailureContext,
): Promise<QoderInferenceError> {
  const responseBody = await response.text().catch(() => '');
  const bodyText = responseBody.trim();
  const parsed = bodyText ? parseApiErrorBody(bodyText) : undefined;
  const paidConfirmation =
    parsed?.subCode === 'MODEL_PAID_CONFIRM_REQUIRED'
      ? isNewPaidConfirmationCode(parsed.code)
        ? paidConfirmationMessage()
        : PAID_CONFIRMATION_OLD_MESSAGE
      : undefined;
  const detail = paidConfirmation
    ? `: ${paidConfirmation}`
    : bodyText
      ? `: ${bodyText.slice(0, 300)}`
      : ': response body is empty';
  const trace = context.traceId ? ` traceId=${context.traceId}` : '';
  const paidModelKey = parsed?.modelKey ?? context.fallbackModelKey;
  runLogger.warn('[qoder-inference] inference failed', {
    sessionId: context.sessionId,
    requestSetId: context.requestSetId,
    requestId: context.requestId,
    traceId: context.traceId,
    code: parsed?.code,
    subCode: parsed?.subCode,
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
    paidConfirmation
      ? `${paidConfirmation} requestId=${context.requestId ?? 'unknown'}${trace}`
      : `Qoder inference failed with HTTP ${response.status} (${response.url}) requestId=${context.requestId ?? 'unknown'}${trace}${detail}`,
    {
      status: response.status,
      responseBody: responseBody.slice(0, 64_000),
      ...(parsed?.code ? { code: parsed.code } : {}),
      ...(parsed?.subCode ? { subCode: parsed.subCode } : {}),
      ...(paidModelKey ? { modelKey: paidModelKey } : {}),
      ...(parsed?.confirmationExpiresAt !== undefined
        ? { confirmationExpiresAt: parsed.confirmationExpiresAt }
        : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
    },
  );
}
