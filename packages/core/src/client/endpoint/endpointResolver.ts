/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EndpointType } from './endpointType.js';
import type { ResolvedIp } from './ip/ipResolver.js';

/** 一次出站请求的目标端点：origin 加可选直连候选。 */
export interface EndpointResolveResult {
  readonly origin: string;
  /** 直连候选，按优先序排列；缺省走域名解析。 */
  readonly ips?: readonly ResolvedIp[];
  /** 反馈本次端点的尝试结果；failure 仅指线路失败，不包括业务拒绝或取消。 */
  readonly report?: (outcome: 'success' | 'failure') => void;
}

/**
 * 解析一次出站请求的目标端点。键是品牌化的端点类型标签，
 * core 只感知推理端点（INFER），其余键由各 client 侧常量承载。
 */
export interface EndpointResolver {
  resolve(endpointType: EndpointType): Promise<EndpointResolveResult | undefined>;
}
