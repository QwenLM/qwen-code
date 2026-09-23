/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mem0CompatibleProviderConfig, Mem0PresetId } from './types.js';

export type Mem0Authentication =
  | 'authorization-token'
  | 'authorization-bearer'
  | 'x-api-key';

export type Mem0ScopePlacement = 'body' | 'filters' | 'omit';

interface Mem0ScopeRule {
  required: boolean;
  search: Mem0ScopePlacement;
  write: Mem0ScopePlacement;
}

export interface Mem0Preset {
  authentication: Mem0Authentication;
  scope: {
    userId: Mem0ScopeRule;
    agentId: Mem0ScopeRule;
    appId: Mem0ScopeRule;
  };
  search: {
    path: string;
    limitField: 'top_k' | 'limit';
    fixedBody?: Readonly<Record<string, number | boolean>>;
    idField: 'id' | 'memory_id';
    contentFields: ReadonlyArray<'memory' | 'content' | 'text'>;
  };
  write?:
    | {
        path: string;
        response: 'async-status';
      }
    | {
        path: string;
        response: 'results-id';
        idField: 'id' | 'memory_id';
      };
}

const omittedScope: Mem0ScopeRule = {
  required: false,
  search: 'omit',
  write: 'omit',
};

export const MEM0_PRESETS: Readonly<Record<Mem0PresetId, Mem0Preset>> = {
  'mem0-platform-v3': {
    authentication: 'authorization-token',
    scope: {
      userId: omittedScope,
      agentId: omittedScope,
      appId: { required: true, search: 'filters', write: 'body' },
    },
    search: {
      path: '/v3/memories/search/',
      limitField: 'top_k',
      fixedBody: { threshold: 0.1, rerank: false },
      idField: 'id',
      contentFields: ['memory'],
    },
    write: {
      path: '/v3/memories/add/',
      response: 'async-status',
    },
  },
  'mem0-oss-rest-2026-08': {
    authentication: 'x-api-key',
    scope: {
      userId: { required: true, search: 'filters', write: 'body' },
      agentId: { required: false, search: 'filters', write: 'body' },
      appId: omittedScope,
    },
    search: {
      path: '/search',
      limitField: 'top_k',
      idField: 'id',
      contentFields: ['memory', 'content'],
    },
    write: {
      path: '/memories',
      response: 'results-id',
      idField: 'id',
    },
  },
  'aliyun-polardb-mysql-2026-08': {
    authentication: 'authorization-token',
    scope: {
      userId: { required: true, search: 'filters', write: 'body' },
      agentId: { required: false, search: 'body', write: 'body' },
      appId: omittedScope,
    },
    search: {
      path: '/v2/memories/search',
      limitField: 'top_k',
      idField: 'id',
      contentFields: ['memory'],
    },
    write: {
      path: '/v1/memories',
      response: 'results-id',
      idField: 'id',
    },
  },
};

export function getMem0Preset(id: Mem0PresetId): Mem0Preset {
  return MEM0_PRESETS[id];
}

export function isValidMem0Scope(
  config: Pick<Mem0CompatibleProviderConfig, 'preset' | 'scope'>,
): boolean {
  const rules = getMem0Preset(config.preset).scope;
  return (['userId', 'agentId', 'appId'] as const).every((key) => {
    const rule = rules[key];
    const value = config.scope[key];
    if (rule.required) {
      return value !== undefined;
    }
    if (rule.search === 'omit' && rule.write === 'omit') {
      return value === undefined;
    }
    return true;
  });
}
