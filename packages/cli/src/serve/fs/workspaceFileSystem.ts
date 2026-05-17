/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
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
  loadIgnoreRules,
  type Ignore,
  type WriteTextFileOptions,
} from '@qwen-code/qwen-code-core';
import type { BridgeEvent } from '../eventBus.js';
import {
  type AuditContext,
  type AuditPublisher,
  createAuditPublisher,
} from './audit.js';
import { FsError, wrapAsFsError } from './errors.js';
import {
  canonicalizeWorkspace,
  resolveWithinWorkspace,
  type Intent,
  type ResolvedPath,
} from './paths.js';
import {
  MAX_READ_BYTES,
  assertTrustedForIntent,
  detectBinary,
  enforceReadBytesSize,
  enforceReadSize,
  enforceWriteSize,
  shouldIgnore,
} from './policy.js';

/**
 * Stat snapshot returned by `WorkspaceFileSystem.stat`. We
 * deliberately avoid passing through `fs.Stats` directly — the
 * boundary should not leak Node-specific bigint quirks or
 * platform-specific fields to PR 19/20 SDK consumers.
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
  truncated?: boolean;
  matchedIgnore?: 'file' | 'directory';
  originalLineCount?: number;
}

export interface ReadTextOptions {
  /** Cap returned bytes; defaults to MAX_READ_BYTES. */
  maxBytes?: number;
  /**
   * 1-based starting line for partial reads. `1` returns the file
   * from its first line. The boundary converts to the 0-based slice
   * index `readFileWithLineAndLimit` expects internally; SDK
   * consumers don't need to adjust. Values < 1 (or undefined) are
   * treated as "from the beginning".
   */
  line?: number;
  /** Maximum number of lines to return. */
  limit?: number;
}

export interface ListOptions {
  /** When true, ignored entries are returned with `ignored: true` rather than dropped. */
  includeIgnored?: boolean;
}

export interface GlobOptions {
  cwd?: ResolvedPath;
  includeIgnored?: boolean;
  maxResults?: number;
}

export interface WriteOutcome {
  writtenBytes: number;
}

export interface RequestContext extends AuditContext {
  /** Mostly redundant with `originatorClientId`; kept for forward-compat with future ACP fields. */
  ownerSessionId?: string;
}

/**
 * Public boundary type. PR 19/20 routes consume this via the
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
  readBytes(p: ResolvedPath, opts?: { maxBytes?: number }): Promise<Buffer>;
  list(p: ResolvedPath, opts?: ListOptions): Promise<FsEntry[]>;
  glob(pattern: string, opts?: GlobOptions): Promise<ResolvedPath[]>;
  writeText(
    p: ResolvedPath,
    content: string,
    opts?: WriteTextFileOptions,
  ): Promise<void>;
  edit(
    p: ResolvedPath,
    oldText: string,
    newText: string,
  ): Promise<WriteOutcome>;
}

/**
 * Per-process factory. Build once at `createServeApp` boot, call
 * `forRequest` per HTTP route invocation.
 */
export interface WorkspaceFileSystemFactory {
  forRequest(ctx: RequestContext): WorkspaceFileSystem;
}

export interface CreateWorkspaceFileSystemFactoryDeps {
  /** Canonical workspace path; the daemon's `boundWorkspace`. */
  boundWorkspace: string;
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
}

/**
 * Build a `WorkspaceFileSystemFactory`. The factory itself is
 * stateless across requests; per-request state (the audit context)
 * lives on the bound `WorkspaceFileSystem` returned from `forRequest`.
 */
export function createWorkspaceFileSystemFactory(
  deps: CreateWorkspaceFileSystemFactoryDeps,
): WorkspaceFileSystemFactory {
  const boundWorkspace = canonicalizeWorkspace(deps.boundWorkspace);
  const ignore =
    deps.ignore ??
    loadIgnoreRules({
      projectRoot: boundWorkspace,
      useGitignore: true,
      useQwenignore: true,
      ignoreDirs: [],
    });
  const audit: AuditPublisher = createAuditPublisher({
    emit: deps.emit,
    boundWorkspace,
    includeRawPaths: deps.includeRawPaths,
  });
  const lowFs = new StandardFileSystemService();

  return {
    forRequest(ctx) {
      return new WorkspaceFileSystemImpl({
        boundWorkspace,
        trusted: deps.trusted,
        ignore,
        audit,
        ctx,
        lowFs,
      });
    },
  };
}

interface ImplDeps {
  boundWorkspace: string;
  trusted: boolean;
  ignore: Ignore;
  audit: AuditPublisher;
  ctx: RequestContext;
  lowFs: StandardFileSystemService;
}

class WorkspaceFileSystemImpl implements WorkspaceFileSystem {
  constructor(private readonly deps: ImplDeps) {}

  async resolve(input: string, intent: Intent): Promise<ResolvedPath> {
    try {
      return await resolveWithinWorkspace(
        input,
        this.deps.boundWorkspace,
        intent,
      );
    } catch (err) {
      throw this.recordAndWrap(err, intent, input);
    }
  }

  async stat(p: ResolvedPath): Promise<FsStat> {
    const start = performance.now();
    try {
      assertTrustedForIntent(this.deps.trusted, 'stat');
      const st = await fsp.lstat(p as string);
      const out: FsStat = {
        kind: kindFromStats(st),
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
      assertTrustedForIntent(this.deps.trusted, 'read');
      const st = await fsp.stat(p as string);
      // Hard size gate before we delegate to lowFs.readTextFile —
      // that helper's underlying `readFileWithLineAndLimit` slurps
      // the whole file into memory before slicing lines, so an
      // unbounded request against a 5 GB text file would OOM the
      // daemon (or, on a healthy host, flood the SSE replay ring
      // with a 5 GB string). `MAX_READ_BYTES` is the hard cap and
      // is independent of the caller's `opts.maxBytes` (which is a
      // *softer* post-read truncation target — the boundary still
      // honors it via `enforceReadSize` below). A future streaming
      // read path can lift this hard cap by reading only the first
      // N bytes; for now files above the cap throw and the SDK
      // consumer can fall back to `readBytes` with an explicit
      // length window.
      if (st.size > MAX_READ_BYTES) {
        throw new FsError(
          'file_too_large',
          `file of ${st.size} bytes exceeds read cap of ${MAX_READ_BYTES} bytes`,
          {
            hint: 'use readBytes for explicit byte-windowed access on large files',
          },
        );
      }
      if (await detectBinary(p)) {
        throw new FsError('binary_file', `binary file: ${p}`, {
          hint: 'use readBytes for binary content',
        });
      }
      const sizeOutcome = enforceReadSize(st.size, opts.maxBytes);
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
      // Delegate encoding-aware read to the existing core service so
      // BOM, CRLF, and iconv-supported codepages remain consistent
      // with what the tools layer already does. The core service's
      // `line` parameter is a 0-based slice index whereas the
      // boundary's public `ReadTextOptions.line` is 1-based (the
      // convention SDK consumers expect from line-numbered errors,
      // editor jump-to-line, etc.). Convert here so the public
      // contract isn't tied to the internal helper's indexing.
      const startLineIndex = opts.line !== undefined ? opts.line - 1 : 0;
      const result = await this.deps.lowFs.readTextFile({
        path: p as string,
        limit: opts.limit ?? Number.POSITIVE_INFINITY,
        line: startLineIndex,
      });
      const ignoreVerdict = shouldIgnore(
        p,
        this.deps.boundWorkspace,
        this.deps.ignore,
        'file',
      );
      const meta: ReadMeta = {
        encoding: result._meta?.encoding,
        bom: result._meta?.bom,
        lineEnding: (result._meta?.lineEnding ?? 'lf') as 'crlf' | 'lf',
        originalLineCount: result._meta?.originalLineCount,
      };
      let truncatedContent = result.content;
      if (sizeOutcome.truncated) {
        const buf = Buffer.from(result.content, 'utf-8');
        if (buf.length > sizeOutcome.bytesToRead) {
          truncatedContent = buf
            .subarray(0, sizeOutcome.bytesToRead)
            .toString('utf-8');
        }
        meta.truncated = true;
      }
      // Surface truncation whenever lowFs's own `limit` clipped the
      // content too — without this the audit row + meta.truncated
      // would silently disagree on whether the SDK consumer received
      // the full file.
      if (
        opts.limit !== undefined &&
        Number.isFinite(opts.limit) &&
        result._meta?.originalLineCount !== undefined &&
        result._meta.originalLineCount > opts.limit + startLineIndex
      ) {
        meta.truncated = true;
      }
      if (ignoreVerdict.ignored) meta.matchedIgnore = ignoreVerdict.category;
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'read',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: st.size,
        truncated: meta.truncated,
        matchedIgnore: meta.matchedIgnore,
      });
      return { content: truncatedContent, meta };
    } catch (err) {
      throw this.recordAndWrap(err, 'read', p as string);
    }
  }

  async readBytes(
    p: ResolvedPath,
    opts: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const start = performance.now();
    try {
      assertTrustedForIntent(this.deps.trusted, 'read');
      const st = await fsp.stat(p as string);
      enforceReadBytesSize(st.size, opts.maxBytes);
      const buf = await fsp.readFile(p as string);
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'read',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: buf.length,
      });
      return buf;
    } catch (err) {
      throw this.recordAndWrap(err, 'read', p as string);
    }
  }

  async list(p: ResolvedPath, opts: ListOptions = {}): Promise<FsEntry[]> {
    const start = performance.now();
    try {
      assertTrustedForIntent(this.deps.trusted, 'list');
      const dirents = await fsp.readdir(p as string, { withFileTypes: true });
      const entries: FsEntry[] = [];
      for (const d of dirents) {
        // `path.join(p, d.name)` is a shallow extension of an
        // already-canonical workspace path. Symlinked dirents are
        // tagged as `kind: 'symlink'` rather than auto-followed —
        // PR 19/20 callers that want the target's containment can
        // call `resolve()` separately. Treating each child as
        // implicitly-resolved here would be a brand-cast bypass.
        const childAbs = path.join(p as string, d.name);
        const kind = kindFromDirent(d);
        const verdict = shouldIgnore(
          childAbs as ResolvedPath,
          this.deps.boundWorkspace,
          this.deps.ignore,
          kind === 'directory' ? 'directory' : 'file',
        );
        if (verdict.ignored && !opts.includeIgnored) continue;
        entries.push({ name: d.name, kind, ignored: verdict.ignored });
      }
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'list',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: entries.length,
      });
      return entries;
    } catch (err) {
      throw this.recordAndWrap(err, 'list', p as string);
    }
  }

  async glob(pattern: string, opts: GlobOptions = {}): Promise<ResolvedPath[]> {
    const start = performance.now();
    try {
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
      const cwd = (opts.cwd as string | undefined) ?? this.deps.boundWorkspace;
      const matches = await globAsync(pattern, {
        cwd,
        nodir: false,
        absolute: true,
        dot: true,
      });
      const out: ResolvedPath[] = [];
      const max = opts.maxResults ?? Number.POSITIVE_INFINITY;
      let escapedCount = 0;
      let permissionErrorCount = 0;
      let transientErrorCount = 0;
      for (const hit of matches) {
        if (out.length >= max) break;
        const absolute = path.resolve(hit);
        // Per-hit boundary check defends against a glob that
        // matches a symlink whose target escapes the workspace.
        // The literal path is in-workspace (the symlink itself
        // sits there), but the realpath isn't — so we resolve
        // each hit's symlink chain and compare the canonical to
        // the canonical workspace root. Filtered hits are counted
        // and reported via aggregated `fs.denied` events after
        // the loop so per-hit emit doesn't flood the bus when a
        // misconfigured tree contains many escape symlinks.
        let canonical: string;
        try {
          canonical = await fsp.realpath(absolute);
        } catch (err) {
          // Three-way classification so monitoring pipelines can
          // tell escapes from access denials from transient I/O:
          //   - `ENOENT` / `ELOOP`  → real `symlink_escape`
          //     (dangling symlink, symlink cycle)
          //   - `EACCES` / `EPERM`  → `permission_denied`
          //     (the literal access-denied case the kind names)
          //   - everything else     → `io_error` (EIO, EBUSY,
          //     ENAMETOOLONG, EMFILE, …) — environmental, NOT a
          //     security signal. Conflating these poisons audit:
          //     a failing disk would page security oncall.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT' || code === 'ELOOP') {
            escapedCount += 1;
          } else if (code === 'EACCES' || code === 'EPERM') {
            permissionErrorCount += 1;
          } else {
            transientErrorCount += 1;
          }
          continue;
        }
        const rel = path.relative(this.deps.boundWorkspace, canonical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          escapedCount += 1;
          continue;
        }
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
        const verdict = shouldIgnore(
          canonical as ResolvedPath,
          this.deps.boundWorkspace,
          this.deps.ignore,
          kind,
        );
        if (verdict.ignored && !opts.includeIgnored) continue;
        out.push(canonical as ResolvedPath);
      }
      if (escapedCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          errorKind: 'symlink_escape',
          hint: `glob filtered ${escapedCount} hit(s) that resolved outside workspace`,
        });
      }
      if (permissionErrorCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          errorKind: 'permission_denied',
          hint: `glob skipped ${permissionErrorCount} hit(s) due to EACCES/EPERM`,
        });
      }
      if (transientErrorCount > 0) {
        this.deps.audit.recordDenied(this.deps.ctx, {
          intent: 'glob',
          input: pattern,
          // `io_error` (not `permission_denied`) so monitoring
          // pipelines that page security oncall on
          // `permission_denied` aren't woken up by a failing disk
          // or busy file. The kind was added to `FsErrorKind` for
          // exactly this case (and for `wrapAsFsError`'s ENOSPC /
          // EIO / EBUSY / ETXTBSY / ENAMETOOLONG / EMFILE / ENFILE
          // mappings).
          errorKind: 'io_error',
          hint: `glob skipped ${transientErrorCount} hit(s) due to transient I/O errors (EIO/EBUSY/ENAMETOOLONG/EMFILE)`,
        });
      }
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'glob',
        absolute: cwd as ResolvedPath,
        durationMs: performance.now() - start,
        sizeBytes: out.length,
      });
      return out;
    } catch (err) {
      throw this.recordAndWrap(err, 'glob', pattern);
    }
  }

  async writeText(
    p: ResolvedPath,
    content: string,
    opts?: WriteTextFileOptions,
  ): Promise<void> {
    const start = performance.now();
    try {
      assertTrustedForIntent(this.deps.trusted, 'write');
      const buf = Buffer.from(content, 'utf-8');
      enforceWriteSize(buf.length);
      await this.deps.lowFs.writeTextFile({
        path: p as string,
        content,
        _meta: opts ? buildWriteMeta(opts) : undefined,
      });
      const verdict = shouldIgnore(
        p,
        this.deps.boundWorkspace,
        this.deps.ignore,
        'file',
      );
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'write',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: buf.length,
        matchedIgnore: verdict.ignored ? verdict.category : undefined,
      });
    } catch (err) {
      throw this.recordAndWrap(err, 'write', p as string);
    }
  }

  async edit(
    p: ResolvedPath,
    oldText: string,
    newText: string,
  ): Promise<WriteOutcome> {
    const start = performance.now();
    try {
      assertTrustedForIntent(this.deps.trusted, 'edit');
      // Mirror `readText`'s pre-stat OOM gate: `fsp.readFile` would
      // otherwise slurp the whole target into memory before
      // `enforceWriteSize` got a chance to refuse. A multi-GB file
      // already inside the workspace can OOM the daemon even though
      // the *edited output* would later fail the size check.
      // Reject above `MAX_READ_BYTES` outright with a typed
      // `file_too_large`; binary content is also refused since
      // `current.indexOf(oldText)` over arbitrary bytes is meaningless.
      const st = await fsp.stat(p as string);
      if (st.size > MAX_READ_BYTES) {
        throw new FsError(
          'file_too_large',
          `file of ${st.size} bytes exceeds edit cap of ${MAX_READ_BYTES} bytes`,
          {
            hint: 'split large edits into bounded readBytes/writeText sequences',
          },
        );
      }
      if (await detectBinary(p)) {
        throw new FsError('binary_file', `cannot edit binary file: ${p}`, {
          hint: 'edit() works on text files only',
        });
      }
      const current = await fsp.readFile(p as string, 'utf-8');
      // Single replacement to preserve atomic write-once semantics.
      // Multi-occurrence handling lives in PR 20's edit endpoint
      // where the route can decide policy; the boundary stays
      // mechanical.
      const idx = current.indexOf(oldText);
      if (idx === -1) {
        throw new FsError('parse_error', `oldText not found in ${p}`, {
          hint: 'edit() expects oldText to appear verbatim in the file',
        });
      }
      const next =
        current.slice(0, idx) + newText + current.slice(idx + oldText.length);
      const buf = Buffer.from(next, 'utf-8');
      enforceWriteSize(buf.length);
      await this.deps.lowFs.writeTextFile({
        path: p as string,
        content: next,
      });
      // Symmetric with `readText` / `writeText` — operators
      // monitoring `fs.access` need to see when an edit landed on
      // a `.gitignore`d / `.qwenignore`d file (build artifacts,
      // logs, etc.) rather than only learning about
      // matchedIgnore for reads and writes.
      const editVerdict = shouldIgnore(
        p,
        this.deps.boundWorkspace,
        this.deps.ignore,
        'file',
      );
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'edit',
        absolute: p,
        durationMs: performance.now() - start,
        sizeBytes: buf.length,
        matchedIgnore: editVerdict.ignored ? editVerdict.category : undefined,
      });
      return { writtenBytes: buf.length };
    } catch (err) {
      throw this.recordAndWrap(err, 'edit', p as string);
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
   *   - PR 19/20 routes can still rely on `instanceof FsError`
   *     for their `sendFsError` serializer.
   */
  private recordAndWrap(err: unknown, intent: Intent, input: string): FsError {
    const fs = wrapAsFsError(err);
    this.deps.audit.recordDenied(this.deps.ctx, {
      intent,
      input,
      errorKind: fs.kind,
      hint: fs.hint,
    });
    return fs;
  }
}

function kindFromStats(st: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsStat['kind'] {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

function kindFromDirent(d: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntry['kind'] {
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isDirectory()) return 'directory';
  if (d.isFile()) return 'file';
  return 'other';
}

function buildWriteMeta(
  opts: WriteTextFileOptions,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (opts.bom) meta['bom'] = true;
  if (opts.encoding) meta['encoding'] = opts.encoding;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

// Re-export so PR 19/20 routes can access the orchestrator surface
// from a single `serve/fs/index.js` import.
export { MAX_READ_BYTES };
