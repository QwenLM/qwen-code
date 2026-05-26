/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FileService — thin delegation layer wrapping WorkspaceFileSystemFactory.
 *
 * Accepts `WorkspaceRequestContext` and constructs the appropriate
 * `RequestContext` to call `fsFactory.forRequest(ctx)`, then delegates
 * to the returned `WorkspaceFileSystem`.
 */

import type {
  WorkspaceFileSystemFactory,
  WorkspaceFileSystem,
  RequestContext,
} from '../fs/index.js';

import type { FileService, WorkspaceRequestContext } from './types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FileServiceDeps {
  fsFactory: WorkspaceFileSystemFactory;
  boundWorkspace: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileService(deps: FileServiceDeps): FileService {
  function scopedFs(ctx: WorkspaceRequestContext): WorkspaceFileSystem {
    const reqCtx: RequestContext = {
      originatorClientId: ctx.originatorClientId,
      sessionId: ctx.sessionId,
      route: ctx.route,
    };
    return deps.fsFactory.forRequest(reqCtx);
  }

  return {
    async resolve(ctx, input, intent) {
      return scopedFs(ctx).resolve(input, intent);
    },

    async stat(ctx, p) {
      return scopedFs(ctx).stat(p);
    },

    async readText(ctx, p, opts?) {
      return scopedFs(ctx).readText(p, opts);
    },

    async readBytes(ctx, p, opts?) {
      return scopedFs(ctx).readBytes(p, opts);
    },

    async readBytesWindow(ctx, p, opts?) {
      return scopedFs(ctx).readBytesWindow(p, opts);
    },

    async list(ctx, p, opts?) {
      return scopedFs(ctx).list(p, opts);
    },

    async glob(ctx, pattern, opts?) {
      return scopedFs(ctx).glob(pattern, opts);
    },

    async writeTextAtomic(ctx, p, content, opts) {
      return scopedFs(ctx).writeTextAtomic(p, content, opts);
    },

    async writeTextOverwrite(ctx, p, content) {
      return scopedFs(ctx).writeTextOverwrite(p, content);
    },

    async edit(ctx, p, content, opts) {
      return scopedFs(ctx).writeTextAtomic(p, content, opts);
    },
  };
}
