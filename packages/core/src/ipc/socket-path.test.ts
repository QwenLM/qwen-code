/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import {
  isLocalIpcPath,
  resolvePeerSocketCandidates,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketPath,
} from './socket-path.js';

const isWindows = process.platform === 'win32';

const originalRuntimeDir = process.env['XDG_RUNTIME_DIR'];

beforeEach(() => {
  delete process.env['XDG_RUNTIME_DIR'];
});

afterEach(() => {
  // packages/core's vitest config does not set `unstubEnvs`, so a test
  // that throws before its own cleanup would otherwise leak its stubs.
  vi.unstubAllEnvs();
  if (originalRuntimeDir === undefined) {
    delete process.env['XDG_RUNTIME_DIR'];
  } else {
    process.env['XDG_RUNTIME_DIR'] = originalRuntimeDir;
  }
});

// POSIX-only: the resolver builds paths with path.join and the
// expectations assume forward slashes; on Windows the whole feature is
// out of scope (see isLocalIpcPath), like the sibling socket suites.
describe.skipIf(isWindows)('resolvePeerSocketPath', () => {
  it('prefers XDG_RUNTIME_DIR', () => {
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
    expect(resolvePeerSocketPath(4242)).toBe(
      '/run/user/1000/qwen-socks/4242.sock',
    );
  });

  it('falls back to an unpredictable per-session temp-dir path', () => {
    // A shared temp dir needs a random name: a fixed or uid-derived one
    // is a cross-user lockout or a pre-creatable DoS target.
    const tmpPrefix = `${os.tmpdir()}/`.replace(/\/+/g, '/');
    const first = resolvePeerSocketPath(4242).replace(/\/+/g, '/');
    const second = resolvePeerSocketPath(4242).replace(/\/+/g, '/');
    for (const resolved of [first, second]) {
      expect(resolved.startsWith(tmpPrefix)).toBe(true);
      expect(resolved).toMatch(/\/qwen-socks-[0-9a-f]{16}\/4242\.sock$/);
    }
    expect(first).not.toBe(second);
  });

  it('falls back to a short /tmp path when the preferred one cannot be bound', () => {
    process.env['XDG_RUNTIME_DIR'] = `/run/${'d'.repeat(120)}`;
    const originalTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = `/${'t'.repeat(110)}`;
    try {
      const resolved = resolvePeerSocketPath(4242);
      expect(resolved).toMatch(/^\/tmp\/qwen-socks-[0-9a-f]{16}\/4242\.sock$/);
      expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(
        MAX_SOCKET_PATH_BYTES,
      );
    } finally {
      if (originalTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = originalTmpdir;
    }
  });

  it('keeps a path that is exactly at the limit', () => {
    // Build a runtime dir that lands the full path on the boundary.
    const suffix = '/qwen-socks/4242.sock';
    const dirLength = MAX_SOCKET_PATH_BYTES - suffix.length;
    process.env['XDG_RUNTIME_DIR'] = '/' + 'd'.repeat(dirLength - 1);
    const resolved = resolvePeerSocketPath(4242);
    expect(Buffer.byteLength(resolved)).toBe(MAX_SOCKET_PATH_BYTES);
    expect(resolved.startsWith('/tmp/qwen-socks-')).toBe(false);
  });
});

describe('isLocalIpcPath', () => {
  it.skipIf(isWindows)('accepts an absolute posix path', () => {
    expect(isLocalIpcPath('/run/user/1000/qwen-socks/1.sock')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isLocalIpcPath('qwen-socks/1.sock')).toBe(false);
    expect(isLocalIpcPath('./1.sock')).toBe(false);
    expect(isLocalIpcPath('../../etc/1.sock')).toBe(false);
  });

  it('rejects UNC-looking paths that could dial another host', () => {
    expect(isLocalIpcPath('//server/pipe/qwen')).toBe(false);
  });

  it('rejects a path containing a NUL', () => {
    expect(isLocalIpcPath('/tmp/a\0/../../etc/passwd')).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isLocalIpcPath('')).toBe(false);
    expect(isLocalIpcPath(undefined as unknown as string)).toBe(false);
    expect(isLocalIpcPath(42 as unknown as string)).toBe(false);
  });
});

describe.skipIf(isWindows)('resolvePeerSocketCandidates', () => {
  it('lists the runtime directory first, then a nonce directory under tmpdir, then /tmp', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000');
    vi.stubEnv('TMPDIR', '/var/tmp');
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates[0]).toBe('/run/user/1000/qwen-socks/42.sock');
      expect(candidates[1]).toMatch(
        /^\/var\/tmp\/qwen-socks-[0-9a-f]{16}\/42\.sock$/,
      );
      expect(candidates[2]).toMatch(
        /^\/tmp\/qwen-socks-[0-9a-f]{16}\/42\.sock$/,
      );
      // The same nonce for both fallbacks: one session, one directory name.
      expect(candidates[1]!.split('/')[3]).toBe(candidates[2]!.split('/')[2]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops candidates that cannot fit in sun_path', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/' + 'r'.repeat(120));
    vi.stubEnv('TMPDIR', undefined);
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates.some((c) => c.startsWith('/rrr'))).toBe(false);
      expect(candidates.every((c) => Buffer.byteLength(c) <= 103)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('deduplicates the /tmp fallback', () => {
    // TMPDIR is named, not unset: deleting it does not make os.tmpdir()
    // return /tmp, it only moves libuv on to TMP, then TEMP. A shell
    // exporting either (Nix and Guix shells, some container images) would
    // yield three distinct candidates and fail this assertion without any
    // change to the resolver. Construct the duplicate rather than hope
    // the environment supplies it.
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000');
    vi.stubEnv('TMPDIR', '/tmp');
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates).size).toBe(candidates.length);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops an over-long temp-dir candidate and keeps the short /tmp one', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('TMPDIR', '/' + 't'.repeat(200));
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates).toHaveLength(1);
      expect(candidates.at(-1)).toMatch(/^\/tmp\/qwen-socks-/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
