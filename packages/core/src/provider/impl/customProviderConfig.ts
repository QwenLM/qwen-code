/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApiKeyResolver } from '../../auth/apiKeyResolver.js';
import type { BearerResolver } from '../../auth/bearerResolver.js';
import type { CustomProviderRoutingPurpose } from '../custom/types.js';
import type {
  EndpointResolveResult,
  EndpointResolver,
} from '../../client/index.js';
import {
  INFERENCE,
  type EndpointType,
} from '../../client/endpoint/endpointType.js';
import { runLogger } from '../../utils/runLogger.js';
import type { Model } from '../model/model.js';
import {
  GOOGLE_GEMINI,
  type ModelProtocol,
} from '../transport/modelProtocol.js';

/** v1、v1beta、v1beta1、v1alpha 等版本段；带版本时不再补默认值。 */
const API_VERSION_SEGMENT = /\/v\d+(?:[a-z]+\d*)?$/i;

/**
 * Gemini REST 的路径本身不带版本，Google SDK 会用 apiVersion 拼在 baseUrl
 * 后面。这里做同样的事：baseUrl 未指明版本时补 `/v1beta`，已带版本则原样使用。
 */
function normalizeGeminiOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '' && API_VERSION_SEGMENT.test(path)) return baseUrl;
    url.pathname = path === '' ? '/v1beta' : `${path}/v1beta`;
    return url.toString().replace(/\/$/, '');
  } catch {
    return baseUrl;
  }
}

/**
 * Custom Provider 的长期运行配置，包含凭证，不得写入日志。
 * 端点是静态配置：resolve 恒返回 baseUrl，无解析链。
 */
export class CustomProviderConfig
  implements EndpointResolver, BearerResolver, ApiKeyResolver
{
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly authType?: 'bearer' | 'api-key' | 'google-api-key';
  readonly models: readonly Model[];
  readonly protocol: ModelProtocol;
  readonly firstPayloadTimeoutMs?: number;
  /** 语义用途 → 模型 id 的路由表；未配置的用途回落主模型。 */
  readonly routing: Partial<Record<CustomProviderRoutingPurpose, string>>;

  constructor(options: {
    providerId: string;
    baseUrl: string;
    apiKey?: string;
    authType?: 'bearer' | 'api-key' | 'google-api-key';
    models: readonly Model[];
    protocol: ModelProtocol;
    firstPayloadTimeoutMs?: number;
    routing?: Partial<Record<CustomProviderRoutingPurpose, string>>;
  }) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.authType = options.authType;
    this.models = options.models;
    this.protocol = options.protocol;
    this.firstPayloadTimeoutMs = options.firstPayloadTimeoutMs;
    this.routing = options.routing ?? {};
  }

  /**
   * BearerResolver 读面：bearer 鉴权时携带 apiKey，其余鉴权方式不产生 token。
   */
  getBearer(): string | undefined {
    return this.authType !== 'bearer' ? undefined : this.apiKey;
  }

  /**
   * ApiKeyResolver 读面：api-key 鉴权时携带 apiKey，其余鉴权方式不产生 key。
   */
  getApiKey(): string | undefined {
    return this.authType === 'api-key' || this.authType === 'google-api-key'
      ? this.apiKey
      : undefined;
  }

  /** Gemini keys travel in x-goog-api-key instead of x-api-key. */
  getApiKeyHeader(): 'x-api-key' | 'x-goog-api-key' {
    return this.authType === 'google-api-key'
      ? 'x-goog-api-key'
      : 'x-api-key';
  }

  resolve(endpointType: EndpointType): Promise<EndpointResolveResult | undefined> {
    // Custom Provider 只提供推理端点能力，其余端点类型无法解析。
    if (endpointType !== INFERENCE) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      origin:
        this.protocol === GOOGLE_GEMINI
          ? normalizeGeminiOrigin(this.baseUrl)
          : this.baseUrl,
      report: (outcome) => {
        if (outcome === 'failure') {
          runLogger.warn(
            '[custom-provider] Fixed endpoint request failed; only one endpoint can be configured; endpoint failover is not supported.',
          );
        }
      },
    });
  }
}
