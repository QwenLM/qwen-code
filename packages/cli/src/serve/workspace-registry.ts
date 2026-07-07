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
  readonly envFileReadFailures?: readonly {
    readonly path: string;
    readonly error: string;
  }[];
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
}

export type WorkspaceSessionOwnerResolution =
  | { readonly kind: 'found'; readonly runtime: WorkspaceRuntime }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'ambiguous';
      readonly runtimes: readonly WorkspaceRuntime[];
    };

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

export function createWorkspaceRegistry(
  inputRuntimes: readonly WorkspaceRuntime[],
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
  return {
    primary,
    list: () => runtimes,
    getByWorkspaceCwd: (workspaceCwd) => byCwd.get(workspaceCwd),
    getByWorkspaceId: (workspaceId) => byId.get(workspaceId),
    resolveWorkspaceCwd: (workspaceCwd) =>
      workspaceCwd === undefined ? primary : byCwd.get(workspaceCwd),
    resolveLiveSessionOwner: (sessionId) => {
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
      if (matches.length === 0) return { kind: 'not_found' };
      if (matches.length === 1) {
        return { kind: 'found', runtime: matches[0]! };
      }
      return { kind: 'ambiguous', runtimes: matches };
    },
  };
}

export function createSingleWorkspaceRegistry(
  runtime: WorkspaceRuntime,
): WorkspaceRegistry {
  return createWorkspaceRegistry([runtime]);
}
