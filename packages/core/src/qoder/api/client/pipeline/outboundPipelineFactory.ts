/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpTransport } from '../../../../client/transport/httpTransport.js';
import { ProxyValve } from '../../../../client/pipeline/valve/proxyValve.js';
import { ResilienceValve } from '../../../../client/pipeline/valve/resilienceValve.js';
import { RetryValve } from '../../../../client/pipeline/valve/retryValve.js';
import { TransportValve } from '../../../../client/pipeline/valve/transportValve.js';
import type { Transport } from '../../../../client/transport/transport.js';
import { QoderOutboundPipeline } from '../pipeline/qoderOutboundPipeline.js';
import { QoderResponse } from '../response/qoderResponse.js';
import {
  QoderAttributionValve,
  type QoderAttributionValveOptions,
} from './valve/attributionValve.js';
import {
  QoderAuthValve,
  type QoderTokenProvider,
} from './valve/authValve.js';

export interface BuildQoderOutboundPipelineOptions {
  readonly tokenProvider: QoderTokenProvider;
  readonly attribution: QoderAttributionValveOptions;
  /** Wire transport override; tests use a fake, production uses fetch. */
  readonly transport?: Transport;
}

/**
 * Qoder 开源出站管线：
 * 登录门禁/动态 Bearer → 容错预算 → 代理 → 重试 → 归因/请求 ID → 传输。
 *
 * 没有商业化栈的 WASM 签名、UMID、HMAC；这些能力不需要，也不应在开源包中出现。
 */
export function buildQoderOutboundPipeline(
  options: BuildQoderOutboundPipelineOptions,
): QoderOutboundPipeline {
  const pipeline = new QoderOutboundPipeline(QoderResponse.initial);
  pipeline.append('auth', new QoderAuthValve(options.tokenProvider));
  pipeline.append('resilience', new ResilienceValve());
  pipeline.append('proxy', new ProxyValve(undefined));
  pipeline.append('retry', new RetryValve());
  pipeline.append(
    'attribution',
    new QoderAttributionValve(options.attribution),
  );
  pipeline.append(
    'transport',
    new TransportValve({ http: options.transport ?? new HttpTransport() }),
  );
  return pipeline;
}
