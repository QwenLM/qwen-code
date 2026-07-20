/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import type { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { DaemonWorkspaceService } from './workspace-service/types.js';

export interface WorkspaceRuntimeEnvMetadata {
  readonly mode: 'parent-process' | 'runtime-overlay';
  readonly overlayKeys: readonly string[];
  readonly effectiveEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly envFilePaths?: readonly string[];
  readonly envFileReadFailed?: boolean;
  readonly envFileReadFailures?: ReadonlyArray<{
    readonly path: string;
    readonly error: string;
  }>;
  readonly fallbackReason?: string;
}

export interface WorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  /** Optional presentation-only name. Workspace identity remains id/cwd. */
  displayName?: string;
  readonly primary: boolean;
  readonly trusted: boolean;
  /** Whether this runtime may be removed without restarting the daemon. */
  readonly removable?: boolean;
  /** Persistent registration ids that restore this runtime on daemon startup. */
  registrationIds?: string[];
  readonly env: WorkspaceRuntimeEnvMetadata;
  readonly bridge: AcpSessionBridge;
  readonly workspaceService: DaemonWorkspaceService;
  readonly routeFileSystemFactory: WorkspaceFileSystemFactory;
  readonly clientMcpSenderRegistry: ClientMcpSenderRegistry;
  readonly generationGuard?: WorkspaceGenerationGuard;
  readonly trustMaterialization?: string;
}

export type WorkspaceEntryState =
  | 'active'
  | 'draining'
  | 'transitioning'
  | 'blocked'
  | 'removed';

export class WorkspaceGenerationClosedError extends Error {
  readonly code = 'workspace_generation_closed';

  constructor(message = 'Workspace runtime generation is no longer active.') {
    super(message);
    this.name = 'WorkspaceGenerationClosedError';
  }
}

export interface WorkspaceGenerationGuard {
  readonly closed: boolean;
  assertOpen(): void;
  close(): void;
}

export function createWorkspaceGenerationGuard(): WorkspaceGenerationGuard {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    assertOpen() {
      if (closed) throw new WorkspaceGenerationClosedError();
    },
    close() {
      closed = true;
    },
  };
}

export interface WorkspaceRuntimeGeneration {
  readonly generationId: number;
  readonly policyRevision: string;
  readonly runtime: WorkspaceRuntime;
  readonly guard: WorkspaceGenerationGuard;
}

export interface WorkspaceEntry {
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly primary: boolean;
  readonly removable: boolean;
  readonly registrationIds: readonly string[];
  lastGenerationId: number;
  state: WorkspaceEntryState;
  current?: WorkspaceRuntimeGeneration;
  configuredRevision: string;
  appliedRevision: string | null;
  applyError?: string;
}

export type WorkspaceSessionOwnerResolution =
  | { readonly kind: 'found'; readonly runtime: WorkspaceRuntime }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'ambiguous';
      readonly runtimes: readonly WorkspaceRuntime[];
    };

export type WorkspaceSessionLifecycleEvent =
  | {
      readonly type: 'registered';
      readonly sessionId: string;
      readonly workspaceCwd: string;
    }
  | {
      readonly type: 'removed';
      readonly sessionId: string;
      readonly workspaceCwd: string;
    };

export interface WorkspaceSessionOwnerIndex {
  register(sessionId: string, workspaceCwd: string): void;
  remove(sessionId: string, workspaceCwd?: string): void;
  getWorkspaceCwds(sessionId: string): readonly string[];
  removeWorkspace(workspaceCwd: string): void;
  handleBridgeSessionLifecycle(event: WorkspaceSessionLifecycleEvent): void;
}

export interface WorkspaceRegistry {
  readonly primary: WorkspaceRuntime;
  readonly primaryEntry: WorkspaceEntry;
  list(): readonly WorkspaceRuntime[];
  listEntries(): readonly WorkspaceEntry[];
  getEntryByWorkspaceCwd(workspaceCwd: string): WorkspaceEntry | undefined;
  getEntryByWorkspaceId(workspaceId: string): WorkspaceEntry | undefined;
  beginReplacement(entry: WorkspaceEntry, configuredRevision: string): boolean;
  activateReplacement(
    entry: WorkspaceEntry,
    runtime: WorkspaceRuntime,
    policyRevision: string,
  ): WorkspaceRuntimeGeneration;
  advancePolicyRevision(entry: WorkspaceEntry, policyRevision: string): void;
  blockReplacement(entry: WorkspaceEntry, error: string): void;
  getByWorkspaceCwd(workspaceCwd: string): WorkspaceRuntime | undefined;
  getByWorkspaceId(workspaceId: string): WorkspaceRuntime | undefined;
  resolveWorkspaceCwd(
    workspaceCwd: string | undefined,
  ): WorkspaceRuntime | undefined;
  resolveLiveSessionOwner(sessionId: string): WorkspaceSessionOwnerResolution;
  add(runtime: WorkspaceRuntime): void;
  listManaged(): readonly WorkspaceRuntime[];
  getManagedByWorkspaceCwd(workspaceCwd: string): WorkspaceRuntime | undefined;
  getManagedByWorkspaceId(workspaceId: string): WorkspaceRuntime | undefined;
  beginDrain(runtime: WorkspaceRuntime): boolean;
  cancelDrain(runtime: WorkspaceRuntime): void;
  commitDrain(runtime: WorkspaceRuntime): void;
  completeDrain(runtime: WorkspaceRuntime): void;
}

export interface WorkspaceRegistryOptions {
  readonly sessionOwnerIndex?: WorkspaceSessionOwnerIndex;
  readonly scanUnindexedOwners?: boolean;
}

export function createWorkspaceSessionOwnerIndex(): WorkspaceSessionOwnerIndex {
  const bySessionId = new Map<string, Set<string>>();

  const register = (sessionId: string, workspaceCwd: string): void => {
    let owners = bySessionId.get(sessionId);
    if (!owners) {
      owners = new Set<string>();
      bySessionId.set(sessionId, owners);
    }
    owners.add(workspaceCwd);
  };

  const remove = (sessionId: string, workspaceCwd?: string): void => {
    if (workspaceCwd === undefined) {
      bySessionId.delete(sessionId);
      return;
    }
    const owners = bySessionId.get(sessionId);
    if (!owners) return;
    owners.delete(workspaceCwd);
    if (owners.size === 0) {
      bySessionId.delete(sessionId);
    }
  };

  return {
    register,
    remove,
    getWorkspaceCwds: (sessionId) => [...(bySessionId.get(sessionId) ?? [])],
    removeWorkspace: (workspaceCwd) => {
      for (const [sessionId, owners] of bySessionId) {
        owners.delete(workspaceCwd);
        if (owners.size === 0) bySessionId.delete(sessionId);
      }
    },
    handleBridgeSessionLifecycle: (event) => {
      if (event.type === 'registered') {
        register(event.sessionId, event.workspaceCwd);
      } else {
        remove(event.sessionId, event.workspaceCwd);
      }
    },
  };
}

export function createWorkspaceRegistry(
  inputRuntimes: readonly WorkspaceRuntime[],
  options: WorkspaceRegistryOptions = {},
): WorkspaceRegistry {
  if (inputRuntimes.length === 0) {
    throw new Error(
      'WorkspaceRegistry requires at least one workspace runtime.',
    );
  }

  const primaryRuntimes = inputRuntimes.filter((runtime) => runtime.primary);
  if (primaryRuntimes.length !== 1) {
    throw new Error(
      'WorkspaceRegistry requires exactly one primary workspace runtime.',
    );
  }

  const byCwd = new Map<string, WorkspaceEntry>();
  const byId = new Map<string, WorkspaceEntry>();
  const createEntry = (
    runtime: WorkspaceRuntime,
    generationId: number,
  ): WorkspaceEntry => ({
    workspaceId: runtime.workspaceId,
    workspaceCwd: runtime.workspaceCwd,
    primary: runtime.primary,
    removable: runtime.removable === true,
    registrationIds: Object.freeze([...(runtime.registrationIds ?? [])]),
    lastGenerationId: generationId,
    state: 'active',
    current: {
      generationId,
      policyRevision: 'boot',
      runtime,
      guard: runtime.generationGuard ?? createWorkspaceGenerationGuard(),
    },
    configuredRevision: 'boot',
    appliedRevision: 'boot',
  });
  const entries: WorkspaceEntry[] = [];
  for (const runtime of inputRuntimes) {
    if (byCwd.has(runtime.workspaceCwd)) {
      throw new Error(
        `Duplicate workspace runtime cwd ${JSON.stringify(
          runtime.workspaceCwd,
        )}.`,
      );
    }
    const entry = createEntry(runtime, 1);
    byCwd.set(runtime.workspaceCwd, entry);

    if (byId.has(runtime.workspaceId)) {
      throw new Error(
        `Duplicate workspace runtime id ${JSON.stringify(
          runtime.workspaceId,
        )}.`,
      );
    }
    byId.set(runtime.workspaceId, entry);
    entries.push(entry);
  }

  const primaryEntry = entries.find((entry) => entry.primary)!;
  const entryForRuntime = (
    runtime: WorkspaceRuntime,
  ): WorkspaceEntry | undefined => {
    const entry = byId.get(runtime.workspaceId);
    return entry?.current?.runtime === runtime ? entry : undefined;
  };
  const activeRuntime = (entry: WorkspaceEntry | undefined) =>
    entry?.state === 'active' ? entry.current?.runtime : undefined;
  const requirePrimaryRuntime = (): WorkspaceRuntime => {
    const runtime =
      primaryEntry.state === 'active'
        ? primaryEntry.current?.runtime
        : undefined;
    if (!runtime) {
      throw new WorkspaceGenerationClosedError(
        'Primary workspace runtime is unavailable.',
      );
    }
    return runtime;
  };
  const sessionOwnerIndex = options.sessionOwnerIndex;
  const scanLiveOwners = (
    sessionId: string,
  ): WorkspaceSessionOwnerResolution => {
    const matches: WorkspaceRuntime[] = [];
    for (const entry of entries) {
      const runtime = activeRuntime(entry);
      if (!runtime) continue;
      try {
        runtime.bridge.getSessionSummary(sessionId);
        matches.push(runtime);
      } catch (err) {
        if (err instanceof SessionNotFoundError) continue;
        throw err;
      }
    }
    for (const match of matches) {
      sessionOwnerIndex?.register(sessionId, match.workspaceCwd);
    }
    if (matches.length === 0) return { kind: 'not_found' };
    if (matches.length === 1) {
      return { kind: 'found', runtime: matches[0]! };
    }
    return { kind: 'ambiguous', runtimes: matches };
  };
  return {
    get primary() {
      return requirePrimaryRuntime();
    },
    primaryEntry,
    // Return a frozen snapshot: `runtimes` is mutable internally (see `add`),
    // but callers must not be able to push/splice into the registry's state.
    list: () =>
      Object.freeze(
        entries.flatMap((entry) => {
          const runtime = activeRuntime(entry);
          return runtime ? [runtime] : [];
        }),
      ) as readonly WorkspaceRuntime[],
    listEntries: () =>
      Object.freeze(
        entries.filter((entry) => entry.state !== 'removed'),
      ) as readonly WorkspaceEntry[],
    listManaged: () =>
      Object.freeze(
        entries.flatMap((entry) =>
          entry.current?.runtime ? [entry.current.runtime] : [],
        ),
      ) as readonly WorkspaceRuntime[],
    getEntryByWorkspaceCwd: (workspaceCwd) => byCwd.get(workspaceCwd),
    getEntryByWorkspaceId: (workspaceId) => byId.get(workspaceId),
    beginReplacement: (entry, configuredRevision) => {
      if (entry.state === 'blocked') {
        entry.configuredRevision = configuredRevision;
        entry.state = 'transitioning';
        entry.current?.guard.close();
        sessionOwnerIndex?.removeWorkspace(entry.workspaceCwd);
        delete entry.applyError;
        return true;
      }
      if (entry.state !== 'active' || !entry.current) return false;
      entry.configuredRevision = configuredRevision;
      entry.state = 'transitioning';
      entry.current.guard.close();
      sessionOwnerIndex?.removeWorkspace(entry.workspaceCwd);
      delete entry.applyError;
      return true;
    },
    activateReplacement: (entry, runtime, policyRevision) => {
      if (entry.state !== 'transitioning') {
        throw new Error(
          'Replacement runtime can only activate a transitioning entry.',
        );
      }
      if (
        runtime.workspaceId !== entry.workspaceId ||
        runtime.workspaceCwd !== entry.workspaceCwd ||
        runtime.primary !== entry.primary
      ) {
        throw new Error('Replacement runtime identity does not match entry.');
      }
      const generationId = entry.lastGenerationId + 1;
      const generation: WorkspaceRuntimeGeneration = {
        generationId,
        policyRevision,
        runtime,
        guard: runtime.generationGuard ?? createWorkspaceGenerationGuard(),
      };
      entry.lastGenerationId = generationId;
      entry.current = generation;
      entry.configuredRevision = policyRevision;
      entry.appliedRevision = policyRevision;
      entry.state = 'active';
      delete entry.applyError;
      return generation;
    },
    advancePolicyRevision: (entry, policyRevision) => {
      entry.configuredRevision = policyRevision;
      entry.appliedRevision = policyRevision;
      if (entry.current) {
        entry.current = { ...entry.current, policyRevision };
      }
      delete entry.applyError;
    },
    blockReplacement: (entry, error) => {
      entry.current?.guard.close();
      entry.state = 'blocked';
      entry.appliedRevision = null;
      entry.applyError = error;
    },
    getByWorkspaceCwd: (workspaceCwd) => activeRuntime(byCwd.get(workspaceCwd)),
    getByWorkspaceId: (workspaceId) => activeRuntime(byId.get(workspaceId)),
    getManagedByWorkspaceCwd: (workspaceCwd) =>
      byCwd.get(workspaceCwd)?.current?.runtime,
    getManagedByWorkspaceId: (workspaceId) =>
      byId.get(workspaceId)?.current?.runtime,
    resolveWorkspaceCwd: (workspaceCwd) =>
      workspaceCwd === undefined
        ? activeRuntime(primaryEntry)
        : activeRuntime(byCwd.get(workspaceCwd)),
    add: (runtime) => {
      if (byCwd.has(runtime.workspaceCwd)) {
        throw new Error(
          `Duplicate workspace runtime cwd ${JSON.stringify(runtime.workspaceCwd)}.`,
        );
      }
      if (byId.has(runtime.workspaceId)) {
        throw new Error(
          `Duplicate workspace runtime id ${JSON.stringify(runtime.workspaceId)}.`,
        );
      }
      const entry = createEntry(runtime, 1);
      byCwd.set(runtime.workspaceCwd, entry);
      byId.set(runtime.workspaceId, entry);
      entries.push(entry);
    },
    beginDrain: (runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== 'active') return false;
      entry.state = 'draining';
      return true;
    },
    cancelDrain: (runtime) => {
      const entry = entryForRuntime(runtime);
      if (entry?.state === 'draining' && entry.current?.guard.closed !== true) {
        entry.state = 'active';
      }
    },
    commitDrain: (runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== 'draining') return;
      entry.current?.guard.close();
      sessionOwnerIndex?.removeWorkspace(runtime.workspaceCwd);
    },
    completeDrain: (runtime) => {
      const entry = entryForRuntime(runtime);
      if (!entry || runtime.primary || entry.state !== 'draining') return;
      entry.state = 'removed';
      byCwd.delete(runtime.workspaceCwd);
      byId.delete(runtime.workspaceId);
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      sessionOwnerIndex?.removeWorkspace(runtime.workspaceCwd);
    },
    resolveLiveSessionOwner: (sessionId) => {
      const indexedCwds = sessionOwnerIndex?.getWorkspaceCwds(sessionId) ?? [];
      if (indexedCwds.length > 0) {
        const matches: WorkspaceRuntime[] = [];
        for (const workspaceCwd of indexedCwds) {
          const entry = byCwd.get(workspaceCwd);
          const runtime = entry?.current?.runtime;
          if (!entry || !runtime || entry.state === 'removed') {
            sessionOwnerIndex?.remove(sessionId, workspaceCwd);
            continue;
          }
          if (entry.state !== 'active') continue;
          try {
            runtime.bridge.getSessionSummary(sessionId);
            matches.push(runtime);
          } catch (err) {
            if (err instanceof SessionNotFoundError) {
              sessionOwnerIndex?.remove(sessionId, workspaceCwd);
              continue;
            }
            throw err;
          }
        }
        if (matches.length === 1) {
          return { kind: 'found', runtime: matches[0]! };
        }
        if (matches.length > 1) {
          return { kind: 'ambiguous', runtimes: matches };
        }
        return { kind: 'not_found' };
      }
      return options.scanUnindexedOwners !== false
        ? scanLiveOwners(sessionId)
        : { kind: 'not_found' };
    },
  };
}

export function createSingleWorkspaceRegistry(
  runtime: WorkspaceRuntime,
  options: WorkspaceRegistryOptions = {},
): WorkspaceRegistry {
  return createWorkspaceRegistry([runtime], options);
}
