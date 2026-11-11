/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError } from '../../clientError.js';
import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import { deriveBodyReplayable } from '../../utils/bodyUtils.js';
import { BaseValve } from './valve.js';

/** 由调用方选择的容错预设，不包含产品端点策略。 */
export interface ResiliencePreset {
  readonly idempotent: boolean;
  readonly maxAttempts: number;
  readonly addressFailover: boolean;
  readonly preRequestAddressFailover: boolean;
  readonly connectTimeoutMs: number;
  readonly responseHeadersTimeoutMs?: number;
  readonly establishmentTimeoutMs?: number;
  readonly bodyIdleTimeoutMs?: number;
  readonly firstPayloadTimeoutMs?: number;
}

interface ResilienceSettled {
  idempotent: boolean;
  maxAttempts: number;
  connectTimeoutMs: number;
  minRouteAttemptMs: number;
  addressFailover: boolean;
  preRequestAddressFailover: boolean;
  responseHeadersTimeoutMs?: number;
  establishmentTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  firstPayloadTimeoutMs?: number;
  resetTimeoutOnStreamActivity: boolean;
  bodyReplayable: boolean;
}

const MIN_ROUTE_ATTEMPT_MS = 500;

// 基础栈没有地址层，两份预设的 failover 一律关闭：声明开启也无人执行。

// 流式载荷只能被消费一次，所以非幂等；启动由首包预算计时，不设总时限。
const DEFAULT_SSE_PRESET: ResiliencePreset = {
  idempotent: false,
  maxAttempts: 3,
  addressFailover: false,
  preRequestAddressFailover: false,
  connectTimeoutMs: 3_000,
  firstPayloadTimeoutMs: 60_000,
};

// 其余形状：幂等由请求方法推定，建连预算为同步对端留出余地。
const DEFAULT_UNARY_PRESET: ResiliencePreset = {
  idempotent: false,
  maxAttempts: 3,
  addressFailover: false,
  preRequestAddressFailover: false,
  connectTimeoutMs: 3_000,
  responseHeadersTimeoutMs: 300_000,
  establishmentTimeoutMs: 300_000,
  bodyIdleTimeoutMs: 60_000,
};

/**
 * 合并声明、校验预算并降级不可重放请求。
 *
 * 预设选择按请求形状分流，只用通用信号；按自家 SLA 或端点语义选型的栈
 * 覆写 {@link resolvePreset}。
 */
export class ResilienceValve extends BaseValve {
  /** 通用形状分流；幂等沿用 HTTP 方法语义，不做端点推测。 */
  protected resolvePreset(request: CustomRequest): ResiliencePreset {
    if (request.streamResponse) return DEFAULT_SSE_PRESET;
    if (isIdempotentMethod(request.method)) {
      return { ...DEFAULT_UNARY_PRESET, idempotent: true };
    }
    return DEFAULT_UNARY_PRESET;
  }

  async invoke(
    request: CustomRequest,
    response: CustomResponse,
  ): Promise<void> {
    const settled = settleResilience(request, this.resolvePreset(request));
    validateSettledResilience(settled, request.operation);
    downgradeWhenBodyNotReplayable(settled);
    applySettledResilience(request, settled);
    response.streamResponse = request.streamResponse;
    response.maxBytes = request.maxResponseBytes;
    response.firstPayloadTimeoutMs = request.firstPayloadTimeoutMs;
    response.bodyIdleTimeoutMs = request.bodyIdleTimeoutMs;
    response.resetTimeoutOnStreamActivity =
      settled.resetTimeoutOnStreamActivity;
    await this.getNext()!.invoke(request, response);
  }
}

/**
 * 只认无副作用的方法。PUT/DELETE 按 RFC 幂等，但实际对端常带版本号或
 * 计数副作用，重发并不安全，所以不列入默认幂等。
 */
function isIdempotentMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return (
    normalized === 'GET' ||
    normalized === 'HEAD' ||
    normalized === 'OPTIONS' ||
    normalized === 'TRACE'
  );
}

function settleResilience(
  request: CustomRequest,
  preset: ResiliencePreset,
): ResilienceSettled {
  const connectTimeoutMs = request.connectTimeoutMs ?? preset.connectTimeoutMs;
  const settled: ResilienceSettled = {
    idempotent: request.idempotent ?? preset.idempotent,
    maxAttempts: request.maxAttempts ?? preset.maxAttempts,
    connectTimeoutMs,
    minRouteAttemptMs: request.minRouteAttemptMs ?? MIN_ROUTE_ATTEMPT_MS,
    addressFailover: request.addressFailover ?? preset.addressFailover,
    preRequestAddressFailover:
      request.preRequestAddressFailover ?? preset.preRequestAddressFailover,
    resetTimeoutOnStreamActivity: request.resetTimeoutOnStreamActivity ?? false,
    bodyReplayable: deriveBodyReplayable(request.method, request.body),
  };
  if (preset.responseHeadersTimeoutMs !== undefined) {
    settled.responseHeadersTimeoutMs =
      request.responseHeadersTimeoutMs ??
      request.requestTimeoutMs ??
      Math.max(preset.responseHeadersTimeoutMs, connectTimeoutMs);
  }
  if (preset.establishmentTimeoutMs !== undefined) {
    settled.establishmentTimeoutMs =
      request.establishmentTimeoutMs ??
      request.requestTimeoutMs ??
      Math.max(preset.establishmentTimeoutMs, connectTimeoutMs);
  }
  if (preset.bodyIdleTimeoutMs !== undefined) {
    settled.bodyIdleTimeoutMs =
      request.bodyIdleTimeoutMs ?? preset.bodyIdleTimeoutMs;
  }
  settled.firstPayloadTimeoutMs =
    request.firstPayloadTimeoutMs ?? preset.firstPayloadTimeoutMs;
  return settled;
}

function validateSettledResilience(
  settled: ResilienceSettled,
  operation: string,
): void {
  const fail = (detail: string) =>
    new ClientError(`Resilience settings rejected: ${detail}`, { operation });
  if (
    !Number.isFinite(settled.connectTimeoutMs) ||
    settled.connectTimeoutMs <= 0
  ) {
    throw fail('connectTimeoutMs must be a positive finite number');
  }
  if (settled.maxAttempts < 1 || !Number.isInteger(settled.maxAttempts)) {
    throw fail('maxAttempts must be a positive integer');
  }
  validateOptionalTimeout(settled.establishmentTimeoutMs, fail);
  validateOptionalTimeout(settled.responseHeadersTimeoutMs, fail);
  validateOptionalTimeout(settled.bodyIdleTimeoutMs, fail);
  validateOptionalTimeout(settled.firstPayloadTimeoutMs, fail);
  validateOptionalTimeout(settled.minRouteAttemptMs, fail);
}

function validateOptionalTimeout(
  value: number | undefined,
  fail: (detail: string) => ClientError,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw fail('timeouts must be positive finite numbers');
  }
}

function downgradeWhenBodyNotReplayable(settled: ResilienceSettled): void {
  if (settled.maxAttempts > 1 && !settled.bodyReplayable) {
    settled.maxAttempts = 1;
    settled.addressFailover = false;
    settled.preRequestAddressFailover = false;
  }
}

function applySettledResilience(
  request: CustomRequest,
  settled: ResilienceSettled,
): void {
  request.idempotent = settled.idempotent;
  request.maxAttempts = settled.maxAttempts;
  request.connectTimeoutMs = settled.connectTimeoutMs;
  request.minRouteAttemptMs = settled.minRouteAttemptMs;
  request.addressFailover = settled.addressFailover;
  request.preRequestAddressFailover = settled.preRequestAddressFailover;
  if (settled.responseHeadersTimeoutMs !== undefined) {
    request.responseHeadersTimeoutMs = settled.responseHeadersTimeoutMs;
  }
  if (settled.establishmentTimeoutMs !== undefined) {
    request.establishmentTimeoutMs = settled.establishmentTimeoutMs;
  }
  if (settled.bodyIdleTimeoutMs !== undefined) {
    request.bodyIdleTimeoutMs = settled.bodyIdleTimeoutMs;
  }
  if (settled.firstPayloadTimeoutMs !== undefined) {
    request.firstPayloadTimeoutMs = settled.firstPayloadTimeoutMs;
  }
  request.resetTimeoutOnStreamActivity = settled.resetTimeoutOnStreamActivity;
  request.bodyReplayable = settled.bodyReplayable;
}
