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

export type ProviderConfig = Mem0ProviderConfig | GenericHttpProviderConfig;

export interface Mem0ProviderConfig {
  type: 'mem0-platform-v3';
  apiKeyEnv: string;
  apiKey: string;
  appId: string;
}

export interface GenericHttpProviderConfig {
  type: 'generic-http-search-v1';
  baseUrl: string;
  tokenEnv: string;
  token: string;
}
