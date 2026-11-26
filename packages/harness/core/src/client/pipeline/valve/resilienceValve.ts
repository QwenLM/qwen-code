/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import { deriveBodyReplayable } from '../../utils/bodyUtils.js';
import { isIdempotentMethod } from '../../utils/httpMethodUtils.js';
import { validatePositiveInteger } from '../../utils/numberUtils.js';
import { BaseValve } from './valve.js';

export interface ResilienceFlowControls {
  idempotent: boolean;
  maxAttempts: number;
  connectTimeoutMs: number;
  responseHeadersTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  firstPayloadTimeoutMs?: number;
  resetTimeoutOnStreamActivity?: boolean;
  bodyReplayable?: boolean;
}

/** 管线持有方给出的流式预算，优先于 SSE 预设，可被单个请求的声明覆盖。 */
export type StreamTimeouts = Readonly<
  Pick<
    ResilienceFlowControls,
    | 'firstPayloadTimeoutMs'
    | 'bodyIdleTimeoutMs'
    | 'resetTimeoutOnStreamActivity'
  >
>;

// 流式载荷只能被消费一次，所以非幂等且不重发；启动由首包预算计时，不设总时限。
const DEFAULT_SSE_PRESET: ResilienceFlowControls = {
  idempotent: false,
  maxAttempts: 1,
  connectTimeoutMs: 3_000,
  firstPayloadTimeoutMs: 60_000,
};

// 幂等读（GET/HEAD/OPTIONS/TRACE）：可安全重发，预算按读请求收紧。
const DEFAULT_SAFE_READ_PRESET: ResilienceFlowControls = {
  idempotent: true,
  maxAttempts: 3,
  connectTimeoutMs: 3_000,
  responseHeadersTimeoutMs: 30_000,
  bodyIdleTimeoutMs: 30_000,
};

// 其余形状：建连预算为同步对端留出余地，重发仍取决于幂等声明。
const DEFAULT_UNARY_PRESET: ResilienceFlowControls = {
  idempotent: false,
  maxAttempts: 3,
  connectTimeoutMs: 3_000,
  responseHeadersTimeoutMs: 300_000,
  bodyIdleTimeoutMs: 60_000,
};

/**
 * 合并声明、校验预算并降级不可重放请求。
 *
 * 结算结果同时写回请求与响应两侧视图，保证链上后续各阀读到同一份契约。
 */
export class ResilienceValve extends BaseValve {
  constructor(private readonly streamTimeouts: StreamTimeouts = {}) {
    super();
  }

  async invoke(
    request: CustomRequest,
    response: CustomResponse,
  ): Promise<void> {
    const preset = this.resolvePreset(request);
    const settled = this.settleResilience(request, preset);
    this.validateSettledResilience(settled);
    this.applySettledRequest(request, settled);
    this.applySettledResponse(response, request, settled);
    await this.getNext()!.invoke(request, response);
  }

  /** 通用形状分流；幂等沿用 HTTP 方法语义，不做端点推测。 */
  private resolvePreset(request: CustomRequest): ResilienceFlowControls {
    if (request.streamResponse) return DEFAULT_SSE_PRESET;
    if (isIdempotentMethod(request.method)) return DEFAULT_SAFE_READ_PRESET;
    return DEFAULT_UNARY_PRESET;
  }

  private settleResilience(
    request: CustomRequest,
    preset: ResilienceFlowControls,
  ): ResilienceFlowControls {
    const connectTimeoutMs =
      request.connectTimeoutMs ?? preset.connectTimeoutMs;
    const streamTimeouts = request.streamResponse ? this.streamTimeouts : {};
    const settled: ResilienceFlowControls = {
      idempotent: request.idempotent ?? preset.idempotent,
      maxAttempts: request.maxAttempts ?? preset.maxAttempts,
      connectTimeoutMs,
      resetTimeoutOnStreamActivity:
        request.resetTimeoutOnStreamActivity ??
        streamTimeouts.resetTimeoutOnStreamActivity ??
        false,
      bodyReplayable: deriveBodyReplayable(request.method, request.body),
    };
    if (preset.responseHeadersTimeoutMs !== undefined) {
      settled.responseHeadersTimeoutMs =
        request.responseHeadersTimeoutMs ??
        request.requestTimeoutMs ??
        Math.max(preset.responseHeadersTimeoutMs, connectTimeoutMs);
    }
    settled.bodyIdleTimeoutMs =
      request.bodyIdleTimeoutMs ??
      streamTimeouts.bodyIdleTimeoutMs ??
      preset.bodyIdleTimeoutMs;
    settled.firstPayloadTimeoutMs =
      request.firstPayloadTimeoutMs ??
      streamTimeouts.firstPayloadTimeoutMs ??
      preset.firstPayloadTimeoutMs;
    if (streamTimeouts.firstPayloadTimeoutMs !== undefined) {
      // 响应头必然先于首包到达：不随首包预算走，传输层的缺省响应头期限会先到期。
      settled.responseHeadersTimeoutMs =
        request.responseHeadersTimeoutMs ??
        Math.max(
          request.firstPayloadTimeoutMs ?? streamTimeouts.firstPayloadTimeoutMs,
          connectTimeoutMs,
        );
    }
    return settled;
  }

  private validateSettledResilience(settled: ResilienceFlowControls): void {
    validatePositiveInteger(settled.connectTimeoutMs, 'connectTimeoutMs');
    validatePositiveInteger(settled.maxAttempts, 'maxAttempts');
    validatePositiveInteger(
      settled.responseHeadersTimeoutMs,
      'responseHeadersTimeoutMs',
    );
    validatePositiveInteger(settled.bodyIdleTimeoutMs, 'bodyIdleTimeoutMs');
    validatePositiveInteger(
      settled.firstPayloadTimeoutMs,
      'firstPayloadTimeoutMs',
    );
  }

  private applySettledRequest(
    request: CustomRequest,
    settled: ResilienceFlowControls,
  ): void {
    const bodyReplayable = settled.bodyReplayable ?? false;
    // 流式请求即便显式声明了多次尝试也只发一次。
    if (settled.maxAttempts > 1 && (!bodyReplayable || request.streamResponse)) {
      settled.maxAttempts = 1;
    }
    request.idempotent = settled.idempotent;
    request.maxAttempts = settled.maxAttempts;
    request.connectTimeoutMs = settled.connectTimeoutMs;
    if (settled.responseHeadersTimeoutMs !== undefined) {
      request.responseHeadersTimeoutMs = settled.responseHeadersTimeoutMs;
    }
    if (settled.bodyIdleTimeoutMs !== undefined) {
      request.bodyIdleTimeoutMs = settled.bodyIdleTimeoutMs;
    }
    if (settled.firstPayloadTimeoutMs !== undefined) {
      request.firstPayloadTimeoutMs = settled.firstPayloadTimeoutMs;
    }
    request.resetTimeoutOnStreamActivity =
      settled.resetTimeoutOnStreamActivity ?? false;
    request.bodyReplayable = bodyReplayable;
  }

  /** 把结算结果镜像到消费端视图；流式标志与下载上限不是结算字段，直接取请求声明。 */
  private applySettledResponse(
    response: CustomResponse,
    request: CustomRequest,
    settled: ResilienceFlowControls,
  ): void {
    response.streamResponse = request.streamResponse;
    response.maxBytes = request.maxResponseBytes;
    response.firstPayloadTimeoutMs = settled.firstPayloadTimeoutMs;
    response.bodyIdleTimeoutMs = settled.bodyIdleTimeoutMs;
    response.resetTimeoutOnStreamActivity =
      settled.resetTimeoutOnStreamActivity ?? false;
  }
}
