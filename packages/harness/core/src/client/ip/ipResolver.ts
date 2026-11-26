/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 直连候选 IP 的来源标签。品牌化字符串：core 不解释取值，
 * 具体来源常量由各 client 侧具象化。
 */
declare const ipSource: unique symbol;
export type IpSource = string & {
  readonly [ipSource]: 'IpSource';
};

/** 一次直连候选尝试的反馈参数。 */
export interface IpReportOptions {
  /** failure 仅指线路失败，不包括业务拒绝或取消。 */
  readonly outcome: 'success' | 'failure';
}

/** 一次出站请求的目标IP。 */
export interface ResolvedIp {
  readonly ip: string;
  readonly source: IpSource;
  readonly report: (options: IpReportOptions) => void;
}

/** 按目标 origin 解析直连候选，返回最优的一个；undefined 表示无候选。 */
export interface IpResolver {
  resolve(origin: string): Promise<ResolvedIp | undefined>;
}
