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
  getAllMemoryFilenames,
  writeWorkspaceContextFile,
} from '@qwen-code/qwen-code-core';
import { detectBOM } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { openNoFollow } from '@qwen-code/qwen-code-core/noFollowOpen';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isServeDebugMode } from './debug-mode.js';
import type { WorkspaceEventBridge } from './acp-session-bridge.js';
import {
  createIdleWorkspaceMemoryStatus,
  STATUS_SCHEMA_VERSION,
  type ServeContextFileScope,
  type ServeWorkspaceMemoryFile,
  type ServeWorkspaceMemoryStatus,
} from '@qwen-code/acp-bridge/status';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from './workspace-route-runtime.js';
import type { WorkspaceRegistry } from './workspace-registry.js';
import { FsError } from './fs/errors.js';
import { resolveWithinWorkspace } from './fs/paths.js';

/**
 * Issue #4175 PR 16: workspace memory CRUD routes.
 *
 * `GET /workspace/memory` returns the daemon's snapshot of explicit
 * `QWEN.md` / `AGENTS.md` files reachable from the bound workspace
 * plus the user's `~/.qwen/` global. Read-only; returns
 * `initialized: false` and an empty `files` list when no files exist
 * (no synthetic 500s, mirroring PR 12's read-only routes).
 * `?content=true` also returns each file's text, which is how a client
 * reads the global file: it lives outside the bound workspace, so the
 * sandboxed `GET /file` refuses it, yet `POST` below can replace it.
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
 * lose information. Configured bearer auth or the daemon's trusted-loopback
 * binding already defines who can see these paths. If a
 * future deployment shape needs path redaction (e.g. multi-tenant
 * over a shared host), it should land as a `--redact-paths`
 * deployment toggle rather than a per-route default flip — tracked
 * with PR 24's `--redact-errors` policy work, not in PR 16.
 */

export interface WorkspaceMemoryRouteDeps {
  bridge: WorkspaceEventBridge;
  boundWorkspace: string;
  collectStatus?: typeof collectWorkspaceMemoryStatus;
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
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
}

function requireTrustedWorkspace(
  deps: WorkspaceMemoryRouteDeps,
  res: Response,
): boolean {
  if (deps.isWorkspaceTrusted?.() !== false) return true;
  res.status(403).json({
    error: 'Workspace is not trusted.',
    code: 'untrusted_workspace',
  });
  return false;
}

function captureOpenGeneration(
  deps: WorkspaceMemoryRouteDeps,
  res: Response,
): (() => void) | null {
  const assertGenerationOpen =
    deps.captureGenerationAssertion?.() ?? (() => {});
  try {
    assertGenerationOpen();
    return assertGenerationOpen;
  } catch (error) {
    sendGenerationClosedError(res, error);
    return null;
  }
}

const MAX_MEMORY_CONTENT_BYTES = 1024 * 1024;

function sendWorkspaceMemoryWriteError(
  res: Response,
  err: unknown,
  options: {
    route: string;
    scope: ServeContextFileScope;
    mode: 'append' | 'replace';
  },
): void {
  const { route, scope, mode } = options;
  if (sendGenerationClosedError(res, err)) return;
  if (err instanceof WorkspaceMemoryWriteTimeoutError) {
    writeStderrLine(
      `qwen serve: ${route} timeout — file lock at ` +
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
      `qwen serve: ${route} refused — existing file ` +
        `${err.filePath} is ${err.bytes} bytes (cap ${err.limit})`,
    );
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
    `qwen serve: ${route} failed (scope=${scope} mode=${mode}): ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
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

/** Mount the two memory routes on the supplied Express app. */
export function mountWorkspaceMemoryRoutes(
  app: Application,
  deps: WorkspaceMemoryRouteDeps,
): void {
  app.get('/workspace/memory', async (req, res) => {
    const assertGenerationOpen = captureOpenGeneration(deps, res);
    if (!assertGenerationOpen) return;
    if (!requireTrustedWorkspace(deps, res)) return;
    try {
      const collectStatus = deps.collectStatus ?? collectWorkspaceMemoryStatus;
      const status = await collectStatus(deps.boundWorkspace, {
        includeContent: req.query['content'] === 'true',
      });
      assertGenerationOpen();
      res.status(200).json(status);
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
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
      const assertGenerationOpen = captureOpenGeneration(deps, res);
      if (!assertGenerationOpen) return;
      if (!requireTrustedWorkspace(deps, res)) return;
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
          assertCanCommit: assertGenerationOpen,
        });
        assertGenerationOpen?.();
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
        sendWorkspaceMemoryWriteError(res, err, {
          route: 'POST /workspace/memory',
          scope,
          mode,
        });
      }
    },
  );
}

export function mountWorkspaceQualifiedMemoryRoutes(
  app: Application,
  deps: Omit<WorkspaceMemoryRouteDeps, 'bridge' | 'boundWorkspace'> & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.get('/workspaces/:workspace/memory', async (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    try {
      const collectStatus = deps.collectStatus ?? collectWorkspaceMemoryStatus;
      const status = await collectStatus(runtime.workspaceCwd, {
        includeContent: req.query['content'] === 'true',
      });
      runtime.generationGuard?.assertOpen();
      res.status(200).json(status);
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/memory failed: ${
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
    '/workspaces/:workspace/memory',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const assertGenerationOpen = () => runtime.generationGuard?.assertOpen();
      assertGenerationOpen();
      const body = deps.safeBody(req);
      if (body['scope'] !== 'workspace') {
        res.status(400).json({
          error:
            'workspace-qualified memory routes only support "workspace" scope',
          code: 'global_scope_not_supported_for_workspace_route',
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
        if (!runtime.bridge.knownClientIds().has(clientId)) {
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
          scope: 'workspace',
          mode,
          content,
          projectRoot: runtime.workspaceCwd,
          assertCanCommit: assertGenerationOpen,
        });
        assertGenerationOpen();
        if (result.changed) {
          runtime.bridge.publishWorkspaceEvent({
            type: 'memory_changed',
            data: {
              scope: 'workspace',
              filePath: result.filePath,
              mode,
              bytesWritten: result.bytesWritten,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        }
        res.status(200).json({
          ok: true,
          filePath: result.filePath,
          bytesWritten: result.bytesWritten,
          mode,
          changed: result.changed,
        });
      } catch (err) {
        sendWorkspaceMemoryWriteError(res, err, {
          route: 'POST /workspaces/:workspace/memory',
          scope: 'workspace',
          mode,
        });
      }
    },
  );
}

interface DiscoveredFile {
  absolutePath: string;
  scope: ServeContextFileScope;
  bytes: number;
  content?: string;
  truncated?: boolean;
}

export interface CollectWorkspaceMemoryStatusOptions {
  /**
   * Read each discovered file's text, capped at the write route's
   * byte limit. A file that fails to read keeps its entry without
   * `content` and adds a cell to `errors[]`. `content` is also
   * omitted (without an error cell) when the on-disk bytes are not
   * valid BOM-free UTF-8 — a lossy decode is never served as
   * replaceable text — and a read whose byte count differs from the
   * earlier `stat` is flagged `truncated` with no `content` (torn
   * read racing a concurrent write).
   */
  includeContent?: boolean;
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
  options: CollectWorkspaceMemoryStatusOptions = {},
): Promise<ServeWorkspaceMemoryStatus> {
  const filenames = new Set(getAllMemoryFilenames());
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

  if (options.includeContent) {
    for (const file of files) {
      try {
        Object.assign(
          file,
          await readMemoryFileContent(
            file.absolutePath,
            file.bytes,
            file.scope === 'workspace' ? boundWorkspace : globalDir,
          ),
        );
      } catch (err) {
        errors.push({
          kind: 'memory_file',
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          hint: file.absolutePath,
        });
      }
    }
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
        ...(f.content !== undefined ? { content: f.content } : {}),
        ...(f.truncated ? { truncated: true } : {}),
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

/**
 * Read one memory file for the `?content=true` response. The web-shell
 * memory panel treats any non-`truncated` `content` as the file's full
 * text and may `mode:'replace'` the file from it (an unconditional
 * `fs.writeFile` with no backup), so this read must be lossless or
 * honest — never serve bytes the panel could mistake for the original:
 *
 * - Resolve within the file's own scope and bind the bounded read to one
 *   regular-file descriptor. A changed path, size, or modification time
 *   makes the snapshot unsafe to replace: flag `truncated` and omit text.
 * - Bytes that are not valid BOM-free UTF-8 (GBK, Shift_JIS, UTF-16 from
 *   PowerShell `>` redirection, BOM'd UTF-8) cannot round-trip through
 *   a replace write: omit `content` so the client's fallback path takes
 *   over instead of saving a lossy decode back over the original bytes.
 */
async function readMemoryFileContent(
  filePath: string,
  expectedBytes: number,
  scopeRoot: string,
): Promise<{ content?: string; truncated?: boolean }> {
  const resolved = await resolveWithinWorkspace(filePath, scopeRoot, 'read');
  const before = await fs.lstat(resolved);
  if (!before.isFile()) {
    throw new FsError('parse_error', `path is not a regular file: ${filePath}`);
  }
  const handle = await openNoFollow(resolved);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== expectedBytes
    ) {
      return { truncated: true };
    }
    const buffer = Buffer.alloc(
      Math.min(opened.size, MAX_MEMORY_CONTENT_BYTES + 1),
    );
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    const current = await resolveWithinWorkspace(filePath, scopeRoot, 'read');
    const currentStat = await fs.lstat(current);
    if (
      bytesRead !== buffer.length ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current !== resolved ||
      currentStat.dev !== opened.dev ||
      currentStat.ino !== opened.ino ||
      currentStat.size !== opened.size ||
      currentStat.mtimeMs !== opened.mtimeMs
    ) {
      return { truncated: true };
    }
    const truncated = opened.size > MAX_MEMORY_CONTENT_BYTES;
    const slice = buffer.subarray(0, MAX_MEMORY_CONTENT_BYTES);
    if (detectBOM(slice)) return { truncated };
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(slice, {
          stream: truncated,
        }),
        truncated,
      };
    } catch {
      return { truncated };
    }
  } finally {
    await handle.close();
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
