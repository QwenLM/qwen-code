/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ExternalContextProvider {
  search(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly ExternalContextItem[]>;
}

export interface ExternalMemoryWriter {
  remember(input: {
    content: string;
    signal: AbortSignal;
  }): Promise<RememberResult>;
}

export type RememberResult =
  | { status: 'stored'; providerOperationId?: string }
  | { status: 'accepted'; providerOperationId: string }
  | { status: 'failed' }
  | { status: 'unknown' };

export interface ExternalContextItem {
  id: string;
  content: string;
  title?: string;
  uri?: string;
  score?: number;
  updatedAt?: string;
}

export interface ExternalContextConfigV1 {
  version: 1;
  timeoutMs: number;
  provider: ProviderConfig;
  write?: {
    enabled: true;
  };
}

export interface ExternalContextConfigV2 {
  version: 2;
  timeoutMs: number;
  autoRecall: AutoRecallConfig;
  provider: ProviderConfig;
}

export type ExternalContextConfig =
  | ExternalContextConfigV1
  | ExternalContextConfigV2;

export interface AutoRecallConfig {
  repositoryRoot: string;
  timeoutMs: number;
}

export type ProviderConfig =
  | Mem0ProviderConfig
  | Mem0CompatibleProviderConfig
  | GenericHttpProviderConfig;

export interface Mem0ProviderConfig {
  type: 'mem0-platform-v3';
  apiKeyEnv: string;
  apiKey: string;
  appId: string;
}

export const MEM0_PRESET_IDS = [
  'mem0-platform-v3',
  'mem0-oss-rest-2026-08',
  'aliyun-polardb-mysql-2026-08',
] as const;

export type Mem0PresetId = (typeof MEM0_PRESET_IDS)[number];

export interface Mem0CompatibleProviderConfig {
  type: 'mem0';
  preset: Mem0PresetId;
  endpoint: {
    origin: string;
    basePath: string;
    allowInsecureHttp?: boolean;
  };
  credentialEnv: string;
  credential: string;
  scope: {
    userId?: string;
    agentId?: string;
    appId?: string;
  };
}

export interface GenericHttpProviderConfig {
  type: 'generic-http-search-v1';
  baseUrl: string;
  tokenEnv: string;
  token: string;
}
