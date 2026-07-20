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
  list(): readonly WorkspaceRuntime[];
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
  completeDrain(runtime: WorkspaceRuntime): void;
}

type WorkspaceRuntimeState = 'active' | 'draining' | 'removed';

export interface WorkspaceRegistryOptions {
  readonly sessionOwnerIndex?: WorkspaceSessionOwnerIndex;
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

  const byCwd = new Map<string, WorkspaceRuntime>();
  const byId = new Map<string, WorkspaceRuntime>();
  for (const runtime of inputRuntimes) {
    if (byCwd.has(runtime.workspaceCwd)) {
      throw new Error(
        `Duplicate workspace runtime cwd ${JSON.stringify(
          runtime.workspaceCwd,
        )}.`,
      );
    }
    byCwd.set(runtime.workspaceCwd, runtime);

    if (byId.has(runtime.workspaceId)) {
      throw new Error(
        `Duplicate workspace runtime id ${JSON.stringify(
          runtime.workspaceId,
        )}.`,
      );
    }
    byId.set(runtime.workspaceId, runtime);
  }

  const runtimes: WorkspaceRuntime[] = [...inputRuntimes];
  const states = new WeakMap<WorkspaceRuntime, WorkspaceRuntimeState>(
    inputRuntimes.map((runtime) => [runtime, 'active']),
  );
  const primary = primaryRuntimes[0]!;
  const sessionOwnerIndex = options.sessionOwnerIndex;
  const scanLiveOwners = (
    sessionId: string,
  ): WorkspaceSessionOwnerResolution => {
    const matches: WorkspaceRuntime[] = [];
    for (const runtime of runtimes) {
      if (states.get(runtime) !== 'active') continue;
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
    primary,
    // Return a frozen snapshot: `runtimes` is mutable internally (see `add`),
    // but callers must not be able to push/splice into the registry's state.
    list: () =>
      Object.freeze(
        runtimes.filter((runtime) => states.get(runtime) === 'active'),
      ) as readonly WorkspaceRuntime[],
    listManaged: () =>
      Object.freeze([...runtimes]) as readonly WorkspaceRuntime[],
    getByWorkspaceCwd: (workspaceCwd) => {
      const runtime = byCwd.get(workspaceCwd);
      return runtime && states.get(runtime) === 'active' ? runtime : undefined;
    },
    getByWorkspaceId: (workspaceId) => {
      const runtime = byId.get(workspaceId);
      return runtime && states.get(runtime) === 'active' ? runtime : undefined;
    },
    getManagedByWorkspaceCwd: (workspaceCwd) => byCwd.get(workspaceCwd),
    getManagedByWorkspaceId: (workspaceId) => byId.get(workspaceId),
    resolveWorkspaceCwd: (workspaceCwd) =>
      workspaceCwd === undefined
        ? primary
        : (() => {
            const runtime = byCwd.get(workspaceCwd);
            return runtime && states.get(runtime) === 'active'
              ? runtime
              : undefined;
          })(),
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
      byCwd.set(runtime.workspaceCwd, runtime);
      byId.set(runtime.workspaceId, runtime);
      runtimes.push(runtime);
      states.set(runtime, 'active');
    },
    beginDrain: (runtime) => {
      if (runtime.primary || states.get(runtime) !== 'active') return false;
      states.set(runtime, 'draining');
      return true;
    },
    cancelDrain: (runtime) => {
      if (states.get(runtime) === 'draining') states.set(runtime, 'active');
    },
    completeDrain: (runtime) => {
      if (runtime.primary || states.get(runtime) !== 'draining') return;
      states.set(runtime, 'removed');
      byCwd.delete(runtime.workspaceCwd);
      byId.delete(runtime.workspaceId);
      const index = runtimes.indexOf(runtime);
      if (index >= 0) runtimes.splice(index, 1);
      sessionOwnerIndex?.removeWorkspace(runtime.workspaceCwd);
    },
    resolveLiveSessionOwner: (sessionId) => {
      const indexedCwds = sessionOwnerIndex?.getWorkspaceCwds(sessionId) ?? [];
      if (indexedCwds.length > 0) {
        const matches: WorkspaceRuntime[] = [];
        for (const workspaceCwd of indexedCwds) {
          const runtime = byCwd.get(workspaceCwd);
          if (!runtime || states.get(runtime) === 'removed') {
            sessionOwnerIndex?.remove(sessionId, workspaceCwd);
            continue;
          }
          if (states.get(runtime) !== 'active') continue;
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
      }
      return scanLiveOwners(sessionId);
    },
  };
}

export function createSingleWorkspaceRegistry(
  runtime: WorkspaceRuntime,
  options: WorkspaceRegistryOptions = {},
): WorkspaceRegistry {
  return createWorkspaceRegistry([runtime], options);
}
