/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DaemonWorkspaceService facade factory.
 *
 * Public entry point that wires up all four sub-services (file, auth,
 * agents, memory) and exposes workspace-scoped methods: status queries,
 * tool toggle, init, and MCP server restart.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  SERVE_STATUS_EXT_METHODS,
  SERVE_CONTROL_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceSkillsStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleEnvStatus,
  createIdleAcpPreflightCells,
  type ServeWorkspacePreflightStatus,
} from '@qwen-code/acp-bridge/status';

import {
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitConflictError,
  WorkspaceInitRaceError,
} from '@qwen-code/acp-bridge/bridgeErrors';

import { createFileService } from './fileService.js';
import { createAuthService } from './authService.js';
import { createAgentsService } from './agentsService.js';
import { createMemoryService } from './memoryService.js';

import type {
  DaemonWorkspaceService,
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
  RestartMcpServerResult,
} from './types.js';

// Re-export types for consumers.
export type {
  DaemonWorkspaceService,
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
  RestartMcpServerResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `inputPath` until we find an ancestor that exists on disk,
 * then `realpath` it. Mirrors `canonicalizeExistingAncestor` in bridge.ts.
 */
async function canonicalizeExistingAncestor(
  inputPath: string,
): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * Construct an idle preflight envelope (no ACP child available).
 */
function createIdlePreflightStatus(
  workspaceCwd: string,
): ServeWorkspacePreflightStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: true,
    acpChannelLive: false,
    cells: createIdleAcpPreflightCells(),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaemonWorkspaceService(
  deps: DaemonWorkspaceServiceDeps,
): DaemonWorkspaceService {
  const {
    boundWorkspace,
    contextFilename,
    fsFactory,
    deviceFlowRegistry,
    subagentManager,
    persistDisabledTools,
    queryWorkspaceStatus,
    invokeWorkspaceCommand,
    publishWorkspaceEvent,
    knownClientIds,
  } = deps;

  // -- Sub-services --
  const file = createFileService({
    fsFactory,
    boundWorkspace,
  });

  const auth = createAuthService({
    registry: deviceFlowRegistry,
  });

  const agents = createAgentsService({
    subagentManager: subagentManager as import('@qwen-code/qwen-code-core').SubagentManager,
    boundWorkspace,
    publishWorkspaceEvent,
    knownClientIds,
  });

  const memory = createMemoryService({
    boundWorkspace,
    publishWorkspaceEvent,
    knownClientIds,
  });

  // -- Facade --
  return {
    file,
    auth,
    agents,
    memory,

    // -- Status queries (delegate to ACP child via queryWorkspaceStatus) --

    async getWorkspaceMcpStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcp,
        () => createIdleWorkspaceMcpStatus(boundWorkspace),
      );
    },

    async getWorkspaceSkillsStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace),
      );
    },

    async getWorkspaceProvidersStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace),
      );
    },

    async getWorkspaceEnvStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        'qwen/status/workspace/env',
        () => createIdleEnvStatus(boundWorkspace, false),
      );
    },

    async getWorkspacePreflightStatus(_ctx: WorkspaceRequestContext) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspacePreflight,
        () => createIdlePreflightStatus(boundWorkspace),
      );
    },

    // -- Mutations --

    async setWorkspaceToolEnabled(
      ctx: WorkspaceRequestContext,
      toolName: string,
      enabled: boolean,
    ) {
      await persistDisabledTools(boundWorkspace, toolName, enabled);
      publishWorkspaceEvent({
        type: 'tool_toggled',
        data: { toolName, enabled },
        originatorClientId: ctx.originatorClientId,
      });
      return { toolName, enabled };
    },

    async initWorkspace(
      ctx: WorkspaceRequestContext,
      opts: { force?: boolean },
    ) {
      // Resolve the context filename against the workspace root.
      const filename = contextFilename;
      const target = path.resolve(boundWorkspace, filename);

      // Textual boundary check: reject paths that escape the workspace.
      const withinWorkspace =
        target === boundWorkspace ||
        target.startsWith(boundWorkspace + path.sep);
      if (!withinWorkspace) {
        throw new WorkspaceInitPathEscapeError(filename, boundWorkspace);
      }

      // Symlink check on parent path: canonicalize and verify.
      const wsCanonical = await fs.realpath(boundWorkspace);
      const parentCanonical = await canonicalizeExistingAncestor(
        path.dirname(target),
      );
      const parentWithinWorkspace =
        parentCanonical === wsCanonical ||
        parentCanonical.startsWith(wsCanonical + path.sep);
      if (!parentWithinWorkspace) {
        throw new WorkspaceInitSymlinkError(
          target,
          'parent',
          `Configured workspace context filename ${JSON.stringify(filename)} ` +
            `has a parent path that resolves outside the bound workspace ` +
            `(parent canonicalizes to ${JSON.stringify(parentCanonical)}, ` +
            `workspace canonicalizes to ${JSON.stringify(wsCanonical)}). ` +
            `Refusing to write — replace any symlinked parent directory ` +
            `with a real directory before re-running init.`,
        );
      }

      // Symlink check on the target itself.
      try {
        const lst = await fs.lstat(target);
        if (lst.isSymbolicLink()) {
          throw new WorkspaceInitSymlinkError(
            target,
            'target',
            `Workspace context file ${JSON.stringify(target)} is a symlink. ` +
              `Refusing to follow it for write — replace the symlink with a ` +
              `regular file (or remove it) before re-running init.`,
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceInitSymlinkError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — target doesn't exist; fresh create is fine.
      }

      // Determine action based on existing file state.
      let action: 'created' | 'overwrote' | 'noop' = 'created';
      try {
        const existing = await fs.readFile(target, 'utf8');
        if (existing.trim().length > 0) {
          const existingSize = Buffer.byteLength(existing, 'utf8');
          if (opts.force !== true) {
            throw new WorkspaceInitConflictError(target, existingSize);
          }
          action = 'overwrote';
        } else {
          // Whitespace-only file: treat as noop.
          action = 'noop';
        }
      } catch (err) {
        if (err instanceof WorkspaceInitConflictError) throw err;
        const code = (err as { code?: unknown } | null | undefined)?.code;
        if (code !== 'ENOENT') throw err;
        // ENOENT — fall through to create.
      }

      // Write the file.
      if (action === 'created') {
        // Atomic exclusive create to close TOCTOU window.
        let fh: import('node:fs/promises').FileHandle;
        try {
          fh = await fs.open(target, 'wx');
        } catch (err) {
          const code = (err as { code?: unknown } | null | undefined)?.code;
          if (code === 'EEXIST') {
            throw new WorkspaceInitRaceError(
              target,
              'eexist',
              `Workspace context file ${JSON.stringify(target)} appeared ` +
                `between our absence check and the create — refusing to ` +
                `proceed (a regular file or symlink was just placed at the ` +
                `target path, and following it could escape the workspace).`,
            );
          }
          throw err;
        }
        try {
          await fh.writeFile('', 'utf8');
        } finally {
          await fh.close();
        }
      } else if (action === 'overwrote') {
        await fs.writeFile(target, '', 'utf8');
      }
      // action === 'noop' — no write needed.

      publishWorkspaceEvent({
        type: 'workspace_initialized',
        data: { path: target, action },
        originatorClientId: ctx.originatorClientId,
      });

      return { path: target, action };
    },

    async restartMcpServer(
      ctx: WorkspaceRequestContext,
      serverName: string,
      opts?: { entryIndex?: number },
    ) {
      const params: Record<string, unknown> = { serverName };
      if (opts?.entryIndex !== undefined) {
        params.entryIndex = opts.entryIndex;
      }
      const result = await invokeWorkspaceCommand<RestartMcpServerResult>(
        SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart,
        params,
      );
      publishWorkspaceEvent({
        type: 'mcp_server_restarted',
        data: { serverName, ...result },
        originatorClientId: ctx.originatorClientId,
      });
      return result;
    },
  };
}
