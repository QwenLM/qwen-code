/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProviderBinding, ProviderSearchResult } from './domain.js';
import type {
  IndexRecordRequest,
  SearchIndexRequest,
  SemanticIndex,
} from './semantic-index.js';
import { readBoundedJson } from './http-json.js';

interface Mem0Memory {
  id: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

interface Mem0Page {
  next: string | null;
  results: Mem0Memory[];
}

export interface Mem0SemanticIndexOptions {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export class Mem0SemanticIndex implements SemanticIndex {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly operationTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: Mem0SemanticIndexOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.mem0.ai';
    if (new URL(this.baseUrl).protocol !== 'https:') {
      throw new Error('Mem0 base URL must use https');
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    if (
      options.apiKey.length === 0 ||
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs <= 0 ||
      !Number.isSafeInteger(this.operationTimeoutMs) ||
      this.operationTimeoutMs <= 0
    ) {
      throw new Error('Mem0 adapter configuration is invalid');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async add(request: IndexRecordRequest): Promise<string> {
    const existing = await this.findExact(request);
    if (existing) {
      await this.ensureDiscoverable(request, existing.id);
      return existing.id;
    }
    const response = await this.request<{ event_id: string }>(
      '/v3/memories/add/',
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: request.summary }],
          ...entityField(request.scope, request.entityId),
          metadata: {
            canonical_memory_id: request.canonicalMemoryId,
            canonical_version: request.canonicalVersion,
            scope: request.scope,
          },
          infer: false,
        }),
      },
    );
    if (
      typeof response.event_id !== 'string' ||
      response.event_id.length === 0 ||
      response.event_id.length > 512
    ) {
      throw new Error('Mem0 add response has no event ID');
    }
    await this.waitForEvent(response.event_id);
    const indexed = await this.findExact(request);
    if (!indexed) {
      throw new Error('Mem0 add succeeded without exact indexed record');
    }
    await this.ensureDiscoverable(request, indexed.id);
    return indexed.id;
  }

  private async ensureDiscoverable(
    request: IndexRecordRequest,
    providerMemoryId: string,
  ): Promise<void> {
    const response = await this.request<{ results: Mem0Memory[] }>(
      '/v3/memories/search/',
      {
        method: 'POST',
        body: JSON.stringify({
          query: request.summary,
          filters: exactFilter(request),
          top_k: 1,
          threshold: 0,
          rerank: false,
          show_expired: false,
        }),
      },
    );
    if (
      !Array.isArray(response.results) ||
      response.results.length > 1 ||
      response.results[0]?.id !== providerMemoryId ||
      typeof response.results[0].score !== 'number' ||
      !Number.isFinite(response.results[0].score) ||
      response.results[0].score < 0 ||
      response.results[0].score > 1
    ) {
      throw new Error('Mem0 record is not discoverable after successful add');
    }
  }

  async search(
    request: SearchIndexRequest,
  ): Promise<readonly ProviderSearchResult[]> {
    const response = await this.request<{ results: Mem0Memory[] }>(
      '/v3/memories/search/',
      {
        method: 'POST',
        body: JSON.stringify({
          query: request.query,
          filters: entityFilter(request.scope, request.entityId),
          top_k: request.limit,
          threshold: request.threshold,
          rerank: false,
          show_expired: false,
        }),
      },
    );
    if (!Array.isArray(response.results)) {
      throw new Error('Mem0 search response has no results');
    }
    if (response.results.length > request.limit) {
      throw new Error('Mem0 search exceeded the requested result limit');
    }
    return response.results
      .map((item) => {
        if (
          typeof item.id !== 'string' ||
          item.id.length === 0 ||
          item.id.length > 512
        ) {
          throw new Error('Mem0 search returned an invalid memory ID');
        }
        if (
          typeof item.score !== 'number' ||
          !Number.isFinite(item.score) ||
          item.score < 0 ||
          item.score > 1
        ) {
          throw new Error('Mem0 search returned an invalid score');
        }
        return { providerMemoryId: item.id, score: item.score };
      })
      .filter((item) => item.score >= request.threshold);
  }

  async delete(binding: ProviderBinding): Promise<void> {
    await this.request(
      `/v1/memories/${encodeURIComponent(binding.providerMemoryId)}/`,
      { method: 'DELETE' },
      [404],
    );
    const exact = await this.findExact({
      tenantId: binding.tenantId,
      scope: binding.scope,
      entityId: binding.entityId,
      canonicalMemoryId: binding.canonicalMemoryId,
      canonicalVersion: binding.canonicalVersion,
      summary: '',
    });
    if (exact) {
      throw new Error('Mem0 deletion did not remove exact provider binding');
    }
  }

  private async waitForEvent(eventId: string): Promise<void> {
    const deadline = Date.now() + this.operationTimeoutMs;
    while (Date.now() < deadline) {
      const event = await this.request<Record<string, unknown>>(
        `/v1/event/${encodeURIComponent(eventId)}/`,
        { method: 'GET' },
      );
      const status = readEventStatus(event);
      if (status === 'SUCCEEDED') {
        return;
      }
      if (status === 'FAILED') {
        throw new Error('Mem0 asynchronous add failed');
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error('Mem0 asynchronous add timed out');
  }

  private async findExact(
    request: IndexRecordRequest,
  ): Promise<Mem0Memory | null> {
    const response = await this.request<Mem0Page>(
      '/v3/memories/?page=1&page_size=200',
      {
        method: 'POST',
        body: JSON.stringify({
          filters: exactFilter(request),
          show_expired: false,
        }),
      },
    );
    if (!Array.isArray(response.results)) {
      throw new Error('Mem0 exact lookup has no results');
    }
    const matches = response.results.filter(
      (item) =>
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        item.id.length <= 512 &&
        item.metadata?.['canonical_memory_id'] === request.canonicalMemoryId &&
        item.metadata?.['canonical_version'] === request.canonicalVersion,
    );
    if (
      matches.length !== response.results.length ||
      matches.length > 1 ||
      response.next !== null
    ) {
      throw new Error('Mem0 exact lookup was not unique');
    }
    return matches[0] ?? null;
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
    acceptedStatuses: readonly number[] = [],
  ): Promise<T> {
    const response = await this.fetchImplementation(
      new URL(path, this.baseUrl),
      {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Token ${this.options.apiKey}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(this.operationTimeoutMs),
      },
    );
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new Error(`Mem0 request failed with ${response.status}`);
    }
    if (response.status === 204 || acceptedStatuses.includes(response.status)) {
      return undefined as T;
    }
    return readBoundedJson<T>(response, 2 * 1024 * 1024);
  }
}

function entityField(
  scope: IndexRecordRequest['scope'],
  entityId: string,
): { user_id: string } | { app_id: string } {
  return scope === 'personal' ? { user_id: entityId } : { app_id: entityId };
}

function entityFilter(
  scope: IndexRecordRequest['scope'],
  entityId: string,
): { user_id: string } | { app_id: string } {
  return entityField(scope, entityId);
}

function exactFilter(request: IndexRecordRequest): {
  AND: readonly Record<string, string | number>[];
} {
  return {
    AND: [
      entityFilter(request.scope, request.entityId),
      { canonical_memory_id: request.canonicalMemoryId },
      { canonical_version: request.canonicalVersion },
    ],
  };
}

function readEventStatus(
  event: Record<string, unknown>,
): 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' {
  const metadata =
    typeof event['metadata'] === 'object' && event['metadata'] !== null
      ? (event['metadata'] as Record<string, unknown>)
      : undefined;
  const value =
    event['status'] ?? event['event_status'] ?? metadata?.['status'];
  if (
    value === 'PENDING' ||
    value === 'RUNNING' ||
    value === 'SUCCEEDED' ||
    value === 'FAILED'
  ) {
    return value;
  }
  throw new Error('Mem0 event response has no recognized status');
}
