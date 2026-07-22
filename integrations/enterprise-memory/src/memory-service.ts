/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { AntiResurrectionLedger } from './anti-resurrection-ledger.js';
import type { CanonicalStore, StoreContext } from './canonical-store.js';
import type { ContentProtector } from './content-protector.js';
import type {
  CandidateInput,
  CanonicalMemoryRecord,
  DeletionReason,
  FeedbackSignal,
  MemoryScope,
  PolicySnapshot,
  RawEventInput,
  RecalledMemory,
  RuntimeIdentity,
} from './domain.js';
import {
  type EntityIdMapper,
  sanitizeRetrievalQuery,
  type SemanticIndex,
} from './semantic-index.js';

export type PersonalMemoryMode = 'off' | 'read_only' | 'read_write';

export interface PrivacyIdentity {
  tenantId: string;
  principalId: string;
}

export interface PrivacyModeResolver {
  getPersonalMode(identity: PrivacyIdentity): Promise<PersonalMemoryMode>;
}

export interface PolicyResolver {
  getPolicy(identity: RuntimeIdentity): Promise<PolicySnapshot | null>;
}

export interface ManagementIdentity extends StoreContext {
  authority: 'data_subject' | 'repository_maintainer';
}

export interface MemoryServiceOptions {
  idempotencySecret: Uint8Array;
  rawRetentionMs?: number;
  personalRetentionMs?: number;
  searchLimit?: number;
  searchThreshold?: number;
  now?: () => Date;
  rawCaptureEnabled?: boolean;
  maxEventClockSkewMs?: number;
}

export interface SearchResponse {
  memories: readonly RecalledMemory[];
}

export interface TurnOpenRequest {
  eventId: string;
  sessionId: string;
  occurredAt: Date;
  prompt: string;
}

export interface TurnOpenResponse extends SearchResponse {
  turnId: string;
}

export interface CandidateReview {
  id: string;
  scope: MemoryScope;
  summary: string;
  references: readonly string[];
  version: number;
  state: 'candidate';
}

export interface TurnEventRequest {
  eventId: string;
  sessionId: string;
  turnId?: string;
  eventKind: string;
  occurredAt: Date;
  payload: unknown;
}

export class StaticPrivacyModeResolver implements PrivacyModeResolver {
  private readonly modes = new Map<string, PersonalMemoryMode>();

  set(tenantId: string, principalId: string, mode: PersonalMemoryMode): void {
    this.modes.set(JSON.stringify([tenantId, principalId]), mode);
  }

  async getPersonalMode(
    identity: PrivacyIdentity,
  ): Promise<PersonalMemoryMode> {
    return (
      this.modes.get(
        JSON.stringify([identity.tenantId, identity.principalId]),
      ) ?? 'off'
    );
  }
}

export class StaticPolicyResolver implements PolicyResolver {
  constructor(private readonly snapshot: PolicySnapshot | null = null) {}

  async getPolicy(): Promise<PolicySnapshot | null> {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }
}

export class MemoryService {
  private readonly rawRetentionMs: number;
  private readonly personalRetentionMs: number;
  private readonly searchLimit: number;
  private readonly searchThreshold: number;
  private readonly idempotencySecret: Uint8Array;
  private readonly now: () => Date;
  private readonly rawCaptureEnabled: boolean;
  private readonly maxEventClockSkewMs: number;

  constructor(
    private readonly store: CanonicalStore,
    private readonly ledger: AntiResurrectionLedger,
    private readonly contentProtector: ContentProtector,
    private readonly semanticIndex: SemanticIndex,
    private readonly entityIds: EntityIdMapper,
    private readonly privacyModes: PrivacyModeResolver,
    private readonly policies: PolicyResolver,
    options: MemoryServiceOptions,
  ) {
    this.rawRetentionMs = options.rawRetentionMs ?? 24 * 60 * 60 * 1000;
    this.personalRetentionMs =
      options.personalRetentionMs ?? 365 * 24 * 60 * 60 * 1000;
    this.searchLimit = options.searchLimit ?? 6;
    this.searchThreshold = options.searchThreshold ?? 0.1;
    this.idempotencySecret = options.idempotencySecret;
    this.now = options.now ?? (() => new Date());
    this.rawCaptureEnabled = options.rawCaptureEnabled ?? false;
    this.maxEventClockSkewMs = options.maxEventClockSkewMs ?? 5 * 60 * 1000;
    if (
      this.rawRetentionMs <= 0 ||
      this.rawRetentionMs > 24 * 60 * 60 * 1000 ||
      this.personalRetentionMs <= 0 ||
      this.searchLimit <= 0 ||
      this.maxEventClockSkewMs < 0
    ) {
      throw new Error(
        'Memory service retention or limit configuration is invalid',
      );
    }
  }

  async getSessionContext(
    identity: RuntimeIdentity,
  ): Promise<PolicySnapshot | null> {
    const snapshot = await this.policies.getPolicy(identity);
    if (!snapshot || snapshot.expiresAt <= this.now()) {
      return null;
    }
    if (
      !Number.isSafeInteger(snapshot.version) ||
      snapshot.version < 0 ||
      !Number.isFinite(snapshot.expiresAt.getTime()) ||
      snapshot.systemContext.length > 32_000
    ) {
      throw new Error('Policy snapshot is invalid');
    }
    return snapshot;
  }

  async openTurn(
    identity: RuntimeIdentity,
    request: TurnOpenRequest,
  ): Promise<TurnOpenResponse> {
    const turnId = deterministicUuid(
      createHmac('sha256', this.idempotencySecret)
        .update(
          JSON.stringify(['turn-id-v1', identity.tenantId, request.eventId]),
        )
        .digest(),
    );
    if (this.rawCaptureEnabled) {
      await this.recordRawEvent(identity, {
        eventId: request.eventId,
        sessionId: request.sessionId,
        turnId,
        eventKind: 'prompt',
        occurredAt: request.occurredAt,
        payload: { prompt: request.prompt },
      });
    }
    const recall = await this.search(identity, request.prompt);
    return { turnId, ...recall };
  }

  async recordTurnEvent(
    identity: RuntimeIdentity,
    request: TurnEventRequest,
  ): Promise<void> {
    if (this.rawCaptureEnabled) {
      await this.recordRawEvent(identity, request);
    }
  }

  async recordFeedback(
    identity: RuntimeIdentity,
    eventId: string,
    sessionId: string,
    memoryId: string,
    signal: FeedbackSignal,
    occurredAt: Date,
  ): Promise<void> {
    this.assertEventTime(occurredAt);
    await this.store.insertFeedback(
      identity,
      eventId,
      memoryId,
      signal,
      occurredAt,
      this.now(),
      this.fingerprint('feedback-idempotency-v1', [
        identity.tenantId,
        eventId,
        sessionId,
        memoryId,
        signal,
        occurredAt.toISOString(),
      ]),
    );
  }

  async propose(
    identity: RuntimeIdentity,
    input: CandidateInput,
    operationId: string,
  ): Promise<CanonicalMemoryRecord> {
    validateCandidate(input);
    if (
      input.scope === 'personal' &&
      (await this.privacyModes.getPersonalMode(identity)) !== 'read_write'
    ) {
      throw new Error('Personal memory capture is disabled');
    }
    const now = this.now();
    const scopeId =
      input.scope === 'personal' ? identity.principalId : identity.repositoryId;
    const protectedContent = await this.contentProtector.protect({
      tenantId: identity.tenantId,
      principalId:
        input.scope === 'personal' ? identity.principalId : undefined,
      sourceOperationId: operationId,
      plaintext: JSON.stringify({
        summary: input.summary,
        references: input.references,
      }),
      expiresAt:
        input.scope === 'personal'
          ? new Date(now.getTime() + this.personalRetentionMs)
          : null,
    });
    const record: CanonicalMemoryRecord = {
      id: randomUUID(),
      tenantId: identity.tenantId,
      scope: input.scope,
      scopeId,
      protectedContent,
      authority: 'model_proposal',
      lifecycleState: 'candidate',
      erasureState: 'live',
      version: 1,
      sourceOperationId: operationId,
      sourceFingerprint: createHmac('sha256', this.idempotencySecret)
        .update(
          JSON.stringify([
            'candidate-idempotency-v1',
            identity.tenantId,
            operationId,
            input.scope,
            input.summary,
            input.references,
          ]),
        )
        .digest('base64url'),
      createdAt: now,
      expiresAt:
        input.scope === 'personal'
          ? new Date(now.getTime() + this.personalRetentionMs)
          : null,
    };
    try {
      const stored = await this.store.insertCandidate(identity, record);
      if (stored.id !== record.id) {
        await this.contentProtector.destroy(
          identity.tenantId,
          protectedContent.keyHandle,
        );
      }
      return stored;
    } catch (error) {
      await this.contentProtector.destroy(
        identity.tenantId,
        protectedContent.keyHandle,
      );
      throw error;
    }
  }

  async approveCandidate(
    manager: ManagementIdentity,
    memoryId: string,
    expectedVersion: number,
  ): Promise<CanonicalMemoryRecord> {
    const candidate = await this.store.getAuthorized(manager, memoryId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }
    assertManagementAuthority(manager, candidate.scope);
    if (
      candidate.scope === 'personal' &&
      (await this.privacyModes.getPersonalMode(manager)) !== 'read_write'
    ) {
      throw new Error('Personal memory capture is disabled');
    }
    const authority =
      candidate.scope === 'personal' ? 'user_confirmed' : 'maintainer_approved';
    if (candidate.lifecycleState === 'active') {
      if (
        candidate.erasureState === 'live' &&
        candidate.version === expectedVersion + 1 &&
        candidate.authority === authority
      ) {
        return candidate;
      }
      throw new Error('Candidate version conflict');
    }
    if (
      candidate.lifecycleState !== 'candidate' ||
      candidate.erasureState !== 'live' ||
      candidate.version !== expectedVersion ||
      (candidate.expiresAt !== null && candidate.expiresAt <= this.now())
    ) {
      throw new Error('Candidate version conflict');
    }
    const content = await this.revealCanonicalContent(
      candidate.tenantId,
      candidate.protectedContent,
    );
    const canonicalVersion = expectedVersion + 1;
    const entityId = this.entityId(candidate, manager);
    const providerMemoryId = await this.semanticIndex.add({
      tenantId: candidate.tenantId,
      scope: candidate.scope,
      entityId,
      canonicalMemoryId: candidate.id,
      canonicalVersion,
      summary: content.summary,
    });
    return this.store.activateWithProvider(
      manager,
      memoryId,
      expectedVersion,
      authority,
      {
        tenantId: candidate.tenantId,
        canonicalMemoryId: candidate.id,
        canonicalVersion,
        providerMemoryId,
        scope: candidate.scope,
        entityId,
        state: 'active',
      },
    );
  }

  async getCandidateForReview(
    manager: ManagementIdentity,
    memoryId: string,
  ): Promise<CandidateReview | null> {
    const candidate = await this.store.getAuthorized(manager, memoryId);
    if (
      !candidate ||
      candidate.lifecycleState !== 'candidate' ||
      candidate.erasureState !== 'live'
    ) {
      return null;
    }
    assertManagementAuthority(manager, candidate.scope);
    const content = await this.revealCanonicalContent(
      candidate.tenantId,
      candidate.protectedContent,
    );
    return {
      id: candidate.id,
      scope: candidate.scope,
      summary: content.summary,
      references: content.references,
      version: candidate.version,
      state: 'candidate',
    };
  }

  async search(
    identity: RuntimeIdentity,
    prompt: string,
  ): Promise<SearchResponse> {
    const query = sanitizeRetrievalQuery(prompt);
    if (!query) {
      return { memories: [] };
    }
    const searches: Promise<
      readonly { providerMemoryId: string; score: number }[]
    >[] = [];
    const personalMode = await this.privacyModes.getPersonalMode(identity);
    if (personalMode !== 'off') {
      searches.push(
        this.semanticIndex.search({
          tenantId: identity.tenantId,
          scope: 'personal',
          entityId: this.entityIds.personal(
            identity.tenantId,
            identity.principalId,
          ),
          query,
          limit: this.searchLimit,
          threshold: this.searchThreshold,
        }),
      );
    }
    searches.push(
      this.semanticIndex.search({
        tenantId: identity.tenantId,
        scope: 'repository',
        entityId: this.entityIds.repository(
          identity.tenantId,
          identity.repositoryId,
        ),
        query,
        limit: this.searchLimit,
        threshold: this.searchThreshold,
      }),
    );
    const providerResults = (await Promise.all(searches)).flat();
    const scoreByProviderId = new Map(
      providerResults.map((result) => [result.providerMemoryId, result.score]),
    );
    const records = await this.store.getAuthorizedByProviderIds(identity, [
      ...scoreByProviderId.keys(),
    ]);
    const recalled: RecalledMemory[] = [];
    for (const record of records) {
      if (record.expiresAt && record.expiresAt <= this.now()) {
        continue;
      }
      const deletion = await this.ledger.getDeletion(
        record.tenantId,
        record.id,
        record.version,
      );
      if (deletion) {
        continue;
      }
      const binding = await this.store.getProviderBinding(
        identity,
        record.id,
        record.version,
      );
      const content = await this.revealCanonicalContent(
        record.tenantId,
        record.protectedContent,
      );
      recalled.push({
        id: record.id,
        scope: record.scope,
        authority: record.authority,
        summary: content.summary,
        references: content.references,
        score: binding
          ? (scoreByProviderId.get(binding.providerMemoryId) ?? 0)
          : 0,
      });
    }
    recalled.sort((left, right) => right.score - left.score);
    return { memories: recalled.slice(0, this.searchLimit) };
  }

  async get(
    identity: RuntimeIdentity,
    memoryId: string,
  ): Promise<RecalledMemory | null> {
    const record = await this.store.getAuthorized(identity, memoryId);
    if (
      !record ||
      record.lifecycleState !== 'active' ||
      record.erasureState !== 'live' ||
      (record.expiresAt !== null && record.expiresAt <= this.now()) ||
      (record.scope === 'personal' &&
        (await this.privacyModes.getPersonalMode(identity)) === 'off') ||
      (await this.ledger.getDeletion(
        record.tenantId,
        record.id,
        record.version,
      ))
    ) {
      return null;
    }
    const content = await this.revealCanonicalContent(
      record.tenantId,
      record.protectedContent,
    );
    return {
      id: record.id,
      scope: record.scope,
      authority: record.authority,
      summary: content.summary,
      references: content.references,
      score: 1,
    };
  }

  async eraseMemory(
    manager: ManagementIdentity,
    memoryId: string,
    expectedVersion: number,
    scope: MemoryScope,
    reason: DeletionReason,
  ): Promise<void> {
    assertManagementAuthority(manager, scope);
    const existingDeletion = await this.ledger.getDeletion(
      manager.tenantId,
      memoryId,
      expectedVersion,
    );
    if (
      existingDeletion &&
      (existingDeletion.scope !== scope || existingDeletion.reason !== reason)
    ) {
      throw new Error('Deletion intent binding conflict');
    }
    let pending = await this.store.getAuthorized(manager, memoryId);
    if (!pending) {
      if (existingDeletion?.state === 'erased') {
        return;
      }
      if (existingDeletion?.state === 'deletion_intent') {
        await this.ledger.markErased(
          manager.tenantId,
          memoryId,
          expectedVersion,
        );
        return;
      }
      throw new Error('Memory not found');
    }
    if (pending.scope !== scope) {
      throw new Error('Memory scope mismatch');
    }
    if (!existingDeletion) {
      if (
        pending.version !== expectedVersion ||
        pending.erasureState !== 'live'
      ) {
        throw new Error('Memory version conflict');
      }
      const deletion = await this.ledger.beginDeletion(
        manager.tenantId,
        memoryId,
        expectedVersion,
        scope,
        reason,
        this.now(),
      );
      if (deletion.scope !== scope || deletion.reason !== reason) {
        throw new Error('Deletion intent binding conflict');
      }
      pending = await this.store.markPendingErasure(
        manager,
        memoryId,
        expectedVersion,
      );
    } else if (
      pending.version === expectedVersion &&
      pending.erasureState === 'live'
    ) {
      pending = await this.store.markPendingErasure(
        manager,
        memoryId,
        expectedVersion,
      );
    } else if (
      pending.version !== expectedVersion + 1 ||
      pending.erasureState !== 'pending_erasure'
    ) {
      throw new Error('Deletion state conflict');
    }

    const binding = await this.store.getProviderBinding(
      manager,
      memoryId,
      expectedVersion,
    );
    if (binding && binding.state !== 'deleted') {
      await this.semanticIndex.delete(binding);
    }
    await this.contentProtector.destroy(
      pending.tenantId,
      pending.protectedContent.keyHandle,
    );
    await this.store.eraseContent(manager, memoryId, pending.version);
    await this.ledger.markErased(manager.tenantId, memoryId, expectedVersion);
  }

  private async recordRawEvent(
    identity: RuntimeIdentity,
    request: TurnEventRequest & { payload: unknown },
  ): Promise<void> {
    const receivedAt = this.now();
    this.assertEventTime(request.occurredAt, receivedAt);
    const purgeAt = new Date(receivedAt.getTime() + this.rawRetentionMs);
    const receipt = await this.ledger.ensureRawReceipt(
      identity.tenantId,
      request.eventId,
      receivedAt,
      purgeAt,
    );
    if (
      receipt.state === 'purged' ||
      receipt.receivedAt > receivedAt ||
      receipt.purgeAt <= receipt.receivedAt ||
      receipt.purgeAt.getTime() - receipt.receivedAt.getTime() >
        this.rawRetentionMs ||
      receipt.purgeAt <= receivedAt
    ) {
      throw new Error('Raw event retention already expired');
    }
    const protectedPayload = await this.contentProtector.protect({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      sourceOperationId: request.eventId,
      plaintext: JSON.stringify(request.payload),
      expiresAt: receipt.purgeAt,
    });
    const event: RawEventInput = {
      eventId: request.eventId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      eventKind: request.eventKind,
      occurredAt: request.occurredAt,
      protectedPayload,
      sourceFingerprint: this.fingerprint('raw-event-idempotency-v1', [
        identity.tenantId,
        request.eventId,
        request.sessionId,
        request.turnId,
        request.eventKind,
        request.occurredAt.toISOString(),
        request.payload,
      ]),
    };
    try {
      const inserted = await this.store.insertRawEvent(
        identity,
        event,
        receipt,
      );
      if (!inserted) {
        await this.contentProtector.destroy(
          identity.tenantId,
          protectedPayload.keyHandle,
        );
      }
    } catch (error) {
      await this.contentProtector.destroy(
        identity.tenantId,
        protectedPayload.keyHandle,
      );
      throw error;
    }
  }

  private entityId(
    record: CanonicalMemoryRecord,
    context: StoreContext,
  ): string {
    return record.scope === 'personal'
      ? this.entityIds.personal(record.tenantId, context.principalId)
      : this.entityIds.repository(record.tenantId, context.repositoryId);
  }

  private fingerprint(purpose: string, parts: readonly unknown[]): string {
    return createHmac('sha256', this.idempotencySecret)
      .update(JSON.stringify([purpose, ...parts]))
      .digest('base64url');
  }

  private async revealCanonicalContent(
    tenantId: string,
    content: CanonicalMemoryRecord['protectedContent'],
  ): Promise<{ summary: string; references: readonly string[] }> {
    const plaintext = await this.contentProtector.reveal(tenantId, content);
    const value = JSON.parse(plaintext) as unknown;
    if (typeof value !== 'object' || value === null) {
      throw new Error('Canonical memory content is invalid');
    }
    const fields = value as Record<string, unknown>;
    const summary = fields['summary'];
    const references = fields['references'];
    if (
      typeof summary !== 'string' ||
      summary.length === 0 ||
      summary.length > 1_000 ||
      !Array.isArray(references) ||
      references.length > 10 ||
      !references.every(
        (reference) =>
          typeof reference === 'string' &&
          reference.length > 0 &&
          reference.length <= 500,
      )
    ) {
      throw new Error('Canonical memory content is invalid');
    }
    return {
      summary,
      references,
    };
  }

  private assertEventTime(occurredAt: Date, now = this.now()): void {
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      Math.abs(occurredAt.getTime() - now.getTime()) > this.maxEventClockSkewMs
    ) {
      throw new Error('Event timestamp is outside the allowed clock skew');
    }
  }
}

function deterministicUuid(digest: Uint8Array): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

function validateCandidate(input: CandidateInput): void {
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > 1_000) {
    throw new Error('Candidate summary must contain 1-1000 characters');
  }
  if (containsDisallowedCandidateContent(summary)) {
    throw new Error('Candidate summary contains disallowed content');
  }
  if (input.references.length > 10) {
    throw new Error('Candidate has too many references');
  }
  for (const reference of input.references) {
    if (
      reference.trim().length === 0 ||
      reference.length > 500 ||
      containsDisallowedCandidateContent(reference)
    ) {
      throw new Error('Candidate reference is invalid');
    }
  }
}

function containsDisallowedCandidateContent(value: string): boolean {
  return /```|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(
    value,
  );
}

function assertManagementAuthority(
  manager: ManagementIdentity,
  scope: MemoryScope,
): void {
  if (
    (scope === 'personal' && manager.authority !== 'data_subject') ||
    (scope === 'repository' && manager.authority !== 'repository_maintainer')
  ) {
    throw new Error('Management authority does not match memory scope');
  }
}
