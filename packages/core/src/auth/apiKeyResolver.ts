/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Supplies the static API-key credential for requests that authenticate by key. */
export interface ApiKeyResolver {
  /** 当前应携带的 API key；不采用该鉴权方式或未配置时返回 undefined。 */
  getApiKey(): string | undefined;
  /** 承载 API key 的请求头；缺省为 x-api-key。 */
  getApiKeyHeader?(): 'x-api-key' | 'x-goog-api-key';
}
