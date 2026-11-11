/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClientError,
  MALFORMED_RESPONSE_CODE,
  NETWORK_FAILURE_CODE,
} from '../client/clientError.js';
import type { QoderApiErrorDetails } from '../protocol/provider/qoder-api-error.js';

/** 推理失败的语义分类：消费方据此决定压缩、提示额度、重新登录或放弃。 */
export type ModelInferenceErrorKind =
  | 'prompt_too_long'
  | 'quota_exhausted'
  | 'auth'
  | 'rate_limited'
  | 'model_not_found'
  | 'invalid_request'
  | 'server'
  | 'network'
  | 'protocol'
  | 'unknown';

/**
 * 失败发生在已向消费方吐出事件之前还是之后：之后失败时消费方已渲染部分内容，
 * 不能当作未发生而透明重放。
 */
export type ModelInferenceErrorPhase = 'before_output' | 'after_output';

/** Provider 对一个内部错误的语义映射；phase 与 cause 由出口统一补齐。 */
export interface ModelInferenceErrorDetail {
  readonly kind: ModelInferenceErrorKind;
  /** 缺省沿用原错误 message，保证按文本识别的下游判定不变。 */
  readonly message?: string;
  /** HTTP 或业务信封状态码；字段名取 `status`，与 getErrorStatus 等读取口径一致。 */
  readonly status?: number;
  /** 上游原样的错误码，不做归一。 */
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  /** 服务端结构化错误说明；展示层据此透传原文而非本地包装文案。 */
  readonly qoderApiError?: QoderApiErrorDetails;
}

/** Provider 私有映射表：只有 provider 知道自家 wire 错误码的含义。 */
export type ModelInferenceErrorClassifier = (
  error: unknown,
) => ModelInferenceErrorDetail;

export interface ModelInferenceErrorOptions extends ModelInferenceErrorDetail {
  readonly phase: ModelInferenceErrorPhase;
  readonly cause?: unknown;
}

/**
 * inference 的异常契约：`events` 迭代抛出与 `completed` reject 的只会是本类型
 * 或 AbortError；ClientError 等实现细节只在 provider 内部流转，原样挂在 cause 上。
 */
export class ModelInferenceError extends Error {
  readonly kind: ModelInferenceErrorKind;
  readonly phase: ModelInferenceErrorPhase;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly qoderApiError?: QoderApiErrorDetails;

  constructor(message: string, options: ModelInferenceErrorOptions) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'ModelInferenceError';
    this.kind = options.kind;
    this.phase = options.phase;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.qoderApiError !== undefined) {
      this.qoderApiError = options.qoderApiError;
    }
  }
}

/** Find the Provider failure through lifecycle wrappers without reclassifying it. */
export function findModelInferenceError(
  error: unknown,
): ModelInferenceError | undefined {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current) &&
    seen.size < 16
  ) {
    if (current instanceof ModelInferenceError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** OpenAI / Anthropic 公开协议里语义明确的错误码（流内错误帧没有 HTTP 状态码可用）。 */
const WIRE_CODE_KINDS = new Map<string, ModelInferenceErrorKind>([
  ['context_length_exceeded', 'prompt_too_long'],
  ['context_window_exceeded', 'prompt_too_long'],
  ['model_context_window_exceeded', 'prompt_too_long'],
  ['insufficient_quota', 'quota_exhausted'],
  ['authentication_error', 'auth'],
  ['permission_error', 'auth'],
  ['invalid_api_key', 'auth'],
  ['rate_limit_error', 'rate_limited'],
  ['rate_limit_exceeded', 'rate_limited'],
  ['overloaded_error', 'server'],
  ['api_error', 'server'],
  ['server_error', 'server'],
  ['not_found_error', 'model_not_found'],
  ['model_not_found', 'model_not_found'],
  ['invalid_request_error', 'invalid_request'],
]);

/** Client 层自己的分类码：响应无法解码、连接失败。 */
const CLIENT_CODE_KINDS = new Map<string, ModelInferenceErrorKind>([
  [MALFORMED_RESPONSE_CODE, 'protocol'],
  [NETWORK_FAILURE_CODE, 'network'],
]);

/** 通用 HTTP 状态映射：provider 无私有语义时的兜底。 */
export function inferenceErrorKindFromStatus(
  status: number | undefined,
): ModelInferenceErrorKind {
  if (status === undefined) return 'unknown';
  if (status === 413) return 'prompt_too_long';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota_exhausted';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'server';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/**
 * 默认映射：先认 Client 层分类码，再读 ClientError 的错误码、状态码与错误体里的通用
 * `code`/`message` 信封，错误码优先于状态码。不是 ClientError 的失败归 unknown。
 */
export function classifyClientError(error: unknown): ModelInferenceErrorDetail {
  if (!(error instanceof ClientError)) return { kind: 'unknown' };
  const clientKind =
    error.code !== undefined ? CLIENT_CODE_KINDS.get(error.code) : undefined;
  if (clientKind !== undefined) {
    return {
      kind: clientKind,
      status: error.statusCode,
      code: error.code,
      requestId: error.requestId,
    };
  }
  const status = error.statusCode;
  const body = parseErrorBody(error.responseBody);
  const code = body.code ?? error.code;
  const kind =
    (code !== undefined
      ? WIRE_CODE_KINDS.get(code.toLowerCase())
      : undefined) ?? inferenceErrorKindFromStatus(status);
  return {
    kind,
    message:
      body.message && !error.message.includes(body.message)
        ? `${error.message}: ${body.message}`
        : undefined,
    status,
    code,
    requestId: error.requestId,
  };
}

/** 解析 `{code,message}` 或 `{error:{code,message}}` 两种常见错误信封。 */
function parseErrorBody(body: string | undefined): {
  code?: string;
  message?: string;
} {
  if (!body) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const root = parsed as Record<string, unknown>;
  const inner = root['error'];
  const envelope =
    typeof inner === 'object' && inner !== null
      ? (inner as Record<string, unknown>)
      : root;
  const code = envelope['code'];
  const message = envelope['message'] ?? root['message'];
  return {
    code:
      typeof code === 'string' || typeof code === 'number'
        ? String(code)
        : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}
