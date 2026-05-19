/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serve-side adapter that satisfies `@qwen-code/acp-bridge`'s
 * `BridgeFileSystem` interface by routing ACP `writeTextFile` /
 * `readTextFile` requests through PR 18's `WorkspaceFileSystem`.
 *
 * F1 (#4319) shipped the seam — `BridgeOptions.fileSystem` +
 * `BridgeClient`'s early-return delegation; without this adapter the
 * seam stays unused in production and `BridgeClient` falls back to
 * its inline `fs.realpath` / `fs.writeFile` / `fs.readFile` proxy
 * (which lacks the TOCTOU + symlink + trust-gate + audit machinery
 * PR 18 added).
 *
 * Wiring this adapter through `runQwenServe` + `createServeApp`'s
 * default bridge construction closes the `ws.ts:613` follow-up
 * thread tracked since PR 18 landed — agent-side ACP fs calls now
 * pick up the same defensive guarantees the HTTP file routes
 * (`POST /file`, `POST /file/edit` from PR 20) already enforce.
 *
 * The adapter is a thin translation layer:
 *   - ACP request → `WorkspaceFileSystem.resolve(path, intent)` to
 *     materialize the `ResolvedPath` brand
 *   - For writes: `wfs.writeText(resolved, content)` (the PR 18 write
 *     path applies trust gate + atomic temp-file + symlink resolution
 *     + audit emit internally)
 *   - For reads: `wfs.readText(resolved, { line, limit })` (PR 18's
 *     read path enforces size caps + line/limit windowing + audit)
 *   - Error propagation is by reference — the bridge's existing
 *     `mapDomainErrorToErrorKind` classifier downstream picks up
 *     `FsError` codes the same way it would for HTTP route errors
 *
 * Tests for this adapter live alongside the bridge integration
 * suite — they verify both the happy path (ACP write/read hits
 * disk under the workspace) and the trust gate (`trustedWorkspace:
 * false` fsFactory makes ACP writes reject with the same posture
 * as HTTP `POST /file`).
 */

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { BridgeFileSystem } from '@qwen-code/acp-bridge';
import type {
  WorkspaceFileSystemFactory,
  RequestContext,
} from './fs/workspaceFileSystem.js';

/** Route label used in audit events for ACP-triggered fs operations. */
const ACP_WRITE_ROUTE = 'ACP writeTextFile';
const ACP_READ_ROUTE = 'ACP readTextFile';

/**
 * Build the per-tick `RequestContext` the `WorkspaceFileSystemFactory`
 * needs. ACP fs calls always carry a `sessionId`; `originatorClientId`
 * is intentionally NOT set here because the agent (not an HTTP
 * client) initiated the call — the audit record's `route` field is
 * what marks it as agent-sourced. SDK consumers reading the audit
 * stream can `switch` on `route` to distinguish HTTP route fs from
 * agent fs.
 */
function buildAuditContext(
  params: { sessionId?: string },
  route: string,
): RequestContext {
  return {
    route,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}

/**
 * Adapter factory. Pass the existing `WorkspaceFileSystemFactory`
 * (the same instance `createServeApp` / `runQwenServe` build for
 * HTTP fs routes) — both paths share the same `fsAuditEmit` channel
 * + trust gate snapshot so an operator gets a unified audit stream.
 */
export function createBridgeFileSystemAdapter(
  factory: WorkspaceFileSystemFactory,
): BridgeFileSystem {
  return {
    async writeText(
      params: WriteTextFileRequest,
    ): Promise<WriteTextFileResponse> {
      const wfs = factory.forRequest(
        buildAuditContext(params, ACP_WRITE_ROUTE),
      );
      const resolved = await wfs.resolve(params.path, 'write');
      await wfs.writeText(resolved, params.content);
      return {};
    },

    async readText(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const wfs = factory.forRequest(buildAuditContext(params, ACP_READ_ROUTE));
      const resolved = await wfs.resolve(params.path, 'read');
      // ACP `line` / `limit` are `number | null | undefined`; PR 18's
      // `readText` opts expect `number | undefined`. Drop nulls AND
      // undefineds so we only forward concrete numeric windows.
      const opts: { line?: number; limit?: number } = {};
      if (typeof params.line === 'number') opts.line = params.line;
      if (typeof params.limit === 'number') opts.limit = params.limit;
      const { content } = await wfs.readText(resolved, opts);
      return { content };
    },
  };
}
