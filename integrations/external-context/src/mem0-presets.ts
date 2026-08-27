/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mem0CompatibleProviderConfig, Mem0PresetId } from './types.js';

// Every member of these unions is exercised by a shipped preset and pinned by
// a contract test. Widen one only together with the preset that needs it, so
// no reviewed wire contract is described by an untested branch.
export type Mem0Authentication = 'authorization-token' | 'x-api-key';

/**
 * Where a fixed scope selector is placed in a request body.
 *
 * `body-and-filters` writes the same key and value in both positions. It is
 * not a fallback or a probe: it is one fixed request that older and newer
 * builds of the same upstream both read as the identical scope. The Mem0
 * server moved session identity from the request root into `filters`, and
 * both shapes resolve through `_build_filters_and_metadata`, which seeds the
 * effective filters from `filters` and then overwrites each identity key with
 * the root value. Same key, same value, so the resolved scope is byte-equal
 * either way, and neither build silently searches an unscoped corpus.
 */
export type Mem0ScopePlacement =
  | 'body'
  | 'filters'
  | 'body-and-filters'
  | 'omit';

interface Mem0ScopeRule {
  required: boolean;
  search: Mem0ScopePlacement;
  write: Mem0ScopePlacement;
}

export interface Mem0Preset {
  /**
   * Who controls the build behind the endpoint.
   *
   * `managed` is one vendor-operated service with a published contract, so
   * there is no version skew for the integration to hedge against. Everything
   * else is deployed by the operator or packaged by a cloud, where the build
   * is unknown and a preset is a claim rather than a fact. Only the latter can
   * benefit from the compatibility hedges above, and only the latter should be
   * probed for them.
   */
  deployment: 'managed' | 'operator-deployed';
  authentication: Mem0Authentication;
  scope: {
    userId: Mem0ScopeRule;
    agentId: Mem0ScopeRule;
    appId: Mem0ScopeRule;
  };
  search: {
    path: string;
    limitField: 'top_k';
    fixedBody?: Readonly<Record<string, number | boolean>>;
    idField: 'id';
    contentFields: ReadonlyArray<'memory' | 'content'>;
  };
  write?:
    | {
        path: string;
        response: 'async-status';
      }
    | {
        path: string;
        response: 'results-id';
        idField: 'id';
      };
}

const omittedScope: Mem0ScopeRule = {
  required: false,
  search: 'omit',
  write: 'omit',
};

export const MEM0_PRESETS: Readonly<Record<Mem0PresetId, Mem0Preset>> = {
  'mem0-platform-v3': {
    deployment: 'managed',
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
  'mem0-server-rest-2026-08': {
    deployment: 'operator-deployed',
    authentication: 'x-api-key',
    scope: {
      userId: { required: true, search: 'body-and-filters', write: 'body' },
      agentId: { required: false, search: 'body-and-filters', write: 'body' },
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
  'polardb-mysql-2026-08': {
    deployment: 'operator-deployed',
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

export type Mem0ScopeKey = 'userId' | 'agentId' | 'appId';

export const MEM0_SCOPE_KEYS: readonly Mem0ScopeKey[] = [
  'userId',
  'agentId',
  'appId',
];

export interface Mem0ScopeViolation {
  key: Mem0ScopeKey;
  reason: 'missing' | 'unused';
}

/**
 * Returns the first scope key that breaks the selected preset's rules, or
 * `undefined` when the fixed scope is valid. The offending key and reason are
 * reported rather than a bare boolean because the rules are preset-dependent
 * and an administrator editing a local file cannot otherwise tell which of
 * three keys the preset rejected.
 */
export function findInvalidMem0Scope(
  config: Pick<Mem0CompatibleProviderConfig, 'preset' | 'scope'>,
): Mem0ScopeViolation | undefined {
  const rules = getMem0Preset(config.preset).scope;
  for (const key of MEM0_SCOPE_KEYS) {
    const rule = rules[key];
    const value = config.scope[key];
    if (rule.required) {
      if (value === undefined) {
        return { key, reason: 'missing' };
      }
      continue;
    }
    if (
      rule.search === 'omit' &&
      rule.write === 'omit' &&
      value !== undefined
    ) {
      return { key, reason: 'unused' };
    }
  }
  return undefined;
}

export function mem0ScopeViolationMessage(
  preset: Mem0PresetId,
  violation: Mem0ScopeViolation,
): string {
  return violation.reason === 'missing'
    ? `External context Mem0 scope is invalid: preset "${preset}" requires "${violation.key}".`
    : `External context Mem0 scope is invalid: preset "${preset}" does not use "${violation.key}", so it must be omitted.`;
}
