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

export interface ExternalContextConfig {
  version: 1;
  timeoutMs: number;
  provider: ProviderConfig;
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
