/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
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
  decodeBufferWithEncodingInfo,
  detectLineEnding,
  encodeTextFileContent,
  loadIgnoreRules,
  isWithinRoot,
  type Ignore,
  type WriteTextFileOptions,
} from '@qwen-code/qwen-code-core';
import type { BridgeEvent } from '../event-bus.js';
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
  enforceReadSize,
  enforceWriteSize,
  shouldIgnore,
} from './policy.js';

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
   * the edit at `0o600`; a new file is created at `0o600` (NOT umask
   * default). Used by protocols whose wire format carries no client-side
   * hash — e.g. ACP `WriteTextFileRequest` is just `{path, content,
   * sessionId}` so the CAS-gated `writeTextAtomic` doesn't fit.
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
  // Freeze the `Ignore` instance so it cannot be mutated after
  // the factory builds it. The `Ignore` class exposes a public
  // `add(patterns): this` method that mutates state in-place;
  // every `forRequest()` returns a `WorkspaceFileSystemImpl`
  // sharing this same instance, so a future "ignore this
  // pattern for this session" feature calling `.add()` would
  // silently corrupt all concurrent requests. `Object.freeze`
  // turns the mutation into a `TypeError` instead of a silent
  // cross-request leak — surfacing the architectural mistake
  // before it ships. Read paths (`getFileFilter` /
  // `getDirectoryFilter`) are unaffected. Operators wanting
  // per-session ignore rules should pass a different `Ignore`
  // instance via `deps.ignore` to a separate factory.
  Object.freeze(ignore);
  const audit: AuditPublisher = createAuditPublisher({
    emit: deps.emit,
    boundWorkspace,
    includeRawPaths: deps.includeRawPaths,
  });
  const lowFs = new StandardFileSystemService();
  const pathLocks = new PathMutexRegistry();

  return {
    forRequest(ctx) {
      return new WorkspaceFileSystemImpl({
        boundWorkspace,
        trusted: deps.trusted,
        ignore,
        audit,
        ctx,
        lowFs,
        pathLocks,
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
  pathLocks: PathMutexRegistry;
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
      const snapshot = await readTextSnapshotFromResolvedFile(p, opts);
      const ignoreVerdict = shouldIgnore(
        p,
        this.deps.boundWorkspace,
        this.deps.ignore,
        'file',
      );
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
      assertTrustedForIntent(this.deps.trusted, 'list');
      const entries: FsEntry[] = [];
      const dir = await fsp.opendir(p as string);
      for await (const d of dir) {
        // `path.join(p, d.name)` is a shallow extension of an
        // already-canonical workspace path. Symlinked dirents are
        // tagged as `kind: 'symlink'` rather than auto-followed —
        // callers that want the target's containment can call
        // `resolve()` separately. Treating each child as
        // implicitly-resolved here would be a brand-cast bypass.
        const childAbs = path.join(p as string, d.name);
        const kind = kindFromStatLike(d);
        const verdict = shouldIgnore(
          childAbs as ResolvedPath,
          this.deps.boundWorkspace,
          this.deps.ignore,
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
      // `opts.cwd` is typed `ResolvedPath` but a brand cast in
      // calling code can produce a path that's never been verified
      // against `boundWorkspace` (or was verified at a stale
      // moment). Re-validate at the entry point so a glob with
      // `cwd: '/etc'` cannot enumerate files outside the workspace
      // even when the *pattern* is harmlessly relative.
      //
      // **Important**: use `realpath` rather than `path.resolve` —
      // a textual containment check on `path.resolve(cwd)` admits
      // `<ws>/link` even when `<ws>/link → /etc` is a symlink to
      // outside the workspace; `globAsync` would then walk
      // `/etc` before the per-hit filter drops the results.
      // `realpath` follows the chain (or throws ENOENT for missing
      // ancestors), so the containment check sees the actual
      // walk root.
      const cwd = (opts.cwd as string | undefined) ?? this.deps.boundWorkspace;
      let cwdReal: string;
      // Short-circuit when `cwd` is exactly the canonical
      // boundWorkspace — the factory already canonicalized it via
      // `realpathSync.native`, so a per-request async `realpath`
      // is a redundant syscall. Saves the syscall on the common
      // path (route handlers omitting `opts.cwd` to glob the
      // whole workspace) without losing the canonicalization
      // guarantee — the factory's stored value IS the canonical.
      if (cwd === this.deps.boundWorkspace) {
        cwdReal = cwd;
      } else {
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
      if (!isWithinRoot(cwdReal, this.deps.boundWorkspace)) {
        throw new FsError(
          'path_outside_workspace',
          `glob cwd is outside workspace: ${cwd}`,
          { hint: 'opts.cwd must be a path obtained from fs.resolve()' },
        );
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
      const matches = await globAsync(pattern, {
        cwd: cwdReal,
        nodir: false,
        absolute: true,
        dot: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
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
          // `io_error` (not `permission_denied`) so monitoring
          // pipelines that page security oncall on
          // `permission_denied` aren't woken up by a failing disk
          // or busy file. The kind was added to `FsErrorKind` for
          // exactly this case (and for `wrapAsFsError`'s ENOSPC /
          // EIO / EBUSY / ETXTBSY / ENAMETOOLONG / EMFILE / ENFILE
          // mappings).
          errorKind: 'io_error',
          hint: `glob skipped ${transientErrorCount} hit(s) due to transient I/O errors (EIO/EBUSY/ENAMETOOLONG/EMFILE)`,
          pattern,
        });
      }
      // `absolute: boundWorkspace` (rather than `cwd`) ties every
      // glob audit row's `pathHash` to the workspace itself.
      // The literal `pattern` field is the per-call signal;
      // `pathHash` is the workspace marker operators correlate
      // across audit rows.
      this.deps.audit.recordAccess(this.deps.ctx, {
        intent: 'glob',
        absolute: this.deps.boundWorkspace,
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
          const meta = mergeWriteMeta(existingMeta, opts);
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content,
            mode: opts.mode,
            expectedHash: opts.expectedHash,
            meta,
          });
          const verdict = shouldIgnore(
            p,
            this.deps.boundWorkspace,
            this.deps.ignore,
            'file',
          );
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
          const meta = mergeWriteMeta(existingMeta, opts);
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content,
            mode: 'overwrite',
            meta,
          });
          const verdict = shouldIgnore(
            p,
            this.deps.boundWorkspace,
            this.deps.ignore,
            'file',
          );
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
          const meta = mergeWriteMeta(snapshot.meta, {});
          const result = await atomicWriteTextResolvedFile({
            target: p,
            content: next,
            mode: 'replace',
            expectedHash: opts.expectedHash,
            meta,
          });
          const verdict = shouldIgnore(
            p,
            this.deps.boundWorkspace,
            this.deps.ignore,
            'file',
          );
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
      // Reject empty `oldText` BEFORE reading. JavaScript's
      // `''.indexOf('')` returns `0`, so without this guard
      // `current.slice(0, 0) + newText + current.slice(0)` would
      // silently prepend `newText` to the entire file and emit a
      // success audit event — a textbook silent data corruption
      // bug. Routes that pass user-supplied `oldText`
      // through verbatim must not be able to trigger it.
      if (oldText.length === 0) {
        throw new FsError(
          'parse_error',
          `oldText must be a non-empty string for edit on ${p}`,
          {
            hint: 'empty oldText would match at position 0 and silently prepend newText',
          },
        );
      }
      // Use `lowFs.readTextFile` (not raw `fsp.readFile(p,
      // 'utf-8')`) so BOM / encoding / CRLF handling matches what
      // `readText` does and what `writeTextFile` will preserve on
      // write-back. A direct utf-8 read on a UTF-8-BOM file would
      // include the U+FEFF BOM codepoint in `current`,
      // breaking `oldText` matching even when the user passed
      // the exact string from a previous read; on iconv-supported
      // codepages (GBK, Big5, Shift_JIS) it would mojibake the
      // content and round-trip-corrupt the file on write-back.
      const readResult = await this.deps.lowFs.readTextFile({
        path: p as string,
        limit: Number.POSITIVE_INFINITY,
        line: 0,
      });
      const current = readResult.content;
      // Post-read TOCTOU guard — catches the swap-during-read
      // attack where `p` is replaced with a symlink between
      // `fsp.stat` above and the read here.
      await assertInodeStableAfterRead(p as string, st.ino);
      // Single replacement to preserve atomic write-once semantics.
      const idx = current.indexOf(oldText);
      if (idx === -1) {
        // Include a snippet of `oldText` in the hint so an operator
        // staring at "edit failed" at 3 AM can tell whether the
        // mismatch is whitespace, a stale file, or a wrong target
        // path. Truncate to keep the hint readable on a one-line
        // log; the full `oldText` is always reproducible from the
        // request body.
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
      // Pre-write TOCTOU guard — same shape as writeText.
      // Defense-in-depth layer.
      await assertNotSymlinkBeforeWrite(p as string);
      // Forward the encoding/BOM/lineEnding metadata captured
      // during the read so the write-back preserves the file's
      // original encoding profile. Without this, a UTF-8-BOM
      // file would be written without BOM, and a non-UTF-8 file
      // (GBK/Shift_JIS) would be written as UTF-8 — silent
      // round-trip corruption of any file the daemon edits.
      await this.deps.lowFs.writeTextFile({
        path: p as string,
        content: next,
        _meta: readResult._meta,
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
        sizeBytes: writtenBytes,
        matchedIgnore: editVerdict.ignored ? editVerdict.category : undefined,
      });
      return { writtenBytes };
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
   *   - routes can still rely on `instanceof FsError`
   *     for their `sendFsError` serializer.
   */
  private recordAndWrap(err: unknown, intent: Intent, input: string): FsError {
    const fs = wrapAsFsError(err);
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

class PathMutexRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

interface AtomicWriteTextInput {
  target: ResolvedPath;
  content: string;
  mode: WriteMode;
  expectedHash?: ContentHash;
  meta: ReadMeta;
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

interface TextSnapshot {
  content: string;
  meta: ReadMeta & { hash: ContentHash; sizeBytes: number };
}

async function readTextSnapshotFromResolvedFile(
  p: ResolvedPath,
  opts: ReadTextOptions = {},
): Promise<TextSnapshot> {
  const pre = await fsp.lstat(p as string);
  if (pre.isSymbolicLink()) {
    throw new FsError('symlink_escape', `path is a symlink: ${p}`, {
      hint: 're-resolve the target file instead of reading through a link',
    });
  }
  if (!pre.isFile()) {
    throw new FsError('parse_error', `path is not a regular file: ${p}`);
  }
  // Hard size gate before reading the full raw snapshot. Files above
  // this cap should use `readBytesWindow()` with an explicit byte
  // window instead of allocating a full decoded text snapshot.
  if (pre.size > MAX_READ_BYTES) {
    throw new FsError(
      'file_too_large',
      `file of ${pre.size} bytes exceeds read cap of ${MAX_READ_BYTES} bytes`,
      {
        hint: 'use readBytes for explicit byte-windowed access on large files',
      },
    );
  }

  const raw = await readStableRegularFileBuffer(p as string, pre);
  if (looksBinary(raw)) {
    throw new FsError('binary_file', `binary file: ${p}`, {
      hint: 'use readBytes for binary content',
    });
  }

  const decoded = decodeBufferWithEncodingInfo(raw);
  const startLineIndex = opts.line !== undefined ? opts.line - 1 : 0;
  const sliced = sliceDecodedText(
    decoded.content,
    startLineIndex,
    opts.limit ?? Number.POSITIVE_INFINITY,
  );
  const sizeOutcome = enforceReadSize(raw.length, opts.maxBytes);
  let content = sliced.content;
  const meta: TextSnapshot['meta'] = {
    encoding: decoded.encoding,
    bom: decoded.bom,
    lineEnding: detectLineEnding(content),
    sizeBytes: raw.length,
    originalLineCount: sliced.originalLineCount,
    hash: hashBuffer(raw),
  };

  if (sizeOutcome.truncated) {
    const buf = Buffer.from(content, 'utf-8');
    if (buf.length > sizeOutcome.bytesToRead) {
      content = safeUtf8Truncate(buf, sizeOutcome.bytesToRead).toString(
        'utf-8',
      );
      meta.lineEnding = detectLineEnding(content);
    }
    meta.truncated = true;
  }

  if (
    opts.limit !== undefined &&
    Number.isFinite(opts.limit) &&
    sliced.originalLineCount > opts.limit + startLineIndex
  ) {
    meta.truncated = true;
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
          hint: 'use readBytes for explicit byte-windowed access on large files',
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
): { content: string; originalLineCount: number } {
  const lines = content.split('\n');
  const originalLineCount = lines.length;
  const endLine = Math.min(startLine + limit, originalLineCount);
  const actualStartLine = Math.min(startLine, originalLineCount);
  return {
    content: lines.slice(actualStartLine, endLine).join('\n'),
    originalLineCount,
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
  const target = input.target as string;
  const parent = path.dirname(target);
  const parentStat = await fsp.lstat(parent);
  // Defense-in-depth against a parent-symlink swap. A full fix
  // requires parent-fd / `openat`-style publish (Node stdlib does
  // not expose this) — tracked alongside the fd-based read
  // follow-up referenced by `assertInodeStableAfterRead`. This
  // guard at least surfaces an obviously-swapped parent before
  // we open the temp file or rename through it.
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
  const tmpPath = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let tempLive = false;
  let tempHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let tempStat: Awaited<ReturnType<typeof fsp.lstat>> | undefined;
  try {
    tempHandle = await reserveTempFile(tmpPath);
    tempLive = true;
    const encoded = await writeEncodedTextTemp({
      targetPath: target,
      tmpPath,
      content: input.content,
      meta: input.meta,
      handle: tempHandle,
    });
    tempStat = encoded.stat;
    const targetState = await assertAtomicTargetPrecondition({
      target,
      mode: input.mode,
      expectedHash: input.expectedHash,
    });
    await chmodHandleBestEffort(tempHandle, targetState.mode ?? 0o600);
    await assertTempPathMatchesStat(tmpPath, tempStat);
    await tempHandle.close();
    tempHandle = undefined;
    await assertTempPathMatchesStat(tmpPath, tempStat);
    if (input.mode === 'create') {
      await publishCreateNoClobber(tmpPath, target);
    } else {
      await renameWithRetryLocal(tmpPath, target, 3, 50);
    }
    tempLive = false;
    await fsyncParentDirBestEffort(parent);
    return encoded;
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

async function writeEncodedTextTemp(input: {
  targetPath: string;
  tmpPath: string;
  content: string;
  meta: ReadMeta;
  handle: Awaited<ReturnType<typeof fsp.open>>;
}): Promise<AtomicWriteTextOutcome> {
  const buf = encodeTextFileContent(
    input.targetPath,
    input.content,
    buildWriteMeta(input.meta),
  );
  enforceWriteSize(buf.length);
  await input.handle.writeFile(buf);
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
  return { sizeBytes: buf.length, hash: hashBuffer(buf), stat: st };
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
 * Post-read TOCTOU guard. After reading the file at `p`, re-`lstat`
 * to confirm the inode hasn't changed and the path isn't now a
 * symlink. Catches the swap-then-leave attack where a regular
 * file is replaced with a symlink to outside the workspace
 * BETWEEN the boundary's pre-stat and the actual read — the
 * pre-stat saw the original (small, regular) file but the read
 * followed the swap to wherever the attacker pointed. There's a
 * residual race where the attacker swaps back after our read but
 * before this check; that window is much smaller than the swap-
 * and-leave attack and outside this module's threat model. The proper
 * fix is fd-based reading (`fsp.open` + `fileHandle.read`) so the
 * fd binds to the inode at open time; that's a follow-up since it
 * requires a new variant of `lowFs.readTextFile` that takes a
 * FileHandle instead of a path.
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
