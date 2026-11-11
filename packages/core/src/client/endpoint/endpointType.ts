/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 端点解析键。品牌化字符串：只有经常量标注的字符串才是合法端点类型，
 * core 开源世界只感知一种端点——推理端点；其余端点类型的常量由
 * 各 client 侧自带。
 */
declare const endpointType: unique symbol;
export type EndpointType = string & {
  readonly [endpointType]: 'EndpointType';
};

/** core 唯一感知的端点类型：推理端点。 */
export const INFERENCE = 'inference' as EndpointType;
