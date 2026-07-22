/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  CanonicalMemoryRecord,
  DeletionReason,
  FeedbackSignal,
  MemoryScope,
  ProviderBinding,
  RawEventInput,
  RuntimeIdentity,
} from './domain.js';
import type { RawEventReceipt } from './anti-resurrection-ledger.js';

export interface StoreContext {
  tenantId: string;
  principalId: string;
  repositoryId: string;
}

export interface CanonicalStore {
  insertCandidate(
    identity: RuntimeIdentity,
    record: CanonicalMemoryRecord,
  ): Promise<CanonicalMemoryRecord>;
  getAuthorized(
    context: StoreContext,
    memoryId: string,
  ): Promise<CanonicalMemoryRecord | null>;
  getAuthorizedByProviderIds(
    context: StoreContext,
    providerMemoryIds: readonly string[],
  ): Promise<readonly CanonicalMemoryRecord[]>;
  reserveActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authorizationExpiresAt: Date | null,
  ): Promise<void>;
  releaseActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<void>;
  activateWithProvider(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authority: string,
    binding: ProviderBinding,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord>;
  getProviderBinding(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<ProviderBinding | null>;
  reserveErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord>;
  markPendingErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<CanonicalMemoryRecord>;
  eraseContent(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<void>;
  insertRawEvent(
    identity: RuntimeIdentity,
    event: RawEventInput,
    receipt: RawEventReceipt,
  ): Promise<boolean>;
  insertFeedback(
    identity: RuntimeIdentity,
    eventId: string,
    memoryId: string,
    signal: FeedbackSignal,
    occurredAt: Date,
    receivedAt: Date,
    sourceFingerprint: string,
  ): Promise<boolean>;
}

function canRead(
  context: StoreContext,
  record: CanonicalMemoryRecord,
): boolean {
  return (
    context.tenantId === record.tenantId &&
    ((record.scope === 'personal' && record.scopeId === context.principalId) ||
      (record.scope === 'repository' &&
        record.scopeId === context.repositoryId))
  );
}

export class InMemoryCanonicalStore implements CanonicalStore {
  private readonly records = new Map<string, CanonicalMemoryRecord>();
  private readonly sourceReceipts = new Map<
    string,
    {
      canonicalMemoryId: string;
      sourceFingerprint: string;
      state: 'live' | 'erased';
    }
  >();
  private readonly bindings = new Map<string, ProviderBinding>();
  private readonly activationReservations = new Map<string, number>();
  private readonly erasureReservations = new Map<
    string,
    {
      version: number;
      scope: MemoryScope;
      reason: DeletionReason;
      createdAt: Date;
    }
  >();
  private readonly rawEvents = new Map<string, string>();
  private readonly feedbackEvents = new Map<string, string>();

  async insertCandidate(
    identity: RuntimeIdentity,
    record: CanonicalMemoryRecord,
  ): Promise<CanonicalMemoryRecord> {
    const key = this.recordKey(identity.tenantId, record.id);
    if (!canRead(identity, record)) {
      throw new Error('Candidate scope is outside runtime identity');
    }
    const receiptKey = this.sourceReceiptKey(
      identity.tenantId,
      record.sourceOperationId,
    );
    const receipt = this.sourceReceipts.get(receiptKey);
    if (receipt?.state === 'erased') {
      throw new Error('Candidate source operation is no longer reusable');
    }
    if (
      receipt &&
      (receipt.canonicalMemoryId !== record.id ||
        receipt.sourceFingerprint !== record.sourceFingerprint)
    ) {
      throw new Error(
        'Operation ID was reused with different candidate content',
      );
    }
    const duplicate = [...this.records.values()].find(
      (item) =>
        item.tenantId === identity.tenantId &&
        item.sourceOperationId === record.sourceOperationId,
    );
    if (duplicate) {
      if (!canRead(identity, duplicate)) {
        throw new Error('Candidate scope is outside runtime identity');
      }
      if (duplicate.sourceFingerprint !== record.sourceFingerprint) {
        throw new Error(
          'Operation ID was reused with different candidate content',
        );
      }
      if (!receipt) {
        this.sourceReceipts.set(receiptKey, {
          canonicalMemoryId: record.id,
          sourceFingerprint: record.sourceFingerprint,
          state: 'live',
        });
      }
      return structuredClone(duplicate);
    }
    if (this.records.has(key)) {
      throw new Error('Canonical memory ID already exists');
    }
    if (!receipt) {
      this.sourceReceipts.set(receiptKey, {
        canonicalMemoryId: record.id,
        sourceFingerprint: record.sourceFingerprint,
        state: 'live',
      });
    }
    this.records.set(key, structuredClone(record));
    return structuredClone(record);
  }

  async getAuthorized(
    context: StoreContext,
    memoryId: string,
  ): Promise<CanonicalMemoryRecord | null> {
    const record = this.records.get(this.recordKey(context.tenantId, memoryId));
    return record && canRead(context, record) ? structuredClone(record) : null;
  }

  async getAuthorizedByProviderIds(
    context: StoreContext,
    providerMemoryIds: readonly string[],
  ): Promise<readonly CanonicalMemoryRecord[]> {
    const ids = new Set(providerMemoryIds);
    const result: CanonicalMemoryRecord[] = [];
    for (const binding of this.bindings.values()) {
      if (
        binding.tenantId !== context.tenantId ||
        !ids.has(binding.providerMemoryId) ||
        binding.state !== 'active'
      ) {
        continue;
      }
      const record = this.records.get(
        this.recordKey(context.tenantId, binding.canonicalMemoryId),
      );
      if (
        record &&
        record.version === binding.canonicalVersion &&
        record.lifecycleState === 'active' &&
        record.erasureState === 'live' &&
        canRead(context, record)
      ) {
        result.push(structuredClone(record));
      }
    }
    return result;
  }

  async activateWithProvider(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authority: string,
    binding: ProviderBinding,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord> {
    void authorizationExpiresAt;
    const record = this.requireRecord(context, memoryId);
    const activeVersion = expectedVersion + 1;
    if (
      this.erasureReservations.has(this.recordKey(context.tenantId, memoryId))
    ) {
      throw new Error('Candidate version conflict');
    }
    if (
      binding.tenantId !== context.tenantId ||
      binding.canonicalMemoryId !== memoryId ||
      binding.canonicalVersion !== activeVersion ||
      binding.scope !== record.scope
    ) {
      throw new Error('Provider binding does not match activation');
    }
    if (record.lifecycleState === 'active') {
      if (
        record.erasureState !== 'live' ||
        record.version !== activeVersion ||
        record.authority !== authority
      ) {
        throw new Error('Candidate version conflict');
      }
      const existing = this.bindings.get(
        this.bindingKey(context.tenantId, memoryId, activeVersion),
      );
      if (!existing || !sameProviderBinding(existing, binding)) {
        throw new Error('Provider binding conflict');
      }
      return structuredClone(record);
    } else if (
      record.erasureState !== 'live' ||
      record.version !== expectedVersion ||
      record.lifecycleState !== 'candidate' ||
      this.activationReservations.get(
        this.recordKey(context.tenantId, memoryId),
      ) !== expectedVersion
    ) {
      throw new Error('Candidate version conflict');
    }
    const active = {
      ...record,
      authority,
      lifecycleState: 'active' as const,
      version: activeVersion,
    };
    this.records.set(this.recordKey(context.tenantId, memoryId), active);
    this.bindings.set(
      this.bindingKey(
        binding.tenantId,
        binding.canonicalMemoryId,
        binding.canonicalVersion,
      ),
      structuredClone(binding),
    );
    this.activationReservations.delete(
      this.recordKey(context.tenantId, memoryId),
    );
    return structuredClone(active);
  }

  async reserveActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authorizationExpiresAt: Date | null,
  ): Promise<void> {
    void authorizationExpiresAt;
    const record = this.requireRecord(context, memoryId);
    const key = this.recordKey(context.tenantId, memoryId);
    const existing = this.activationReservations.get(key);
    if (existing !== undefined) {
      throw new Error('Provider activation is already in progress');
    }
    if (
      record.version !== expectedVersion ||
      record.lifecycleState !== 'candidate' ||
      record.erasureState !== 'live' ||
      this.erasureReservations.has(key)
    ) {
      throw new Error('Candidate version conflict');
    }
    this.activationReservations.set(key, expectedVersion);
  }

  async releaseActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<void> {
    const record = this.requireRecord(context, memoryId);
    const key = this.recordKey(context.tenantId, memoryId);
    if (
      record.version !== expectedVersion ||
      record.lifecycleState !== 'candidate' ||
      record.erasureState !== 'live' ||
      this.activationReservations.get(key) !== expectedVersion
    ) {
      throw new Error('Activation reservation binding conflict');
    }
    this.activationReservations.delete(key);
  }

  async getProviderBinding(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<ProviderBinding | null> {
    this.requireRecord(context, memoryId);
    const binding = this.bindings.get(
      this.bindingKey(context.tenantId, memoryId, version),
    );
    return binding ? structuredClone(binding) : null;
  }

  async markPendingErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<CanonicalMemoryRecord> {
    const record = this.requireRecord(context, memoryId);
    const reservation = this.erasureReservations.get(
      this.recordKey(context.tenantId, memoryId),
    );
    if (
      record.version !== expectedVersion ||
      reservation?.version !== expectedVersion
    ) {
      throw new Error('Memory version conflict');
    }
    const tombstoned: CanonicalMemoryRecord = {
      ...record,
      lifecycleState: 'tombstoned',
      erasureState: 'pending_erasure',
      version: record.version + 1,
    };
    this.records.set(this.recordKey(context.tenantId, memoryId), tombstoned);
    return structuredClone(tombstoned);
  }

  async reserveErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord> {
    void authorizationExpiresAt;
    const record = this.requireRecord(context, memoryId);
    const key = this.recordKey(context.tenantId, memoryId);
    const existing = this.erasureReservations.get(key);
    if (existing) {
      if (
        existing.version !== expectedVersion ||
        existing.scope !== scope ||
        existing.reason !== reason
      ) {
        throw new Error('Erasure reservation binding conflict');
      }
      if (
        !(
          (record.version === expectedVersion &&
            record.erasureState === 'live') ||
          (record.version === expectedVersion + 1 &&
            record.erasureState === 'pending_erasure')
        )
      ) {
        throw new Error('Memory version conflict');
      }
      return structuredClone(record);
    }
    if (this.activationReservations.has(key)) {
      throw new Error('Provider activation is in progress');
    }
    if (
      record.version !== expectedVersion ||
      record.erasureState !== 'live' ||
      record.scope !== scope
    ) {
      throw new Error('Memory version conflict');
    }
    this.erasureReservations.set(key, {
      version: expectedVersion,
      scope,
      reason,
      createdAt,
    });
    return structuredClone(record);
  }

  async eraseContent(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<void> {
    const record = this.requireRecord(context, memoryId);
    if (
      record.version !== version ||
      record.erasureState !== 'pending_erasure'
    ) {
      throw new Error('Memory is not pending erasure at expected version');
    }
    const receipt = this.sourceReceipts.get(
      this.sourceReceiptKey(context.tenantId, record.sourceOperationId),
    );
    if (!receipt || receipt.canonicalMemoryId !== memoryId) {
      throw new Error('Candidate source receipt is missing');
    }
    receipt.state = 'erased';
    this.records.delete(this.recordKey(context.tenantId, memoryId));
    this.activationReservations.delete(
      this.recordKey(context.tenantId, memoryId),
    );
    this.erasureReservations.delete(this.recordKey(context.tenantId, memoryId));
    const binding = this.bindings.get(
      this.bindingKey(context.tenantId, memoryId, version - 1),
    );
    if (binding) {
      binding.state = 'deleted';
    }
  }

  async insertRawEvent(
    identity: RuntimeIdentity,
    event: RawEventInput,
    receipt: RawEventReceipt,
  ): Promise<boolean> {
    if (receipt.state === 'purged') {
      throw new Error('Purged raw event cannot be recreated');
    }
    const key = `${identity.tenantId}:${event.eventId}`;
    const existing = this.rawEvents.get(key);
    if (existing && existing !== event.sourceFingerprint) {
      throw new Error('Event ID was reused with different content');
    }
    if (existing) {
      return false;
    }
    this.rawEvents.set(key, event.sourceFingerprint);
    return true;
  }

  async insertFeedback(
    identity: RuntimeIdentity,
    eventId: string,
    memoryId: string,
    _signal: FeedbackSignal,
    _occurredAt: Date,
    _receivedAt: Date,
    sourceFingerprint: string,
  ): Promise<boolean> {
    const record = this.records.get(
      this.recordKey(identity.tenantId, memoryId),
    );
    if (
      !record ||
      !canRead(identity, record) ||
      record.lifecycleState !== 'active' ||
      record.erasureState !== 'live' ||
      this.erasureReservations.has(this.recordKey(identity.tenantId, memoryId))
    ) {
      throw new Error('Canonical memory not found');
    }
    const key = `${identity.tenantId}:${eventId}`;
    const existing = this.feedbackEvents.get(key);
    if (existing && existing !== sourceFingerprint) {
      throw new Error('Event ID was reused with different content');
    }
    if (existing) {
      return false;
    }
    this.feedbackEvents.set(key, sourceFingerprint);
    return true;
  }

  private requireRecord(
    context: StoreContext,
    memoryId: string,
  ): CanonicalMemoryRecord {
    const record = this.records.get(this.recordKey(context.tenantId, memoryId));
    if (!record || !canRead(context, record)) {
      throw new Error('Canonical memory not found');
    }
    return record;
  }

  private recordKey(tenantId: string, memoryId: string): string {
    return `${tenantId}:${memoryId}`;
  }

  private bindingKey(
    tenantId: string,
    memoryId: string,
    version: number,
  ): string {
    return `${tenantId}:${memoryId}:${version}`;
  }

  private sourceReceiptKey(tenantId: string, operationId: string): string {
    return `${tenantId}:${operationId}`;
  }
}

interface MemoryRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  scope: 'personal' | 'repository';
  scope_id: string;
  content_ciphertext: string;
  content_key_handle: string;
  authority: string;
  lifecycle_state: CanonicalMemoryRecord['lifecycleState'];
  erasure_state: CanonicalMemoryRecord['erasureState'];
  version: number;
  source_operation_id: string;
  source_fingerprint: string;
  created_at: Date;
  expires_at: Date | null;
}

interface ProviderBindingRow extends QueryResultRow {
  tenant_id: string;
  canonical_memory_id: string;
  canonical_version: number;
  provider_memory_id: string;
  scope: ProviderBinding['scope'];
  entity_id: string;
  state: ProviderBinding['state'];
}

interface ErasureReservationRow extends QueryResultRow {
  canonical_version: number;
  scope: MemoryScope;
  reason: DeletionReason;
}

export class PostgresCanonicalStore implements CanonicalStore {
  constructor(private readonly pool: Pool) {}

  async insertCandidate(
    identity: RuntimeIdentity,
    record: CanonicalMemoryRecord,
  ): Promise<CanonicalMemoryRecord> {
    return this.transaction(identity, async (client) => {
      await this.requirePersonalWrite(
        client,
        record.tenantId,
        record.scope,
        record.scopeId,
      );
      await client.query(
        `INSERT INTO memory_source_receipts (
           tenant_id, source_operation_id, canonical_memory_id,
           source_fingerprint, state
         ) VALUES ($1,$2,$3,$4,'live')
         ON CONFLICT (tenant_id, source_operation_id) DO NOTHING`,
        [
          record.tenantId,
          record.sourceOperationId,
          record.id,
          record.sourceFingerprint,
        ],
      );
      const receipt = await client.query<{
        canonical_memory_id: string;
        source_fingerprint: string;
        state: string;
      }>(
        `SELECT canonical_memory_id, source_fingerprint, state
           FROM memory_source_receipts
          WHERE source_operation_id = $1`,
        [record.sourceOperationId],
      );
      if (receipt.rows[0]?.state === 'erased') {
        throw new Error('Candidate source operation is no longer reusable');
      }
      if (
        receipt.rows[0]?.canonical_memory_id !== record.id ||
        receipt.rows[0]?.source_fingerprint !== record.sourceFingerprint
      ) {
        throw new Error(
          'Operation ID was reused with different candidate content',
        );
      }
      const result = await client.query<MemoryRow>(
        `INSERT INTO memory_records (
           id, tenant_id, scope, scope_id, content_ciphertext,
           content_key_handle, authority, lifecycle_state,
           erasure_state, version, source_operation_id, source_fingerprint,
           created_at, expires_at
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
          WHERE $3 <> 'personal'
             OR EXISTS (
               SELECT 1 FROM personal_memory_preferences p
                WHERE p.tenant_id = $2
                  AND p.principal_id = $4
                  AND p.mode = 'read_write'
             )
         ON CONFLICT (tenant_id, source_operation_id) DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.tenantId,
          record.scope,
          record.scopeId,
          record.protectedContent.ciphertext,
          record.protectedContent.keyHandle,
          record.authority,
          record.lifecycleState,
          record.erasureState,
          record.version,
          record.sourceOperationId,
          record.sourceFingerprint,
          record.createdAt,
          record.expiresAt,
        ],
      );
      if (result.rows[0]) {
        return mapMemoryRow(result.rows[0]);
      }
      const existing = await client.query<MemoryRow>(
        `SELECT * FROM memory_records
          WHERE source_operation_id = $1
            AND (
              scope <> 'personal'
              OR EXISTS (
                SELECT 1 FROM personal_memory_preferences p
                 WHERE p.tenant_id = memory_records.tenant_id
                   AND p.principal_id = memory_records.scope_id
                   AND p.mode = 'read_write'
              )
            )`,
        [record.sourceOperationId],
      );
      const duplicate = mapMemoryRow(existing.rows[0]);
      if (duplicate.sourceFingerprint !== record.sourceFingerprint) {
        throw new Error(
          'Operation ID was reused with different candidate content',
        );
      }
      return duplicate;
    });
  }

  async getAuthorized(
    context: StoreContext,
    memoryId: string,
  ): Promise<CanonicalMemoryRecord | null> {
    return this.transaction(context, async (client) => {
      const result = await client.query<MemoryRow>(
        'SELECT * FROM memory_records WHERE id = $1',
        [memoryId],
      );
      return result.rows[0] ? mapMemoryRow(result.rows[0]) : null;
    });
  }

  async getAuthorizedByProviderIds(
    context: StoreContext,
    providerMemoryIds: readonly string[],
  ): Promise<readonly CanonicalMemoryRecord[]> {
    if (providerMemoryIds.length === 0) {
      return [];
    }
    return this.transaction(context, async (client) => {
      const result = await client.query<MemoryRow>(
        `SELECT m.*
           FROM provider_bindings b
           JOIN memory_records m
             ON m.tenant_id = b.tenant_id
            AND m.id = b.canonical_memory_id
            AND m.version = b.canonical_version
          WHERE b.provider_memory_id = ANY($1::text[])
            AND b.state = 'active'
            AND m.lifecycle_state = 'active'
            AND m.erasure_state = 'live'`,
        [providerMemoryIds],
      );
      return result.rows.map(mapMemoryRow);
    });
  }

  async reserveActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authorizationExpiresAt: Date | null,
  ): Promise<void> {
    await this.transaction(context, async (client) => {
      const result = await client.query<MemoryRow>(
        'SELECT * FROM memory_records WHERE id = $1 FOR UPDATE',
        [memoryId],
      );
      const record = mapMemoryRow(result.rows[0]);
      await this.requireCurrentAuthorization(client, authorizationExpiresAt);
      await this.requirePersonalWrite(
        client,
        record.tenantId,
        record.scope,
        record.scopeId,
      );
      if (
        record.version !== expectedVersion ||
        record.lifecycleState !== 'candidate' ||
        record.erasureState !== 'live'
      ) {
        throw new Error('Candidate version conflict');
      }
      const erasure = await client.query(
        `SELECT 1 FROM memory_erasure_reservations
          WHERE canonical_memory_id = $1`,
        [memoryId],
      );
      if (erasure.rowCount !== 0) {
        throw new Error('Candidate version conflict');
      }
      const reservation = await client.query(
        `INSERT INTO memory_activation_reservations (
           tenant_id, canonical_memory_id, canonical_version, created_at
         ) VALUES ($1,$2,$3,clock_timestamp())
         ON CONFLICT (tenant_id, canonical_memory_id) DO NOTHING`,
        [context.tenantId, memoryId, expectedVersion],
      );
      if (reservation.rowCount !== 1) {
        throw new Error('Provider activation is already in progress');
      }
    });
  }

  async releaseActivation(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.transaction(context, async (client) => {
      const result = await client.query(
        `DELETE FROM memory_activation_reservations r
          USING memory_records m
          WHERE m.id = $1 AND m.version = $2
            AND m.lifecycle_state = 'candidate'
            AND m.erasure_state = 'live'
            AND r.tenant_id = m.tenant_id
            AND r.canonical_memory_id = m.id
            AND r.canonical_version = m.version`,
        [memoryId, expectedVersion],
      );
      if (result.rowCount !== 1) {
        throw new Error('Activation reservation binding conflict');
      }
    });
  }

  async activateWithProvider(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    authority: string,
    binding: ProviderBinding,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord> {
    return this.transaction(context, async (client) => {
      if (
        binding.tenantId !== context.tenantId ||
        binding.canonicalMemoryId !== memoryId ||
        binding.canonicalVersion !== expectedVersion + 1
      ) {
        throw new Error('Provider binding does not match activation');
      }
      const locked = await client.query<
        Pick<MemoryRow, 'scope' | 'scope_id' | 'tenant_id'>
      >(
        `SELECT tenant_id, scope, scope_id
           FROM memory_records
          WHERE id = $1
          FOR UPDATE`,
        [memoryId],
      );
      const lockedRecord = locked.rows[0];
      if (!lockedRecord) {
        throw new Error('Candidate version conflict');
      }
      await this.requirePersonalWrite(
        client,
        lockedRecord.tenant_id,
        lockedRecord.scope,
        lockedRecord.scope_id,
      );
      const result = await client.query<MemoryRow>(
        `UPDATE memory_records
            SET lifecycle_state = 'active', authority = $3, version = version + 1
          WHERE id = $1 AND version = $2
            AND lifecycle_state = 'candidate' AND erasure_state = 'live'
            AND ($4::timestamptz IS NULL OR clock_timestamp() < $4)
            AND (
              scope <> 'personal'
              OR EXISTS (
                SELECT 1 FROM personal_memory_preferences p
                 WHERE p.tenant_id = memory_records.tenant_id
                   AND p.principal_id = memory_records.scope_id
                   AND p.mode = 'read_write'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_erasure_reservations r
               WHERE r.tenant_id = memory_records.tenant_id
                 AND r.canonical_memory_id = memory_records.id
            )
            AND EXISTS (
              SELECT 1 FROM memory_activation_reservations a
               WHERE a.tenant_id = memory_records.tenant_id
                 AND a.canonical_memory_id = memory_records.id
                 AND a.canonical_version = memory_records.version
            )
          RETURNING *`,
        [memoryId, expectedVersion, authority, authorizationExpiresAt],
      );
      const activatedCandidate = result.rows[0] !== undefined;
      let active = result.rows[0];
      if (!active) {
        const existing = await client.query<MemoryRow>(
          `SELECT * FROM memory_records
            WHERE id = $1 AND version = $2
              AND lifecycle_state = 'active'
              AND erasure_state = 'live'
              AND authority = $3
              AND ($4::timestamptz IS NULL OR clock_timestamp() < $4)
              AND NOT EXISTS (
                SELECT 1 FROM memory_erasure_reservations r
                 WHERE r.tenant_id = memory_records.tenant_id
                   AND r.canonical_memory_id = memory_records.id
              )`,
          [memoryId, expectedVersion + 1, authority, authorizationExpiresAt],
        );
        if (!existing.rows[0]) {
          throw new Error('Candidate version conflict');
        }
        active = existing.rows[0];
      }
      if (binding.scope !== active.scope) {
        throw new Error('Provider binding scope does not match activation');
      }
      const existingBinding = await client.query<ProviderBindingRow>(
        `SELECT * FROM provider_bindings
          WHERE canonical_memory_id = $1 AND canonical_version = $2`,
        [memoryId, expectedVersion + 1],
      );
      if (existingBinding.rows[0]) {
        if (
          !sameProviderBinding(
            mapProviderBindingRow(existingBinding.rows[0]),
            binding,
          )
        ) {
          throw new Error('Provider binding conflict');
        }
      } else {
        await client.query(
          `INSERT INTO provider_bindings (
             tenant_id, canonical_memory_id, canonical_version,
             provider_memory_id, scope, entity_id, state
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            binding.tenantId,
            binding.canonicalMemoryId,
            binding.canonicalVersion,
            binding.providerMemoryId,
            binding.scope,
            binding.entityId,
            binding.state,
          ],
        );
      }
      if (activatedCandidate) {
        const released = await client.query(
          `DELETE FROM memory_activation_reservations
            WHERE canonical_memory_id = $1 AND canonical_version = $2`,
          [memoryId, expectedVersion],
        );
        if (released.rowCount !== 1) {
          throw new Error('Activation reservation binding conflict');
        }
      }
      return mapMemoryRow(active);
    });
  }

  async getProviderBinding(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<ProviderBinding | null> {
    return this.transaction(context, async (client) => {
      const result = await client.query<ProviderBindingRow>(
        `SELECT * FROM provider_bindings
          WHERE canonical_memory_id = $1 AND canonical_version = $2`,
        [memoryId, version],
      );
      return result.rows[0] ? mapProviderBindingRow(result.rows[0]) : null;
    });
  }

  async markPendingErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
  ): Promise<CanonicalMemoryRecord> {
    return this.transaction(context, async (client) => {
      const result = await client.query<MemoryRow>(
        `UPDATE memory_records
            SET lifecycle_state = 'tombstoned',
                erasure_state = 'pending_erasure',
                version = version + 1
          WHERE id = $1 AND version = $2 AND erasure_state = 'live'
            AND EXISTS (
              SELECT 1 FROM memory_erasure_reservations r
               WHERE r.tenant_id = memory_records.tenant_id
                 AND r.canonical_memory_id = memory_records.id
                 AND r.canonical_version = $2
            )
          RETURNING *`,
        [memoryId, expectedVersion],
      );
      if (!result.rows[0]) {
        throw new Error('Memory version conflict');
      }
      return mapMemoryRow(result.rows[0]);
    });
  }

  async reserveErasure(
    context: StoreContext,
    memoryId: string,
    expectedVersion: number,
    scope: MemoryScope,
    reason: DeletionReason,
    createdAt: Date,
    authorizationExpiresAt: Date | null,
  ): Promise<CanonicalMemoryRecord> {
    return this.transaction(context, async (client) => {
      const result = await client.query<MemoryRow>(
        'SELECT * FROM memory_records WHERE id = $1 FOR UPDATE',
        [memoryId],
      );
      const record = mapMemoryRow(result.rows[0]);
      await this.requireCurrentAuthorization(client, authorizationExpiresAt);
      const reservations = await client.query<ErasureReservationRow>(
        `SELECT canonical_version, scope, reason
           FROM memory_erasure_reservations
          WHERE canonical_memory_id = $1`,
        [memoryId],
      );
      const existing = reservations.rows[0];
      if (existing) {
        if (
          existing.canonical_version !== expectedVersion ||
          existing.scope !== scope ||
          existing.reason !== reason
        ) {
          throw new Error('Erasure reservation binding conflict');
        }
        if (
          !(
            (record.version === expectedVersion &&
              record.erasureState === 'live') ||
            (record.version === expectedVersion + 1 &&
              record.erasureState === 'pending_erasure')
          )
        ) {
          throw new Error('Memory version conflict');
        }
        return record;
      }
      if (
        record.version !== expectedVersion ||
        record.erasureState !== 'live' ||
        record.scope !== scope
      ) {
        throw new Error('Memory version conflict');
      }
      const activation = await client.query(
        `SELECT 1 FROM memory_activation_reservations
          WHERE canonical_memory_id = $1`,
        [memoryId],
      );
      if (activation.rowCount !== 0) {
        throw new Error('Provider activation is in progress');
      }
      await client.query(
        `INSERT INTO memory_erasure_reservations (
           tenant_id, canonical_memory_id, canonical_version,
           scope, reason, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [context.tenantId, memoryId, expectedVersion, scope, reason, createdAt],
      );
      return record;
    });
  }

  async eraseContent(
    context: StoreContext,
    memoryId: string,
    version: number,
  ): Promise<void> {
    await this.transaction(context, async (client) => {
      const receipt = await client.query(
        `UPDATE memory_source_receipts r
            SET state = 'erased'
           FROM memory_records m
          WHERE m.id = $1 AND m.version = $2
            AND m.erasure_state = 'pending_erasure'
            AND r.source_operation_id = m.source_operation_id
            AND r.canonical_memory_id = m.id
          RETURNING r.source_operation_id`,
        [memoryId, version],
      );
      if (receipt.rowCount !== 1) {
        throw new Error('Candidate source receipt is missing');
      }
      const result = await client.query(
        `DELETE FROM memory_records
          WHERE id = $1 AND version = $2 AND erasure_state = 'pending_erasure'`,
        [memoryId, version],
      );
      if (result.rowCount !== 1) {
        throw new Error('Memory is not pending erasure at expected version');
      }
    });
  }

  async insertRawEvent(
    identity: RuntimeIdentity,
    event: RawEventInput,
    receipt: RawEventReceipt,
  ): Promise<boolean> {
    return this.transaction(identity, async (client) => {
      const result = await client.query(
        `INSERT INTO raw_events (
           tenant_id, event_id, principal_id, workspace_id, repository_id,
           session_id, turn_id, event_kind, occurred_at, received_at, purge_at,
           payload_ciphertext, content_key_handle, source_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [
          identity.tenantId,
          event.eventId,
          identity.principalId,
          identity.workspaceId,
          identity.repositoryId,
          event.sessionId,
          event.turnId,
          event.eventKind,
          event.occurredAt,
          receipt.receivedAt,
          receipt.purgeAt,
          event.protectedPayload.ciphertext,
          event.protectedPayload.keyHandle,
          event.sourceFingerprint,
        ],
      );
      if (result.rowCount === 1) {
        return true;
      }
      const duplicate = await client.query<{ source_fingerprint: string }>(
        'SELECT source_fingerprint FROM raw_events WHERE event_id = $1',
        [event.eventId],
      );
      if (duplicate.rows[0]?.source_fingerprint !== event.sourceFingerprint) {
        throw new Error('Event ID was reused with different content');
      }
      return false;
    });
  }

  async insertFeedback(
    identity: RuntimeIdentity,
    eventId: string,
    memoryId: string,
    signal: FeedbackSignal,
    occurredAt: Date,
    receivedAt: Date,
    sourceFingerprint: string,
  ): Promise<boolean> {
    return this.transaction(identity, async (client) => {
      const result = await client.query(
        `INSERT INTO memory_feedback (
           tenant_id, event_id, memory_id, memory_version, principal_id,
           signal, occurred_at, received_at, source_fingerprint
         )
         SELECT tenant_id, $1, id, version, $2, $3, $4, $5, $6
           FROM memory_records
          WHERE id = $7
            AND lifecycle_state = 'active'
            AND erasure_state = 'live'
            AND NOT EXISTS (
              SELECT 1 FROM memory_erasure_reservations r
               WHERE r.tenant_id = memory_records.tenant_id
                 AND r.canonical_memory_id = memory_records.id
            )
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [
          eventId,
          identity.principalId,
          signal,
          occurredAt,
          receivedAt,
          sourceFingerprint,
          memoryId,
        ],
      );
      if (result.rowCount === 1) {
        return true;
      }
      const duplicate = await client.query<{ source_fingerprint: string }>(
        'SELECT source_fingerprint FROM memory_feedback WHERE event_id = $1',
        [eventId],
      );
      if (duplicate.rows[0]?.source_fingerprint === sourceFingerprint) {
        return false;
      }
      if (duplicate.rowCount === 1) {
        throw new Error('Event ID was reused with different content');
      }
      throw new Error('Canonical memory not found');
    });
  }

  private async requirePersonalWrite(
    client: PoolClient,
    tenantId: string,
    scope: MemoryScope,
    principalId: string,
  ): Promise<void> {
    if (scope !== 'personal') {
      return;
    }
    const preference = await client.query<{ mode: string }>(
      `SELECT mode
         FROM personal_memory_preferences
        WHERE tenant_id = $1 AND principal_id = $2
        FOR SHARE`,
      [tenantId, principalId],
    );
    if (preference.rows[0]?.mode !== 'read_write') {
      throw new Error('Personal memory capture is disabled');
    }
  }

  private async requireCurrentAuthorization(
    client: PoolClient,
    authorizationExpiresAt: Date | null,
  ): Promise<void> {
    const authorization = await client.query<{ current: boolean }>(
      `SELECT $1::timestamptz IS NULL
           OR clock_timestamp() < $1 AS current`,
      [authorizationExpiresAt],
    );
    if (!authorization.rows[0]?.current) {
      throw new Error('Management authorization lease expired');
    }
  }

  private async transaction<T>(
    context: StoreContext,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.principal_id', $2, true),
                set_config('app.repository_id', $3, true)`,
        [context.tenantId, context.principalId, context.repositoryId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapMemoryRow(row: MemoryRow | undefined): CanonicalMemoryRecord {
  if (!row) {
    throw new Error('Database did not return a memory record');
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    scopeId: row.scope_id,
    protectedContent: {
      ciphertext: row.content_ciphertext,
      keyHandle: row.content_key_handle,
    },
    authority: row.authority,
    lifecycleState: row.lifecycle_state,
    erasureState: row.erasure_state,
    version: row.version,
    sourceOperationId: row.source_operation_id,
    sourceFingerprint: row.source_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapProviderBindingRow(row: ProviderBindingRow): ProviderBinding {
  return {
    tenantId: row.tenant_id,
    canonicalMemoryId: row.canonical_memory_id,
    canonicalVersion: row.canonical_version,
    providerMemoryId: row.provider_memory_id,
    scope: row.scope,
    entityId: row.entity_id,
    state: row.state,
  };
}

function sameProviderBinding(
  left: ProviderBinding,
  right: ProviderBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.canonicalMemoryId === right.canonicalMemoryId &&
    left.canonicalVersion === right.canonicalVersion &&
    left.providerMemoryId === right.providerMemoryId &&
    left.scope === right.scope &&
    left.entityId === right.entityId &&
    left.state === right.state
  );
}
