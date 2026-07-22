/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomUUID } from 'node:crypto';
import type {
  MemoryScope,
  ProviderBinding,
  ProviderSearchResult,
} from './domain.js';

export interface IndexScope {
  tenantId: string;
  scope: MemoryScope;
  entityId: string;
}

export interface IndexRecordRequest extends IndexScope {
  canonicalMemoryId: string;
  canonicalVersion: number;
  summary: string;
}

export interface SearchIndexRequest extends IndexScope {
  query: string;
  limit: number;
  threshold: number;
}

export interface SemanticIndex {
  add(request: IndexRecordRequest): Promise<string>;
  search(request: SearchIndexRequest): Promise<readonly ProviderSearchResult[]>;
  delete(binding: ProviderBinding): Promise<void>;
}

export class EntityIdMapper {
  constructor(
    private readonly secret: Uint8Array,
    private readonly keyVersion: string,
  ) {}

  personal(tenantId: string, principalId: string): string {
    return this.derive('personal', tenantId, principalId);
  }

  repository(tenantId: string, repositoryId: string): string {
    return this.derive('repository', tenantId, repositoryId);
  }

  private derive(
    scope: MemoryScope,
    tenantId: string,
    scopeId: string,
  ): string {
    const tenantKey = createHmac('sha256', this.secret)
      .update(JSON.stringify(['mem0-tenant-key-v1', tenantId]))
      .digest();
    const digest = createHmac('sha256', tenantKey)
      .update(JSON.stringify(['mem0-entity-v1', scope, scopeId]))
      .digest('base64url');
    return `em_${this.keyVersion}_${digest}`;
  }
}

interface FakeRecord extends IndexRecordRequest {
  providerMemoryId: string;
}

export class FakeSemanticIndex implements SemanticIndex {
  private readonly records = new Map<string, FakeRecord>();

  async add(request: IndexRecordRequest): Promise<string> {
    const existing = [...this.records.values()].find(
      (record) =>
        record.tenantId === request.tenantId &&
        record.scope === request.scope &&
        record.entityId === request.entityId &&
        record.canonicalMemoryId === request.canonicalMemoryId &&
        record.canonicalVersion === request.canonicalVersion,
    );
    if (existing) {
      return existing.providerMemoryId;
    }
    const providerMemoryId = randomUUID();
    this.records.set(providerMemoryId, { ...request, providerMemoryId });
    return providerMemoryId;
  }

  async search(
    request: SearchIndexRequest,
  ): Promise<readonly ProviderSearchResult[]> {
    const terms = new Set(
      request.query.toLowerCase().split(/\s+/).filter(Boolean),
    );
    return [...this.records.values()]
      .filter(
        (record) =>
          record.tenantId === request.tenantId &&
          record.scope === request.scope &&
          record.entityId === request.entityId,
      )
      .map((record) => {
        const text = record.summary.toLowerCase();
        const matches = [...terms].filter((term) => text.includes(term)).length;
        return {
          providerMemoryId: record.providerMemoryId,
          score: terms.size === 0 ? 0 : matches / terms.size,
        };
      })
      .filter((result) => result.score >= request.threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit);
  }

  async delete(binding: ProviderBinding): Promise<void> {
    const record = this.records.get(binding.providerMemoryId);
    if (
      record &&
      (record.tenantId !== binding.tenantId ||
        record.entityId !== binding.entityId)
    ) {
      throw new Error('Provider binding does not own indexed record');
    }
    this.records.delete(binding.providerMemoryId);
  }
}

export function sanitizeRetrievalQuery(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\r\n]{1,500}`/g, ' ')
    .replace(/\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}\b/gi, ' ')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, ' ')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length <= 64 && !looksHighEntropy(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

function looksHighEntropy(value: string): boolean {
  if (value.length < 24 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  const entropy = [...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum - probability * Math.log2(probability);
  }, 0);
  return entropy >= 4;
}
