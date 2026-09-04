/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discriminator for filesystem-boundary errors raised by the
 * `WorkspaceFileSystem` layer (#4175 PR 18).
 *
 * The values are also serialized verbatim onto the wire by PR 19/20
 * route handlers as the `errorKind` field of the planned PR 13
 * envelope `{ kind, status, error, errorKind, hint }`. Keeping the
 * union closed and stable lets SDK consumers exhaustively switch
 * over the kinds without falling through to a generic 5xx path.
 */
export type FsErrorKind =
  | 'path_outside_workspace'
  | 'symlink_escape'
  | 'path_not_found'
  | 'binary_file'
  | 'file_too_large'
  | 'hash_mismatch'
  | 'file_already_exists'
  | 'text_not_found'
  | 'ambiguous_text_match'
  | 'untrusted_workspace'
  | 'permission_denied'
  /**
   * Environmental I/O failure that is *not* a permission decision —
   * disk full (`ENOSPC`), generic I/O error (`EIO`), filesystem busy
   * (`EBUSY`/`ETXTBSY`), path-too-long (`ENAMETOOLONG`), or
   * file-descriptor exhaustion (`EMFILE`/`ENFILE`).
   *
   * Separated from `permission_denied` because monitoring pipelines
   * key on `errorKind` for alerting — conflating "ACL denied" with
   * "disk full" pages the security oncall when the real action is
   * `df -h`. The 503 status communicates "service-level transient
   * failure" to PR 19/20 route handlers and SDK consumers.
   */
  | 'io_error'
  /**
   * Catch-all for non-errno errors that reach the boundary
   * (`TypeError`, programmer-error throws, native module
   * exceptions, etc.). Distinguished from `permission_denied`
   * because monitoring pipelines key on `errorKind` for
   * security alerting — conflating "code bug" with "ACL
   * denied" pages security oncall for what should be a
   * developer ticket. The 500 status communicates "daemon
   * internal fault" to PR 19/20 route handlers.
   */
  | 'internal_error'
  | 'parse_error';

/**
 * HTTP status codes the boundary maps onto. The status lives on the
 * error itself rather than being derived by the route handler so the
 * serialization is "one helper line" — see PR 19/20 plans. The set is
 * intentionally narrow: anything outside this map indicates the
 * boundary is being asked to model a transport-level concern that
 * doesn't belong here (5xx, 401/403 from auth, etc.).
 */
export type FsErrorStatus = 400 | 403 | 404 | 409 | 413 | 422 | 500 | 503;

/**
 * Default HTTP status mapping. Centralized here so callers can throw
 * `new FsError('path_not_found', 'message')` without re-deriving the
 * status; the constructor still accepts an explicit status override
 * for the rare case where a kind is reused under a different status
 * (e.g. `parse_error` may be 400 from a request body but 422 from a
 * service-level invariant breach).
 */
const DEFAULT_STATUS_BY_KIND: Record<FsErrorKind, FsErrorStatus> = {
  path_outside_workspace: 400,
  symlink_escape: 400,
  path_not_found: 404,
  binary_file: 422,
  file_too_large: 413,
  hash_mismatch: 409,
  file_already_exists: 409,
  text_not_found: 422,
  ambiguous_text_match: 422,
  untrusted_workspace: 403,
  permission_denied: 403,
  io_error: 503,
  internal_error: 500,
  parse_error: 400,
};

/**
 * Typed boundary error. PR 18 ships the class only — no route
 * serializes it yet. PR 19/20 add a `sendFsError(res, err)` helper
 * that maps `kind`/`status`/`hint` onto the envelope.
 *
 * Why a class rather than a plain object: `instanceof FsError`
 * gives the orchestrator a single catch-clause to convert thrown
 * boundary errors into `fs.denied` audit events without also
 * eating unrelated runtime errors (`TypeError`, `ENOENT` from a
 * lower-level `fs.promises` call that escaped categorization, etc.).
 */
export class FsError extends Error {
  readonly kind: FsErrorKind;
  readonly status: FsErrorStatus;
  readonly hint?: string;

  constructor(
    kind: FsErrorKind,
    message: string,
    options?: { hint?: string; status?: FsErrorStatus; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'FsError';
    this.kind = kind;
    this.status = options?.status ?? DEFAULT_STATUS_BY_KIND[kind];
    this.hint = options?.hint;
  }
}

/**
 * Type guard for catch sites that need to distinguish boundary
 * errors from generic `Error` instances.
 */
export function isFsError(err: unknown): err is FsError {
  return err instanceof FsError;
}

/**
 * Coerce an arbitrary thrown value into an `FsError`. Used by the
 * orchestrator's catch blocks so every body-level failure surfaces
 * as a typed error AND emits an `fs.denied` audit event — without
 * this, raw `fs.promises` errnos (`EACCES`, `ENOENT`, `ELOOP`, …)
 * propagate uncategorized, the audit log loses denial visibility,
 * and PR 19/20 routes degrade to opaque 5xx responses.
 *
 * Already-typed `FsError`s pass through unchanged so callers can
 * safely chain this on every catch.
 */
export function wrapAsFsError(
  err: unknown,
  fallbackKind: FsErrorKind = 'internal_error',
): FsError {
  if (err instanceof FsError) return err;
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const message =
    err instanceof Error ? err.message : 'unknown filesystem error';
  switch (errno) {
    case 'ENOENT':
      return new FsError('path_not_found', message, { cause: err });
    case 'EACCES':
    case 'EPERM':
      return new FsError('permission_denied', message, { cause: err });
    case 'ELOOP':
      return new FsError('symlink_escape', message, {
        cause: err,
        hint: 'symlink chain forms a cycle or exceeds SYMLOOP_MAX',
      });
    case 'EISDIR':
      return new FsError('parse_error', message, {
        cause: err,
        hint: 'EISDIR — path is a directory but a regular file was expected',
      });
    case 'ENOTDIR':
      return new FsError('parse_error', message, {
        cause: err,
        hint: 'ENOTDIR — a path component is a regular file but a directory was expected',
      });
    case 'ENOSPC':
      return new FsError('io_error', message, {
        cause: err,
        hint: 'filesystem is full (df -h reporting 100%)',
      });
    case 'EIO':
      return new FsError('io_error', message, {
        cause: err,
        hint: 'underlying I/O error (failing disk or kernel-level fault)',
      });
    case 'EBUSY':
    case 'ETXTBSY':
      return new FsError('io_error', message, {
        cause: err,
        hint: 'file is busy; another process holds an exclusive handle',
      });
    case 'ENAMETOOLONG':
      return new FsError('io_error', message, {
        cause: err,
        hint: 'path exceeds the OS PATH_MAX',
      });
    case 'EMFILE':
    case 'ENFILE':
      return new FsError('io_error', message, {
        cause: err,
        hint: 'too many open files; daemon is at file-descriptor limit',
      });
    default:
      return new FsError(fallbackKind, message, { cause: err });
  }
}
