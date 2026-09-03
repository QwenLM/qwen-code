/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Ignore } from '@qwen-code/qwen-code-core/utils/filesearch/ignore.js';
import { isBinaryFile } from '@qwen-code/qwen-code-core/utils/fileUtils.js';
import { FsError } from './errors.js';
import type { Intent, ResolvedPath } from './paths.js';

/**
 * Maximum bytes the `readText` boundary is willing to slurp before
 * delegating to the core service. Mirrors claude-code's
 * `MAX_OUTPUT_SIZE` (`src/utils/file.ts`) — large enough for
 * typical source files, small enough that an SSE replay buffer
 * doesn't fill on a single read.
 *
 * Full-snapshot reads above this cap are refused with `file_too_large`
 * rather than truncated. `readText` can serve finite-limit line windows from
 * larger files, but the default read/edit contract still needs a bounded
 * snapshot for hash stability, SSE buffering, and oldText matching. Files at
 * or below the cap honor a tighter `opts.maxBytes` as a post-decode UTF-8
 * output cap; `enforceReadSize` also supplies source-size truncation metadata.
 *
 * `edit()` uses the same constant as a hard upper bound.
 * `readBytesWindow` instead binds an fd and returns at most its explicit
 * byte window without buffering the whole file. `enforceReadBytesSize`
 * remains available to strict callers that do require a full byte snapshot.
 */
export const MAX_READ_BYTES = 256 * 1024;

/**
 * Upper bound on bytes read off disk to locate a line window above
 * `MAX_READ_BYTES`.
 *
 * `MAX_READ_BYTES` caps what a read *returns*; it says nothing about what a
 * read *costs*. Line offsets address a byte stream, so `{ line: 900_000_000,
 * limit: 20 }` returns almost nothing and still walks the file from byte 0.
 * Without this cap a single query param turns into an uninterruptible
 * multi-second scan of an arbitrarily large file, and on Windows it holds a
 * read handle (opened without `FILE_SHARE_DELETE`) for that entire span,
 * blocking renames and deletes of the target.
 *
 * 8 MiB is ~25 ms at the ~300 MB/s this streams at — small enough that the
 * cost is bounded and the handle-hold window stays negligible, large enough
 * to cover the head and tail-ish regions agents actually ask for. Requests
 * past it get `file_too_large` pointing at `readBytes`, which reaches any
 * offset in O(1).
 */
export const MAX_TEXT_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Maximum bytes accepted by `writeText` / `edit`. Sized below the
 * `express.json({ limit: '10mb' })` middleware cap so a request
 * body that survives the parser also survives the policy gate.
 * Halving the parser cap leaves headroom for JSON envelope
 * overhead (path, encoding hints, etc.).
 */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Maximum bytes accepted by the binary upload write path
 * (`writeBytesAtomic`). This is a distinct binary-ingress policy, NOT an
 * increase to the agent text-write limit: text writes keep
 * `MAX_WRITE_BYTES`. Sized for screenshots, data files, and configs that a
 * user drags into the Web Shell. The daemon's upload route and the fs
 * boundary share this single constant so a request buffered under the parser
 * cap is never rejected later under a different limit.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Sample size used for content-based binary detection. Aligned with
 * `isBinaryFile` from `packages/core/src/utils/fileUtils.ts:414` so
 * the boundary and the existing tool layer agree on what counts as
 * "binary".
 */
export const BINARY_PROBE_BYTES = 4096;

/**
 * Result of an ignore-rule check against a resolved path. The
 * `category` field exists so audit events can distinguish
 * file-pattern vs directory-pattern matches without exposing the
 * `Ignore` class's private state.
 */
export interface IgnoreVerdict {
  ignored: boolean;
  category?: 'file' | 'directory';
}

/**
 * Check whether `absolute` is matched by the workspace's ignore
 * rules. The check is computed against the workspace-relative
 * form of the path, matching the convention of `.gitignore` /
 * `.qwenignore` patterns.
 *
 * Returns `{ ignored: false }` when:
 *   - the path equals `boundWorkspace` (the workspace root itself
 *     can never be ignored),
 *   - the relative path escapes the workspace (caller's bug; the
 *     boundary check should have rejected first),
 *   - neither the file nor directory filter matches.
 *
 * The `kind` parameter tells the function whether the resolved
 * path is a regular file or a directory. This avoids an extra
 * `stat` call (the orchestrator already has the dirent info from
 * its `list`/`stat` step) and lets us check directory patterns
 * with the trailing slash the underlying `ignore` library expects
 * for `foo/`-style entries.
 */
export function shouldIgnore(
  absolute: ResolvedPath,
  boundWorkspace: string,
  ignore: Ignore,
  kind: 'file' | 'directory' = 'file',
): IgnoreVerdict {
  const rel = path.relative(boundWorkspace, absolute as string);
  if (rel === '' || rel.startsWith('..')) return { ignored: false };
  const fileFilter = ignore.getFileFilter();
  const dirFilter = ignore.getDirectoryFilter();
  if (kind === 'directory') {
    // `foo/` patterns require the trailing slash; `node_modules`-style
    // patterns (no slash, no extension) are added to both ignorers by
    // `Ignore.add`, so the slash-suffixed probe still hits them.
    const withSlash = rel.endsWith('/') ? rel : `${rel}/`;
    if (dirFilter(withSlash)) return { ignored: true, category: 'directory' };
    if (fileFilter(rel)) return { ignored: true, category: 'file' };
    return { ignored: false };
  }
  if (fileFilter(rel)) return { ignored: true, category: 'file' };
  if (dirFilter(rel)) return { ignored: true, category: 'directory' };
  return { ignored: false };
}

/**
 * Apply the trust gate to an intent. Read-shaped intents (`read`,
 * `list`, `glob`, `stat`) always pass — remote clients debugging
 * an untrusted workspace still need to inspect state. Mutating
 * intents (`write`, `edit`) on an untrusted workspace throw
 * `untrusted_workspace`, which routes surface as 403.
 *
 * Trust is captured at factory build (a snapshot of
 * `Config.isTrustedFolder()`); the orchestrator does not consult
 * Config per-request, so an IDE that flips trust mid-request
 * cannot split-brain a session.
 *
 * The body is an exhaustive `switch` so adding a new variant to
 * `Intent` (e.g. a future `'delete'`) becomes a TypeScript error
 * here — the gate must explicitly classify every intent rather
 * than silently defaulting to "allowed".
 */
export function assertTrustedForIntent(trusted: boolean, intent: Intent): void {
  if (trusted) return;
  switch (intent) {
    case 'read':
    case 'list':
    case 'glob':
    case 'stat':
      return;
    case 'write':
    case 'edit':
      throw new FsError(
        'untrusted_workspace',
        `workspace is not trusted; ${intent} operations are forbidden`,
        {
          hint: 'mark the folder as trusted in the daemon configuration to allow writes',
        },
      );
    default: {
      const _exhaustive: never = intent;
      throw new FsError(
        'untrusted_workspace',
        `workspace is not trusted; intent "${String(_exhaustive)}" is not classified`,
        {
          hint: 'unknown intent reached the trust gate; classify it in policy.ts',
        },
      );
    }
  }
}

/** Outcome of a read-size enforcement check. */
export interface ReadSizeOutcome {
  /** Number of bytes the caller should read. */
  bytesToRead: number;
  /** True iff the file is larger than the cap and content was truncated. */
  truncated: boolean;
}

/**
 * Decide how many bytes a `readText` call should return given the
 * file's actual size and the caller's optional tighter cap.
 *
 * **Note**: this helper is the *soft* truncation gate that fires
 * when `opts.maxBytes < fileSize <= MAX_READ_BYTES`. It runs only
 * on the full-snapshot path: unbounded files above `MAX_READ_BYTES`
 * are rejected before this helper, while finite line windows use
 * the separate streaming path. Within the full-snapshot cap the caller
 * can opt into a tighter byte ceiling via `opts.maxBytes`, and we
 * surface that truncation via `truncated: true` rather than throwing —
 * operators want to see a partial config file rather than an opaque
 * error when they explicitly opted in to a smaller window.
 */
export function enforceReadSize(
  fileBytes: number,
  maxBytes: number = MAX_READ_BYTES,
): ReadSizeOutcome {
  if (fileBytes <= maxBytes) {
    return { bytesToRead: fileBytes, truncated: false };
  }
  return { bytesToRead: maxBytes, truncated: true };
}

/**
 * Throw `file_too_large` if `bytes` exceeds the write cap. Used by
 * `writeText` and `edit`, which (unlike text reads) cannot silently
 * truncate without corrupting the file.
 */
export function enforceWriteSize(
  bytes: number,
  maxBytes: number = MAX_WRITE_BYTES,
): void {
  if (bytes > maxBytes) {
    throw new FsError(
      'file_too_large',
      `payload of ${bytes} bytes exceeds write limit of ${maxBytes} bytes`,
      {
        hint: 'split the write into smaller chunks or raise the daemon limit',
      },
    );
  }
}

/**
 * Throw `file_too_large` when a strict full-byte-snapshot caller exceeds the
 * hard `MAX_READ_BYTES` cap. The production `readBytesWindow` path does not
 * use this helper: it reads an explicit bounded window from an opened handle,
 * so a multi-GB file never requires a multi-GB allocation.
 *
 * Soft window-read (`opts.maxBytes` truncation) is NOT this
 * function's job. Mixing a bounded window contract into this strict
 * full-snapshot gate would make the helper's safety guarantee ambiguous.
 */
export function enforceReadBytesSize(fileBytes: number): void {
  if (fileBytes > MAX_READ_BYTES) {
    throw new FsError(
      'file_too_large',
      `file of ${fileBytes} bytes exceeds read limit of ${MAX_READ_BYTES} bytes`,
      {
        hint: 'use an explicit bounded readBytesWindow request for large files',
      },
    );
  }
}

/**
 * Decide whether a path is binary using the existing core helper.
 * Wrapping it here lets PR 18 callers keep a single `policy.ts`
 * import surface and lets future tweaks (e.g. extension allow-list)
 * land without touching the orchestrator.
 */
export async function detectBinary(filePath: ResolvedPath): Promise<boolean> {
  return isBinaryFile(filePath as string);
}
