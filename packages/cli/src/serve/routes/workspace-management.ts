/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Application, Request, Response } from 'express';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { MAX_REGISTERED_WORKSPACES } from '../workspace-inputs.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { AcpHttpHandle } from '../acp-http/index.js';
import {
  isPortableAbsolutePath,
  resolveManagedWorkspaceRuntimeByPathSelector,
} from '../workspace-route-runtime.js';
import {
  normalizeWorkspaceDisplayName,
  workspaceRegistrationId,
  WorkspaceDisplayNameValidationError,
  WorkspaceRegistrationStoreCommittedError,
  WorkspaceRegistrationStoreLimitError,
  type WorkspaceRegistrationStore,
} from '../workspace-registration-store.js';

// Upper bound on total registered workspaces (startup + dynamic). Each
// registration allocates a full runtime (bridge, channel factory, sub-session
// launcher), so an unbounded POST /workspaces would let an authenticated
// client exhaust memory / file descriptors. Forgetting persistence does not
// unload an active runtime, so this remains the runtime backpressure.

// Cap on directory suggestions returned by GET /workspace-path-suggestions.
// Autocomplete only needs the first screenful; anything more is wasted
// readdir/stat work on huge directories.
const MAX_PATH_SUGGESTIONS = 50;

export interface WorkspaceManagementRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  createWorkspaceRuntime?: (cwd: string) => Promise<WorkspaceRuntime>;
  workspaceRegistrationStore?: WorkspaceRegistrationStore;
  getAcpHandle?: () => AcpHttpHandle | undefined;
  runtimeRemoval?: WorkspaceRuntimeRemovalController;
}

export interface WorkspaceRemovalActivity {
  sessions: number;
  activePrompts: number;
  pendingSessionStarts: number;
  acpConnections: number;
  memoryTasks: number;
  channelWorkers: number;
  voiceSessions: number;
}

export interface WorkspaceRuntimeRemovalController {
  runtimeAdded?(runtime: WorkspaceRuntime): Promise<void>;
  beginDrain(runtime: WorkspaceRuntime): void;
  cancelDrain(runtime: WorkspaceRuntime): void;
  completeDrain(runtime: WorkspaceRuntime): void;
  getActivity(runtime: WorkspaceRuntime): {
    pendingSessionStarts: number;
    channelWorkers: number;
    voiceSessions: number;
  };
  disposeRuntime(
    runtime: WorkspaceRuntime,
    reason?: 'daemon_shutdown' | 'workspace_removed',
  ): Promise<void>;
}

export interface WorkspaceManagementHandle {
  sealAndWait(): Promise<void>;
}

export function registerWorkspaceManagementRoutes(
  app: Application,
  deps: WorkspaceManagementRouteDeps,
): WorkspaceManagementHandle {
  const {
    workspaceRegistry,
    mutate,
    safeBody,
    createWorkspaceRuntime,
    workspaceRegistrationStore,
    getAcpHandle,
    runtimeRemoval,
  } = deps;
  // Serialize runtime addition, persistence promotion/forget, metadata updates,
  // and removal by canonical cwd so conflicting management mutations cannot
  // cross their validation and persistence commit points concurrently.
  const inFlight = new Map<
    string,
    'addition' | 'promotion' | 'removal' | 'forget' | 'metadata'
  >();
  let sealed = false;
  let activeOperations = 0;
  const idleWaiters = new Set<() => void>();
  const operationStarted = (): void => {
    activeOperations++;
  };
  const operationFinished = (): void => {
    activeOperations--;
    if (activeOperations !== 0) return;
    for (const resolveIdle of idleWaiters) resolveIdle();
    idleWaiters.clear();
  };
  const sendSealed = (res: Response): void => {
    res.status(503).json({
      error: 'Daemon is shutting down',
      code: 'daemon_shutting_down',
    });
  };
  const resolvesToCanonicalWorkspace = (
    workspace: string,
    canonical: string,
  ): boolean => {
    try {
      return realpathSync.native(resolve(workspace)) === canonical;
    } catch {
      return false;
    }
  };
  const persistDisplayName = async (
    store: WorkspaceRegistrationStore,
    registrationIds: readonly string[],
    displayName: string | undefined,
  ): Promise<void> => {
    try {
      await store.setDisplayNameByIds(registrationIds, displayName);
    } catch (err) {
      if (!(err instanceof WorkspaceRegistrationStoreCommittedError)) {
        throw err;
      }
      try {
        writeStderrLine(`qwen serve: ${err.message}`);
      } catch {
        // The display name update is committed; diagnostics are best-effort.
      }
    }
  };

  // Read-only directory suggestions for the "Add workspace" flow. The
  // existing `GET /list` route resolves paths through a registered
  // workspace's filesystem boundary, so it cannot browse a path that is
  // not yet a workspace. This route fills that gap with a deliberately
  // narrow surface: it reveals only the *names* of subdirectories (no
  // files, no contents, no stat details) at an absolute prefix, capped at
  // MAX_PATH_SUGGESTIONS entries. That is the same trust surface as
  // `POST /workspaces`, which already lets an authenticated client stat
  // and register any absolute directory path.
  app.get(
    '/workspace-path-suggestions',
    async (req: Request, res: Response) => {
      const prefixRaw = req.query['prefix'];
      if (typeof prefixRaw !== 'string' || prefixRaw.trim().length === 0) {
        res.status(400).json({
          error: '`prefix` must be a non-empty string',
          code: 'invalid_prefix',
        });
        return;
      }
      const prefix = prefixRaw;
      if (prefix.length > MAX_WORKSPACE_PATH_LENGTH) {
        res.status(400).json({
          error: `\`prefix\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
          code: 'invalid_prefix',
        });
        return;
      }
      if (!isAbsolute(prefix)) {
        res.status(400).json({
          error: '`prefix` must be an absolute path',
          code: 'invalid_prefix',
        });
        return;
      }
      // A prefix ending in a separator means "list inside this directory";
      // otherwise the final segment is an in-progress name used as a filter.
      const endsWithSep =
        prefix.endsWith('/') ||
        (process.platform === 'win32' && prefix.endsWith('\\'));
      // join(x, '.') normalizes away the trailing separator while leaving a
      // bare root ('/', 'C:\') intact.
      const dir = endsWithSep ? join(prefix, '.') : dirname(prefix);
      const filter = endsWithSep ? '' : basename(prefix);
      const filterLower = filter.toLowerCase();
      const suggestions: Array<{ name: string; path: string }> = [];
      let truncated = false;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          // Hidden directories only surface once the user explicitly starts
          // typing a dot — mirrors shell completion behavior.
          if (entry.name.startsWith('.') && !filter.startsWith('.')) continue;
          if (filter && !entry.name.toLowerCase().startsWith(filterLower)) {
            continue;
          }
          let isDir = entry.isDirectory();
          if (!isDir && entry.isSymbolicLink()) {
            try {
              isDir = (await stat(join(dir, entry.name))).isDirectory();
            } catch {
              continue; // broken symlink — not a navigable directory
            }
          }
          if (!isDir) continue;
          if (suggestions.length >= MAX_PATH_SUGGESTIONS) {
            truncated = true;
            break;
          }
          suggestions.push({ name: entry.name, path: join(dir, entry.name) });
        }
      } catch {
        // Nonexistent / unreadable directory: an empty suggestion list is the
        // correct autocomplete answer, not an error dialog.
      }
      res.status(200).json({
        kind: 'workspace-path-suggestions',
        dir,
        sep,
        suggestions,
        truncated,
      });
    },
  );

  app.post(
    '/workspaces',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const cwd = body['cwd'];
      const persist = body['persist'] ?? false;
      const hasDisplayName = Object.hasOwn(body, 'displayName');
      let displayName: string | undefined;
      if (hasDisplayName) {
        try {
          displayName = normalizeWorkspaceDisplayName(body['displayName']);
        } catch (err) {
          if (!(err instanceof WorkspaceDisplayNameValidationError)) throw err;
          res.status(400).json({
            error: err.message,
            code: 'invalid_display_name',
          });
          return;
        }
      }
      if (typeof cwd !== 'string' || cwd.trim().length === 0) {
        res.status(400).json({
          error: '`cwd` must be a non-empty string',
          code: 'invalid_path',
        });
        return;
      }
      if (typeof persist !== 'boolean') {
        res.status(400).json({
          error: '`persist` must be a boolean',
          code: 'invalid_persist_flag',
        });
        return;
      }
      if (persist && !workspaceRegistrationStore) {
        res.status(501).json({
          error: 'Persistent workspace registration is not available',
          code: 'persistence_not_available',
        });
        return;
      }
      if (!createWorkspaceRuntime && !persist) {
        res.status(501).json({
          error: 'Dynamic workspace registration is not available',
          code: 'not_implemented',
        });
        return;
      }

      if (!isAbsolute(cwd)) {
        res.status(400).json({
          error: '`cwd` must be an absolute path',
          code: 'invalid_path',
        });
        return;
      }

      // Bound the input before any filesystem work, matching the limit other
      // workspace routes enforce (memory-amplification guard).
      if (cwd.length > MAX_WORKSPACE_PATH_LENGTH) {
        res.status(400).json({
          error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
          code: 'invalid_path',
        });
        return;
      }

      // Canonicalize with the OS-native syscall, the same call startup
      // registration uses (canonicalizeWorkspace -> realpathSync.native). The
      // POSIX JS realpath() can differ on case-insensitive filesystems
      // (APFS/NTFS), which would let the same physical directory register under
      // two distinct canonical strings and defeat the duplicate check.
      let canonical: string;
      try {
        canonical = realpathSync.native(resolve(cwd));
      } catch {
        res.status(400).json({
          error: 'Path does not exist or is not accessible',
          code: 'invalid_path',
        });
        return;
      }

      if (sealed) {
        sendSealed(res);
        return;
      }

      try {
        const s = await stat(canonical);
        if (!s.isDirectory()) {
          res.status(400).json({
            error: 'Path is not a directory',
            code: 'invalid_path',
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: 'Path does not exist or is not accessible',
          code: 'invalid_path',
        });
        return;
      }

      // `stat` yields. Shutdown may seal management after the earlier fast
      // check, so re-check immediately before claiming the cwd operation.
      if (sealed) {
        sendSealed(res);
        return;
      }

      // The duplicate / in-flight / nesting checks and `inFlight.add` below run
      // synchronously (no `await` between them), so concurrent POSTs for the
      // same canonical cwd can't race past registration. Error messages stay
      // generic and never echo a resolved path (which could reveal symlink
      // targets or another workspace's location).
      const activeOperation = inFlight.get(canonical);
      if (activeOperation === 'removal') {
        res.status(409).json({
          error: 'Workspace removal is in progress',
          code: 'workspace_removal_in_progress',
        });
        return;
      }
      const existingRuntime =
        workspaceRegistry.getManagedByWorkspaceCwd(canonical);
      if (existingRuntime?.primary && persist) {
        res.status(400).json({
          error: 'Primary workspace cannot be persisted',
          code: 'invalid_persist_target',
        });
        return;
      }
      if (existingRuntime && persist && !existingRuntime.primary) {
        if (activeOperation) {
          res.status(409).json({
            error: 'Workspace registration is in progress',
            code: 'workspace_registration_in_progress',
          });
          return;
        }
        const nested = [
          ...workspaceRegistry
            .listManaged()
            .map((runtime) => runtime.workspaceCwd),
          ...[...inFlight].flatMap(([cwd, operation]) =>
            operation === 'addition' || operation === 'promotion' ? [cwd] : [],
          ),
        ].some(
          (boundCwd) =>
            boundCwd !== canonical &&
            (isWithinRoot(canonical, boundCwd) ||
              isWithinRoot(boundCwd, canonical)),
        );
        if (nested) {
          res.status(409).json({
            error: 'Workspace path nests with an existing workspace',
            code: 'workspace_nested',
          });
          return;
        }
        inFlight.set(canonical, 'promotion');
        operationStarted();
        try {
          const snapshot = await workspaceRegistrationStore!.read();
          const persistedRegistrationIds = snapshot.workspaces.flatMap(
            (stored) => {
              const registrationId = workspaceRegistrationId(stored);
              return existingRuntime.registrationIds?.includes(
                registrationId,
              ) === true || resolvesToCanonicalWorkspace(stored, canonical)
                ? [registrationId]
                : [];
            },
          );
          const alreadyPersisted = persistedRegistrationIds.length > 0;
          let displayNamePersistedByAdd = false;
          if (
            !alreadyPersisted &&
            snapshot.workspaces.length >= MAX_REGISTERED_WORKSPACES - 1
          ) {
            res.status(409).json({
              error: 'Workspace registration limit reached',
              code: 'workspace_limit_reached',
            });
            return;
          }
          if (!alreadyPersisted) {
            try {
              const persistedDisplayName = hasDisplayName
                ? displayName
                : existingRuntime.displayName;
              const added =
                persistedDisplayName === undefined
                  ? await workspaceRegistrationStore!.add(canonical)
                  : await workspaceRegistrationStore!.add(
                      canonical,
                      persistedDisplayName,
                    );
              displayNamePersistedByAdd =
                hasDisplayName && (displayName !== undefined || added);
            } catch (err) {
              if (!(err instanceof WorkspaceRegistrationStoreCommittedError)) {
                throw err;
              }
              displayNamePersistedByAdd = hasDisplayName;
              try {
                writeStderrLine(`qwen serve: ${err.message}`);
              } catch {
                // The registration is committed; diagnostics are best-effort.
              }
            }
            persistedRegistrationIds.push(workspaceRegistrationId(canonical));
          }
          if (hasDisplayName && !displayNamePersistedByAdd) {
            await persistDisplayName(
              workspaceRegistrationStore!,
              persistedRegistrationIds,
              displayName,
            );
          }
          existingRuntime.registrationIds ??= [];
          for (const registrationId of persistedRegistrationIds) {
            if (!existingRuntime.registrationIds.includes(registrationId)) {
              existingRuntime.registrationIds.push(registrationId);
            }
          }
          if (hasDisplayName) {
            if (displayName === undefined) {
              delete existingRuntime.displayName;
            } else {
              existingRuntime.displayName = displayName;
            }
          }
          res.status(200).json({
            id: existingRuntime.workspaceId,
            cwd: existingRuntime.workspaceCwd,
            ...(existingRuntime.displayName !== undefined
              ? { displayName: existingRuntime.displayName }
              : {}),
            primary: existingRuntime.primary,
            trusted: existingRuntime.trusted,
            persisted: true,
          });
        } catch (err) {
          if (err instanceof WorkspaceRegistrationStoreLimitError) {
            res.status(409).json({
              error: 'Workspace registration limit reached',
              code: 'workspace_limit_reached',
            });
            return;
          }
          writeStderrLine(
            `qwen serve: failed to persist existing workspace registration: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.status(500).json({
            error: 'Failed to persist workspace registration',
            code: 'workspace_registration_store_error',
          });
        } finally {
          inFlight.delete(canonical);
          operationFinished();
        }
        return;
      }
      if (existingRuntime || activeOperation) {
        res.status(409).json({
          error: 'Workspace already registered',
          code: 'workspace_exists',
        });
        return;
      }
      if (!createWorkspaceRuntime) {
        res.status(501).json({
          error: 'Dynamic workspace registration is not available',
          code: 'not_implemented',
        });
        return;
      }

      // Nesting guard checks registered workspaces AND in-flight registrations,
      // so two concurrent POSTs for parent/child paths (e.g. /project and
      // /project/sub) can't both pass while neither is in the registry yet.
      const boundCwds = [
        ...workspaceRegistry.listManaged().map((r) => r.workspaceCwd),
        ...[...inFlight].flatMap(([cwd, operation]) =>
          operation === 'addition' ? [cwd] : [],
        ),
      ];
      for (const existing of boundCwds) {
        if (
          existing !== canonical &&
          (isWithinRoot(canonical, existing) ||
            isWithinRoot(existing, canonical))
        ) {
          res.status(409).json({
            error: 'Workspace path nests with an existing workspace',
            code: 'workspace_nested',
          });
          return;
        }
      }

      const projectedWorkspaceCwds = new Set(
        workspaceRegistry.listManaged().map((runtime) => runtime.workspaceCwd),
      );
      for (const [cwd, operation] of inFlight) {
        if (operation === 'addition') projectedWorkspaceCwds.add(cwd);
      }
      if (projectedWorkspaceCwds.size >= MAX_REGISTERED_WORKSPACES) {
        res.status(409).json({
          error: 'Workspace registration limit reached',
          code: 'workspace_limit_reached',
        });
        return;
      }

      inFlight.set(canonical, 'addition');
      operationStarted();
      let persistenceFailed = false;
      try {
        const runtime = await createWorkspaceRuntime(canonical);
        if (!persist && displayName !== undefined) {
          runtime.displayName = displayName;
        }
        let persistedRecordAdded = false;
        try {
          if (persist) {
            try {
              const snapshot = await workspaceRegistrationStore!.read();
              const matchingRegistrationIds = snapshot.workspaces
                .filter((stored) =>
                  resolvesToCanonicalWorkspace(stored, canonical),
                )
                .map(workspaceRegistrationId);
              let effectiveDisplayName = displayName;
              if (matchingRegistrationIds.length === 0) {
                const registrationId = workspaceRegistrationId(canonical);
                try {
                  persistedRecordAdded =
                    displayName === undefined
                      ? await workspaceRegistrationStore!.add(canonical)
                      : await workspaceRegistrationStore!.add(
                          canonical,
                          displayName,
                        );
                } catch (err) {
                  if (
                    !(err instanceof WorkspaceRegistrationStoreCommittedError)
                  ) {
                    throw err;
                  }
                  persistedRecordAdded = true;
                  try {
                    writeStderrLine(`qwen serve: ${err.message}`);
                  } catch {
                    // The registration is committed; diagnostics are best-effort.
                  }
                }
                matchingRegistrationIds.push(registrationId);
                if (!persistedRecordAdded) {
                  if (hasDisplayName && displayName === undefined) {
                    await persistDisplayName(
                      workspaceRegistrationStore!,
                      [registrationId],
                      undefined,
                    );
                  } else if (!hasDisplayName) {
                    const latest = await workspaceRegistrationStore!.read();
                    effectiveDisplayName =
                      latest.displayNames?.[registrationId];
                  }
                }
              } else if (hasDisplayName) {
                await persistDisplayName(
                  workspaceRegistrationStore!,
                  matchingRegistrationIds,
                  displayName,
                );
              } else {
                effectiveDisplayName = matchingRegistrationIds
                  .map((id) => snapshot.displayNames?.[id])
                  .find((name) => name !== undefined);
              }
              runtime.registrationIds ??= [];
              runtime.registrationIds.push(...matchingRegistrationIds);
              if (effectiveDisplayName === undefined) {
                delete runtime.displayName;
              } else {
                runtime.displayName = effectiveDisplayName;
              }
            } catch (err) {
              persistenceFailed = true;
              throw err;
            }
          }
          workspaceRegistry.add(runtime);
          try {
            await runtimeRemoval?.runtimeAdded?.(runtime);
          } catch (err) {
            try {
              writeStderrLine(
                `qwen serve: workspace runtime adapter notification failed after registry add: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            } catch {
              // The runtime is registered; diagnostics are best-effort.
            }
          }
        } catch (err) {
          if (persistedRecordAdded) {
            try {
              await workspaceRegistrationStore!.removeById(
                workspaceRegistrationId(canonical),
              );
            } catch (rollbackErr) {
              writeStderrLine(
                `qwen serve: failed to roll back workspace persistence after runtime registration failure: ${
                  rollbackErr instanceof Error
                    ? rollbackErr.message
                    : String(rollbackErr)
                }`,
              );
            }
          }
          if (runtimeRemoval) {
            await runtimeRemoval
              .disposeRuntime(runtime, 'workspace_removed')
              .catch(() => {
                try {
                  runtime.bridge.killAllSync();
                } catch {
                  // Preserve the original registration failure.
                }
              });
          } else {
            await runtime.bridge.shutdown().catch(() => undefined);
          }
          throw err;
        }
        res.status(201).json({
          id: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          ...(runtime.displayName !== undefined
            ? { displayName: runtime.displayName }
            : {}),
          primary: runtime.primary,
          trusted: runtime.trusted,
          ...(persist ? { persisted: true } : {}),
        });
      } catch (err) {
        // Log the full error server-side but return a generic message so the
        // response can't leak internal filesystem paths / implementation detail.
        writeStderrLine(
          `qwen serve: POST /workspaces failed for ${canonical}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (persistenceFailed) {
          res.status(500).json({
            error: 'Failed to persist workspace registration',
            code: 'workspace_registration_store_error',
          });
        } else {
          res.status(500).json({
            error: 'Failed to register workspace',
            code: 'runtime_creation_failed',
          });
        }
      } finally {
        inFlight.delete(canonical);
        operationFinished();
      }
    },
  );

  const workspaceActivity = (
    runtime: WorkspaceRuntime,
  ): WorkspaceRemovalActivity => {
    const controllerActivity = runtimeRemoval?.getActivity(runtime) ?? {
      pendingSessionStarts: 0,
      channelWorkers: 0,
      voiceSessions: 0,
    };
    const acpActivity = getAcpHandle?.()?.getWorkspaceActivity(
      runtime.workspaceId,
    ) ?? { acpConnections: 0, memoryTasks: 0 };
    return {
      pendingSessionStarts: controllerActivity.pendingSessionStarts,
      sessions: runtime.bridge.sessionCount,
      activePrompts: runtime.bridge.activePromptCount,
      acpConnections: acpActivity.acpConnections,
      memoryTasks: acpActivity.memoryTasks,
      channelWorkers: controllerActivity.channelWorkers,
      voiceSessions: controllerActivity.voiceSessions,
    };
  };
  const isBusy = (activity: WorkspaceRemovalActivity): boolean =>
    Object.values(activity).some((count) => count > 0);
  const resolveManagedRuntime = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const selector = String(req.params['workspace'] ?? '');
    const byId = workspaceRegistry.getManagedByWorkspaceId(selector);
    if (byId) return byId;
    if (!isPortableAbsolutePath(selector)) {
      res.status(400).json({
        error: '`workspace` must decode to a workspace id or absolute path',
        code: 'workspace_mismatch',
      });
      return undefined;
    }
    const runtime = resolveManagedWorkspaceRuntimeByPathSelector(
      workspaceRegistry,
      selector,
    );
    if (runtime) return runtime;
    res.status(400).json({
      error:
        'Workspace mismatch: the requested workspace is not registered with this daemon.',
      code: 'workspace_mismatch',
    });
    return undefined;
  };

  app.patch(
    '/workspaces/:workspace',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      if (!Object.hasOwn(body, 'displayName')) {
        res.status(400).json({
          error: '`displayName` is required',
          code: 'invalid_display_name',
        });
        return;
      }
      let displayName: string | undefined;
      try {
        displayName =
          body['displayName'] === null
            ? undefined
            : normalizeWorkspaceDisplayName(body['displayName']);
      } catch (err) {
        if (!(err instanceof WorkspaceDisplayNameValidationError)) throw err;
        res.status(400).json({
          error: err.message,
          code: 'invalid_display_name',
        });
        return;
      }
      if (sealed) {
        sendSealed(res);
        return;
      }
      const runtime = resolveManagedRuntime(req, res);
      if (!runtime) return;
      const operation = inFlight.get(runtime.workspaceCwd);
      if (operation) {
        const removing = operation === 'removal';
        const updating = operation === 'metadata';
        res.status(409).json({
          error: removing
            ? 'Workspace removal is in progress'
            : updating
              ? 'Workspace display name update is in progress'
              : 'Workspace registration is in progress',
          code: removing
            ? 'workspace_removal_in_progress'
            : updating
              ? 'workspace_update_in_progress'
              : 'workspace_registration_in_progress',
        });
        return;
      }

      inFlight.set(runtime.workspaceCwd, 'metadata');
      operationStarted();
      try {
        if (
          workspaceRegistrationStore &&
          runtime.registrationIds !== undefined &&
          runtime.registrationIds.length > 0
        ) {
          await persistDisplayName(
            workspaceRegistrationStore,
            runtime.registrationIds,
            displayName,
          );
        }
        if (displayName === undefined) {
          delete runtime.displayName;
        } else {
          runtime.displayName = displayName;
        }
        res.status(200).json({
          id: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          ...(runtime.displayName !== undefined
            ? { displayName: runtime.displayName }
            : {}),
          primary: runtime.primary,
          trusted: runtime.trusted,
          ...(runtimeRemoval ? { removable: runtime.removable === true } : {}),
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: failed to persist workspace display name: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to persist workspace display name',
          code: 'workspace_registration_store_error',
        });
      } finally {
        inFlight.delete(runtime.workspaceCwd);
        operationFinished();
      }
    },
  );

  app.delete(
    '/workspaces/:workspace',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const force = body['force'];
      if (force !== undefined && typeof force !== 'boolean') {
        res.status(400).json({
          error: '`force` must be a boolean when provided',
          code: 'invalid_force_flag',
        });
        return;
      }
      if (sealed) {
        sendSealed(res);
        return;
      }
      const runtime = resolveManagedRuntime(req, res);
      if (!runtime) return;
      if (runtime.primary) {
        res.status(409).json({
          error: 'The primary workspace cannot be removed at runtime',
          code: 'primary_workspace_removal_forbidden',
        });
        return;
      }
      if (runtime.removable !== true) {
        res.status(409).json({
          error: 'Startup workspaces cannot be removed at runtime',
          code: 'static_workspace_removal_forbidden',
        });
        return;
      }
      if (!runtimeRemoval) {
        res.status(501).json({
          error: 'Workspace runtime removal is not available',
          code: 'workspace_runtime_removal_unsupported',
        });
        return;
      }

      const operation = inFlight.get(runtime.workspaceCwd);
      if (operation) {
        const removing = operation === 'removal';
        const updating = operation === 'metadata';
        res.status(409).json({
          error: removing
            ? 'Workspace removal is in progress'
            : updating
              ? 'Workspace display name update is in progress'
              : 'Workspace registration is in progress',
          code: removing
            ? 'workspace_removal_in_progress'
            : updating
              ? 'workspace_update_in_progress'
              : 'workspace_registration_in_progress',
        });
        return;
      }

      const initialActivity = workspaceActivity(runtime);
      if (force !== true && isBusy(initialActivity)) {
        res.status(409).json({
          error: 'Workspace has active runtime resources',
          code: 'workspace_busy',
          activity: initialActivity,
        });
        return;
      }

      inFlight.set(runtime.workspaceCwd, 'removal');
      operationStarted();
      let registryDraining = false;
      let controllerDraining = false;
      let acpDraining = false;
      const rollbackDrain = (): void => {
        if (acpDraining) {
          try {
            getAcpHandle?.()?.cancelWorkspaceDrain(runtime.workspaceId);
          } catch {
            // Continue rolling back the remaining gates.
          }
          acpDraining = false;
        }
        if (controllerDraining) {
          try {
            runtimeRemoval.cancelDrain(runtime);
          } catch {
            // Continue rolling back the remaining gates.
          }
          controllerDraining = false;
        }
        if (registryDraining) {
          try {
            workspaceRegistry.cancelDrain(runtime);
          } catch {
            // Every rollback gate has now been attempted.
          }
          registryDraining = false;
        }
      };
      const convergeCommittedRemoval = async (): Promise<void> => {
        const logCleanupFailure = (message: string): void => {
          try {
            writeStderrLine(message);
          } catch {
            // Cleanup must continue after the persistence commit point.
          }
        };
        try {
          getAcpHandle?.()?.commitWorkspaceRemoval(runtime.workspaceId);
        } catch (err) {
          logCleanupFailure(
            `qwen serve: failed to commit workspace ACP removal: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        await runtimeRemoval
          .disposeRuntime(runtime, 'workspace_removed')
          .catch((err) => {
            logCleanupFailure(
              `qwen serve: workspace runtime cleanup failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            try {
              runtime.bridge.killAllSync();
            } catch {
              // Logical removal must still converge after persistence commits.
            }
          });
        try {
          getAcpHandle?.()?.disposeWorkspace(runtime.workspaceId);
        } catch (err) {
          logCleanupFailure(
            `qwen serve: failed to dispose workspace ACP mount: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        try {
          runtimeRemoval.completeDrain(runtime);
        } catch (err) {
          logCleanupFailure(
            `qwen serve: failed to complete workspace admission drain: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        try {
          workspaceRegistry.completeDrain(runtime);
        } catch (err) {
          logCleanupFailure(
            `qwen serve: failed to complete workspace registry drain: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        registryDraining = false;
        controllerDraining = false;
        acpDraining = false;
      };

      try {
        registryDraining = workspaceRegistry.beginDrain(runtime);
        if (!registryDraining) {
          res.status(409).json({
            error: 'Workspace removal is in progress',
            code: 'workspace_removal_in_progress',
          });
          return;
        }
        runtimeRemoval.beginDrain(runtime);
        controllerDraining = true;
        getAcpHandle?.()?.beginWorkspaceDrain(runtime.workspaceId);
        acpDraining = true;

        const activity = workspaceActivity(runtime);
        if (force !== true && isBusy(activity)) {
          rollbackDrain();
          res.status(409).json({
            error: 'Workspace has active runtime resources',
            code: 'workspace_busy',
            activity,
          });
          return;
        }

        let persistedRegistrationRemoved = false;
        if (workspaceRegistrationStore) {
          try {
            const registrationIds = new Set([
              ...(runtime.registrationIds ?? []),
              workspaceRegistrationId(runtime.workspaceCwd),
            ]);
            try {
              persistedRegistrationRemoved =
                (await workspaceRegistrationStore.removeByIds([
                  ...registrationIds,
                ])) > 0;
            } catch (err) {
              if (!(err instanceof WorkspaceRegistrationStoreCommittedError)) {
                throw err;
              }
              persistedRegistrationRemoved = true;
              try {
                writeStderrLine(`qwen serve: ${err.message}`);
              } catch {
                // Persistence committed; diagnostics are best-effort.
              }
            }
          } catch (err) {
            rollbackDrain();
            writeStderrLine(
              `qwen serve: failed to remove workspace persistence: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            res.status(500).json({
              error: 'Failed to persist workspace removal',
              code: 'workspace_persist_failed',
            });
            return;
          }
        }

        // Persistence is the commit point. Every cleanup step after it is
        // best-effort and logical removal must never roll back to active.
        await convergeCommittedRemoval();

        res.status(200).json({
          removed: true,
          workspaceId: runtime.workspaceId,
          workspaceCwd: runtime.workspaceCwd,
          forced: force === true,
          persistedRegistrationRemoved,
          activity,
        });
      } catch (err) {
        rollbackDrain();
        writeStderrLine(
          `qwen serve: DELETE /workspaces/:workspace failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to remove workspace runtime',
            code: 'workspace_runtime_removal_failed',
          });
        }
      } finally {
        inFlight.delete(runtime.workspaceCwd);
        operationFinished();
      }
    },
  );

  const registrationIsActive = (registrationId: string): boolean =>
    workspaceRegistry.listManaged().some((runtime) => {
      if (workspaceRegistrationId(runtime.workspaceCwd) === registrationId) {
        return true;
      }
      return runtime.registrationIds?.includes(registrationId) === true;
    });

  app.get('/workspace-registrations', async (_req, res) => {
    if (!workspaceRegistrationStore) {
      res.status(501).json({
        error: 'Persistent workspace registration is not available',
        code: 'persistence_not_available',
      });
      return;
    }
    try {
      const snapshot = await workspaceRegistrationStore.read();
      res.json({
        schemaVersion: snapshot.schemaVersion,
        primaryWorkspace: snapshot.primaryWorkspace,
        entries: snapshot.workspaces.map((cwd) => {
          const registrationId = workspaceRegistrationId(cwd);
          const runtime = workspaceRegistry.getByWorkspaceCwd(cwd);
          return {
            id: registrationId,
            cwd,
            ...(snapshot.displayNames?.[registrationId] !== undefined
              ? { displayName: snapshot.displayNames[registrationId] }
              : {}),
            active:
              runtime !== undefined || registrationIsActive(registrationId),
            persisted: true,
          };
        }),
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: failed to read workspace registrations: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to read workspace registrations',
        code: 'workspace_registration_store_error',
      });
    }
  });

  app.delete(
    '/workspace-registrations/:id',
    mutate({ strict: true }),
    async (req, res) => {
      if (!workspaceRegistrationStore) {
        res.status(501).json({
          error: 'Persistent workspace registration is not available',
          code: 'persistence_not_available',
        });
        return;
      }
      if (sealed) {
        sendSealed(res);
        return;
      }
      operationStarted();
      let operationCwd: string | undefined;
      let ownsInFlight = false;
      try {
        const registrationId = String(req.params['id']);
        let runtime = workspaceRegistry
          .listManaged()
          .find(
            (candidate) =>
              workspaceRegistrationId(candidate.workspaceCwd) ===
                registrationId ||
              candidate.registrationIds?.includes(registrationId) === true,
          );
        operationCwd = runtime?.workspaceCwd;
        if (!operationCwd) {
          let storedCwd: string | undefined;
          try {
            const snapshot = await workspaceRegistrationStore.read();
            storedCwd = snapshot.workspaces.find(
              (workspace) =>
                workspaceRegistrationId(workspace) === registrationId,
            );
          } catch (err) {
            writeStderrLine(
              `qwen serve: failed to read workspace registration before forget: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            res.status(500).json({
              error: 'Failed to read workspace registration',
              code: 'workspace_registration_store_error',
            });
            return;
          }
          if (storedCwd) {
            try {
              operationCwd = realpathSync.native(resolve(storedCwd));
            } catch {
              operationCwd = resolve(storedCwd);
            }
          }
        }
        const operation = operationCwd ? inFlight.get(operationCwd) : undefined;
        if (operation) {
          const removing = operation === 'removal';
          const updating = operation === 'metadata';
          res.status(409).json({
            error: removing
              ? 'Workspace removal is in progress'
              : updating
                ? 'Workspace display name update is in progress'
                : 'Workspace registration is in progress',
            code: removing
              ? 'workspace_removal_in_progress'
              : updating
                ? 'workspace_update_in_progress'
                : 'workspace_registration_in_progress',
          });
          return;
        }
        if (operationCwd) {
          inFlight.set(operationCwd, 'forget');
          ownsInFlight = true;
        }
        runtime =
          (operationCwd
            ? workspaceRegistry.getManagedByWorkspaceCwd(operationCwd)
            : undefined) ?? runtime;
        const active = registrationIsActive(registrationId);
        let removed: boolean;
        try {
          removed = await workspaceRegistrationStore.removeById(registrationId);
        } catch (err) {
          if (!(err instanceof WorkspaceRegistrationStoreCommittedError)) {
            throw err;
          }
          removed = true;
          try {
            writeStderrLine(`qwen serve: ${err.message}`);
          } catch {
            // The forget committed; diagnostics are best-effort.
          }
        }
        if (!removed) {
          res.status(404).json({
            error: 'Workspace registration not found',
            code: 'workspace_registration_not_found',
          });
          return;
        }
        if (runtime?.registrationIds) {
          runtime.registrationIds = runtime.registrationIds.filter(
            (id) => id !== registrationId,
          );
        }
        res.json({
          removed: true,
          active,
          restartRequired: active && runtime?.removable === true,
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: failed to forget workspace registration: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to forget workspace registration',
          code: 'workspace_registration_store_error',
        });
      } finally {
        if (ownsInFlight && operationCwd) inFlight.delete(operationCwd);
        operationFinished();
      }
    },
  );

  return {
    async sealAndWait() {
      sealed = true;
      if (activeOperations === 0) return;
      await new Promise<void>((resolveIdle) => idleWaiters.add(resolveIdle));
    },
  };
}
