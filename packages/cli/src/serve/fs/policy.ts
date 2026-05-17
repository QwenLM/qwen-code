/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Ignore} from '@qwen-code/qwen-code-core';
import { isBinaryFile } from '@qwen-code/qwen-code-core';
import { FsError } from './errors.js';
import type { Intent, ResolvedPath } from './paths.js';

/**
 * Maximum bytes returned by `readText`. Mirrors claude-code's
 * `MAX_OUTPUT_SIZE` (`src/utils/file.ts`) — large enough for
 * typical source files, small enough that an SSE replay buffer
 * doesn't fill on a single read. Reads above this size return
 * truncated content with `meta.truncated = true`.
 */
export const MAX_READ_BYTES = 256 * 1024;

/**
 * Maximum bytes accepted by `writeText` / `edit`. Sized below the
 * `express.json({ limit: '10mb' })` middleware cap so a request
 * body that survives the parser also survives the policy gate.
 * Halving the parser cap leaves headroom for JSON envelope
 * overhead (path, encoding hints, etc.).
 */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

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
 * Decide how many bytes a `readText` call should pull off disk
 * given the file's actual size. Reads above the cap surface
 * `truncated: true`; the boundary intentionally does NOT throw,
 * matching claude-code's behavior so a large config file still
 * returns useful content rather than an opaque error.
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
 * Throw `file_too_large` if a read would exceed the cap and the
 * caller cannot accept truncation (used by `readBytes`, where
 * partial content is unsafe to return).
 */
export function enforceReadBytesSize(
  fileBytes: number,
  maxBytes: number = MAX_READ_BYTES,
): void {
  if (fileBytes > maxBytes) {
    throw new FsError(
      'file_too_large',
      `file of ${fileBytes} bytes exceeds read limit of ${maxBytes} bytes`,
      {
        hint: 'use readText for capped truncation, or raise the daemon limit',
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
