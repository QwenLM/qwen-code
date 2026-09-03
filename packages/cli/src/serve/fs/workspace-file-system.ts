/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { glob as globAsync } from 'glob';
// `StandardFileSystemService` is constructed and `loadIgnoreRules` is
// invoked at runtime — they MUST stay as value imports. The eslint
// auto-fix in commit 7b0db4c3a hoisted the whole block to `import type`
// (because the same line referenced the `Ignore` and `WriteTextFileOptions`
// types), which silently erased the value bindings and broke the runtime
// + 31 tests post-commit. The inline `type` modifiers below tell the
// `consistent-type-imports` rule per-symbol intent so future autofixes
// don't repeat the regression.

import {
  StandardFileSystemService,
  detectLineEnding,
  encodeTextFileContentAsync,
} from '@qwen-code/qwen-code-core/services/fileSystemService.js';
import type { WriteTextFileOptions } from '@qwen-code/qwen-code-core/services/fileSystemService.js';
import { isUtf8CompatibleEncoding } from '@qwen-code/qwen-code-core/utils/encoding.js';
import {
  decodeBufferWithEncodingInfoAsync,
  isWithinRoot,
} from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { loadIgnoreRules } from '@qwen-code/qwen-code-core/utils/filesearch/ignore.js';
import type { Ignore } from '@qwen-code/qwen-code-core/utils/filesearch/ignore.js';
import {
  CursorNotAtLineBoundaryError,
  LargeNonUtf8TextError,
  TextScanBudgetExceededError,
} from '@qwen-code/qwen-code-core/utils/read-text-range.js';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { WorkspaceGenerationGuard } from '../workspace-registry.js';
import {
  type AuditContext,
  type AuditPublisher,
  createAuditPublisher,
} from './audit.js';
import {
  FsError,
  isFsError,
  wrapAsFsError,
  type FsErrorKind,
} from './errors.js';
import {
  assertCursorMatchesFile,
  decodeTextCursor,
  encodeTextCursor,
} from './text-cursor.js';
import {
  canonicalizeWorkspaces,
  hasSuspiciousPathPattern,
  resolveWithinWorkspace,
  type Intent,
  type ResolvedPath,
} from './paths.js';
import {
  BINARY_PROBE_BYTES,
  MAX_READ_BYTES,
  MAX_TEXT_SCAN_BYTES,
  MAX_UPLOAD_BYTES,
  assertTrustedForIntent,
  enforceReadSize,
  enforceWriteSize,
  shouldIgnore,
  type IgnoreVerdict,
} from './policy.js';
import { PathMutexRegistry } from './path-mutex-registry.js';

/**
 * Stat snapshot returned by `WorkspaceFileSystem.stat`. We
 * deliberately avoid passing through `fs.Stats` directly — the
 * boundary should not leak Node-specific bigint quirks or
 * platform-specific fields to SDK consumers.
 */
export interface FsStat {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes: number;
  modifiedMs: number;
}

/** Directory listing entry from `WorkspaceFileSystem.list`. */
export interface FsEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  /** True iff the entry matched a `.gitignore`/`.qwenignore` rule. */
  ignored: boolean;
}

/** Metadata side-channel returned alongside `readText` content. */
export interface ReadMeta {
  encoding?: string;
  bom?: boolean;
  lineEnding: 'crlf' | 'lf';
  sizeBytes?: number;
  hash?: ContentHash;
  truncated?: boolean;
  matchedIgnore?: 'file' | 'directory';
  originalLineCount?: number;
  /**
   * Resume token for the next page. Present only when content remains *and* a
   * file byte offset is derivable — a non-UTF-8 snapshot read has more to give
   * but cannot be paged by byte, which is why `hasMore` is a separate field
   * rather than a restatement of this one.
   */
  nextCursor?: string;
  /** Whether content remains beyond what was returned, for any reason. */
  hasMore?: boolean;
}

/**
 * Above `MAX_READ_BYTES` at least one of these must be set. Any of them is
 * the caller stating it accepts partial content, which is all the streamed
 * path returns; with none of them the read is refused rather than silently
 * handing back a truncated "whole file". Which one is set does not affect
 * cost — that is bounded by `MAX_TEXT_SCAN_BYTES`.
 */
export interface ReadTextOptions {
  /** Returned-byte cap in [1, MAX_READ_BYTES]; defaults to MAX_READ_BYTES. */
  maxBytes?: number;
  /**
   * Opaque resume token from a previous read's `meta.nextCursor`. Mutually
   * exclusive with `line` — both name a starting point. Reaches any offset in
   * O(1), where `line` must scan from byte 0.
   */
  cursor?: string;
  /**
   * 1-based starting line for partial reads. `1` returns the file
   * from its first line. The boundary converts to the 0-based slice
   * index `readFileWithLineAndLimit` expects internally; SDK
   * consumers don't need to adjust. Undefined starts from the
   * beginning; non-positive or non-integral values are rejected.
   */
  line?: number;
  /** Maximum number of lines to return. */
  limit?: number;
}

export interface ListOptions {
  /** When true, ignored entries are returned with `ignored: true` rather than dropped. */
  includeIgnored?: boolean;
  /** Stop after this many returned entries have been collected. */
  maxEntries?: number;
}

export interface GlobOptions {
  cwd?: ResolvedPath;
  includeIgnored?: boolean;
  maxResults?: number;
}

export type ContentHash = `sha256:${string}`;

export interface ReadBytesOptions {
  /** Zero-based byte offset. */
  offset?: number;
  /** Maximum bytes to return; defaults to MAX_READ_BYTES. */
  maxBytes?: number;
}

export interface ReadBytesOutcome {
  buffer: Buffer;
  sizeBytes: number;
  returnedBytes: number;
  offset: number;
  truncated: boolean;
  /** Present only when the returned window covers the whole file. */
  hash?: ContentHash;
}

/**
 * Atomic write modes.
 *
 *   - `'create'`   — fails with `file_already_exists` if the target exists.
 *   - `'replace'`  — requires `expectedHash`; fails with `hash_mismatch` if
 *                    the on-disk hash doesn't match (optimistic concurrency).
 *   - `'overwrite'` — unconditional create-or-overwrite, no hash check. Used
 *                     by callers whose protocol has no client-side hash
 *                     (e.g. ACP `WriteTextFileRequest` has only
 *                     `{path, content, sessionId}`). Still goes through the
 *                     atomic tmp+rename + mode-preservation path so a
 *                     `0o600` secret edit does NOT downgrade to umask-default
 *                     and a SIGKILL mid-write does NOT truncate the target.
 */
export type WriteMode = 'create' | 'replace' | 'overwrite';

/**
 * Subset of `WriteMode` that `writeTextAtomic` accepts. `'overwrite'`
 * is intentionally excluded: the helper underneath
 * (`atomicWriteTextResolvedFile`) supports it for the `writeTextOverwrite`
 * method, but `writeTextAtomic`'s `existingMeta`-detection +
 * `created`-derivation branches assume 'create' | 'replace' shape.
 * Narrowing here prevents callers from writing
 * `writeTextAtomic(p, c, {mode: 'overwrite'})` and hitting the runtime
 * `parse_error` from `validateWriteTextAtomicOptions` — TypeScript
 * catches it at compile time and points at the right alternative
 * (`writeTextOverwrite`).
 */
export type AtomicWriteMode = Exclude<WriteMode, 'overwrite'>;

/**
 * Mode policy for NEW files created by text writes
 * (`writeTextAtomic` / `writeTextOverwrite` / `edit` / `editAtomic`
 * and the same-host built-in-tool write route).
 *
 *   - `'owner'` (default) — owner-only `0o600`, independent of the
 *     daemon's umask. This is the long-standing fail-closed posture:
 *     a fresh agent-created file is never world/group readable by
 *     accident, regardless of how permissive the process umask is.
 *   - `'system'` — the standard POSIX `0o666 & ~umask` handling, so
 *     agent-created files follow the daemon process's umask like any
 *     other process on the machine (e.g. `0664` under `umask 0002`).
 *     Operators running the daemon under a supervisor that sets
 *     `UMask=` (systemd drop-ins, containers) can opt in via
 *     `QWEN_SERVE_NEW_FILE_MODE=system`.
 *
 * Existing-file mode preservation is unaffected by either policy —
 * editing a `0600` secret keeps it `0600`, an executable keeps `+x`.
 * Binary uploads (`writeBytesAtomic`) always create at `0o600`
 * regardless of this policy.
 */
export type NewFileModePolicy = 'owner' | 'system';

/** Owner-only mode bits applied to new files under the default policy. */
export const OWNER_ONLY_NEW_FILE_MODE = 0o600;

/**
 * Resolve the mode bits for a NEW file under the given policy.
 * `umask` is read lazily only when the `system` policy consumes it; the
 * default `owner` policy never touches the process umask. Tests pass an
 * explicit value to stay deterministic without mutating process state.
 */
export function resolveNewFileModeBits(
  policy: NewFileModePolicy,
  umask?: number,
): number {
  return policy === 'system'
    ? 0o666 & ~(umask ?? process.umask())
    : OWNER_ONLY_NEW_FILE_MODE;
}

export interface WriteTextAtomicOptions extends WriteTextFileOptions {
  mode: AtomicWriteMode;
  expectedHash?: ContentHash;
  lineEnding?: 'crlf' | 'lf';
}

export interface WriteTextAtomicOutcome {
  created: boolean;
  sizeBytes: number;
  hash: ContentHash;
  meta: ReadMeta;
}

export interface WriteOutcome {
  writtenBytes: number;
  hash?: ContentHash;
  meta?: ReadMeta;
}

export interface RequestContext extends AuditContext {
  /** Mostly redundant with `originatorClientId`; kept for forward-compat with future ACP fields. */
  ownerSessionId?: string;
}

/** Host-only write input after the bridge adapter validates tool provenance. */
export interface SameHostToolTextWriteRequest {
  path: string;
  content: string;
  meta?: {
    bom?: boolean;
    encoding?: string;
    lineEnding?: 'crlf' | 'lf';
  };
}

/**
 * Public boundary type. Routes consume this via the
 * factory's `forRequest(ctx)` so audit context is automatically
 * threaded through every operation.
 */
export interface WorkspaceFileSystem {
  resolve(input: string, intent: Intent): Promise<ResolvedPath>;
  stat(p: ResolvedPath): Promise<FsStat>;
  readText(
    p: ResolvedPath,
    opts?: ReadTextOptions,
  ): Promise<{ content: string; meta: ReadMeta }>;
  readBytes(p: ResolvedPath, opts?: ReadBytesOptions): Promise<Buffer>;
  readBytesWindow(
    p: ResolvedPath,
    opts?: ReadBytesOptions,
  ): Promise<ReadBytesOutcome>;
  list(p: ResolvedPath, opts?: ListOptions): Promise<FsEntry[]>;
  glob(pattern: string, opts?: GlobOptions): Promise<ResolvedPath[]>;
  writeTextAtomic(
    p: ResolvedPath,
    content: string,
    opts: WriteTextAtomicOptions,
  ): Promise<WriteTextAtomicOutcome>;
  /**
   * Unconditional create-or-overwrite (no `expectedHash` gate). Atomic
   * temp+rename with target-mode preservation: a `0o600` secret survives
   * the edit at `0o600`. New files are created under the factory's
   * `NewFileModePolicy` — `0o600` by default, or the umask-derived
   * `0o666 & ~umask` under `'system'`. Used by protocols whose wire
   * format carries no client-side hash — e.g. ACP `WriteTextFileRequest`
   * is just `{path, content, sessionId}` so the CAS-gated
   * `writeTextAtomic` doesn't fit.
   *
   * Symlinks at the target are rejected (`symlink_escape`) consistent
   * with `writeTextAtomic` and HTTP `POST /file`.
   */
  writeTextOverwrite(
    p: ResolvedPath,
    content: string,
    opts?: WriteTextFileOptions,
  ): Promise<WriteTextAtomicOutcome>;
  writeText(
    p: ResolvedPath,
    content: string,
    opts?: WriteTextFileOptions,
  ): Promise<void>;
  edit(
    p: ResolvedPath,
    oldText: string,
    newText: string,
    opts?: { expectedHash?: ContentHash },
  ): Promise<WriteOutcome>;
  editAtomic(
    p: ResolvedPath,
    oldText: string,
    newText: string,
    opts: { expectedHash: ContentHash },
  ): Promise<WriteOutcome>;
  /**
   * Single-purpose no-clobber binary create. Writes `data` atomically
   * (temp + publish) at `p`; it cannot modify or replace existing file
   * content. An existing target (including a final-component symlink)
   * throws `file_already_exists` (`symlink_escape` for a symlink). The
   * caller is responsible for choosing a free name; the upload route owns
   * the numbered-candidate policy; the collision is expected control flow
   * there and emits no `fs.denied` audit event. `data` is size-checked
   * against `MAX_UPLOAD_BYTES` here — the binary-ingress policy, NOT the
   * `MAX_WRITE_BYTES` text default. Trust and generation guards are enforced
   * at entry, inside the path lock, and at the final publish checkpoint.
   * New files are created at `0o600`.
   */
  writeBytesAtomic(
    p: ResolvedPath,
    data: Buffer,
  ): Promise<{ sizeBytes: number; hash: ContentHash }>;
  /**
   * Create a directory at `p` (already resolved within the workspace).
   * `recursive: true` also creates missing intermediate components; every
   * created component is re-checked with `lstat` right after `mkdir` and
   * each parent is re-checked before the next `mkdir`, so a symlink
   * swapped in mid-creation is rejected (`symlink_escape`) rather than
   * followed. An existing directory is left untouched; an existing
   * non-directory or symlink at `p` is rejected. Directories are created
   * at `0o755` (modulo the process umask).
   */
  mkdir(p: ResolvedPath, opts?: { recursive?: boolean }): Promise<void>;
}

/**
 * Per-process factory. Build once at `createServeApp` boot, call
 * `forRequest` per HTTP route invocation.
 */
export interface WorkspaceFileSystemFactory {
  forRequest(ctx: RequestContext): WorkspaceFileSystem;
  assertCanWrite(): void;
  /** Optional so existing custom factories remain workspace-only by default. */
  writeSameHostToolText?(
    ctx: RequestContext,
    request: SameHostToolTextWriteRequest,
  ): Promise<void>;
}

export interface CreateWorkspaceFileSystemFactoryDeps {
  /** Canonical workspace roots; index 0 is the primary cwd. */
  boundWorkspaces: readonly string[];
  /** Snapshot of `Config.isTrustedFolder()` at boot. */
  trusted: boolean;
  /** Bridge-bound publisher into `EventBus.publish`. */
  emit: (event: BridgeEvent) => void;
  /**
   * Override the default ignore loader. Tests pass a fixed `Ignore`
   * to avoid filesystem coupling; production lets the factory build
   * one per workspace via `loadIgnoreRules`.
   */
  ignore?: Ignore;
  /** Override audit raw-path mode. Defaults to env `QWEN_AUDIT_RAW_PATHS=1`. */
  includeRawPaths?: boolean;
  /** Custom AI ignore files from context.fileFiltering.customIgnoreFiles. */
  customIgnoreFiles?: string[];
  /** Optional shared write-lock registry for multiple daemon entrypoints. */
  pathLocks?: PathMutexRegistry;
  /** Runtime-generation guard checked at mutation commit points. */
  generationGuard?: Pick<WorkspaceGenerationGuard, 'assertOpen'>;
  /**
   * Mode policy for NEW files created by text writes. Defaults to
   * `'owner'` (`0o600`, umask-independent). `'system'` follows the
   * daemon process's umask (`0o666 & ~umask`). Production wiring
   * derives this from `QWEN_SERVE_NEW_FILE_MODE`; see
   * `NewFileModePolicy`.
   */
  newFileMode?: NewFileModePolicy;
}

/**
 * Build a `WorkspaceFileSystemFactory`. The factory itself is
 * stateless across requests; per-request state (the audit context)
 * lives on the bound `WorkspaceFileSystem` returned from `forRequest`.
 */
export function createWorkspaceFileSystemFactory(
  deps: CreateWorkspaceFileSystemFactoryDeps,
): WorkspaceFileSystemFactory {
  const boundWorkspaces = canonicalizeWorkspaces(deps.boundWorkspaces);
  if (boundWorkspaces.length === 0) {
    throw new Error('WorkspaceFileSystem requires at least one workspace root');
  }
  assertNoNestedWorkspaces(boundWorkspaces);
  const primaryWorkspace = boundWorkspaces[0]!;
  const workspaces = boundWorkspaces.map((workspace) => {
    const ignore =
      deps.ignore ??
      loadIgnoreRules({
        projectRoot: workspace,
        useGitignore: true,
        useQwenignore: true,
        ...(deps.customIgnoreFiles !== undefined
          ? { customIgnoreFiles: deps.customIgnoreFiles }
          : {}),
        ignoreDirs: [],
      });
    // Freeze each per-root `Ignore` instance so it cannot be mutated
    // after the factory builds it. The `Ignore` class exposes a public
    // `add(patterns): this` method that mutates state in-place; every
    // `forRequest()` returns a `WorkspaceFileSystemImpl` sharing these
    // same instances, so a future "ignore this pattern for this
    // session" feature calling `.add()` would silently corrupt
    // concurrent requests for that root.
    Object.freeze(ignore);
    return { path: workspace, ignore };
  });
  const audit: AuditPublisher = createAuditPublisher({
    emit: deps.emit,
    boundWorkspace: primaryWorkspace,
    includeRawPaths: deps.includeRawPaths,
  });
  const lowFs = new StandardFileSystemService();
  const pathLocks = deps.pathLocks ?? new PathMutexRegistry();
  const newFileMode: NewFileModePolicy = deps.newFileMode ?? 'owner';

  const forRequest = (ctx: RequestContext): WorkspaceFileSystem =>
    new WorkspaceFileSystemImpl({
      primaryWorkspace,
      workspaces,
      trusted: deps.trusted,
      audit,
      ctx,
      lowFs,
      pathLocks,
      generationGuard: deps.generationGuard,
      newFileMode,
    });

  return {
    assertCanWrite() {
      deps.generationGuard?.assertOpen();
      assertTrustedForIntent(deps.trusted, 'write');
    },
    forRequest,
    async writeSameHostToolText(ctx, request) {
      try {
        deps.generationGuard?.assertOpen();
      } catch (err) {
        throw recordSameHostToolWriteDenied(audit, ctx, request.path, err);
      }

      let resolved: ResolvedPath;
      try {
        resolved = await resolveWithinWorkspace(
          request.path,
          workspaces.map((workspace) => workspace.path),
          'write',
        );
        deps.generationGuard?.assertOpen();
      } catch (err) {
        if (
          !(err instanceof FsError && err.kind === 'path_outside_workspace')
        ) {
          throw recordSameHostToolWriteDenied(audit, ctx, request.path, err);
        }
        try {
          await writeSameHostToolTextOutsideWorkspace({
            request,
            trusted: deps.trusted,
            audit,
            ctx,
            pathLocks,
            generationGuard: deps.generationGuard,
            newFileMode,
          });
          return;
        } catch (outsideErr) {
          throw recordSameHostToolWriteDenied(
            audit,
            ctx,
            request.path,
            outsideErr,
          );
        }
      }

      try {
        await forRequest(ctx).writeTextOverwrite(resolved, request.content);
      } catch (err) {
        if (isWorkspaceGenerationClosedError(err)) {
          recordSameHostToolWriteDenied(audit, ctx, request.path, err);
        }
        throw err;
      }
    },
  };
}

interface SameHostToolTextWriteDeps {
  request: SameHostToolTextWriteRequest;
  trusted: boolean;
  audit: AuditPublisher;
  ctx: RequestContext;
  pathLocks: PathMutexRegistry;
  generationGuard?: Pick<WorkspaceGenerationGuard, 'assertOpen'>;
  /** New-file mode policy for the external host-writer route. */
  newFileMode: NewFileModePolicy;
}

async function writeSameHostToolTextOutsideWorkspace(
  deps: SameHostToolTextWriteDeps,
): Promise<void> {
  const start = performance.now();
  deps.generationGuard?.assertOpen();
  assertTrustedForIntent(deps.trusted, 'write');
  enforceWriteSize(Buffer.byteLength(deps.request.content, 'utf-8'));
  const target = await resolveSameHostToolWriteTarget(deps.request.path);
  await deps.pathLocks.runExclusive(target, async () => {
    deps.generationGuard?.assertOpen();
    const meta = mergeWriteMeta(undefined, deps.request.meta ?? {});
    const content =
      meta.bom && deps.request.content.charCodeAt(0) === 0xfeff
        ? deps.request.content.slice(1)
        : deps.request.content;
    const result = await atomicWriteTextResolvedFile({
      target,
      content,
      mode: 'overwrite',
      meta,
      newFileModeBits: resolveNewFileModeBits(deps.newFileMode),
      assertGenerationOpen: () => deps.generationGuard?.assertOpen(),
    });
    deps.audit.recordAccess(deps.ctx, {
      intent: 'write',
      absolute: target,
      durationMs: performance.now() - start,
      sizeBytes: result.sizeBytes,
    });
  });
}

async function resolveSameHostToolWriteTarget(input: string): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new FsError(
      'path_outside_workspace',
      `same-host external tool write requires an absolute path: ${input}`,
    );
  }
  if (hasSuspiciousPathPattern(input)) {
    throw new FsError(
      'path_outside_workspace',
      `path contains suspicious pattern: ${input}`,
    );
  }

  let leaf: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    leaf = await fsp.lstat(input);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
    const parent = await fsp.realpath(path.dirname(input));
    const parentStat = await fsp.lstat(parent);
    if (!parentStat.isDirectory()) {
      throw new FsError(
        'parse_error',
        `parent path is not a directory: ${parent}`,
      );
    }
    return path.join(parent, path.basename(input));
  }

  if (leaf.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path is a symlink and cannot be overwritten: ${input}`,
      { hint: 'resolve the target explicitly before writing' },
    );
  }
  if (!leaf.isFile()) {
    throw new FsError('parse_error', `path is not a regular file: ${input}`);
  }
  const canonical = await fsp.realpath(input);
  const canonicalStat = await fsp.lstat(canonical);
  if (!canonicalStat.isFile()) {
    throw new FsError(
      'parse_error',
      `canonical path is not a regular file: ${canonical}`,
    );
  }
  assertSameFile(leaf, canonicalStat, input, 'write');
  return canonical;
}

function isWorkspaceGenerationClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'workspace_generation_closed'
  );
}

function recordSameHostToolWriteDenied(
  audit: AuditPublisher,
  ctx: RequestContext,
  input: string,
  error: unknown,
): Error {
  const fsError = wrapAsFsError(error);
  audit.recordDenied(ctx, {
    intent: 'write',
    input,
    errorKind: fsError.kind,
    hint: fsError.hint,
    message: fsError.message,
  });
  return isWorkspaceGenerationClosedError(error) && error instanceof Error
    ? error
    : fsError;
}

interface WorkspaceRoot {
  path: string;
  ignore: Ignore;
}

interface ImplDeps {
  primaryWorkspace: string;
  workspaces: readonly WorkspaceRoot[];
  trusted: boolean;
  audit: AuditPublisher;
  ctx: RequestContext;
  lowFs: StandardFileSystemService;
  pathLocks: PathMutexRegistry;
  generationGuard?: Pick<WorkspaceGenerationGuard, 'assertOpen'>;
  /** Mode policy for NEW files created by text writes. */
  newFileMode: NewFileModePolicy;
}

function assertNoNestedWorkspaces(workspaces: readonly string[]): void {
  for (let i = 0; i < workspaces.length; i++) {
    const a = workspaces[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < workspaces.length; j++) {
      const b = workspaces[j];
      if (b === undefined) continue;
      if (isWithinRoot(a, b) || isWithinRoot(b, a)) {
        throw new Error(
          `Nested workspace roots are not supported: ${JSON.stringify(
            a,
          )} and ${JSON.stringify(b)}`,
        );
      }
    }
  }
}

class WorkspaceFileSystemImpl implements WorkspaceFileSystem {
  constructor(private readonly deps: ImplDeps) {}

  private workspaceForPath(p: string): WorkspaceRoot | undefined {
    let match: WorkspaceRoot | undefined;
    for (const workspace of this.deps.workspaces) {
      if (
        isWithinRoot(p, workspace.path) &&
        (match === undefined || workspace.path.length > match.path.length)
      ) {
        match = workspace;
      }
    }
    return match;
  }

  private ignoreVerdict(
    p: ResolvedPath,
    kind: 'file' | 'directory' = 'file',
  ): IgnoreVerdict {
    const workspace = this.workspaceForPath(p as string);
    if (!workspace) return { ignored: false };
    return shouldIgnore(p, workspace.path, workspace.ignore, kind);
  }

  async resolve(input: string, intent: Intent): Promise<ResolvedPath> {
    try {
      this.deps.generationGuard?.assertOpen();
      const resolved = await resolveWithinWorkspace(
        input,
        this.deps.workspaces.map((workspace) => workspace.path),
        intent,
      );
      this.deps.generationGuard?.assertOpen();
      return resolved;
    } catch (err) {
      throw this.recordAndWrap(err, intent, input);
    }
  }

  async stat(p: ResolvedPath): Promise<FsStat> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'stat');
      const st = await fsp.lstat(p as string);
      this.deps.generationGuard?.assertOpen();
      const out: FsStat = {
        kind: kindFromStatLike(st),
        sizeBytes: st.size,
        modifiedMs: st.mtimeMs,
      };
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'stat',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: st.size,
      });
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'stat', p as string);
    }
  }

  async readText(
    p: ResolvedPath,
    opts: ReadTextOptions = {},
  ): Promise<{ content: string; meta: ReadMeta }> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'read');
      // Reject `opts.line` values that the docstring forbids
      // (positive integer required). Without this guard `Infinity`
      // (`Infinity > 1` is true; `Infinity - 1` is still
      // `Infinity`) and floats (`2.5 - 1 = 1.5`) flow through to
      // `readFileWithLineAndLimit` and degrade silently to weird
      // truncation behavior. `NaN` and `0` happen to work via the
      // falsy fallback but that's accidental — prefer an explicit
      // error.
      if (
        opts.line !== undefined &&
        (!Number.isSafeInteger(opts.line) || opts.line < 1)
      ) {
        throw new FsError(
          'parse_error',
          `line must be a positive integer, got ${opts.line}`,
        );
      }
      if (
        opts.limit !== undefined &&
        (!Number.isSafeInteger(opts.limit) || opts.limit < 1)
      ) {
        throw new FsError(
          'parse_error',
          `limit must be a positive integer, got ${opts.limit}`,
        );
      }
      // Both name a starting point; honouring one and ignoring the other
      // would silently return the wrong window.
      if (opts.cursor !== undefined && opts.line !== undefined) {
        throw new FsError(
          'parse_error',
          'cursor and line are mutually exclusive; a cursor already encodes where to resume',
        );
      }
      if (
        opts.maxBytes !== undefined &&
        (!Number.isSafeInteger(opts.maxBytes) ||
          opts.maxBytes < 1 ||
          opts.maxBytes > MAX_READ_BYTES)
      ) {
        throw new FsError(
          'parse_error',
          `maxBytes must be a positive integer in [1, ${MAX_READ_BYTES}], got ${opts.maxBytes}`,
        );
      }
      const snapshot = await readTextFromResolvedFile(p, opts, this.deps.lowFs);
      this.deps.generationGuard?.assertOpen();
      const ignoreVerdict = this.ignoreVerdict(p, 'file');
      const meta = snapshot.meta;
      if (ignoreVerdict.ignored) meta.matchedIgnore = ignoreVerdict.category;
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'read',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: meta.sizeBytes,
        truncated: meta.truncated,
        matchedIgnore: meta.matchedIgnore,
      });
      return { content: snapshot.content, meta };
    } catch (err) {
      throw this.recordAndWrap(err, 'read', p as string);
    }
  }

  async readBytes(
    p: ResolvedPath,
    opts: ReadBytesOptions = {},
  ): Promise<Buffer> {
    const out = await this.readBytesWindow(p, opts);
    return out.buffer;
  }

  async readBytesWindow(
    p: ResolvedPath,
    opts: ReadBytesOptions = {},
  ): Promise<ReadBytesOutcome> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'read');
      const offset = opts.offset ?? 0;
      const maxBytes = opts.maxBytes ?? MAX_READ_BYTES;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new FsError(
          'parse_error',
          `offset must be a non-negative integer, got ${offset}`,
        );
      }
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_READ_BYTES
      ) {
        throw new FsError(
          'parse_error',
          `maxBytes must be a positive integer in [1, ${MAX_READ_BYTES}], got ${maxBytes}`,
        );
      }
      const pre = await fsp.lstat(p as string);
      if (!pre.isFile()) {
        throw new FsError('parse_error', `path is not a regular file: ${p}`);
      }
      const fh = await fsp.open(p as string, 'r');
      let st: Awaited<ReturnType<typeof fh.stat>>;
      let buf: Buffer;
      try {
        st = await fh.stat();
        assertSameFile(pre, st, p as string, 'read');
        const available = Math.max(0, st.size - offset);
        const toRead = Math.min(maxBytes, available);
        buf = Buffer.allocUnsafe(toRead);
        if (toRead > 0) {
          const read = await fh.read(buf, 0, toRead, offset);
          buf =
            read.bytesRead === toRead ? buf : buf.subarray(0, read.bytesRead);
        }
        // Bind the returned bytes to a stable on-disk snapshot: an
        // in-place rewrite (size unchanged, content changed) or
        // append/truncate between the pre-stat and read would
        // otherwise leave us with a buffer that no longer matches
        // the file. Mirror `readStableRegularFileBuffer` and require
        // ino+size+mtime to be unchanged on the same fd before
        // emitting the response — clients use the full-window hash
        // as an optimistic-concurrency token, so a stale snapshot
        // must surface as a retryable `hash_mismatch`.
        const afterRead = await fh.stat();
        assertSameFile(st, afterRead, p as string, 'read');
        if (afterRead.size !== st.size || afterRead.mtimeMs !== st.mtimeMs) {
          throw new FsError('hash_mismatch', `file changed during read: ${p}`, {
            hint: 'retry after re-reading the latest file hash',
          });
        }
      } finally {
        await fh.close();
      }
      await assertInodeStableAfterRead(p as string, st.ino);
      this.deps.generationGuard?.assertOpen();
      const fullWindow = offset === 0 && buf.length === st.size;
      const out: ReadBytesOutcome = {
        buffer: buf,
        sizeBytes: st.size,
        returnedBytes: buf.length,
        offset,
        truncated: !fullWindow,
        ...(fullWindow ? { hash: hashBuffer(buf) } : {}),
      };
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'read',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: buf.length,
        truncated: out.truncated,
      });
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'read', p as string);
    }
  }

  async list(p: ResolvedPath, opts: ListOptions = {}): Promise<FsEntry[]> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'list');
      // Reject malformed caps the same way readText() guards `limit`/`line`:
      // an unvalidated Infinity/NaN/float/0/negative makes the
      // `entries.length >= opts.maxEntries` break check silently wrong.
      if (
        opts.maxEntries !== undefined &&
        (!Number.isSafeInteger(opts.maxEntries) || opts.maxEntries < 1)
      ) {
        throw new FsError(
          'parse_error',
          `maxEntries must be a positive integer, got ${opts.maxEntries}`,
        );
      }
      const entries: FsEntry[] = [];
      const dir = await fsp.opendir(p as string);
      for await (const d of dir) {
        this.deps.generationGuard?.assertOpen();
        // `path.join(p, d.name)` is a shallow extension of an
        // already-canonical workspace path. Symlinked dirents are
        // tagged as `kind: 'symlink'` rather than auto-followed —
        // callers that want the target's containment can call
        // `resolve()` separately. Treating each child as
        // implicitly-resolved here would be a brand-cast bypass.
        const childAbs = path.join(p as string, d.name);
        const kind = kindFromStatLike(d);
        const verdict = this.ignoreVerdict(
          childAbs as ResolvedPath,
          kind === 'directory' ? 'directory' : 'file',
        );
        if (verdict.ignored && !opts.includeIgnored) continue;
        entries.push({ name: d.name, kind, ignored: verdict.ignored });
        if (
          opts.maxEntries !== undefined &&
          entries.length >= opts.maxEntries
        ) {
          break;
        }
      }
      this.deps.generationGuard?.assertOpen();
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'list',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: entries.length,
        truncated:
          opts.maxEntries !== undefined && entries.length >= opts.maxEntries,
      });
      return entries;
    } catch (err) {
      throw this.recordAndWrap(err, 'list', p as string);
    }
  }

  async glob(pattern: string, opts: GlobOptions = {}): Promise<ResolvedPath[]> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'glob');
      // Reject patterns up-front before delegating to `glob` — the
      // per-hit filter below catches escapes after the walk, but
      // letting a clearly out-of-workspace pattern reach `globAsync`
      // burns I/O *outside* the workspace before we drop the
      // results. Three rejection classes:
      //   1. `..` segments  — would let `cwd` be escaped lexically.
      //   2. POSIX absolute (`/etc/**`) — `glob` rooted outside cwd.
      //   3. Windows-style absolute / device prefixes (`C:\…`,
      //      `\\?\…`, `\\server\share`) — same hazard on the other
      //      platform. `path.isAbsolute` covers POSIX `/`; the
      //      drive-letter / UNC checks cover Win32 even when the
      //      daemon runs on POSIX (clients may send Win32 paths).
      if (pattern.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new FsError(
          'parse_error',
          `glob pattern may not contain '..' segments: ${pattern}`,
        );
      }
      if (
        path.isAbsolute(pattern) ||
        /^[A-Za-z]:[\\/]/.test(pattern) ||
        pattern.startsWith('\\\\') ||
        pattern.startsWith('//')
      ) {
        throw new FsError(
          'parse_error',
          `glob pattern must be workspace-relative: ${pattern}`,
          { hint: 'pass a relative pattern such as "src/**/*.ts"' },
        );
      }
      const searchRoots: Array<{ cwd: string; workspace: WorkspaceRoot }> = [];
      if (opts.cwd === undefined) {
        for (const workspace of this.deps.workspaces) {
          searchRoots.push({ cwd: workspace.path, workspace });
        }
      } else {
        const cwd = opts.cwd as string;
        let cwdReal: string;
        const directWorkspace = this.workspaceForPath(cwd);
        if (directWorkspace && cwd === directWorkspace.path) {
          cwdReal = cwd;
        } else {
          // `opts.cwd` is typed `ResolvedPath` but a brand cast in
          // calling code can produce a path that's never been verified.
          // Realpath before walking so `<ws>/link -> /etc` is rejected
          // before `globAsync` can enumerate outside the workspace.
          try {
            cwdReal = await fsp.realpath(path.resolve(cwd));
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') {
              throw new FsError(
                'path_not_found',
                `glob cwd does not exist: ${cwd}`,
                { cause: err },
              );
            }
            throw err;
          }
        }
        const workspace = this.workspaceForPath(cwdReal);
        if (!workspace) {
          throw new FsError(
            'path_outside_workspace',
            `glob cwd is outside workspace: ${cwd}`,
            { hint: 'opts.cwd must be a path obtained from fs.resolve()' },
          );
        }
        searchRoots.push({ cwd: cwdReal, workspace });
      }
      // Pass an `ignore` option so the glob library prunes
      // common-and-huge directories at traversal time. Without
      // this, `glob('**/*')` in a typical workspace walks every
      // file under `node_modules/` and `.git/` (often hundreds
      // of thousands of paths) before our per-hit `realpath` +
      // `lstat` filter drops them. The post-filter via
      // `shouldIgnore` is still authoritative — this is purely a
      // walk-time optimization that aligns with the
      // `loadIgnoreRules` defaults (which already include `.git`
      // as a default ignore dir).
      const out: ResolvedPath[] = [];
      const seenCanonicals = new Set<string>();
      const max = opts.maxResults ?? Number.POSITIVE_INFINITY;
      let escapedCount = 0;
      let permissionErrorCount = 0;
      let transientErrorCount = 0;
      const globErrors: unknown[] = [];
      let successfulGlobRoots = 0;
      for (const searchRoot of searchRoots) {
        this.deps.generationGuard?.assertOpen();
        if (out.length >= max) break;
        let matches: string[];
        try {
          await fsp.access(searchRoot.cwd, fsConstants.R_OK | fsConstants.X_OK);
          const rootStat = await fsp.stat(searchRoot.cwd);
          if (!rootStat.isDirectory()) {
            const err = new Error(
              `glob workspace root is not a directory: ${searchRoot.cwd}`,
            ) as NodeJS.ErrnoException;
            err.code = 'ENOTDIR';
            throw err;
          }
          matches = await globAsync(pattern, {
            cwd: searchRoot.cwd,
            nodir: false,
            absolute: true,
            dot: true,
            ignore: ['**/node_modules/**', '**/.git/**'],
          });
        } catch (err) {
          globErrors.push(err);
          this.deps.audit.recordDenied(this.deps.ctx, {
            intent: 'glob',
            input: pattern,
            errorKind: errorKindForRealpathFailure(err),
            hint: `glob failed for workspace root: ${errorCode(err) ?? 'unknown error'}`,
            pattern,
          });
          continue;
        }
        successfulGlobRoots += 1;
        for (const hit of matches) {
          this.deps.generationGuard?.assertOpen();
          if (out.length >= max) break;
          const absolute = path.resolve(hit);
          // Per-hit boundary check defends against a glob that
          // matches a symlink whose target escapes the workspace.
          // The literal path is in-workspace (the symlink itself
          // sits there), but the realpath isn't — so we resolve
          // each hit's symlink chain and compare the canonical to
          // the canonical workspace root.
          let canonical: string;
          try {
            canonical = await fsp.realpath(absolute);
          } catch (err) {
            const code = errorCode(err);
            if (code === 'ENOENT' || code === 'ELOOP') {
              escapedCount += 1;
            } else if (code === 'EACCES' || code === 'EPERM') {
              permissionErrorCount += 1;
            } else {
              transientErrorCount += 1;
            }
            continue;
          }
          const inAnyWorkspace = this.deps.workspaces.some((workspace) =>
            isWithinRoot(canonical, workspace.path),
          );
          if (!inAnyWorkspace) {
            escapedCount += 1;
            continue;
          }
          if (seenCanonicals.has(canonical)) continue;
          // Check the dirent kind so directory ignore rules (`dist/`,
          // `.git/`, `node_modules/`) actually match — `shouldIgnore`
          // probes `<rel>/` for the directory filter, which the
          // underlying `ignore` library requires for trailing-slash
          // patterns. Probing every hit as a `file` (the prior
          // behavior) silently leaks ignored directories from
          // `glob('**/*')` even when `includeIgnored` is false. We
          // already realpath'd the hit, so an extra `lstat` here is
          // cheap; on `lstat` failure (raced unlink) we conservatively
          // treat the hit as a file so the file-pattern check still
          // runs.
          let dirent: { isDirectory(): boolean } | null = null;
          try {
            dirent = await fsp.lstat(canonical);
          } catch {
            dirent = null;
          }
          const kind = dirent?.isDirectory() ? 'directory' : 'file';
          const verdict = this.ignoreVerdict(canonical as ResolvedPath, kind);
          if (verdict.ignored && !opts.includeIgnored) continue;
          seenCanonicals.add(canonical);
          out.push(canonical as ResolvedPath);
        }
      }
      if (globErrors.length > 0 && successfulGlobRoots === 0) {
        if (globErrors.length === 1) throw globErrors[0];
        throw new AggregateError(
          globErrors,
          'glob failed for all workspace roots',
        );
      }
      if (escapedCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          errorKind: 'symlink_escape',
          hint: `glob filtered ${escapedCount} hit(s) that resolved outside workspace`,
          pattern,
        });
      }
      if (permissionErrorCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          errorKind: 'permission_denied',
          hint: `glob skipped ${permissionErrorCount} hit(s) due to EACCES/EPERM`,
          pattern,
        });
      }
      if (transientErrorCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          errorKind: 'io_error',
          hint: `glob skipped ${transientErrorCount} hit(s) due to transient I/O errors`,
          pattern,
        });
      }
      this.deps.generationGuard?.assertOpen();
      // `absolute: primaryWorkspace` (rather than `cwd`) ties every
      // glob audit row's `pathHash` to the workspace itself.
      // The literal `pattern` field is the per-call signal;
      // `pathHash` is the workspace marker operators correlate
      // across audit rows.
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'glob',
        absolute: this.deps.primaryWorkspace,
        durationMs: performance.now() - start,
        sizeBytes: out.length,
        pattern,
      });
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'glob', pattern);
    }
  }

  async writeTextAtomic(
    p: ResolvedPath,
    content: string,
    opts: WriteTextAtomicOptions,
  ): Promise<WriteTextAtomicOutcome> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'write');
      validateWriteTextAtomicOptions(opts);
      const decodedSizeBytes = Buffer.byteLength(content, 'utf-8');
      enforceWriteSize(decodedSizeBytes);
      const out = await this.deps.pathLocks.runExclusive(
        p as string,
        async () => {
          const existingMeta =
            opts.mode === 'replace'
              ? await readExistingTextMeta(p, opts.expectedHash)
              : undefined;
          if (opts.mode === 'create') {
            await assertCreateTargetAbsent(p as string);
          }
          this.deps.generationGuard?.assertOpen();
          const meta = mergeWriteMeta(existingMeta, opts);
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content,
            mode: opts.mode,
            expectedHash: opts.expectedHash,
            meta,
            newFileModeBits: resolveNewFileModeBits(this.deps.newFileMode),
            assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
          });
          const verdict = this.ignoreVerdict(p, 'file');
          if (verdict.ignored) meta.matchedIgnore = verdict.category;
          meta.sizeBytes = result.sizeBytes;
          meta.hash = result.hash;
          this.deps.audit.recordAccess(this.deps.ctx, {
            intent: 'write',
            absolute: p,
            durationMs: performance.now() - start,
            sizeBytes: result.sizeBytes,
            matchedIgnore: meta.matchedIgnore,
          });
          return {
            created: opts.mode === 'create',
            sizeBytes: result.sizeBytes,
            hash: result.hash,
            meta,
          };
        },
      );
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'write', p as string);
    }
  }

  async writeTextOverwrite(
    p: ResolvedPath,
    content: string,
    opts: WriteTextFileOptions = {},
  ): Promise<WriteTextAtomicOutcome> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'write');
      const decodedSizeBytes = Buffer.byteLength(content, 'utf-8');
      enforceWriteSize(decodedSizeBytes);
      const out = await this.deps.pathLocks.runExclusive(
        p as string,
        async () => {
          // Determine `created` from a stat — NOT from whether the meta
          // read succeeded. The meta read is best-effort and can fail
          // on existing files (file_too_large, binary_file); those still
          // count as "the target existed", so `created: false`.
          // ENOENT here means "no entry at the target" → `created: true`.
          let targetExisted = false;
          try {
            await fsp.lstat(p as string);
            targetExisted = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              throw err;
            }
          }
          // Best-effort read of existing meta so we preserve detected
          // encoding / BOM / line-ending across overwrites — matches the
          // posture of `writeTextAtomic({mode:'replace'})` whose existing
          // meta is sourced the same way. ENOENT (new file) leaves
          // `existingMeta` undefined and `mergeWriteMeta` falls back to
          // its UTF-8 / no-BOM / lf defaults.
          let existingMeta: ReadMeta | undefined;
          try {
            existingMeta = await readExistingTextMeta(p);
          } catch (err) {
            // The meta read is best-effort — we only need it to preserve
            // encoding / BOM / line-ending hints across overwrites. The
            // overwrite itself never needs the existing content, so any
            // failure to read it must NOT block the write:
            //   - ENOENT          → new file, no meta to preserve (UTF-8/LF defaults)
            //   - EACCES / EPERM  → daemon can't read (e.g. 0o000 or
            //                       other-user-owned); the actual write
            //                       may still succeed if the parent dir
            //                       grants write. Bubbling here would
            //                       both regress pre-PR behavior AND let
            //                       agents probe file readability by
            //                       observing EACCES on overwrite.
            //   - file_too_large  → existing is >256 KiB; fall back to defaults
            //   - binary_file     → existing is binary; text meta is meaningless
            // Pre-PR, ACP `BridgeClient.writeTextFile` never read the
            // existing file at all, so a 1 MiB log, binary config, or
            // unreadable secret could always be overwritten by an agent
            // (subject only to the parent dir's write permission).
            // Bubbling any of these here would silently regress that.
            const code = (err as NodeJS.ErrnoException)?.code;
            const kind = (err as { kind?: string })?.kind;
            if (
              code !== 'ENOENT' &&
              code !== 'EACCES' &&
              code !== 'EPERM' &&
              kind !== 'file_too_large' &&
              kind !== 'binary_file'
            ) {
              throw err;
            }
          }
          this.deps.generationGuard?.assertOpen();
          const meta = mergeWriteMeta(existingMeta, opts);
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content,
            mode: 'overwrite',
            meta,
            newFileModeBits: resolveNewFileModeBits(this.deps.newFileMode),
            assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
          });
          const verdict = this.ignoreVerdict(p, 'file');
          if (verdict.ignored) meta.matchedIgnore = verdict.category;
          meta.sizeBytes = result.sizeBytes;
          meta.hash = result.hash;
          this.deps.audit.recordAccess(this.deps.ctx, {
            intent: 'write',
            absolute: p,
            durationMs: performance.now() - start,
            sizeBytes: result.sizeBytes,
            matchedIgnore: meta.matchedIgnore,
          });
          return {
            created: !targetExisted,
            sizeBytes: result.sizeBytes,
            hash: result.hash,
            meta,
          };
        },
      );
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'write', p as string);
    }
  }

  async writeText(
    p: ResolvedPath,
    content: string,
    opts?: WriteTextFileOptions,
  ): Promise<void> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'write');
      // `Buffer.byteLength` returns the UTF-8 byte count without
      // allocating a Buffer. The earlier `Buffer.from(content,
      // 'utf-8')` materialized the entire payload (up to
      // `MAX_WRITE_BYTES = 5 MiB`) just to read its `.length`,
      // wasting heap on every write.
      const sizeBytes = Buffer.byteLength(content, 'utf-8');
      enforceWriteSize(sizeBytes);
      // Pre-write TOCTOU guard — `atomicWriteFile`'s
      // `resolveSymlinkChain` follows symlinks at write time, so
      // a swap between the boundary's `resolve()` and this call
      // would land the write outside the workspace. ENOENT is
      // fine (ahead-of-create flow); an actual symlink is
      // rejected.
      await assertNotSymlinkBeforeWrite(p as string);
      this.deps.generationGuard?.assertOpen();
      await this.deps.lowFs.writeTextFile({
        path: p as string,
        content,
        _meta: opts ? buildWriteMeta(opts) : undefined,
      });
      const verdict = this.ignoreVerdict(p, 'file');
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'write',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes,
        matchedIgnore: verdict.ignored ? verdict.category : undefined,
      });
    } catch (err) {
      throw this.recordAndWrap(err, 'write', p as string);
    }
  }

  async editAtomic(
    p: ResolvedPath,
    oldText: string,
    newText: string,
    opts: { expectedHash: ContentHash },
  ): Promise<WriteOutcome> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'edit');
      if (!isContentHash(opts.expectedHash)) {
        throw new FsError(
          'parse_error',
          'expectedHash must match sha256:<64 lowercase hex chars>',
        );
      }
      if (typeof oldText !== 'string' || oldText.length === 0) {
        throw new FsError(
          'parse_error',
          `oldText must be a non-empty string for edit on ${p}`,
        );
      }
      if (typeof newText !== 'string') {
        throw new FsError('parse_error', 'newText must be a string');
      }
      const out = await this.deps.pathLocks.runExclusive(
        p as string,
        async () => {
          const snapshot = await readTextSnapshotFromResolvedFile(p);
          if (snapshot.meta.hash !== opts.expectedHash) {
            throw new FsError(
              'hash_mismatch',
              `expected ${opts.expectedHash}, found ${snapshot.meta.hash}`,
              { hint: 're-read the file and retry with the latest hash' },
            );
          }
          const current = snapshot.content;
          const occurrences = countOccurrences(current, oldText);
          if (occurrences === 0) {
            const snippet =
              oldText.length > 80 ? oldText.slice(0, 80) + '...' : oldText;
            throw new FsError('text_not_found', `oldText not found in ${p}`, {
              hint: `searched for: ${JSON.stringify(snippet)}`,
            });
          }
          if (occurrences > 1) {
            throw new FsError(
              'ambiguous_text_match',
              `oldText appears ${occurrences} times in ${p}`,
              {
                hint: 'pass a larger oldText span that occurs exactly once',
              },
            );
          }
          const idx = current.indexOf(oldText);
          const next =
            current.slice(0, idx) +
            newText +
            current.slice(idx + oldText.length);
          enforceWriteSize(Buffer.byteLength(next, 'utf-8'));
          this.deps.generationGuard?.assertOpen();
          const meta = mergeWriteMeta(snapshot.meta, {});
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content: next,
            mode: 'replace',
            expectedHash: opts.expectedHash,
            meta,
            newFileModeBits: resolveNewFileModeBits(this.deps.newFileMode),
            assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
          });
          const verdict = this.ignoreVerdict(p, 'file');
          if (verdict.ignored) meta.matchedIgnore = verdict.category;
          meta.sizeBytes = result.sizeBytes;
          meta.hash = result.hash;
          this.deps.audit.recordAccess(this.deps.ctx, {
            intent: 'edit',
            absolute: p,
            durationMs: performance.now() - start,
            sizeBytes: result.sizeBytes,
            matchedIgnore: meta.matchedIgnore,
          });
          return {
            writtenBytes: result.sizeBytes,
            hash: result.hash,
            meta,
          };
        },
      );
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'edit', p as string);
    }
  }

  async edit(
    p: ResolvedPath,
    oldText: string,
    newText: string,
    opts?: { expectedHash?: ContentHash },
  ): Promise<WriteOutcome> {
    if (opts?.expectedHash !== undefined) {
      return this.editAtomic(p, oldText, newText, {
        expectedHash: opts.expectedHash,
      });
    }
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'edit');
      if (oldText.length === 0) {
        throw new FsError(
          'parse_error',
          `oldText must be a non-empty string for edit on ${p}`,
          {
            hint: 'empty oldText would match at position 0 and silently prepend newText',
          },
        );
      }
      return await this.deps.pathLocks.runExclusive(p as string, async () => {
        const snapshot = await readTextSnapshotFromResolvedFile(p);
        const current = snapshot.content;
        const idx = current.indexOf(oldText);
        if (idx === -1) {
          const snippet =
            oldText.length > 80 ? oldText.slice(0, 80) + '…' : oldText;
          throw new FsError('parse_error', `oldText not found in ${p}`, {
            hint: `edit() expects oldText to appear verbatim; searched for: ${JSON.stringify(snippet)}`,
          });
        }
        const next =
          current.slice(0, idx) + newText + current.slice(idx + oldText.length);
        const writtenBytes = Buffer.byteLength(next, 'utf-8');
        enforceWriteSize(writtenBytes);
        this.deps.generationGuard?.assertOpen();
        const result = await atomicWriteTextResolvedFile({
          target: p,
          content: next,
          mode: 'overwrite',
          meta: mergeWriteMeta(snapshot.meta, {}),
          newFileModeBits: resolveNewFileModeBits(this.deps.newFileMode),
          assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
        });
        const verdict = this.ignoreVerdict(p, 'file');
        this.deps.audit.recordAccess(this.deps.ctx, {
          intent: 'edit',
          absolute: p,
          durationMs: performance.now() - start,
          sizeBytes: result.sizeBytes,
          matchedIgnore: verdict.ignored ? verdict.category : undefined,
        });
        return { writtenBytes: result.sizeBytes };
      });
    } catch (err) {
      throw this.recordAndWrap(err, 'edit', p as string);
    }
  }

  async writeBytesAtomic(
    p: ResolvedPath,
    data: Buffer,
  ): Promise<{ sizeBytes: number; hash: ContentHash }> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'write');
      enforceWriteSize(data.length, MAX_UPLOAD_BYTES);
      const out = await this.deps.pathLocks.runExclusive(
        p as string,
        async () => {
          await assertCreateTargetAbsent(p as string);
          this.deps.generationGuard?.assertOpen();
          const result = await atomicPublishResolvedFile({
            target: p,
            buf: data,
            mode: 'create',
            assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
          });
          const verdict = this.ignoreVerdict(p, 'file');
          this.deps.audit.recordAccess(this.deps.ctx, {
            intent: 'write',
            absolute: p,
            durationMs: performance.now() - start,
            sizeBytes: result.sizeBytes,
            matchedIgnore: verdict.ignored ? verdict.category : undefined,
          });
          return { sizeBytes: result.sizeBytes, hash: result.hash };
        },
      );
      return out;
    } catch (err) {
      // A no-clobber collision is the upload route's expected candidate-loop
      // outcome (it numbers on), not a boundary policy denial; auditing it
      // would emit one `fs.denied` per skipped occupied name.
      throw this.recordAndWrap(err, 'write', p as string, {
        audit: !(isFsError(err) && err.kind === 'file_already_exists'),
      });
    }
  }

  async mkdir(p: ResolvedPath, opts?: { recursive?: boolean }): Promise<void> {
    const start = performance.now();
    try {
      this.deps.generationGuard?.assertOpen();
      assertTrustedForIntent(this.deps.trusted, 'write');
      const out = await this.deps.pathLocks.runExclusive(
        p as string,
        async () => {
          await ensureResolvedDirectory(p as string, {
            recursive: opts?.recursive ?? false,
            assertGenerationOpen: () => this.deps.generationGuard?.assertOpen(),
          });
          this.deps.generationGuard?.assertOpen();
          const verdict = this.ignoreVerdict(p, 'directory');
          this.deps.audit.recordAccess(this.deps.ctx, {
            intent: 'write',
            absolute: p,
            durationMs: performance.now() - start,
            sizeBytes: 0,
            operation: 'mkdir',
            matchedIgnore: verdict.ignored ? verdict.category : undefined,
          });
          return undefined;
        },
      );
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'write', p as string);
    }
  }

  /**
   * Coerce an arbitrary thrown value into an `FsError`, emit the
   * matching `fs.denied` audit event, and return the typed error
   * for the caller to rethrow. Body methods invoke this in their
   * `catch` so:
   *   - raw fs errnos (`EACCES`, `ENOTDIR`, …) get categorized
   *     instead of escaping as opaque 5xx,
   *   - the audit log records every failure (the prior helper
   *     early-returned for non-`FsError`s and silently lost the
   *     event), and
   *   - routes can still rely on `instanceof FsError`
   *     for their `sendFsError` serializer.
   */
  private recordAndWrap(
    err: unknown,
    intent: Intent,
    input: string,
    opts?: { audit?: boolean },
  ): Error {
    if (
      err instanceof Error &&
      'code' in err &&
      err.code === 'workspace_generation_closed'
    ) {
      return err;
    }
    const fs = wrapAsFsError(err);
    if (opts?.audit === false) {
      return fs;
    }
    this.deps.audit.recordDenied(this.deps.ctx, {
      intent,
      input,
      errorKind: fs.kind,
      hint: fs.hint,
      // Quote the underlying OS / FsError message so audit
      // consumers debugging a production incident can see the
      // actual cause (errno text, byte counts, glob pattern,
      // etc.) rather than just `errorKind` + `hint`.
      message: fs.message,
      // For glob denials (parse_error pattern rejection,
      // catastrophic walk failures) the input IS the pattern
      // already; surfacing it on the dedicated `pattern` field
      // keeps the schema parallel with successful `recordAccess`
      // glob rows so consumers can `data.pattern` without
      // branching on intent.
      pattern: intent === 'glob' ? input : undefined,
    });
    return fs;
  }
}

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && CONTENT_HASH_RE.test(value);
}

interface AtomicWriteTextInput {
  target: string;
  content: string;
  mode: WriteMode;
  expectedHash?: ContentHash;
  meta: ReadMeta;
  /**
   * Mode bits for a NEW target (existing targets always preserve their
   * on-disk mode). Undefined falls back to the owner-only `0o600`
   * default; callers wired with a `NewFileModePolicy` pass
   * `resolveNewFileModeBits(policy)` here.
   */
  newFileModeBits?: number;
  assertGenerationOpen?: () => void;
}

interface AtomicWriteTextOutcome {
  sizeBytes: number;
  hash: ContentHash;
  stat: Awaited<ReturnType<typeof fsp.lstat>>;
}

function validateWriteTextAtomicOptions(opts: WriteTextAtomicOptions): void {
  // `'overwrite'` is intentionally rejected here even though the
  // `WriteMode` union admits it. The `'overwrite'` variant skips the
  // expectedHash CAS gate AND requires the caller to handle existing
  // text-meta detection (encoding/BOM/line-ending preservation) and
  // the `created` outcome flag — none of which `writeTextAtomic`'s
  // existing branches do. Direct callers of `writeTextAtomic({mode:
  // 'overwrite'})` would silently lose CRLF on Windows files and
  // report `created: false` for new files. The dedicated
  // `writeTextOverwrite()` method handles those correctly and is the
  // only supported entry point for unconditional-overwrite semantics.
  if (opts.mode !== 'create' && opts.mode !== 'replace') {
    throw new FsError(
      'parse_error',
      'mode must be either "create" or "replace" (use writeTextOverwrite() for unconditional overwrites)',
    );
  }
  if (opts.expectedHash !== undefined && !isContentHash(opts.expectedHash)) {
    throw new FsError(
      'parse_error',
      'expectedHash must match sha256:<64 lowercase hex chars>',
    );
  }
  if (opts.mode === 'replace' && opts.expectedHash === undefined) {
    throw new FsError(
      'parse_error',
      'expectedHash is required when mode is "replace"',
    );
  }
  if (
    opts.lineEnding !== undefined &&
    opts.lineEnding !== 'lf' &&
    opts.lineEnding !== 'crlf'
  ) {
    throw new FsError('parse_error', 'lineEnding must be "lf" or "crlf"');
  }
}

interface TextReadOutcome {
  content: string;
  meta: ReadMeta & { sizeBytes: number };
}

interface TextSnapshot extends TextReadOutcome {
  meta: ReadMeta & { hash: ContentHash; sizeBytes: number };
}

async function readTextFromResolvedFile(
  p: ResolvedPath,
  opts: ReadTextOptions,
  lowFs: StandardFileSystemService,
): Promise<TextReadOutcome> {
  const pre = await fsp.lstat(p as string);
  if (pre.isSymbolicLink()) {
    throw new FsError('symlink_escape', `path is a symlink: ${p}`, {
      hint: 're-resolve the target file instead of reading through a link',
    });
  }
  if (!pre.isFile()) {
    throw new FsError('parse_error', `path is not a regular file: ${p}`);
  }

  // Any explicit window argument is the caller stating it accepts partial
  // content, which is what the large-file path returns. Gating on `limit`
  // alone got this backwards in both directions: `{ line: 900_000_000,
  // limit: 20 }` was admitted despite costing a full scan, while
  // `{ maxBytes: 4096 }` — satisfiable from the first 4 KiB — was refused.
  // Cost is bounded by MAX_TEXT_SCAN_BYTES, not by which knob was set.
  //
  // A read with no window argument at all still fails: an agent that
  // believes it holds the whole file may write it back truncated. The
  // omitted `hash` blocks that for `editText`/`writeTextAtomic`, but
  // `writeTextOverwrite` takes no hash, so `truncated: true` is the only
  // signal on that path — refusing the unbounded read keeps the caller
  // from ever being in that position by accident.
  // Cursor reads branch before the size check, not by widening `wantsWindow`.
  // Adding `cursor` there would fix only large files: a cursor read of a file
  // *under* MAX_READ_BYTES would still land on the snapshot path, which knows
  // only `line`/`limit` and would silently ignore the cursor and return from
  // line 0 — a wrong answer, worse than the refusal the large case would give.
  if (opts.cursor !== undefined) {
    return readTextCursorWindowFromResolvedFile(p, pre, opts, lowFs);
  }

  const wantsWindow =
    opts.limit !== undefined ||
    opts.maxBytes !== undefined ||
    opts.line !== undefined;
  if (pre.size > MAX_READ_BYTES && wantsWindow) {
    return readLargeTextWindowFromResolvedFile(p, pre, opts, lowFs);
  }
  return readTextSnapshotFromResolvedFile(p, opts, pre);
}

async function readTextSnapshotFromResolvedFile(
  p: ResolvedPath,
  opts: ReadTextOptions = {},
  knownPre?: Awaited<ReturnType<typeof fsp.lstat>>,
): Promise<TextSnapshot> {
  const pre = knownPre ?? (await fsp.lstat(p as string));
  if (pre.isSymbolicLink()) {
    throw new FsError('symlink_escape', `path is a symlink: ${p}`, {
      hint: 're-resolve the target file instead of reading through a link',
    });
  }
  if (!pre.isFile()) {
    throw new FsError('parse_error', `path is not a regular file: ${p}`);
  }
  // Hard size gate before reading the full raw snapshot. Files above
  // this cap need a finite text line limit or an explicit
  // `readBytesWindow()` byte window instead of a full decoded snapshot.
  if (pre.size > MAX_READ_BYTES) {
    throw new FsError(
      'file_too_large',
      `file of ${pre.size} bytes exceeds read cap of ${MAX_READ_BYTES} bytes`,
      {
        hint: 'use a finite line limit for large UTF-8 text, or readBytes for explicit byte-windowed access',
      },
    );
  }

  const raw = await readStableRegularFileBuffer(p as string, pre);
  if (looksBinary(raw)) {
    throw new FsError('binary_file', `binary file: ${p}`, {
      hint: 'use readBytes for binary content',
    });
  }

  const decoded = await decodeBufferWithEncodingInfoAsync(raw);
  const startLineIndex = opts.line !== undefined ? opts.line - 1 : 0;
  const sliced = sliceDecodedText(
    decoded.content,
    startLineIndex,
    opts.limit ?? Number.POSITIVE_INFINITY,
  );
  const maxOutputBytes = opts.maxBytes ?? MAX_READ_BYTES;
  const sizeOutcome = enforceReadSize(raw.length, maxOutputBytes);
  let content = sliced.content;
  let byteTruncated = false;
  const meta: TextSnapshot['meta'] = {
    encoding: decoded.encoding,
    bom: decoded.bom,
    // Detected across the whole decoded file, not the returned slice. A slice
    // holding one CRLF line arrives as text ending in '\r' with the '\n'
    // consumed as its terminator, so testing the slice reports 'lf' — and one
    // page of a cursor sequence would then disagree with the next about the
    // same file.
    lineEnding: detectLineEnding(decoded.content),
    sizeBytes: raw.length,
    originalLineCount: sliced.originalLineCount,
    hash: hashBuffer(raw),
  };

  const output = Buffer.from(content, 'utf-8');
  if (output.length > maxOutputBytes) {
    content = safeUtf8Truncate(output, maxOutputBytes).toString('utf-8');
    meta.truncated = true;
    byteTruncated = true;
  }
  if (sizeOutcome.truncated) {
    meta.truncated = true;
  }

  if (
    opts.limit !== undefined &&
    Number.isFinite(opts.limit) &&
    sliced.originalLineCount > opts.limit + startLineIndex
  ) {
    meta.truncated = true;
  }

  const pageableLineCount =
    sliced.originalLineCount - (decoded.content.endsWith('\n') ? 1 : 0);
  meta.hasMore = byteTruncated || sliced.endLine < pageableLineCount;
  // A byte offset into the file is only derivable when the decoded text and
  // the file agree byte-for-byte. For GBK, Shift_JIS, or UTF-16 the decoded
  // string is a UTF-8 re-encoding whose lengths are unrelated to the file's,
  // so a cursor built from it would point at the wrong byte. Such a read still
  // reports `hasMore` honestly — it has more to give, it just cannot be paged.
  // A byte-truncated slice ends mid-line, so there is no line start to resume
  // from; `hasMore` still says content remains. Every cursor this boundary
  // mints points at a line start, so a client following cursors never skips
  // the tail of a line it was only shown part of.
  const bomBytes = decoded.bom ? 3 : 0;
  const decodedBytesMatchSource =
    isUtf8CompatibleEncoding(decoded.encoding) &&
    Buffer.from(decoded.content, 'utf-8').equals(raw.subarray(bomBytes));
  if (meta.hasMore && !byteTruncated && decodedBytesMatchSource) {
    // `decodeBufferWithEncodingInfoAsync` strips the BOM, so decoded offsets
    // run short by its length. A BOM on a byte-compatible encoding is UTF-8,
    // whose marker is three bytes.
    const startByte = bomBytes + sliced.startByteOffset;
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    // Whole lines consumed their terminator; a byte-truncated slice stopped
    // mid-line and resumes at exactly what was returned.
    const nextOffset = startByte + contentBytes + 1;
    if (nextOffset < raw.length) {
      meta.nextCursor = encodeTextCursor({
        off: nextOffset,
        size: raw.length,
        dev: String(pre.dev),
        ino: String(pre.ino),
      });
    }
  }

  return { content, meta };
}

/**
 * Stability check for a streamed *prefix* window.
 *
 * The full-snapshot path can demand byte-for-byte stability (`size` and
 * `mtimeMs` unchanged) because it returns the whole file: any change
 * invalidates the result. A line window does not return the whole file, so
 * demanding whole-file stability rejects reads whose returned bytes are
 * still perfectly valid — and the case it rejects is the one this feature
 * exists for. Appending to a log does not change lines 1-20, but under an
 * equality check every read of a live log is a coin flip.
 *
 * So the streamed path accepts growth, but rejects shrinkage and same-size
 * version changes. The latter preserves the stable-read protection against
 * in-place overwrites while still allowing append-only logs.
 *
 * The residual gap is a writer that changes existing bytes and grows past the
 * original size inside one read window while keeping the same inode. Metadata
 * cannot distinguish that from a pure append; hashing the prefix would make
 * every page O(n), defeating the cursor.
 */
function assertStreamWindowStable(
  before: {
    size: number | bigint;
    mtimeMs: number | bigint;
    ctimeMs: number | bigint;
  },
  after: {
    size: number | bigint;
    mtimeMs: number | bigint;
    ctimeMs: number | bigint;
  },
  p: ResolvedPath,
  reason: string,
): void {
  const beforeSize = toBigInt(before.size);
  const afterSize = toBigInt(after.size);
  if (
    afterSize < beforeSize ||
    (afterSize === beforeSize &&
      (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs))
  ) {
    throw new FsError('hash_mismatch', `${reason}: ${p}`, {
      hint: 'retry after re-reading the latest file',
    });
  }
}

/**
 * Byte-cursor page. Reaches any offset in O(1), so `MAX_TEXT_SCAN_BYTES` does
 * not apply here — that budget exists only because line offsets must be
 * resolved by scanning.
 *
 * The fd-bound TOCTOU discipline is lifted verbatim from
 * `readLargeTextWindowFromResolvedFile`. It is deliberately *not* copied from
 * `readBytesWindow`, which sits next door and looks like the closer model but
 * still demands `size`/`mtimeMs` equality after the read — the check `e784e6d`
 * relaxed precisely because it fails every page of an actively-written log.
 */
async function readTextCursorWindowFromResolvedFile(
  p: ResolvedPath,
  pre: Awaited<ReturnType<typeof fsp.lstat>>,
  opts: ReadTextOptions,
  lowFs: StandardFileSystemService,
): Promise<TextReadOutcome> {
  const cursor = decodeTextCursor(opts.cursor as string);
  const fh = await fsp.open(p as string, 'r');
  let opened: Awaited<ReturnType<typeof fh.stat>> | undefined;
  let afterRead: Awaited<ReturnType<typeof fh.stat>> | undefined;
  let window:
    | Awaited<ReturnType<StandardFileSystemService['readTextCursorFromHandle']>>
    | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    opened = await fh.stat();
    assertSameFile(pre, opened, p as string, 'read');
    assertStreamWindowStable(pre, opened, p, 'file changed before read');
    assertCursorMatchesFile(cursor, opened, p as string);

    try {
      const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, opened.size));
      if (probe.length > 0) {
        const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
        if (looksBinary(probe.subarray(0, bytesRead))) {
          throw new FsError('binary_file', `binary file: ${p}`, {
            hint: 'use readBytes for binary content',
          });
        }
      }

      window = await lowFs.readTextCursorFromHandle({
        fileHandle: fh,
        startOffset: cursor.off,
        fileSize: opened.size,
        maxOutputBytes: opts.maxBytes ?? MAX_READ_BYTES,
        maxSnapBytes: MAX_TEXT_SCAN_BYTES,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
    } catch (err) {
      hasPrimaryError = true;
      primaryError = err;
    }

    afterRead = await fh.stat();
  } finally {
    await fh.close();
  }

  if (opened === undefined || afterRead === undefined) {
    throw new FsError('internal_error', `failed to stat opened file: ${p}`);
  }
  const post = await fsp.lstat(p as string);
  if (post.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path was replaced with a symlink during read: ${p}`,
      { hint: 'TOCTOU swap detected via post-read lstat' },
    );
  }
  assertSameFile(opened, afterRead, p as string, 'read');
  assertStreamWindowStable(opened, afterRead, p, 'file changed during read');
  assertSameFile(opened, post, p as string, 'read');
  assertStreamWindowStable(opened, post, p, 'file changed during read');

  if (hasPrimaryError) {
    if (primaryError instanceof LargeNonUtf8TextError) {
      throw new FsError('binary_file', primaryError.message, {
        cause: primaryError,
        hint: 'convert the file to UTF-8, or use readBytes for the raw bytes',
      });
    }
    // The offset is malformed, not the file oversized — a cursor this daemon
    // issued always lands on a line start.
    if (primaryError instanceof CursorNotAtLineBoundaryError) {
      throw new FsError('parse_error', primaryError.message, {
        cause: primaryError,
        hint: 'pass a cursor returned by a previous read',
      });
    }
    throw primaryError;
  }
  if (window === undefined) {
    throw new FsError(
      'internal_error',
      `cursor text read returned no result: ${p}`,
    );
  }

  const meta: TextReadOutcome['meta'] = {
    encoding: window.encoding,
    bom: window.bom,
    lineEnding: window.lineEnding,
    sizeBytes: opened.size,
    truncated: true,
    hasMore:
      window.nextOffset !== undefined || window.truncatedByBytes === true,
  };
  if (window.nextOffset !== undefined) {
    meta.nextCursor = encodeTextCursor({
      off: window.nextOffset,
      size: opened.size,
      dev: String(opened.dev),
      ino: String(opened.ino),
    });
  }
  return { content: window.content, meta };
}

async function readLargeTextWindowFromResolvedFile(
  p: ResolvedPath,
  pre: Awaited<ReturnType<typeof fsp.lstat>>,
  opts: ReadTextOptions,
  lowFs: StandardFileSystemService,
): Promise<TextReadOutcome> {
  const fh = await fsp.open(p as string, 'r');
  let opened: Awaited<ReturnType<typeof fh.stat>> | undefined;
  let afterRead: Awaited<ReturnType<typeof fh.stat>> | undefined;
  let result:
    | Awaited<ReturnType<StandardFileSystemService['readTextFileFromHandle']>>
    | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    opened = await fh.stat();
    assertSameFile(pre, opened, p as string, 'read');
    assertStreamWindowStable(pre, opened, p, 'file changed before read');

    try {
      const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, opened.size));
      if (probe.length > 0) {
        const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
        if (looksBinary(probe.subarray(0, bytesRead))) {
          throw new FsError('binary_file', `binary file: ${p}`, {
            hint: 'use readBytes for binary content',
          });
        }
      }

      result = await lowFs.readTextFileFromHandle({
        fileHandle: fh,
        fileSize: opened.size,
        limit: opts.limit ?? Number.POSITIVE_INFINITY,
        line: opts.line !== undefined ? opts.line - 1 : 0,
        maxOutputBytes: opts.maxBytes ?? MAX_READ_BYTES,
        maxScanBytes: MAX_TEXT_SCAN_BYTES,
      });
    } catch (err) {
      hasPrimaryError = true;
      primaryError = err;
    }

    afterRead = await fh.stat();
  } finally {
    await fh.close();
  }

  if (opened === undefined || afterRead === undefined) {
    throw new FsError('internal_error', `failed to stat opened file: ${p}`);
  }
  const post = await fsp.lstat(p as string);
  if (post.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path was replaced with a symlink during read: ${p}`,
      { hint: 'TOCTOU swap detected via post-read lstat' },
    );
  }
  assertSameFile(opened, afterRead, p as string, 'read');
  assertStreamWindowStable(opened, afterRead, p, 'file changed during read');
  assertSameFile(opened, post, p as string, 'read');
  assertStreamWindowStable(opened, post, p, 'file changed during read');

  if (hasPrimaryError) {
    // An encoding the text route can't represent is the same class of refusal
    // as sniffed-binary content, and `binary_file` already tells clients to
    // fall back to `readBytes`.
    if (primaryError instanceof LargeNonUtf8TextError) {
      throw new FsError('binary_file', primaryError.message, {
        cause: primaryError,
        hint: 'convert the file to UTF-8, or use readBytes for the raw bytes',
      });
    }
    if (primaryError instanceof TextScanBudgetExceededError) {
      throw new FsError('file_too_large', primaryError.message, {
        cause: primaryError,
        hint: `line offsets are resolved by scanning from byte 0 and stop after ${MAX_TEXT_SCAN_BYTES} bytes; page with the cursor from a shallower read to reach this offset in O(1), or use readBytes for raw bytes`,
      });
    }
    throw primaryError;
  }
  if (result === undefined) {
    throw new FsError(
      'internal_error',
      `large text range read returned no result: ${p}`,
    );
  }
  const content = result.content;
  const readMeta = result._meta;

  const meta: TextReadOutcome['meta'] = {
    encoding: readMeta?.encoding,
    bom: readMeta?.bom,
    lineEnding: readMeta?.lineEnding ?? detectLineEnding(content),
    // Size as of `open`, not as of now: it describes the snapshot the
    // returned window was cut from. A file that grew during the read
    // reports the smaller, consistent number.
    sizeBytes: opened.size,
    truncated: true,
    hasMore:
      readMeta?.nextByteOffset !== undefined ||
      readMeta?.truncatedByBytes === true,
  };
  if (readMeta?.nextByteOffset !== undefined) {
    meta.nextCursor = encodeTextCursor({
      off: readMeta.nextByteOffset,
      size: opened.size,
      dev: String(opened.dev),
      ino: String(opened.ino),
    });
  }
  if (
    readMeta?.originalLineCountExact === true &&
    readMeta?.originalLineCount !== undefined
  ) {
    meta.originalLineCount = readMeta.originalLineCount;
  }
  return { content, meta };
}

async function readStableRegularFileBuffer(
  p: string,
  pre: Awaited<ReturnType<typeof fsp.lstat>>,
): Promise<Buffer> {
  const fh = await fsp.open(p, 'r');
  let opened: Awaited<ReturnType<typeof fh.stat>> | undefined;
  try {
    opened = await fh.stat();
    assertSameFile(pre, opened, p, 'read');
    if (opened.size > MAX_READ_BYTES) {
      throw new FsError(
        'file_too_large',
        `file of ${opened.size} bytes exceeds read cap of ${MAX_READ_BYTES} bytes`,
        {
          hint: 'use a finite line limit for large UTF-8 text, or readBytes for explicit byte-windowed access',
        },
      );
    }
    const out = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = await fh.read(out, offset, opened.size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const afterRead = await fh.stat();
    assertSameFile(opened, afterRead, p, 'read');
    if (
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs
    ) {
      throw new FsError('hash_mismatch', `file changed during read: ${p}`, {
        hint: 'retry after re-reading the latest file hash',
      });
    }
    const post = await fsp.lstat(p);
    assertSameFile(pre, post, p, 'read');
    if (post.size !== opened.size || post.mtimeMs !== opened.mtimeMs) {
      throw new FsError('hash_mismatch', `file changed during read: ${p}`, {
        hint: 'retry after re-reading the latest file hash',
      });
    }
    return offset === out.length ? out : out.subarray(0, offset);
  } finally {
    await fh.close();
  }
}

function sliceDecodedText(
  content: string,
  startLine: number,
  limit: number,
): {
  content: string;
  originalLineCount: number;
  /** Byte offset of `startLine` within the decoded text (BOM excluded). */
  startByteOffset: number;
  /** Index just past the last returned line. */
  endLine: number;
} {
  const lines = content.split('\n');
  const originalLineCount = lines.length;
  const endLine = Math.min(startLine + limit, originalLineCount);
  const actualStartLine = Math.min(startLine, originalLineCount);
  let startByteOffset = 0;
  for (let i = 0; i < actualStartLine; i++) {
    startByteOffset += Buffer.byteLength(lines[i]!, 'utf-8') + 1;
  }
  return {
    content: lines.slice(actualStartLine, endLine).join('\n'),
    originalLineCount,
    startByteOffset,
    endLine,
  };
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const bomProbe = buf.subarray(0, Math.min(4, buf.length));
  const hasUnicodeBom =
    (bomProbe.length >= 4 &&
      ((bomProbe[0] === 0xff &&
        bomProbe[1] === 0xfe &&
        bomProbe[2] === 0x00 &&
        bomProbe[3] === 0x00) ||
        (bomProbe[0] === 0x00 &&
          bomProbe[1] === 0x00 &&
          bomProbe[2] === 0xfe &&
          bomProbe[3] === 0xff))) ||
    (bomProbe.length >= 3 &&
      bomProbe[0] === 0xef &&
      bomProbe[1] === 0xbb &&
      bomProbe[2] === 0xbf) ||
    (bomProbe.length >= 2 &&
      ((bomProbe[0] === 0xff && bomProbe[1] === 0xfe) ||
        (bomProbe[0] === 0xfe && bomProbe[1] === 0xff)));
  if (hasUnicodeBom) return false;

  const sampleLength = Math.min(4096, buf.length);
  let nonPrintableCount = 0;
  for (let i = 0; i < sampleLength; i++) {
    if (buf[i] === 0) return true;
    if (buf[i] < 9 || (buf[i] > 13 && buf[i] < 32)) {
      nonPrintableCount++;
    }
  }
  return nonPrintableCount / sampleLength > 0.3;
}

async function readExistingTextMeta(
  p: ResolvedPath,
  expectedHash?: ContentHash,
): Promise<ReadMeta> {
  const snapshot = await readTextSnapshotFromResolvedFile(p);
  if (expectedHash !== undefined && snapshot.meta.hash !== expectedHash) {
    throw new FsError(
      'hash_mismatch',
      `expected ${expectedHash}, found ${snapshot.meta.hash}`,
      { hint: 're-read the file and retry with the latest hash' },
    );
  }
  return snapshot.meta;
}

function mergeWriteMeta(
  existing: Partial<ReadMeta> | undefined,
  opts: Partial<WriteTextAtomicOptions>,
): ReadMeta {
  return {
    encoding: opts.encoding ?? existing?.encoding ?? 'utf-8',
    bom: opts.bom ?? existing?.bom ?? false,
    lineEnding: opts.lineEnding ?? existing?.lineEnding ?? 'lf',
  };
}

async function atomicWriteTextResolvedFile(
  input: AtomicWriteTextInput,
): Promise<AtomicWriteTextOutcome> {
  const buf = await encodeTextFileContentAsync(
    input.target,
    input.content,
    buildWriteMeta(input.meta),
  );
  // Text writes keep the `MAX_WRITE_BYTES` policy. The byte upload path
  // validates its own buffer against `MAX_UPLOAD_BYTES` before calling the
  // shared publisher, so the two policies stay distinct.
  enforceWriteSize(buf.length);
  return atomicPublishResolvedFile({
    target: input.target,
    buf,
    mode: input.mode,
    expectedHash: input.expectedHash,
    newFileModeBits: input.newFileModeBits,
    assertGenerationOpen: input.assertGenerationOpen,
  });
}

/**
 * Ensure `target` exists as a real directory (never a symlink). With
 * `recursive`, walk up to the deepest existing ancestor and create each
 * missing component one at a time, verifying with `lstat` immediately after
 * each `mkdir` — and checking each component's parent before the next
 * `mkdir` — so a symlink swapped in mid-creation is rejected instead of
 * followed. `target` must already be resolved within the workspace; the
 * caller holds the path lock.
 */
async function ensureResolvedDirectory(
  target: string,
  opts: {
    recursive: boolean;
    assertGenerationOpen: () => void;
  },
): Promise<void> {
  const assertRealDirectory = async (p: string): Promise<void> => {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) {
      throw new FsError('symlink_escape', `directory path is a symlink: ${p}`, {
        hint: 're-resolve the target after detecting symlink swaps',
      });
    }
    if (!st.isDirectory()) {
      throw new FsError(
        'parse_error',
        `path exists and is not a directory: ${p}`,
      );
    }
  };
  // `lstat` does not follow the FINAL component, so the per-component
  // re-check above cannot see a symlink swapped into an intermediate
  // ancestor mid-creation; reject one before the next `mkdir` would
  // create through it.
  const assertParentNotSymlink = async (p: string): Promise<void> => {
    const parent = path.dirname(p);
    const st = await fsp.lstat(parent);
    if (st.isSymbolicLink()) {
      throw new FsError(
        'symlink_escape',
        `directory parent is a symlink: ${parent}`,
        { hint: 're-resolve the target after detecting symlink swaps' },
      );
    }
  };
  try {
    await assertRealDirectory(target);
    return;
  } catch (err) {
    if (isFsError(err)) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!opts.recursive) {
    opts.assertGenerationOpen();
    await assertParentNotSymlink(target);
    try {
      await fsp.mkdir(target, { mode: 0o755 });
    } catch (err) {
      // Lost a create race; the winner may be a directory we can reuse.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await assertRealDirectory(target);
    return;
  }
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      await assertRealDirectory(current);
      break;
    } catch (err) {
      if (isFsError(err)) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
  for (const entry of missing.reverse()) {
    opts.assertGenerationOpen();
    await assertParentNotSymlink(entry);
    try {
      await fsp.mkdir(entry, { mode: 0o755 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await assertRealDirectory(entry);
  }
}

/**
 * Shared atomic temp+publish core. `buf` MUST already be size-validated by
 * the caller against its own policy (`MAX_WRITE_BYTES` for text,
 * `MAX_UPLOAD_BYTES` for binary uploads). This function does not re-check
 * size; it only handles the filesystem mechanics: parent validation, temp
 * reservation, precondition checks, generation gating, and publication.
 */
async function atomicPublishResolvedFile(input: {
  target: string;
  buf: Buffer;
  mode: WriteMode;
  expectedHash?: ContentHash;
  /**
   * Mode bits for a NEW target. Existing targets preserve their on-disk
   * mode regardless. Undefined falls back to the owner-only `0o600`
   * default (`OWNER_ONLY_NEW_FILE_MODE`).
   */
  newFileModeBits?: number;
  assertGenerationOpen?: () => void;
}): Promise<AtomicWriteTextOutcome> {
  const target = input.target;
  const parent = path.dirname(target);
  const parentStat = await fsp.lstat(parent);
  // Defense-in-depth against a parent-symlink swap. A full fix requires
  // parent-fd / `openat`-style publish, which Node stdlib does not expose.
  // This guard at least surfaces an obviously-swapped parent before we open
  // the temp file or rename through it.
  if (parentStat.isSymbolicLink()) {
    throw new FsError('symlink_escape', `parent path is a symlink: ${parent}`, {
      hint: 're-resolve the target after detecting parent-symlink swaps',
    });
  }
  if (!parentStat.isDirectory()) {
    throw new FsError(
      'parse_error',
      `parent path is not a directory: ${parent}`,
    );
  }
  const tmpSuffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // The temp name is `.<basename><suffix>`. When the target basename is itself
  // near the filesystem NAME_MAX (255 bytes) — a 255-byte upload, say — the
  // untruncated temp name would exceed it and `open()` would fail ENAMETOOLONG
  // before the atomic publish could run. Cap the basename portion (UTF-8-safe).
  const tmpNameMaxBytes = 255;
  const tmpBaseMaxBytes =
    tmpNameMaxBytes - 1 - Buffer.byteLength(tmpSuffix, 'utf-8');
  let tmpBase = path.basename(target);
  if (Buffer.byteLength(tmpBase, 'utf-8') > tmpBaseMaxBytes) {
    tmpBase = safeUtf8Truncate(
      Buffer.from(tmpBase, 'utf-8'),
      tmpBaseMaxBytes,
    ).toString('utf-8');
  }
  const tmpPath = path.join(parent, `.${tmpBase}${tmpSuffix}`);
  let tempLive = false;
  let tempHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let tempStat: Awaited<ReturnType<typeof fsp.lstat>> | undefined;
  try {
    tempHandle = await reserveTempFile(tmpPath);
    tempLive = true;
    const written = await writeBufferToTemp({
      tmpPath,
      buf: input.buf,
      handle: tempHandle,
    });
    tempStat = written.stat;
    const targetState = await assertAtomicTargetPrecondition({
      target,
      mode: input.mode,
      expectedHash: input.expectedHash,
    });
    // Existing targets preserve their on-disk mode; NEW targets get the
    // caller's policy bits (umask-following `0o666 & ~umask` under the
    // `system` policy) or the owner-only `0o600` default.
    await chmodHandleBestEffort(
      tempHandle,
      targetState.mode ?? input.newFileModeBits ?? OWNER_ONLY_NEW_FILE_MODE,
    );
    await assertTempPathMatchesStat(tmpPath, tempStat);
    await tempHandle.close();
    tempHandle = undefined;
    await assertTempPathMatchesStat(tmpPath, tempStat);
    input.assertGenerationOpen?.();
    if (input.mode === 'create') {
      await publishCreateNoClobber(tmpPath, target);
    } else {
      await renameWithRetryLocal(tmpPath, target, 3, 50);
    }
    tempLive = false;
    await fsyncParentDirBestEffort(parent);
    return written;
  } catch (err) {
    await tempHandle?.close().catch(() => undefined);
    if (tempLive) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // Best-effort cleanup; preserve the original failure.
      }
    }
    throw err;
  }
}

async function reserveTempFile(
  tmpPath: string,
): Promise<Awaited<ReturnType<typeof fsp.open>>> {
  return fsp.open(tmpPath, 'wx', 0o600);
}

/**
 * Write an already-validated buffer to the reserved temp handle and verify
 * the handle still names the same regular file. Shared by the text and
 * binary publishers; size policy is enforced by the caller, not here.
 */
async function writeBufferToTemp(input: {
  tmpPath: string;
  buf: Buffer;
  handle: Awaited<ReturnType<typeof fsp.open>>;
}): Promise<AtomicWriteTextOutcome> {
  await input.handle.writeFile(input.buf);
  await syncHandleBestEffort(input.handle);
  const st = await fsp.lstat(input.tmpPath);
  const opened = await input.handle.stat();
  assertSameFile(opened, st, input.tmpPath, 'write');
  if (st.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `temporary path became a symlink: ${input.tmpPath}`,
      { hint: 'temp-file race detected before final rename' },
    );
  }
  if (!st.isFile()) {
    throw new FsError(
      'parse_error',
      `temporary path is not a regular file: ${input.tmpPath}`,
    );
  }
  return { sizeBytes: input.buf.length, hash: hashBuffer(input.buf), stat: st };
}

async function assertCreateTargetAbsent(target: string): Promise<void> {
  try {
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink()) {
      throw new FsError(
        'symlink_escape',
        `path is a symlink and cannot be created over: ${target}`,
        { hint: 'remove the symlink or resolve the target explicitly' },
      );
    }
    throw new FsError('file_already_exists', `file already exists: ${target}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    throw err;
  }
}

async function assertAtomicTargetPrecondition(input: {
  target: string;
  mode: WriteMode;
  expectedHash?: ContentHash;
}): Promise<{ mode?: number }> {
  if (input.mode === 'create') {
    await assertCreateTargetAbsent(input.target);
    return {};
  }
  if (input.mode === 'overwrite') {
    // Tolerate missing target (new file path); reject symlinks and
    // non-regular files (parity with 'replace'). When the target
    // exists, return its mode so the caller can preserve it on the
    // temp file before rename.
    let pre: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      pre = await fsp.lstat(input.target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {};
      }
      throw err;
    }
    if (pre.isSymbolicLink()) {
      throw new FsError(
        'symlink_escape',
        `path is a symlink and cannot be overwritten atomically: ${input.target}`,
        {
          hint: 're-resolve the target file instead of writing through a link',
        },
      );
    }
    if (!pre.isFile()) {
      throw new FsError(
        'parse_error',
        `path is not a regular file: ${input.target}`,
      );
    }
    return { mode: pre.mode & 0o7777 };
  }
  if (!isContentHash(input.expectedHash)) {
    throw new FsError(
      'parse_error',
      'expectedHash is required when mode is "replace"',
    );
  }
  const pre = await fsp.lstat(input.target);
  if (pre.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path is a symlink and cannot be replaced atomically: ${input.target}`,
      { hint: 're-resolve the target file instead of writing through a link' },
    );
  }
  if (!pre.isFile()) {
    throw new FsError(
      'parse_error',
      `path is not a regular file: ${input.target}`,
    );
  }
  const actual = await hashRegularFileAtPath(input.target, pre);
  if (actual !== input.expectedHash) {
    throw new FsError(
      'hash_mismatch',
      `expected ${input.expectedHash}, found ${actual}`,
      { hint: 're-read the file and retry with the latest hash' },
    );
  }
  return { mode: pre.mode & 0o7777 };
}

async function hashRegularFileAtPath(
  p: string,
  pre: Awaited<ReturnType<typeof fsp.lstat>>,
): Promise<ContentHash> {
  const fh = await fsp.open(p, 'r');
  const hash = createHash('sha256');
  let opened: Awaited<ReturnType<typeof fh.stat>> | undefined;
  try {
    opened = await fh.stat();
    assertSameFile(pre, opened, p, 'read');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const read = await fh.read(
        buf,
        0,
        Math.min(buf.length, opened.size - offset),
        offset,
      );
      if (read.bytesRead === 0) break;
      hash.update(buf.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
  } finally {
    await fh.close();
  }
  if (opened === undefined) {
    throw new FsError('internal_error', `failed to stat opened file: ${p}`);
  }
  const post = await fsp.lstat(p);
  assertSameFile(pre, post, p, 'read');
  if (post.size !== opened.size || post.mtimeMs !== opened.mtimeMs) {
    throw new FsError('hash_mismatch', `file changed during hash: ${p}`, {
      hint: 'retry after re-reading the latest file hash',
    });
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashBuffer(buf: Buffer): ContentHash {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function assertSameFile(
  pre: { dev: number | bigint; ino: number | bigint },
  post: { dev: number | bigint; ino: number | bigint },
  p: string,
  intent: Intent,
): void {
  const preDev = toBigInt(pre.dev);
  const postDev = toBigInt(post.dev);
  const preIno = toBigInt(pre.ino);
  const postIno = toBigInt(post.ino);
  if (
    preDev !== 0n &&
    postDev !== 0n &&
    preIno !== 0n &&
    postIno !== 0n &&
    (preDev !== postDev || preIno !== postIno)
  ) {
    throw new FsError('symlink_escape', `path changed during ${intent}: ${p}`, {
      hint: 'TOCTOU swap detected via device/inode comparison',
    });
  }
}

function toBigInt(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

async function syncHandleBestEffort(
  fh: Awaited<ReturnType<typeof fsp.open>>,
): Promise<void> {
  try {
    await fh.sync();
  } catch {
    // Some platforms/filesystems reject fsync on temporary files.
  }
}

async function fsyncParentDirBestEffort(parent: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    fh = await fsp.open(parent, 'r');
    await fh.sync();
  } catch {
    // Windows and some filesystems do not support directory fsync.
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function chmodHandleBestEffort(
  fh: Awaited<ReturnType<typeof fsp.open>>,
  mode: number,
): Promise<void> {
  try {
    await fh.chmod(mode);
  } catch {
    // Not all filesystems support POSIX permission bits.
  }
}

async function assertTempPathMatchesStat(
  tmpPath: string,
  expected: Awaited<ReturnType<typeof fsp.lstat>>,
): Promise<void> {
  const st = await fsp.lstat(tmpPath);
  if (st.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `temporary path is a symlink: ${tmpPath}`,
      {
        hint: 'temp-file race detected before final rename',
      },
    );
  }
  if (!st.isFile()) {
    throw new FsError(
      'parse_error',
      `temporary path is not a regular file: ${tmpPath}`,
    );
  }
  assertSameFile(expected, st, tmpPath, 'write');
}

// POSIX `rename(src, dest)` overwrites an existing regular file,
// which would silently break the public `mode: 'create'` contract
// if an external process raced us between the absence check and
// the publish. `link()` is the portable no-clobber publish: it
// returns `EEXIST` atomically when `dest` already exists, on both
// POSIX filesystems and NTFS. The early `assertCreateTargetAbsent`
// stays in place to give friendlier `symlink_escape` /
// `file_already_exists` errors on the non-racing path; this is the
// hard guarantee that closes the race window.
async function publishCreateNoClobber(
  tmpPath: string,
  target: string,
): Promise<void> {
  try {
    await fsp.link(tmpPath, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      throw new FsError(
        'file_already_exists',
        `file already exists: ${target}`,
      );
    }
    throw err;
  }
  // After link(), tmp and target name the same inode. Drop the
  // tmp name best-effort — if unlink fails the publish has still
  // succeeded, so we must not bubble the error and confuse the
  // caller into thinking the create failed.
  await fsp.unlink(tmpPath).catch(() => undefined);
}

async function renameWithRetryLocal(
  src: string,
  dest: string,
  retries: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fsp.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = code === 'EPERM' || code === 'EACCES';
      if (!retryable || attempt === retries) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * 2 ** attempt),
      );
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/**
 * Truncate a UTF-8 buffer to at most `maxBytes` bytes WITHOUT
 * splitting a multi-byte codepoint. `Buffer.subarray(0, n).toString('utf-8')`
 * silently emits U+FFFD replacement chars when `n` falls in the
 * middle of a 2-4-byte sequence (CJK, emoji); a downstream consumer
 * parsing JSON / source code over the truncated content sees corrupted
 * trailing bytes. We back off `n` to the last valid codepoint
 * boundary so the truncated string is always a clean prefix of the
 * original.
 *
 * Algorithm:
 * 1. If the buffer fits, return as-is.
 * 2. Walk back from `maxBytes` while the previous byte is a UTF-8
 *    continuation byte (`0b10xxxxxx`).
 * 3. The byte at the new boundary is now either ASCII (`<0x80`) or
 *    a leading byte. If it's a leading byte, check whether the full
 *    multi-byte sequence fits within `maxBytes`. If not, drop the
 *    leading byte too — the sequence is incomplete.
 */
function safeUtf8Truncate(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  // Walk `end` back through any UTF-8 continuation bytes
  // (`0b10xxxxxx`) at the cut position. After the loop:
  //   - `end == 0`, OR
  //   - `buf[end]` is a leading byte (top bits `0xxxxxxx`,
  //     `110xxxxx`, `1110xxxx`, or `11110xxx`).
  // Either way, `subarray(0, end)` is exactly the longest
  // codepoint-aligned prefix at most `maxBytes` long: if
  // `buf[end]` is the leading byte of an incomplete sequence
  // we exclude it; if `buf[end]` is ASCII (i.e. the original
  // `maxBytes` happened to land on a codepoint boundary) the
  // walk-back is a no-op and we still cut at `maxBytes`.
  // The earlier "seqLen check" was dead code — `subarray(0,
  // end)` already excludes the leading byte at index `end`,
  // so no further adjustment is ever needed.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * Post-read pathname guard for handle-bound byte reads. The content read is
 * already tied to the opened inode; re-`lstat` confirms the requested path
 * still names that inode and was not replaced by a symlink before the response
 * is emitted. A swap after this final check remains outside the module's
 * point-in-time guarantee, but cannot change the bytes already read from the
 * original handle.
 */
async function assertInodeStableAfterRead(
  p: string,
  preIno: bigint | number,
): Promise<void> {
  const post = await fsp.lstat(p);
  if (post.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path was replaced with a symlink during read: ${p}`,
      { hint: 'TOCTOU swap detected via post-read lstat' },
    );
  }
  const preNum = toBigInt(preIno);
  const postNum = toBigInt(post.ino);
  if (preNum !== 0n && postNum !== 0n && preNum !== postNum) {
    throw new FsError(
      'symlink_escape',
      `path inode changed during read: ${p}`,
      { hint: 'TOCTOU swap detected via inode comparison' },
    );
  }
}

/**
 * Pre-write TOCTOU guard. Mirrors the post-read inode check but
 * runs BEFORE the actual write. The earlier `resolve()` →
 * `writeTextFile()` window let an attacker swap `p` with a
 * symlink to outside the workspace; `atomicWriteFile`'s
 * underlying `resolveSymlinkChain` follows the symlink and the
 * write lands outside.
 *
 * Catches:
 * - the path is now a symlink (`isSymbolicLink()`) — reject
 *   with `symlink_escape` regardless of where it points; callers
 *   should re-`resolve` after a swap rather than blindly writing
 *   through the rename.
 *
 * Does NOT catch:
 * - swap-back AFTER this guard but BEFORE `lowFs.writeTextFile`
 *   completes — the residual race window. The proper fix is
 *   fd-based atomic write (`fsp.open(O_NOFOLLOW)` + temp + rename
 *   tied to the parent dir). This guard is the defense-in-depth
 *   layer that closes the wide window.
 *
 * Used by `writeText` and `edit()` immediately before
 * `lowFs.writeTextFile`. ENOENT is fine (ahead-of-create flow);
 * only an actual symlink is rejected.
 */
async function assertNotSymlinkBeforeWrite(p: string): Promise<void> {
  let pre: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    pre = await fsp.lstat(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return; // ahead-of-create flow
    throw err;
  }
  if (pre.isSymbolicLink()) {
    throw new FsError(
      'symlink_escape',
      `path was replaced with a symlink before write: ${p}`,
      {
        hint: 'TOCTOU swap detected via pre-write lstat — re-resolve before retrying',
      },
    );
  }
}

/**
 * Map a `Stats` or `Dirent` (both expose the same `isFile` /
 * `isDirectory` / `isSymbolicLink` methods) to the boundary's
 * narrow `kind` union. `FsStat['kind']` and `FsEntry['kind']` are
 * the same 4-value union, so a single helper keeps the
 * classification rule in one place.
 */
function kindFromStatLike(s: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsStat['kind'] {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isDirectory()) return 'directory';
  if (s.isFile()) return 'file';
  return 'other';
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function errorKindForRealpathFailure(err: unknown): FsErrorKind {
  const code = errorCode(err);
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ENOENT' || code === 'ELOOP') return 'symlink_escape';
  return 'io_error';
}

function buildWriteMeta(
  opts: WriteTextFileOptions & { lineEnding?: 'crlf' | 'lf' },
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (opts.bom !== undefined) meta['bom'] = opts.bom;
  if (opts.encoding) meta['encoding'] = opts.encoding;
  if (opts.lineEnding) meta['lineEnding'] = opts.lineEnding;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

// Re-export so routes can access the orchestrator surface from a
// single `serve/fs/index.js` import.
export { MAX_READ_BYTES };
