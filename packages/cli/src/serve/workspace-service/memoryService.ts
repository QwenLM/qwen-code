/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryService — workspace memory (QWEN.md / AGENTS.md) read/write
 * operations with clientId validation and workspace event publishing.
 *
 * Delegates to `writeWorkspaceContextFile` for mutations and uses
 * filesystem-based discovery (same logic as `workspaceMemory.ts`
 * routes) for reads. Validates `originatorClientId` on write/delete
 * mutations against `deps.knownClientIds()`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  Storage,
  getAllGeminiMdFilenames,
  writeWorkspaceContextFile,
} from '@qwen-code/qwen-code-core';

import {
  createIdleWorkspaceMemoryStatus,
  type ServeWorkspaceMemoryFile,
  type ServeWorkspaceMemoryStatus,
  STATUS_SCHEMA_VERSION,
} from '@qwen-code/acp-bridge/status';

import type {
  MemoryService,
  WriteMemoryParams,
  WriteMemoryResult,
  WorkspaceRequestContext,
} from './types.js';

import { validateClientId as validateClientIdShared } from './validation.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface MemoryServiceDeps {
  /** Absolute path to the workspace root. */
  boundWorkspace: string;
  /** Publish a workspace-wide event to all sessions' SSE buses. */
  publishWorkspaceEvent: (event: {
    type: string;
    data: unknown;
    originatorClientId?: string;
  }) => void;
  /** Set of all currently known client ids across live sessions. */
  knownClientIds: () => ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { boundWorkspace, publishWorkspaceEvent, knownClientIds } = deps;

  function validateClientId(ctx: WorkspaceRequestContext): void {
    validateClientIdShared(ctx, knownClientIds);
  }

  /** Resolve the memory file path for a given scope key ('global' | 'workspace'). */
  function resolveMemoryFilePath(key: string): string {
    const filenames = getAllGeminiMdFilenames();
    const filename = filenames[0] ?? 'QWEN.md';
    if (key === 'global') {
      return path.join(Storage.getGlobalQwenDir(), filename);
    }
    return path.join(boundWorkspace, filename);
  }

  return {
    async list(
      _ctx: WorkspaceRequestContext,
    ): Promise<ServeWorkspaceMemoryStatus> {
      const filenames = new Set(getAllGeminiMdFilenames());
      const files: ServeWorkspaceMemoryFile[] = [];

      // Discover workspace-root memory files
      for (const filename of filenames) {
        const candidate = path.join(boundWorkspace, filename);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) {
            files.push({
              kind: 'memory_file',
              path: candidate,
              scope: 'workspace',
              bytes: stat.size,
            });
          }
        } catch {
          // ENOENT is expected — file just doesn't exist yet
        }
      }

      // Discover global memory files
      const globalDir = Storage.getGlobalQwenDir();
      for (const filename of filenames) {
        const candidate = path.join(globalDir, filename);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile()) {
            files.push({
              kind: 'memory_file',
              path: candidate,
              scope: 'global',
              bytes: stat.size,
            });
          }
        } catch {
          // ENOENT is expected
        }
      }

      if (files.length === 0) {
        return createIdleWorkspaceMemoryStatus(boundWorkspace);
      }

      const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        files,
        totalBytes,
        fileCount: files.length,
        ruleCount: 0,
      };
    },

    async read(
      ctx: WorkspaceRequestContext,
      key: string,
    ): Promise<{ content: string; path: string }> {
      const filePath = resolveMemoryFilePath(key);
      const content = await fs.readFile(filePath, 'utf8');
      return { content, path: filePath };
    },

    async write(
      ctx: WorkspaceRequestContext,
      params: WriteMemoryParams,
    ): Promise<WriteMemoryResult> {
      validateClientId(ctx);

      const result = await writeWorkspaceContextFile({
        scope: params.scope,
        mode: params.mode,
        content: params.content,
        projectRoot: boundWorkspace,
      });

      if (result.changed) {
        publishWorkspaceEvent({
          type: 'memory_changed',
          data: {
            scope: params.scope,
            filePath: result.filePath,
            mode: params.mode,
            bytesWritten: result.bytesWritten,
          },
          originatorClientId: ctx.originatorClientId,
        });
      }

      return {
        path: result.filePath,
        scope: params.scope,
        bytes: result.bytesWritten,
      };
    },

    async delete(
      ctx: WorkspaceRequestContext,
      key: string,
    ): Promise<{ deleted: boolean }> {
      validateClientId(ctx);

      const filePath = resolveMemoryFilePath(key);

      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'ENOENT'
        ) {
          return { deleted: false };
        }
        throw err;
      }

      publishWorkspaceEvent({
        type: 'memory_changed',
        data: { change: 'deleted', key, filePath },
        originatorClientId: ctx.originatorClientId,
      });

      return { deleted: true };
    },
  };
}
