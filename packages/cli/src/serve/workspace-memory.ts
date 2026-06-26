/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  Storage,
  WorkspaceMemoryFileTooLargeError,
  WorkspaceMemoryWriteTimeoutError,
  getAllGeminiMdFilenames,
  writeWorkspaceContextFile,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isServeDebugMode } from './debug-mode.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  createIdleWorkspaceMemoryStatus,
  STATUS_SCHEMA_VERSION,
  type ServeContextFileScope,
  type ServeWorkspaceMemoryFile,
  type ServeWorkspaceMemoryStatus,
} from './status.js';

/**
 * Issue #4175 PR 16: workspace memory CRUD routes.
 *
 * `GET /workspace/memory` returns the daemon's snapshot of explicit
 * `QWEN.md` / `AGENTS.md` files reachable from the bound workspace
 * plus the user's `~/.qwen/` global. Read-only; returns
 * `initialized: false` and an empty `files` list when no files exist
 * (no synthetic 500s, mirroring PR 12's read-only routes).
 *
 * `POST /workspace/memory` accepts `{ scope, content, mode }` and
 * forwards to `writeWorkspaceContextFile`. Strict mutation gate; on
 * success, fans out a `memory_changed` event onto every active
 * session's bus so adapters can refresh cached snapshots.
 *
 * Both routes are filesystem-only — neither spawns the ACP child.
 *
 * **Absolute filePath disclosure note**: success / 413 / GET-list
 * responses include absolute on-disk paths (`/work/<x>/QWEN.md`,
 * `/Users/<x>/.qwen/QWEN.md`). This is by design for a daemon
 * contract: clients pre-flight `caps.workspaceCwd` to learn the
 * bound workspace root and can compute relative paths if they
 * prefer; the global scope (`~/.qwen/QWEN.md`) is NOT under the
 * workspace root, so rewriting to a workspace-relative form would
 * lose information. The bearer-token gate + the daemon's loopback-
 * default binding already restrict who can see these paths. If a
 * future deployment shape needs path redaction (e.g. multi-tenant
 * over a shared host), it should land as a `--redact-paths`
 * deployment toggle rather than a per-route default flip — tracked
 * with PR 24's `--redact-errors` policy work, not in PR 16.
 */

export interface WorkspaceMemoryRouteDeps {
  bridge: AcpSessionBridge;
  boundWorkspace: string;
  /**
   * `mutate({ strict: true })`-style middleware factory from PR 15.
   * Passed in so `server.ts` stays the single composition root for
   * the mutation-gate decisions.
   */
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /**
   * Pre-validated client id parser. Returns `undefined` for absent
   * headers, the parsed id for valid ones, and `null` after sending
   * its own 400 response (so the route handler must short-circuit).
   * Re-uses `parseClientIdHeader` from `server.ts`.
   */
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  /** `safeBody` from `server.ts` — strips prototype-pollution keys. */
  safeBody: (req: Request) => Record<string, unknown>;
}

const MAX_MEMORY_CONTENT_BYTES = 1024 * 1024;

/** Mount the two memory routes on the supplied Express app. */
export function mountWorkspaceMemoryRoutes(
  app: Application,
  deps: WorkspaceMemoryRouteDeps,
): void {
  app.get('/workspace/memory', async (_req, res) => {
    try {
      const status = await collectWorkspaceMemoryStatus(deps.boundWorkspace);
      res.status(200).json(status);
    } catch (err) {
      // Per-file stat failures are caught inside
      // `collectWorkspaceMemoryStatus` and surfaced in-band via
      // `errors[]` with `errorKind: 'stat_failed'`. The outer catch
      // here only fires on programmer error (an upstream helper
      // throws unexpectedly). Return 500 — a 200-with-errors response
      // for a complete-discovery failure would silently look healthy
      // to status dashboards counting non-2xx as failures, which is
      // exactly the silent-failure mode PR 12's read-only routes
      // avoided by routing bridge errors through `sendBridgeError`.
      writeStderrLine(
        `qwen serve: GET /workspace/memory failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to discover workspace memory',
        code: 'memory_discovery_failed',
      });
    }
  });

  app.post(
    '/workspace/memory',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const body = deps.safeBody(req);

      const scope = body['scope'];
      if (scope !== 'workspace' && scope !== 'global') {
        res.status(400).json({
          error: '`scope` must be "workspace" or "global"',
          code: 'invalid_scope',
        });
        return;
      }

      const modeRaw = body['mode'];
      if (
        modeRaw !== undefined &&
        modeRaw !== 'append' &&
        modeRaw !== 'replace'
      ) {
        res.status(400).json({
          error: '`mode` must be "append", "replace", or omitted',
          code: 'invalid_mode',
        });
        return;
      }
      const mode: 'append' | 'replace' =
        modeRaw === 'replace' ? 'replace' : 'append';

      const content = body['content'];
      if (typeof content !== 'string') {
        res.status(400).json({
          error: '`content` must be a string',
          code: 'invalid_content',
        });
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_CONTENT_BYTES) {
        res.status(400).json({
          error: `\`content\` exceeds the ${MAX_MEMORY_CONTENT_BYTES}-byte limit`,
          code: 'content_too_large',
        });
        return;
      }

      const clientId = deps.parseClientId(req, res);
      if (clientId === null) return;
      let originatorClientId: string | undefined;
      if (clientId !== undefined) {
        // Mirror the workspace-agents.ts `resolveOriginatorClientId`
        // posture: validate against `bridge.knownClientIds()`, send
        // 400 directly, return `null` so the caller short-circuits.
        // Previously this branch threw `InvalidClientIdError` and
        // caught it locally — wenshao round-6 flagged the
        // throw-vs-direct-400 inconsistency between the two route
        // files. Aligning the call sites now removes the surface
        // divergence; the deeper DRY refactor (one shared helper
        // module) still lands in the cross-Wave-4 sweep with PR
        // 17/19/20/21.
        const known = deps.bridge.knownClientIds();
        if (!known.has(clientId)) {
          res.status(400).json({
            error: `Client id "${clientId}" is not registered for this workspace`,
            code: 'invalid_client_id',
            clientId,
          });
          return;
        }
        originatorClientId = clientId;
      }

      try {
        const result = await writeWorkspaceContextFile({
          scope,
          mode,
          content,
          projectRoot: deps.boundWorkspace,
        });
        const responseBody = {
          ok: true as const,
          filePath: result.filePath,
          bytesWritten: result.bytesWritten,
          mode,
          changed: result.changed,
        };
        // Only fan out a `memory_changed` event when the helper
        // actually mutated the file. Whitespace-only appends short-
        // circuit upstream (writeContextFile.ts) and would otherwise
        // emit a misleading "memory just changed" toast across every
        // SSE subscriber for a request that did nothing.
        if (result.changed) {
          deps.bridge.publishWorkspaceEvent({
            type: 'memory_changed',
            data: {
              scope,
              filePath: result.filePath,
              mode,
              bytesWritten: result.bytesWritten,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        }
        res.status(200).json(responseBody);
      } catch (err) {
        // 413 + structured fields for the "memory file is past the
        // safe-append cap" case so callers can tell pathological
        // file size apart from generic file errors. The helper
        // refuses to pull >16 MB into memory on append; clients
        // either trim the file or switch to mode=replace.
        if (err instanceof WorkspaceMemoryWriteTimeoutError) {
          writeStderrLine(
            `qwen serve: POST /workspace/memory timeout — file lock at ` +
              `${err.filePath} did not acquire within ${err.timeoutMs}ms ` +
              `(stalled FS / OneDrive / NFS)`,
          );
          const debug = isServeDebugMode();
          res.status(500).json({
            error: debug
              ? err.message
              : 'Workspace memory write timed out waiting for the per-file lock. Retry or restart the daemon.',
            code: 'memory_write_timeout',
            scope,
            mode,
            timeoutMs: err.timeoutMs,
            ...(debug ? { filePath: err.filePath } : {}),
          });
          return;
        }
        if (err instanceof WorkspaceMemoryFileTooLargeError) {
          writeStderrLine(
            `qwen serve: POST /workspace/memory refused — existing file ` +
              `${err.filePath} is ${err.bytes} bytes (cap ${err.limit})`,
          );
          // Path disclosure: both `error` (which embeds the absolute
          // file path in the constructor message — see
          // `WorkspaceMemoryFileTooLargeError`) and `filePath` are
          // gated behind QWEN_SERVE_DEBUG so production responses
          // don't include `/Users/<x>/.qwen/...` in the body.
          // Operators triaging an issue locally enable the debug
          // toggle to get the full text; in default mode SDK
          // callers branch on `code` + `bytes` / `limit` instead
          // (the structured discriminator survives without the
          // disclosure).
          const debug = isServeDebugMode();
          res.status(413).json({
            error: debug
              ? err.message
              : 'Existing memory file exceeds the safe-append cap. Trim the file or POST with mode=replace.',
            code: 'memory_file_too_large',
            scope,
            mode,
            ...(debug ? { filePath: err.filePath } : {}),
            bytes: err.bytes,
            limit: err.limit,
          });
          return;
        }
        writeStderrLine(
          `qwen serve: POST /workspace/memory failed (scope=${scope} mode=${mode}): ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        // Surface enough context for callers to debug without leaking
        // absolute paths in the response body. `osCode` (`EACCES` /
        // `EROFS` / `EDQUOT` / `ENOSPC` / ...) stays unconditional so
        // SDK clients can branch on the failure class. The full
        // `errorMessage` (which often embeds the file path on Node's
        // ENOENT/EACCES messages) is gated behind `QWEN_SERVE_DEBUG`.
        // Without the debug toggle, callers see only the generic
        // `error` + `code` + `osCode` envelope; the daemon's stderr
        // log has the full message for the operator.
        const osCode =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code?: unknown }).code
            : undefined;
        const debug = isServeDebugMode();
        res.status(500).json({
          error: 'Failed to write workspace memory',
          code: 'file_error',
          scope,
          mode,
          ...(typeof osCode === 'string' ? { osCode } : {}),
          ...(debug
            ? {
                errorMessage: err instanceof Error ? err.message : String(err),
              }
            : {}),
        });
      }
    },
  );
}

interface DiscoveredFile {
  absolutePath: string;
  scope: ServeContextFileScope;
  bytes: number;
}

/**
 * Filesystem-only discovery of explicit `QWEN.md` / `AGENTS.md`
 * files reachable from the daemon's bound workspace plus the user's
 * `~/.qwen/` global directory.
 *
 * Discovers the bound-workspace-root file(s) (no parent-directory
 * walk in this version) plus the global dir. `walkWorkspaceForMemory`
 * keeps a guarded upward-walk loop body for a future hierarchical
 * mode but breaks after iteration 1 today; callers should treat the
 * surface as "workspace root + global". Auto-memory (the `MEMORY.md`
 * index + per-type files) is intentionally NOT included; that's PR
 * 16.5's responsibility per scope decision in issue #4175. Path-
 * based rules (`.qwen/rules/`) are also out of scope for v1.
 */
export async function collectWorkspaceMemoryStatus(
  boundWorkspace: string,
): Promise<ServeWorkspaceMemoryStatus> {
  const filenames = new Set(getAllGeminiMdFilenames());
  const files: DiscoveredFile[] = [];
  const errors: ServeWorkspaceMemoryStatus['errors'] = [];

  const workspaceFiles = await walkWorkspaceForMemory(
    boundWorkspace,
    filenames,
    errors,
  );
  files.push(...workspaceFiles);

  const globalDir = Storage.getGlobalQwenDir();
  for (const filename of filenames) {
    const candidate = path.join(globalDir, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        files.push({
          absolutePath: candidate,
          scope: 'global',
          bytes: stat.size,
        });
      }
    } catch (err) {
      if (!isEnoent(err)) {
        errors.push({
          kind: 'memory_file',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          errorKind: 'stat_failed',
          hint: candidate,
        });
      }
    }
  }

  if (files.length === 0 && errors.length === 0) {
    return createIdleWorkspaceMemoryStatus(boundWorkspace);
  }

  const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
  const result: ServeWorkspaceMemoryStatus = {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd: boundWorkspace,
    initialized: true,
    files: files.map(
      (f): ServeWorkspaceMemoryFile => ({
        kind: 'memory_file',
        path: f.absolutePath,
        scope: f.scope,
        bytes: f.bytes,
      }),
    ),
    totalBytes,
    fileCount: files.length,
    ruleCount: 0,
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/**
 * Stat each known memory filename (`QWEN.md`, `AGENTS.md`) at the
 * bound workspace root and return the matches. v1 does not walk
 * parent directories — that's reserved for PR 16.5's hierarchical
 * mode, which will replace this helper with a real upward walk
 * (originally drafted in this file but removed at glm-5.1's review
 * because the loop body was reachable only on its first iteration
 * via `if (cursor === start) break`, making the cap and `seen` set
 * dead code that confused reviewers). When PR 16.5 lifts the cap,
 * the new implementation lands as a fresh upward walk rather than
 * "uncomment lines".
 */
async function walkWorkspaceForMemory(
  start: string,
  filenames: ReadonlySet<string>,
  errors: NonNullable<ServeWorkspaceMemoryStatus['errors']>,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const filename of filenames) {
    const candidate = path.join(start, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        out.push({
          absolutePath: candidate,
          scope: 'workspace',
          bytes: stat.size,
        });
      }
    } catch (err) {
      if (!isEnoent(err)) {
        errors.push({
          kind: 'memory_file',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          errorKind: 'stat_failed',
          hint: candidate,
        });
      }
    }
  }
  return out;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
