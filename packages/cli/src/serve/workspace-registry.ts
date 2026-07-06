/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import type { DaemonWorkspaceService } from './workspace-service/types.js';

export interface WorkspaceRuntime {
  readonly workspaceCwd: string;
  readonly bridge: AcpSessionBridge;
  readonly workspaceService: DaemonWorkspaceService;
  readonly routeFileSystemFactory: WorkspaceFileSystemFactory;
  readonly clientMcpSenderRegistry: ClientMcpSenderRegistry;
}

export interface WorkspaceRegistry {
  readonly primary: WorkspaceRuntime;
  list(): readonly WorkspaceRuntime[];
  getByWorkspaceCwd(workspaceCwd: string): WorkspaceRuntime | undefined;
}

export function createSingleWorkspaceRegistry(
  runtime: WorkspaceRuntime,
): WorkspaceRegistry {
  const runtimes = Object.freeze([runtime]);
  return {
    primary: runtime,
    list: () => runtimes,
    getByWorkspaceCwd: (workspaceCwd) =>
      workspaceCwd === runtime.workspaceCwd ? runtime : undefined,
  };
}
