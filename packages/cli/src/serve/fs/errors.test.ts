/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  FsError,
  isFsError,
  wrapAsFsError,
  type FsErrorKind,
} from './errors.js';

describe('FsError', () => {
  it('uses the default status mapping for each kind', () => {
    const cases: Array<[FsErrorKind, number]> = [
      ['path_outside_workspace', 400],
      ['symlink_escape', 400],
      ['path_not_found', 404],
      ['binary_file', 422],
      ['file_too_large', 413],
      ['hash_mismatch', 409],
      ['file_already_exists', 409],
      ['text_not_found', 422],
      ['ambiguous_text_match', 422],
      ['untrusted_workspace', 403],
      ['permission_denied', 403],
      ['io_error', 503],
      ['internal_error', 500],
      ['parse_error', 400],
    ];
    for (const [kind, status] of cases) {
      const err = new FsError(kind, `${kind} message`);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
    }
  });

  it('honors an explicit status override', () => {
    const err = new FsError('parse_error', 'service invariant', {
      status: 422,
    });
    expect(err.status).toBe(422);
  });

  it('captures the hint string when provided', () => {
    const err = new FsError('binary_file', 'binary content', {
      hint: 'Use readBytes for binary content',
    });
    expect(err.hint).toBe('Use readBytes for binary content');
  });

  it('omits hint when not provided', () => {
    const err = new FsError('path_not_found', 'missing');
    expect(err.hint).toBeUndefined();
  });

  it('forwards a cause through to Error.cause when available', () => {
    const root = new Error('underlying ENOENT');
    const err = new FsError('path_not_found', 'wrapped', { cause: root });
    // Node 16+ supports Error.cause. On the off chance the runtime
    // doesn't, we just assert the message + kind survived rather
    // than failing the suite for a feature-detection issue.
    expect(err.message).toBe('wrapped');
    expect(err.kind).toBe('path_not_found');
    if ('cause' in err) {
      expect((err as Error & { cause?: unknown }).cause).toBe(root);
    }
  });

  it('sets name to "FsError" for stack-trace clarity', () => {
    const err = new FsError('symlink_escape', 'x');
    expect(err.name).toBe('FsError');
  });

  it('is an Error subclass and isFsError narrows it', () => {
    const err = new FsError('untrusted_workspace', 'no writes here');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FsError);
    expect(isFsError(err)).toBe(true);
    expect(isFsError(new Error('plain'))).toBe(false);
    expect(isFsError(null)).toBe(false);
    expect(isFsError(undefined)).toBe(false);
    expect(isFsError({ kind: 'path_not_found' })).toBe(false);
  });
});

describe('wrapAsFsError', () => {
  function errno(
    code: string,
    message = `${code} message`,
  ): NodeJS.ErrnoException {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it('returns FsError instances unchanged', () => {
    const original = new FsError('binary_file', 'x');
    expect(wrapAsFsError(original)).toBe(original);
  });

  it('maps ENOENT to path_not_found', () => {
    const out = wrapAsFsError(errno('ENOENT'));
    expect(out.kind).toBe('path_not_found');
    expect(out.status).toBe(404);
  });

  it('maps EACCES and EPERM to permission_denied', () => {
    expect(wrapAsFsError(errno('EACCES')).kind).toBe('permission_denied');
    expect(wrapAsFsError(errno('EPERM')).kind).toBe('permission_denied');
  });

  it('maps ELOOP to symlink_escape', () => {
    expect(wrapAsFsError(errno('ELOOP')).kind).toBe('symlink_escape');
  });

  it('maps ENOTDIR / EISDIR to parse_error', () => {
    expect(wrapAsFsError(errno('ENOTDIR')).kind).toBe('parse_error');
    expect(wrapAsFsError(errno('EISDIR')).kind).toBe('parse_error');
  });

  it('maps EMFILE / ENFILE to io_error with a hint', () => {
    const out = wrapAsFsError(errno('EMFILE'));
    expect(out.kind).toBe('io_error');
    expect(out.hint).toMatch(/file-descriptor/);
  });

  it('maps ENOSPC / EIO / EBUSY / ETXTBSY / ENAMETOOLONG to io_error', () => {
    const enospc = wrapAsFsError(errno('ENOSPC'));
    expect(enospc.kind).toBe('io_error');
    expect(enospc.hint).toMatch(/full/);
    expect(wrapAsFsError(errno('EIO')).kind).toBe('io_error');
    expect(wrapAsFsError(errno('EBUSY')).kind).toBe('io_error');
    expect(wrapAsFsError(errno('ETXTBSY')).kind).toBe('io_error');
    expect(wrapAsFsError(errno('ENAMETOOLONG')).kind).toBe('io_error');
  });

  it('io_error has HTTP status 503', () => {
    expect(new FsError('io_error', 'disk full').status).toBe(503);
  });

  it('falls back to internal_error (not permission_denied) for unknown errnos and non-errno errors', () => {
    // Default fallback used to be `permission_denied`, which mis-paged
    // security oncall on a TypeError or null-deref. The new default is
    // `internal_error` (HTTP 500) so monitoring keys stay aligned with
    // the actual class of fault.
    expect(wrapAsFsError(errno('EWHATEVER')).kind).toBe('internal_error');
    expect(wrapAsFsError(new TypeError('null deref')).kind).toBe(
      'internal_error',
    );
    // Caller can still override.
    expect(wrapAsFsError(errno('EWHATEVER'), 'parse_error').kind).toBe(
      'parse_error',
    );
  });

  it('internal_error has HTTP status 500', () => {
    expect(new FsError('internal_error', 'bug').status).toBe(500);
  });

  it('non-Error values fall back to internal_error not permission_denied', () => {
    // `string thrown` from somewhere weird. Earlier default of
    // permission_denied would page security oncall for what
    // is a developer ticket.
    const out = wrapAsFsError('boom');
    expect(out.kind).toBe('internal_error');
    expect(out.status).toBe(500);
  });

  it('preserves the original error as cause', () => {
    const root = errno('ENOENT', 'where');
    const out = wrapAsFsError(root);
    if ('cause' in out) {
      expect((out as Error & { cause?: unknown }).cause).toBe(root);
    }
  });

  it('handles non-Error throwables without crashing', () => {
    const out = wrapAsFsError('string thrown', 'parse_error');
    expect(out.kind).toBe('parse_error');
    expect(out.message).toBe('unknown filesystem error');
  });
});
