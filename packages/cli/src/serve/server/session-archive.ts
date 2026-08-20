/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
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
import {
  disableTasksForSessions,
  enableTasksForSessions,
  removeTasksForSessions,
} from '../scheduled-task-session-lifecycle.js';

export interface DaemonArchiveSessionsResult {
  archived: string[];
  alreadyArchived: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export interface DaemonUnarchiveSessionsResult {
  unarchived: string[];
  alreadyActive: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
}

export interface DaemonDeleteSessionsResult {
  removed: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: unknown }>;
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
  private maintenanceSealed = false;
  private activeMaintenance = 0;
  private maintenanceDrain:
    | { promise: Promise<void>; resolve: () => void }
    | undefined;

  assertNotTransitioning(sessionId: string): void {
    if (this.exclusive.has(sessionId)) {
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
    const uniqueSessionIds = [...new Set(sessionIds)];
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
    const uniqueSessionIds = [...new Set(sessionIds)];
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
    lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });
  } catch (error) {
    return { mutationApplied: false, error };
  }

  let value: T | undefined;
  let mutationApplied = false;
  let mutationError: unknown;
  try {
    const mutation = await mutate(() => lease.assertOwnedAndUnchanged());
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
  return service.getSessionLocation(sessionId);
}

function sessionLocationError(sessionId: string): Error {
  return new Error(`Session archive conflict: ${sessionId}`);
}

function updateScheduledTaskForMaintenance(
  service: SessionService,
  sessionId: string,
  action: DaemonMaintenanceAction,
): Promise<void> {
  if (action === 'archive') {
    return disableTasksForSessions(service.getProjectRoot(), [sessionId]);
  }
  if (action === 'unarchive') {
    return enableTasksForSessions(service.getProjectRoot(), [sessionId]);
  }
  return removeTasksForSessions(service.getProjectRoot(), [sessionId]);
}

type DeleteOneResult =
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
    };

async function deletePersistedSessionWithLease(
  service: SessionService,
  sessionId: string,
): Promise<DeleteOneResult> {
  const initialLocation = await classifySessionLocation(service, sessionId);
  if (initialLocation === undefined) {
    return { kind: 'notFound', mutationApplied: false };
  }
  if (initialLocation === 'conflict') {
    return {
      kind: 'error',
      error: sessionLocationError(sessionId),
      mutationApplied: false,
    };
  }

  const mutation = await runWithDaemonWriterLease({
    action: 'delete',
    sessionId,
    service,
    mutate: async (assertOwnedAndUnchanged) => {
      const lockedLocation = await classifySessionLocation(service, sessionId);
      if (lockedLocation === undefined) {
        return {
          value: 'notFound' as const,
          mutationApplied: false,
        };
      }
      if (lockedLocation === 'conflict') {
        throw sessionLocationError(sessionId);
      }
      await assertOwnedAndUnchanged();
      const removed = await service.removeSession(sessionId);
      return {
        value: removed ? ('removed' as const) : ('notFound' as const),
        mutationApplied: removed,
      };
    },
    mutationAppliedAfterError: async () =>
      (await classifySessionLocation(service, sessionId)) === undefined,
    afterMutationApplied: () =>
      updateScheduledTaskForMaintenance(service, sessionId, 'delete'),
  });
  if (mutation.error !== undefined) {
    return {
      kind: 'error',
      error: mutation.error,
      mutationApplied: mutation.mutationApplied,
    };
  }
  return {
    kind: mutation.value ?? 'notFound',
    mutationApplied: mutation.mutationApplied,
  };
}

export async function deleteDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  bridge: Pick<AcpSessionBridge, 'closeSession'>;
  coordinator: SessionArchiveCoordinator;
  coordinatorLockHeld?: boolean;
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
    onError,
  } = params;
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
          try {
            await bridge.closeSession(sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error)) {
              const result = await deletePersistedSessionWithLease(
                service,
                sessionId,
              );
              if (result.kind === 'error') {
                onError?.({
                  phase: 'remove',
                  sessionId,
                  error: errorMessage(result.error),
                });
              }
              return result;
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

          const result = await deletePersistedSessionWithLease(
            service,
            sessionId,
          );
          if (result.kind === 'error') {
            onError?.({
              phase: 'remove',
              sessionId,
              error: errorMessage(result.error),
            });
          }
          return result;
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
  const errors: Array<{ sessionId: string; error: unknown }> = [];
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
  }

  return { removed, notFound, errors };
}

export async function deleteDaemonSessionIfOrphan(params: {
  sessionId: string;
  service: SessionService;
  bridge: Pick<AcpSessionBridge, 'killSession' | 'markSessionCatalogChanged'>;
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
    return deletePersistedSessionWithLease(service, sessionId);
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
): Promise<SessionLocation> {
  const location = await new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionLocation(sessionId);
  if (location === 'archived') {
    throw new SessionArchivedError(sessionId);
  }
  if (location === 'conflict') {
    throw new SessionConflictError(sessionId);
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
}): Promise<DaemonArchiveSessionsResult> {
  const {
    sessionIds,
    service,
    bridge,
    coordinator,
    coordinatorLockHeld = false,
  } = params;
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
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
          if (initialLocation === 'archived') {
            return {
              kind: 'alreadyArchived' as const,
              mutationApplied: false,
            };
          }
          if (initialLocation === 'conflict') {
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
            mutate: async (assertOwnedAndUnchanged) => {
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
              if (lockedLocation === 'archived') {
                return {
                  value: 'alreadyArchived' as const,
                  mutationApplied: false,
                };
              }
              if (lockedLocation === 'conflict') {
                throw sessionLocationError(sessionId);
              }
              await assertOwnedAndUnchanged();
              const result = await service.archiveSessions([sessionId], {
                knownLocation: 'active',
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.archived.length > 0) {
                return {
                  value: 'archived' as const,
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
            afterMutationApplied: () =>
              updateScheduledTaskForMaintenance(service, sessionId, 'archive'),
          });
          if (mutation.error !== undefined) {
            return {
              kind: 'error' as const,
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
            };
          }
          return {
            kind: mutation.value ?? 'notFound',
            mutationApplied: mutation.mutationApplied,
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
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i]!;
    const result = results[i]!;
    if (result.kind === 'archived') archived.push(sessionId);
    else if (result.kind === 'alreadyArchived') {
      alreadyArchived.push(sessionId);
    } else if (result.kind === 'notFound') notFound.push(sessionId);
    else errors.push({ sessionId, error: result.error });
  }

  logSessionArchiveResult('archive', {
    requested: uniqueSessionIds,
    changed: archived,
    already: alreadyArchived,
    notFound,
    errors,
  });

  return { archived, alreadyArchived, notFound, errors };
}

export async function unarchiveDaemonSessions(params: {
  sessionIds: string[];
  service: SessionService;
  coordinator: SessionArchiveCoordinator;
  coordinatorLockHeld?: boolean;
}): Promise<DaemonUnarchiveSessionsResult> {
  const {
    sessionIds,
    service,
    coordinator,
    coordinatorLockHeld = false,
  } = params;
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (!coordinatorLockHeld) {
    for (const sessionId of uniqueSessionIds) {
      coordinator.assertNotTransitioning(sessionId);
    }
  }
  const results = await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      try {
        const mutateSession = async () => {
          const initialLocation = await classifySessionLocation(
            service,
            sessionId,
          );
          if (initialLocation === undefined) {
            return { kind: 'notFound' as const, mutationApplied: false };
          }
          if (initialLocation === 'active') {
            let maintenanceError: unknown;
            try {
              await updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'unarchive',
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
            return {
              kind: 'alreadyActive' as const,
              mutationApplied: false,
              maintenanceError,
            };
          }
          if (initialLocation === 'conflict') {
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
            mutate: async (assertOwnedAndUnchanged) => {
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
              if (lockedLocation === 'active') {
                return {
                  value: 'alreadyActive' as const,
                  mutationApplied: false,
                };
              }
              if (lockedLocation === 'conflict') {
                throw sessionLocationError(sessionId);
              }
              await assertOwnedAndUnchanged();
              const result = await service.unarchiveSessions([sessionId], {
                knownLocation: 'archived',
              });
              if (result.errors[0]) throw result.errors[0].error;
              if (result.unarchived.length > 0) {
                return {
                  value: 'unarchived' as const,
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
            afterMutationApplied: () =>
              updateScheduledTaskForMaintenance(
                service,
                sessionId,
                'unarchive',
              ),
          });
          if (mutation.error !== undefined) {
            return {
              kind: 'error' as const,
              error: mutation.error,
              mutationApplied: mutation.mutationApplied,
            };
          }
          return {
            kind: mutation.value ?? 'notFound',
            mutationApplied: mutation.mutationApplied,
            maintenanceError: mutation.maintenanceError,
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
  const notFound: string[] = [];
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  for (let i = 0; i < results.length; i++) {
    const sessionId = uniqueSessionIds[i]!;
    const result = results[i]!;
    if (result.kind === 'unarchived') unarchived.push(sessionId);
    else if (result.kind === 'alreadyActive') alreadyActive.push(sessionId);
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

  return { unarchived, alreadyActive, notFound, errors };
}
