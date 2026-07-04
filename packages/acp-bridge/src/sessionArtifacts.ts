/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  PersistedSessionArtifact,
  RebuiltSessionArtifactSnapshot,
  SessionArtifactContentRef,
  SessionArtifactEventRecordPayload,
  SessionArtifactPersistenceWarning,
  SessionArtifactRestoreState,
  SessionArtifactRetention,
  SessionArtifactSnapshotRecordPayload,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from './internal/stderrLine.js';

const SESSION_ARTIFACT_PERSISTENCE_VERSION = 2 as const;

function stableSessionArtifactId(
  sessionId: string,
  identityKey: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}:${identityKey}`)
    .digest('hex')
    .slice(0, 16);
}

export type DaemonSessionArtifactKind =
  | 'file'
  | 'link'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'notebook'
  | 'other';

export type DaemonSessionArtifactStorage =
  | 'workspace'
  | 'external_url'
  | 'managed'
  | 'published';

export type DaemonSessionArtifactSource = 'tool' | 'hook' | 'client';

export type DaemonSessionArtifactStatus = 'available' | 'missing';

const SOURCE_RESERVATIONS: Record<DaemonSessionArtifactSource, number> = {
  tool: 100,
  client: 50,
  hook: 50,
};
const WORKSPACE_STATUS_REFRESH_TTL_MS = 5_000;
const WORKSPACE_STATUS_REFRESH_BATCH_SIZE = 20;
const SNAPSHOT_AFTER_DURABLE_EVENTS = 50;

export interface ToolArtifactLike {
  kind?: DaemonSessionArtifactKind;
  storage?: DaemonSessionArtifactStorage;
  title: string;
  description?: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SessionArtifactInput extends ToolArtifactLike {
  source?: DaemonSessionArtifactSource;
  retention?: SessionArtifactRetention;
  clientRetained?: boolean;
  toolCallId?: string;
  toolName?: string;
  hookEventName?: string;
  clientId?: string;
}

export interface DaemonSessionArtifact {
  id: string;
  kind: DaemonSessionArtifactKind;
  storage: DaemonSessionArtifactStorage;
  source: DaemonSessionArtifactSource;
  status: DaemonSessionArtifactStatus;
  title: string;
  description?: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string | number | boolean | null>;
  retention: SessionArtifactRetention;
  restoreState?: SessionArtifactRestoreState;
  persistenceWarning?: SessionArtifactPersistenceWarning;
  contentRef?: SessionArtifactContentRef;
  persistedAt?: string;
  expiresAt?: string;
  clientRetained: boolean;
  createdAt: string;
  updatedAt: string;
  toolCallId?: string;
  toolName?: string;
  hookEventName?: string;
  clientId?: string;
}

export type SessionArtifactRemovalReason =
  | 'eviction'
  | 'explicit'
  | 'unpin_to_ephemeral';

export interface SessionArtifactChange {
  action: 'created' | 'updated' | 'removed';
  artifactId: string;
  artifact?: DaemonSessionArtifact;
  reason?: SessionArtifactRemovalReason;
}

export interface SessionArtifactsEnvelope {
  v: 1;
  sessionId: string;
  artifacts: DaemonSessionArtifact[];
  generatedAt: string;
  limits: {
    maxArtifacts: number;
  };
}

export interface SessionArtifactMutationResult {
  v: 1;
  sessionId: string;
  changes: SessionArtifactChange[];
  warnings?: string[];
}

export interface SessionArtifactPersistence {
  recordEvent(payload: SessionArtifactEventRecordPayload): Promise<void>;
  recordSnapshot(payload: SessionArtifactSnapshotRecordPayload): Promise<void>;
}

export class SessionArtifactValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SessionArtifactValidationError';
  }
}

interface SessionArtifactStoreOptions {
  sessionId: string;
  workspaceCwd: string;
  maxArtifacts?: number;
  persistence?: SessionArtifactPersistence;
}

interface NormalizedArtifact extends DaemonSessionArtifact {
  identityKey: string;
  receivedSeq: number;
  retentionSource: DaemonSessionArtifactSource;
  trustedPublisher: boolean;
  lastStatAt?: number;
}

interface StoredArtifact extends NormalizedArtifact {
  insertSeq: number;
}

export class SessionArtifactStore {
  private readonly sessionId: string;
  private readonly workspaceCwd: string;
  private readonly maxArtifacts: number;
  private readonly persistence?: SessionArtifactPersistence;
  private readonly artifacts = new Map<string, StoredArtifact>();
  private receivedSeq = 0;
  private insertSeq = 0;
  private persistenceSeq = 0;
  private durableEventsSinceSnapshot = 0;
  private realWorkspaceCwdPromise?: Promise<string>;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly tombstonedIds = new Set<string>();
  private readonly stickyEphemeralIds = new Set<string>();

  constructor(options: SessionArtifactStoreOptions) {
    this.sessionId = options.sessionId;
    this.workspaceCwd = options.workspaceCwd;
    this.maxArtifacts = options.maxArtifacts ?? 200;
    this.persistence = options.persistence;
  }

  inputBatchLimit(): number {
    return this.maxArtifacts * 2;
  }

  async list(): Promise<SessionArtifactsEnvelope> {
    return this.enqueue(async () => {
      await this.refreshWorkspaceStatuses();
      return {
        v: 1,
        sessionId: this.sessionId,
        artifacts: Array.from(this.artifacts.values())
          .sort((a, b) => a.insertSeq - b.insertSeq)
          .map(toPublicArtifact),
        generatedAt: new Date().toISOString(),
        limits: { maxArtifacts: this.maxArtifacts },
      };
    });
  }

  async get(artifactId: string): Promise<DaemonSessionArtifact | undefined> {
    return this.enqueue(async () => {
      const artifact = this.artifacts.get(artifactId);
      if (!artifact) return undefined;
      if (
        artifact.workspacePath &&
        shouldRefreshWorkspaceStatus(artifact, Date.now())
      ) {
        await this.refreshWorkspaceStatus(artifact, { onError: 'missing' });
      }
      return toPublicArtifact(artifact);
    });
  }

  async contentRefs(): Promise<SessionArtifactContentRef[]> {
    return this.enqueue(async () =>
      Array.from(this.artifacts.values())
        .map((artifact) => artifact.contentRef)
        .filter((ref): ref is SessionArtifactContentRef => ref !== undefined),
    );
  }

  async upsertMany(
    inputs: SessionArtifactInput[],
    options: { strict?: boolean; trustedPublisher?: boolean } = {},
  ): Promise<SessionArtifactMutationResult> {
    return this.enqueue(async () => {
      const before = this.cloneState();
      const normalizedResults: NormalizedArtifact[] = [];
      const warnings: string[] = [];
      for (const input of inputs) {
        try {
          normalizedResults.push(
            await this.normalizeInput(
              input,
              ++this.receivedSeq,
              options.trustedPublisher === true,
            ),
          );
        } catch (error) {
          if (options.strict) {
            throw error;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          writeStderrLine(
            `[artifacts] session=${this.sessionId} action=dropped reason=${JSON.stringify(
              message,
            )}`,
          );
        }
      }
      const changes: SessionArtifactChange[] = [];
      try {
        for (const artifact of coalesceByIdentity(normalizedResults)) {
          const existing =
            this.artifacts.get(artifact.id) ??
            this.findPublishedUpgradeTarget(artifact) ??
            this.findPublishedWorkspaceTarget(artifact);
          if (!existing) {
            const stored: StoredArtifact = {
              ...artifact,
              insertSeq: ++this.insertSeq,
            };
            this.artifacts.set(stored.id, stored);
            changes.push({
              action: 'created',
              artifactId: stored.id,
              artifact: toPublicArtifact(stored),
            });
            continue;
          }

          const updated = mergeArtifact(existing, artifact);
          if (updated.changed) {
            if (updated.artifact.id !== existing.id) {
              this.artifacts.delete(existing.id);
            }
            this.artifacts.set(updated.artifact.id, updated.artifact);
            changes.push({
              action: 'updated',
              artifactId: updated.artifact.id,
              artifact: toPublicArtifact(updated.artifact),
            });
          }
        }

        const createdIds = new Set(
          changes
            .filter((change) => change.action === 'created')
            .map((change) => change.artifactId),
        );
        changes.push(...(await this.evictOverflow(createdIds, changes)));

        warnings.push(...(await this.persistChanges(changes, options.strict)));
      } catch (error) {
        if (options.strict) {
          this.restoreState(before);
        }
        throw error;
      }

      return {
        v: 1,
        sessionId: this.sessionId,
        changes,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  private findPublishedUpgradeTarget(
    artifact: NormalizedArtifact,
  ): StoredArtifact | undefined {
    if (
      artifact.storage !== 'published' ||
      !artifact.trustedPublisher ||
      !artifact.managedId ||
      !artifact.url
    ) {
      return undefined;
    }
    const byUrl = this.artifacts.get(
      stableSessionArtifactId(this.sessionId, `url:${artifact.url}`),
    );
    if (
      byUrl &&
      (byUrl.storage !== 'published' || byUrl.managedId === artifact.managedId)
    ) {
      return byUrl;
    }

    for (const existing of this.artifacts.values()) {
      if (
        (existing.storage === 'workspace' &&
          existing.workspacePath &&
          artifact.managedId ===
            managedIdForWorkspacePath(
              this.workspaceCwd,
              existing.workspacePath,
            )) ||
        (existing.storage === 'published' &&
          existing.managedId === artifact.managedId)
      ) {
        return existing;
      }
    }

    return undefined;
  }

  private findPublishedWorkspaceTarget(
    artifact: NormalizedArtifact,
  ): StoredArtifact | undefined {
    if (artifact.storage !== 'workspace' || !artifact.workspacePath) {
      return undefined;
    }
    const managedId = managedIdForWorkspacePath(
      this.workspaceCwd,
      artifact.workspacePath,
    );
    for (const existing of this.artifacts.values()) {
      if (
        existing.storage === 'published' &&
        existing.managedId === managedId
      ) {
        return existing;
      }
    }
    return undefined;
  }

  async remove(
    artifactId: string,
    options?: { clientId?: string },
  ): Promise<SessionArtifactMutationResult> {
    return this.enqueue(async () => {
      const before = this.cloneState();
      const existing = this.artifacts.get(artifactId);
      if (!existing) {
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      // Client-created artifacts with an owner require the same client id.
      // Tool/hook artifacts are session-scoped outputs and may be removed by
      // any caller that already passed session mutation auth.
      if (
        existing.source === 'client' &&
        existing.clientId !== undefined &&
        existing.clientId !== options?.clientId
      ) {
        writeStderrLine(
          `[artifacts] session=${this.sessionId} action=remove_denied artifactId=${artifactId} owner=${existing.clientId} requester=${options?.clientId ?? '<anonymous>'}`,
        );
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      this.artifacts.delete(artifactId);
      const changes: SessionArtifactChange[] = [
        {
          action: 'removed',
          artifactId,
          artifact: toPublicArtifact(existing),
          reason: 'explicit',
        },
      ];
      try {
        const warnings = await this.persistChanges(changes, true);
        return {
          v: 1,
          sessionId: this.sessionId,
          changes,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        this.restoreState(before);
        throw error;
      }
    });
  }

  async pin(
    artifactId: string,
    contentRef?: SessionArtifactContentRef,
  ): Promise<SessionArtifactMutationResult> {
    return this.enqueue(async () => {
      const before = this.cloneState();
      const existing = this.artifacts.get(artifactId);
      if (!existing) {
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      const updated: StoredArtifact = {
        ...existing,
        retention: 'pinned',
        clientRetained: true,
        restoreState: 'live',
        updatedAt: new Date().toISOString(),
        ...(contentRef
          ? { contentRef }
          : { persistenceWarning: 'metadata_only_restore' as const }),
      };
      if (contentRef) {
        delete updated.persistenceWarning;
      }
      this.artifacts.set(artifactId, updated);
      const changes: SessionArtifactChange[] = [
        {
          action: 'updated',
          artifactId,
          artifact: toPublicArtifact(updated),
        },
      ];
      try {
        const warnings = await this.persistChanges(changes, true);
        return {
          v: 1,
          sessionId: this.sessionId,
          changes,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        this.restoreState(before);
        throw error;
      }
    });
  }

  async unpin(artifactId: string): Promise<SessionArtifactMutationResult> {
    return this.enqueue(async () => {
      const before = this.cloneState();
      const existing = this.artifacts.get(artifactId);
      if (!existing) {
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      const updated: StoredArtifact = {
        ...existing,
        retention: 'restorable',
        restoreState: 'live',
        persistenceWarning: 'metadata_only_restore',
        updatedAt: new Date().toISOString(),
      };
      delete updated.contentRef;
      delete updated.expiresAt;
      this.artifacts.set(artifactId, updated);
      const changes: SessionArtifactChange[] = [
        {
          action: 'updated',
          artifactId,
          artifact: toPublicArtifact(updated),
        },
      ];
      try {
        const warnings = await this.persistChanges(changes, true);
        return {
          v: 1,
          sessionId: this.sessionId,
          changes,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        this.restoreState(before);
        throw error;
      }
    });
  }

  async restore(
    snapshot: RebuiltSessionArtifactSnapshot | undefined,
  ): Promise<string[]> {
    if (!snapshot) return [];
    return this.enqueue(async () => {
      const warnings = [...snapshot.warnings];
      this.artifacts.clear();
      this.tombstonedIds.clear();
      this.stickyEphemeralIds.clear();
      this.insertSeq = 0;
      this.persistenceSeq = snapshot.sequence;
      for (const id of snapshot.tombstonedIds) {
        this.tombstonedIds.add(id);
      }
      for (const id of snapshot.stickyEphemeralIds) {
        this.stickyEphemeralIds.add(id);
      }
      for (const artifact of snapshot.artifacts) {
        try {
          const input = persistedArtifactToInput(artifact);
          if (input.retention === 'pinned') {
            input.retention = 'restorable';
          }
          const normalized = await this.normalizeInput(
            input,
            ++this.receivedSeq,
            artifact.storage === 'published',
          );
          if (normalized.id !== artifact.id) {
            warnings.push(`skipped artifact with mismatched id ${artifact.id}`);
            continue;
          }
          const stored: StoredArtifact = {
            ...normalized,
            retention: artifact.retention,
            clientRetained: artifact.clientRetained,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            persistedAt: artifact.persistedAt,
            expiresAt: artifact.expiresAt,
            restoreState: 'restored',
            persistenceWarning: artifact.contentRef
              ? artifact.persistenceWarning
              : (artifact.persistenceWarning ?? 'metadata_only_restore'),
            contentRef: artifact.contentRef,
            insertSeq: ++this.insertSeq,
          };
          this.artifacts.set(stored.id, stored);
        } catch (error) {
          warnings.push(
            `skipped artifact restore: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return warnings;
    });
  }

  private cloneState(): {
    artifacts: Map<string, StoredArtifact>;
    insertSeq: number;
    persistenceSeq: number;
    durableEventsSinceSnapshot: number;
    tombstonedIds: Set<string>;
    stickyEphemeralIds: Set<string>;
  } {
    return {
      artifacts: new Map(
        Array.from(this.artifacts.entries()).map(([id, artifact]) => [
          id,
          cloneStoredArtifact(artifact),
        ]),
      ),
      insertSeq: this.insertSeq,
      persistenceSeq: this.persistenceSeq,
      durableEventsSinceSnapshot: this.durableEventsSinceSnapshot,
      tombstonedIds: new Set(this.tombstonedIds),
      stickyEphemeralIds: new Set(this.stickyEphemeralIds),
    };
  }

  private restoreState(state: {
    artifacts: Map<string, StoredArtifact>;
    insertSeq: number;
    persistenceSeq: number;
    durableEventsSinceSnapshot: number;
    tombstonedIds: Set<string>;
    stickyEphemeralIds: Set<string>;
  }): void {
    this.artifacts.clear();
    for (const [id, artifact] of state.artifacts) {
      this.artifacts.set(id, cloneStoredArtifact(artifact));
    }
    this.insertSeq = state.insertSeq;
    this.persistenceSeq = state.persistenceSeq;
    this.durableEventsSinceSnapshot = state.durableEventsSinceSnapshot;
    this.tombstonedIds.clear();
    for (const id of state.tombstonedIds) {
      this.tombstonedIds.add(id);
    }
    this.stickyEphemeralIds.clear();
    for (const id of state.stickyEphemeralIds) {
      this.stickyEphemeralIds.add(id);
    }
  }

  private async persistChanges(
    changes: SessionArtifactChange[],
    strict = false,
  ): Promise<string[]> {
    const durableChanges = changes.filter(isDurablePersistenceChange);
    if (durableChanges.length === 0) {
      return [];
    }
    if (!this.persistence) {
      if (strict) {
        throw new SessionArtifactValidationError(
          'artifact persistence is unavailable',
          'retention',
        );
      }
      return this.downgradeDurableChanges(durableChanges);
    }

    const recordedAt = new Date().toISOString();
    for (const change of durableChanges) {
      if (change.action === 'removed') continue;
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      stored.persistedAt = recordedAt;
      if (
        stored.contentRef ||
        stored.persistenceWarning !== 'metadata_only_restore'
      ) {
        delete stored.persistenceWarning;
      }
      change.artifact = toPublicArtifact(stored);
    }

    const payload: SessionArtifactEventRecordPayload = {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence: ++this.persistenceSeq,
      recordedAt,
      changes: durableChanges.map((change) =>
        toPersistedChange(change, recordedAt),
      ),
    };

    try {
      await this.persistence.recordEvent(payload);
      this.applyDurableMarkers(durableChanges);
      await this.maybeRecordSnapshot(recordedAt);
      return [];
    } catch (error) {
      if (strict) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=persist_failed reason=${JSON.stringify(
          reason,
        )}`,
      );
      return this.downgradeDurableChanges(durableChanges);
    }
  }

  private async maybeRecordSnapshot(recordedAt: string): Promise<void> {
    if (!this.persistence) return;
    this.durableEventsSinceSnapshot++;
    if (this.durableEventsSinceSnapshot < SNAPSHOT_AFTER_DURABLE_EVENTS) {
      return;
    }
    const artifacts = Array.from(this.artifacts.values())
      .filter((artifact) => artifact.retention !== 'ephemeral')
      .sort((a, b) => a.insertSeq - b.insertSeq)
      .map((artifact) =>
        toPersistedArtifact(toPublicArtifact(artifact), recordedAt),
      );
    const payload: SessionArtifactSnapshotRecordPayload = {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence: ++this.persistenceSeq,
      recordedAt,
      artifacts,
      tombstonedIds: Array.from(this.tombstonedIds),
      stickyEphemeralIds: Array.from(this.stickyEphemeralIds),
    };
    try {
      await this.persistence.recordSnapshot(payload);
      this.durableEventsSinceSnapshot = 0;
    } catch (error) {
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=snapshot_failed reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  private downgradeDurableChanges(changes: SessionArtifactChange[]): string[] {
    for (const change of changes) {
      if (change.action === 'removed') continue;
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      stored.retention = 'ephemeral';
      stored.persistenceWarning = 'persistence_unavailable';
      delete stored.persistedAt;
      delete stored.contentRef;
      change.artifact = toPublicArtifact(stored);
    }
    return [
      'artifact persistence unavailable; durable artifacts kept ephemeral',
    ];
  }

  private applyDurableMarkers(changes: readonly SessionArtifactChange[]): void {
    for (const change of changes) {
      if (change.action === 'removed') {
        if (change.reason === 'explicit') {
          this.tombstonedIds.add(change.artifactId);
          this.stickyEphemeralIds.delete(change.artifactId);
        } else if (change.reason === 'unpin_to_ephemeral') {
          this.stickyEphemeralIds.add(change.artifactId);
        }
        continue;
      }
      if (change.artifact && change.artifact.retention !== 'ephemeral') {
        this.tombstonedIds.delete(change.artifactId);
        this.stickyEphemeralIds.delete(change.artifactId);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async normalizeInput(
    input: SessionArtifactInput,
    receivedSeq: number,
    trustedPublisherFromCaller: boolean,
  ): Promise<NormalizedArtifact> {
    if (!input || typeof input !== 'object') {
      throw new SessionArtifactValidationError('Artifact must be an object');
    }
    const title = normalizeString(input.title, 'title', 200, true);
    const description = normalizeString(
      input.description,
      'description',
      1000,
      false,
    );
    const source = input.source ?? 'tool';
    if (source !== 'tool' && source !== 'hook' && source !== 'client') {
      throw new SessionArtifactValidationError(
        'source must be tool, hook, or client',
        'source',
      );
    }

    const trustedPublisher = trustedPublisherFromCaller;
    const workspacePath = input.workspacePath
      ? normalizeWorkspacePath(input.workspacePath, this.workspaceCwd)
      : undefined;
    const managedId = normalizeManagedId(input.managedId);
    const rawStorage = input.storage;
    const storage = inferStorage(rawStorage, {
      workspacePath,
      managedId,
      url: input.url,
      trustedPublisher,
    });
    const url = input.url
      ? normalizeArtifactUrl(input.url, trustedPublisher)
      : undefined;

    validateLocator(storage, {
      workspacePath,
      managedId,
      url,
      trustedPublisher,
    });

    const metadata = normalizeMetadata(input.metadata);
    const retention = normalizeRetention(input.retention, {
      persistenceAvailable: this.persistence !== undefined,
      strictPinnedAllowed: false,
    });
    const workspaceStatus = workspacePath
      ? await this.getInitialWorkspaceStatus(workspacePath)
      : undefined;
    if (workspaceStatus?.escaped) {
      throw new SessionArtifactValidationError(
        'workspacePath must stay inside the workspace',
        'workspacePath',
      );
    }
    const kind = normalizeKind(
      input.kind ?? inferKind({ storage, workspacePath, url }),
    );
    const now = new Date().toISOString();
    const identityKey = buildIdentityKey({
      storage,
      workspacePath,
      managedId,
      url,
    });
    const id = stableSessionArtifactId(this.sessionId, identityKey);

    return {
      id,
      identityKey,
      receivedSeq,
      retentionSource: source,
      trustedPublisher,
      kind,
      storage,
      source,
      status: workspaceStatus?.status ?? 'available',
      ...(workspacePath ? { lastStatAt: Date.now() } : {}),
      title,
      description,
      workspacePath,
      managedId,
      url,
      mimeType: normalizeString(input.mimeType, 'mimeType', 120, false),
      sizeBytes:
        input.sizeBytes !== undefined
          ? normalizeSizeBytes(input.sizeBytes)
          : workspaceStatus?.sizeBytes,
      metadata,
      retention,
      restoreState: 'live',
      ...(this.persistence === undefined && retention !== 'ephemeral'
        ? { persistenceWarning: 'persistence_unavailable' as const }
        : {}),
      clientRetained:
        input.clientRetained !== undefined
          ? input.clientRetained === true
          : source === 'client',
      createdAt: now,
      updatedAt: now,
      toolCallId: normalizeString(input.toolCallId, 'toolCallId', 200, false),
      toolName: normalizeString(input.toolName, 'toolName', 200, false),
      hookEventName: normalizeString(
        input.hookEventName,
        'hookEventName',
        200,
        false,
      ),
      clientId: normalizeString(input.clientId, 'clientId', 200, false),
    };
  }

  private async refreshWorkspaceStatuses(): Promise<void> {
    const now = Date.now();
    const staleWorkspaceArtifacts = Array.from(this.artifacts.values())
      .filter((artifact) => artifact.workspacePath)
      .filter((artifact) => shouldRefreshWorkspaceStatus(artifact, now));

    await runInBatches(
      staleWorkspaceArtifacts,
      WORKSPACE_STATUS_REFRESH_BATCH_SIZE,
      (artifact) =>
        this.refreshWorkspaceStatus(artifact, {
          onError: 'missing',
          now,
        }),
    );
  }

  private async getInitialWorkspaceStatus(workspacePath: string): Promise<{
    status: DaemonSessionArtifactStatus;
    sizeBytes?: number;
    escaped?: boolean;
  }> {
    try {
      return await getWorkspaceStatus(
        this.workspaceCwd,
        workspacePath,
        this.getRealWorkspaceCwd(),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        'workspacePath',
      );
    }
  }

  private async refreshWorkspaceStatus(
    artifact: StoredArtifact,
    options: { onError: 'missing' | 'preserve'; now?: number },
  ): Promise<void> {
    if (!artifact.workspacePath) {
      return;
    }
    try {
      const status = await getWorkspaceStatus(
        this.workspaceCwd,
        artifact.workspacePath,
        this.getRealWorkspaceCwd(),
      );
      artifact.status = status.status;
      artifact.sizeBytes = status.sizeBytes;
      if (status.escaped) {
        artifact.status = 'missing';
        artifact.sizeBytes = undefined;
        delete artifact.workspacePath;
      }
      artifact.lastStatAt = options.now ?? Date.now();
    } catch (error) {
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=status_refresh_failed artifactId=${artifact.id} reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
      if (options.onError === 'missing') {
        artifact.status = 'missing';
        artifact.sizeBytes = undefined;
        artifact.lastStatAt = options.now ?? Date.now();
      }
      return;
    }
  }

  private getRealWorkspaceCwd(): Promise<string> {
    if (!this.realWorkspaceCwdPromise) {
      const promise = fs.realpath(this.workspaceCwd).catch((error: unknown) => {
        if (this.realWorkspaceCwdPromise === promise) {
          this.realWorkspaceCwdPromise = undefined;
        }
        throw error;
      });
      this.realWorkspaceCwdPromise = promise;
    }
    return this.realWorkspaceCwdPromise;
  }

  private async evictOverflow(
    createdIds: Set<string>,
    changes: SessionArtifactChange[],
  ): Promise<SessionArtifactChange[]> {
    const removed: SessionArtifactChange[] = [];
    if (this.artifacts.size <= this.maxArtifacts) {
      return removed;
    }

    const createdInThisBatch = new Set(createdIds);
    const candidates = Array.from(this.artifacts.values()).filter(
      (artifact) => !createdInThisBatch.has(artifact.id),
    );
    const now = Date.now();
    const staleWorkspaceCandidates = candidates
      .filter((artifact) => artifact.workspacePath)
      .filter((artifact) => shouldRefreshWorkspaceStatus(artifact, now));
    await runInBatches(
      staleWorkspaceCandidates,
      WORKSPACE_STATUS_REFRESH_BATCH_SIZE,
      (artifact) =>
        this.refreshWorkspaceStatus(artifact, { onError: 'preserve', now }),
    );
    const sourceCounts = countByRetentionSource(this.artifacts.values());

    while (this.artifacts.size > this.maxArtifacts) {
      const artifact = selectEvictionCandidate(candidates, sourceCounts);
      if (!artifact) break;
      this.artifacts.delete(artifact.id);
      candidates.splice(candidates.indexOf(artifact), 1);
      sourceCounts[artifact.retentionSource]--;
      removePriorChange(changes, artifact.id);
      removed.push({
        action: 'removed',
        artifactId: artifact.id,
        artifact: toPublicArtifact(artifact),
        reason: 'eviction',
      });
    }

    const overflowCreated = Array.from(this.artifacts.values())
      .filter((artifact) => createdInThisBatch.has(artifact.id))
      .sort((a, b) => b.receivedSeq - a.receivedSeq);
    for (const artifact of overflowCreated) {
      if (this.artifacts.size <= this.maxArtifacts) {
        break;
      }
      this.artifacts.delete(artifact.id);
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=dropped reason="max artifacts exceeded" artifactId=${artifact.id}`,
      );
      removePriorChange(changes, artifact.id);
    }

    return removed;
  }
}

function coalesceByIdentity(
  artifacts: NormalizedArtifact[],
): NormalizedArtifact[] {
  const byId = new Map<string, NormalizedArtifact>();
  for (const artifact of artifacts) {
    const existing = byId.get(artifact.id);
    if (!existing) {
      byId.set(artifact.id, artifact);
      continue;
    }
    byId.set(artifact.id, mergeBatchArtifact(existing, artifact));
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.receivedSeq - b.receivedSeq,
  );
}

function mergeBatchArtifact(
  existing: NormalizedArtifact,
  next: NormalizedArtifact,
): NormalizedArtifact {
  const publishedUpgrade =
    existing.storage !== 'published' &&
    next.storage === 'published' &&
    next.trustedPublisher;
  if (publishedUpgrade) {
    const merged: NormalizedArtifact = {
      ...existing,
      id: next.id,
      identityKey: next.identityKey,
      kind: next.kind,
      storage: 'published',
      status: next.status,
      title: next.title,
      description: next.description,
      managedId: next.managedId ?? existing.managedId,
      url: next.url ?? existing.url,
      mimeType: next.mimeType ?? existing.mimeType,
      sizeBytes: next.sizeBytes ?? existing.sizeBytes,
      metadata: mergeMetadata(existing, next),
      trustedPublisher: true,
      createdAt: existing.createdAt,
      receivedSeq: existing.receivedSeq,
      retentionSource: existing.retentionSource,
      retention: strongestRetention(existing.retention, next.retention),
      restoreState: 'live',
      persistenceWarning:
        existing.persistenceWarning ?? next.persistenceWarning,
      contentRef: existing.contentRef ?? next.contentRef,
      persistedAt: existing.persistedAt ?? next.persistedAt,
      expiresAt: existing.expiresAt ?? next.expiresAt,
      clientRetained: existing.clientRetained || next.clientRetained,
      lastStatAt: undefined,
    };
    delete merged.workspacePath;
    return merged;
  }
  return {
    ...existing,
    status: next.status,
    sizeBytes: mergeSizeBytes(existing, next),
    metadata: mergeMetadata(existing, next),
    clientRetained: existing.clientRetained || next.clientRetained,
    trustedPublisher: existing.trustedPublisher || next.trustedPublisher,
    lastStatAt: next.lastStatAt ?? existing.lastStatAt,
  };
}

function mergeArtifact(
  existing: StoredArtifact,
  incoming: NormalizedArtifact,
): { artifact: StoredArtifact; changed: boolean } {
  const now = new Date().toISOString();
  const publishedUpgrade =
    existing.storage !== 'published' &&
    incoming.storage === 'published' &&
    incoming.trustedPublisher;
  const publishedRefresh =
    existing.storage === 'published' &&
    incoming.storage === 'published' &&
    incoming.trustedPublisher &&
    incoming.managedId !== undefined &&
    incoming.managedId === existing.managedId;
  const publishedUpdate = publishedUpgrade || publishedRefresh;
  const next: StoredArtifact = {
    ...existing,
    id: publishedUpdate ? incoming.id : existing.id,
    identityKey: publishedUpdate ? incoming.identityKey : existing.identityKey,
    kind: publishedUpdate ? incoming.kind : existing.kind,
    storage: publishedUpgrade ? 'published' : existing.storage,
    status:
      existing.storage === 'published' && !publishedUpdate
        ? existing.status
        : incoming.status,
    managedId: publishedUpdate
      ? (incoming.managedId ?? existing.managedId)
      : existing.managedId,
    url: publishedUpdate ? (incoming.url ?? existing.url) : existing.url,
    workspacePath:
      publishedUpdate || existing.storage === 'published'
        ? undefined
        : (existing.workspacePath ?? incoming.workspacePath),
    mimeType: publishedUpdate
      ? (incoming.mimeType ?? existing.mimeType)
      : existing.mimeType,
    sizeBytes:
      existing.storage === 'published' && !publishedUpdate
        ? existing.sizeBytes
        : mergeSizeBytes(existing, incoming),
    metadata:
      existing.storage === 'published' && !publishedUpdate
        ? existing.metadata
        : mergeMetadata(existing, incoming),
    retention: strongestRetention(existing.retention, incoming.retention),
    restoreState: 'live',
    persistenceWarning:
      existing.persistenceWarning ?? incoming.persistenceWarning,
    contentRef: existing.contentRef ?? incoming.contentRef,
    persistedAt: existing.persistedAt ?? incoming.persistedAt,
    expiresAt: existing.expiresAt ?? incoming.expiresAt,
    source: existing.source,
    retentionSource: existing.retentionSource,
    trustedPublisher: existing.trustedPublisher || incoming.trustedPublisher,
    clientRetained: existing.clientRetained || incoming.clientRetained,
    lastStatAt:
      publishedUpdate || existing.storage === 'published'
        ? undefined
        : (incoming.lastStatAt ?? existing.lastStatAt),
    updatedAt: existing.updatedAt,
  };

  if (publishedUpdate) {
    next.title = incoming.title;
    next.description = incoming.description;
    delete next.workspacePath;
  }

  const changed = !publicArtifactsEqual(
    toPublicArtifact(existing),
    toPublicArtifact(next),
  );
  if (changed) {
    next.updatedAt = now;
  }
  return { artifact: changed ? next : existing, changed };
}

function publicArtifactsEqual(
  a: DaemonSessionArtifact,
  b: DaemonSessionArtifact,
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.storage === b.storage &&
    a.source === b.source &&
    a.status === b.status &&
    a.title === b.title &&
    a.description === b.description &&
    a.workspacePath === b.workspacePath &&
    a.managedId === b.managedId &&
    a.url === b.url &&
    a.mimeType === b.mimeType &&
    a.sizeBytes === b.sizeBytes &&
    metadataEqual(a.metadata, b.metadata) &&
    a.retention === b.retention &&
    a.restoreState === b.restoreState &&
    a.persistenceWarning === b.persistenceWarning &&
    contentRefEqual(a.contentRef, b.contentRef) &&
    a.persistedAt === b.persistedAt &&
    a.expiresAt === b.expiresAt &&
    a.clientRetained === b.clientRetained &&
    a.createdAt === b.createdAt &&
    a.toolCallId === b.toolCallId &&
    a.toolName === b.toolName &&
    a.hookEventName === b.hookEventName &&
    a.clientId === b.clientId
  );
}

function contentRefEqual(
  a: SessionArtifactContentRef | undefined,
  b: SessionArtifactContentRef | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.contentId === b.contentId &&
    a.sha256 === b.sha256 &&
    a.sizeBytes === b.sizeBytes &&
    a.createdAt === b.createdAt
  );
}

function metadataEqual(
  a: Record<string, string | number | boolean | null> | undefined,
  b: Record<string, string | number | boolean | null> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function mergeSizeBytes(
  existing: DaemonSessionArtifact,
  incoming: DaemonSessionArtifact,
): number | undefined {
  if (incoming.sizeBytes !== undefined) {
    return incoming.sizeBytes;
  }
  if (incoming.workspacePath && incoming.status === 'missing') {
    return undefined;
  }
  return existing.sizeBytes;
}

function strongestRetention(
  a: SessionArtifactRetention,
  b: SessionArtifactRetention,
): SessionArtifactRetention {
  const rank: Record<SessionArtifactRetention, number> = {
    ephemeral: 0,
    restorable: 1,
    pinned: 2,
  };
  return rank[b] > rank[a] ? b : a;
}

function mergeMetadata(
  existing: DaemonSessionArtifact,
  incoming: NormalizedArtifact,
): Record<string, string | number | boolean | null> | undefined {
  if (
    !incoming.metadata ||
    incoming.source === 'hook' ||
    incoming.source !== existing.source
  ) {
    return existing.metadata;
  }
  const merged = { ...(existing.metadata ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(incoming.metadata)) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = value;
      changed = true;
    }
  }
  if (!changed) {
    return existing.metadata;
  }
  if (!isMetadataWithinLimit(merged)) {
    writeStderrLine(
      `[artifacts] action=metadata_merge_dropped artifactId=${incoming.id} reason="metadata limit exceeded"`,
    );
    return existing.metadata;
  }
  return merged;
}

function isMetadataWithinLimit(
  metadata: Record<string, string | number | boolean | null>,
): boolean {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= 4096;
}

function countByRetentionSource(
  artifacts: Iterable<StoredArtifact>,
): Record<DaemonSessionArtifactSource, number> {
  const counts: Record<DaemonSessionArtifactSource, number> = {
    tool: 0,
    client: 0,
    hook: 0,
  };
  for (const artifact of artifacts) {
    counts[artifact.retentionSource]++;
  }
  return counts;
}

function shouldRefreshWorkspaceStatus(
  artifact: StoredArtifact,
  now: number,
): boolean {
  return (
    artifact.lastStatAt === undefined ||
    now - artifact.lastStatAt >= WORKSPACE_STATUS_REFRESH_TTL_MS
  );
}

function selectEvictionCandidate(
  candidates: StoredArtifact[],
  sourceCounts: Record<DaemonSessionArtifactSource, number>,
): StoredArtifact | undefined {
  return (
    oldest(
      candidates,
      (artifact) => artifact.status === 'missing' && !artifact.clientRetained,
    ) ??
    oldest(
      candidates,
      (artifact) =>
        !artifact.clientRetained &&
        sourceCounts[artifact.retentionSource] >
          SOURCE_RESERVATIONS[artifact.retentionSource],
    ) ??
    oldest(candidates, (artifact) => !artifact.clientRetained) ??
    oldest(candidates, (artifact) => artifact.retention !== 'pinned')
  );
}

function oldest(
  artifacts: StoredArtifact[],
  predicate: (artifact: StoredArtifact) => boolean = () => true,
): StoredArtifact | undefined {
  let selected: StoredArtifact | undefined;
  for (const artifact of artifacts) {
    if (!predicate(artifact)) {
      continue;
    }
    if (!selected || compareOldest(artifact, selected) < 0) {
      selected = artifact;
    }
  }
  return selected;
}

function compareOldest(a: StoredArtifact, b: StoredArtifact): number {
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.insertSeq - b.insertSeq;
}

function removePriorChange(
  changes: SessionArtifactChange[],
  artifactId: string,
): void {
  const index = changes.findIndex((change) => change.artifactId === artifactId);
  if (index >= 0) {
    changes.splice(index, 1);
  }
}

function toPublicArtifact(
  artifact: StoredArtifact | DaemonSessionArtifact,
): DaemonSessionArtifact {
  const {
    id,
    kind,
    storage,
    source,
    status,
    title,
    description,
    workspacePath,
    managedId,
    url,
    mimeType,
    sizeBytes,
    metadata,
    retention,
    restoreState,
    persistenceWarning,
    contentRef,
    persistedAt,
    expiresAt,
    clientRetained,
    createdAt,
    updatedAt,
    toolCallId,
    toolName,
    hookEventName,
    clientId,
  } = artifact;
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...(description ? { description } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(managedId ? { managedId } : {}),
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(metadata ? { metadata } : {}),
    retention,
    ...(restoreState ? { restoreState } : {}),
    ...(persistenceWarning ? { persistenceWarning } : {}),
    ...(contentRef ? { contentRef } : {}),
    ...(persistedAt ? { persistedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    clientRetained,
    createdAt,
    updatedAt,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(hookEventName ? { hookEventName } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

function persistedArtifactToInput(
  artifact: PersistedSessionArtifact,
): SessionArtifactInput {
  return {
    title: artifact.title,
    kind: artifact.kind,
    storage: artifact.storage,
    description: artifact.description,
    workspacePath: artifact.workspacePath,
    managedId: artifact.managedId,
    url: artifact.url,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    metadata: artifact.metadata,
    source: artifact.source,
    retention: artifact.retention,
    clientRetained: artifact.clientRetained,
    toolCallId: artifact.toolCallId,
    toolName: artifact.toolName,
    hookEventName: artifact.hookEventName,
    clientId: artifact.clientId,
  };
}

function toPersistedChange(
  change: SessionArtifactChange,
  recordedAt: string,
): SessionArtifactEventRecordPayload['changes'][number] {
  return {
    action: change.action,
    artifactId: change.artifactId,
    ...(change.artifact
      ? { artifact: toPersistedArtifact(change.artifact, recordedAt) }
      : {}),
    ...(change.reason ? { reason: change.reason } : {}),
  };
}

function toPersistedArtifact(
  artifact: DaemonSessionArtifact,
  recordedAt: string,
): PersistedSessionArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    storage: artifact.storage,
    source: artifact.source,
    status: artifact.status,
    title: artifact.title,
    ...(artifact.description ? { description: artifact.description } : {}),
    ...(artifact.workspacePath
      ? { workspacePath: artifact.workspacePath }
      : {}),
    ...(artifact.managedId ? { managedId: artifact.managedId } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    ...(artifact.sizeBytes !== undefined
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
    retention: artifact.retention,
    clientRetained: artifact.clientRetained,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    persistedAt: artifact.persistedAt ?? recordedAt,
    ...(artifact.expiresAt ? { expiresAt: artifact.expiresAt } : {}),
    ...(artifact.restoreState ? { restoreState: artifact.restoreState } : {}),
    ...(artifact.persistenceWarning
      ? { persistenceWarning: artifact.persistenceWarning }
      : {}),
    ...(artifact.contentRef ? { contentRef: artifact.contentRef } : {}),
    ...(artifact.toolCallId ? { toolCallId: artifact.toolCallId } : {}),
    ...(artifact.toolName ? { toolName: artifact.toolName } : {}),
    ...(artifact.hookEventName
      ? { hookEventName: artifact.hookEventName }
      : {}),
    ...(artifact.clientId ? { clientId: artifact.clientId } : {}),
  };
}

function isDurablePersistenceChange(change: SessionArtifactChange): boolean {
  if (change.reason === 'eviction') return false;
  if (!change.artifact) return false;
  return change.artifact.retention !== 'ephemeral';
}

function cloneStoredArtifact(artifact: StoredArtifact): StoredArtifact {
  return {
    ...artifact,
    ...(artifact.metadata ? { metadata: { ...artifact.metadata } } : {}),
    ...(artifact.contentRef ? { contentRef: { ...artifact.contentRef } } : {}),
  };
}

function inferStorage(
  requested: unknown,
  locators: {
    workspacePath?: string;
    managedId?: string;
    url?: string;
    trustedPublisher: boolean;
  },
): DaemonSessionArtifactStorage {
  if (requested !== undefined && typeof requested !== 'string') {
    throw new SessionArtifactValidationError(
      'storage must be a string',
      'storage',
    );
  }
  if (requested) {
    if (
      requested !== 'workspace' &&
      requested !== 'external_url' &&
      requested !== 'managed' &&
      requested !== 'published'
    ) {
      throw new SessionArtifactValidationError(
        'storage must be workspace, external_url, managed, or published',
        'storage',
      );
    }
    return requested as DaemonSessionArtifactStorage;
  }
  if (locators.workspacePath) return 'workspace';
  if (locators.managedId) return 'managed';
  if (locators.url && locators.trustedPublisher) return 'published';
  return 'external_url';
}

function normalizeKind(kind: unknown): DaemonSessionArtifactKind {
  if (
    kind === 'file' ||
    kind === 'link' ||
    kind === 'html' ||
    kind === 'image' ||
    kind === 'video' ||
    kind === 'audio' ||
    kind === 'pdf' ||
    kind === 'notebook' ||
    kind === 'other'
  ) {
    return kind;
  }
  throw new SessionArtifactValidationError(
    'kind must be a supported artifact kind',
    'kind',
  );
}

function validateLocator(
  storage: DaemonSessionArtifactStorage,
  locators: {
    workspacePath?: string;
    managedId?: string;
    url?: string;
    trustedPublisher: boolean;
  },
): void {
  if (storage === 'published') {
    if (!locators.trustedPublisher) {
      throw new SessionArtifactValidationError(
        'published artifacts are reserved for trusted publishers',
        'storage',
      );
    }
    if (!locators.url) {
      throw new SessionArtifactValidationError(
        'published artifacts require url',
        'url',
      );
    }
    if (locators.workspacePath) {
      throw new SessionArtifactValidationError(
        'published artifacts cannot include workspacePath',
        'workspacePath',
      );
    }
    return;
  }

  const locatorCount = [
    locators.workspacePath,
    locators.managedId,
    locators.url,
  ].filter(Boolean).length;
  if (locatorCount !== 1) {
    throw new SessionArtifactValidationError(
      'provide exactly one of workspacePath, managedId, or url',
    );
  }
  if (storage === 'workspace' && !locators.workspacePath) {
    throw new SessionArtifactValidationError(
      'workspace storage requires workspacePath',
      'workspacePath',
    );
  }
  if (storage === 'managed' && !locators.managedId) {
    throw new SessionArtifactValidationError(
      'managed storage requires managedId',
      'managedId',
    );
  }
  if (storage === 'external_url' && !locators.url) {
    throw new SessionArtifactValidationError(
      'external_url storage requires url',
      'url',
    );
  }
}

function buildIdentityKey(input: {
  storage: DaemonSessionArtifactStorage;
  workspacePath?: string;
  managedId?: string;
  url?: string;
}): string {
  if (input.workspacePath) return `workspace:${input.workspacePath}`;
  if (input.managedId) return `managed:${input.managedId}`;
  if (input.url) return `url:${input.url}`;
  throw new SessionArtifactValidationError(
    'artifact identity requires workspacePath, managedId, or url',
  );
}

function managedIdForWorkspacePath(
  workspaceCwd: string,
  workspacePath: string,
): string {
  return createHash('sha1')
    .update(path.resolve(workspaceCwd, workspacePath))
    .digest('hex')
    .slice(0, 16);
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
  required: true,
): string;
function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
  required: false,
): string | undefined;
function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw new SessionArtifactValidationError(`${field} is required`, field);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SessionArtifactValidationError(
      `${field} must be a string`,
      field,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      throw new SessionArtifactValidationError(`${field} is required`, field);
    }
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new SessionArtifactValidationError(
      `${field} exceeds ${maxLength} characters`,
      field,
    );
  }
  if (hasControlCharacter(trimmed, field === 'description')) {
    throw new SessionArtifactValidationError(
      `${field} contains control characters`,
      field,
    );
  }
  if (isDisplayField(field) && hasUnsafeDisplayPayload(trimmed)) {
    throw new SessionArtifactValidationError(
      `${field} contains unsafe markup`,
      field,
    );
  }
  return trimmed;
}

function normalizeManagedId(value: unknown): string | undefined {
  const managedId = normalizeString(value, 'managedId', 200, false);
  if (!managedId) return undefined;
  if (
    managedId.includes('/') ||
    managedId.includes('\\') ||
    managedId.includes('..') ||
    path.isAbsolute(managedId) ||
    path.win32.isAbsolute(managedId)
  ) {
    throw new SessionArtifactValidationError(
      'managedId must be an opaque managed resource id',
      'managedId',
    );
  }
  return managedId;
}

function isDisplayField(field: string): boolean {
  return (
    field === 'title' ||
    field === 'description' ||
    field === 'mimeType' ||
    field === 'workspacePath' ||
    field === 'managedId'
  );
}

function hasControlCharacter(
  value: string,
  allowLineWhitespace = false,
): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      allowLineWhitespace &&
      (code === 0x09 || code === 0x0a || code === 0x0d)
    ) {
      continue;
    }
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeDisplayPayload(value: string): boolean {
  return (
    /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
      value,
    ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value)
  );
}

function normalizeWorkspacePath(raw: unknown, workspaceCwd: string): string {
  const trimmed = normalizeString(raw, 'workspacePath', 500, true);
  if (path.isAbsolute(trimmed)) {
    throw new SessionArtifactValidationError(
      'workspacePath must be relative to the workspace',
      'workspacePath',
    );
  }
  const absolute = path.resolve(workspaceCwd, trimmed);
  const relative = path.relative(workspaceCwd, absolute);
  if (!relative || isOutsidePath(relative)) {
    throw new SessionArtifactValidationError(
      'workspacePath must stay inside the workspace',
      'workspacePath',
    );
  }
  return relative.split(path.sep).join('/');
}

function normalizeArtifactUrl(raw: unknown, allowFile: boolean): string {
  const trimmed = normalizeString(raw, 'url', 2048, true);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SessionArtifactValidationError('url must be valid', 'url');
  }
  if (parsed.username || parsed.password) {
    throw new SessionArtifactValidationError(
      'url must not include credentials',
      'url',
    );
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    !(allowFile && parsed.protocol === 'file:')
  ) {
    throw new SessionArtifactValidationError(
      allowFile
        ? 'url must use http, https, or file'
        : 'url must use http or https',
      'url',
    );
  }
  return parsed.href;
}

function normalizeMetadata(
  metadata: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new SessionArtifactValidationError(
      'metadata must be an object',
      'metadata',
    );
  }
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key) {
      throw new SessionArtifactValidationError(
        'metadata keys must not be empty',
        'metadata',
      );
    }
    if (key.length > 120) {
      throw new SessionArtifactValidationError(
        'metadata keys must be 120 characters or fewer',
        'metadata',
      );
    }
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) {
      throw new SessionArtifactValidationError(
        'metadata keys contain unsafe content',
        'metadata',
      );
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new SessionArtifactValidationError(
        'metadata values must be primitive',
        'metadata',
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new SessionArtifactValidationError(
        'metadata numbers must be finite',
        'metadata',
      );
    }
    if (
      typeof value === 'string' &&
      (hasControlCharacter(value) || hasUnsafeDisplayPayload(value))
    ) {
      throw new SessionArtifactValidationError(
        'metadata string values contain unsafe content',
        'metadata',
      );
    }
    normalized[key] = value;
  }
  if (Object.keys(normalized).length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 4096) {
    throw new SessionArtifactValidationError(
      'metadata must be 4096 bytes or fewer',
      'metadata',
    );
  }
  return normalized;
}

function normalizeRetention(
  value: unknown,
  options: { persistenceAvailable: boolean; strictPinnedAllowed: boolean },
): SessionArtifactRetention {
  if (value === undefined) {
    return options.persistenceAvailable ? 'restorable' : 'ephemeral';
  }
  if (value === 'ephemeral' || value === 'restorable') {
    return value;
  }
  if (value === 'pinned' && options.strictPinnedAllowed) {
    return 'pinned';
  }
  if (value === 'pinned') {
    throw new SessionArtifactValidationError(
      'pinned retention requires the pin API',
      'retention',
    );
  }
  throw new SessionArtifactValidationError(
    'retention must be ephemeral, restorable, or pinned',
    'retention',
  );
}

function normalizeSizeBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionArtifactValidationError(
      'sizeBytes must be a non-negative safe integer',
      'sizeBytes',
    );
  }
  return value;
}

function inferKind(input: {
  storage: DaemonSessionArtifactStorage;
  workspacePath?: string;
  url?: string;
}): DaemonSessionArtifactKind {
  if (input.storage === 'published') return 'html';
  if (input.url) return 'link';
  const ext = input.workspacePath
    ? path.extname(input.workspacePath).toLowerCase()
    : '';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.ogg'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.ipynb') return 'notebook';
  return input.workspacePath ? 'file' : 'other';
}

async function getWorkspaceStatus(
  workspaceCwd: string,
  workspacePath: string,
  realWorkspaceCwd: Promise<string>,
): Promise<{
  status: DaemonSessionArtifactStatus;
  sizeBytes?: number;
  escaped?: boolean;
}> {
  const absolutePath = path.resolve(workspaceCwd, workspacePath);
  const realWorkspace = await realWorkspaceCwd;
  try {
    const realPath = await fs.realpath(absolutePath);
    const relative = path.relative(realWorkspace, realPath);
    if (!relative || isOutsidePath(relative)) {
      return { status: 'missing', escaped: true };
    }
    const stat = await fs.stat(realPath);
    return {
      status: 'available',
      ...(stat.isFile() ? { sizeBytes: stat.size } : {}),
    };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    if (await danglingSymlinkEscapesWorkspace(absolutePath, realWorkspace)) {
      return { status: 'missing', escaped: true };
    }
    return { status: 'missing' };
  }
}

async function danglingSymlinkEscapesWorkspace(
  absolutePath: string,
  realWorkspace: string,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = await fs.readlink(absolutePath);
    const parent = await fs.realpath(path.dirname(absolutePath));
    const targetPath = path.resolve(parent, target);
    return isOutsidePath(path.relative(realWorkspace, targetPath));
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.all(items.slice(index, index + batchSize).map(fn));
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isOutsidePath(relative: string): boolean {
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
