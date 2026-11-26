/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** 插件定义携带的市场身份，供执行时确定插件归属。 */
export interface PluginMarketplaceMetadata {
  marketSourceId: string;
  orgId: string;
  itemKind: string;
  marketItemId: string;
  displayName: string;
  version: string;
}

/** MCP 只保留网关提供的三个身份字段，不补造市场和组织信息。 */
export interface McpMarketplaceMetadata {
  marketItemId: string;
  displayName: string;
  version: string;
}

export type HookMarketplaceMetadata = PluginMarketplaceMetadata;

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

export function normalizeMcpMarketplaceMetadata(
  input?: unknown,
): McpMarketplaceMetadata {
  return {
    marketItemId: stringField(input, 'marketItemId'),
    displayName: stringField(input, 'displayName'),
    version: stringField(input, 'version'),
  };
}

export function normalizePluginMarketplaceMetadata(
  input?: unknown,
): PluginMarketplaceMetadata {
  return {
    marketSourceId: stringField(input, 'marketSourceId'),
    orgId: stringField(input, 'orgId'),
    itemKind: stringField(input, 'itemKind'),
    ...normalizeMcpMarketplaceMetadata(input),
  };
}

export function toMcpHookMarketplaceMetadata(
  metadata: McpMarketplaceMetadata,
): HookMarketplaceMetadata {
  return {
    marketSourceId: '',
    orgId: '',
    itemKind: '',
    ...normalizeMcpMarketplaceMetadata(metadata),
  };
}
