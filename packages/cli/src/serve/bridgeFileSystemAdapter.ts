/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serve-side adapter that satisfies `@qwen-code/acp-bridge`'s
 * `BridgeFileSystem` interface by routing ACP `writeTextFile` /
 * `readTextFile` requests through the `WorkspaceFileSystem`. Agent-side
 * ACP fs calls pick up the same defensive guarantees the HTTP file
 * routes already enforce.
 *
 * The adapter is a thin translation layer:
 *   - ACP request → `WorkspaceFileSystem.resolve(path, intent)` to
 *     materialize the `ResolvedPath` brand
 *   - For writes: `wfs.writeTextOverwrite(resolved, content)` — the
 *     primitive that does atomic temp+rename with target-mode
 *     preservation (existing `0o600` survives the edit; new files
 *     default to `0o600`, NOT umask). Picked over `wfs.writeText` (no
 *     mode handling, non-atomic) and over `wfs.writeTextAtomic` (whose
 *     `expectedHash` CAS gate doesn't map to ACP's hash-less
 *     `WriteTextFileRequest` wire shape).
 *   - For reads: `wfs.readText(resolved, { line, limit })` (the read
 *     path enforces size caps + line/limit windowing + audit)
 *   - Error propagation is by reference — `FsError` (the boundary-error
 *     type, carrying a discriminator on `.kind`:
 *     `untrusted_workspace` / `symlink_escape` / `file_too_large` /
 *     etc.) is thrown unchanged through `BridgeClient`'s ACP
 *     `writeTextFile` / `readTextFile` handlers and serialized to the
 *     agent via the existing ACP error envelope. The classifier in
 *     `@qwen-code/acp-bridge`'s `mapDomainErrorToErrorKind` does NOT
 *     translate `FsError.kind` to `ServeErrorKind` — it only checks
 *     `instanceof` / `.name` / `.code`. The `.kind` field rides
 *     through on the error object itself; downstream consumers
 *     reading the ACP error payload pick it up directly. HTTP route
 *     errors take the same shape (`sendFsError` in `cli/src/serve/fs/
 *     errors.ts` serializes the same `.kind`), so an SDK consumer
 *     handling either surface keys on `.kind` either way.
 *     Future: if `mapDomainErrorToErrorKind` should also map
 *     `FsError.kind`, it'd need cross-package imports (FsError lives
 *     in `cli/src/serve/fs`, classifier in `acp-bridge`) — handled
 *     as a separate scope.
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
      await wfs.writeTextOverwrite(resolved, params.content);
      return {};
    },

    async readText(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const wfs = factory.forRequest(buildAuditContext(params, ACP_READ_ROUTE));
      const resolved = await wfs.resolve(params.path, 'read');
      // ACP `line` / `limit` are `number | null | undefined`; the
      // `readText` opts expect `number | undefined`. Drop nulls AND
      // undefineds so we only forward concrete numeric windows.
      //
      // Also drop non-positive `limit` (e.g. `-1`, `0`): the previous
      // inline `BridgeClient.readTextFile` proxy returned `{ content:
      // '' }` for `limit <= 0`, but the `readText` boundary applies
      // `slice(0, limit)` which returns "all lines except the last
      // |limit|" for negative limits — wrong content. Same for non-
      // positive `line` (1-based; <= 0 is meaningless and currently
      // rejected with parse_error). Drop both so the boundary falls back to
      // its `undefined` defaults (no windowing) — closest match to the
      // pre-PR empty-content posture without smuggling a `parse_error`
      // to agents that previously got `''`.
      const opts: { line?: number; limit?: number } = {};
      if (typeof params.line === 'number' && params.line > 0) {
        opts.line = params.line;
      }
      if (typeof params.limit === 'number' && params.limit > 0) {
        opts.limit = params.limit;
      }
      const { content } = await wfs.readText(resolved, opts);
      return { content };
    },
  };
}
