/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type AuthenticationKind =
  | 'authorization-token'
  | 'authorization-bearer'
  | 'x-api-key';

export type ScopeLocation = 'json' | 'json.filters' | 'query' | 'omit';

interface InstanceConfigBase {
  dialectPath: string;
  endpoint: {
    origin: string;
    basePath: string;
    allowInsecureHttp: boolean;
  };
  credentialEnv: string;
  scope: {
    userId?: string;
    agentId?: string;
    appId?: string;
  };
  timeoutMs: number;
}

export interface InstanceConfigV2 extends InstanceConfigBase {
  schemaVersion: 2;
}

export interface InstanceConfigV3 extends InstanceConfigBase {
  schemaVersion: 3;
  autoRecall: {
    repositoryRoot: string;
  };
}

export interface DialectV1 {
  dialectVersion: 1;
  id: string;
  auth: AuthenticationKind;
  search: {
    method: 'GET' | 'POST';
    path: string;
    queryLocation: 'json' | 'query';
    userIdLocation: ScopeLocation;
    agentIdLocation: ScopeLocation;
    appIdLocation: ScopeLocation;
    limitField: 'top_k' | 'limit' | 'omit';
    threshold?: number;
    rerank?: boolean;
  };
  response: {
    collection: 'results' | 'root-array';
    idField: 'id' | 'memory_id';
    contentField: 'memory' | 'content' | 'text';
    titleField: 'title' | 'omit';
    uriField: 'uri' | 'omit';
    scoreField: 'score' | 'omit';
    updatedAtField: 'updated_at' | 'updatedAt' | 'omit';
  };
}

export interface RuntimeConfiguration {
  instance: InstanceConfigV2;
  dialect: DialectV1;
  credential: string;
}

export interface AutoRecallRuntimeConfiguration {
  instance: InstanceConfigV3;
  dialect: DialectV1;
  credential: string;
}

export type SearchRuntimeConfiguration =
  | RuntimeConfiguration
  | AutoRecallRuntimeConfiguration;

export interface ExternalContextItem {
  id: string;
  content: string;
  title?: string;
  uri?: string;
  score?: number;
  updatedAt?: string;
}

export interface SearchInput {
  query: string;
  signal: AbortSignal;
}

export type SearchProvider = (
  input: SearchInput,
) => Promise<readonly ExternalContextItem[]>;
