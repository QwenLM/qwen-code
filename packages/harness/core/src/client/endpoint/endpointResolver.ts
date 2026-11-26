/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Endpoint, EndpointSource, EndpointType } from './endpoint.js';

/** 一次端点尝试的反馈参数。 */
export interface EndpointReportOptions {
  /** failure 仅指线路失败，不包括业务拒绝或取消。 */
  readonly outcome: 'success' | 'failure';
}

/** 一次出站请求的目标端点：具体端点加上来自哪条解析链与尝试反馈。 */
export interface ResolvedEndpoint extends Endpoint {
  readonly source: EndpointSource;
  readonly report: (options: EndpointReportOptions) => void;
}

/** 解析一次出站请求的目标端点。键是品牌化的端点类型标签  */
export interface EndpointResolver {
  resolve(endpointType: EndpointType): Promise<ResolvedEndpoint | undefined>;
}
