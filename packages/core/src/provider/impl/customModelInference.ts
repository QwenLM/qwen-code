/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClientError,
  NETWORK_FAILURE_CODE,
  toClientError,
} from '../../client/clientError.js';
import type { CustomClient } from '../../client/customClient.js';
import {
  isTlsCertificateValidationFailure,
  readNetworkFailurePhase,
} from '../../client/utils/networkUtils.js';
import { EmptyAssistantCompletionError } from '../../model-request/empty-assistant-completion.js';
import { SINGLE_REQUEST_FORK } from '../../model-request/request-scope.js';
import { calculateExponentialBackoffMs } from '../../utils/backoff.js';
import { delay } from '../../utils/delay.js';
import { collectErrorObjects, isAbortErrorDeep } from '../../utils/errors.js';
import { composeAbortSignals, disableKeepAlive } from '../../utils/fetch.js';
import { isProtocolLimitError } from '../../utils/protocol-limits.js';
import { isStaleConnectionError } from '../../utils/retry.js';
import { runLogger } from '../../utils/runLogger.js';
import type { ModelPartialMessage } from '../aggregate/modelPartialMessage.js';
import type {
  ModelCompleteEvent,
  ModelMessage,
} from '../event/modelCompleteEvent.js';
import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import {
  ModelInferenceError,
  type ModelInferenceErrorClassifier,
  type ModelInferenceErrorDetail,
} from '../modelInferenceError.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { createModelStreamResponse } from '../modelStreamResponseFactory.js';
import type { ModelTransport } from '../transport/modelTransport.js';

type Event = ModelStreamEvent | ModelCompleteEvent;
type Item = { event: Event } | { error: unknown } | { done: true };

const MAX_INFERENCE_ATTEMPTS = 5;
const MAX_REASONING_ONLY_RETRIES = 2;
const MAX_EMPTY_COMPLETION_REPLAYS = 2;

/** Provider 层重放同一请求；Transport 只负责单次协议映射，每次尝试独立聚合。 */
export function createRetryingCustomInference(
  transport: ModelTransport,
  client: CustomClient,
  request: ModelStreamRequest,
  classify: ModelInferenceErrorClassifier,
  {
    firstPayloadTimeoutMs,
    canRetry,
  }: {
    firstPayloadTimeoutMs?: number;
    /** Returning false vetoes a retry allowed by the default policy. */
    canRetry?: (failure: ModelInferenceErrorDetail) => boolean;
  } = {},
): ModelStreamResponse {
  request.control?.signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = composeAbortSignals(
    request.control?.signal
      ? [request.control.signal, controller.signal]
      : [controller.signal],
  );
  const signal = combined.signal;
  const items: Item[] = [];
  let wake: (() => void) | undefined;
  let current: ModelStreamResponse | undefined;
  let settled = false;
  let exposed = false;
  let reasoningRetries = 0;
  let emptyRetries = 0;
  let resolveCompleted!: (message: ModelMessage) => void;
  let rejectCompleted!: (error: unknown) => void;
  let resolvePartial!: (message: ModelPartialMessage) => void;
  const completed = new Promise<ModelMessage>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const partial = new Promise<ModelPartialMessage>((resolve) => {
    resolvePartial = resolve;
  });
  const publish = (item: Item) => {
    items.push(item);
    wake?.();
  };
  const forward = (event: Event) => {
    exposed = true;
    publish({ event });
  };
  const contractError = (error: unknown): unknown => {
    if (isAbortErrorDeep(error)) return error;
    const detail: ModelInferenceErrorDetail =
      error instanceof ModelInferenceError
        ? error
        : error instanceof EmptyAssistantCompletionError
          ? { kind: 'unknown' as const, code: error.code }
          : classify(
              toClientError(error, { operation: 'inference.custom.stream' }),
            );
    return new ModelInferenceError(
      detail.message ??
        (error instanceof Error ? error.message : String(error)),
      {
        ...detail,
        phase: exposed ? 'after_output' : 'before_output',
        cause:
          error instanceof ModelInferenceError ? (error.cause ?? error) : error,
      },
    );
  };
  const cleanup = () => {
    signal.removeEventListener('abort', onAbort);
    combined.cleanup();
  };
  const fail = async (error: unknown, direct = false) => {
    if (settled) return;
    settled = true;
    cleanup();
    void current?.cancel?.(error);
    const terminal = direct ? error : contractError(error);
    rejectCompleted(terminal);
    publish({ error: terminal });
    resolvePartial(
      current
        ? await current.partial
        : {
            messageId: '',
            model: request.resolution.model.key,
            blocks: [],
            openBlocks: new Map(),
          },
    );
  };
  const onAbort = () => {
    void fail(signal.reason, true);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const drive = async () => {
    try {
      for (let attempt = 1; !settled; attempt++) {
        signal.throwIfAborted();
        let sourceEnded = false;
        let sawStop = false;
        let hadPayload = false;
        let unsafePayload = false;
        let deliveredTool = false;
        const pending: Event[] = [];
        const terminals: Event[] = [];
        const startup = new AbortController();
        const attemptSignal = composeAbortSignals([signal, startup.signal]);
        const input = {
          ...request,
          control: { ...request.control, signal: attemptSignal.signal },
        };
        const timer =
          firstPayloadTimeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                startup.abort(
                  new ClientError(
                    'inference.custom.stream: first payload timeout',
                    {
                      code: NETWORK_FAILURE_CODE,
                      operation: 'inference.custom.stream',
                    },
                  ),
                );
              }, firstPayloadTimeoutMs);
        timer?.unref?.();
        const source = (async function* () {
          yield* transport.stream(client, input);
          sourceEnded = true;
        })();
        current = createModelStreamResponse(source, undefined, (error) =>
          classify(
            toClientError(error, { operation: 'inference.custom.stream' }),
          ),
        );
        void current.completed.catch(() => undefined);
        try {
          for await (const event of current.events) {
            if (settled) return;
            const payload = classifyPayload(event);
            if (payload) {
              hadPayload = true;
              clearTimeout(timer);
            }
            if (payload === 'unsafe') unsafePayload = true;
            if (
              event.type === 'content_block_complete' &&
              event.block.type === 'tool_use'
            )
              deliveredTool = true;
            if (event.type === 'message_stop') sawStop = true;
            if (
              event.type === 'message_delta' ||
              event.type === 'message_complete' ||
              event.type === 'message_stop'
            )
              terminals.push(event);
            else pending.push(event);
            if (hadPayload) while (pending.length) forward(pending.shift()!);
          }
          const result = await current.completed;
          if (!sawStop || !result.stopReason) throw incompleteStream();
          validateCompletion(result, transport.protocol);
          while (pending.length) forward(pending.shift()!);
          for (const event of terminals) forward(event);
          settled = true;
          cleanup();
          resolvePartial(await current.partial);
          resolveCompleted(result);
          publish({ done: true });
          return;
        } catch (caught) {
          clearTimeout(timer);
          if (settled) return;
          const snapshot = await current.partial;
          // 正常 EOF 缺少终态属于截断；其他聚合/解析错误仍按 protocol 处理。
          const error = startup.signal.aborted
            ? startup.signal.reason
            : sourceEnded && (!sawStop || !snapshot.stopReason)
              ? incompleteStream()
              : caught;
          // Single-request forks get one attempt, including empty completions.
          if (SINGLE_REQUEST_FORK in input) {
            await fail(error);
            return;
          }
          const empty = error instanceof EmptyAssistantCompletionError;
          const reasoningOnly = hadPayload && !unsafePayload;
          const replaySafe =
            !deliveredTool &&
            (empty
              ? emptyRetries < MAX_EMPTY_COMPLETION_REPLAYS
              : !hadPayload ||
                (reasoningOnly &&
                  reasoningRetries < MAX_REASONING_ONLY_RETRIES));
          const waitMs = nextRetryDelay(error, attempt);
          if (
            attempt >= MAX_INFERENCE_ATTEMPTS ||
            !replaySafe ||
            snapshot.stopReason === 'refusal' ||
            snapshot.stopReason === 'max_tokens' ||
            !isRetryable(error, classify, canRetry) ||
            waitMs === undefined
          ) {
            await fail(error);
            return;
          }
          if (empty) emptyRetries++;
          else if (reasoningOnly) reasoningRetries++;
          if (isStaleConnectionError(error)) disableKeepAlive();
          runLogger.debug('[custom-model-retry] replaying inference', {
            attempt,
            reasoningRetries,
            emptyRetries,
            delayMs: waitMs,
          });
          // 分段等待，避免服务端的大 Retry-After 溢出运行时定时器。
          for (let remaining = waitMs; remaining > 0; ) {
            const chunk = Math.min(remaining, 30_000);
            await delay(chunk, signal);
            remaining -= chunk;
          }
        } finally {
          clearTimeout(timer);
          attemptSignal.cleanup();
        }
      }
    } catch (error) {
      await fail(error);
    }
  };
  void drive();
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (!items.length) {
            if (settled) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          wake = undefined;
          const item = items.shift()!;
          if ('error' in item) throw item.error;
          if ('done' in item) return;
          yield item.event;
        }
      },
    },
    completed,
    partial,
    cancel(reason = new DOMException('Aborted', 'AbortError')) {
      if (!settled) controller.abort(reason);
    },
  };
}

function incompleteStream(): ClientError {
  return new ClientError('Model stream ended before completion', {
    code: NETWORK_FAILURE_CODE,
  });
}

function isRetryable(
  error: unknown,
  classify: ModelInferenceErrorClassifier,
  canRetry?: (failure: ModelInferenceErrorDetail) => boolean,
): boolean {
  if (
    isAbortErrorDeep(error) ||
    isProtocolLimitError(error) ||
    isTlsCertificateValidationFailure(error)
  )
    return false;
  if (error instanceof EmptyAssistantCompletionError) return true;
  const detail = error instanceof ModelInferenceError ? error : classify(error);
  if (detail.kind === 'protocol' || canRetry?.(detail) === false) return false;
  if (detail.kind === 'server' || detail.kind === 'rate_limited') return true;
  if (detail.kind !== 'unknown' && detail.kind !== 'network') return false;
  const phase = readNetworkFailurePhase(error);
  if (['request_build', 'protocol', 'abort'].includes(phase)) return false;
  if (
    ['dns', 'proxy_connect', 'connect', 'tls', 'request_write'].includes(phase)
  )
    return true;
  return (
    detail.kind === 'network' ||
    [
      'response_headers',
      'first_byte',
      'first_event',
      'first_payload',
      'stream_idle',
      'body',
      'timeout',
    ].includes(phase)
  );
}

function nextRetryDelay(error: unknown, attempt: number): number | undefined {
  for (const record of collectErrorObjects(error)) {
    const value = record as {
      retryAfterMs?: unknown;
      retry_after_ms?: unknown;
      retryAfterSeconds?: unknown;
    };
    const raw = value.retryAfterMs ?? value.retry_after_ms;
    if (raw === undefined && value.retryAfterSeconds === undefined) continue;
    const ms =
      raw !== undefined ? Number(raw) : Number(value.retryAfterSeconds) * 1000;
    return Number.isFinite(ms) &&
      ms >= 0 &&
      Number.isSafeInteger(Math.round(ms))
      ? Math.round(ms)
      : undefined;
  }
  return calculateExponentialBackoffMs({
    attempt,
    baseDelayMs: 500,
    maxBaseDelayMs: 32_000,
    minJitterFactor: 1,
    maxJitterFactor: 1.25,
  });
}

/** 与重放保护一致：正文、工具名/参数和拒绝信号都不能当作仅思考内容。 */
function classifyPayload(event: Event): 'unsafe' | 'reasoning' | undefined {
  if (event.type === 'content_block_start') {
    const block = event.contentBlock;
    if (block.type === 'tool_use' && block.name.length > 0) return 'unsafe';
    if (
      (block.type === 'redacted_thinking' && block.data.length > 0) ||
      ((block.type === 'thinking' || block.type === 'redacted_thinking') &&
        block.reasoning !== undefined)
    )
      return 'reasoning';
  } else if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (
      (delta.type === 'text_delta' && delta.text.length > 0) ||
      (delta.type === 'input_json_delta' && delta.partial_json.length > 0)
    )
      return 'unsafe';
    if (
      (delta.type === 'thinking_delta' && delta.thinking.length > 0) ||
      (delta.type === 'signature_delta' && delta.signature.length > 0)
    )
      return 'reasoning';
  } else if (
    event.type === 'message_delta' &&
    event.delta.stopReason === 'refusal'
  )
    return 'unsafe';
  return undefined;
}

function validateCompletion(result: ModelMessage, protocol: string): void {
  if (
    result.stopReason !== 'end_turn' ||
    result.blocks.some(
      (block) =>
        block.type === 'tool_use' ||
        (block.type === 'text' && block.text.trim().length > 0),
    )
  )
    return;
  const reasoningBlockCount = result.blocks.filter(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  ).length;
  throw new EmptyAssistantCompletionError({
    reason: reasoningBlockCount > 0 ? 'reasoning_only' : 'no_visible_content',
    finishReason: 'end_turn',
    contentBlockCount: result.blocks.length,
    reasoningBlockCount,
    textCharacterCount: result.blocks.reduce(
      (count, block) => count + (block.type === 'text' ? block.text.length : 0),
      0,
    ),
    model: result.model,
    transport: protocol,
  });
}
