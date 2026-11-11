/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpTransport } from '../transport/httpTransport.js';
import { CustomResponse } from '../response/customResponse.js';
import type { EndpointResolver } from '../endpoint/endpointResolver.js';
import type { ApiKeyResolver } from '../../auth/apiKeyResolver.js';
import type { BearerResolver } from '../../auth/bearerResolver.js';
import { CustomOutboundPipeline } from './customOutboundPipeline.js';
import { ApiKeyValve } from './valve/apiKeyValve.js';
import { BearerValve } from './valve/bearerValve.js';
import { EndpointValve } from './valve/endpointValve.js';
import { ProxyValve } from './valve/proxyValve.js';
import type { ProxyInstance } from '../proxy/proxyInstance.js';
import { ResilienceValve } from './valve/resilienceValve.js';
import { RetryValve } from './valve/retryValve.js';
import { TransportValve } from './valve/transportValve.js';

export interface CreateCustomOutboundPipelineOptions {
  readonly endpointResolver: EndpointResolver;
  readonly bearerResolver: BearerResolver;
  readonly apiKeyResolver: ApiKeyResolver;
  readonly proxyInstance?: ProxyInstance;
}

/**
 * 装配 Custom Provider 的出站管线。
 *
 * 链序：resilience → endpoint → auth → proxy → retry → transport，前段与产品栈的
 * 相对顺序一致：预算先落定，端点解析与下游各级都能读到已确定的幂等性、
 * 重试额度与超时。
 *
 * retry 紧邻 transport，所以一次重发只重走传输层：目标地址与凭据保持上游
 * 各阀留下的样子，重发始终发往同一个端点。
 */
export function buildCustomOutboundPipeline(
  options: CreateCustomOutboundPipelineOptions,
): CustomOutboundPipeline {
  const pipeline = new CustomOutboundPipeline(CustomResponse.initial);
  pipeline.append('resilience', new ResilienceValve());
  pipeline.append('endpoint', new EndpointValve(options.endpointResolver));
  pipeline.append('bearer', new BearerValve(options.bearerResolver));
  pipeline.append('api-key', new ApiKeyValve(options.apiKeyResolver));
  pipeline.append('proxy', new ProxyValve(options.proxyInstance));
  pipeline.append('retry', new RetryValve());
  pipeline.append(
    'transport',
    new TransportValve({ http: new HttpTransport() }),
  );
  return pipeline;
}
