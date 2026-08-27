/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs, type BigIntStats, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  collectRecordableWorkspaceFiles,
  isOfficeDocumentExtension,
  isPrototypeMetadataKey,
  isRecordableDerivedChild,
  isReservedWorkspaceMetadataKey,
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  MAX_DIRECTORY_ARTIFACT_FILES,
  metadataBudgetBytes,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  pathHasSkippedDirectoryComponent,
  stableSessionArtifactId,
  WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY,
  WORKSPACE_CONTENT_SHA256_METADATA_KEY,
} from '@qwen-code/qwen-code-core';
import type {
  PersistedSessionArtifact,
  RebuiltSessionArtifactSnapshot,
  SessionArtifactEventRecordPayload,
  SessionArtifactPersistenceWarning,
  SessionArtifactRestoreState,
  SessionArtifactRetention,
  SessionArtifactSnapshotRecordPayload,
} from '@qwen-code/qwen-code-core';
import {
  isUnverifiableIdentityError,
  openNoFollow,
} from '@qwen-code/qwen-code-core/noFollowOpen';
import { writeStderrLine } from './internal/stderrLine.js';

export type DaemonSessionArtifactKind =
  | 'file'
  | 'link'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'notebook'
  | 'document'
  | 'other';

export type DaemonSessionArtifactStorage =
  | 'workspace'
  | 'external_url'
  | 'managed'
  | 'published';

export type DaemonSessionArtifactSource = 'tool' | 'hook' | 'client';

export type DaemonSessionArtifactStatus = 'available' | 'missing' | 'changed';
export type DaemonSessionArtifactRetention = Exclude<
  SessionArtifactRetention,
  'pinned'
>;

const SOURCE_RESERVATIONS: Record<DaemonSessionArtifactSource, number> = {
  tool: 100,
  client: 50,
  hook: 50,
};
const WORKSPACE_STATUS_REFRESH_TTL_MS = 5_000;
const WORKSPACE_STATUS_REFRESH_BATCH_SIZE = 20;
const SNAPSHOT_AFTER_DURABLE_EVENTS = 50;
const MAX_SNAPSHOT_BACKOFF_MULTIPLIER = 4;
const MAX_TOMBSTONED_IDS = 500;
const MAX_STICKY_EPHEMERAL_IDS = 500;
const MAX_WORKSPACE_HASH_BYTES = 100 * 1024 * 1024;
const SECRET_TOKEN_VALUE_PATTERN =
  /(?:^|\s)(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,}|[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})(?:$|\s)/i;
const RESTORE_FAILED_WARNING_PREFIX = 'artifact snapshot restore failed';
const RESTORE_PARTIAL_FAILED_WARNING_PREFIX =
  'artifact snapshot restore partially failed';

export function isArtifactRestoreFailureWarning(warning: string): boolean {
  return (
    warning.startsWith(RESTORE_FAILED_WARNING_PREFIX) ||
    warning.startsWith(RESTORE_PARTIAL_FAILED_WARNING_PREFIX)
  );
}

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
  retention?: DaemonSessionArtifactRetention;
  clientRetained?: boolean;
  toolCallId?: string;
  toolName?: string;
  hookEventName?: string;
  clientId?: string;
}

type RestoreSessionArtifactInput = Omit<SessionArtifactInput, 'retention'> & {
  retention?: SessionArtifactRetention;
};

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
  retention: DaemonSessionArtifactRetention;
  restoreState?: SessionArtifactRestoreState;
  persistenceWarning?: SessionArtifactPersistenceWarning;
  persistedAt?: string;
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
  durableTombstoneRequired?: boolean;
}

type InternalSessionArtifactChange = SessionArtifactChange & {
  removedClientId?: string;
};

export interface SessionArtifactsEnvelope {
  v: 1;
  sessionId: string;
  artifacts: DaemonSessionArtifact[];
  generatedAt: string;
  limits: {
    maxArtifacts: number;
  };
  warnings?: string[];
  warningDetails?: SessionArtifactWarningDetail[];
}

export interface SessionArtifactMutationResult {
  v: 1;
  sessionId: string;
  changes: SessionArtifactChange[];
  warnings?: string[];
  warningDetails?: SessionArtifactWarningDetail[];
}

export interface SessionArtifactWarningDetail {
  code: string;
  operation: 'upsert' | 'remove' | 'restore';
  artifactIds?: string[];
  durability?: 'durable' | 'live_only' | 'unavailable';
  retryable?: boolean;
  message: string;
}

export interface SessionArtifactRestoreOptions {
  preserveLiveEphemeral?: boolean;
  workspaceAccess?: 'metadata-only';
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

export class SessionArtifactAuthorizationError extends Error {
  readonly code = 'SESSION_ARTIFACT_FORBIDDEN';

  constructor(
    readonly sessionId: string,
    readonly artifactId: string,
    readonly ownerClientId: string,
    readonly requesterClientId?: string,
  ) {
    super(`artifact ${artifactId} is owned by a different client`);
    this.name = 'SessionArtifactAuthorizationError';
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
  retentionExplicit: boolean;
  retentionSource: DaemonSessionArtifactSource;
  trustedPublisher: boolean;
  lastStatAt?: number;
}

interface StoredArtifact extends NormalizedArtifact {
  insertSeq: number;
  durableTombstoneRequired?: boolean;
  hideWorkspacePath?: boolean;
}

interface WorkspaceStatusExpected {
  sizeBytes?: number;
  mtimeMs?: string | number | boolean | null;
  sha256?: string | number | boolean | null;
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
  private consecutiveSnapshotFailures = 0;
  private realWorkspaceCwdPromise?: Promise<string>;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly tombstonedIds = new Set<string>();
  private readonly tombstonedClientIds = new Map<string, string | undefined>();
  private readonly stickyEphemeralIds = new Set<string>();
  private readonly markerArtifacts = new Map<
    string,
    PersistedSessionArtifact
  >();
  private lastRestoreWarnings: string[] = [];
  private lastRestoreWarningDetails: SessionArtifactWarningDetail[] = [];

  constructor(options: SessionArtifactStoreOptions) {
    this.sessionId = options.sessionId;
    this.workspaceCwd = options.workspaceCwd;
    this.maxArtifacts = options.maxArtifacts ?? 200;
    this.persistence = options.persistence;
  }

  inputBatchLimit(): number {
    return this.maxArtifacts * 2;
  }

  resetWorkspaceResolutionCache(): void {
    this.realWorkspaceCwdPromise = undefined;
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
        ...(this.lastRestoreWarnings.length > 0
          ? { warnings: [...this.lastRestoreWarnings] }
          : {}),
        ...(this.lastRestoreWarningDetails.length > 0
          ? { warningDetails: [...this.lastRestoreWarningDetails] }
          : {}),
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

  async upsertMany(
    inputs: SessionArtifactInput[],
    options: {
      strict?: boolean;
      validationStrict?: boolean;
      persistenceStrict?: boolean;
      trustedPublisher?: boolean;
    } = {},
  ): Promise<SessionArtifactMutationResult> {
    return this.enqueue(async () => {
      const validationStrict = options.validationStrict ?? options.strict;
      const persistenceStrict = options.persistenceStrict ?? options.strict;
      const before = this.cloneState();
      const normalizedResults: NormalizedArtifact[] = [];
      const warnings: string[] = [];
      const warningDetails: SessionArtifactWarningDetail[] = [];
      for (const input of inputs) {
        try {
          const expanded = await this.expandWorkspaceDirectoryInput(input);
          for (const item of expanded.inputs) {
            try {
              normalizedResults.push(
                await this.normalizeInput(
                  item,
                  ++this.receivedSeq,
                  options.trustedPublisher === true,
                ),
              );
            } catch (error) {
              if (validationStrict) {
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
          if (expanded.warning) {
            warnings.push(expanded.warning);
          }
        } catch (error) {
          if (validationStrict) {
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
        for (const normalized of coalesceByIdentity(normalizedResults)) {
          const artifact = this.applyStickyEphemeralOverride(normalized);
          if (this.shouldSuppressTombstonedUpsert(artifact)) {
            writeStderrLine(
              `[artifacts] session=${this.sessionId} action=tombstone_replay_suppressed artifactId=${artifact.id}`,
            );
            continue;
          }
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

          try {
            this.denyCrossClientMutation('upsert', existing.id, existing, {
              clientId: artifact.clientId,
            });
          } catch (error) {
            if (validationStrict) {
              throw error;
            }
            if (error instanceof SessionArtifactAuthorizationError) {
              warnings.push(error.message);
              continue;
            }
            throw error;
          }
          const updated = mergeArtifact(existing, artifact);
          if (updated.changed) {
            if (updated.artifact.id !== existing.id) {
              const removeChange: InternalSessionArtifactChange = {
                action: 'removed',
                artifactId: existing.id,
                artifact: toPublicArtifact(existing),
                reason: 'explicit',
                durableTombstoneRequired:
                  existing.durableTombstoneRequired ||
                  existing.persistedAt !== undefined,
                removedClientId: existing.clientId,
              };
              changes.push(removeChange);
              this.artifacts.delete(existing.id);
            } else if (shouldRecordEphemeralUnpin(existing, artifact)) {
              changes.push({
                action: 'removed',
                artifactId: existing.id,
                artifact: toPublicArtifact(existing),
                reason: 'unpin_to_ephemeral',
                durableTombstoneRequired: true,
              });
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
        const overflowRemoved = await this.evictOverflow(
          createdIds,
          changes,
          persistenceStrict,
        );
        changes.push(...overflowRemoved.removed);
        if (overflowRemoved.droppedCreated > 0) {
          warnings.push(
            `dropped ${overflowRemoved.droppedCreated} newly created artifacts because the store is full`,
          );
        }

        const hasStrictDurableTransition = changes.some(
          shouldCommitBeforeDurablePersistence,
        );
        let persistenceWarnings: string[];
        if (hasStrictDurableTransition && !persistenceStrict) {
          try {
            persistenceWarnings = await this.persistChanges(changes, true);
          } catch (error) {
            this.restoreState(before);
            const artifactIds = changes
              .filter(shouldCommitBeforeDurablePersistence)
              .map((change) => change.artifactId);
            const warning =
              'artifact durable removal not persisted; live changes rolled back';
            writeStderrLine(
              `[artifacts] session=${this.sessionId} action=upsert_rollback warning=${JSON.stringify(
                warning,
              )} artifactIds=${JSON.stringify(artifactIds)} error=${JSON.stringify(
                error instanceof Error ? error.message : String(error),
              )}`,
            );
            return {
              v: 1,
              sessionId: this.sessionId,
              changes: [],
              warnings: [warning],
              warningDetails: [
                persistenceFailureDetail({
                  message: warning,
                  operation: 'upsert',
                  artifactIds,
                  error,
                }),
              ],
            };
          }
        } else {
          persistenceWarnings = await this.persistChanges(
            changes,
            persistenceStrict,
          );
        }
        warnings.push(...persistenceWarnings);
        warningDetails.push(
          ...detailsForPersistenceWarnings(
            persistenceWarnings,
            changes,
            'upsert',
          ),
        );
        stripDurableTombstoneMarkers(changes);
      } catch (error) {
        if (
          validationStrict ||
          persistenceStrict ||
          error instanceof SessionArtifactAuthorizationError
        ) {
          this.restoreState(before);
        }
        throw error;
      }

      return {
        v: 1,
        sessionId: this.sessionId,
        changes,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(warningDetails.length > 0 ? { warningDetails } : {}),
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
      const existing = this.artifacts.get(artifactId);
      if (!existing) {
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      // Client-created artifacts with an owner require the same client id.
      // Tool/hook artifacts are session-scoped outputs and may be removed by
      // any caller that already passed session mutation auth.
      this.denyCrossClientMutation('remove', artifactId, existing, options);
      const removeChange: InternalSessionArtifactChange = {
        action: 'removed',
        artifactId,
        artifact: toPublicArtifact(existing),
        reason: 'explicit',
        durableTombstoneRequired:
          existing.durableTombstoneRequired ||
          existing.retention !== 'ephemeral'
            ? true
            : undefined,
        removedClientId: existing.clientId,
      };
      const changes: SessionArtifactChange[] = [removeChange];
      const needsDurableTombstone =
        removeChange.durableTombstoneRequired === true;
      if (needsDurableTombstone) {
        const before = this.cloneState();
        this.artifacts.delete(artifactId);
        try {
          await this.persistChanges(changes, true);
        } catch (error) {
          this.restoreState(before);
          const warning = 'artifact removal not persisted; live artifact kept';
          return {
            v: 1,
            sessionId: this.sessionId,
            changes: [],
            warnings: [warning],
            warningDetails: [
              persistenceFailureDetail({
                message: warning,
                operation: 'remove',
                artifactIds: [artifactId],
                error,
              }),
            ],
          };
        }
      }
      if (!needsDurableTombstone) {
        this.artifacts.delete(artifactId);
      }
      const warnings = needsDurableTombstone
        ? []
        : await this.persistChanges(changes, false);
      stripDurableTombstoneMarkers(changes);
      const warningDetails = detailsForPersistenceWarnings(
        warnings,
        changes,
        'remove',
      );
      return {
        v: 1,
        sessionId: this.sessionId,
        changes,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(warningDetails.length > 0 ? { warningDetails } : {}),
      };
    });
  }

  async restore(
    snapshot: RebuiltSessionArtifactSnapshot | undefined,
    options: SessionArtifactRestoreOptions = {},
  ): Promise<string[]> {
    if (!snapshot) return [];
    return this.enqueue(async () => {
      const warnings = [...(snapshot?.warnings ?? [])];
      const baselineWarnings = [...warnings];
      const previousState = this.cloneState();
      const preservedLiveEphemeralArtifacts = options.preserveLiveEphemeral
        ? Array.from(this.artifacts.values())
            .filter((artifact) => artifact.retention === 'ephemeral')
            .map(cloneStoredArtifact)
        : [];
      let restoredCount = 0;
      this.artifacts.clear();
      this.tombstonedIds.clear();
      this.tombstonedClientIds.clear();
      this.stickyEphemeralIds.clear();
      this.markerArtifacts.clear();
      if (snapshot) {
        this.insertSeq = 0;
        this.persistenceSeq = snapshot.sequence;
        this.durableEventsSinceSnapshot = 0;
        this.consecutiveSnapshotFailures = 0;
        for (const id of snapshot.tombstonedIds) {
          this.tombstonedIds.add(id);
        }
        for (const id of snapshot.stickyEphemeralIds.slice(
          -MAX_STICKY_EPHEMERAL_IDS,
        )) {
          this.stickyEphemeralIds.add(id);
        }
        const markerIds = new Set([
          ...this.tombstonedIds,
          ...this.stickyEphemeralIds,
        ]);
        for (const artifact of snapshot.markerArtifacts ?? []) {
          if (!markerIds.has(artifact.id)) continue;
          const markerArtifact = await this.normalizeRestoredMarkerArtifact(
            artifact,
            warnings,
            options.workspaceAccess === 'metadata-only',
          );
          if (markerArtifact)
            this.markerArtifacts.set(artifact.id, markerArtifact);
        }
      }
      for (const artifact of snapshot?.artifacts ?? []) {
        try {
          const input = persistedArtifactToInput(artifact);
          if (input.retention === 'pinned') {
            input.retention = 'restorable';
            warnings.push(
              `pinned artifact ${artifact.id} downgraded to restorable; runtime does not support pinned retention`,
            );
          }
          let normalized = await this.normalizeInput(
            input,
            ++this.receivedSeq,
            artifact.storage === 'published' &&
              !isFileArtifactUrl(artifact.url),
            {
              metadataBudget: 'persisted',
              workspaceExpected: workspaceExpectedFromArtifact(artifact),
              hashWorkspaceContent: false,
              ...(options.workspaceAccess === 'metadata-only'
                ? {
                    workspaceAccess: 'metadata-only' as const,
                    workspaceStatus: artifact.status,
                  }
                : {}),
            },
          );
          if (
            this.stickyEphemeralIds.has(normalized.id) &&
            normalized.retention !== 'ephemeral'
          ) {
            normalized = {
              ...normalized,
              retention: 'ephemeral',
              persistenceWarning: 'sticky_override_active',
            };
          }
          const stickyApplied =
            normalized.persistenceWarning === 'sticky_override_active';
          if (normalized.id !== artifact.id) {
            warnings.push(`skipped artifact with mismatched id ${artifact.id}`);
            continue;
          }
          const retention = normalized.retention;
          let persistenceWarning: SessionArtifactPersistenceWarning | undefined;
          if (stickyApplied) {
            persistenceWarning = 'sticky_override_active';
          } else if (normalized.status !== 'available') {
            persistenceWarning = 'metadata_only_restore';
          }
          const stored: StoredArtifact = {
            ...normalized,
            retention,
            clientRetained: artifact.clientRetained,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            persistedAt: artifact.persistedAt,
            status: normalized.status,
            restoreState: 'restored',
            persistenceWarning,
            durableTombstoneRequired:
              retention !== 'ephemeral' ? true : undefined,
            insertSeq: ++this.insertSeq,
          };
          this.artifacts.set(stored.id, stored);
          restoredCount++;
        } catch (error) {
          warnings.push(
            `skipped artifact restore: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (snapshot.artifacts.length > 0 && restoredCount === 0) {
        this.restoreState(previousState);
        const rollbackWarnings = [
          ...baselineWarnings,
          `${RESTORE_FAILED_WARNING_PREFIX}; kept existing live artifacts`,
        ];
        this.setLastRestoreWarnings(rollbackWarnings);
        return rollbackWarnings;
      }
      if (
        previousState.artifacts.size > 0 &&
        baselineWarnings.some(isArtifactSnapshotCompletenessWarning)
      ) {
        this.restoreState(previousState);
        const rollbackWarnings = [
          ...baselineWarnings,
          restoredCount === 0
            ? `${RESTORE_FAILED_WARNING_PREFIX}; kept existing live artifacts`
            : `${RESTORE_PARTIAL_FAILED_WARNING_PREFIX}; kept existing live artifacts`,
        ];
        this.setLastRestoreWarnings(rollbackWarnings);
        return rollbackWarnings;
      }
      for (const artifact of preservedLiveEphemeralArtifacts) {
        if (
          this.artifacts.has(artifact.id) ||
          this.tombstonedIds.has(artifact.id)
        ) {
          continue;
        }
        this.artifacts.set(artifact.id, {
          ...artifact,
          insertSeq: ++this.insertSeq,
        });
      }
      const evicted = await this.evictOverflow(new Set(), []);
      if (evicted.removed.length > 0) {
        warnings.push('restored artifact list pruned to live limit');
        warnings.push(...(await this.persistChanges(evicted.removed, false)));
      }
      this.setLastRestoreWarnings(warnings);
      return warnings;
    });
  }

  async recordSnapshot(): Promise<string[]> {
    const persistence = this.persistence;
    if (!persistence) {
      return [
        'artifact persistence unavailable; restored artifacts not snapshotted',
      ];
    }
    return this.enqueue(async () => {
      const recordedAt = new Date().toISOString();
      const sequence = this.persistenceSeq + 1;
      try {
        await persistence.recordSnapshot(
          this.buildSnapshotPayload(recordedAt, sequence),
        );
        this.persistenceSeq = sequence;
        this.durableEventsSinceSnapshot = 0;
        this.consecutiveSnapshotFailures = 0;
        return [];
      } catch (error) {
        writeStderrLine(
          `[artifacts] session=${this.sessionId} action=snapshot_failed reason=${JSON.stringify(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        return ['artifact snapshot not persisted'];
      }
    });
  }

  private async normalizeRestoredMarkerArtifact(
    artifact: PersistedSessionArtifact,
    warnings: string[],
    metadataOnly = false,
  ): Promise<PersistedSessionArtifact | undefined> {
    try {
      const input = persistedArtifactToInput(artifact);
      if (input.retention === 'pinned') {
        input.retention = 'restorable';
        warnings.push(
          `pinned marker artifact ${artifact.id} downgraded to restorable; runtime does not support pinned retention`,
        );
      }
      const normalized = await this.normalizeInput(
        input,
        ++this.receivedSeq,
        artifact.storage === 'published' && !isFileArtifactUrl(artifact.url),
        {
          metadataBudget: 'persisted',
          workspaceExpected: workspaceExpectedFromArtifact(artifact),
          hashWorkspaceContent: false,
          ...(metadataOnly
            ? {
                workspaceAccess: 'metadata-only' as const,
                workspaceStatus: artifact.status,
              }
            : {}),
        },
      );
      if (normalized.id !== artifact.id) {
        warnings.push(
          `skipped marker artifact with mismatched id ${artifact.id}`,
        );
        return undefined;
      }
      return toPersistedArtifact(
        {
          ...normalized,
          clientRetained: artifact.clientRetained,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          persistedAt: artifact.persistedAt,
        },
        artifact.persistedAt ?? artifact.updatedAt,
      );
    } catch (error) {
      warnings.push(
        `skipped marker artifact ${artifact.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  private cloneState(): {
    artifacts: Map<string, StoredArtifact>;
    receivedSeq: number;
    insertSeq: number;
    persistenceSeq: number;
    durableEventsSinceSnapshot: number;
    consecutiveSnapshotFailures: number;
    tombstonedIds: Set<string>;
    tombstonedClientIds: Map<string, string | undefined>;
    stickyEphemeralIds: Set<string>;
    markerArtifacts: Map<string, PersistedSessionArtifact>;
    lastRestoreWarnings: string[];
    lastRestoreWarningDetails: SessionArtifactWarningDetail[];
  } {
    return {
      artifacts: new Map(
        Array.from(this.artifacts.entries()).map(([id, artifact]) => [
          id,
          cloneStoredArtifact(artifact),
        ]),
      ),
      receivedSeq: this.receivedSeq,
      insertSeq: this.insertSeq,
      persistenceSeq: this.persistenceSeq,
      durableEventsSinceSnapshot: this.durableEventsSinceSnapshot,
      consecutiveSnapshotFailures: this.consecutiveSnapshotFailures,
      tombstonedIds: new Set(this.tombstonedIds),
      tombstonedClientIds: new Map(this.tombstonedClientIds),
      stickyEphemeralIds: new Set(this.stickyEphemeralIds),
      markerArtifacts: new Map(this.markerArtifacts),
      lastRestoreWarnings: [...this.lastRestoreWarnings],
      lastRestoreWarningDetails: [...this.lastRestoreWarningDetails],
    };
  }

  private restoreState(state: {
    artifacts: Map<string, StoredArtifact>;
    receivedSeq: number;
    insertSeq: number;
    persistenceSeq: number;
    durableEventsSinceSnapshot: number;
    consecutiveSnapshotFailures: number;
    tombstonedIds: Set<string>;
    tombstonedClientIds: Map<string, string | undefined>;
    stickyEphemeralIds: Set<string>;
    markerArtifacts: Map<string, PersistedSessionArtifact>;
    lastRestoreWarnings: string[];
    lastRestoreWarningDetails: SessionArtifactWarningDetail[];
  }): void {
    this.artifacts.clear();
    for (const [id, artifact] of state.artifacts) {
      this.artifacts.set(id, cloneStoredArtifact(artifact));
    }
    this.receivedSeq = state.receivedSeq;
    this.insertSeq = state.insertSeq;
    this.persistenceSeq = state.persistenceSeq;
    this.durableEventsSinceSnapshot = state.durableEventsSinceSnapshot;
    this.consecutiveSnapshotFailures = state.consecutiveSnapshotFailures;
    this.tombstonedIds.clear();
    for (const id of state.tombstonedIds) {
      this.tombstonedIds.add(id);
    }
    this.tombstonedClientIds.clear();
    for (const [id, clientId] of state.tombstonedClientIds) {
      this.tombstonedClientIds.set(id, clientId);
    }
    this.stickyEphemeralIds.clear();
    for (const id of state.stickyEphemeralIds) {
      this.stickyEphemeralIds.add(id);
    }
    this.markerArtifacts.clear();
    for (const [id, artifact] of state.markerArtifacts) {
      this.markerArtifacts.set(id, artifact);
    }
    this.setLastRestoreWarnings(state.lastRestoreWarnings);
    this.lastRestoreWarningDetails = [...state.lastRestoreWarningDetails];
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
      const warnings = this.downgradeDurableChanges(durableChanges);
      this.applyDurableMarkers(durableChanges);
      return warnings;
    }

    const recordedAt = new Date().toISOString();
    for (const change of durableChanges) {
      if (change.action === 'removed') continue;
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      const artifact = {
        ...toPublicArtifact(stored),
        persistedAt: recordedAt,
      };
      change.artifact = artifact;
    }

    const sequence = this.persistenceSeq + 1;
    const payload: SessionArtifactEventRecordPayload = {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence,
      recordedAt,
      changes: durableChanges.map((change) =>
        toPersistedChange(change, recordedAt),
      ),
    };

    try {
      await this.persistence.recordEvent(payload);
      this.persistenceSeq = sequence;
      for (const change of durableChanges) {
        if (change.action === 'removed') continue;
        const stored = this.artifacts.get(change.artifactId);
        if (!stored) continue;
        stored.persistedAt = recordedAt;
        stored.durableTombstoneRequired = true;
        change.artifact = toPublicArtifact(stored);
      }
      this.applyDurableMarkers(durableChanges);
      await this.maybeRecordSnapshot(recordedAt);
      return [];
    } catch (error) {
      if (strict) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const artifactIds = durableChanges.map((change) => change.artifactId);
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=persist_failed sequence=${payload.sequence} artifactIds=${JSON.stringify(
          artifactIds,
        )} reason=${JSON.stringify(reason)}`,
      );
      const warnings = this.downgradeDurableChanges(durableChanges);
      this.applyDurableMarkers(durableChanges);
      return warnings;
    }
  }

  private async maybeRecordSnapshot(recordedAt: string): Promise<void> {
    if (!this.persistence) return;
    this.durableEventsSinceSnapshot++;
    const snapshotThreshold =
      SNAPSHOT_AFTER_DURABLE_EVENTS *
      Math.min(
        MAX_SNAPSHOT_BACKOFF_MULTIPLIER,
        2 ** this.consecutiveSnapshotFailures,
      );
    if (this.durableEventsSinceSnapshot < snapshotThreshold) {
      return;
    }
    const sequence = this.persistenceSeq + 1;
    try {
      await this.persistence.recordSnapshot(
        this.buildSnapshotPayload(recordedAt, sequence),
      );
      this.persistenceSeq = sequence;
      this.durableEventsSinceSnapshot = 0;
      this.consecutiveSnapshotFailures = 0;
    } catch (error) {
      this.consecutiveSnapshotFailures = Math.min(
        this.consecutiveSnapshotFailures + 1,
        Math.log2(MAX_SNAPSHOT_BACKOFF_MULTIPLIER),
      );
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=snapshot_failed reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  private buildSnapshotPayload(
    recordedAt: string,
    sequence: number,
  ): SessionArtifactSnapshotRecordPayload {
    const artifacts = Array.from(this.artifacts.values())
      .filter((artifact) => artifact.retention !== 'ephemeral')
      .sort((a, b) => a.insertSeq - b.insertSeq)
      .map((artifact) => toPersistedArtifact(artifact, recordedAt));
    const stickyEphemeralIds = Array.from(this.stickyEphemeralIds).filter(
      (id) => this.artifacts.has(id) || this.markerArtifacts.has(id),
    );
    const markerArtifacts = this.buildMarkerArtifacts(
      recordedAt,
      stickyEphemeralIds,
    );
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence,
      recordedAt,
      artifacts,
      tombstonedIds: Array.from(this.tombstonedIds),
      stickyEphemeralIds,
      ...(markerArtifacts.length > 0 ? { markerArtifacts } : {}),
    };
  }

  private buildMarkerArtifacts(
    recordedAt: string,
    stickyEphemeralIds: string[],
  ): PersistedSessionArtifact[] {
    const markerIds = [...this.tombstonedIds, ...stickyEphemeralIds];
    const artifacts: PersistedSessionArtifact[] = [];
    const seen = new Set<string>();
    for (const id of markerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const live = this.artifacts.get(id);
      if (live) {
        artifacts.push(toPersistedArtifact(toPublicArtifact(live), recordedAt));
        continue;
      }
      const markerArtifact = this.markerArtifacts.get(id);
      if (markerArtifact) {
        artifacts.push(markerArtifact);
      }
    }
    return artifacts;
  }

  private downgradeDurableChanges(changes: SessionArtifactChange[]): string[] {
    let downgraded = false;
    let removalNotPersisted = false;
    for (const change of changes) {
      if (change.action === 'removed') {
        removalNotPersisted = true;
        if (change.reason === 'explicit') {
          this.rememberTombstone(change);
          this.stickyEphemeralIds.delete(change.artifactId);
        }
        continue;
      }
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      stored.retention = 'ephemeral';
      stored.persistenceWarning = 'persistence_unavailable';
      stored.durableTombstoneRequired =
        stored.durableTombstoneRequired || stored.persistedAt !== undefined;
      delete stored.persistedAt;
      change.artifact = toPublicArtifact(stored);
      downgraded = true;
    }
    const warnings: string[] = [];
    if (downgraded) {
      warnings.push(
        'artifact persistence unavailable; durable artifacts kept ephemeral',
      );
    }
    if (removalNotPersisted) {
      warnings.push('artifact removal not persisted; live removal kept');
    }
    return warnings;
  }

  private applyDurableMarkers(changes: readonly SessionArtifactChange[]): void {
    for (const change of changes) {
      if (change.action === 'removed') {
        if (change.reason === 'explicit') {
          this.rememberTombstone(change);
          this.stickyEphemeralIds.delete(change.artifactId);
        } else if (change.reason === 'eviction') {
          this.stickyEphemeralIds.delete(change.artifactId);
          this.markerArtifacts.delete(change.artifactId);
        } else if (change.reason === 'unpin_to_ephemeral') {
          this.rememberStickyEphemeral(change);
        }
        continue;
      }
      if (change.artifact && change.artifact.retention !== 'ephemeral') {
        this.tombstonedIds.delete(change.artifactId);
        this.tombstonedClientIds.delete(change.artifactId);
        this.stickyEphemeralIds.delete(change.artifactId);
        this.markerArtifacts.delete(change.artifactId);
      }
    }
  }

  private rememberStickyEphemeral(change: SessionArtifactChange): void {
    const artifactId = change.artifactId;
    this.stickyEphemeralIds.delete(artifactId);
    this.stickyEphemeralIds.add(artifactId);
    if (change.artifact) {
      this.markerArtifacts.set(
        artifactId,
        toPersistedArtifact(change.artifact, change.artifact.updatedAt),
      );
    }
    while (this.stickyEphemeralIds.size > MAX_STICKY_EPHEMERAL_IDS) {
      const oldest = this.stickyEphemeralIds.values().next().value;
      if (oldest === undefined) break;
      this.stickyEphemeralIds.delete(oldest);
      this.markerArtifacts.delete(oldest);
    }
  }

  private rememberTombstone(change: SessionArtifactChange): void {
    this.tombstonedIds.delete(change.artifactId);
    this.tombstonedIds.add(change.artifactId);
    this.tombstonedClientIds.set(
      change.artifactId,
      (change as InternalSessionArtifactChange).removedClientId ??
        this.artifacts.get(change.artifactId)?.clientId,
    );
    if (change.artifact) {
      this.markerArtifacts.set(
        change.artifactId,
        toPersistedArtifact(change.artifact, change.artifact.updatedAt),
      );
    }
    while (this.tombstonedIds.size > MAX_TOMBSTONED_IDS) {
      const oldest = this.tombstonedIds.values().next().value;
      if (oldest === undefined) break;
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=tombstone_evicted artifactId=${JSON.stringify(
          oldest,
        )} limit=${MAX_TOMBSTONED_IDS}`,
      );
      this.tombstonedIds.delete(oldest);
      this.tombstonedClientIds.delete(oldest);
      this.markerArtifacts.delete(oldest);
    }
  }

  private setLastRestoreWarnings(warnings: readonly string[]): void {
    this.lastRestoreWarnings = [...warnings];
    this.lastRestoreWarningDetails = detailsForRestoreWarnings(warnings);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private denyCrossClientMutation(
    action: 'remove' | 'pin' | 'unpin' | 'upsert',
    artifactId: string,
    existing: StoredArtifact,
    options?: { clientId?: string },
  ): void {
    if (
      existing.source !== 'client' ||
      existing.clientId === undefined ||
      existing.clientId === options?.clientId
    ) {
      return;
    }
    writeStderrLine(
      `[artifacts] session=${this.sessionId} action=${action}_denied artifactId=${artifactId} owner=${existing.clientId} requester=${options?.clientId ?? '<anonymous>'}`,
    );
    throw new SessionArtifactAuthorizationError(
      this.sessionId,
      artifactId,
      existing.clientId,
      options?.clientId,
    );
  }

  private async expandWorkspaceDirectoryInput(
    input: SessionArtifactInput,
  ): Promise<{ inputs: SessionArtifactInput[]; warning?: string }> {
    const workspacePath =
      typeof input.workspacePath === 'string'
        ? input.workspacePath.trim()
        : undefined;
    if (!workspacePath) {
      return { inputs: [input] };
    }
    const realWorkspace = await this.getRealWorkspaceCwdForValidation();
    const normalizedPath = normalizeWorkspacePath(workspacePath, realWorkspace);
    const absolutePath = path.resolve(realWorkspace, normalizedPath);
    let stat: Stats;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { inputs: [input] };
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        'workspacePath',
      );
    }
    let walkDir = absolutePath;
    let walkRelative = normalizedPath;
    if (stat.isSymbolicLink()) {
      let realPath: string;
      try {
        realPath = await fs.realpath(absolutePath);
      } catch {
        return { inputs: [input] };
      }
      let realStat: Stats;
      try {
        realStat = await fs.lstat(realPath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return { inputs: [input] };
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new SessionArtifactValidationError(
          `workspacePath could not be inspected: ${reason}`,
          'workspacePath',
        );
      }
      if (!realStat.isDirectory()) {
        return { inputs: [input] };
      }
      walkDir = realPath;
      // Keep the caller-facing symlink path so expansion and direct records
      // share one identity; realPath is only used to read the directory.
      walkRelative = normalizedPath;
    } else if (!stat.isDirectory()) {
      return { inputs: [input] };
    } else {
      // Intermediate symlink components are followed by path lookup, so the
      // final lstat may look like a plain directory while the real target
      // sits under a skipped tree. Canonicalize before the skip gate.
      try {
        walkDir = await fs.realpath(absolutePath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return { inputs: [input] };
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new SessionArtifactValidationError(
          `workspacePath could not be inspected: ${reason}`,
          'workspacePath',
        );
      }
    }

    const resolvedRelative = path.relative(realWorkspace, walkDir);
    if (!resolvedRelative || isOutsidePath(resolvedRelative)) {
      throw new SessionArtifactValidationError(
        'workspacePath must stay inside the workspace',
        'workspacePath',
      );
    }
    if (
      pathHasSkippedDirectoryComponent(
        resolvedRelative.split(path.sep).join('/'),
      ) ||
      (walkRelative && pathHasSkippedDirectoryComponent(walkRelative))
    ) {
      throw new SessionArtifactValidationError(
        'workspacePath is a skipped directory and cannot be recorded',
        'workspacePath',
      );
    }

    if (
      input.metadata !== undefined &&
      !isPlainMetadataObject(input.metadata)
    ) {
      throw new SessionArtifactValidationError(
        'metadata must be an object',
        'metadata',
      );
    }
    const childMetadata = {
      ...(isPlainMetadataObject(input.metadata) ? input.metadata : {}),
      expandedFromDirectory: true as const,
    };
    if (Buffer.byteLength(JSON.stringify(childMetadata), 'utf8') > 4096) {
      throw new SessionArtifactValidationError(
        'metadata is too large to expand a directory',
        'metadata',
      );
    }
    const parentTitle = normalizeString(input.title, 'title', 200, true);
    const parentDescription = normalizeString(
      input.description,
      'description',
      1000,
      false,
    );

    let collected: Awaited<ReturnType<typeof collectRecordableWorkspaceFiles>>;
    try {
      collected = await collectRecordableWorkspaceFiles(
        walkDir,
        walkRelative,
        realWorkspace,
        (filePath) =>
          isRecordableDerivedChild(path.posix.basename(filePath), filePath),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return { inputs: [input] };
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        'workspacePath',
      );
    }
    if (collected.files.length === 0) {
      throw new SessionArtifactValidationError(
        collected.depthLimited
          ? `workspacePath is a directory whose recordable files are deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} levels`
          : 'workspacePath is a directory with no recordable files',
        'workspacePath',
      );
    }

    const warnings: string[] = [];
    if (collected.truncated) {
      warnings.push(
        `workspacePath "${normalizedPath}" contained more than ${MAX_DIRECTORY_ARTIFACT_FILES} files; recorded the first ${collected.files.length}`,
      );
    }
    if (collected.depthLimited) {
      warnings.push(
        `workspacePath "${normalizedPath}" exceeded ${MAX_DIRECTORY_ARTIFACT_DEPTH} directory levels; some files were not recorded`,
      );
    }
    if (collected.unreadable) {
      warnings.push(
        `workspacePath "${normalizedPath}" contained subdirectories that could not be read`,
      );
    }
    if (collected.skippedUnrecordable > 0) {
      warnings.push(
        `workspacePath "${normalizedPath}" skipped ${collected.skippedUnrecordable} files whose names cannot be recorded as artifact titles`,
      );
    }
    return {
      inputs: collected.files.map((filePath) => {
        const title = path.posix.basename(filePath).trim();
        const description =
          parentDescription ||
          (parentTitle && parentTitle !== title ? parentTitle : undefined);
        return {
          ...input,
          title,
          workspacePath: filePath,
          kind: undefined,
          mimeType: undefined,
          sizeBytes: undefined,
          metadata: childMetadata,
          ...(description ? { description } : { description: undefined }),
        };
      }),
      ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    };
  }

  private async normalizeInput(
    input: RestoreSessionArtifactInput,
    receivedSeq: number,
    trustedPublisherFromCaller: boolean,
    options: {
      metadataBudget?: 'user' | 'persisted';
      workspaceExpected?: WorkspaceStatusExpected;
      hashWorkspaceContent?: boolean;
      workspaceAccess?: 'metadata-only';
      workspaceStatus?: DaemonSessionArtifactStatus;
    } = {},
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
      ? normalizeWorkspacePath(
          input.workspacePath,
          options.workspaceAccess === 'metadata-only'
            ? this.workspaceCwd
            : await this.getRealWorkspaceCwdForValidation(),
        )
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

    const retention = normalizeRetention(input.retention, {
      persistenceAvailable: this.persistence !== undefined,
    });
    const workspaceStatus = workspacePath
      ? options.workspaceAccess === 'metadata-only'
        ? {
            status: options.workspaceStatus ?? 'missing',
            ...(options.workspaceExpected?.sizeBytes !== undefined
              ? { sizeBytes: options.workspaceExpected.sizeBytes }
              : {}),
          }
        : await this.getInitialWorkspaceStatus(
            workspacePath,
            options.workspaceExpected,
            { hashContent: options.hashWorkspaceContent !== false },
          )
      : undefined;
    if (workspaceStatus?.escaped) {
      throw new SessionArtifactValidationError(
        'workspacePath must stay inside the workspace',
        'workspacePath',
      );
    }
    const metadata = withWorkspaceContentHashMetadata(
      normalizeMetadata(input.metadata, {
        budget: options.metadataBudget ?? 'user',
      }),
      workspaceStatus,
    );
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
      retentionExplicit: input.retention !== undefined,
      retentionSource: source,
      trustedPublisher,
      kind,
      storage,
      source,
      status: workspaceStatus?.status ?? 'available',
      ...(workspacePath && options.workspaceAccess !== 'metadata-only'
        ? { lastStatAt: Date.now() }
        : {}),
      title,
      description,
      workspacePath,
      managedId,
      url,
      mimeType: normalizeString(input.mimeType, 'mimeType', 120, false),
      sizeBytes:
        workspaceStatus?.sizeBytes !== undefined
          ? workspaceStatus.sizeBytes
          : input.sizeBytes !== undefined
            ? normalizeSizeBytes(input.sizeBytes)
            : undefined,
      metadata,
      retention,
      restoreState: 'live',
      ...(this.persistence === undefined && retention !== 'ephemeral'
        ? { persistenceWarning: 'persistence_unavailable' as const }
        : {}),
      clientRetained:
        source === 'client' &&
        (input.clientRetained !== undefined
          ? input.clientRetained === true
          : true),
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

  private shouldSuppressTombstonedUpsert(
    artifact: NormalizedArtifact,
  ): boolean {
    if (!this.tombstonedIds.has(artifact.id)) {
      return false;
    }
    const tombstonedClientId = this.tombstonedClientIds.get(artifact.id);
    // Tool/hook outputs are session-scoped and may be recreated by a later run
    // with the same identity after an explicit deletion.
    if (artifact.source !== 'client') {
      return false;
    }
    return !(
      artifact.retentionExplicit &&
      artifact.clientId !== undefined &&
      artifact.clientId === tombstonedClientId
    );
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

  private applyStickyEphemeralOverride(
    artifact: NormalizedArtifact,
  ): NormalizedArtifact {
    if (
      !this.stickyEphemeralIds.has(artifact.id) ||
      artifact.retentionExplicit ||
      artifact.retention === 'ephemeral'
    ) {
      return artifact;
    }
    return {
      ...artifact,
      retention: 'ephemeral',
      retentionExplicit: true,
      persistenceWarning: 'sticky_override_active',
    };
  }

  private async getInitialWorkspaceStatus(
    workspacePath: string,
    expected?: WorkspaceStatusExpected,
    options: { hashContent: boolean } = { hashContent: true },
  ): Promise<{
    status: DaemonSessionArtifactStatus;
    sizeBytes?: number;
    sha256?: string;
    mtimeMs?: number;
    escaped?: boolean;
  }> {
    try {
      return await getWorkspaceStatus(
        workspacePath,
        this.getRealWorkspaceCwd(),
        expected,
        options,
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
        artifact.workspacePath,
        this.getRealWorkspaceCwd(),
        {
          sizeBytes: artifact.sizeBytes,
          mtimeMs: artifact.metadata?.[WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY],
          sha256: artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY],
        },
      );
      const changed = isWorkspaceContentChanged(artifact, status);
      artifact.status = changed ? 'changed' : status.status;
      if (!changed) {
        artifact.sizeBytes = status.sizeBytes;
      }
      if (status.escaped) {
        artifact.status = 'missing';
        artifact.sizeBytes = undefined;
        artifact.hideWorkspacePath = true;
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

  private async getRealWorkspaceCwdForValidation(): Promise<string> {
    try {
      return await this.getRealWorkspaceCwd();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        'workspacePath',
      );
    }
  }

  private async evictOverflow(
    createdIds: Set<string>,
    changes: SessionArtifactChange[],
    strict = false,
  ): Promise<{ removed: SessionArtifactChange[]; droppedCreated: number }> {
    const removed: SessionArtifactChange[] = [];
    if (this.artifacts.size <= this.maxArtifacts) {
      return { removed, droppedCreated: 0 };
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
        durableTombstoneRequired: artifact.durableTombstoneRequired,
        reason: 'eviction',
      });
    }

    const overflowCreated = Array.from(this.artifacts.values())
      .filter((artifact) => createdInThisBatch.has(artifact.id))
      .sort((a, b) => b.receivedSeq - a.receivedSeq);
    if (
      strict &&
      overflowCreated.length > 0 &&
      this.artifacts.size > this.maxArtifacts
    ) {
      throw new SessionArtifactValidationError(
        'artifact store is full; no eviction candidate is available',
        'artifactId',
      );
    }
    let droppedCreated = 0;
    for (const artifact of overflowCreated) {
      if (this.artifacts.size <= this.maxArtifacts) {
        break;
      }
      this.artifacts.delete(artifact.id);
      droppedCreated++;
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=dropped reason="max artifacts exceeded" artifactId=${artifact.id}`,
      );
      removePriorChange(changes, artifact.id);
    }

    return { removed, droppedCreated };
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
      retentionExplicit: existing.retentionExplicit || next.retentionExplicit,
      retentionSource: existing.retentionSource,
      retention: mergeRetention(existing, next),
      restoreState: 'live',
      persistenceWarning:
        existing.persistenceWarning ?? next.persistenceWarning,
      persistedAt: existing.persistedAt ?? next.persistedAt,
      clientRetained: existing.clientRetained || next.clientRetained,
      lastStatAt: undefined,
    };
    delete merged.workspacePath;
    return merged;
  }
  const refreshDisplay =
    existing.storage === 'workspace' &&
    next.storage === 'workspace' &&
    shouldRefreshWorkspaceDisplay(next, existing);
  const metadata = mergeMetadata(existing, next);
  return {
    ...existing,
    title: refreshDisplay ? next.title : existing.title,
    description: refreshDisplay
      ? (next.description ?? existing.description)
      : existing.description,
    toolName: refreshDisplay ? next.toolName : existing.toolName,
    source: refreshDisplay ? next.source : existing.source,
    hookEventName: refreshDisplay ? next.hookEventName : existing.hookEventName,
    toolCallId: refreshDisplay ? next.toolCallId : existing.toolCallId,
    status: next.status,
    sizeBytes: mergeSizeBytes(existing, next),
    metadata: refreshDisplay
      ? stripExpandedFromDirectoryMarker(metadata)
      : metadata,
    clientRetained: existing.clientRetained || next.clientRetained,
    trustedPublisher: existing.trustedPublisher || next.trustedPublisher,
    retentionExplicit: existing.retentionExplicit || next.retentionExplicit,
    retention: mergeRetention(existing, next),
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
    hideWorkspacePath:
      publishedUpdate ||
      existing.storage === 'published' ||
      incoming.workspacePath
        ? undefined
        : existing.hideWorkspacePath,
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
    retention: mergeRetention(existing, incoming),
    restoreState: 'live',
    persistenceWarning:
      incoming.retentionExplicit && incoming.retention !== 'ephemeral'
        ? incoming.persistenceWarning
        : (existing.persistenceWarning ?? incoming.persistenceWarning),
    persistedAt:
      incoming.retentionExplicit && incoming.retention === 'ephemeral'
        ? undefined
        : (existing.persistedAt ?? incoming.persistedAt),
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
    delete next.hideWorkspacePath;
  } else if (
    existing.storage === 'workspace' &&
    incoming.storage === 'workspace' &&
    shouldRefreshWorkspaceDisplay(incoming, existing)
  ) {
    // Workspace re-records keep the same locator identity. Explicit
    // record_artifact (or the same producer) may refresh the display
    // name; write_file/hook auto-records must not clobber it.
    next.title = incoming.title;
    next.description = incoming.description ?? existing.description;
    next.toolCallId = incoming.toolCallId;
    next.toolName = incoming.toolName;
    next.source = incoming.source;
    next.hookEventName = incoming.hookEventName;
    next.metadata = stripExpandedFromDirectoryMarker(next.metadata);
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

function shouldRecordEphemeralUnpin(
  existing: StoredArtifact,
  incoming: NormalizedArtifact,
): boolean {
  return (
    incoming.retentionExplicit &&
    incoming.retention === 'ephemeral' &&
    (existing.retention !== 'ephemeral' ||
      existing.persistedAt !== undefined ||
      existing.durableTombstoneRequired === true)
  );
}

function stripExpandedFromDirectoryMarker(
  metadata: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (metadata?.['expandedFromDirectory'] !== true) {
    return metadata;
  }
  const { expandedFromDirectory: _dropped, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function shouldRefreshWorkspaceDisplay(
  incoming: Pick<
    NormalizedArtifact,
    'toolName' | 'source' | 'hookEventName' | 'metadata'
  >,
  existing: Pick<NormalizedArtifact, 'toolName' | 'source' | 'hookEventName'>,
): boolean {
  if (incoming.metadata?.['expandedFromDirectory'] === true) {
    return false;
  }
  if (incoming.toolName === 'record_artifact' && incoming.source !== 'hook') {
    return true;
  }
  if (!incoming.toolName) {
    return true;
  }
  return (
    incoming.toolName === existing.toolName &&
    incoming.source === existing.source &&
    incoming.hookEventName === existing.hookEventName
  );
}

export function publicArtifactsEqual(
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
    a.persistedAt === b.persistedAt &&
    a.clientRetained === b.clientRetained &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.toolCallId === b.toolCallId &&
    a.toolName === b.toolName &&
    a.hookEventName === b.hookEventName &&
    a.clientId === b.clientId
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
  a: DaemonSessionArtifactRetention,
  b: DaemonSessionArtifactRetention,
): DaemonSessionArtifactRetention {
  const rank: Record<DaemonSessionArtifactRetention, number> = {
    ephemeral: 0,
    restorable: 1,
  };
  return rank[b] > rank[a] ? b : a;
}

function mergeRetention(
  existing: Pick<StoredArtifact, 'retention' | 'retentionExplicit'>,
  incoming: Pick<NormalizedArtifact, 'retention' | 'retentionExplicit'>,
): DaemonSessionArtifactRetention {
  if (incoming.retentionExplicit && incoming.retention === 'ephemeral') {
    return 'ephemeral';
  }
  if (
    existing.retentionExplicit &&
    existing.retention === 'ephemeral' &&
    !incoming.retentionExplicit
  ) {
    return 'ephemeral';
  }
  return strongestRetention(existing.retention, incoming.retention);
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
    if (
      (key === WORKSPACE_CONTENT_SHA256_METADATA_KEY ||
        key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY) &&
      merged[key] !== value
    ) {
      merged[key] = value;
      changed = true;
    } else if (!Object.hasOwn(merged, key)) {
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
  return metadataBudgetBytes(metadata, 'persisted') <= 4096;
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
    oldest(candidates)
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
  const hideWorkspacePath =
    'hideWorkspacePath' in artifact && artifact.hideWorkspacePath === true;
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
    persistedAt,
    clientRetained,
    createdAt,
    updatedAt,
    toolCallId,
    toolName,
    hookEventName,
  } = artifact;
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...(description ? { description } : {}),
    ...(workspacePath && !hideWorkspacePath ? { workspacePath } : {}),
    ...(managedId ? { managedId } : {}),
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(metadata ? { metadata } : {}),
    retention,
    ...(restoreState ? { restoreState } : {}),
    ...(persistenceWarning ? { persistenceWarning } : {}),
    ...(persistedAt ? { persistedAt } : {}),
    clientRetained,
    createdAt,
    updatedAt,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(hookEventName ? { hookEventName } : {}),
  };
}

function persistedArtifactToInput(
  artifact: PersistedSessionArtifact,
): RestoreSessionArtifactInput {
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
  };
}

function workspaceExpectedFromArtifact(
  artifact: PersistedSessionArtifact,
): WorkspaceStatusExpected | undefined {
  if (!artifact.workspacePath) {
    return undefined;
  }
  return {
    sizeBytes: artifact.sizeBytes,
    mtimeMs: artifact.metadata?.[WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY],
    sha256: artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY],
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
    status: artifact.status === 'changed' ? 'available' : artifact.status,
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
    ...(artifact.toolCallId ? { toolCallId: artifact.toolCallId } : {}),
    ...(artifact.toolName ? { toolName: artifact.toolName } : {}),
    ...(artifact.hookEventName
      ? { hookEventName: artifact.hookEventName }
      : {}),
  };
}

function isFileArtifactUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    return new URL(raw).protocol === 'file:';
  } catch {
    return false;
  }
}

function isArtifactSnapshotCompletenessWarning(warning: string): boolean {
  if (warning.startsWith('skipped stale event sequence ')) return false;
  return (
    warning.startsWith('skipped ') || warning.includes(' list truncated to ')
  );
}

function shouldCommitBeforeDurablePersistence(
  change: SessionArtifactChange,
): boolean {
  return (
    change.action === 'removed' && change.durableTombstoneRequired === true
  );
}

function isDurablePersistenceChange(change: SessionArtifactChange): boolean {
  if (change.action === 'removed' && change.durableTombstoneRequired === true) {
    return true;
  }
  if (!change.artifact) return false;
  return (
    change.artifact.retention !== 'ephemeral' ||
    change.artifact.persistenceWarning === 'persistence_unavailable'
  );
}

function stripDurableTombstoneMarkers(changes: SessionArtifactChange[]): void {
  for (const change of changes) {
    delete change.durableTombstoneRequired;
    delete (change as InternalSessionArtifactChange).removedClientId;
  }
}

function detailsForRestoreWarnings(
  warnings: readonly string[],
): SessionArtifactWarningDetail[] {
  return warnings.map((warning) => {
    if (warning.startsWith(RESTORE_FAILED_WARNING_PREFIX)) {
      return {
        code: 'ARTIFACT_RESTORE_FAILED',
        operation: 'restore',
        durability: 'unavailable',
        retryable: true,
        message: warning,
      };
    }
    if (warning.startsWith(RESTORE_PARTIAL_FAILED_WARNING_PREFIX)) {
      return {
        code: 'ARTIFACT_RESTORE_PARTIAL_FAILED',
        operation: 'restore',
        durability: 'live_only',
        retryable: true,
        message: warning,
      };
    }
    return {
      code: 'ARTIFACT_WARNING',
      operation: 'restore',
      message: warning,
    };
  });
}

function detailsForPersistenceWarnings(
  warnings: readonly string[],
  changes: readonly SessionArtifactChange[],
  operation: SessionArtifactWarningDetail['operation'],
): SessionArtifactWarningDetail[] {
  if (warnings.length === 0) return [];
  const artifactIds = changes
    .filter(isDurablePersistenceChange)
    .map((change) => change.artifactId);
  return warnings.map((warning) => {
    if (
      warning ===
      'artifact persistence unavailable; durable artifacts kept ephemeral'
    ) {
      return {
        code: 'ARTIFACT_PERSISTENCE_UNAVAILABLE',
        operation,
        artifactIds,
        durability: 'live_only',
        retryable: false,
        message: warning,
      };
    }
    if (warning === 'artifact removal not persisted; live removal kept') {
      return {
        code: 'ARTIFACT_REMOVAL_NOT_PERSISTED',
        operation,
        artifactIds,
        durability: 'live_only',
        retryable: true,
        message: warning,
      };
    }
    return {
      code: 'ARTIFACT_WARNING',
      operation,
      artifactIds,
      message: warning,
    };
  });
}

function persistenceFailureDetail(options: {
  message: string;
  operation: SessionArtifactWarningDetail['operation'];
  artifactIds: string[];
  error: unknown;
}): SessionArtifactWarningDetail {
  const unavailable =
    options.error instanceof SessionArtifactValidationError &&
    options.error.message === 'artifact persistence is unavailable';
  return {
    code: unavailable
      ? 'ARTIFACT_PERSISTENCE_UNAVAILABLE'
      : 'ARTIFACT_PERSISTENCE_WRITE_FAILED',
    operation: options.operation,
    artifactIds: options.artifactIds,
    durability: 'unavailable',
    retryable: !unavailable,
    message: options.message,
  };
}

function cloneStoredArtifact(artifact: StoredArtifact): StoredArtifact {
  return {
    ...artifact,
    ...(artifact.metadata ? { metadata: { ...artifact.metadata } } : {}),
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
    kind === 'document' ||
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
  if (hasSecretLikeUrlComponent(parsed)) {
    throw new SessionArtifactValidationError(
      'url must not include secret-like components',
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

function hasSecretLikeUrlComponent(parsed: URL): boolean {
  for (const [key, value] of parsed.searchParams) {
    if (isSecretLikeUrlText(key) || isSecretLikeUrlValue(value)) {
      return true;
    }
  }
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      // Keep scanning the raw segment if URL parsing accepted malformed escape.
    }
    if (isSecretLikeUrlValue(decodedSegment)) {
      return true;
    }
  }
  const fragment = parsed.hash.slice(1);
  return hasSecretLikeUrlFragment(fragment);
}

function hasSecretLikeUrlFragment(fragment: string): boolean {
  if (!fragment) return false;
  const candidates = new Set([fragment]);
  try {
    candidates.add(decodeURIComponent(fragment));
  } catch {
    // Keep scanning the raw fragment if URL parsing accepted malformed escape.
  }
  for (const candidate of candidates) {
    if (isSecretLikeUrlText(candidate) || isSecretLikeUrlValue(candidate)) {
      return true;
    }
    for (const [key, value] of new URLSearchParams(candidate)) {
      if (isSecretLikeUrlText(key) || isSecretLikeUrlValue(value)) {
        return true;
      }
    }
  }
  return false;
}

function isSecretLikeUrlText(value: string): boolean {
  const normalized = value.replace(/([a-z])([A-Z])/g, '$1-$2');
  return /(?:^|[-_.])(token|secret|password|passwd|pwd|cookie|authorization|credential|signature|sig|api[-_]?key|access[-_]?key)(?:$|[-_.=&#])/i.test(
    normalized,
  );
}

function isSecretLikeUrlValue(value: string): boolean {
  return SECRET_TOKEN_VALUE_PATTERN.test(value.trim());
}

function isSecretLikeMetadataValue(value: string): boolean {
  return /^(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,})$/i.test(
    value.trim(),
  );
}

function normalizeMetadata(
  metadata: unknown,
  options: { budget?: 'user' | 'persisted' } = {},
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
    if (isPrototypeMetadataKey(key)) {
      continue;
    }
    if (options.budget !== 'persisted' && isReservedWorkspaceMetadataKey(key)) {
      continue;
    }
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
    if (isSecretLikeUrlText(key)) {
      throw new SessionArtifactValidationError(
        'metadata keys must not contain secret-like names',
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
    if (
      typeof value === 'string' &&
      !isReservedWorkspaceMetadataKey(key) &&
      isSecretLikeMetadataValue(value)
    ) {
      throw new SessionArtifactValidationError(
        'metadata string values must not contain secret-like tokens',
        'metadata',
      );
    }
    normalized[key] = value;
  }
  if (Object.keys(normalized).length === 0) {
    return undefined;
  }
  if (metadataBudgetBytes(normalized, options.budget ?? 'user') > 4096) {
    throw new SessionArtifactValidationError(
      'metadata must be 4096 bytes or fewer',
      'metadata',
    );
  }
  return normalized;
}

function normalizeRetention(
  value: unknown,
  options: { persistenceAvailable: boolean },
): DaemonSessionArtifactRetention {
  if (value === undefined) {
    return options.persistenceAvailable ? 'restorable' : 'ephemeral';
  }
  if (value === 'ephemeral' || value === 'restorable') {
    return value;
  }
  if (value === 'pinned') {
    throw new SessionArtifactValidationError(
      'pinned retention is not supported by session_artifacts_persistence',
      'retention',
    );
  }
  throw new SessionArtifactValidationError(
    'retention must be ephemeral or restorable',
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
  if (isOfficeDocumentExtension(ext)) return 'document';
  return input.workspacePath ? 'file' : 'other';
}

async function getWorkspaceStatus(
  workspacePath: string,
  realWorkspaceCwd: Promise<string>,
  expected?: WorkspaceStatusExpected,
  options: { hashContent: boolean } = { hashContent: true },
): Promise<{
  status: DaemonSessionArtifactStatus;
  sizeBytes?: number;
  sha256?: string;
  mtimeMs?: number;
  escaped?: boolean;
}> {
  const realWorkspace = await realWorkspaceCwd;
  const absolutePath = path.resolve(realWorkspace, workspacePath);
  try {
    const realPath = await fs.realpath(absolutePath);
    const relative = path.relative(realWorkspace, realPath);
    if (!relative || isOutsidePath(relative)) {
      return { status: 'missing', escaped: true };
    }
    // Identity is compared on bigint stats: NTFS file ids are 64-bit and the
    // Number spelling loses precision above 2^53, so two files created close
    // together can round to the SAME numeric ino and defeat the swap check.
    const preOpenStat = await fs.lstat(realPath, { bigint: true });
    // Where O_NOFOLLOW does not exist (Windows) the helper compensates
    // with an lstat/open/fstat identity check instead of collapsing to a
    // plain open that follows symlinks (#8227).
    const handle = await openNoFollow(realPath);
    try {
      if (!isSameFile(preOpenStat, await handle.stat({ bigint: true }))) {
        return { status: 'missing', escaped: true };
      }
      // The identity fstat cannot be reused here: bigint stats return BigInt
      // fields and truncate mtimeMs, breaking the Number comparisons below.
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error('path is not a regular file');
      }
      const expectedMtimeMs =
        typeof expected?.mtimeMs === 'number' ? expected.mtimeMs : undefined;
      const expectedSha256 =
        typeof expected?.sha256 === 'string' ? expected.sha256 : undefined;
      const unchanged =
        expected?.sizeBytes === stat.size && expectedMtimeMs === stat.mtimeMs;
      const sizeChanged =
        expected?.sizeBytes !== undefined && expected.sizeBytes !== stat.size;
      if (sizeChanged) {
        return {
          status: 'changed',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      if (unchanged) {
        return {
          status: 'available',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      if (stat.size > MAX_WORKSPACE_HASH_BYTES) {
        return {
          status: expectedSha256 ? 'changed' : 'available',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      if (!options.hashContent) {
        return {
          status: expectedSha256 ? 'changed' : 'available',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      const sha256 = await hashFile(handle);
      if (expectedSha256 && sha256 !== expectedSha256) {
        return {
          status: 'changed',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      return {
        status: 'available',
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNoFollowSymlinkError(error)) {
      return { status: 'missing', escaped: true };
    }
    if (isUnverifiableIdentityError(error)) {
      // inode-0 volume: the file could not be proven identical to the one
      // the pre-open check saw. Fail closed like a missing artifact, but
      // do NOT flag a symlink escape we did not observe — the path passed
      // the containment check above (#8227 follow-up).
      return { status: 'missing' };
    }
    if (!isNotFoundError(error)) {
      throw error;
    }
    if (await danglingSymlinkEscapesWorkspace(absolutePath, realWorkspace)) {
      return { status: 'missing', escaped: true };
    }
    return { status: 'missing' };
  }
}

function isSameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function hashFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ start: 0 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function withWorkspaceContentHashMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
  workspaceStatus:
    | {
        status: DaemonSessionArtifactStatus;
        sha256?: string;
        mtimeMs?: number;
      }
    | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (workspaceStatus?.status !== 'available' || !workspaceStatus.sha256) {
    return metadata;
  }
  const next = {
    ...(metadata ?? {}),
    [WORKSPACE_CONTENT_SHA256_METADATA_KEY]: workspaceStatus.sha256,
    ...(workspaceStatus.mtimeMs !== undefined
      ? { [WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY]: workspaceStatus.mtimeMs }
      : {}),
  };
  return next;
}

function isWorkspaceContentChanged(
  artifact: StoredArtifact,
  status: {
    status: DaemonSessionArtifactStatus;
    sizeBytes?: number;
    sha256?: string;
  },
): boolean {
  if (status.status !== 'available') {
    return false;
  }
  const expectedSha256 =
    artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY];
  if (
    artifact.sizeBytes !== undefined &&
    status.sizeBytes !== undefined &&
    status.sizeBytes !== artifact.sizeBytes
  ) {
    return true;
  }
  return (
    typeof expectedSha256 === 'string' &&
    status.sha256 !== undefined &&
    status.sha256 !== expectedSha256
  );
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

function isPlainMetadataObject(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNoFollowSymlinkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return (error as { code?: unknown }).code === 'ELOOP';
}

function isOutsidePath(relative: string): boolean {
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
