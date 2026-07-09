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
import type { DeviceFlowRegistry } from './auth/device-flow.js';
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
  readonly primary: boolean;
  readonly trusted: boolean;
  readonly env: WorkspaceRuntimeEnvMetadata;
  readonly bridge: AcpSessionBridge;
  readonly workspaceService: DaemonWorkspaceService;
  readonly routeFileSystemFactory: WorkspaceFileSystemFactory;
  readonly clientMcpSenderRegistry: ClientMcpSenderRegistry;
  /**
   * Phase 4 (issue #6378): per-runtime OAuth device-flow registry. Optional so
   * existing single-workspace construction and tests are unaffected; populated
   * for non-primary runtimes so their ACP `auth/device_flow` calls target their
   * own bridge instead of the primary app-global registry.
   */
  readonly deviceFlowRegistry?: DeviceFlowRegistry;
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
}

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

  const runtimes = Object.freeze([...inputRuntimes]);
  const primary = primaryRuntimes[0]!;
  const sessionOwnerIndex = options.sessionOwnerIndex;
  const scanLiveOwners = (
    sessionId: string,
  ): WorkspaceSessionOwnerResolution => {
    const matches: WorkspaceRuntime[] = [];
    for (const runtime of runtimes) {
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
    list: () => runtimes,
    getByWorkspaceCwd: (workspaceCwd) => byCwd.get(workspaceCwd),
    getByWorkspaceId: (workspaceId) => byId.get(workspaceId),
    resolveWorkspaceCwd: (workspaceCwd) =>
      workspaceCwd === undefined ? primary : byCwd.get(workspaceCwd),
    resolveLiveSessionOwner: (sessionId) => {
      const indexedCwds = sessionOwnerIndex?.getWorkspaceCwds(sessionId) ?? [];
      if (indexedCwds.length > 0) {
        const matches: WorkspaceRuntime[] = [];
        for (const workspaceCwd of indexedCwds) {
          const runtime = byCwd.get(workspaceCwd);
          if (!runtime) {
            sessionOwnerIndex?.remove(sessionId, workspaceCwd);
            continue;
          }
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
