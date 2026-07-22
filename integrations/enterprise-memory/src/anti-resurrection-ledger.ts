/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';
import type { DeletionReason, MemoryScope } from './domain.js';
import { readBoundedJson } from './http-json.js';

export interface RawEventReceipt {
  key: string;
  receivedAt: Date;
  purgeAt: Date;
  state: 'received' | 'purged';
}

export interface DeletionReceipt {
  key: string;
  scope: MemoryScope;
  reason: DeletionReason;
  state: 'deletion_intent' | 'erased';
  createdAt: Date;
}

export interface AntiResurrectionLedger {
  ensureRawReceipt(
    tenantId: string,
    eventId: string,
    receivedAt: Date,
    purgeAt: Date,
  ): Promise<RawEventReceipt>;
  markRawPurged(tenantId: string, eventId: string): Promise<void>;
  getRawReceipt(
    tenantId: string,
    eventId: string,
  ): Promise<RawEventReceipt | null>;
  beginDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
  ): Promise<DeletionReceipt>;
  markErased(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<void>;
  getDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<DeletionReceipt | null>;
}

export class LedgerKeyFactory {
  constructor(private readonly secret: Uint8Array) {}

  rawEvent(tenantId: string, eventId: string): string {
    return this.derive('raw-event-v1', tenantId, eventId);
  }

  deletion(tenantId: string, memoryId: string, version: number): string {
    return this.derive('canonical-deletion-v1', tenantId, memoryId, version);
  }

  private derive(purpose: string, ...parts: readonly unknown[]): string {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify([purpose, ...parts]))
      .digest('base64url');
  }
}

export class InMemoryAntiResurrectionLedger implements AntiResurrectionLedger {
  private readonly rawReceipts = new Map<string, RawEventReceipt>();
  private readonly deletions = new Map<string, DeletionReceipt>();

  constructor(private readonly keys: LedgerKeyFactory) {}

  async ensureRawReceipt(
    tenantId: string,
    eventId: string,
    receivedAt: Date,
    purgeAt: Date,
  ): Promise<RawEventReceipt> {
    const key = this.keys.rawEvent(tenantId, eventId);
    const existing = this.rawReceipts.get(key);
    if (existing) {
      return structuredClone(existing);
    }
    const receipt: RawEventReceipt = {
      key,
      receivedAt,
      purgeAt,
      state: 'received',
    };
    this.rawReceipts.set(key, receipt);
    return structuredClone(receipt);
  }

  async markRawPurged(tenantId: string, eventId: string): Promise<void> {
    const key = this.keys.rawEvent(tenantId, eventId);
    const receipt = this.rawReceipts.get(key);
    if (!receipt) {
      throw new Error('Raw event receipt does not exist');
    }
    receipt.state = 'purged';
  }

  async getRawReceipt(
    tenantId: string,
    eventId: string,
  ): Promise<RawEventReceipt | null> {
    const receipt = this.rawReceipts.get(this.keys.rawEvent(tenantId, eventId));
    return receipt ? structuredClone(receipt) : null;
  }

  async beginDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
  ): Promise<DeletionReceipt> {
    const key = this.keys.deletion(tenantId, canonicalMemoryId, version);
    const existing = this.deletions.get(key);
    if (existing) {
      if (existing.scope !== scope || existing.reason !== reason) {
        throw new Error('Deletion intent binding conflict');
      }
      return structuredClone(existing);
    }
    const receipt: DeletionReceipt = {
      key,
      scope,
      reason,
      state: 'deletion_intent',
      createdAt,
    };
    this.deletions.set(key, receipt);
    return structuredClone(receipt);
  }

  async markErased(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<void> {
    const key = this.keys.deletion(tenantId, canonicalMemoryId, version);
    const deletion = this.deletions.get(key);
    if (!deletion) {
      throw new Error('Deletion intent does not exist');
    }
    deletion.state = 'erased';
  }

  async getDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<DeletionReceipt | null> {
    const deletion = this.deletions.get(
      this.keys.deletion(tenantId, canonicalMemoryId, version),
    );
    return deletion ? structuredClone(deletion) : null;
  }
}

export interface HttpLedgerOptions {
  baseUrl: string;
  bearerToken: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class HttpAntiResurrectionLedger implements AntiResurrectionLedger {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpLedgerOptions) {
    requireHttps(options.baseUrl, 'Anti-resurrection ledger');
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async ensureRawReceipt(
    tenantId: string,
    eventId: string,
    receivedAt: Date,
    purgeAt: Date,
  ): Promise<RawEventReceipt> {
    const value = await this.request<SerializedRawReceipt>('/v1/raw-receipts', {
      method: 'PUT',
      body: JSON.stringify({
        tenant_id: tenantId,
        event_id: eventId,
        received_at: receivedAt.toISOString(),
        purge_at: purgeAt.toISOString(),
      }),
    });
    return deserializeRawReceipt(value);
  }

  async markRawPurged(tenantId: string, eventId: string): Promise<void> {
    await this.request('/v1/raw-receipts:purge', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId, event_id: eventId }),
    });
  }

  async getRawReceipt(
    tenantId: string,
    eventId: string,
  ): Promise<RawEventReceipt | null> {
    const response = await this.requestNullable<SerializedRawReceipt>(
      '/v1/raw-receipts:lookup',
      {
        method: 'POST',
        body: JSON.stringify({ tenant_id: tenantId, event_id: eventId }),
      },
    );
    return response ? deserializeRawReceipt(response) : null;
  }

  async beginDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
  ): Promise<DeletionReceipt> {
    const value = await this.request<SerializedDeletionReceipt>(
      '/v1/deletions',
      {
        method: 'PUT',
        body: JSON.stringify({
          tenant_id: tenantId,
          canonical_memory_id: canonicalMemoryId,
          version,
          scope,
          reason,
          created_at: createdAt.toISOString(),
        }),
      },
    );
    return deserializeDeletionReceipt(value);
  }

  async markErased(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<void> {
    await this.request('/v1/deletions:erased', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: tenantId,
        canonical_memory_id: canonicalMemoryId,
        version,
      }),
    });
  }

  async getDeletion(
    tenantId: string,
    canonicalMemoryId: string,
    version: number,
  ): Promise<DeletionReceipt | null> {
    const value = await this.requestNullable<SerializedDeletionReceipt>(
      '/v1/deletions:lookup',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: tenantId,
          canonical_memory_id: canonicalMemoryId,
          version,
        }),
      },
    );
    return value ? deserializeDeletionReceipt(value) : null;
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.perform(path, init);
    if (!response.ok) {
      throw new Error(
        `Anti-resurrection ledger failed with ${response.status}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return readBoundedJson<T>(response, 32 * 1024);
  }

  private async requestNullable<T>(
    path: string,
    init: RequestInit,
  ): Promise<T | null> {
    const response = await this.perform(path, init);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Anti-resurrection ledger failed with ${response.status}`,
      );
    }
    return readBoundedJson<T>(response, 32 * 1024);
  }

  private perform(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImplementation(new URL(path, this.options.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        'content-type': 'application/json',
      },
      redirect: 'error',
      signal:
        init.signal ??
        AbortSignal.timeout(this.options.requestTimeoutMs ?? 3_000),
    });
  }
}

interface SerializedRawReceipt {
  key: string;
  received_at: string;
  purge_at: string;
  state: 'received' | 'purged';
}

interface SerializedDeletionReceipt {
  key: string;
  scope: MemoryScope;
  reason: DeletionReason;
  state: 'deletion_intent' | 'erased';
  created_at: string;
}

function deserializeRawReceipt(value: SerializedRawReceipt): RawEventReceipt {
  if (
    typeof value.received_at !== 'string' ||
    typeof value.purge_at !== 'string'
  ) {
    throw new Error('Anti-resurrection ledger returned an invalid raw receipt');
  }
  const receivedAt = new Date(value.received_at);
  const purgeAt = new Date(value.purge_at);
  if (
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    value.key.length > 512 ||
    (value.state !== 'received' && value.state !== 'purged') ||
    !Number.isFinite(receivedAt.getTime()) ||
    !Number.isFinite(purgeAt.getTime()) ||
    purgeAt <= receivedAt
  ) {
    throw new Error('Anti-resurrection ledger returned an invalid raw receipt');
  }
  return {
    key: value.key,
    receivedAt,
    purgeAt,
    state: value.state,
  };
}

function deserializeDeletionReceipt(
  value: SerializedDeletionReceipt,
): DeletionReceipt {
  if (typeof value.created_at !== 'string') {
    throw new Error('Anti-resurrection ledger returned an invalid deletion');
  }
  const createdAt = new Date(value.created_at);
  if (
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    value.key.length > 512 ||
    ![
      'user_request',
      'maintainer_request',
      'candidate_rejected',
      'retention_expired',
      'tenant_offboarding',
    ].includes(value.reason) ||
    (value.scope !== 'personal' && value.scope !== 'repository') ||
    (value.state !== 'deletion_intent' && value.state !== 'erased') ||
    !Number.isFinite(createdAt.getTime())
  ) {
    throw new Error('Anti-resurrection ledger returned an invalid deletion');
  }
  return {
    key: value.key,
    scope: value.scope,
    reason: value.reason,
    state: value.state,
    createdAt,
  };
}

function requireHttps(value: string, name: string): void {
  if (new URL(value).protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
}
