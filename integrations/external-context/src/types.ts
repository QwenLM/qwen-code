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

export interface ExternalContextItem {
  id: string;
  content: string;
  title?: string;
  uri?: string;
  score?: number;
  updatedAt?: string;
}

export type RememberResult =
  | { status: 'stored'; providerOperationId?: string }
  | { status: 'accepted'; providerOperationId?: string }
  | { status: 'unknown'; providerOperationId?: string };

export interface ProviderBinding {
  type: ProviderConfig['type'];
  provider: ExternalContextProvider;
  writer?: ExternalMemoryWriter;
}

export interface ExternalContextConfig {
  version: 1;
  repositoryRoot: string;
  autoRecall: {
    enabled: boolean;
    timeoutMs: number;
  };
  write: {
    enabled: boolean;
  };
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
