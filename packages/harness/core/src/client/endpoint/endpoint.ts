/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

declare const endpointType: unique symbol;
export type EndpointType = string & {
  readonly [endpointType]: 'EndpointType';
};

export const INFERENCE = 'inference' as EndpointType;

declare const endpointScope: unique symbol;
export type EndpointScope = string & {
  readonly [endpointScope]: 'EndpointScope';
};

export const PUBLIC = 'public' as EndpointScope;

declare const endpointSource: unique symbol;
export type EndpointSource = string & {
  readonly [endpointSource]: 'EndpointSource';
};

export const CUSTOM_PROVIDER = 'custom-provider' as EndpointSource;

/** 一个具体端点：解析键、ORIGIN 与归属节点池。 */
export interface Endpoint {
  readonly origin: string;
  readonly type: EndpointType;
  readonly scope: EndpointScope;
}
