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

/**
 * 一个直连候选 IP。来源标签由各 client 侧具象化，core 不解释其取值。
 */
export type ResolvedIp = {
  readonly ip: string;
  readonly source: IpSource;
};

/** 按目标 origin 解析直连候选，按优先序返回；空数组表示无候选。 */
export interface IpResolver {
  resolve(origin: string): Promise<readonly ResolvedIp[]>;
}
