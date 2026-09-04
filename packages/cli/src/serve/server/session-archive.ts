/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionIdCaseConflictError,
  SessionService,
  SessionTranscriptChangedError,
  SessionWriterUnavailableError,
  type SessionLocation,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  SessionArchivedError,
  SessionArchivingError,
  SessionConflictError,
  SessionNotArchivedError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { safeLogValue } from './request-helpers.js';
import { normalizeSessionIdForLookup } from '../../config/session-id.js';
import {
  disableTasksForSessions,
  enableTasksForSessions,
  removeTasksForSessions,
} from '../scheduled-task-session-lifecycle.js';

export interface DaemonArchiveSessionsResult {
  archived: string[];
  alreadyArchived: string[];
  resolvedConflicts: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export interface DaemonUnarchiveSessionsResult {
  unarchived: string[];
  alreadyActive: string[];
  resolvedConflicts: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export interface DaemonDeleteSessionsResult {
  removed: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export type DaemonDeleteErrorPhase = 'close' | 'remove' | 'delete';

export class DaemonDrainingError extends Error {
  override readonly name = 'DaemonDrainingError';
  readonly code = 'daemon_draining';

  constructor() {
    super('The daemon is draining and no longer accepts session maintenance.');
  }
}

export class SessionArchiveCoordinator {
  private readonly exclusive = new Set<string>();
  private readonly shared = new Map<string, number>();
  private readonly sharedDrains = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private maintenanceSealed = false;
  private activeMaintenance = 0;
  private maintenanceDrain:
    | { promise: Promise<void>; resolve: () => void }
    | undefined;

  // Lock keys are canonicalized like every other session-id lookup: batch
  // delete/archive/unarchive lock raw caller spellings while restore locks
  // the request spelling, and on a case-insensitive filesystem both reach
  // the same transcript file — uncanonicalized keys would let a differently
  // cased caller id slip past a held guard and unlink it mid-restore.
  assertNotTransitioning(sessionId: string): void {
    if (this.exclusive.has(normalizeSessionIdForLookup(sessionId))) {
      throw new SessionArchivingError(sessionId);
    }
  }

  async runExclusiveMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const uniqueSessionIds = [
      ...new Set(sessionIds.map(normalizeSessionIdForLookup)),
    ];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
      if ((this.shared.get(sessionId) ?? 0) > 0) {
        throw new SessionArchivingError(sessionId, 'shared');
      }
    }
    for (const sessionId of uniqueSessionIds) {
      this.exclusive.add(sessionId);
    }
    this.activeMaintenance++;
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        this.exclusive.delete(sessionId);
      }
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = undefined;
      }
    }
  }

  async runExclusiveAfterShared<T>(
    rawSessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const sessionId = normalizeSessionIdForLookup(rawSessionId);
    this.assertNotTransitioning(sessionId);
    this.exclusive.add(sessionId);
    this.activeMaintenance++;
    try {
      const sharedCount = this.shared.get(sessionId) ?? 0;
      if (sharedCount > 0) {
        let drain = this.sharedDrains.get(sessionId);
        if (!drain) {
          let resolve!: () => void;
          const promise = new Promise<void>((done) => {
            resolve = done;
          });
          drain = { promise, resolve };
          this.sharedDrains.set(sessionId, drain);
        }
        await drain.promise;
      }
      return await fn();
    } finally {
      this.sharedDrains.delete(sessionId);
      this.exclusive.delete(sessionId);
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = undefined;
      }
    }
  }

  sealMaintenanceAndWait(): Promise<void> {
    this.maintenanceSealed = true;
    if (this.activeMaintenance === 0) {
      return Promise.resolve();
    }
    if (!this.maintenanceDrain) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.maintenanceDrain = { promise, resolve };
    }
    return this.maintenanceDrain.promise;
  }

  async runSharedMany<T>(
    sessionIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const uniqueSessionIds = [
      ...new Set(sessionIds.map(normalizeSessionIdForLookup)),
    ];
    for (const sessionId of uniqueSessionIds) {
      this.assertNotTransitioning(sessionId);
    }
    for (const sessionId of uniqueSessionIds) {
      this.shared.set(sessionId, (this.shared.get(sessionId) ?? 0) + 1);
    }
    this.activeMaintenance++;
    try {
      return await fn();
    } finally {
      for (const sessionId of uniqueSessionIds) {
        const count = (this.shared.get(sessionId) ?? 1) - 1;
        if (count <= 0) {
          this.shared.delete(sessionId);
          this.sharedDrains.get(sessionId)?.resolve();
          this.sharedDrains.delete(sessionId);
        } else {
          this.shared.set(sessionId, count);
        }
      }
      this.activeMaintenance--;
      if (this.activeMaintenance === 0) {
        this.maintenanceDrain?.resolve();
        this.maintenanceDrain = undefined;
      }
    }
  }
}

type DaemonMaintenanceAction = 'delete' | 'archive' | 'unarchive';

interface LeaseMutationResult<T> {
  value?: T;
  mutationApplied: boolean;
  error?: unknown;
  maintenanceError?: unknown;
}

async function runWithDaemonWriterLease<T>(params: {
  action: DaemonMaintenanceAction;
  sessionId: string;
  service: SessionService;
  mutate: (
    assertOwnedAndUnchanged: () => Promise<void>,
    assertCleanupOwned: () => void,
  ) => Promise<{ value: T; mutationApplied: boolean }>;
  mutationAppliedAfterError: () => Promise<boolean>;
  afterMutationApplied: () => Promise<void>;
}): Promise<LeaseMutationResult<T>> {
  const {
    action,
    sessionId,
    service,
    mutate,
    mutationAppliedAfterError,
    afterMutationApplied,
  } = params;
  let lease;
  try {
    const leaseOptions = {
      processKind: 'daemon' as const,
      reclaimPolicy: 'never' as const,
      takeoverPolicy: 'certified' as const,
    };
    try {
      lease = await service.acquireSessionWriterLease(sessionId, leaseOptions);
    } catch (error) {
      if (
        !(error instanceof SessionWriterUnavailableError) &&
        !(error instanceof SessionTranscriptChangedError)
      ) {
        throw error;
      }
      lease = await service.acquireSessionMaintenanceLease(
        sessionId,
        leaseOptions,
      );
    }
  } catch (error) {
    return { mutationApplied: false, error };
  }

  let value: T | undefined;
  let mutationApplied = false;
  let mutationError: unknown;
  try {
    const mutation = await mutate(
      () => lease.assertOwnedAndUnchanged(),
      () => lease.assertCleanupOwned(),
    );
    value = mutation.value;
    mutationApplied = mutation.mutationApplied;
  } catch (error) {
    mutationError = error;
    try {
      mutationApplied = await mutationAppliedAfterError();
    } catch {
      mutationApplied = false;
    }
  }

  let maintenanceError: unknown;
  if (mutationApplied) {
    try {
      await afterMutationApplied();
    } catch (error) {
      maintenanceError = error;
      logSessionArchiveWarning(
        `scheduled task lifecycle update failed action=${action} workspace=${safeLogValue(
          service.getProjectRoot(),
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(error),
        )}`,
      );
    }
  }

  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }

  if (releaseError !== undefined) {
    logMaintenanceLeaseReleaseFailure({
      action,
      workspace: service.getProjectRoot(),
      sessionId,
      error: releaseError,
      mutationApplied,
    });
    if (mutationError !== undefined) {
      logSessionArchiveWarning(
        `session maintenance mutation also failed action=${action} workspace=${safeLogValue(
          service.getProjectRoot(),
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(mutationError),
        )}`,
      );
    }
    return { mutationApplied, error: releaseError, maintenanceError };
  }
  if (mutationError !== undefined) {
    return { mutationApplied, error: mutationError, maintenanceError };
  }
  return { value, mutationApplied, maintenanceError };
}

function logMaintenanceLeaseReleaseFailure(params: {
  action: DaemonMaintenanceAction;
  workspace: string;
  sessionId: string;
  error: unknown;
  mutationApplied: boolean;
}): void {
  const errorKind =
    typeof params.error === 'object' &&
    params.error !== null &&
    typeof (params.error as { errorKind?: unknown }).errorKind === 'string'
      ? (params.error as { errorKind: string }).errorKind
      : 'unknown';
  logSessionArchiveWarning(
    `session maintenance lease release failed action=${params.action} workspace=${safeLogValue(
      params.workspace,
    )} session=${safeLogValue(params.sessionId)} errorKind=${safeLogValue(
      errorKind,
    )} mutationApplied=${params.mutationApplied}`,
  );
}

async function classifySessionLocation(
  service: SessionService,
  sessionId: string,
): Promise<SessionLocation> {
  return service.getMaintainableSessionLocation(sessionId);
}

function sessionLocationError(sessionId: string): SessionConflictError {
  const error = new SessionConflictError(sessionId);
  error.message = `Session "${sessionId}" exists in both active and archived directories. Retry with resolveConflicts: true to keep one copy.`;
  return error;
}

function updateScheduledTaskForMaintenance(
  service: SessionService,
  sessionId: string,
  action: DaemonMaintenanceAction,
  assertCanMutate?: () => void,
): Promise<void> {
  if (action === 'archive') {
    return disableTasksForSessions(service.getProjectRoot(), [sessionId], {
      assertCanCommit: assertCanMutate,
    });
  }
  if (action === 'unarchive') {
    return enableTasksForSessions(
      service.getProjectRoot(),
      [sessionId],
      Date.now(),
      { assertCanCommit: assertCanMutate },
    );
  }
  return removeTasksForSessions(service.getProjectRoot(), [sessionId], {
    assertCanCommit: assertCanMutate,
  });
}

type DeleteOneResult = (
  | {
      kind: 'removed';
      mutationApplied: boolean;
    }
  | {
      kind: 'notFound';
      mutationApplied: boolean;
    }
  | {
      kind: 'error';
      error: unknown;
      mutationApplied: boolean;
    }
) & { maintenanceError?: unknown };

async function deletePersistedSessionWithLease(
  service: SessionService,
  sessionId: string,
  assertCanMutate?: () => void,
): Promise<DeleteOneResult> {
  const initialLocation = await classifySessionLocation(service, sessionId);
  if (initialLocation === undefined) {
    let maintenanceError: unknown;
    try {
      assertCanMutate?.();
      await updateScheduledTaskForMaintenance(
        service,
        sessionId,
        'delete',
        assertCanMutate,
      );
    } catch (error) {
      maintenanceError = error;
      logSessionArchiveWarning(
        `scheduled task lifecycle update failed action=delete workspace=${safeLogValue(
          service.getProjectRoot(),
        )} session=${safeLogValue(sessionId)} error=${safeLogValue(
          errorMessage(error),
        )}`,
      );
    }
    return {
      kind: 'notFound',
      mutationApplied: false,
      maintenanceError,
    };
  }

  const mutation = await runWithDaemonWriterLease({
    action: 'delete',
    sessionId,
    service,
    mutate: async (assertOwnedAndUnchanged, assertCleanupOwned) => {
      const lockedLocation = await classifySessionLocation(service, sessionId);
      if (lockedLocation === undefined) {
        return {
          value: 'notFound' as const,
          mutationApplied: false,
        };
      }
      const removed = await service.removeSession(sessionId, {
        assertStorageUnchanged: assertOwnedAndUnchanged,
        assertCanMutate,
        assertCleanupOwned,
      });
      return {
        value: removed ? ('removed' as const) : ('notFound' as const),
        mutationApplied: removed,
      };
    },
    mutationAppliedAfterError: async () =>
      (await classifySessionLocation(service, sessionId)) === undefined,
    afterMutationApplied: async () => {
      assertCanMutate?.();
      await updateScheduledTaskForMaintenance(
        service,
        sessionId,
        'delete',
        assertCanMutate,
      );
    },
  });
  if (mutation.error !== undefined) {
    return {
      kind: 'error',
      error: mutation.error,
      mutationApplied: mutation.mutationApplied,
      maintenanceError: mutation.maintenanceError,
    };
  }
  return {
    kind: mutation.value ?? 'notFound',
    mutationApplied: mutation.mutationApplied,
    maintenanceError: mutation.maintenanceError,
  };
}

export async function deleteDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  bridge: Pick<AcpSessionBridge, 'closeSession' | 'deleteSessionAttachments'>;
  coordinator: SessionArchiveCoordinator;
  coordinatorLockHeld?: boolean;
  assertCanMutate?: () => void;
  onError?: (entry: {
    phase: DaemonDeleteErrorPhase;
    sessionId: string;
    error: string;
  }) => void;
}): Promise<DaemonDeleteSessionsResult> {
  const {
    sessionIds,
    service,
    bridge,
    coordinator,
    coordinatorLockHeld = false,
    assertCanMutate,
    onError,
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup)),
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
          assertCanMutate?.();
          const removePersistedSession = async () => {
            const result = await deletePersistedSessionWithLease(
              service,
              sessionId,
              assertCanMutate,
            );
            if (result.kind === 'error') {
              onError?.({
                phase: 'remove',
                sessionId,
                error: errorMessage(result.error),
              });
              return result;
            }
            try {
              if (assertCanMutate) {
                await bridge.deleteSessionAttachments(sessionId, {
                  assertCanCommit: assertCanMutate,
                });
              } else {
                await bridge.deleteSessionAttachments(sessionId);
              }
              return result;
            } catch (error) {
              onError?.({
                phase: 'delete',
                sessionId,
                error: errorMessage(error),
              });
              return {
                kind: 'error' as const,
                error,
                mutationApplied: result.mutationApplied,
                maintenanceError: result.maintenanceError,
              };
            }
          };
          try {
            await bridge.closeSession(sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error)) {
              return await removePersistedSession();
            }
            onError?.({
              phase: 'close',
              sessionId,
              error: errorMessage(error),
            });
            return {
              kind: 'error' as const,
              error,
              mutationApplied: false,
            };
          }

          return await removePersistedSession();
        };
        return await (coordinatorLockHeld
          ? mutateSession()
          : coordinator.runExclusiveMany([sessionId], mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        onError?.({
          phase: 'delete',
          sessionId,
          error: errorMessage(error),
        });
        return {
          kind: 'error' as const,
          error,
          mutationApplied: false,
        };
      }
    }),
  );

  const removed: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i]!;
    const result = results[i]!;
    if (result.kind === 'removed') {
      removed.push(sessionId);
    } else if (result.kind === 'notFound') {
      notFound.push(sessionId);
    } else {
      errors.push({ sessionId, error: errorMessage(result.error) });
    }
    if (result.maintenanceError !== undefined) {
      errors.push({
        sessionId,
        error: 'Scheduled task lifecycle update failed.',
      });
    }
  }

  return { removed, notFound, errors };
}

export async function deleteDaemonSessionIfOrphan(params: {
  sessionId: string;
  service: SessionService;
  bridge: Pick<
    AcpSessionBridge,
    'killSession' | 'markSessionCatalogChanged' | 'deleteSessionAttachments'
  >;
  coordinator: SessionArchiveCoordinator;
}): Promise<boolean> {
  const { sessionId, service, bridge, coordinator } = params;
  coordinator.assertNotTransitioning(sessionId);
  const result = await coordinator.runExclusiveMany([sessionId], async () => {
    let killed = false;
    try {
      killed = await bridge.killSession(sessionId, {
        requireZeroAttaches: true,
      });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
      killed = true;
    }
    if (!killed) {
      return undefined;
    }
    const removal = await deletePersistedSessionWithLease(service, sessionId);
    if (removal.kind !== 'error') {
      // Mirror deleteDaemonSessions: a reaped orphan is never looked up
      // again, and close() on a persistent store deletes nothing — without
      // this the attachment bytes leak from both storage roots.
      await bridge.deleteSessionAttachments(sessionId);
    }
    return removal;
  });
  if (result === undefined) {
    return false;
  }
  if (result.kind === 'error') {
    throw result.error;
  }
  // The persisted removal succeeded. A live removal already advanced the
  // catalog revision through the lifecycle choke point; this conservative
  // extra mark covers the never-live orphan case and is protocol-permitted.
  bridge.markSessionCatalogChanged();
  return true;
}

export async function assertSessionLoadable(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
  options: { allowActiveConflict?: boolean } = {},
): Promise<SessionLocation> {
  const service = new SessionService(workspaceCwd, {
    runtimeBaseDir,
  });
  const location = await service.getSessionLocation(sessionId);
  if (location === 'archived') {
    throw new SessionArchivedError(sessionId);
  }
  if (location === 'conflict') {
    if (options.allowActiveConflict) {
      try {
        await service.findSessionIdIgnoringCase(sessionId);
      } catch (error) {
        if (
          error instanceof SessionIdCaseConflictError &&
          error.reason === 'case_conflict' &&
          error.candidateSessionId === sessionId
        ) {
          return 'active';
        }
        if (!(error instanceof SessionIdCaseConflictError)) throw error;
      }
    }
    throw new SessionConflictError(sessionId);
  }
  return location;
}

export async function resolveSessionIdForRestore(
  service: SessionService,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await service.findSessionIdIgnoringCase(sessionId);
  } catch (error) {
    if (error instanceof SessionIdCaseConflictError) {
      if (error.candidateSessionId === sessionId) return sessionId;
      throw new SessionConflictError(sessionId);
    }
    throw error;
  }
}

export async function assertSessionRestorable(
  workspaceCwd: string,
  sessionId: string,
  requestedSessionId: string,
  runtimeBaseDir?: string,
): Promise<SessionLocation> {
  const location = await new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionLocation(sessionId);
  if (location === 'archived') {
    throw new SessionArchivedError(sessionId);
  }
  if (location === 'conflict') {
    if (sessionId !== requestedSessionId) {
      throw new SessionConflictError(requestedSessionId);
    }
    return 'active';
  }
  return location;
}

export async function assertSessionArchived(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
): Promise<void> {
  const location = await new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionLocation(sessionId);
  if (location === 'active') {
    throw new SessionNotArchivedError(sessionId);
  }
  if (location === 'conflict') {
    throw new SessionConflictError(sessionId);
  }
  if (location === undefined) {
    throw new SessionNotFoundError(sessionId);
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  return (
    err instanceof SessionNotFoundError ||
    (err instanceof Error && err.name === 'SessionNotFoundError')
  );
}

function logSessionArchiveResult(
  action: 'archive' | 'unarchive',
  result: {
    requested: string[];
    changed: string[];
    already: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: unknown }>;
  },
): void {
  const changedLabel = action === 'archive' ? 'archived' : 'unarchived';
  const alreadyLabel =
    action === 'archive' ? 'alreadyArchived' : 'alreadyActive';
  const details = [
    `requested=${result.requested.length} requestedIds=${formatSessionIds(result.requested)}`,
    `${changedLabel}=${result.changed.length} ${changedLabel}Ids=${formatSessionIds(result.changed)}`,
    `${alreadyLabel}=${result.already.length} ${alreadyLabel}Ids=${formatSessionIds(result.already)}`,
    `notFound=${result.notFound.length} notFoundIds=${formatSessionIds(result.notFound)}`,
    `errors=${result.errors.length} errorIds=${formatSessionErrors(result.errors)}`,
  ].join(' ');
  writeStderrLine(`qwen serve: sessions ${action} result ${details}`);
}

function formatSessionIds(sessionIds: string[]): string {
  return `[${sessionIds.map((sessionId) => safeLogValue(sessionId)).join(',')}]`;
}

function formatSessionErrors(
  errors: Array<{ sessionId: string; error: unknown }>,
): string {
  return `[${errors
    .map(
      ({ sessionId, error }) =>
        `${safeLogValue(sessionId)}:${safeLogValue(errorMessage(error))}`,
    )
    .join(',')}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logSessionArchiveWarning(message: string): void {
  writeStderrLine(`qwen serve: ${sanitizeLogLine(message)}`);
}

// Control characters are intentionally stripped from daemon log lines.
/* eslint-disable no-control-regex */
const LOG_LINE_UNSAFE_RE =
  /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

function sanitizeLogLine(message: string): string {
  return message.replace(LOG_LINE_UNSAFE_RE, ' ').slice(0, 4096);
}

export async function archiveDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  bridge: Pick<AcpSessionBridge, 'closeSession'>;
  coordinator: SessionArchiveCoordinator;
  coordinatorLockHeld?: boolean;
  resolveConflicts?: boolean;
  assertCanMutate?: () => void;
}): Promise<DaemonArchiveSessionsResult> {
  const {
    sessionIds,
    service,
    bridge,
    coordinator,
    coordinatorLockHeld = false,
    resolveConflicts = false,
    assertCanMutate,
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup)),
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
          assertCanMutate?.();
          try {
            await bridge.closeSession(sessionId, undefined, {
              requireAgentClose: true,
            });
          } catch (error) {
            if (!isSessionNotFoundError(error)) {
              return {
                kind: 'error' as const,
                error,
                mutationApplied: false,
              };
            }
          }

          const initialLocation = await classifySessionLocation(
            service,
            sessionId,
          );
          if (initialLocation === undefined) {
            return { kind: 'notFound' as const, mutationApplied: false };
          }
          if (initialLocation === 'conflict' && !resolveConflicts) {
            return {
              kind: 'error' as const,
              error: sessionLocationError(sessionId),
              mutationApplied: false,
            };
          }

          const mutation = await runWithDaemonWriterLease({
            action: 'archive',
            sessionId,
            service,
            mutate: async (assertOwnedAndUnchanged, assertCleanupOwned) => {
              const lockedLocation = await classifySessionLocation(
                service,
                sessionId,
              );
              if (lockedLocation === undefined) {
                return {
                  value: 'notFound' as const,
                  mutationApplied: false,
                };
              }
              if (lockedLocation === 'conflict' && !resolveConflicts) {
                throw sessionLocationError(sessionId);
              }
              const result = await service.archiveSessions([sessionId], {
                resolveConflicts,
                assertStorageUnchanged: assertOwnedAndUnchanged,
                assertCanMutate,
                assertCleanupOwned,
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.archived.length > 0) {
                return {
                  value: result.resolvedConflicts.length
                    ? ('resolvedConflict' as const)
                    : ('archived' as const),
                  mutationApplied: true,
                };
              }
              return {
                value:
                  result.alreadyArchived.length > 0
                    ? ('alreadyArchived' as const)
                    : ('notFound' as const),
                mutationApplied: false,
              };
            },
            mutationAppliedAfterError: async () =>
              (await classifySessionLocation(service, sessionId)) ===
              'archived',
            afterMutationApplied: async () => {
              assertCanMutate?.();
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'archive',
                assertCanMutate,
              );
            },
          });
          if (mutation.error !== undefined) {
            return {
              kind: 'error' as const,
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
              maintenanceError: mutation.maintenanceError,
            };
          }
          let maintenanceError = mutation.maintenanceError;
          if (mutation.value === 'alreadyArchived') {
            try {
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'archive',
                assertCanMutate,
              );
            } catch (error) {
              maintenanceError = error;
              logSessionArchiveWarning(
                `scheduled task lifecycle update failed action=archive workspace=${safeLogValue(
                  service.getProjectRoot(),
                )} session=${safeLogValue(sessionId)} error=${safeLogValue(
                  errorMessage(error),
                )}`,
              );
            }
          }
          return {
            kind: mutation.value ?? 'notFound',
            mutationApplied: mutation.mutationApplied,
            maintenanceError,
          };
        };
        return await (coordinatorLockHeld
          ? mutateSession()
          : coordinator.runExclusiveMany([sessionId], mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        return {
          kind: 'error' as const,
          error,
          mutationApplied: false,
          maintenanceError: undefined,
        };
      }
    }),
  );

  const archived: string[] = [];
  const alreadyArchived: string[] = [];
  const resolvedConflicts: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i]!;
    const result = results[i]!;
    if (result.kind === 'archived') archived.push(sessionId);
    else if (result.kind === 'resolvedConflict') {
      archived.push(sessionId);
      resolvedConflicts.push(sessionId);
    } else if (result.kind === 'alreadyArchived') {
      alreadyArchived.push(sessionId);
    } else if (result.kind === 'notFound') notFound.push(sessionId);
    else errors.push({ sessionId, error: result.error });
    if ('maintenanceError' in result && result.maintenanceError !== undefined) {
      errors.push({ sessionId, error: result.maintenanceError });
    }
  }

  logSessionArchiveResult('archive', {
    requested: uniqueSessionIds,
    changed: archived,
    already: alreadyArchived,
    notFound,
    errors,
  });

  return {
    archived,
    alreadyArchived,
    resolvedConflicts,
    notFound,
    errors,
  };
}

export async function unarchiveDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  coordinator: SessionArchiveCoordinator;
  coordinatorLockHeld?: boolean;
  resolveConflicts?: boolean;
  assertCanMutate?: () => void;
}): Promise<DaemonUnarchiveSessionsResult> {
  const {
    sessionIds,
    service,
    coordinator,
    coordinatorLockHeld = false,
    resolveConflicts = false,
    assertCanMutate,
  } = params;
  const uniqueSessionIds = [
    ...new Set(sessionIds.map(normalizeSessionIdForLookup)),
  ];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
          assertCanMutate?.();
          const initialLocation = await classifySessionLocation(
            service,
            sessionId,
          );
          if (initialLocation === undefined) {
            return { kind: 'notFound' as const, mutationApplied: false };
          }
          if (initialLocation === 'conflict' && !resolveConflicts) {
            return {
              kind: 'error' as const,
              error: sessionLocationError(sessionId),
              mutationApplied: false,
            };
          }

          const mutation = await runWithDaemonWriterLease({
            action: 'unarchive',
            sessionId,
            service,
            mutate: async (assertOwnedAndUnchanged, assertCleanupOwned) => {
              const lockedLocation = await classifySessionLocation(
                service,
                sessionId,
              );
              if (lockedLocation === undefined) {
                return {
                  value: 'notFound' as const,
                  mutationApplied: false,
                };
              }
              if (lockedLocation === 'conflict' && !resolveConflicts) {
                throw sessionLocationError(sessionId);
              }
              const result = await service.unarchiveSessions([sessionId], {
                resolveConflicts,
                assertStorageUnchanged: assertOwnedAndUnchanged,
                assertCanMutate,
                assertCleanupOwned,
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.unarchived.length > 0) {
                return {
                  value: result.resolvedConflicts.length
                    ? ('resolvedConflict' as const)
                    : ('unarchived' as const),
                  mutationApplied: true,
                };
              }
              return {
                value:
                  result.alreadyActive.length > 0
                    ? ('alreadyActive' as const)
                    : ('notFound' as const),
                mutationApplied: false,
              };
            },
            mutationAppliedAfterError: async () =>
              (await classifySessionLocation(service, sessionId)) === 'active',
            afterMutationApplied: async () => {
              assertCanMutate?.();
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'unarchive',
                assertCanMutate,
              );
            },
          });
          if (mutation.error !== undefined) {
            return {
              kind: 'error' as const,
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
              maintenanceError: mutation.maintenanceError,
            };
          }
          let maintenanceError = mutation.maintenanceError;
          if (mutation.value === 'alreadyActive') {
            try {
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'unarchive',
                assertCanMutate,
              );
            } catch (error) {
              maintenanceError = error;
              logSessionArchiveWarning(
                `scheduled task lifecycle update failed action=unarchive workspace=${safeLogValue(
                  service.getProjectRoot(),
                )} session=${safeLogValue(sessionId)} error=${safeLogValue(
                  errorMessage(error),
                )}`,
              );
            }
          }
          return {
            kind: mutation.value ?? 'notFound',
            mutationApplied: mutation.mutationApplied,
            maintenanceError,
          };
        };
        return await (coordinatorLockHeld
          ? mutateSession()
          : coordinator.runExclusiveMany([sessionId], mutateSession));
      } catch (error) {
        if (error instanceof DaemonDrainingError) {
          throw error;
        }
        return {
          kind: 'error' as const,
          error,
          mutationApplied: false,
          maintenanceError: undefined,
        };
      }
    }),
  );

  const unarchived: string[] = [];
  const alreadyActive: string[] = [];
  const resolvedConflicts: string[] = [];
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i]!;
    const result = results[i]!;
    if (result.kind === 'unarchived') unarchived.push(sessionId);
    else if (result.kind === 'resolvedConflict') {
      unarchived.push(sessionId);
      resolvedConflicts.push(sessionId);
    } else if (result.kind === 'alreadyActive') alreadyActive.push(sessionId);
    else if (result.kind === 'notFound') notFound.push(sessionId);
    else errors.push({ sessionId, error: result.error });
    if (result.maintenanceError !== undefined) {
      errors.push({ sessionId, error: result.maintenanceError });
    }
  }

  logSessionArchiveResult('unarchive', {
    requested: uniqueSessionIds,
    changed: unarchived,
    already: alreadyActive,
    notFound,
    errors,
  });

  return {
    unarchived,
    alreadyActive,
    resolvedConflicts,
    notFound,
    errors,
  };
}
